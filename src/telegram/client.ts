import { setTimeout as delay } from "node:timers/promises";

import type {
  TelegramBotCommand,
  TelegramForumTopic,
  TelegramInlineKeyboard,
  TelegramSendMessageOptions,
  TelegramUpdate,
} from "../types.js";

const POLL_RETRY_DELAY_MS = 750;
const POLL_TIMEOUT_BUFFER_MS = 10_000;
const RETRYABLE_POLL_HTTP_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504]);
const RETRYABLE_NETWORK_ERROR_CODES = new Set([
  "ABORT_ERR",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "UND_ERR_ABORTED",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

interface TelegramRequestOptions {
  timeoutMs?: number;
}

interface TelegramApiParameters {
  retry_after?: number;
}

interface TelegramApiResponse {
  ok: boolean;
  description?: string;
  error_code?: number;
  parameters?: TelegramApiParameters;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function getErrorCode(error: unknown): string | null {
  const record = asRecord(error);
  const code = record?.code;
  if (typeof code === "string" && code) {
    return code;
  }
  return record?.cause ? getErrorCode(record.cause) : null;
}

function getPreferredErrorMessage(error: unknown): string | null {
  if (error instanceof Error) {
    const nested = getPreferredErrorMessage(error.cause);
    if (nested && error.message.toLowerCase() === "fetch failed") {
      return nested;
    }
    return error.message || nested;
  }
  if (typeof error === "string") {
    return error;
  }
  const record = asRecord(error);
  if (!record) {
    return null;
  }
  const message = record.message;
  if (typeof message === "string" && message) {
    const nested = record.cause ? getPreferredErrorMessage(record.cause) : null;
    if (nested && message.toLowerCase() === "fetch failed") {
      return nested;
    }
    return message;
  }
  return record.cause ? getPreferredErrorMessage(record.cause) : null;
}

function parseRetryAfterSeconds(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.ceil(value);
}

function parseRetryAfterFromDescription(description: string | null): number | null {
  if (!description) {
    return null;
  }
  const match = description.match(/\bretry after\s+(\d+)\b/i);
  if (!match) {
    return null;
  }
  return parseRetryAfterSeconds(Number(match[1]));
}

function getTelegramRetryAfterSeconds(
  parameters: TelegramApiParameters | null | undefined,
  description: string | null,
): number | null {
  return parseRetryAfterSeconds(parameters?.retry_after) ?? parseRetryAfterFromDescription(description);
}

export class TelegramNetworkError extends Error {
  readonly code: string | null;
  readonly method: string;

  constructor(method: string, cause: unknown) {
    const details = summarizeTelegramNetworkError(cause);
    super(`Telegram API ${method} request failed: ${details.message}`, { cause });
    this.name = "TelegramNetworkError";
    this.method = method;
    this.code = details.code;
  }
}

export class TelegramApiError extends Error {
  readonly description: string | null;
  readonly method: string;
  readonly retryAfterSeconds: number | null;
  readonly status: number | null;

  constructor(
    method: string,
    status: number | null,
    description: string | null,
    retryAfterSeconds: number | null = null,
  ) {
    const statusText = status === null ? "request failed" : `HTTP ${status}`;
    super(`Telegram API ${method} failed: ${description ?? statusText}`);
    this.name = "TelegramApiError";
    this.method = method;
    this.status = status;
    this.description = description;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function isTransientTelegramNetworkError(error: unknown): boolean {
  if (error instanceof TelegramNetworkError) {
    return error.code === null || RETRYABLE_NETWORK_ERROR_CODES.has(error.code);
  }

  const code = getErrorCode(error);
  if (code && RETRYABLE_NETWORK_ERROR_CODES.has(code)) {
    return true;
  }

  const message = getPreferredErrorMessage(error)?.toLowerCase() ?? "";
  return message.includes("fetch failed") || message.includes("socket") || message.includes("timed out");
}

export function isTransientTelegramError(error: unknown): boolean {
  if (error instanceof TelegramApiError) {
    return error.method === "getUpdates" && error.status !== null && RETRYABLE_POLL_HTTP_STATUSES.has(error.status);
  }
  return isTransientTelegramNetworkError(error);
}

export function summarizeTelegramError(error: unknown): { code: string | null; message: string } {
  if (error instanceof TelegramApiError) {
    const code = error.status === null ? null : String(error.status);
    return {
      code,
      message: error.description ?? (code ? `HTTP ${code}` : "request failed"),
    };
  }

  const code = getErrorCode(error);
  const message = getPreferredErrorMessage(error) ?? "request failed";
  if (!code || message.includes(code)) {
    return { code, message };
  }
  return { code, message: `${message} (${code})` };
}

export const summarizeTelegramNetworkError = summarizeTelegramError;

function isExpiredCallbackQueryDescription(description: string | null): boolean {
  const normalized = description?.toLowerCase() ?? "";
  return normalized.includes("query is too old") || normalized.includes("response timeout expired");
}

function isExpiredCallbackQueryError(error: unknown): boolean {
  return (
    error instanceof TelegramApiError &&
    error.method === "answerCallbackQuery" &&
    isExpiredCallbackQueryDescription(error.description)
  );
}

async function readTelegramApiError(
  response: Response,
): Promise<{ description: string | null; retryAfterSeconds: number | null; status: number | null }> {
  let description: string | null = null;
  let retryAfterSeconds: number | null = null;
  let status: number | null = response.status;

  try {
    const text = await response.text();
    if (text) {
      try {
        const data = JSON.parse(text) as TelegramApiResponse;
        description = typeof data.description === "string" && data.description ? data.description : null;
        if (typeof data.error_code === "number") {
          status = data.error_code;
        }
        retryAfterSeconds = getTelegramRetryAfterSeconds(data.parameters, description);
      } catch {
        description = text.trim() || null;
        retryAfterSeconds = getTelegramRetryAfterSeconds(null, description);
      }
    }
  } catch {
    description = null;
  }

  return { status, description, retryAfterSeconds };
}

export class TelegramClient {
  private readonly baseUrl: string;
  private retryAfterDeadlineMs = 0;

  constructor(token: string) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  async getUpdates(offset: number, timeoutSeconds: number): Promise<TelegramUpdate[]> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await this.callApi<{ ok: boolean; result: TelegramUpdate[] }>(
          "getUpdates",
          {
            offset,
            timeout: timeoutSeconds,
            allowed_updates: ["message", "callback_query"],
          },
          {
            timeoutMs: timeoutSeconds * 1000 + POLL_TIMEOUT_BUFFER_MS,
          },
        );
        return response.result ?? [];
      } catch (error) {
        if (attempt >= 1 || !isTransientTelegramNetworkError(error)) {
          throw error;
        }
        await delay(POLL_RETRY_DELAY_MS);
      }
    }
  }

  async sendMessage(chatId: number, text: string, options?: TelegramSendMessageOptions): Promise<number | null> {
    const response = await this.callApi<{ ok: boolean; result?: { message_id: number } }>("sendMessage", {
      chat_id: chatId,
      text,
      message_thread_id: options?.message_thread_id,
      disable_web_page_preview: options?.disable_web_page_preview ?? true,
      reply_markup: options?.reply_markup,
    });
    return response.result?.message_id ?? null;
  }

  async createForumTopic(chatId: number, name: string): Promise<TelegramForumTopic> {
    const response = await this.callApi<{ ok: boolean; result: TelegramForumTopic }>("createForumTopic", {
      chat_id: chatId,
      name,
    });
    return response.result;
  }

  async editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    inlineKeyboard?: TelegramInlineKeyboard,
  ): Promise<void> {
    await this.callApi("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      reply_markup: inlineKeyboard ? { inline_keyboard: inlineKeyboard } : undefined,
      disable_web_page_preview: true,
    });
  }

  async deleteMessage(chatId: number, messageId: number): Promise<void> {
    await this.callApi("deleteMessage", {
      chat_id: chatId,
      message_id: messageId,
    });
  }

  async setMyCommands(commands: TelegramBotCommand[]): Promise<void> {
    await this.callApi("setMyCommands", {
      commands: commands.map((command) => ({
        command: command.command,
        description: command.description,
      })),
    });
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    try {
      await this.callApi("answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        text,
        show_alert: false,
      });
    } catch (error) {
      if (isExpiredCallbackQueryError(error)) {
        return;
      }
      throw error;
    }
  }

  private async callApi<T>(
    method: string,
    body: Record<string, unknown>,
    options?: TelegramRequestOptions,
  ): Promise<T> {
    for (;;) {
      await this.waitForRetryWindow();

      let response: Response;
      const requestInit: RequestInit = {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      };
      if (options?.timeoutMs) {
        requestInit.signal = AbortSignal.timeout(options.timeoutMs);
      }
      try {
        response = await fetch(`${this.baseUrl}/${method}`, requestInit);
      } catch (error) {
        throw new TelegramNetworkError(method, error);
      }

      if (!response.ok) {
        const apiError = await readTelegramApiError(response);
        if (apiError.retryAfterSeconds !== null) {
          this.deferUntilRetryWindow(apiError.retryAfterSeconds);
          continue;
        }
        throw new TelegramApiError(method, apiError.status, apiError.description, apiError.retryAfterSeconds);
      }
      const data = (await response.json()) as TelegramApiResponse;
      if (!data.ok) {
        const description = typeof data.description === "string" && data.description ? data.description : null;
        const status = typeof data.error_code === "number" ? data.error_code : response.status;
        const retryAfterSeconds = getTelegramRetryAfterSeconds(data.parameters, description);
        if (retryAfterSeconds !== null) {
          this.deferUntilRetryWindow(retryAfterSeconds);
          continue;
        }
        throw new TelegramApiError(method, status, description, retryAfterSeconds);
      }
      return data as T;
    }
  }

  private deferUntilRetryWindow(retryAfterSeconds: number): void {
    const retryAfterMs = Math.ceil(retryAfterSeconds * 1000);
    const deadline = Date.now() + retryAfterMs;
    if (deadline > this.retryAfterDeadlineMs) {
      this.retryAfterDeadlineMs = deadline;
    }
  }

  private async waitForRetryWindow(): Promise<void> {
    for (;;) {
      const delayMs = this.retryAfterDeadlineMs - Date.now();
      if (delayMs <= 0) {
        return;
      }
      await delay(delayMs);
    }
  }
}
