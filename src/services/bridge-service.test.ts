import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BridgeStateStore } from "../bridge/state-store.js";
import { TelegramBridgeService } from "./bridge-service.js";
import type {
  CodexNotification,
  ConductorSessionRef,
  SessionDefaults,
  SessionStatus,
  TelegramInlineKeyboard,
  TelegramSendMessageOptions,
  TelegramUpdate,
  WorkspaceRef,
} from "../types.js";

interface SendMessageCall {
  chatId: number;
  text: string;
  options?: TelegramSendMessageOptions;
}

interface EditMessageCall {
  chatId: number;
  messageId: number;
  text: string;
  inlineKeyboard?: TelegramInlineKeyboard;
}

interface AnswerCallbackCall {
  id: string;
  text?: string;
}

interface UserMessageCall {
  sessionId: string;
  turnId: string;
  text: string;
  sentAt: string;
}

interface AssistantMessageCall {
  sessionId: string;
  threadId: string;
  turnId: string;
  text: string;
  sentAt: string;
  model: string | null;
}

class FakeTelegramClient {
  sentMessages: SendMessageCall[] = [];
  editedMessages: EditMessageCall[] = [];
  answeredCallbacks: AnswerCallbackCall[] = [];
  nextMessageId = 100;

  async getUpdates(): Promise<TelegramUpdate[]> {
    return [];
  }

  async sendMessage(chatId: number, text: string, options?: TelegramSendMessageOptions): Promise<number> {
    const call: SendMessageCall = { chatId, text };
    if (options) {
      call.options = options;
    }
    this.sentMessages.push(call);
    return this.nextMessageId++;
  }

  async editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    inlineKeyboard?: TelegramInlineKeyboard,
  ): Promise<void> {
    const call: EditMessageCall = { chatId, messageId, text };
    if (inlineKeyboard) {
      call.inlineKeyboard = inlineKeyboard;
    }
    this.editedMessages.push(call);
  }

  async answerCallbackQuery(id: string, text?: string): Promise<void> {
    const call: AnswerCallbackCall = { id };
    if (text) {
      call.text = text;
    }
    this.answeredCallbacks.push(call);
  }
}

class FakeRegistryAdapter {
  private readonly workspaces = new Map<string, WorkspaceRef>();
  private readonly sessions = new Map<string, ConductorSessionRef>();
  private readonly workspacePaths = new Map<string, string>();
  readonly createdSessions: Array<{
    workspaceId: string;
    threadId: string;
    seed: { model: string; permissionMode: string; title: string };
  }> = [];
  readonly appendedMessages: Array<{
    sessionId: string;
    role: "user" | "assistant";
    content: string;
    turnId: string;
    model: string | null;
    sentAt: string;
  }> = [];
  private sessionCounter = 0;

  constructor(options?: {
    workspaces?: WorkspaceRef[];
    sessions?: ConductorSessionRef[];
    workspacePaths?: Record<string, string>;
  }) {
    for (const workspace of options?.workspaces ?? []) {
      this.workspaces.set(workspace.id, { ...workspace });
    }
    for (const session of options?.sessions ?? []) {
      this.sessions.set(session.id, { ...session });
    }
    for (const [workspaceId, workspacePath] of Object.entries(options?.workspacePaths ?? {})) {
      this.workspacePaths.set(workspaceId, workspacePath);
    }
  }

  listWorkspaces(limit: number): WorkspaceRef[] {
    return [...this.workspaces.values()].slice(0, limit).map((workspace) => ({ ...workspace }));
  }

  getWorkspaceById(workspaceId: string): WorkspaceRef | null {
    const workspace = this.workspaces.get(workspaceId);
    return workspace ? { ...workspace } : null;
  }

  listSessions(workspaceId: string, limit: number): ConductorSessionRef[] {
    return [...this.sessions.values()]
      .filter((session) => session.workspaceId === workspaceId)
      .slice(0, limit)
      .map((session) => ({ ...session }));
  }

  getSessionById(sessionId: string): ConductorSessionRef | null {
    const session = this.sessions.get(sessionId);
    return session ? { ...session } : null;
  }

  findSessionByThreadId(threadId: string): ConductorSessionRef | null {
    for (const session of this.sessions.values()) {
      if (session.claudeSessionId === threadId) {
        return { ...session };
      }
    }
    return null;
  }

  getInboxSessions(limit: number): ConductorSessionRef[] {
    return [...this.sessions.values()]
      .filter((session) => ["needs_user_input", "needs_plan_response", "error"].includes(session.status))
      .slice(0, limit)
      .map((session) => ({ ...session }));
  }

  getSessionDefaults(): SessionDefaults {
    return {
      model: "gpt-5.4",
      permissionMode: "default",
    };
  }

  resolveWorkspacePath(workspaceId: string): string {
    return this.workspacePaths.get(workspaceId) ?? `/tmp/${workspaceId}`;
  }

  updateWorkspaceActiveSession(workspaceId: string, sessionId: string): void {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      return;
    }
    workspace.activeSessionId = sessionId;
  }

  updateSessionStatus(sessionId: string, status: SessionStatus): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    session.status = status;
  }

  updateSessionLastUserMessageAt(sessionId: string, sentAtIso: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    session.lastUserMessageAt = sentAtIso;
  }

  createSession(
    workspaceId: string,
    threadId: string,
    seed: { model: string; permissionMode: string; title: string },
  ): ConductorSessionRef {
    this.sessionCounter += 1;
    const session: ConductorSessionRef = {
      id: `created-session-${this.sessionCounter}`,
      workspaceId,
      status: "idle",
      agentType: "codex",
      model: seed.model,
      permissionMode: seed.permissionMode,
      title: seed.title,
      claudeSessionId: threadId,
      updatedAt: "2026-03-29T00:00:00.000Z",
      lastUserMessageAt: null,
    };
    this.createdSessions.push({ workspaceId, threadId, seed });
    this.sessions.set(session.id, { ...session });
    this.updateWorkspaceActiveSession(workspaceId, session.id);
    return { ...session };
  }

  appendSessionMessage(params: {
    sessionId: string;
    role: "user" | "assistant";
    content: string;
    turnId: string;
    model: string | null;
    sentAt: string;
  }): string {
    this.appendedMessages.push(params);
    return `message-${this.appendedMessages.length}`;
  }
}

class FakeMirrorWriter {
  readonly userMessages: UserMessageCall[] = [];
  readonly assistantMessages: AssistantMessageCall[] = [];
  readonly statusUpdates: Array<{ sessionId: string; status: SessionStatus }> = [];

  constructor(private readonly registry: FakeRegistryAdapter) {}

  appendUserMessage(params: UserMessageCall): "ok" {
    this.userMessages.push(params);
    this.registry.appendSessionMessage({
      sessionId: params.sessionId,
      role: "user",
      content: params.text,
      turnId: params.turnId,
      model: null,
      sentAt: params.sentAt,
    });
    this.registry.updateSessionLastUserMessageAt(params.sessionId, params.sentAt);
    return "ok";
  }

  appendAssistantMessage(params: AssistantMessageCall): "ok" {
    this.assistantMessages.push(params);
    this.registry.appendSessionMessage({
      sessionId: params.sessionId,
      role: "assistant",
      content: params.text,
      turnId: params.turnId,
      model: params.model,
      sentAt: params.sentAt,
    });
    return "ok";
  }

  updateSessionStatus(sessionId: string, status: SessionStatus): void {
    this.statusUpdates.push({ sessionId, status });
    this.registry.updateSessionStatus(sessionId, status);
  }
}

class FakeCodexAppServerAdapter {
  readonly startedThreads: Array<{ cwd: string; model: string }> = [];
  readonly resumedThreads: Array<{ threadId: string; cwd?: string | null; model?: string | null }> = [];
  readonly startedTurns: Array<{
    threadId: string;
    input: string;
    cwd?: string | null;
    model?: string | null;
    turnId: string;
  }> = [];
  readonly steeredTurns: Array<{ threadId: string; expectedTurnId: string; input: string }> = [];
  readonly interruptedTurns: Array<{ threadId: string; turnId: string }> = [];
  readonly archivedThreads: string[] = [];
  private nextThreadId = 1;
  private nextTurnId = 1;

  async start(): Promise<void> {
    return;
  }

  async stop(): Promise<void> {
    return;
  }

  on(): void {
    return;
  }

  async startThread(options: { cwd: string; model: string }): Promise<string> {
    this.startedThreads.push(options);
    const threadId = `thread-${this.nextThreadId}`;
    this.nextThreadId += 1;
    return threadId;
  }

  async resumeThread(options: { threadId: string; cwd?: string | null; model?: string | null }): Promise<void> {
    this.resumedThreads.push(options);
  }

  async archiveThread(threadId: string): Promise<void> {
    this.archivedThreads.push(threadId);
  }

  async startTurn(options: {
    threadId: string;
    input: string;
    cwd?: string | null;
    model?: string | null;
  }): Promise<{ turnId: string }> {
    const turnId = `turn-${this.nextTurnId}`;
    this.nextTurnId += 1;
    this.startedTurns.push({ ...options, turnId });
    return { turnId };
  }

  async steerTurn(options: { threadId: string; expectedTurnId: string; input: string }): Promise<void> {
    this.steeredTurns.push(options);
  }

  async interruptTurn(options: { threadId: string; turnId: string }): Promise<void> {
    this.interruptedTurns.push(options);
  }
}

interface Fixture {
  service: TelegramBridgeService;
  stateStore: BridgeStateStore;
  telegram: FakeTelegramClient;
  registry: FakeRegistryAdapter;
  mirror: FakeMirrorWriter;
  codex: FakeCodexAppServerAdapter;
  cleanup: () => void;
}

const cleanups: Array<() => void> = [];
let updateId = 1;
const chatId = 42;

function createWorkspace(overrides?: Partial<WorkspaceRef>): WorkspaceRef {
  return {
    id: "workspace-1",
    directoryName: "victoria",
    branch: "master",
    repositoryId: "repo-1",
    activeSessionId: null,
    updatedAt: "2026-03-29T00:00:00.000Z",
    rootPath: "/repos/telegram-bridge",
    repositoryName: "telegram-bridge",
    ...overrides,
  };
}

function createSession(overrides?: Partial<ConductorSessionRef>): ConductorSessionRef {
  return {
    id: "session-1",
    workspaceId: "workspace-1",
    status: "idle",
    agentType: "codex",
    model: "gpt-5.4",
    permissionMode: "default",
    title: "Existing Session",
    claudeSessionId: "thread-existing",
    updatedAt: "2026-03-29T00:00:00.000Z",
    lastUserMessageAt: null,
    ...overrides,
  };
}

function createFixture(options?: { workspaces?: WorkspaceRef[]; sessions?: ConductorSessionRef[] }): Fixture {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-service-test-"));
  const stateStore = new BridgeStateStore(path.join(tempDir, "bridge.db"));
  stateStore.init();

  const telegram = new FakeTelegramClient();
  const registryOptions: {
    workspaces?: WorkspaceRef[];
    sessions?: ConductorSessionRef[];
    workspacePaths: Record<string, string>;
  } = {
    workspacePaths: {
      "workspace-1": "/tmp/workspace-1",
      "workspace-2": "/tmp/workspace-2",
    },
  };
  if (options?.workspaces) {
    registryOptions.workspaces = options.workspaces;
  }
  if (options?.sessions) {
    registryOptions.sessions = options.sessions;
  }
  const registry = new FakeRegistryAdapter(registryOptions);
  const mirror = new FakeMirrorWriter(registry);
  const codex = new FakeCodexAppServerAdapter();
  const service = new TelegramBridgeService(
    telegram as never,
    stateStore,
    registry as never,
    mirror as never,
    codex as never,
    {
      pollTimeoutSeconds: 30,
      queueTickMs: 100,
      pageSize: 12,
      allowedChatIds: new Set([chatId]),
    },
  );

  const cleanup = () => {
    (stateStore as unknown as { db: { close: () => void } }).db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  };

  cleanups.push(cleanup);
  return { service, stateStore, telegram, registry, mirror, codex, cleanup };
}

function messageUpdate(text: string, id = chatId): TelegramUpdate {
  const current = updateId;
  updateId += 1;
  return {
    update_id: current,
    message: {
      message_id: current,
      chat: { id, type: "private" },
      date: 1_742_000_000,
      text,
    },
  };
}

function callbackUpdate(data: string, id = chatId): TelegramUpdate {
  const current = updateId;
  updateId += 1;
  return {
    update_id: current,
    callback_query: {
      id: `callback-${current}`,
      from: { id, is_bot: false, first_name: "Tester" },
      message: {
        message_id: current,
        chat: { id, type: "private" },
        date: 1_742_000_000,
        text: "button",
      },
      data,
    },
  };
}

async function handleUpdate(fixture: Fixture, update: TelegramUpdate): Promise<void> {
  await (
    fixture.service as unknown as {
      handleUpdate: (update: TelegramUpdate) => Promise<void>;
    }
  ).handleUpdate(update);
}

async function handleNotification(fixture: Fixture, notification: CodexNotification): Promise<void> {
  await (
    fixture.service as unknown as {
      handleCodexNotification: (notification: CodexNotification) => Promise<void>;
    }
  ).handleCodexNotification(notification);
}

afterEach(() => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    cleanup?.();
  }
});

describe("TelegramBridgeService user flows", () => {
  it("rejects unauthorized chats before showing the home flow", async () => {
    const fixture = createFixture();

    await handleUpdate(fixture, messageUpdate("/start", 999));

    expect(fixture.telegram.sentMessages).toEqual([
      {
        chatId: 999,
        text: "Unauthorized account. Access to Conductor is disabled.",
      },
    ]);
  });

  it("lets the user pick a workspace, browse sessions, and switch the active session", async () => {
    const workspace = createWorkspace({
      activeSessionId: "session-1",
    });
    const session1 = createSession({
      id: "session-1",
      title: "Current Session",
    });
    const session2 = createSession({
      id: "session-2",
      title: "Second Session",
      claudeSessionId: "thread-2",
    });
    const fixture = createFixture({
      workspaces: [workspace],
      sessions: [session1, session2],
    });

    await handleUpdate(fixture, callbackUpdate("workspace:workspace-1"));
    await handleUpdate(fixture, messageUpdate("/sessions"));
    await handleUpdate(fixture, callbackUpdate("session:session-2"));

    expect(fixture.telegram.sentMessages[0]?.text).toContain("telegram-bridge [victoria] / Current Session / idle");
    expect(fixture.telegram.sentMessages[1]?.text).toContain("1. Current Session");
    expect(fixture.telegram.sentMessages[1]?.text).toContain("2. Second Session");
    expect(fixture.stateStore.getChatContext(chatId).activeSessionId).toBe("session-2");
    expect(fixture.registry.getWorkspaceById("workspace-1")?.activeSessionId).toBe("session-2");
    expect(fixture.telegram.sentMessages[2]?.text).toContain("telegram-bridge [victoria] / Second Session / idle");
    expect(fixture.telegram.answeredCallbacks.map((call) => call.id)).toEqual(["callback-2", "callback-4"]);
  });

  it("shows the workspace picker when /new is used before selecting a workspace", async () => {
    const fixture = createFixture({
      workspaces: [createWorkspace(), createWorkspace({ id: "workspace-2", directoryName: "demo" })],
    });

    await handleUpdate(fixture, messageUpdate("/new"));

    expect(fixture.telegram.sentMessages).toHaveLength(1);
    expect(fixture.telegram.sentMessages[0]?.text).toBe("Select a workspace before creating a new session.");
    expect(fixture.telegram.sentMessages[0]?.options?.reply_markup?.inline_keyboard).toHaveLength(3);
  });

  it("creates a new session from the next user message and starts the first turn", async () => {
    const workspace = createWorkspace();
    const fixture = createFixture({ workspaces: [workspace] });
    fixture.stateStore.setActiveWorkspace(chatId, "workspace-1");

    await handleUpdate(fixture, messageUpdate("/new"));
    await handleUpdate(fixture, messageUpdate("Build login flow\nwith retry handling"));

    const context = fixture.stateStore.getChatContext(chatId);
    expect(context.composeMode).toBe("none");
    expect(context.activeSessionId).toBe("created-session-1");
    expect(fixture.codex.startedThreads).toEqual([{ cwd: "/tmp/workspace-1", model: "gpt-5.4" }]);
    expect(fixture.registry.createdSessions[0]).toEqual({
      workspaceId: "workspace-1",
      threadId: "thread-1",
      seed: {
        model: "gpt-5.4",
        permissionMode: "default",
        title: "Build login flow",
      },
    });
    expect(fixture.codex.resumedThreads[0]).toEqual({
      threadId: "thread-1",
      cwd: "/tmp/workspace-1",
      model: "gpt-5.4",
      allowMissingRollout: true,
    });
    expect(fixture.codex.startedTurns[0]).toMatchObject({
      threadId: "thread-1",
      input: "Build login flow\nwith retry handling",
      cwd: "/tmp/workspace-1",
      model: "gpt-5.4",
      turnId: "turn-1",
    });
    expect(fixture.mirror.userMessages[0]).toMatchObject({
      sessionId: "created-session-1",
      turnId: "turn-1",
      text: "Build login flow\nwith retry handling",
    });
    expect(fixture.telegram.sentMessages.map((call) => call.text)).toEqual([
      "Your next message will create a new session in the current workspace.",
      "Created session: Build login flow. Starting the first turn.",
    ]);
  });

  it("queues extra user input while a session is already working and exposes it in /queue", async () => {
    const workspace = createWorkspace({
      activeSessionId: "session-1",
    });
    const session = createSession();
    const fixture = createFixture({
      workspaces: [workspace],
      sessions: [session],
    });
    fixture.stateStore.updateChatContext(chatId, {
      activeWorkspaceId: "workspace-1",
      activeSessionId: "session-1",
      followSessionId: "session-1",
    });

    await handleUpdate(fixture, messageUpdate("First prompt"));
    await handleUpdate(fixture, messageUpdate("Second prompt"));
    await handleUpdate(fixture, messageUpdate("/queue"));

    expect(fixture.codex.startedTurns).toHaveLength(1);
    expect(fixture.codex.startedTurns[0]?.input).toBe("First prompt");
    expect(fixture.telegram.sentMessages[0]?.text).toBe(
      "The current session is working. Your message has been queued.",
    );
    expect(fixture.telegram.sentMessages[1]?.text).toContain("[queued] Second prompt");
    expect(fixture.stateStore.listQueueForSession("session-1", 5)[0]?.text).toBe("Second prompt");
  });

  it("treats short status probes as read-only status checks instead of queueing them", async () => {
    const workspace = createWorkspace({
      activeSessionId: "session-1",
    });
    const session = createSession({
      status: "working",
    });
    const fixture = createFixture({
      workspaces: [workspace],
      sessions: [session],
    });
    fixture.stateStore.updateChatContext(chatId, {
      activeWorkspaceId: "workspace-1",
      activeSessionId: "session-1",
      followSessionId: "session-1",
    });

    await handleUpdate(fixture, messageUpdate("目前什么状态"));

    expect(fixture.codex.startedTurns).toHaveLength(0);
    expect(fixture.stateStore.listQueueForSession("session-1", 5)).toHaveLength(0);
    expect(fixture.telegram.sentMessages[0]?.text).toContain("Home");
    expect(fixture.telegram.sentMessages[0]?.text).toContain("working");
  });

  it("interrupts the active turn with /stop", async () => {
    const workspace = createWorkspace({
      activeSessionId: "session-1",
    });
    const session = createSession();
    const fixture = createFixture({
      workspaces: [workspace],
      sessions: [session],
    });
    fixture.stateStore.updateChatContext(chatId, {
      activeWorkspaceId: "workspace-1",
      activeSessionId: "session-1",
      followSessionId: "session-1",
    });

    await handleUpdate(fixture, messageUpdate("First prompt"));
    await handleUpdate(fixture, messageUpdate("/stop"));

    expect(fixture.codex.interruptedTurns).toEqual([{ threadId: "thread-existing", turnId: "turn-1" }]);
    expect(fixture.telegram.sentMessages.at(-1)?.text).toBe("Interrupt requested.");
    expect(fixture.registry.getSessionById("session-1")?.status).toBe("cancelling");
  });

  it("interrupts the active turn with /stop@botname", async () => {
    const workspace = createWorkspace({
      activeSessionId: "session-1",
    });
    const session = createSession();
    const fixture = createFixture({
      workspaces: [workspace],
      sessions: [session],
    });
    fixture.stateStore.updateChatContext(chatId, {
      activeWorkspaceId: "workspace-1",
      activeSessionId: "session-1",
      followSessionId: "session-1",
    });

    await handleUpdate(fixture, messageUpdate("First prompt"));
    await handleUpdate(fixture, messageUpdate("/stop@conductor_coding_bot"));

    expect(fixture.codex.interruptedTurns).toEqual([{ threadId: "thread-existing", turnId: "turn-1" }]);
    expect(fixture.telegram.sentMessages.at(-1)?.text).toBe("Interrupt requested.");
    expect(fixture.registry.getSessionById("session-1")?.status).toBe("cancelling");
  });

  it("treats interrupted turns as idle instead of errors", async () => {
    const workspace = createWorkspace({
      activeSessionId: "session-1",
    });
    const session = createSession();
    const fixture = createFixture({
      workspaces: [workspace],
      sessions: [session],
    });
    fixture.stateStore.updateChatContext(chatId, {
      activeWorkspaceId: "workspace-1",
      activeSessionId: "session-1",
      followSessionId: "session-1",
    });

    await handleUpdate(fixture, messageUpdate("First prompt"));
    await handleNotification(fixture, {
      method: "turn/completed",
      params: {
        threadId: "thread-existing",
        turn: {
          id: "turn-1",
          status: "interrupted",
        },
      },
    });

    expect(fixture.registry.getSessionById("session-1")?.status).toBe("idle");
    expect(fixture.mirror.statusUpdates.at(-1)).toEqual({ sessionId: "session-1", status: "idle" });
  });

  it("blocks free-form text while a plan approval is pending and approves the plan on callback", async () => {
    const workspace = createWorkspace({
      activeSessionId: "session-1",
    });
    const session = createSession();
    const fixture = createFixture({
      workspaces: [workspace],
      sessions: [session],
    });
    fixture.stateStore.updateChatContext(chatId, {
      activeWorkspaceId: "workspace-1",
      activeSessionId: "session-1",
      followSessionId: "session-1",
    });

    await handleNotification(fixture, {
      method: "turn/plan/updated",
      params: {
        threadId: "thread-existing",
        turnId: "turn-plan",
        explanation: "Break the task down first.",
        plan: [
          { step: "Inspect the code", status: "completed" },
          { step: "Add tests", status: "pending" },
        ],
      },
    });
    await handleUpdate(fixture, messageUpdate("go ahead"));
    await handleUpdate(fixture, callbackUpdate("plan:approve"));

    expect(fixture.telegram.sentMessages[0]?.text).toContain("Plan approval required:");
    expect(fixture.telegram.sentMessages[0]?.text).toContain("Break the task down first.");
    expect(fixture.telegram.sentMessages[1]?.text).toContain("Tap Approve Plan or Revise Plan");
    expect(fixture.codex.steeredTurns[0]).toEqual({
      threadId: "thread-existing",
      expectedTurnId: "turn-plan",
      input: "Plan approved. Please proceed to implementation.",
    });
    expect(fixture.registry.getSessionById("session-1")?.status).toBe("working");
    expect(fixture.telegram.sentMessages[2]?.text).toBe("Plan approved. Moving to implementation.");
  });

  it("collects revise-plan feedback as the next message and steers the active turn", async () => {
    const workspace = createWorkspace({
      activeSessionId: "session-1",
    });
    const session = createSession();
    const fixture = createFixture({
      workspaces: [workspace],
      sessions: [session],
    });
    fixture.stateStore.updateChatContext(chatId, {
      activeWorkspaceId: "workspace-1",
      activeSessionId: "session-1",
      followSessionId: "session-1",
    });

    await handleNotification(fixture, {
      method: "turn/plan/updated",
      params: {
        threadId: "thread-existing",
        turnId: "turn-plan",
        plan: [{ step: "Add tests", status: "pending" }],
      },
    });
    await handleUpdate(fixture, callbackUpdate("plan:revise"));
    await handleUpdate(fixture, messageUpdate("Add user-flow tests before changing the implementation."));

    expect(fixture.stateStore.getChatContext(chatId).composeMode).toBe("none");
    expect(fixture.codex.steeredTurns[0]).toEqual({
      threadId: "thread-existing",
      expectedTurnId: "turn-plan",
      input: "Add user-flow tests before changing the implementation.",
    });
    expect(fixture.telegram.sentMessages[1]?.text).toBe(
      "Entered Revise Plan mode. Your next message will be sent as plan feedback.",
    );
    expect(fixture.telegram.sentMessages[2]?.text).toBe("Submitted plan feedback.");
  });

  it("collects reply-required input and forwards it to the waiting turn", async () => {
    const workspace = createWorkspace({
      activeSessionId: "session-1",
    });
    const session = createSession({
      status: "needs_user_input",
    });
    const fixture = createFixture({
      workspaces: [workspace],
      sessions: [session],
    });
    fixture.stateStore.updateChatContext(chatId, {
      activeWorkspaceId: "workspace-1",
      activeSessionId: "session-1",
      followSessionId: "session-1",
    });

    await handleNotification(fixture, {
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-existing",
        turnId: "turn-reply",
        question: "Please provide reproduction steps.",
      },
    });
    await handleUpdate(fixture, callbackUpdate("reply:now"));
    await handleUpdate(fixture, messageUpdate("Open the home page, tap refresh, and it fails twice in a row."));

    expect(fixture.telegram.sentMessages[0]?.text).toBe("Input required:\nPlease provide reproduction steps.");
    expect(fixture.telegram.sentMessages[1]?.text).toBe(
      "Entered Reply mode. Your next message will be sent as a direct reply.",
    );
    expect(fixture.telegram.sentMessages[2]?.text).toBe("Submitted input.");
    expect(fixture.codex.steeredTurns[0]).toEqual({
      threadId: "thread-existing",
      expectedTurnId: "turn-reply",
      input: "Open the home page, tap refresh, and it fails twice in a row.",
    });
    expect(fixture.registry.getSessionById("session-1")?.status).toBe("working");
  });

  it("streams assistant output to Telegram and starts the next queued prompt after completion", async () => {
    const workspace = createWorkspace({
      activeSessionId: "session-1",
    });
    const session = createSession();
    const fixture = createFixture({
      workspaces: [workspace],
      sessions: [session],
    });
    fixture.stateStore.updateChatContext(chatId, {
      activeWorkspaceId: "workspace-1",
      activeSessionId: "session-1",
      followSessionId: "session-1",
    });

    await handleNotification(fixture, {
      method: "turn/started",
      params: {
        threadId: "thread-existing",
        turn: { id: "turn-live" },
      },
    });
    await handleNotification(fixture, {
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-existing",
        turnId: "turn-live",
        delta: "Hello",
      },
    });

    const runtimeBySession = (
      fixture.service as unknown as {
        runtimeBySession: Map<
          string,
          {
            streamByChat: Map<number, { lastAt: number }>;
          }
        >;
      }
    ).runtimeBySession;
    const runtime = runtimeBySession.get("session-1");
    const streamState = runtime?.streamByChat.get(chatId);
    if (streamState) {
      streamState.lastAt = 0;
    }

    fixture.stateStore.enqueuePrompt("session-1", "thread-existing", "normal", "Queued follow-up");

    await handleNotification(fixture, {
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-existing",
        turnId: "turn-live",
        delta: " world",
      },
    });
    await handleNotification(fixture, {
      method: "turn/completed",
      params: {
        threadId: "thread-existing",
        turn: { id: "turn-live", status: "completed" },
      },
    });

    expect(fixture.telegram.sentMessages[0]?.text).toBe("Hello");
    expect(fixture.telegram.editedMessages[0]).toMatchObject({
      chatId,
      text: "Hello world",
    });
    expect(fixture.mirror.assistantMessages[0]).toMatchObject({
      sessionId: "session-1",
      turnId: "turn-live",
      text: "Hello world",
    });
    expect(fixture.codex.startedTurns[0]).toMatchObject({
      threadId: "thread-existing",
      input: "Queued follow-up",
      turnId: "turn-1",
    });
    expect(fixture.stateStore.listQueueForSession("session-1", 5)[0]?.status).toBe("started");
  });
});
