type LogLevel = "debug" | "info" | "warn" | "error";

const rank: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const configured = (process.env.LOG_LEVEL ?? "info") as LogLevel;
const minLevel = rank[configured] ?? rank.info;

function log(level: LogLevel, message: string, meta?: unknown): void {
  if (rank[level] < minLevel) {
    return;
  }
  const prefix = `[${new Date().toISOString()}] ${level.toUpperCase()}`;
  if (meta === undefined) {
    console.log(prefix, message);
    return;
  }
  console.log(prefix, message, meta);
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
