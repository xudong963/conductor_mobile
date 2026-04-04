import { describe, expect, it } from "vitest";

import { buildEnvText, isValidAllowedChatIds, isValidTelegramToken, parseEnvText } from "./cli.js";

describe("cli env helpers", () => {
  it("parses env text while ignoring comments and blank lines", () => {
    expect(
      parseEnvText(`
# comment
TELEGRAM_BOT_TOKEN="123456:abcdef"

TELEGRAM_ALLOWED_CHAT_IDS=123,456
`),
    ).toEqual({
      TELEGRAM_ALLOWED_CHAT_IDS: "123,456",
      TELEGRAM_BOT_TOKEN: "123456:abcdef",
    });
  });

  it("renders env text from the template order and preserves extra keys", () => {
    const rendered = buildEnvText(
      ["TELEGRAM_BOT_TOKEN=", "TELEGRAM_ALLOWED_CHAT_IDS=", "BRIDGE_DB_PATH=bridge.db"].join("\n"),
      {
        TELEGRAM_BOT_TOKEN: "123456:abcdef",
        TELEGRAM_ALLOWED_CHAT_IDS: "123,456",
        BRIDGE_DB_PATH: "bridge.db",
        LOG_LEVEL: "debug",
      },
    );

    expect(rendered).toContain("TELEGRAM_BOT_TOKEN=123456:abcdef");
    expect(rendered).toContain("TELEGRAM_ALLOWED_CHAT_IDS=123,456");
    expect(rendered).toContain("BRIDGE_DB_PATH=bridge.db");
    expect(rendered).toContain("LOG_LEVEL=debug");
  });

  it("validates telegram tokens", () => {
    expect(isValidTelegramToken("123456:abcdef")).toBe(true);
    expect(isValidTelegramToken("short")).toBe(false);
  });

  it("validates allowed chat IDs", () => {
    expect(isValidAllowedChatIds("12345")).toBe(true);
    expect(isValidAllowedChatIds("-100123,456789")).toBe(true);
    expect(isValidAllowedChatIds("abc,123")).toBe(false);
    expect(isValidAllowedChatIds("")).toBe(false);
  });
});
