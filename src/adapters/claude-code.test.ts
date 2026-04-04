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

import { ClaudeCodeAdapter } from "./claude-code.js";

function createFakeChild(): ChildProcessWithoutNullStreams {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  return Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin: new PassThrough(),
    kill: vi.fn(),
  }) as unknown as ChildProcessWithoutNullStreams;
}

function writeJsonLine(child: ChildProcessWithoutNullStreams, payload: Record<string, unknown>): void {
  (child.stdout as PassThrough).write(`${JSON.stringify(payload)}\n`);
}

afterEach(() => {
  spawnMock.mockReset();
  vi.restoreAllMocks();
});

describe("ClaudeCodeAdapter", () => {
  it("starts a new session with --session-id and emits assistant text notifications", async () => {
    const child = createFakeChild();
    spawnMock.mockReturnValue(child);

    const adapter = new ClaudeCodeAdapter("/tmp/claude");
    const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
    adapter.on("notification", (notification) => notifications.push(notification));

    await adapter.resumeThread({
      threadId: "thread-1",
      allowMissingRollout: true,
    });

    const startPromise = adapter.startTurn({
      threadId: "thread-1",
      cwd: "/tmp/workspace",
      model: "opus-1m",
      input: "hello",
    });

    child.emit("spawn");
    const { turnId } = await startPromise;

    expect(spawnMock).toHaveBeenCalledWith(
      "/tmp/claude",
      expect.arrayContaining(["--session-id", "thread-1"]),
      expect.objectContaining({
        cwd: "/tmp/workspace",
      }),
    );

    writeJsonLine(child, {
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "text",
          text: "",
        },
      },
    });
    writeJsonLine(child, {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "text_delta",
          text: "hello",
        },
      },
    });
    writeJsonLine(child, {
      type: "stream_event",
      event: {
        type: "content_block_stop",
        index: 0,
      },
    });
    writeJsonLine(child, {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "hello",
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(notifications).toContainEqual({
      method: "turn/started",
      params: {
        threadId: "thread-1",
        turn: {
          id: turnId,
        },
      },
    });
    expect(
      notifications.some(
        (notification) => notification.method === "item/agentMessage/delta" && notification.params.delta === "hello",
      ),
    ).toBe(true);
    expect(
      notifications.some(
        (notification) =>
          notification.method === "item/completed" &&
          (notification.params.item as { type?: string; text?: string }).type === "agentMessage" &&
          (notification.params.item as { type?: string; text?: string }).text === "hello",
      ),
    ).toBe(true);
    expect(
      notifications.some(
        (notification) =>
          notification.method === "turn/completed" &&
          (notification.params.turn as { status?: string }).status === "completed",
      ),
    ).toBe(true);
  });

  it("translates Claude tool use into bridge activity notifications", async () => {
    const child = createFakeChild();
    spawnMock.mockReturnValue(child);

    const adapter = new ClaudeCodeAdapter("/tmp/claude");
    const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
    adapter.on("notification", (notification) => notifications.push(notification));

    const startPromise = adapter.startTurn({
      threadId: "thread-2",
      cwd: "/tmp/workspace",
      model: "opus-1m",
      input: "run tests",
    });

    child.emit("spawn");
    await startPromise;

    writeJsonLine(child, {
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "tool-1",
          name: "Bash",
          input: {},
        },
      },
    });
    writeJsonLine(child, {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 1,
        delta: {
          type: "input_json_delta",
          partial_json: '{"command":"npm test"}',
        },
      },
    });
    writeJsonLine(child, {
      type: "stream_event",
      event: {
        type: "content_block_stop",
        index: 1,
      },
    });
    writeJsonLine(child, {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: "ok",
          },
        ],
      },
    });
    writeJsonLine(child, {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done",
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(
      notifications.some(
        (notification) =>
          notification.method === "item/started" &&
          (notification.params.item as { type?: string; command?: string }).type === "commandExecution" &&
          (notification.params.item as { type?: string; command?: string }).command === "npm test",
      ),
    ).toBe(true);
    expect(
      notifications.some(
        (notification) =>
          notification.method === "item/completed" &&
          (notification.params.item as { type?: string; command?: string }).type === "commandExecution" &&
          (notification.params.item as { type?: string; command?: string }).command === "npm test",
      ),
    ).toBe(true);
  });

  it("kills the active child process on interrupt", async () => {
    const child = createFakeChild();
    spawnMock.mockReturnValue(child);

    const adapter = new ClaudeCodeAdapter("/tmp/claude");
    const startPromise = adapter.startTurn({
      threadId: "thread-3",
      cwd: "/tmp/workspace",
      model: "opus-1m",
      input: "interrupt me",
    });

    child.emit("spawn");
    const { turnId } = await startPromise;

    await adapter.interruptTurn({
      threadId: "thread-3",
      turnId,
    });

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
