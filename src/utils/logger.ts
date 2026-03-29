type LogLevel = "debug" | "info" | "warn" | "error";

const rank: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const configured = (process.env.LOG_LEVEL ?? "info") as LogLevel;
const minLevel = rank[configured] ?? rank.info;

function sanitizeLogString(value: string): string {
  return value
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_TELEGRAM_BOT_TOKEN]")
    .replace(/(TELEGRAM_BOT_TOKEN=)\S+/g, "$1[REDACTED]")
    .replace(/\/Users\/[^/\s]+/g, "/Users/[REDACTED]");
}

function sanitizeLogValue(value: unknown, depth = 0): unknown {
  if (depth > 5) {
    return "[Truncated]";
  }
  if (typeof value === "string") {
    return sanitizeLogString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeLogValue(item, depth + 1));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeLogString(value.message),
      ...(value.cause !== undefined ? { cause: sanitizeLogValue(value.cause, depth + 1) } : {}),
    };
  }

  const entries = Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    sanitizeLogValue(item, depth + 1),
  ]);
  return Object.fromEntries(entries);
}

function log(level: LogLevel, message: string, meta?: unknown): void {
  if (rank[level] < minLevel) {
    return;
  }
  const prefix = `[${new Date().toISOString()}] ${level.toUpperCase()}`;
  if (meta === undefined) {
    console.log(prefix, message);
    return;
  }
  console.log(prefix, message, sanitizeLogValue(meta));
}

export const logger = {
  debug(message: string, meta?: unknown): void {
    log("debug", message, meta);
  },
  info(message: string, meta?: unknown): void {
    log("info", message, meta);
  },
  warn(message: string, meta?: unknown): void {
    log("warn", message, meta);
  },
  error(message: string, meta?: unknown): void {
    log("error", message, meta);
  },
};
