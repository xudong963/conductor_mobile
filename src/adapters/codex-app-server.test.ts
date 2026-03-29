import { describe, expect, it, vi } from "vitest";

import { CodexAppServerAdapter } from "./codex-app-server.js";

describe("CodexAppServerAdapter.resumeThread", () => {
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
