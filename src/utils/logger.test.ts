import { describe, expect, it, vi } from "vitest";

import { logger } from "./logger.js";

describe("logger", () => {
  it("redacts sensitive values from log metadata", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    logger.error("test", {
      token: "123456789:abcdefghijklmnopqrstuvwxyzABCDE",
      env: "TELEGRAM_BOT_TOKEN=123456789:abcdefghijklmnopqrstuvwxyzABCDE",
      path: "/Users/xudong/project/file.txt",
    });

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("ERROR"),
      "test",
      expect.objectContaining({
        token: "[REDACTED_TELEGRAM_BOT_TOKEN]",
        env: "TELEGRAM_BOT_TOKEN=[REDACTED]",
        path: "/Users/[REDACTED]/project/file.txt",
      }),
    );

    spy.mockRestore();
  });
});
