import { describe, expect, it, vi } from "vitest";

vi.mock("./config.js", () => ({
  config: {
    telegramToken: "test-telegram-token",
    allowedChatIds: null,
    bridgeDbPath: "/tmp/bridge.db",
    conductorDbPath: "/tmp/conductor.db",
    codexBin: "/tmp/codex",
    workspacesRoot: "/tmp/workspaces",
    pollTimeoutSeconds: 30,
    queueTickMs: 3000,
    pageSize: 12,
    defaultFallbackModel: "gpt-5.4",
    defaultPermissionMode: "default",
  },
}));

import { TelegramConductorBridge } from "./index.js";

function createBridge() {
  const codex = {
    respondError: vi.fn().mockResolvedValue(undefined),
  };
  const mirror = {
    updateSessionStatus: vi.fn(),
  };
  const registry = {
    findSessionByThreadId: vi.fn(),
    getSessionById: vi.fn(),
  };
  const stateStore = {
    setTelegramCursor: vi.fn(),
    getSessionById: vi.fn(),
    listFollowingConversations: vi.fn(),
    getNextQueuedPrompt: vi.fn(),
    markPromptStarted: vi.fn(),
    retryPrompt: vi.fn(),
    markPromptFinished: vi.fn(),
  };
  const telegram = {
    sendMessage: vi.fn().mockResolvedValue(null),
  };

  const bridge = new TelegramConductorBridge({
    codex: codex as never,
    mirror: mirror as never,
    registry: registry as never,
    stateStore: stateStore as never,
    telegram: telegram as never,
  });

  return {
    bridge,
    codex,
    mirror,
    registry,
    stateStore,
    telegram,
  };
}

describe("TelegramConductorBridge", () => {
  it("does not advance the Telegram cursor when update handling fails", async () => {
    const { bridge, stateStore, telegram } = createBridge();
    const handleUpdate = vi.fn().mockRejectedValue(new Error("boom"));

    (bridge as unknown as { handleUpdate: typeof handleUpdate }).handleUpdate = handleUpdate;

    const processed = await (
      bridge as unknown as {
        processPolledUpdate: (update: Record<string, unknown>) => Promise<boolean>;
      }
    ).processPolledUpdate({
      update_id: 42,
      message: {
        text: "/start",
        chat: { id: 99, type: "private" },
      },
    });

    expect(processed).toBe(false);
    expect(stateStore.setTelegramCursor).not.toHaveBeenCalled();
    expect(telegram.sendMessage).toHaveBeenCalledWith(99, "Failed to process that message. Please try again.", {});
  });

  it("responds with an error for unsupported codex server requests", async () => {
    const { bridge, codex } = createBridge();

    await (
      bridge as unknown as {
        handleCodexServerRequest: (request: {
          id: string;
          method: string;
          params: Record<string, unknown>;
        }) => Promise<void>;
      }
    ).handleCodexServerRequest({
      id: "req-1",
      method: "item/tool/unknown",
      params: {},
    });

    expect(codex.respondError).toHaveBeenCalledWith("req-1", {
      code: -32601,
      message: "Unsupported server request: item/tool/unknown",
    });
  });

  it("responds with an error when requestUserInput is missing required identifiers", async () => {
    const { bridge, codex } = createBridge();

    await (
      bridge as unknown as {
        handleCodexServerRequest: (request: {
          id: string;
          method: string;
          params: Record<string, unknown>;
        }) => Promise<void>;
      }
    ).handleCodexServerRequest({
      id: "req-2",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
      },
    });

    expect(codex.respondError).toHaveBeenCalledWith("req-2", {
      code: -32602,
      message: "requestUserInput is missing threadId, turnId, or itemId",
    });
  });

  it("requeues queued prompts after retryable submission failures", async () => {
    const { bridge, registry, stateStore } = createBridge();
    const submitPrompt = vi.fn().mockResolvedValue("retryable_failure");

    registry.getSessionById.mockReturnValue({
      id: "session-1",
      status: "idle",
    });
    stateStore.getNextQueuedPrompt.mockReturnValue({
      id: 7,
      text: "Retry this",
    });
    stateStore.listFollowingConversations.mockReturnValue([{ chatId: 12, messageThreadId: null }]);
    (bridge as unknown as { submitPrompt: typeof submitPrompt }).submitPrompt = submitPrompt;

    await (
      bridge as unknown as {
        drainQueueForSession: (sessionId: string) => Promise<void>;
      }
    ).drainQueueForSession("session-1");

    expect(stateStore.markPromptStarted).toHaveBeenCalledWith(7);
    expect(stateStore.retryPrompt).toHaveBeenCalledWith(7);
    expect(stateStore.markPromptFinished).not.toHaveBeenCalled();
  });
});
