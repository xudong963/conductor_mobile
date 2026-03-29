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
    createWorkspace: vi.fn(),
    findWorkspaceByBranch: vi.fn(),
    getRepositoryById: vi.fn(),
    findSessionByThreadId: vi.fn(),
    getSessionById: vi.fn(),
    getWorkspaceById: vi.fn(),
  };
  const stateStore = {
    clearConversationComposeMode: vi.fn(),
    getConversationContext: vi.fn(),
    setTelegramCursor: vi.fn(),
    getSessionById: vi.fn(),
    listFollowingConversations: vi.fn(),
    getNextQueuedPrompt: vi.fn(),
    markPromptStarted: vi.fn(),
    retryPrompt: vi.fn(),
    markPromptFinished: vi.fn(),
    setConversationComposeMode: vi.fn(),
  };
  const telegram = {
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    editMessageText: vi.fn().mockResolvedValue(undefined),
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

  it("treats short status probes as status checks instead of chat input", async () => {
    const { bridge } = createBridge();
    const showStatus = vi.fn().mockResolvedValue(undefined);
    const submitPrompt = vi.fn();

    (bridge as unknown as { showStatus: typeof showStatus }).showStatus = showStatus;
    (bridge as unknown as { submitPrompt: typeof submitPrompt }).submitPrompt = submitPrompt;

    await (
      bridge as unknown as {
        handlePlainText: (location: { chatId: number; messageThreadId: number | null }, text: string) => Promise<void>;
      }
    ).handlePlainText({ chatId: 99, messageThreadId: null }, "目前什么状态");

    expect(showStatus).toHaveBeenCalledWith({ chatId: 99, messageThreadId: null });
    expect(submitPrompt).not.toHaveBeenCalled();
  });

  it("skips redundant context viewer edits when the rendered payload is unchanged", async () => {
    const { bridge, telegram } = createBridge();

    telegram.sendMessage.mockResolvedValueOnce(123);

    const viewer = {
      entryCount: 1,
      keyboardFingerprint: null,
      lastText: null,
      limit: 12,
      location: { chatId: 99, messageThreadId: null },
      messageId: null,
      pageIndex: 0,
      pages: ["assistant: hello"],
      sessionId: "session-1",
      sessionTitle: "Current Session",
    };

    await (
      bridge as unknown as {
        renderContextViewer: (viewer: unknown) => Promise<void>;
      }
    ).renderContextViewer(viewer);
    await (
      bridge as unknown as {
        renderContextViewer: (viewer: unknown) => Promise<void>;
      }
    ).renderContextViewer(viewer);

    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(telegram.editMessageText).not.toHaveBeenCalled();
  });

  it("arms new-workspace mode on the current repo", async () => {
    const { bridge, registry, stateStore, telegram } = createBridge();

    stateStore.getConversationContext.mockReturnValue({
      activeWorkspaceId: "workspace-1",
      composeWorkspaceId: null,
    });
    registry.getWorkspaceById.mockReturnValue({
      id: "workspace-1",
      repositoryId: "repo-1",
    });
    registry.getRepositoryById.mockReturnValue({
      id: "repo-1",
      repositoryName: "conductor_mobile",
      defaultBranch: "master",
    });

    await (
      bridge as unknown as {
        handleCommand: (location: { chatId: number; messageThreadId: number | null }, command: string) => Promise<void>;
      }
    ).handleCommand({ chatId: 99, messageThreadId: null }, "/new_workspace");

    expect(stateStore.setConversationComposeMode).toHaveBeenCalledWith(
      { chatId: 99, messageThreadId: null },
      "new_workspace",
      { composeWorkspaceId: "repo-1" },
    );
    expect(telegram.sendMessage).toHaveBeenCalledWith(
      99,
      "Send the full branch name for the new workspace in conductor_mobile. It will be created from master.",
      {},
    );
  });

  it("creates a workspace from compose mode and switches to it", async () => {
    const { bridge, registry, stateStore } = createBridge();
    const selectBranch = vi.fn().mockResolvedValue(undefined);

    stateStore.getConversationContext.mockReturnValue({
      activeWorkspaceId: "workspace-1",
      activeSessionId: null,
      composeMode: "new_workspace",
      composeWorkspaceId: "repo-1",
    });
    registry.getRepositoryById.mockReturnValue({
      id: "repo-1",
      repositoryName: "conductor_mobile",
      defaultBranch: "master",
    });
    registry.findWorkspaceByBranch.mockReturnValue(null);
    registry.createWorkspace.mockReturnValue({
      id: "workspace-2",
      repositoryId: "repo-1",
      directoryName: "berlin",
      branch: "xudong963/berlin",
    });

    (bridge as unknown as { selectBranch: typeof selectBranch }).selectBranch = selectBranch;

    await (
      bridge as unknown as {
        handlePlainText: (location: { chatId: number; messageThreadId: number | null }, text: string) => Promise<void>;
      }
    ).handlePlainText({ chatId: 99, messageThreadId: null }, "xudong963/berlin");

    expect(registry.createWorkspace).toHaveBeenCalledWith("repo-1", "xudong963/berlin");
    expect(stateStore.clearConversationComposeMode).toHaveBeenCalledWith({ chatId: 99, messageThreadId: null });
    expect(selectBranch).toHaveBeenCalledWith(
      { chatId: 99, messageThreadId: null },
      "workspace-2",
      { prefix: "Created workspace: xudong963/berlin\nDirectory: berlin" },
    );
  });

  it("switches to an existing workspace instead of creating a duplicate", async () => {
    const { bridge, registry, stateStore } = createBridge();
    const selectBranch = vi.fn().mockResolvedValue(undefined);

    stateStore.getConversationContext.mockReturnValue({
      activeWorkspaceId: "workspace-1",
      activeSessionId: null,
      composeMode: "new_workspace",
      composeWorkspaceId: "repo-1",
    });
    registry.getRepositoryById.mockReturnValue({
      id: "repo-1",
      repositoryName: "conductor_mobile",
      defaultBranch: "master",
    });
    registry.findWorkspaceByBranch.mockReturnValue({
      id: "workspace-3",
      repositoryId: "repo-1",
      directoryName: "berlin",
      branch: "xudong963/berlin",
    });

    (bridge as unknown as { selectBranch: typeof selectBranch }).selectBranch = selectBranch;

    await (
      bridge as unknown as {
        handlePlainText: (location: { chatId: number; messageThreadId: number | null }, text: string) => Promise<void>;
      }
    ).handlePlainText({ chatId: 99, messageThreadId: null }, "xudong963/berlin");

    expect(registry.createWorkspace).not.toHaveBeenCalled();
    expect(stateStore.clearConversationComposeMode).toHaveBeenCalledWith({ chatId: 99, messageThreadId: null });
    expect(selectBranch).toHaveBeenCalledWith(
      { chatId: 99, messageThreadId: null },
      "workspace-3",
      { prefix: "Workspace already exists: xudong963/berlin" },
    );
  });

  it("does not re-edit the context viewer when paging stays at the oldest page", async () => {
    const { bridge, telegram } = createBridge();

    const viewer = {
      entryCount: 1,
      keyboardFingerprint: null as string | null,
      lastText: null as string | null,
      limit: 12,
      location: { chatId: 99, messageThreadId: null },
      messageId: 456,
      pageIndex: 0,
      pages: ["assistant: hello"],
      sessionId: "session-1",
      sessionTitle: "Current Session",
    };

    viewer.lastText = (
      bridge as unknown as {
        renderContextViewerText: (state: unknown) => string;
      }
    ).renderContextViewerText(viewer);
    viewer.keyboardFingerprint = JSON.stringify(
      (
        bridge as unknown as {
          contextViewerKeyboard: (state: unknown) => unknown;
        }
      ).contextViewerKeyboard(viewer),
    );

    (
      bridge as unknown as {
        contextViewers: Map<string, unknown>;
      }
    ).contextViewers.set("99:0", viewer);

    await (
      bridge as unknown as {
        handleContextViewerCallback: (
          callback: {
            id: string;
            message: { message_id: number };
          },
          location: { chatId: number; messageThreadId: number | null },
          data: string,
        ) => Promise<void>;
      }
    ).handleContextViewerCallback(
      {
        id: "callback-1",
        message: { message_id: 456 },
      },
      { chatId: 99, messageThreadId: null },
      "context:older",
    );

    expect(telegram.editMessageText).not.toHaveBeenCalled();
    expect(telegram.answerCallbackQuery).toHaveBeenCalledWith("callback-1", "Already at the oldest page.");
  });
});
