import { afterEach, describe, expect, it, vi } from "vitest";

import { isTransientTelegramError, summarizeTelegramError, TelegramApiError, TelegramClient } from "./client.js";

afterEach(() => {
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
});
