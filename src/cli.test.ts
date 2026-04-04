import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { buildEnvText, isDirectExecution, isValidAllowedChatIds, isValidTelegramToken, parseEnvText } from "./cli.js";

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

  it("treats a symlinked bin path as direct execution", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-tg-cli-test-"));
    const targetPath = path.join(tempDir, "dist", "cli.js");
    const linkPath = path.join(tempDir, "bin", "conductor-tg");

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    fs.writeFileSync(targetPath, "#!/usr/bin/env node\n", "utf8");
    fs.symlinkSync(targetPath, linkPath);

    try {
      expect(isDirectExecution(linkPath, pathToFileURL(targetPath).href)).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
