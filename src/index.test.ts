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
    updateWorkspaceActiveSession: vi.fn(),
    getWorkspaceById: vi.fn(),
  };
  const stateStore = {
    clearConversationComposeMode: vi.fn(),
    bindSessionTopic: vi.fn(),
    findFollowingTopic: vi.fn(),
    getConversationContext: vi.fn(),
    getSessionTopic: vi.fn(),
    setTelegramCursor: vi.fn(),
    getSessionById: vi.fn(),
    listQueueForSession: vi.fn().mockReturnValue([]),
    listFollowingConversations: vi.fn(),
    getNextQueuedPrompt: vi.fn(),
    markPromptStarted: vi.fn(),
    retryPrompt: vi.fn(),
    markPromptFinished: vi.fn(),
    setConversationComposeMode: vi.fn(),
    updateConversationContext: vi.fn(),
  };
  const telegram = {
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    createForumTopic: vi.fn(),
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

  it("includes the active execution detail in the runtime body", () => {
    const { bridge } = createBridge();

    const body = (
      bridge as unknown as {
        resolveRuntimeBody: (
          runtime: Record<string, unknown>,
          bodyOverride: string | undefined,
          activePlaceholder: string | null,
        ) => string | null;
      }
    ).resolveRuntimeBody(
      {
        activityText: "Running command: npm run build",
        assistantText: "Previous update",
        lastEventAt: "2026-03-29T14:57:38.107Z",
        model: null,
        planText: null,
        sessionId: "session-1",
        status: "active",
        threadId: "thread-1",
        turnId: "turn-1",
      },
      undefined,
      "Working...",
    );

    expect(body).toContain("Current activity: Running command: npm run build");
    expect(body).toContain("Last event: 2026-03-29 14:57");
    expect(body).toContain("Latest assistant text:");
    expect(body).toContain("Previous update");
  });

  it("surfaces command execution progress in the session panel", async () => {
    const { bridge, registry, stateStore, telegram } = createBridge();

    registry.findSessionByThreadId.mockReturnValue({ id: "session-1" });
    registry.getSessionById.mockReturnValue({
      id: "session-1",
      workspaceId: "workspace-1",
      status: "working",
      model: "gpt-5.4",
      title: "Fix freezing issue",
    });
    registry.getWorkspaceById.mockReturnValue({
      id: "workspace-1",
      branch: "xudong963/investigate-freeze",
      directoryName: "krakow",
      repositoryId: "repo-1",
      activeSessionId: "session-1",
      updatedAt: "2026-03-29 14:57:38",
      rootPath: "/tmp/workspaces/repo",
      repositoryName: "conductor_mobile",
    });
    stateStore.getConversationContext.mockReturnValue({
      activeSessionId: "session-1",
      activeWorkspaceId: "workspace-1",
      chatId: 12,
      composeMode: "none",
      composeTargetSessionId: null,
      composeTargetThreadId: null,
      composeTargetTurnId: null,
      composeWorkspaceId: null,
      followSessionId: "session-1",
      messageThreadId: null,
      updatedAt: "2026-03-29T14:57:38.107Z",
    });
    stateStore.listFollowingConversations.mockReturnValue([{ chatId: 12, messageThreadId: null }]);

    await (
      bridge as unknown as {
        handleCodexNotification: (notification: { method: string; params: Record<string, unknown> }) => Promise<void>;
      }
    ).handleCodexNotification({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "commandExecution",
          command: "npm run build",
        },
      },
    });

    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(telegram.sendMessage.mock.calls[0]?.[1]).toContain("Activity: Running command: npm run build");
    expect(telegram.sendMessage.mock.calls[0]?.[1]).toContain("Current activity: Running command: npm run build");
  });

  it("shows the current execution state in /queue output", async () => {
    const { bridge, stateStore, telegram } = createBridge();

    stateStore.listQueueForSession.mockReturnValue([
      {
        id: 9,
        status: "queued",
        text: "continue",
      },
    ]);
    (
      bridge as unknown as {
        resolveSelectedSession: (location: { chatId: number; messageThreadId: number | null }) => {
          id: string;
          status: string;
          title: string;
        };
      }
    ).resolveSelectedSession = vi.fn().mockReturnValue({
      id: "session-1",
      status: "working",
      title: "Fix freezing issue",
    });
    (
      bridge as unknown as {
        runtimes: Map<
          string,
          {
            activityText: string | null;
            assistantText: string;
            lastEventAt: string | null;
            model: string | null;
            planText: string | null;
            sessionId: string;
            status: "active" | "waiting_user_input" | "waiting_plan" | "completed" | "failed";
            threadId: string;
            turnId: string;
          }
        >;
      }
    ).runtimes.set("session-1", {
      activityText: "Running command: npm run build",
      assistantText: "",
      lastEventAt: "2026-03-29T14:57:38.107Z",
      model: null,
      planText: null,
      sessionId: "session-1",
      status: "active",
      threadId: "thread-1",
      turnId: "turn-1",
    });

    await (
      bridge as unknown as {
        showQueue: (location: { chatId: number; messageThreadId: number | null }) => Promise<void>;
      }
    ).showQueue({ chatId: 12, messageThreadId: null });

    expect(telegram.sendMessage).toHaveBeenCalledWith(
      12,
      expect.stringContaining("Current execution:\nRunning command: npm run build"),
      {},
    );
    expect(telegram.sendMessage.mock.calls[0]?.[1]).toContain("Current queue:");
    expect(telegram.sendMessage.mock.calls[0]?.[1]).toContain("queued · continue");
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

  it("falls back to a legacy following topic when bootstrapping the binding fails", () => {
    const { bridge, stateStore } = createBridge();

    stateStore.getSessionTopic.mockReturnValue(null);
    stateStore.findFollowingTopic.mockReturnValue({ chatId: 99, messageThreadId: 77 });
    stateStore.bindSessionTopic.mockImplementation(() => {
      throw new Error("database is locked");
    });

    const topicLocation = (
      bridge as unknown as {
        getKnownSessionTopicLocation: (
          location: { chatId: number; messageThreadId: number | null },
          session: { id: string },
        ) => { chatId: number; messageThreadId: number | null } | null;
      }
    ).getKnownSessionTopicLocation({ chatId: 99, messageThreadId: null }, { id: "session-1" });

    expect(topicLocation).toEqual({ chatId: 99, messageThreadId: 77 });
  });

  it("keeps working when a new topic is created but binding persistence fails", async () => {
    const { bridge, registry, stateStore, telegram } = createBridge();

    stateStore.getSessionTopic.mockReturnValue(null);
    stateStore.findFollowingTopic.mockReturnValue(null);
    stateStore.bindSessionTopic.mockImplementation(() => {
      throw new Error("write failed");
    });
    stateStore.updateConversationContext.mockReturnValue({});
    telegram.createForumTopic.mockResolvedValue({ message_thread_id: 321 });

    const session: { id: string; workspaceId: string; claudeSessionId: string | null } = {
      id: "session-1",
      workspaceId: "workspace-1",
      claudeSessionId: "thread-1",
    };

    const topicLocation = await (
      bridge as unknown as {
        ensureSessionTopicLocation: (
          location: { chatId: number; messageThreadId: number | null },
          session: { id: string; workspaceId: string; claudeSessionId: string | null },
        ) => Promise<{ chatId: number; messageThreadId: number | null } | null>;
      }
    ).ensureSessionTopicLocation({ chatId: 99, messageThreadId: null }, session);

    expect(topicLocation).toEqual({ chatId: 99, messageThreadId: 321 });
    expect(stateStore.updateConversationContext).toHaveBeenCalledWith(
      { chatId: 99, messageThreadId: 321 },
      expect.objectContaining({
        activeWorkspaceId: "workspace-1",
        activeSessionId: "session-1",
      }),
    );
    expect(registry.updateWorkspaceActiveSession).toHaveBeenCalledWith("workspace-1", "session-1");
  });

  it("ignores malformed createForumTopic responses instead of throwing", async () => {
    const { bridge, stateStore, telegram } = createBridge();

    stateStore.getSessionTopic.mockReturnValue(null);
    stateStore.findFollowingTopic.mockReturnValue(null);
    telegram.createForumTopic.mockResolvedValue({});

    const topicLocation = await (
      bridge as unknown as {
        ensureSessionTopicLocation: (
          location: { chatId: number; messageThreadId: number | null },
          session: { id: string; workspaceId: string; claudeSessionId: string | null },
        ) => Promise<{ chatId: number; messageThreadId: number | null } | null>;
      }
    ).ensureSessionTopicLocation(
      { chatId: 99, messageThreadId: null },
      { id: "session-1", workspaceId: "workspace-1", claudeSessionId: "thread-1" },
    );

    expect(topicLocation).toBeNull();
    expect(stateStore.bindSessionTopic).not.toHaveBeenCalled();
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
    expect(selectBranch).toHaveBeenCalledWith({ chatId: 99, messageThreadId: null }, "workspace-2", {
      prefix: "Created workspace: xudong963/berlin\nDirectory: berlin",
    });
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
    expect(selectBranch).toHaveBeenCalledWith({ chatId: 99, messageThreadId: null }, "workspace-3", {
      prefix: "Workspace already exists: xudong963/berlin",
    });
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
