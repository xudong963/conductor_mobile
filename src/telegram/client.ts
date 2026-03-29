import type {
  TelegramInlineKeyboard,
  TelegramSendMessageOptions,
  TelegramUpdate,
} from "../types.js";

export class TelegramClient {
  private readonly baseUrl: string;

  constructor(token: string) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  async getUpdates(offset: number, timeoutSeconds: number): Promise<TelegramUpdate[]> {
    const response = await this.callApi<{ ok: boolean; result: TelegramUpdate[] }>("getUpdates", {
      offset,
      timeout: timeoutSeconds,
      allowed_updates: ["message", "callback_query"],
    });
    return response.result ?? [];
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

  private async callApi<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${this.baseUrl}/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

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
