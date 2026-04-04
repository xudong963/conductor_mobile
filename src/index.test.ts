import { describe, expect, it, vi } from "vitest";

vi.mock("./config.js", () => ({
  config: {
    telegramToken: "test-telegram-token",
    allowedChatIds: null,
    bridgeDbPath: "/tmp/bridge.db",
    conductorDbPath: "/tmp/conductor.db",
    claudeBin: "/tmp/claude",
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
import { TelegramApiError } from "./telegram/client.js";
import { homeKeyboard } from "./telegram/ui.js";

function createDeferred() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((resolver) => {
    resolve = resolver;
  });
  return {
    promise,
    resolve: () => resolve?.(),
  };
}

async function flushBackgroundTasks(bridge: TelegramConductorBridge): Promise<void> {
  while (true) {
    const tasks = [
      ...(
        bridge as unknown as {
          backgroundTasks: Set<Promise<void>>;
        }
      ).backgroundTasks,
    ];
    if (tasks.length === 0) {
      await Promise.resolve();
      if (
        (
          bridge as unknown as {
            backgroundTasks: Set<Promise<void>>;
          }
        ).backgroundTasks.size === 0
      ) {
        return;
      }
      continue;
    }
    await Promise.allSettled(tasks);
  }
}

function createBridge() {
  const claude = {
    interruptTurn: vi.fn().mockResolvedValue(undefined),
    resumeThread: vi.fn().mockResolvedValue(undefined),
    startTurn: vi.fn().mockResolvedValue({ turnId: "turn-1" }),
    startThread: vi.fn().mockResolvedValue("claude-thread-1"),
    archiveThread: vi.fn().mockResolvedValue(undefined),
  };
  const codex = {
    archiveThread: vi.fn().mockResolvedValue(undefined),
    interruptTurn: vi.fn().mockResolvedValue(undefined),
    resumeThread: vi.fn().mockResolvedValue(undefined),
    respondError: vi.fn().mockResolvedValue(undefined),
    startThread: vi.fn().mockResolvedValue("thread-1"),
    startTurn: vi.fn().mockResolvedValue({ turnId: "turn-1" }),
  };
  const mirror = {
    appendUserMessage: vi.fn(),
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
    countQueuedPrompts: vi.fn().mockReturnValue(0),
    findFollowingTopic: vi.fn(),
    getConversationContext: vi.fn(),
    getSessionTopic: vi.fn(),
    setTelegramCursor: vi.fn(),
    getSessionById: vi.fn(),
    listQueueForSession: vi.fn().mockReturnValue([]),
    listFollowingConversations: vi.fn(),
    listQueuedSessionIds: vi.fn().mockReturnValue([]),
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
    claude: claude as never,
    codex: codex as never,
    mirror: mirror as never,
    registry: registry as never,
    stateStore: stateStore as never,
    telegram: telegram as never,
  });

  return {
    bridge,
    claude,
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

  it("replies to the General forum topic without echoing its message_thread_id", async () => {
    const { bridge, stateStore, telegram } = createBridge();

    stateStore.getConversationContext.mockReturnValue({
      activeSessionId: null,
      activeWorkspaceId: null,
      chatId: -100123,
      composeMode: "none",
      composeTargetSessionId: null,
      composeTargetThreadId: null,
      composeTargetTurnId: null,
      composeWorkspaceId: null,
      followSessionId: null,
      messageThreadId: null,
      updatedAt: "2026-03-31T00:00:00.000Z",
    });

    await (
      bridge as unknown as {
        handleMessage: (message: {
          chat: { id: number; type: string };
          date: number;
          is_topic_message?: boolean;
          message_id: number;
          message_thread_id?: number;
          text?: string;
        }) => Promise<void>;
      }
    ).handleMessage({
      chat: { id: -100123, type: "supergroup" },
      date: 0,
      is_topic_message: false,
      message_id: 7,
      message_thread_id: 321,
      text: "/start@conductor_coding_bot",
    });
    await flushBackgroundTasks(bridge);

    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(telegram.sendMessage.mock.calls[0]?.[0]).toBe(-100123);
    expect(telegram.sendMessage.mock.calls[0]?.[1]).toContain("Conductor Telegram Bridge");
    expect(telegram.sendMessage.mock.calls[0]?.[2]).not.toHaveProperty("message_thread_id");
  });

  it("queues message handling so polling is not blocked by follow-up work", async () => {
    const { bridge } = createBridge();
    const deferred = createDeferred();
    const showHome = vi.fn().mockReturnValue(deferred.promise);

    (bridge as unknown as { showHome: typeof showHome }).showHome = showHome;

    await (
      bridge as unknown as {
        handleMessage: (message: {
          chat: { id: number; type: string };
          date: number;
          is_topic_message?: boolean;
          message_id: number;
          message_thread_id?: number;
          text?: string;
        }) => Promise<void>;
      }
    ).handleMessage({
      chat: { id: 99, type: "private" },
      date: 0,
      message_id: 7,
      text: "/home",
    });
    await Promise.resolve();

    expect(showHome).toHaveBeenCalledWith({ chatId: 99, messageThreadId: null });

    deferred.resolve();
    await flushBackgroundTasks(bridge);
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

  it("dispatches queue drains for every queued session without awaiting them inline", async () => {
    const { bridge, stateStore } = createBridge();
    const requestQueueDrain = vi.fn();

    stateStore.listQueuedSessionIds.mockReturnValue(["session-1", "session-2"]);
    (bridge as unknown as { requestQueueDrain: typeof requestQueueDrain }).requestQueueDrain = requestQueueDrain;

    await (
      bridge as unknown as {
        drainQueues: () => Promise<void>;
      }
    ).drainQueues();

    expect(requestQueueDrain).toHaveBeenCalledTimes(2);
    expect(requestQueueDrain).toHaveBeenNthCalledWith(1, "session-1");
    expect(requestQueueDrain).toHaveBeenNthCalledWith(2, "session-2");
  });

  it("pushes an immediate runtime update instead of sending a separate sent acknowledgement", async () => {
    const { bridge, codex, mirror, registry, stateStore } = createBridge();
    const pushRuntimeUpdate = vi.fn().mockResolvedValue(undefined);
    const safeSendMessage = vi.fn().mockResolvedValue(undefined);

    (
      registry as unknown as {
        resolveWorkspacePath: ReturnType<typeof vi.fn>;
      }
    ).resolveWorkspacePath = vi.fn().mockReturnValue("/tmp/workspaces/repo");
    stateStore.listFollowingConversations.mockReturnValue([{ chatId: 12, messageThreadId: null }]);
    (bridge as unknown as { pushRuntimeUpdate: typeof pushRuntimeUpdate }).pushRuntimeUpdate = pushRuntimeUpdate;
    (bridge as unknown as { safeSendMessage: typeof safeSendMessage }).safeSendMessage = safeSendMessage;

    const result = await (
      bridge as unknown as {
        submitPrompt: (
          location: { chatId: number; messageThreadId: number | null },
          session: {
            id: string;
            workspaceId: string;
            claudeSessionId: string | null;
            agentType: string | null;
            model: string | null;
          },
          text: string,
          fromQueue: boolean,
        ) => Promise<string>;
      }
    ).submitPrompt(
      { chatId: 12, messageThreadId: null },
      {
        id: "session-1",
        workspaceId: "workspace-1",
        claudeSessionId: "thread-1",
        agentType: "codex",
        model: "gpt-5.4",
      },
      "ship it",
      false,
    );

    expect(result).toBe("submitted");
    expect(codex.resumeThread).toHaveBeenCalled();
    expect(codex.startTurn).toHaveBeenCalled();
    expect(mirror.appendUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        turnId: "turn-1",
        text: "ship it",
      }),
    );
    expect(pushRuntimeUpdate).toHaveBeenCalledTimes(1);
    expect(safeSendMessage).not.toHaveBeenCalledWith({ chatId: 12, messageThreadId: null }, "Sent.");
  });

  it("routes Claude sessions through the Claude adapter", async () => {
    const { bridge, claude, codex, mirror, registry, stateStore } = createBridge();
    const pushRuntimeUpdate = vi.fn().mockResolvedValue(undefined);

    (
      registry as unknown as {
        resolveWorkspacePath: ReturnType<typeof vi.fn>;
      }
    ).resolveWorkspacePath = vi.fn().mockReturnValue("/tmp/workspaces/repo");
    stateStore.listFollowingConversations.mockReturnValue([{ chatId: 12, messageThreadId: null }]);
    (bridge as unknown as { pushRuntimeUpdate: typeof pushRuntimeUpdate }).pushRuntimeUpdate = pushRuntimeUpdate;

    const result = await (
      bridge as unknown as {
        submitPrompt: (
          location: { chatId: number; messageThreadId: number | null },
          session: {
            id: string;
            workspaceId: string;
            claudeSessionId: string | null;
            agentType: string | null;
            model: string | null;
          },
          text: string,
          fromQueue: boolean,
        ) => Promise<string>;
      }
    ).submitPrompt(
      { chatId: 12, messageThreadId: null },
      {
        id: "session-claude",
        workspaceId: "workspace-1",
        claudeSessionId: "claude-session-1",
        agentType: "claude",
        model: "opus-1m",
      },
      "ship it",
      false,
    );

    expect(result).toBe("submitted");
    expect(claude.resumeThread).toHaveBeenCalled();
    expect(claude.startTurn).toHaveBeenCalled();
    expect(codex.resumeThread).not.toHaveBeenCalled();
    expect(codex.startTurn).not.toHaveBeenCalled();
    expect(mirror.appendUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-claude",
        turnId: "turn-1",
        text: "ship it",
      }),
    );
    expect(pushRuntimeUpdate).toHaveBeenCalledTimes(1);
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

  it("rejects branch switching commands inside dedicated topics", async () => {
    const { bridge, telegram } = createBridge();
    const showBranches = vi.fn();

    (bridge as unknown as { showBranches: typeof showBranches }).showBranches = showBranches;

    await (
      bridge as unknown as {
        handleCommand: (location: { chatId: number; messageThreadId: number | null }, command: string) => Promise<void>;
      }
    ).handleCommand({ chatId: 99, messageThreadId: 77 }, "/branches");

    expect(showBranches).not.toHaveBeenCalled();
    expect(telegram.sendMessage).toHaveBeenCalledWith(
      99,
      "This topic is locked to its current chat. Use the main chat to switch repos, branches, open inbox, or select or create another chat.",
      { message_thread_id: 77 },
    );
  });

  it("rejects chat switching callbacks inside dedicated topics", async () => {
    const { bridge, telegram } = createBridge();
    const selectChat = vi.fn();

    (bridge as unknown as { selectChat: typeof selectChat }).selectChat = selectChat;

    await (
      bridge as unknown as {
        handleCallback: (callback: {
          id: string;
          data: string;
          from: { first_name: string; id: number; is_bot: boolean };
          message: {
            chat: { id: number; type: string };
            date: number;
            is_topic_message?: boolean;
            message_id: number;
            message_thread_id?: number;
            text?: string;
          };
        }) => Promise<void>;
      }
    ).handleCallback({
      id: "callback-1",
      data: "session:session-2",
      from: { first_name: "Tester", id: 99, is_bot: false },
      message: {
        chat: { id: 99, type: "supergroup" },
        date: 0,
        is_topic_message: true,
        message_id: 1,
        message_thread_id: 77,
        text: "button",
      },
    });

    expect(selectChat).not.toHaveBeenCalled();
    expect(telegram.answerCallbackQuery).toHaveBeenCalledWith(
      "callback-1",
      "This topic is locked to its current chat. Use the main chat.",
    );
  });

  it("schedules queue drain after a turn completes instead of awaiting it inline", async () => {
    const { bridge, registry } = createBridge();
    const requestQueueDrain = vi.fn();
    const pushRuntimeUpdate = vi.fn().mockResolvedValue(undefined);

    registry.findSessionByThreadId.mockReturnValue({ id: "session-1" });
    registry.getSessionById.mockReturnValue({
      id: "session-1",
      workspaceId: "workspace-1",
      status: "working",
      model: "gpt-5.4",
      title: "Fix freezing issue",
    });
    (bridge as unknown as { requestQueueDrain: typeof requestQueueDrain }).requestQueueDrain = requestQueueDrain;
    (bridge as unknown as { pushRuntimeUpdate: typeof pushRuntimeUpdate }).pushRuntimeUpdate = pushRuntimeUpdate;
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
      activityText: null,
      assistantText: "Done",
      lastEventAt: null,
      model: "gpt-5.4",
      planText: null,
      sessionId: "session-1",
      status: "active",
      threadId: "thread-1",
      turnId: "turn-1",
    });

    await (
      bridge as unknown as {
        onTurnCompleted: (params: Record<string, unknown>) => Promise<void>;
      }
    ).onTurnCompleted({
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        status: "completed",
      },
    });

    expect(pushRuntimeUpdate).toHaveBeenCalledTimes(1);
    expect(requestQueueDrain).toHaveBeenCalledWith("session-1");
  });

  it("acknowledges callbacks before finishing slower follow-up work", async () => {
    const { bridge, telegram } = createBridge();
    const deferred = createDeferred();
    const safeSendMessage = vi.fn().mockReturnValue(deferred.promise);

    (bridge as unknown as { safeSendMessage: typeof safeSendMessage }).safeSendMessage = safeSendMessage;

    await (
      bridge as unknown as {
        handleCallback: (callback: {
          id: string;
          data: string;
          from: { first_name: string; id: number; is_bot: boolean };
          message: {
            chat: { id: number; type: string };
            date: number;
            is_topic_message?: boolean;
            message_id: number;
            message_thread_id?: number;
            text?: string;
          };
        }) => Promise<void>;
      }
    ).handleCallback({
      id: "callback-help",
      data: "home:help",
      from: { first_name: "Tester", id: 99, is_bot: false },
      message: {
        chat: { id: 99, type: "private" },
        date: 0,
        message_id: 1,
        text: "button",
      },
    });
    await Promise.resolve();

    expect(telegram.answerCallbackQuery).toHaveBeenCalledWith("callback-help");
    expect(safeSendMessage).toHaveBeenCalledWith({ chatId: 99, messageThreadId: null }, expect.any(String));

    deferred.resolve();
    await flushBackgroundTasks(bridge);
  });

  it("clears stale new-chat compose mode inside dedicated topics", async () => {
    const { bridge, stateStore, telegram } = createBridge();
    const createNewSession = vi.fn();

    stateStore.getConversationContext.mockReturnValue({
      activeSessionId: "session-1",
      activeWorkspaceId: "workspace-1",
      chatId: 99,
      composeMode: "new_session",
      composeTargetSessionId: null,
      composeTargetThreadId: null,
      composeTargetTurnId: null,
      composeWorkspaceId: "workspace-1",
      followSessionId: "session-1",
      messageThreadId: 77,
      updatedAt: "2026-03-31T00:00:00.000Z",
    });
    (bridge as unknown as { createNewSession: typeof createNewSession }).createNewSession = createNewSession;

    await (
      bridge as unknown as {
        handlePlainText: (location: { chatId: number; messageThreadId: number | null }, text: string) => Promise<void>;
      }
    ).handlePlainText({ chatId: 99, messageThreadId: 77 }, "create another chat");

    expect(stateStore.clearConversationComposeMode).toHaveBeenCalledWith({ chatId: 99, messageThreadId: 77 });
    expect(createNewSession).not.toHaveBeenCalled();
    expect(telegram.sendMessage).toHaveBeenCalledWith(
      99,
      "This topic is locked to its current chat. Use the main chat to switch repos, branches, open inbox, or select or create another chat.",
      { message_thread_id: 77 },
    );
  });

  it("removes switching controls from the locked topic home keyboard", () => {
    const callbacks = homeKeyboard({ showStop: true, topicLocked: true })
      .flat()
      .map((button) => button.callback_data);

    expect(callbacks).toEqual(["home:continue", "home:stop", "home:help"]);
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

  it("treats no-op session panel edits as successful refreshes", async () => {
    const { bridge, telegram } = createBridge();

    telegram.editMessageText.mockRejectedValueOnce(
      new TelegramApiError("editMessageText", 400, "Bad Request: message is not modified"),
    );

    const location = { chatId: 99, messageThreadId: null };
    const keyboard = [[{ text: "Refresh Status", callback_data: "panel:refresh" }]];
    (
      bridge as unknown as {
        sessionPanels: Map<
          string,
          {
            keyboardFingerprint: string;
            lastText: string;
            lastSentAt: number;
            messageId: number | null;
            sessionId: string | null;
          }
        >;
      }
    ).sessionPanels.set("99:0", {
      keyboardFingerprint: "[]",
      lastText: "Old panel text",
      lastSentAt: 0,
      messageId: 321,
      sessionId: "session-1",
    });

    await (
      bridge as unknown as {
        upsertSessionPanel: (
          location: { chatId: number; messageThreadId: number | null },
          sessionId: string | null,
          text: string,
          keyboard: Array<Array<{ text: string; callback_data: string }>>,
        ) => Promise<void>;
      }
    ).upsertSessionPanel(location, "session-1", "Fresh panel text", keyboard);

    expect(telegram.sendMessage).not.toHaveBeenCalled();
    expect(
      (
        bridge as unknown as {
          sessionPanels: Map<
            string,
            { lastText: string; keyboardFingerprint: string; lastSentAt: number; messageId: number | null }
          >;
        }
      ).sessionPanels.get("99:0"),
    ).toEqual(
      expect.objectContaining({
        keyboardFingerprint: JSON.stringify(keyboard),
        lastText: "Fresh panel text",
        messageId: 321,
        sessionId: "session-1",
      }),
    );
  });

  it("throttles rapid session panel edits for the same active chat", async () => {
    const { bridge, telegram } = createBridge();

    const location = { chatId: 99, messageThreadId: null };
    const keyboard = [[{ text: "Refresh Status", callback_data: "panel:refresh" }]];
    (
      bridge as unknown as {
        sessionPanels: Map<
          string,
          {
            keyboardFingerprint: string;
            lastText: string;
            lastSentAt: number;
            messageId: number | null;
            sessionId: string | null;
          }
        >;
      }
    ).sessionPanels.set("99:0", {
      keyboardFingerprint: JSON.stringify(keyboard),
      lastText: "Working...\nA short update",
      lastSentAt: Date.now(),
      messageId: 321,
      sessionId: "session-1",
    });

    await (
      bridge as unknown as {
        upsertSessionPanel: (
          location: { chatId: number; messageThreadId: number | null },
          sessionId: string | null,
          text: string,
          keyboard: Array<Array<{ text: string; callback_data: string }>>,
        ) => Promise<void>;
      }
    ).upsertSessionPanel(location, "session-1", "Working...\nA short update plus a bit more", keyboard);

    expect(telegram.editMessageText).not.toHaveBeenCalled();
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  it("treats no-op context viewer edits as successful refreshes", async () => {
    const { bridge, telegram } = createBridge();

    telegram.editMessageText.mockRejectedValueOnce(
      new TelegramApiError("editMessageText", 400, "Bad Request: message is not modified"),
    );

    const viewer = {
      entryCount: 1,
      keyboardFingerprint: null,
      lastText: "Old viewer text",
      limit: 12,
      location: { chatId: 99, messageThreadId: null },
      messageId: 123,
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

    expect(telegram.sendMessage).not.toHaveBeenCalled();
    expect(viewer.messageId).toBe(123);
    expect(viewer.lastText).toContain("assistant: hello");
    expect(viewer.keyboardFingerprint).toBe(
      JSON.stringify([
        [
          { text: "Refresh", callback_data: "context:refresh" },
          { text: "Close", callback_data: "context:close" },
        ],
      ]),
    );
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
      "Send the branch name for the new workspace in conductor_mobile. It will be created from master.",
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
      branch: "berlin",
    });

    (bridge as unknown as { selectBranch: typeof selectBranch }).selectBranch = selectBranch;

    await (
      bridge as unknown as {
        handlePlainText: (location: { chatId: number; messageThreadId: number | null }, text: string) => Promise<void>;
      }
    ).handlePlainText({ chatId: 99, messageThreadId: null }, "berlin");

    expect(registry.createWorkspace).toHaveBeenCalledWith("repo-1", "berlin");
    expect(stateStore.clearConversationComposeMode).toHaveBeenCalledWith({ chatId: 99, messageThreadId: null });
    expect(selectBranch).toHaveBeenCalledWith({ chatId: 99, messageThreadId: null }, "workspace-2", {
      prefix: "Created workspace: berlin",
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
    ).handlePlainText({ chatId: 99, messageThreadId: null }, "berlin");

    expect(registry.createWorkspace).not.toHaveBeenCalled();
    expect(stateStore.clearConversationComposeMode).toHaveBeenCalledWith({ chatId: 99, messageThreadId: null });
    expect(selectBranch).toHaveBeenCalledWith({ chatId: 99, messageThreadId: null }, "workspace-3", {
      prefix: "Workspace already exists: berlin",
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
