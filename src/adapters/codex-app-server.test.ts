import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: spawnMock,
  };
});

import { buildCodexChildEnv, CodexAppServerAdapter } from "./codex-app-server.js";

const DEFAULT_CODEX_FEATURE_FLAGS = {
  "features.enable_request_compression": true,
  "features.collaboration_modes": true,
  "features.personality": true,
  "features.request_rule": true,
  "features.fast_mode": true,
} as const;

function createFakeChild(options?: { deferWriteCallback?: boolean }): {
  child: ChildProcessWithoutNullStreams;
  stdinWrite: ReturnType<typeof vi.fn>;
} {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdinWrite = vi.fn((_payload: string, callback?: (error?: Error | null) => void) => {
    if (!options?.deferWriteCallback) {
      callback?.(null);
    }
    return true;
  });

  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin: { write: stdinWrite },
    kill: vi.fn(),
  }) as unknown as ChildProcessWithoutNullStreams;

  return { child, stdinWrite };
}

afterEach(() => {
  spawnMock.mockReset();
  vi.restoreAllMocks();
});

describe("buildCodexChildEnv", () => {
  it("strips bridge-only environment variables before spawning codex", () => {
    const childEnv = buildCodexChildEnv({
      CLAUDE_BIN: "/tmp/claude",
      OPENAI_API_KEY: "keep-me",
      TELEGRAM_BOT_TOKEN: "drop-me",
      QUEUE_TICK_MS: "3000",
    });

    expect(childEnv.CLAUDE_BIN).toBeUndefined();
    expect(childEnv.OPENAI_API_KEY).toBe("keep-me");
    expect(childEnv.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(childEnv.QUEUE_TICK_MS).toBeUndefined();
  });
});

describe("CodexAppServerAdapter", () => {
  it("sends initialized after initialize succeeds", async () => {
    const { child, stdinWrite } = createFakeChild();
    spawnMock.mockReturnValue(child);

    const adapter = new CodexAppServerAdapter("/tmp/codex");
    const startPromise = adapter.start();

    expect(stdinWrite).toHaveBeenCalledTimes(1);
    const initializePayload = JSON.parse(stdinWrite.mock.calls[0]?.[0] ?? "{}") as {
      id?: string;
      method?: string;
    };

    expect(initializePayload.method).toBe("initialize");
    (child.stdout as PassThrough).write(
      `${JSON.stringify({ jsonrpc: "2.0", id: initializePayload.id, result: {} })}\n`,
    );

    await expect(startPromise).resolves.toBeUndefined();

    expect(stdinWrite).toHaveBeenCalledTimes(2);
    expect(JSON.parse(stdinWrite.mock.calls[1]?.[0] ?? "{}")).toEqual({
      jsonrpc: "2.0",
      method: "initialized",
    });
  });

  it("rejects start when the codex child emits an error", async () => {
    const { child } = createFakeChild({ deferWriteCallback: true });
    spawnMock.mockReturnValue(child);

    const adapter = new CodexAppServerAdapter("/tmp/codex");
    const startPromise = adapter.start();

    await Promise.resolve();
    child.emit("error", new Error("spawn ENOENT"));

    await expect(startPromise).rejects.toThrow("spawn ENOENT");
  });

  it("ignores missing rollout errors when explicitly allowed", async () => {
    const adapter = new CodexAppServerAdapter("/tmp/codex");
    const request = vi
      .fn()
      .mockRejectedValue(
        new Error('thread/resume: {"code":-32600,"message":"no rollout found for thread id thread-1"}'),
      );

    (adapter as unknown as { request: typeof request }).request = request;

    await expect(
      adapter.resumeThread({
        threadId: "thread-1",
        cwd: "/tmp/workspace",
        model: "gpt-5.4",
        allowMissingRollout: true,
      }),
    ).resolves.toBeUndefined();

    expect(request).toHaveBeenCalledWith("thread/resume", {
      threadId: "thread-1",
      cwd: "/tmp/workspace",
      model: "gpt-5.4",
      serviceTier: null,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      persistExtendedHistory: true,
      personality: null,
    });
  });

  it("still throws missing rollout errors by default", async () => {
    const adapter = new CodexAppServerAdapter("/tmp/codex");
    const error = new Error('thread/resume: {"code":-32600,"message":"no rollout found for thread id thread-1"}');
    const request = vi.fn().mockRejectedValue(error);

    (adapter as unknown as { request: typeof request }).request = request;

    await expect(
      adapter.resumeThread({
        threadId: "thread-1",
        cwd: "/tmp/workspace",
        model: "gpt-5.4",
      }),
    ).rejects.toBe(error);
  });

  it("persists extended history when starting threads", async () => {
    const adapter = new CodexAppServerAdapter("/tmp/codex");
    const request = vi.fn().mockResolvedValue({ thread: { id: "thread-9" } });

    (adapter as unknown as { request: typeof request }).request = request;

    await expect(
      adapter.startThread({
        cwd: "/tmp/workspace",
        model: "gpt-5.4",
      }),
    ).resolves.toBe("thread-9");

    expect(request).toHaveBeenCalledWith("thread/start", {
      cwd: "/tmp/workspace",
      model: "gpt-5.4",
      experimentalRawEvents: false,
      serviceTier: null,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      persistExtendedHistory: true,
      personality: null,
      config: DEFAULT_CODEX_FEATURE_FLAGS,
    });
  });

  it("omits nullish resume params instead of sending JSON nulls", async () => {
    const adapter = new CodexAppServerAdapter("/tmp/codex");
    const request = vi.fn().mockResolvedValue({});

    (adapter as unknown as { request: typeof request }).request = request;

    await expect(
      adapter.resumeThread({
        threadId: "thread-1",
        cwd: null,
        model: null,
      }),
    ).resolves.toBeUndefined();

    expect(request).toHaveBeenCalledWith("thread/resume", {
      threadId: "thread-1",
      serviceTier: null,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      persistExtendedHistory: true,
      personality: null,
    });
  });

  it("omits nullish turn params instead of sending JSON nulls", async () => {
    const adapter = new CodexAppServerAdapter("/tmp/codex");
    const request = vi.fn().mockResolvedValue({ turn: { id: "turn-1" } });

    (adapter as unknown as { request: typeof request }).request = request;

    await expect(
      adapter.startTurn({
        threadId: "thread-1",
        input: "ping",
        cwd: null,
        model: null,
        effort: null,
      }),
    ).resolves.toEqual({ turnId: "turn-1" });

    expect(request).toHaveBeenCalledWith("turn/start", {
      threadId: "thread-1",
      input: [{ type: "text", text: "ping", text_elements: [] }],
      serviceTier: null,
      summary: "none",
      sandboxPolicy: { type: "dangerFullAccess" },
      personality: null,
      collaborationMode: {
        mode: "default",
        settings: {
          model: null,
          reasoning_effort: null,
          developer_instructions: null,
        },
      },
    });
  });
});

describe("CodexAppServerAdapter.interruptTurn", () => {
  it("sends the turn/interrupt request with thread and turn ids", async () => {
    const adapter = new CodexAppServerAdapter("/tmp/codex");
    const request = vi.fn().mockResolvedValue({});

    (adapter as unknown as { request: typeof request }).request = request;

    await expect(
      adapter.interruptTurn({
        threadId: "thread-1",
        turnId: "turn-7",
      }),
    ).resolves.toBeUndefined();

    expect(request).toHaveBeenCalledWith("turn/interrupt", {
      threadId: "thread-1",
      turnId: "turn-7",
    });
  });
});
