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
      approvalPolicy: "never",
      sandbox: "danger-full-access",
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
