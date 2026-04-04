import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  defaultBridgeDbPath,
  defaultBridgeEnvPath,
  defaultBridgeSupportDir,
  expandHome,
  resolveConfigPath,
  resolveEnvFilePath,
} from "./paths.js";

describe("paths", () => {
  it("expands home-relative paths", () => {
    expect(expandHome("~/tmp/example", "/Users/tester")).toBe("/Users/tester/tmp/example");
  });

  it("resolves the default macOS support paths", () => {
    expect(defaultBridgeSupportDir("/Users/tester")).toBe("/Users/tester/Library/Application Support/conductor-tg");
    expect(defaultBridgeEnvPath("/Users/tester")).toBe("/Users/tester/Library/Application Support/conductor-tg/.env");
    expect(defaultBridgeDbPath("/Users/tester")).toBe(
      "/Users/tester/Library/Application Support/conductor-tg/bridge.db",
    );
  });

  it("prefers BRIDGE_ENV_PATH over all other env file locations", () => {
    expect(
      resolveEnvFilePath({
        cwd: "/tmp/project",
        env: { BRIDGE_ENV_PATH: "~/custom/bridge.env" },
        fileExists: () => true,
        homeDir: "/Users/tester",
      }),
    ).toBe("/Users/tester/custom/bridge.env");
  });

  it("uses the repo-local .env when it exists", () => {
    const cwd = "/tmp/project";

    expect(
      resolveEnvFilePath({
        cwd,
        env: {},
        fileExists: (filePath) => filePath === path.resolve(cwd, ".env"),
        homeDir: "/Users/tester",
      }),
    ).toBe(path.resolve(cwd, ".env"));
  });

  it("falls back to the app support .env when no local file exists", () => {
    expect(
      resolveEnvFilePath({
        cwd: "/tmp/project",
        env: {},
        fileExists: () => false,
        homeDir: "/Users/tester",
      }),
    ).toBe("/Users/tester/Library/Application Support/conductor-tg/.env");
  });

  it("resolves relative config paths against the env file directory", () => {
    expect(resolveConfigPath(".context/bridge.db", "/tmp/project", "/Users/tester")).toBe(
      "/tmp/project/.context/bridge.db",
    );
  });

  it("keeps absolute and home-relative config paths intact", () => {
    expect(resolveConfigPath("/tmp/bridge.db", "/tmp/project", "/Users/tester")).toBe("/tmp/bridge.db");
    expect(resolveConfigPath("~/Library/custom.db", "/tmp/project", "/Users/tester")).toBe(
      "/Users/tester/Library/custom.db",
    );
  });
});
