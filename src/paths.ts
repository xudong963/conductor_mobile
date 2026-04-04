import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const bridgeSupportDirectoryName = "conductor-tg";

export function expandHome(input: string, homeDir = os.homedir()): string {
  if (!input.startsWith("~")) {
    return input;
  }
  return path.join(homeDir, input.slice(1));
}

export function defaultBridgeSupportDir(homeDir = os.homedir()): string {
  return path.join(homeDir, "Library", "Application Support", bridgeSupportDirectoryName);
}

export function defaultBridgeEnvPath(homeDir = os.homedir()): string {
  return path.join(defaultBridgeSupportDir(homeDir), ".env");
}

export function defaultBridgeDbPath(homeDir = os.homedir()): string {
  return path.join(defaultBridgeSupportDir(homeDir), "bridge.db");
}

interface ResolveEnvFilePathOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  fileExists?: (filePath: string) => boolean;
  homeDir?: string;
}

export function resolveEnvFilePath(options: ResolveEnvFilePathOptions = {}): string {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const fileExists = options.fileExists ?? fs.existsSync;
  const homeDir = options.homeDir ?? os.homedir();

  const override = env.BRIDGE_ENV_PATH?.trim();
  if (override) {
    return path.resolve(expandHome(override, homeDir));
  }

  const cwdEnvPath = path.resolve(cwd, ".env");
  if (fileExists(cwdEnvPath)) {
    return cwdEnvPath;
  }

  return defaultBridgeEnvPath(homeDir);
}

export function resolveConfigPath(input: string, baseDir: string, homeDir = os.homedir()): string {
  const expanded = expandHome(input, homeDir);
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(baseDir, expanded);
}
