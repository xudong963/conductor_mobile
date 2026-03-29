import { setTimeout as delay } from "node:timers/promises";

import type {
  TelegramInlineKeyboard,
  TelegramSendMessageOptions,
  TelegramUpdate,
} from "../types.js";

const POLL_RETRY_DELAY_MS = 750;
const POLL_TIMEOUT_BUFFER_MS = 10_000;
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

export function summarizeTelegramNetworkError(error: unknown): { code: string | null; message: string } {
  const code = getErrorCode(error);
  const message = getPreferredErrorMessage(error) ?? "request failed";
  if (!code || message.includes(code)) {
    return { code, message };
  }
  return { code, message: `${message} (${code})` };
}

export class TelegramClient {
  private readonly baseUrl: string;

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
            timeoutMs: (timeoutSeconds * 1000) + POLL_TIMEOUT_BUFFER_MS,
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
      disable_web_page_preview: options?.disable_web_page_preview ?? true,
      reply_markup: options?.reply_markup,
    });
    return response.result?.message_id ?? null;
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

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    await this.callApi("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text,
      show_alert: false,
    });
  }

  private async callApi<T>(
    method: string,
    body: Record<string, unknown>,
    options?: TelegramRequestOptions,
  ): Promise<T> {
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
      throw new Error(`Telegram API ${method} failed: HTTP ${response.status}`);
    }
    const data = (await response.json()) as { ok: boolean; description?: string };
    if (!data.ok) {
      throw new Error(`Telegram API ${method} rejected: ${data.description ?? "unknown error"}`);
    }
    return data as T;
  }
}
