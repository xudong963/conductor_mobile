import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

function loadEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function expandHome(input: string): string {
  if (!input.startsWith("~")) {
    return input;
  }
  return path.join(os.homedir(), input.slice(1));
}

loadEnvFile(path.resolve(process.cwd(), ".env"));

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(10),
  TELEGRAM_ALLOWED_CHAT_IDS: z.string().optional(),
  BRIDGE_DB_PATH: z.string().default(".context/bridge.db"),
  CONDUCTOR_DB_PATH: z.string().default("~/Library/Application Support/com.conductor.app/conductor.db"),
  CODEX_BIN: z.string().default("~/Library/Application Support/com.conductor.app/bin/codex"),
  WORKSPACES_ROOT: z.string().default("~/conductor/workspaces"),
  POLL_TIMEOUT_SECONDS: z.coerce.number().int().min(5).max(50).default(30),
  QUEUE_TICK_MS: z.coerce.number().int().min(250).default(750),
  PAGE_SIZE: z.coerce.number().int().min(5).max(30).default(12),
  DEFAULT_FALLBACK_MODEL: z.string().default("gpt-5.4"),
  DEFAULT_PERMISSION_MODE: z.string().default("default"),
});

const parsed = schema.parse(process.env);

const allowedChatIds = parsed.TELEGRAM_ALLOWED_CHAT_IDS
  ? new Set(
      parsed.TELEGRAM_ALLOWED_CHAT_IDS.split(",")
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) => Number.parseInt(x, 10))
        .filter((x) => Number.isFinite(x)),
    )
  : null;

export const config = {
  telegramToken: parsed.TELEGRAM_BOT_TOKEN,
  allowedChatIds,
  bridgeDbPath: path.resolve(expandHome(parsed.BRIDGE_DB_PATH)),
  conductorDbPath: path.resolve(expandHome(parsed.CONDUCTOR_DB_PATH)),
  codexBin: path.resolve(expandHome(parsed.CODEX_BIN)),
  workspacesRoot: path.resolve(expandHome(parsed.WORKSPACES_ROOT)),
  pollTimeoutSeconds: parsed.POLL_TIMEOUT_SECONDS,
  queueTickMs: parsed.QUEUE_TICK_MS,
  pageSize: parsed.PAGE_SIZE,
  defaultFallbackModel: parsed.DEFAULT_FALLBACK_MODEL,
  defaultPermissionMode: parsed.DEFAULT_PERMISSION_MODE,
};
