import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isTelegramMessageNotModifiedError,
  isTransientTelegramError,
  summarizeTelegramError,
  TelegramApiError,
  TelegramClient,
} from "./client.js";

function telegramErrorResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

function telegramSuccessResponse(result: unknown): Response {
  return telegramErrorResponse(200, { ok: true, result });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("TelegramClient", () => {
  it("parses getUpdates conflict responses and marks them retryable", async () => {
    const description =
      "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: false, error_code: 409, description }), {
          status: 409,
          headers: {
            "content-type": "application/json",
          },
        }),
      ),
    );

    const client = new TelegramClient("token");

    let thrown: unknown;
    try {
      await client.getUpdates(101, 30);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(TelegramApiError);
    expect(thrown).toMatchObject({
      method: "getUpdates",
      status: 409,
      description,
    });
    expect(isTransientTelegramError(thrown)).toBe(true);
    expect(summarizeTelegramError(thrown)).toEqual({
      code: "409",
      message: description,
    });
  });

  it("does not mark non-poll Telegram API errors as retryable", () => {
    expect(isTransientTelegramError(new TelegramApiError("sendMessage", 409, "Conflict"))).toBe(false);
    expect(isTransientTelegramError(new TelegramApiError("getUpdates", 401, "Unauthorized"))).toBe(false);
  });

  it("identifies no-op editMessageText errors", () => {
    expect(
      isTelegramMessageNotModifiedError(
        new TelegramApiError("editMessageText", 400, "Bad Request: message is not modified"),
      ),
    ).toBe(true);
    expect(isTelegramMessageNotModifiedError(new TelegramApiError("sendMessage", 400, "Bad Request"))).toBe(false);
  });

  it("retries sendMessage after Telegram rate limits", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        telegramErrorResponse(429, {
          ok: false,
          error_code: 429,
          description: "Too Many Requests",
          parameters: {
            retry_after: 2,
          },
        }),
      )
      .mockResolvedValueOnce(telegramSuccessResponse({ message_id: 42 }));
    vi.stubGlobal("fetch", fetch);

    const client = new TelegramClient("token");
    const messageIdPromise = client.sendMessage(7, "hello");

    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(messageIdPromise).resolves.toBe(42);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("shares the Telegram retry window across write requests", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        telegramErrorResponse(429, {
          ok: false,
          error_code: 429,
          description: "Too Many Requests: retry after 3",
        }),
      )
      .mockResolvedValueOnce(telegramSuccessResponse({ message_id: 99 }))
      .mockResolvedValueOnce(telegramSuccessResponse({ message_id: 99 }));
    vi.stubGlobal("fetch", fetch);

    const client = new TelegramClient("token");
    const firstMessagePromise = client.sendMessage(7, "first");

    await vi.advanceTimersByTimeAsync(0);

    const secondMessagePromise = client.sendMessage(7, "second");

    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_999);
    expect(fetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(firstMessagePromise).resolves.toBe(99);
    await expect(secondMessagePromise).resolves.toBe(99);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("rechecks the retry window if it is extended while a request is already waiting", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValueOnce(telegramSuccessResponse({ message_id: 100 }));
    vi.stubGlobal("fetch", fetch);

    const client = new TelegramClient("token");
    client["retryAfterDeadlineMsByLane"].set("write", Date.now() + 2_000);

    const messagePromise = client.sendMessage(7, "first");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetch).not.toHaveBeenCalled();

    client["retryAfterDeadlineMsByLane"].set("write", Date.now() + 2_000);

    await vi.advanceTimersByTimeAsync(999);
    expect(fetch).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_001);
    await expect(messagePromise).resolves.toBe(100);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not block callback acknowledgements on the write retry window", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        telegramErrorResponse(429, {
          ok: false,
          error_code: 429,
          description: "Too Many Requests: retry after 3",
        }),
      )
      .mockResolvedValueOnce(telegramSuccessResponse(true))
      .mockResolvedValueOnce(telegramSuccessResponse({ message_id: 99 }));
    vi.stubGlobal("fetch", fetch);

    const client = new TelegramClient("token");
    const sendPromise = client.sendMessage(7, "first");

    await vi.advanceTimersByTimeAsync(0);

    const callbackPromise = client.answerCallbackQuery("callback-1");

    await vi.advanceTimersByTimeAsync(0);
    await expect(callbackPromise).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(3_000);
    await expect(sendPromise).resolves.toBe(99);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("does not block polling on the write retry window", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        telegramErrorResponse(429, {
          ok: false,
          error_code: 429,
          description: "Too Many Requests: retry after 3",
        }),
      )
      .mockResolvedValueOnce(telegramSuccessResponse([]))
      .mockResolvedValueOnce(telegramSuccessResponse({ message_id: 99 }));
    vi.stubGlobal("fetch", fetch);

    const client = new TelegramClient("token");
    const sendPromise = client.sendMessage(7, "first");

    await vi.advanceTimersByTimeAsync(0);

    const updatesPromise = client.getUpdates(101, 30);

    await vi.advanceTimersByTimeAsync(0);
    await expect(updatesPromise).resolves.toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(3_000);
    await expect(sendPromise).resolves.toBe(99);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("ignores expired callback query errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        telegramErrorResponse(400, {
          ok: false,
          error_code: 400,
          description: "Bad Request: query is too old and response timeout expired or query ID is invalid",
        }),
      ),
    );

    const client = new TelegramClient("token");

    await expect(client.answerCallbackQuery("callback-1")).resolves.toBeUndefined();
  });

  it("still throws unrelated answerCallbackQuery errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        telegramErrorResponse(400, {
          ok: false,
          error_code: 400,
          description: "Bad Request: BUTTON_DATA_INVALID",
        }),
      ),
    );

    const client = new TelegramClient("token");

    await expect(client.answerCallbackQuery("callback-1")).rejects.toMatchObject({
      method: "answerCallbackQuery",
      status: 400,
      description: "Bad Request: BUTTON_DATA_INVALID",
    });
  });
});
