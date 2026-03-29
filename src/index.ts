import process from "node:process";

import { ConductorMirrorWriter } from "./adapters/conductor-mirror.js";
import { CodexAppServerAdapter } from "./adapters/codex-app-server.js";
import { ConductorRegistryAdapter } from "./adapters/conductor-registry.js";
import { BridgeStateStore } from "./bridge/state-store.js";
import { config } from "./config.js";
import { isTransientTelegramNetworkError, summarizeTelegramNetworkError, TelegramClient } from "./telegram/client.js";
import {
  branchesKeyboard,
  homeKeyboard,
  inboxKeyboard,
  planKeyboard,
  repositoriesKeyboard,
  replyKeyboard,
  sessionsKeyboard,
} from "./telegram/ui.js";
import type {
  CodexNotification,
  ConductorSessionRef,
  TelegramBotCommand,
  TelegramCallbackQuery,
  TelegramInlineKeyboard,
  TelegramMessage,
  TelegramUpdate,
  WorkspaceRef,
} from "./types.js";
import { logger } from "./utils/logger.js";
import {
  extractHumanText,
  formatBranchName,
  formatBranchPickerText,
  formatPlan,
  formatRepositoryLabel,
  formatSessionContextEntry,
  formatSessionPickerText,
  formatSessionTitle,
  formatStatusLine,
  formatWorkspaceOptionName,
  sanitizeSessionTitle,
  truncate,
} from "./utils/text.js";

interface PendingInputQuestion {
  id: string;
  header: string;
  question: string;
  options: Array<{ label: string; description: string }> | null;
}

interface PendingInputRequest {
  itemId: string;
  questions: PendingInputQuestion[];
  requestId: number | string;
  threadId: string;
  turnId: string;
}

interface ContextViewerState {
  chatId: number;
  entryCount: number;
  limit: number;
  messageId: number | null;
  pageIndex: number;
  pages: string[];
  sessionId: string;
  sessionTitle: string;
}

interface SessionPanelState {
  keyboardFingerprint: string;
  lastText: string;
  messageId: number | null;
  sessionId: string | null;
}

interface RuntimeState {
  assistantText: string;
  model: string | null;
  planText: string | null;
  sessionId: string;
  status: "active" | "waiting_user_input" | "waiting_plan" | "completed" | "failed";
  threadId: string;
  turnId: string;
}

interface CodexServerRequest {
  id: number | string;
  method: string;
  params: Record<string, unknown>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function normalizeCommand(input: string): string {
  const command = input.trim().split(/\s+/, 1)[0] ?? input.trim();
  return command.split("@", 1)[0] ?? command;
}

function selectedRepositoryLabel(workspace: Pick<WorkspaceRef, "repositoryName"> | null | undefined): string {
  return workspace ? formatRepositoryLabel(workspace) : "Not selected";
}

function selectedBranchLabel(workspace: Pick<WorkspaceRef, "branch" | "directoryName"> | null | undefined): string {
  return workspace ? formatBranchName(workspace) : "Not selected";
}

function selectedChatLabel(session: Pick<ConductorSessionRef, "title"> | null | undefined): string {
  return session ? formatSessionTitle(session.title) : "Not selected";
}

const BOT_COMMANDS: TelegramBotCommand[] = [
  { command: "start", description: "Open the home screen" },
  { command: "home", description: "Show the current repo, branch, and chat" },
  { command: "repos", description: "Choose a repo" },
  { command: "branches", description: "Choose a branch" },
  { command: "chats", description: "Choose a chat" },
  { command: "workspaces", description: "Choose a repo" },
  { command: "sessions", description: "Choose a chat" },
  { command: "status", description: "Refresh the current status panel" },
  { command: "queue", description: "Show the current chat queue" },
  { command: "context", description: "Open the recent context viewer" },
  { command: "new", description: "Create a new chat with the next message" },
  { command: "help", description: "Show help" },
];

function buildHelpText(): string {
  return [
    "Available commands:",
    "/home  Return to the home screen",
    "/repos  Choose a repo",
    "/branches  Choose a branch",
    "/chats  Choose a chat",
    "/workspaces  Choose a repo",
    "/sessions  Choose a chat",
    "/status  Open or refresh the current status panel",
    "/queue  Show the current chat queue",
    "/context [N]  Open the paginated recent context viewer",
    "/new  Make the next message create a new chat on the current branch",
    "/help  Show help",
    "",
    "You can also tap Help on the home screen.",
    "Plain text continues the currently selected chat.",
  ].join("\n");
}

class TelegramConductorBridge {
  private readonly codex = new CodexAppServerAdapter(config.codexBin);
  private readonly mirror: ConductorMirrorWriter;
  private readonly registry = new ConductorRegistryAdapter(config.conductorDbPath, {
    workspacesRoot: config.workspacesRoot,
    defaultFallbackModel: config.defaultFallbackModel,
    defaultPermissionMode: config.defaultPermissionMode,
  });
  private readonly stateStore = new BridgeStateStore(config.bridgeDbPath);
  private readonly telegram = new TelegramClient(config.telegramToken);
  private readonly runtimes = new Map<string, RuntimeState>();
  private readonly pendingInputRequests = new Map<string, PendingInputRequest>();
  private readonly sessionIdByThreadId = new Map<string, string>();
  private readonly contextViewers = new Map<number, ContextViewerState>();
  private readonly sessionPanels = new Map<number, SessionPanelState>();
  private queueTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor() {
    this.mirror = new ConductorMirrorWriter(this.registry, this.stateStore);
  }

  async start(): Promise<void> {
    this.stateStore.init();
    await this.codex.start();
    await this.syncTelegramCommands();

    this.codex.on("notification", (notification: CodexNotification) => {
      void this.handleCodexNotification(notification).catch((error) => {
        logger.error("failed to handle codex notification", error);
      });
    });
    this.codex.on("server-request", (request: CodexServerRequest) => {
      void this.handleCodexServerRequest(request).catch((error) => {
        logger.error("failed to handle codex server request", error);
      });
    });

    this.queueTimer = setInterval(() => {
      void this.drainQueues().catch((error) => {
        logger.error("failed to drain queue", error);
      });
    }, config.queueTickMs);

    process.on("SIGINT", () => {
      void this.stop();
    });
    process.on("SIGTERM", () => {
      void this.stop();
    });

    logger.info("telegram conductor bridge started");
    await this.pollLoop();
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    if (this.queueTimer) {
      clearInterval(this.queueTimer);
      this.queueTimer = null;
    }
    await this.codex.stop();
  }

  private async pollLoop(): Promise<void> {
    let offset = this.stateStore.getTelegramCursor() + 1;
    while (!this.stopped) {
      let updates: TelegramUpdate[];
      try {
        updates = await this.telegram.getUpdates(offset, config.pollTimeoutSeconds);
      } catch (error) {
        if (isTransientTelegramNetworkError(error)) {
          logger.warn("telegram polling interrupted; retrying", summarizeTelegramNetworkError(error));
        } else {
          logger.error("telegram polling failed", error);
        }
        await sleep(2000);
        continue;
      }

      for (const update of updates) {
        try {
          await this.handleUpdate(update);
        } catch (error) {
          logger.error("failed to handle telegram update", {
            updateId: update.update_id,
            error,
          });
          const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id ?? null;
          if (chatId) {
            await this.safeSendMessage(chatId, "Failed to process that message. Please try again.").catch(
              () => undefined,
            );
          }
        } finally {
          this.stateStore.setTelegramCursor(update.update_id);
          offset = update.update_id + 1;
        }
      }
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.message) {
      await this.handleMessage(update.message);
      return;
    }

    if (update.callback_query) {
      await this.handleCallback(update.callback_query);
    }
  }

  private isAuthorized(chatId: number): boolean {
    return !config.allowedChatIds || config.allowedChatIds.has(chatId);
  }

  private async handleMessage(message: TelegramMessage): Promise<void> {
    if (!this.isAuthorized(message.chat.id)) {
      await this.safeSendMessage(message.chat.id, "Unauthorized.");
      return;
    }
    if (message.chat.type !== "private") {
      await this.safeSendMessage(message.chat.id, "Only Telegram private chats are supported.");
      return;
    }
    if (!message.text) {
      return;
    }

    const text = message.text.trim();
    if (!text) {
      return;
    }

    if (text.startsWith("/")) {
      await this.handleCommand(message.chat.id, text);
      return;
    }

    await this.handlePlainText(message.chat.id, text);
  }

  private async handleCallback(callback: TelegramCallbackQuery): Promise<void> {
    const chatId = callback.message?.chat.id;
    if (!chatId) {
      return;
    }
    if (!this.isAuthorized(chatId)) {
      await this.telegram.answerCallbackQuery(callback.id, "Unauthorized");
      return;
    }

    const data = callback.data ?? "";

    if (data.startsWith("context:")) {
      await this.handleContextViewerCallback(callback, chatId, data);
      return;
    }

    if (data.startsWith("panel:")) {
      await this.handleSessionPanelCallback(callback, chatId, data);
      return;
    }

    if (data === "home:help") {
      await this.telegram.answerCallbackQuery(callback.id);
      await this.safeSendMessage(chatId, buildHelpText());
      return;
    }

    if (data === "home:workspaces" || data === "home:repos") {
      await this.telegram.answerCallbackQuery(callback.id);
      await this.showRepositories(chatId);
      return;
    }

    if (data === "home:branches") {
      await this.telegram.answerCallbackQuery(callback.id);
      await this.showBranches(chatId);
      return;
    }

    if (data === "home:sessions" || data === "home:chats") {
      await this.telegram.answerCallbackQuery(callback.id);
      await this.showChats(chatId);
      return;
    }

    if (data === "home:inbox") {
      await this.telegram.answerCallbackQuery(callback.id);
      await this.showInbox(chatId);
      return;
    }

    if (data === "home:continue") {
      await this.telegram.answerCallbackQuery(callback.id);
      const session = this.resolveSelectedSession(chatId);
      if (!session) {
        const context = this.stateStore.getChatContext(chatId);
        if (context.activeWorkspaceId) {
          await this.showChats(chatId, "Select a chat first.");
        } else {
          await this.showRepositories(chatId, "Select a repo and branch before selecting a chat.");
        }
        return;
      }
      await this.showHome(chatId, `Continuing: ${formatSessionTitle(session.title)}`);
      return;
    }

    if (data === "home:new") {
      await this.telegram.answerCallbackQuery(callback.id);
      const context = this.stateStore.getChatContext(chatId);
      if (!context.activeWorkspaceId) {
        await this.showRepositories(chatId, "Select a repo and branch before creating a new chat.");
        return;
      }
      this.stateStore.setComposeMode(chatId, "new_session", {
        composeWorkspaceId: context.activeWorkspaceId,
      });
      await this.safeSendMessage(chatId, "Your next message will create a new chat on the current branch.");
      return;
    }

    if (data === "back:home") {
      await this.telegram.answerCallbackQuery(callback.id);
      await this.showHome(chatId);
      return;
    }

    if (data === "plan:approve") {
      await this.telegram.answerCallbackQuery(callback.id);
      await this.approvePlan(chatId);
      return;
    }

    if (data === "plan:revise") {
      await this.telegram.answerCallbackQuery(callback.id);
      await this.preparePlanRevision(chatId);
      return;
    }

    if (data === "reply:now") {
      await this.telegram.answerCallbackQuery(callback.id);
      await this.prepareReply(chatId);
      return;
    }

    if (data.startsWith("repo:")) {
      await this.telegram.answerCallbackQuery(callback.id);
      await this.selectRepository(chatId, data.slice("repo:".length));
      return;
    }

    if (data.startsWith("branch:")) {
      await this.telegram.answerCallbackQuery(callback.id);
      await this.selectBranch(chatId, data.slice("branch:".length));
      return;
    }

    if (data.startsWith("workspace:")) {
      await this.telegram.answerCallbackQuery(callback.id);
      const id = data.slice("workspace:".length);
      if (this.registry.getWorkspaceById(id)) {
        await this.selectBranch(chatId, id);
        return;
      }
      await this.selectRepository(chatId, id);
      return;
    }

    if (data.startsWith("session:")) {
      await this.telegram.answerCallbackQuery(callback.id);
      const id = data.slice("session:".length);
      if (this.registry.getSessionById(id)) {
        await this.selectChat(chatId, id);
        return;
      }
      if (this.registry.getWorkspaceById(id)) {
        await this.selectBranch(chatId, id);
        return;
      }
      await this.safeSendMessage(chatId, "Chat not found.");
      return;
    }

    await this.telegram.answerCallbackQuery(callback.id, "Not implemented yet");
  }

  private async handleCommand(chatId: number, rawCommand: string): Promise<void> {
    const command = normalizeCommand(rawCommand);
    switch (command) {
      case "/start":
      case "/home":
        await this.showHome(chatId);
        return;
      case "/repos":
      case "/workspaces":
        await this.showRepositories(chatId);
        return;
      case "/branches":
        await this.showBranches(chatId);
        return;
      case "/chats":
      case "/sessions":
        await this.showChats(chatId);
        return;
      case "/status":
        await this.showStatus(chatId);
        return;
      case "/queue":
        await this.showQueue(chatId);
        return;
      case "/context":
        await this.showContext(chatId, rawCommand);
        return;
      case "/new": {
        const context = this.stateStore.getChatContext(chatId);
        if (!context.activeWorkspaceId) {
          await this.showRepositories(chatId, "Select a repo and branch before creating a new chat.");
          return;
        }
        this.stateStore.setComposeMode(chatId, "new_session", {
          composeWorkspaceId: context.activeWorkspaceId,
        });
        await this.safeSendMessage(chatId, "Your next message will create a new chat on the current branch.");
        return;
      }
      case "/help":
        await this.safeSendMessage(chatId, buildHelpText());
        return;
      default:
        await this.safeSendMessage(chatId, `Unknown command: ${command}`);
    }
  }

  private async handlePlainText(chatId: number, text: string): Promise<void> {
    const context = this.stateStore.getChatContext(chatId);
    const session = this.resolveSelectedSession(chatId);

    if (session) {
      const pendingRequest = this.pendingInputRequests.get(session.id);
      if (pendingRequest) {
        await this.answerInputRequest(chatId, session, pendingRequest, text);
        return;
      }
    }

    if (context.composeMode === "new_session") {
      await this.createNewSession(chatId, text);
      return;
    }

    if (context.composeMode === "plan_feedback") {
      await this.sendSteerFromContext(chatId, text, "Plan feedback sent.");
      return;
    }

    if (context.composeMode === "reply_required") {
      if (session) {
        const pendingRequest = this.pendingInputRequests.get(session.id);
        if (pendingRequest) {
          await this.answerInputRequest(chatId, session, pendingRequest, text);
          return;
        }
      }
      this.stateStore.clearComposeMode(chatId);
      await this.safeSendMessage(chatId, "There is no pending question right now.");
      return;
    }

    if (!session) {
      if (context.activeWorkspaceId) {
        await this.showHome(
          chatId,
          "There is no chat to continue on the current branch. Tap New Chat Here to create one.",
        );
        return;
      }
      await this.showRepositories(chatId, "Select a repo, branch, and chat first.");
      return;
    }

    await this.submitPrompt(chatId, session, text, false);
  }

  private resolveSelectedSession(chatId: number): ConductorSessionRef | null {
    const context = this.stateStore.getChatContext(chatId);
    if (context.activeSessionId) {
      return this.registry.getSessionById(context.activeSessionId);
    }

    if (!context.activeWorkspaceId) {
      return null;
    }

    const workspace = this.registry.getWorkspaceById(context.activeWorkspaceId);
    if (!workspace?.activeSessionId) {
      return null;
    }

    this.stateStore.setActiveSession(chatId, workspace.activeSessionId);
    return this.registry.getSessionById(workspace.activeSessionId);
  }

  private async selectRepository(chatId: number, repositoryId: string): Promise<void> {
    const workspaces = this.registry.listWorkspacesForRepository(repositoryId, config.pageSize);
    if (workspaces.length === 0) {
      await this.safeSendMessage(chatId, "Repo not found.");
      return;
    }

    await this.showBranches(chatId, `Switched to repo: ${formatRepositoryLabel(workspaces[0])}`, repositoryId);
  }

  private async selectBranch(chatId: number, workspaceId: string): Promise<void> {
    const workspace = this.registry.getWorkspaceById(workspaceId);
    if (!workspace) {
      await this.safeSendMessage(chatId, "Workspace not found.");
      return;
    }

    this.stateStore.setActiveWorkspace(chatId, workspace.id);
    if (workspace.activeSessionId) {
      this.stateStore.setActiveSession(chatId, workspace.activeSessionId);
      const session = this.registry.getSessionById(workspace.activeSessionId);
      if (session?.claudeSessionId) {
        this.sessionIdByThreadId.set(session.claudeSessionId, session.id);
      }
    } else {
      this.stateStore.updateChatContext(chatId, { activeSessionId: null });
    }
    this.stateStore.clearComposeMode(chatId);

    const workspaceName = formatWorkspaceOptionName(workspace);
    const branchName = formatBranchName(workspace);
    const prefix =
      workspaceName === branchName
        ? `Switched to branch: ${branchName}`
        : `Switched to branch: ${branchName}\nWorkspace: ${workspaceName}`;

    await this.showChats(chatId, prefix, workspace.id);
  }

  private async selectChat(chatId: number, sessionId: string): Promise<void> {
    const session = this.registry.getSessionById(sessionId);
    if (!session) {
      await this.safeSendMessage(chatId, "Chat not found.");
      return;
    }

    this.stateStore.setActiveWorkspace(chatId, session.workspaceId);
    this.stateStore.setActiveSession(chatId, session.id);
    this.stateStore.clearComposeMode(chatId);
    this.registry.updateWorkspaceActiveSession(session.workspaceId, session.id);
    if (session.claudeSessionId) {
      this.sessionIdByThreadId.set(session.claudeSessionId, session.id);
    }

    await this.showHome(chatId, `Switched to chat: ${formatSessionTitle(session.title)}`);
  }

  private async showHome(chatId: number, prefix?: string): Promise<void> {
    const context = this.stateStore.getChatContext(chatId);
    const workspace = context.activeWorkspaceId ? this.registry.getWorkspaceById(context.activeWorkspaceId) : null;
    const session = this.resolveSelectedSession(chatId);
    const runtime = session ? (this.runtimes.get(session.id) ?? null) : null;

    const lines: string[] = [];
    if (prefix) {
      lines.push(prefix);
      lines.push("");
    }
    lines.push("Conductor Telegram Bridge");
    lines.push(`Repo: ${selectedRepositoryLabel(workspace)}`);
    lines.push(`Branch: ${selectedBranchLabel(workspace)}`);
    lines.push(`Current Chat: ${selectedChatLabel(session)}`);
    lines.push(`Status: ${this.sessionStatusLabel(session, runtime)}`);
    lines.push(`Mode: ${context.composeMode}`);
    await this.safeSendMessage(chatId, lines.join("\n"), homeKeyboard());
  }

  private async showRepositories(chatId: number, prefix?: string): Promise<void> {
    const repositories = this.registry.listRepositories(config.pageSize);
    if (repositories.length === 0) {
      await this.safeSendMessage(chatId, "No repos are available.");
      return;
    }
    const text = [prefix, "Select a repo:"].filter(Boolean).join("\n\n");
    await this.safeSendMessage(chatId, text, repositoriesKeyboard(repositories));
  }

  private async showBranches(chatId: number, prefix?: string, repositoryId?: string): Promise<void> {
    const context = this.stateStore.getChatContext(chatId);
    const currentWorkspace = context.activeWorkspaceId
      ? this.registry.getWorkspaceById(context.activeWorkspaceId)
      : null;
    const targetRepositoryId = repositoryId ?? currentWorkspace?.repositoryId ?? null;
    if (!targetRepositoryId) {
      await this.showRepositories(chatId, prefix ?? "Select a repo first.");
      return;
    }

    const workspaces = this.registry.listWorkspacesForRepository(targetRepositoryId, config.pageSize);
    if (workspaces.length === 0) {
      await this.safeSendMessage(
        chatId,
        `${prefix ? `${prefix}\n\n` : ""}There are no workspaces in the current repo.`,
      );
      return;
    }

    const activeWorkspaceId =
      currentWorkspace && currentWorkspace.repositoryId === targetRepositoryId ? currentWorkspace.id : null;
    const text = formatBranchPickerText(workspaces, {
      activeWorkspaceId,
      heading: "Select a branch:",
      prefix,
    });
    await this.safeSendMessage(chatId, text, branchesKeyboard(workspaces));
  }

  private async showChats(chatId: number, prefix?: string, workspaceId?: string): Promise<void> {
    const context = this.stateStore.getChatContext(chatId);
    const targetWorkspaceId = workspaceId ?? context.activeWorkspaceId ?? null;
    if (!targetWorkspaceId) {
      await this.showRepositories(chatId, prefix ?? "Select a repo and branch first.");
      return;
    }

    const workspace = this.registry.getWorkspaceById(targetWorkspaceId);
    if (!workspace) {
      await this.showRepositories(chatId, prefix ?? "Branch not found.");
      return;
    }

    const sessions = this.registry.listSessions(targetWorkspaceId, config.pageSize);
    if (sessions.length === 0) {
      await this.safeSendMessage(
        chatId,
        `${prefix ? `${prefix}\n\n` : ""}There are no chats on the current branch. Tap New Chat Here to create a new Conductor chat.`,
        homeKeyboard(),
      );
      return;
    }

    const text = formatSessionPickerText(sessions, {
      activeSessionId: context.activeSessionId ?? workspace.activeSessionId,
      heading: "Select a chat:",
      prefix,
    });
    await this.safeSendMessage(chatId, text, sessionsKeyboard(sessions));
  }

  private async showInbox(chatId: number): Promise<void> {
    const sessions = this.registry.getInboxSessions(config.pageSize);
    if (sessions.length === 0) {
      await this.safeSendMessage(chatId, "Inbox is empty.");
      return;
    }
    await this.safeSendMessage(chatId, "Chats that need your attention:", inboxKeyboard(sessions));
  }

  private async showStatus(chatId: number): Promise<void> {
    await this.renderSessionPanel(chatId);
  }

  private async showQueue(chatId: number): Promise<void> {
    const session = this.resolveSelectedSession(chatId);
    if (!session) {
      await this.safeSendMessage(chatId, "Select a chat first.");
      return;
    }
    const items = this.stateStore.listQueueForSession(session.id, 10);
    if (items.length === 0) {
      await this.safeSendMessage(chatId, "The current chat has no queue.");
      return;
    }

    const lines = ["Current queue:"];
    for (const item of items.reverse()) {
      lines.push(`${item.status} · ${item.text.slice(0, 80)}`);
    }
    await this.safeSendMessage(chatId, lines.join("\n"));
  }

  private async showContext(chatId: number, rawCommand: string): Promise<void> {
    const session = this.resolveSelectedSession(chatId);
    if (!session) {
      await this.safeSendMessage(chatId, "Select a chat first.");
      return;
    }

    const limit = this.parseContextLimit(rawCommand);
    if (limit === null) {
      await this.safeSendMessage(chatId, "Usage: /context or /context 12");
      return;
    }

    const rawLimit = Math.min(limit * 8, 160);
    const entries = this.registry
      .listSessionMessages(session.id, rawLimit)
      .map((message) => formatSessionContextEntry(message, "full"))
      .filter((message): message is string => Boolean(message))
      .slice(0, limit)
      .reverse();

    if (entries.length === 0) {
      await this.safeSendMessage(chatId, "There is no visible context for the current chat yet.");
      return;
    }

    const existing = this.contextViewers.get(chatId);
    const viewer: ContextViewerState = {
      chatId,
      entryCount: entries.length,
      limit,
      messageId: existing?.messageId ?? null,
      pageIndex: 0,
      pages: this.splitTextForTelegram(entries.join("\n\n"), 3200),
      sessionId: session.id,
      sessionTitle: formatSessionTitle(session.title),
    };
    viewer.pageIndex = Math.max(0, viewer.pages.length - 1);
    this.contextViewers.set(chatId, viewer);
    await this.renderContextViewer(viewer);
  }

  private shouldQueueSession(session: ConductorSessionRef): boolean {
    if (this.pendingInputRequests.has(session.id)) {
      return true;
    }

    const runtime = this.runtimes.get(session.id);
    if (runtime && runtime.status !== "completed" && runtime.status !== "failed") {
      return true;
    }

    return (
      session.status === "working" ||
      session.status === "needs_user_input" ||
      session.status === "needs_plan_response" ||
      session.status === "cancelling"
    );
  }

  private async submitPrompt(
    chatId: number,
    session: ConductorSessionRef,
    text: string,
    fromQueue: boolean,
  ): Promise<boolean> {
    if (session.agentType && session.agentType !== "codex") {
      await this.safeSendMessage(chatId, "Only Codex sessions are supported right now.");
      return false;
    }
    if (!session.claudeSessionId) {
      await this.safeSendMessage(chatId, "This chat is missing its underlying thread ID and cannot continue.");
      return false;
    }

    if (!fromQueue && this.shouldQueueSession(session)) {
      this.stateStore.enqueuePrompt(session.id, session.claudeSessionId, "normal", text);
      await this.safeSendMessage(chatId, "The current chat is busy. Your message was added to the queue.");
      return true;
    }

    const workspacePath = this.registry.resolveWorkspacePath(session.workspaceId);
    let turnId: string;
    try {
      await this.codex.resumeThread({
        threadId: session.claudeSessionId,
        cwd: workspacePath,
        model: session.model,
      });
      ({ turnId } = await this.codex.startTurn({
        threadId: session.claudeSessionId,
        cwd: workspacePath,
        model: session.model,
        input: text,
      }));
    } catch (error) {
      const errorMessage = extractErrorMessage(error);
      logger.error("failed to submit prompt", {
        chatId,
        sessionId: session.id,
        threadId: session.claudeSessionId,
        fromQueue,
        error,
      });

      if (errorMessage.includes("no rollout found for thread id")) {
        const context = this.stateStore.getChatContext(chatId);
        if (context.activeSessionId === session.id) {
          this.stateStore.setActiveSession(chatId, null);
        }
        await this.showChats(
          chatId,
          "The underlying thread for this chat is no longer valid. Switch to another chat or tap New Chat Here to create a new one.",
        );
        return false;
      }

      await this.safeSendMessage(chatId, "Send failed. Please try again later.");
      return false;
    }

    this.sessionIdByThreadId.set(session.claudeSessionId, session.id);
    this.runtimes.set(session.id, {
      sessionId: session.id,
      threadId: session.claudeSessionId,
      turnId,
      status: "active",
      assistantText: "",
      planText: null,
      model: session.model,
    });

    this.mirror.updateSessionStatus(session.id, "working");
    this.mirror.appendUserMessage({
      sessionId: session.id,
      turnId,
      text,
      sentAt: new Date().toISOString(),
    });

    if (!fromQueue) {
      await this.safeSendMessage(chatId, "Sent.");
    }
    return true;
  }

  private async createNewSession(chatId: number, text: string): Promise<void> {
    const context = this.stateStore.getChatContext(chatId);
    const workspaceId = context.composeWorkspaceId ?? context.activeWorkspaceId;
    if (!workspaceId) {
      await this.showRepositories(chatId, "Select a repo and branch first.");
      return;
    }

    const defaults = this.registry.getSessionDefaults(workspaceId);
    const workspacePath = this.registry.resolveWorkspacePath(workspaceId);
    const title = sanitizeSessionTitle(text);

    let threadId: string | null = null;
    try {
      threadId = await this.codex.startThread({
        cwd: workspacePath,
        model: defaults.model,
      });

      const session = this.registry.createSession(workspaceId, threadId, {
        model: defaults.model,
        permissionMode: defaults.permissionMode,
        title,
      });

      this.stateStore.setActiveWorkspace(chatId, workspaceId);
      this.stateStore.setActiveSession(chatId, session.id);
      this.stateStore.clearComposeMode(chatId);
      this.sessionIdByThreadId.set(threadId, session.id);

      await this.safeSendMessage(chatId, `Created chat: ${title}`);
      await this.submitPrompt(chatId, session, text, false);
    } catch (error) {
      if (threadId) {
        await this.codex.archiveThread(threadId).catch(() => undefined);
      }
      logger.error("failed to create new session", error);
      await this.safeSendMessage(chatId, "Failed to create a new chat.");
    }
  }

  private async sendSteerFromContext(chatId: number, text: string, successText: string): Promise<void> {
    const context = this.stateStore.getChatContext(chatId);
    if (!context.composeTargetSessionId || !context.composeTargetThreadId || !context.composeTargetTurnId) {
      this.stateStore.clearComposeMode(chatId);
      await this.safeSendMessage(chatId, "There is no active turn to revise.");
      return;
    }

    await this.codex.steerTurn({
      threadId: context.composeTargetThreadId,
      expectedTurnId: context.composeTargetTurnId,
      input: text,
    });
    this.stateStore.clearComposeMode(chatId);
    const runtime = this.runtimes.get(context.composeTargetSessionId);
    if (runtime) {
      runtime.status = "active";
    }
    this.mirror.updateSessionStatus(context.composeTargetSessionId, "working");
    await this.safeSendMessage(chatId, successText);
  }

  private async preparePlanRevision(chatId: number): Promise<void> {
    const session = this.resolveSelectedSession(chatId);
    const runtime = session ? this.runtimes.get(session.id) : null;
    if (!session || !runtime) {
      await this.safeSendMessage(chatId, "There is no plan to revise right now.");
      return;
    }

    this.stateStore.setComposeMode(chatId, "plan_feedback", {
      composeTargetSessionId: session.id,
      composeTargetThreadId: runtime.threadId,
      composeTargetTurnId: runtime.turnId,
    });
    await this.safeSendMessage(chatId, "Send your next message as plan feedback.");
  }

  private async approvePlan(chatId: number): Promise<void> {
    const session = this.resolveSelectedSession(chatId);
    if (!session) {
      await this.safeSendMessage(chatId, "Select a chat first.");
      return;
    }

    const pendingRequest = this.pendingInputRequests.get(session.id);
    if (pendingRequest) {
      const approvalText =
        pendingRequest.questions[0]?.options?.[0]?.label ?? "The plan looks good. Please continue to implementation.";
      await this.answerInputRequest(chatId, session, pendingRequest, approvalText);
      return;
    }

    const runtime = this.runtimes.get(session.id);
    if (!runtime) {
      await this.safeSendMessage(chatId, "There is no active plan right now.");
      return;
    }

    await this.codex.steerTurn({
      threadId: runtime.threadId,
      expectedTurnId: runtime.turnId,
      input: "The plan looks good. Please continue to implementation.",
    });
    runtime.status = "active";
    this.mirror.updateSessionStatus(session.id, "working");
    await this.safeSendMessage(chatId, "Approval sent.");
  }

  private async prepareReply(chatId: number): Promise<void> {
    const session = this.resolveSelectedSession(chatId);
    const runtime = session ? this.runtimes.get(session.id) : null;
    const pendingRequest = session ? this.pendingInputRequests.get(session.id) : null;
    if (!session || !runtime || !pendingRequest) {
      await this.safeSendMessage(chatId, "There is no pending question right now.");
      return;
    }

    this.stateStore.setComposeMode(chatId, "reply_required", {
      composeTargetSessionId: session.id,
      composeTargetThreadId: runtime.threadId,
      composeTargetTurnId: runtime.turnId,
    });
    await this.safeSendMessage(chatId, "Send your next message as the reply.");
  }

  private buildInputAnswers(questions: PendingInputQuestion[], text: string): Record<string, { answers: string[] }> {
    if (questions.length === 0) {
      return {};
    }

    if (questions.length === 1) {
      return {
        [questions[0]!.id]: {
          answers: [text],
        },
      };
    }

    const parsed = new Map<string, string>();
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const separator = trimmed.includes(":") ? ":" : trimmed.includes("=") ? "=" : null;
      if (!separator) {
        continue;
      }
      const index = trimmed.indexOf(separator);
      if (index <= 0) {
        continue;
      }
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim();
      if (key && value) {
        parsed.set(key, value);
      }
    }

    const answers: Record<string, { answers: string[] }> = {};
    for (const question of questions) {
      const value = parsed.get(question.id) ?? parsed.get(question.header);
      if (value) {
        answers[question.id] = { answers: [value] };
      }
    }

    if (Object.keys(answers).length === 0) {
      answers[questions[0]!.id] = { answers: [text] };
    }

    return answers;
  }

  private async answerInputRequest(
    chatId: number,
    session: ConductorSessionRef,
    request: PendingInputRequest,
    text: string,
  ): Promise<void> {
    const answers = this.buildInputAnswers(request.questions, text);
    await this.codex.respond(request.requestId, { answers });
    this.pendingInputRequests.delete(session.id);
    this.stateStore.clearComposeMode(chatId);
    const runtime = this.runtimes.get(session.id);
    if (runtime) {
      runtime.status = "active";
    }
    this.mirror.updateSessionStatus(session.id, "working");
    await this.safeSendMessage(chatId, "Reply sent.");
  }

  private async handleCodexServerRequest(request: CodexServerRequest): Promise<void> {
    if (request.method !== "item/tool/requestUserInput") {
      logger.info("ignoring unsupported server request", { method: request.method });
      return;
    }

    const threadId = asString(request.params.threadId);
    const turnId = asString(request.params.turnId);
    const itemId = asString(request.params.itemId);
    const rawQuestions = Array.isArray(request.params.questions) ? request.params.questions : [];
    if (!threadId || !turnId || !itemId) {
      return;
    }

    const sessionId = this.resolveSessionIdByThreadId(threadId);
    if (!sessionId) {
      return;
    }

    const questions = rawQuestions
      .map((question) => {
        const value = asRecord(question);
        if (!value) {
          return null;
        }
        const id = asString(value.id);
        const header = asString(value.header) ?? id;
        const questionText = asString(value.question) ?? "";
        if (!id) {
          return null;
        }

        const options = Array.isArray(value.options)
          ? value.options
              .map((option) => {
                const record = asRecord(option);
                if (!record) {
                  return null;
                }
                const label = asString(record.label);
                const description = asString(record.description) ?? "";
                if (!label) {
                  return null;
                }
                return { label, description };
              })
              .filter((option): option is { label: string; description: string } => option !== null)
          : null;

        return {
          id,
          header,
          question: questionText,
          options,
        };
      })
      .filter((question): question is PendingInputQuestion => question !== null);

    this.pendingInputRequests.set(sessionId, {
      requestId: request.id,
      threadId,
      turnId,
      itemId,
      questions,
    });

    const session = this.registry.getSessionById(sessionId);
    const runtime = this.ensureRuntime(sessionId, threadId, turnId, session?.model ?? null);
    runtime.status = "waiting_user_input";
    this.mirror.updateSessionStatus(sessionId, "needs_user_input");

    const lines = ["Reply required:"];
    for (const question of questions) {
      lines.push(`- ${question.header}: ${question.question}`);
      if (question.options?.length) {
        lines.push(`  Options: ${question.options.map((option) => option.label).join(" / ")}`);
      }
    }
    await this.pushRuntimeUpdate(runtime, lines.join("\n"), replyKeyboard());
  }

  private async handleCodexNotification(notification: CodexNotification): Promise<void> {
    if (notification.method.startsWith("codex/event/")) {
      return;
    }

    switch (notification.method) {
      case "turn/started":
        await this.onTurnStarted(notification.params);
        return;
      case "item/agentMessage/delta":
        await this.onAgentMessageDelta(notification.params);
        return;
      case "item/completed":
        await this.onItemCompleted(notification.params);
        return;
      case "turn/plan/updated":
        await this.onPlanUpdated(notification.params);
        return;
      case "serverRequest/resolved":
        await this.onServerRequestResolved(notification.params);
        return;
      case "turn/completed":
        await this.onTurnCompleted(notification.params);
        return;
      case "thread/status/changed":
        await this.onThreadStatusChanged(notification.params);
        return;
      default:
        return;
    }
  }

  private async onTurnStarted(params: Record<string, unknown>): Promise<void> {
    const threadId = asString(params.threadId);
    const turn = asRecord(params.turn);
    const turnId = turn ? asString(turn.id) : null;
    if (!threadId || !turnId) {
      return;
    }

    const sessionId = this.resolveSessionIdByThreadId(threadId);
    if (!sessionId) {
      return;
    }

    const session = this.registry.getSessionById(sessionId);
    const runtime = this.ensureRuntime(sessionId, threadId, turnId, session?.model ?? null);
    runtime.status = "active";
    this.mirror.updateSessionStatus(sessionId, "working");
    await this.pushRuntimeUpdate(runtime);
  }

  private async onAgentMessageDelta(params: Record<string, unknown>): Promise<void> {
    const threadId = asString(params.threadId);
    const turnId = asString(params.turnId);
    const delta = asString(params.delta) ?? "";
    if (!threadId || !turnId || !delta) {
      return;
    }

    const sessionId = this.resolveSessionIdByThreadId(threadId);
    if (!sessionId) {
      return;
    }

    const session = this.registry.getSessionById(sessionId);
    const runtime = this.ensureRuntime(sessionId, threadId, turnId, session?.model ?? null);
    runtime.assistantText += delta;
    runtime.status = "active";
    await this.pushRuntimeUpdate(runtime);
  }

  private async onItemCompleted(params: Record<string, unknown>): Promise<void> {
    const threadId = asString(params.threadId);
    const turnId = asString(params.turnId);
    const item = asRecord(params.item);
    if (!threadId || !turnId || !item) {
      return;
    }

    const sessionId = this.resolveSessionIdByThreadId(threadId);
    if (!sessionId) {
      return;
    }

    const session = this.registry.getSessionById(sessionId);
    const runtime = this.ensureRuntime(sessionId, threadId, turnId, session?.model ?? null);
    const itemType = asString(item.type);

    if (itemType === "agentMessage") {
      const text = asString(item.text) ?? "";
      if (!text) {
        return;
      }
      runtime.assistantText = text;
      this.mirror.appendAssistantMessage({
        sessionId,
        threadId,
        turnId,
        text,
        sentAt: new Date().toISOString(),
        model: session?.model ?? null,
      });
      await this.pushRuntimeUpdate(runtime);
      return;
    }

    if (itemType === "plan") {
      const text = asString(item.text);
      if (text) {
        runtime.planText = text;
        await this.pushRuntimeUpdate(runtime, text, planKeyboard());
      }
    }
  }

  private async onPlanUpdated(params: Record<string, unknown>): Promise<void> {
    const threadId = asString(params.threadId);
    const turnId = asString(params.turnId);
    if (!threadId || !turnId) {
      return;
    }

    const plan = Array.isArray(params.plan)
      ? params.plan
          .map((item) => {
            const value = asRecord(item);
            if (!value) {
              return null;
            }
            const step = asString(value.step);
            const status = asString(value.status);
            if (!step || !status) {
              return null;
            }
            return { step, status };
          })
          .filter((item): item is { step: string; status: string } => item !== null)
      : [];
    const explanation = asString(params.explanation);

    const sessionId = this.resolveSessionIdByThreadId(threadId);
    if (!sessionId) {
      return;
    }

    const session = this.registry.getSessionById(sessionId);
    const runtime = this.ensureRuntime(sessionId, threadId, turnId, session?.model ?? null);
    runtime.status = "waiting_plan";
    runtime.planText = formatPlan(plan, explanation);
    this.mirror.updateSessionStatus(sessionId, "needs_plan_response");
    await this.pushRuntimeUpdate(runtime, runtime.planText, planKeyboard());
  }

  private async onServerRequestResolved(params: Record<string, unknown>): Promise<void> {
    const requestId = params.requestId;
    for (const [sessionId, pending] of this.pendingInputRequests) {
      if (pending.requestId !== requestId) {
        continue;
      }
      this.pendingInputRequests.delete(sessionId);
      const runtime = this.runtimes.get(sessionId);
      if (runtime) {
        runtime.status = "active";
      }
      this.mirror.updateSessionStatus(sessionId, "working");
      break;
    }
  }

  private async onTurnCompleted(params: Record<string, unknown>): Promise<void> {
    const threadId = asString(params.threadId);
    const turn = asRecord(params.turn);
    const turnId = turn ? asString(turn.id) : null;
    const turnStatus = turn ? asString(turn.status) : null;
    const error = turn ? asRecord(turn.error) : null;
    if (!threadId || !turnId || !turnStatus) {
      return;
    }

    const sessionId = this.resolveSessionIdByThreadId(threadId);
    if (!sessionId) {
      return;
    }

    const session = this.registry.getSessionById(sessionId);
    const runtime = this.ensureRuntime(sessionId, threadId, turnId, session?.model ?? null);

    if (turnStatus === "failed") {
      runtime.status = "failed";
      if (!runtime.assistantText) {
        runtime.assistantText = extractHumanText(error) || "Execution failed.";
      }
      this.mirror.updateSessionStatus(sessionId, "error");
      await this.pushRuntimeUpdate(runtime);
    } else {
      runtime.status = "completed";
      this.mirror.updateSessionStatus(sessionId, "idle");
      await this.pushRuntimeUpdate(runtime);
    }

    this.pendingInputRequests.delete(sessionId);
    this.runtimes.delete(sessionId);
    await this.drainQueueForSession(sessionId);
  }

  private async onThreadStatusChanged(params: Record<string, unknown>): Promise<void> {
    const threadId = asString(params.threadId);
    const status = asRecord(params.status);
    if (!threadId || !status) {
      return;
    }

    const sessionId = this.resolveSessionIdByThreadId(threadId);
    if (!sessionId) {
      return;
    }

    if (asString(status.type) !== "systemError") {
      return;
    }

    this.mirror.updateSessionStatus(sessionId, "error");
    const runtime = this.runtimes.get(sessionId);
    if (runtime) {
      runtime.status = "failed";
      runtime.assistantText = "The underlying thread entered systemError.";
      await this.pushRuntimeUpdate(runtime);
    }
  }

  private ensureRuntime(sessionId: string, threadId: string, turnId: string, model: string | null): RuntimeState {
    const existing = this.runtimes.get(sessionId);
    if (existing && existing.turnId === turnId) {
      return existing;
    }

    const runtime: RuntimeState = {
      sessionId,
      threadId,
      turnId,
      status: "active",
      assistantText: existing?.assistantText ?? "",
      planText: existing?.planText ?? null,
      model,
    };
    this.runtimes.set(sessionId, runtime);
    return runtime;
  }

  private resolveSessionIdByThreadId(threadId: string): string | null {
    const cached = this.sessionIdByThreadId.get(threadId);
    if (cached) {
      return cached;
    }

    const session = this.registry.findSessionByThreadId(threadId);
    if (!session) {
      return null;
    }
    this.sessionIdByThreadId.set(threadId, session.id);
    return session.id;
  }

  private sessionStatusLabel(session: ConductorSessionRef | null, runtime: RuntimeState | null): string {
    if (!runtime) {
      return session?.status ?? "idle";
    }
    switch (runtime.status) {
      case "waiting_plan":
        return "needs_plan_response";
      case "waiting_user_input":
        return "needs_user_input";
      case "failed":
        return "error";
      case "completed":
        return "idle";
      default:
        return "working";
    }
  }

  private async pushRuntimeUpdate(
    runtime: RuntimeState,
    bodyOverride?: string,
    keyboard?: ReturnType<typeof planKeyboard>,
  ): Promise<void> {
    const session = this.registry.getSessionById(runtime.sessionId);
    if (!session) {
      return;
    }
    const workspace = this.registry.getWorkspaceById(session.workspaceId);
    const body =
      bodyOverride ??
      runtime.planText ??
      runtime.assistantText ??
      (runtime.status === "waiting_user_input"
        ? "Waiting for your reply."
        : runtime.status === "waiting_plan"
          ? "Waiting for your plan approval."
          : "Working...");

    const markup =
      keyboard ??
      (runtime.status === "waiting_plan"
        ? planKeyboard()
        : runtime.status === "waiting_user_input"
          ? replyKeyboard()
          : undefined);
    const _workspace = workspace;
    const chatIds = this.stateStore.listFollowingChats(runtime.sessionId);
    for (const chatId of chatIds) {
      await this.renderSessionPanel(chatId, {
        bodyOverride: body,
        runtime,
        session,
        workspace: _workspace,
        ...(markup ? { keyboard: markup } : {}),
      });
    }
  }

  private async drainQueues(): Promise<void> {
    for (const sessionId of this.stateStore.listQueuedSessionIds()) {
      await this.drainQueueForSession(sessionId);
    }
  }

  private async drainQueueForSession(sessionId: string): Promise<void> {
    const session = this.registry.getSessionById(sessionId);
    if (!session || this.shouldQueueSession(session)) {
      return;
    }

    const next = this.stateStore.getNextQueuedPrompt(sessionId);
    if (!next) {
      return;
    }

    const chatId = this.stateStore.listFollowingChats(sessionId)[0];
    if (chatId === undefined) {
      return;
    }

    this.stateStore.markPromptStarted(next.id);
    try {
      await this.submitPrompt(chatId, session, next.text, true);
      this.stateStore.markPromptFinished(next.id, "finished");
    } catch (error) {
      logger.error("queued prompt failed", error);
      this.stateStore.markPromptFinished(next.id, "failed");
    }
  }

  private async safeSendMessage(chatId: number, text: string, keyboard?: TelegramInlineKeyboard): Promise<void> {
    await this.telegram.sendMessage(
      chatId,
      truncate(text, 3800),
      keyboard ? { reply_markup: { inline_keyboard: keyboard } } : undefined,
    );
  }

  private async syncTelegramCommands(): Promise<void> {
    try {
      await this.telegram.setMyCommands(BOT_COMMANDS);
    } catch (error) {
      logger.warn("failed to sync telegram bot commands", error);
    }
  }

  private parseContextLimit(rawCommand: string): number | null {
    const parts = rawCommand.trim().split(/\s+/).slice(1);
    if (parts.length === 0) {
      return 8;
    }
    if (parts.length !== 1) {
      return null;
    }

    const limit = Number.parseInt(parts[0] ?? "", 10);
    if (!Number.isInteger(limit) || limit <= 0) {
      return null;
    }

    return Math.min(limit, 20);
  }

  private splitTextForTelegram(text: string, maxLength = 3800): string[] {
    const trimmed = text.trim();
    if (!trimmed) {
      return [];
    }
    if (trimmed.length <= maxLength) {
      return [trimmed];
    }

    const chunks: string[] = [];
    let remaining = trimmed;
    while (remaining.length > maxLength) {
      const splitAt = Math.max(remaining.lastIndexOf("\n\n", maxLength), remaining.lastIndexOf("\n", maxLength));
      const boundary = splitAt >= Math.floor(maxLength / 2) ? splitAt : maxLength;
      chunks.push(remaining.slice(0, boundary).trimEnd());
      remaining = remaining.slice(boundary).trimStart();
    }

    if (remaining) {
      chunks.push(remaining);
    }

    return chunks;
  }

  private async handleSessionPanelCallback(
    callback: TelegramCallbackQuery,
    chatId: number,
    data: string,
  ): Promise<void> {
    const panel = this.sessionPanels.get(chatId);
    const messageId = callback.message?.message_id;
    if (!messageId || !panel || panel.messageId !== messageId) {
      await this.telegram.answerCallbackQuery(callback.id, "That status panel is no longer active.");
      return;
    }

    switch (data) {
      case "panel:refresh":
        await this.renderSessionPanel(chatId);
        await this.telegram.answerCallbackQuery(callback.id, "Refreshed.");
        return;
      case "panel:close":
        await this.closeSessionPanel(chatId);
        await this.telegram.answerCallbackQuery(callback.id);
        return;
      default:
        await this.telegram.answerCallbackQuery(callback.id, "Not implemented yet");
    }
  }

  private async renderSessionPanel(
    chatId: number,
    options?: {
      bodyOverride?: string;
      keyboard?: TelegramInlineKeyboard;
      runtime?: RuntimeState | null;
      session?: ConductorSessionRef | null;
      workspace?: WorkspaceRef | null;
    },
  ): Promise<void> {
    const context = this.stateStore.getChatContext(chatId);
    const workspace =
      options?.workspace ??
      (context.activeWorkspaceId ? this.registry.getWorkspaceById(context.activeWorkspaceId) : null);
    const session = options?.session ?? this.resolveSelectedSession(chatId);
    const runtime = options?.runtime ?? (session ? (this.runtimes.get(session.id) ?? null) : null);
    const queueCount = session
      ? this.stateStore.listQueueForSession(session.id, 50).filter((item) => item.status === "queued").length
      : 0;
    const body = await this.resolveSessionPanelBody(session, runtime, options?.bodyOverride);
    const lines = [
      formatStatusLine(
        workspace ? formatRepositoryLabel(workspace) : selectedRepositoryLabel(workspace),
        session
          ? `${selectedBranchLabel(workspace)} / ${formatSessionTitle(session.title)}`
          : selectedChatLabel(session),
        this.sessionStatusLabel(session, runtime),
      ),
      `Queued: ${queueCount}`,
      `Mode: ${context.composeMode}`,
    ];
    if (runtime?.turnId) {
      lines.push(`Turn: ${runtime.turnId}`);
    }
    const text = truncate(`${lines.join("\n")}\n\n${body}`, 3800);
    const keyboard = this.sessionPanelKeyboard(options?.keyboard);
    await this.upsertSessionPanel(chatId, session?.id ?? null, text, keyboard);
  }

  private async resolveSessionPanelBody(
    session: ConductorSessionRef | null,
    runtime: RuntimeState | null,
    bodyOverride?: string,
  ): Promise<string> {
    if (bodyOverride) {
      return bodyOverride;
    }

    if (runtime) {
      return (
        runtime.planText ??
        runtime.assistantText ??
        (runtime.status === "waiting_user_input"
          ? "Waiting for your reply."
          : runtime.status === "waiting_plan"
            ? "Waiting for plan approval."
            : "Processing...")
      );
    }

    if (!session) {
      return "Select a chat first.";
    }

    const preview = this.registry
      .listSessionMessages(session.id, 12)
      .map((message) => formatSessionContextEntry(message))
      .find((message): message is string => Boolean(message));

    return preview ?? "Waiting for new messages.";
  }

  private sessionPanelKeyboard(extraKeyboard?: TelegramInlineKeyboard): TelegramInlineKeyboard {
    const keyboard = extraKeyboard ? extraKeyboard.map((row) => [...row]) : [];
    keyboard.push([
      { text: "Refresh Status", callback_data: "panel:refresh" },
      { text: "Hide Panel", callback_data: "panel:close" },
    ]);
    return keyboard;
  }

  private async upsertSessionPanel(
    chatId: number,
    sessionId: string | null,
    text: string,
    keyboard: TelegramInlineKeyboard,
  ): Promise<void> {
    const keyboardFingerprint = JSON.stringify(keyboard);
    const existing = this.sessionPanels.get(chatId);
    if (
      existing &&
      existing.messageId &&
      existing.sessionId === sessionId &&
      existing.lastText === text &&
      existing.keyboardFingerprint === keyboardFingerprint
    ) {
      return;
    }

    if (existing?.messageId) {
      try {
        await this.telegram.editMessageText(chatId, existing.messageId, text, keyboard);
        this.sessionPanels.set(chatId, {
          keyboardFingerprint,
          lastText: text,
          messageId: existing.messageId,
          sessionId,
        });
        return;
      } catch (error) {
        logger.warn("failed to edit session panel, sending new message", error);
      }
    }

    const messageId = await this.telegram.sendMessage(chatId, text, {
      reply_markup: { inline_keyboard: keyboard },
    });
    this.sessionPanels.set(chatId, {
      keyboardFingerprint,
      lastText: text,
      messageId,
      sessionId,
    });
  }

  private async closeSessionPanel(chatId: number): Promise<void> {
    const panel = this.sessionPanels.get(chatId);
    if (!panel) {
      return;
    }
    this.sessionPanels.delete(chatId);
    if (!panel.messageId) {
      return;
    }

    try {
      await this.telegram.deleteMessage(chatId, panel.messageId);
    } catch (error) {
      logger.warn("failed to delete session panel", error);
      try {
        await this.telegram.editMessageText(chatId, panel.messageId, "Status panel hidden.");
      } catch (editError) {
        logger.warn("failed to mark session panel as hidden", editError);
      }
    }
  }

  private async handleContextViewerCallback(
    callback: TelegramCallbackQuery,
    chatId: number,
    data: string,
  ): Promise<void> {
    const messageId = callback.message?.message_id;
    const viewer = this.contextViewers.get(chatId);

    if (!messageId || !viewer || viewer.messageId !== messageId) {
      await this.telegram.answerCallbackQuery(callback.id, "That context preview is no longer active.");
      return;
    }

    let notice: string | undefined;
    switch (data) {
      case "context:older":
        if (viewer.pageIndex > 0) {
          viewer.pageIndex -= 1;
        } else {
          notice = "Already at the oldest page.";
        }
        break;
      case "context:newer":
        if (viewer.pageIndex < viewer.pages.length - 1) {
          viewer.pageIndex += 1;
        } else {
          notice = "Already at the newest page.";
        }
        break;
      case "context:refresh":
        notice = await this.refreshContextViewer(viewer);
        break;
      case "context:close":
        await this.closeContextViewer(viewer);
        await this.telegram.answerCallbackQuery(callback.id);
        return;
      default:
        await this.telegram.answerCallbackQuery(callback.id, "Not implemented yet");
        return;
    }

    await this.renderContextViewer(viewer);
    await this.telegram.answerCallbackQuery(callback.id, notice);
  }

  private async refreshContextViewer(viewer: ContextViewerState): Promise<string | undefined> {
    const session = this.registry.getSessionById(viewer.sessionId);
    if (!session) {
      return "That chat no longer exists.";
    }

    const rawLimit = Math.min(viewer.limit * 8, 160);
    const entries = this.registry
      .listSessionMessages(session.id, rawLimit)
      .map((message) => formatSessionContextEntry(message, "full"))
      .filter((message): message is string => Boolean(message))
      .slice(0, viewer.limit)
      .reverse();

    if (entries.length === 0) {
      return "No context is available for that chat yet.";
    }

    viewer.entryCount = entries.length;
    viewer.pages = this.splitTextForTelegram(entries.join("\n\n"), 3200);
    viewer.pageIndex = Math.min(viewer.pageIndex, viewer.pages.length - 1);
    viewer.sessionTitle = formatSessionTitle(session.title);
    return "Refreshed.";
  }

  private async renderContextViewer(viewer: ContextViewerState): Promise<void> {
    const text = this.renderContextViewerText(viewer);
    const keyboard = this.contextViewerKeyboard(viewer);

    if (viewer.messageId) {
      try {
        await this.telegram.editMessageText(viewer.chatId, viewer.messageId, text, keyboard);
        return;
      } catch (error) {
        logger.warn("failed to edit context viewer, sending new message", error);
        viewer.messageId = null;
      }
    }

    const messageId = await this.telegram.sendMessage(viewer.chatId, text, {
      reply_markup: { inline_keyboard: keyboard },
    });
    viewer.messageId = messageId;
  }

  private renderContextViewerText(viewer: ContextViewerState): string {
    const body = viewer.pages[viewer.pageIndex] ?? "No context is available for that chat yet.";
    return truncate(
      [
        `Context: ${viewer.sessionTitle}`,
        `Showing latest ${viewer.entryCount} messages`,
        `Page ${viewer.pageIndex + 1}/${viewer.pages.length}`,
        "",
        body,
      ].join("\n"),
      3800,
    );
  }

  private contextViewerKeyboard(viewer: ContextViewerState): TelegramInlineKeyboard {
    const navigationRow = [];
    if (viewer.pageIndex > 0) {
      navigationRow.push({ text: "Older", callback_data: "context:older" });
    }
    if (viewer.pageIndex < viewer.pages.length - 1) {
      navigationRow.push({ text: "Newer", callback_data: "context:newer" });
    }

    const keyboard: TelegramInlineKeyboard = [];
    if (navigationRow.length > 0) {
      keyboard.push(navigationRow);
    }
    keyboard.push([
      { text: "Refresh", callback_data: "context:refresh" },
      { text: "Close", callback_data: "context:close" },
    ]);
    return keyboard;
  }

  private async closeContextViewer(viewer: ContextViewerState): Promise<void> {
    this.contextViewers.delete(viewer.chatId);
    if (!viewer.messageId) {
      return;
    }

    try {
      await this.telegram.deleteMessage(viewer.chatId, viewer.messageId);
    } catch (error) {
      logger.warn("failed to delete context viewer", error);
      try {
        await this.telegram.editMessageText(viewer.chatId, viewer.messageId, "Context preview closed.");
      } catch (editError) {
        logger.warn("failed to mark context viewer as closed", editError);
      }
    }
  }
}

const bridge = new TelegramConductorBridge();
void bridge.start().catch((error) => {
  logger.error("bridge crashed", error);
  process.exitCode = 1;
});
