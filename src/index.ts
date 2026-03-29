import process from "node:process";

import { ConductorMirrorWriter } from "./adapters/conductor-mirror.js";
import { CodexAppServerAdapter } from "./adapters/codex-app-server.js";
import { ConductorRegistryAdapter } from "./adapters/conductor-registry.js";
import { BridgeStateStore } from "./bridge/state-store.js";
import { config } from "./config.js";
import { TelegramClient } from "./telegram/client.js";
import {
  homeKeyboard,
  inboxKeyboard,
  planKeyboard,
  replyKeyboard,
  sessionsKeyboard,
  workspacesKeyboard,
} from "./telegram/ui.js";
import type {
  CodexNotification,
  ConductorSessionRef,
  TelegramCallbackQuery,
  TelegramMessage,
  TelegramUpdate,
} from "./types.js";
import { logger } from "./utils/logger.js";
import {
  extractHumanText,
  formatPlan,
  formatStatusLine,
  formatWorkspaceLabel,
  sanitizeSessionTitle,
  truncate,
} from "./utils/text.js";

interface LiveMessageState {
  lastText: string;
  messageId: number;
}

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

interface RuntimeState {
  assistantText: string;
  liveMessages: Map<number, LiveMessageState>;
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
  private queueTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor() {
    this.mirror = new ConductorMirrorWriter(this.registry, this.stateStore);
  }

  async start(): Promise<void> {
    this.stateStore.init();
    await this.codex.start();

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
        logger.error("telegram polling failed", error);
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
            await this.safeSendMessage(chatId, "处理这条消息时失败了，请重试一次。").catch(() => undefined);
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
      await this.safeSendMessage(message.chat.id, "未授权。");
      return;
    }
    if (message.chat.type !== "private") {
      await this.safeSendMessage(message.chat.id, "当前只支持 Telegram 私聊。");
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
      await this.telegram.answerCallbackQuery(callback.id, "未授权");
      return;
    }

    const data = callback.data ?? "";

    if (data === "home:workspaces") {
      await this.telegram.answerCallbackQuery(callback.id);
      await this.showWorkspaces(chatId);
      return;
    }

    if (data === "home:sessions") {
      await this.telegram.answerCallbackQuery(callback.id);
      await this.showSessions(chatId);
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
        await this.showSessions(chatId, "先选一个 session。");
        return;
      }
      await this.showHome(chatId, `当前继续目标：${session.title ?? session.id.slice(0, 8)}`);
      return;
    }

    if (data === "home:new") {
      await this.telegram.answerCallbackQuery(callback.id);
      const context = this.stateStore.getChatContext(chatId);
      if (!context.activeWorkspaceId) {
        await this.showWorkspaces(chatId, "先选一个 workspace，再创建新 session。");
        return;
      }
      this.stateStore.setComposeMode(chatId, "new_session", {
        composeWorkspaceId: context.activeWorkspaceId,
      });
      await this.safeSendMessage(chatId, "下一条文本会创建一个新的 Conductor session。");
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

    if (data.startsWith("workspace:")) {
      await this.telegram.answerCallbackQuery(callback.id);
      await this.selectWorkspace(chatId, data.slice("workspace:".length));
      return;
    }

    if (data.startsWith("session:")) {
      await this.telegram.answerCallbackQuery(callback.id);
      await this.selectSession(chatId, data.slice("session:".length));
      return;
    }

    await this.telegram.answerCallbackQuery(callback.id, "暂未实现");
  }

  private async handleCommand(chatId: number, rawCommand: string): Promise<void> {
    const command = normalizeCommand(rawCommand);
    switch (command) {
      case "/start":
      case "/home":
        await this.showHome(chatId);
        return;
      case "/workspaces":
        await this.showWorkspaces(chatId);
        return;
      case "/sessions":
        await this.showSessions(chatId);
        return;
      case "/status":
        await this.showStatus(chatId);
        return;
      case "/queue":
        await this.showQueue(chatId);
        return;
      case "/new": {
        const context = this.stateStore.getChatContext(chatId);
        if (!context.activeWorkspaceId) {
          await this.showWorkspaces(chatId, "先选一个 workspace，再创建新 session。");
          return;
        }
        this.stateStore.setComposeMode(chatId, "new_session", {
          composeWorkspaceId: context.activeWorkspaceId,
        });
        await this.safeSendMessage(chatId, "下一条文本会创建新的 Conductor session。");
        return;
      }
      case "/help":
        await this.safeSendMessage(
          chatId,
          [
            "可用命令：",
            "/home",
            "/workspaces",
            "/sessions",
            "/status",
            "/queue",
            "/new",
            "/help",
            "",
            "普通文本默认继续当前选中的 session。",
          ].join("\n"),
        );
        return;
      default:
        await this.safeSendMessage(chatId, `未知命令：${command}`);
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
      await this.sendSteerFromContext(chatId, text, "已发送计划修改意见。");
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
      await this.safeSendMessage(chatId, "当前没有待回答的问题。");
      return;
    }

    if (!session) {
      await this.showWorkspaces(chatId, "先选 workspace 和 session。");
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

  private async selectWorkspace(chatId: number, workspaceId: string): Promise<void> {
    const workspace = this.registry.getWorkspaceById(workspaceId);
    if (!workspace) {
      await this.safeSendMessage(chatId, "找不到这个 workspace。");
      return;
    }

    this.stateStore.setActiveWorkspace(chatId, workspace.id);
    if (workspace.activeSessionId) {
      this.stateStore.setActiveSession(chatId, workspace.activeSessionId);
    } else {
      this.stateStore.updateChatContext(chatId, { activeSessionId: null });
    }

    await this.showSessions(
      chatId,
      `已切换到 workspace：${formatWorkspaceLabel(workspace, { includeDirectory: true })}`,
    );
  }

  private async selectSession(chatId: number, sessionId: string): Promise<void> {
    const session = this.registry.getSessionById(sessionId);
    if (!session) {
      await this.safeSendMessage(chatId, "找不到这个 session。");
      return;
    }

    this.stateStore.setActiveWorkspace(chatId, session.workspaceId);
    this.stateStore.setActiveSession(chatId, session.id);
    this.stateStore.clearComposeMode(chatId);
    if (session.claudeSessionId) {
      this.sessionIdByThreadId.set(session.claudeSessionId, session.id);
    }

    await this.showHome(chatId, `已切换到 session：${session.title ?? session.id.slice(0, 8)}`);
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
    lines.push(`Workspace: ${workspace ? formatWorkspaceLabel(workspace, { includeDirectory: true }) : "未选择"}`);
    lines.push(`Session: ${session?.title ?? "未选择"}`);
    lines.push(`Status: ${this.sessionStatusLabel(session, runtime)}`);
    lines.push(`Mode: ${context.composeMode}`);
    await this.safeSendMessage(chatId, lines.join("\n"), homeKeyboard());
  }

  private async showWorkspaces(chatId: number, prefix?: string): Promise<void> {
    const workspaces = this.registry.listWorkspaces(config.pageSize);
    if (workspaces.length === 0) {
      await this.safeSendMessage(chatId, "没有可用的 workspace。");
      return;
    }
    const text = [prefix, "选择一个 workspace："].filter(Boolean).join("\n\n");
    await this.safeSendMessage(chatId, text, workspacesKeyboard(workspaces));
  }

  private async showSessions(chatId: number, prefix?: string): Promise<void> {
    const context = this.stateStore.getChatContext(chatId);
    if (!context.activeWorkspaceId) {
      await this.showWorkspaces(chatId, prefix ?? "先选一个 workspace。");
      return;
    }

    const sessions = this.registry.listSessions(context.activeWorkspaceId, config.pageSize);
    if (sessions.length === 0) {
      await this.safeSendMessage(chatId, `${prefix ? `${prefix}\n\n` : ""}当前 workspace 下没有 session。`);
      return;
    }

    const text = [prefix, "选择一个 session："].filter(Boolean).join("\n\n");
    await this.safeSendMessage(chatId, text, sessionsKeyboard(sessions));
  }

  private async showInbox(chatId: number): Promise<void> {
    const sessions = this.registry.getInboxSessions(config.pageSize);
    if (sessions.length === 0) {
      await this.safeSendMessage(chatId, "Inbox 为空。");
      return;
    }
    await this.safeSendMessage(chatId, "需要你处理的 session：", inboxKeyboard(sessions));
  }

  private async showStatus(chatId: number): Promise<void> {
    const context = this.stateStore.getChatContext(chatId);
    const workspace = context.activeWorkspaceId ? this.registry.getWorkspaceById(context.activeWorkspaceId) : null;
    const session = this.resolveSelectedSession(chatId);
    const runtime = session ? (this.runtimes.get(session.id) ?? null) : null;
    const queueCount = session
      ? this.stateStore.listQueueForSession(session.id, 50).filter((item) => item.status === "queued").length
      : 0;

    const lines = [
      `Workspace: ${workspace ? formatWorkspaceLabel(workspace, { includeDirectory: true }) : "未选择"}`,
      `Session: ${session?.title ?? "未选择"}`,
      `Status: ${this.sessionStatusLabel(session, runtime)}`,
      `Compose: ${context.composeMode}`,
      `Queued: ${queueCount}`,
    ];
    if (runtime?.turnId) {
      lines.push(`Turn: ${runtime.turnId}`);
    }
    await this.safeSendMessage(chatId, lines.join("\n"));
  }

  private async showQueue(chatId: number): Promise<void> {
    const session = this.resolveSelectedSession(chatId);
    if (!session) {
      await this.safeSendMessage(chatId, "先选一个 session。");
      return;
    }
    const items = this.stateStore.listQueueForSession(session.id, 10);
    if (items.length === 0) {
      await this.safeSendMessage(chatId, "当前 session 没有队列。");
      return;
    }

    const lines = ["当前队列："];
    for (const item of items.reverse()) {
      lines.push(`${item.status} · ${item.text.slice(0, 80)}`);
    }
    await this.safeSendMessage(chatId, lines.join("\n"));
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
      await this.safeSendMessage(chatId, "当前只支持 Codex session。");
      return false;
    }
    if (!session.claudeSessionId) {
      await this.safeSendMessage(chatId, "当前 session 没有底层 thread id，无法继续。");
      return false;
    }

    if (!fromQueue && this.shouldQueueSession(session)) {
      this.stateStore.enqueuePrompt(session.id, session.claudeSessionId, "normal", text);
      await this.safeSendMessage(chatId, "当前 session 正在忙，已加入队列。");
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
        await this.showSessions(
          chatId,
          "当前 session 的底层 thread 已失效，无法继续。请切换到别的 session，或点 New Chat Here 新建一个。",
        );
        return false;
      }

      await this.safeSendMessage(chatId, "发送失败了，请稍后重试。");
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
      liveMessages: new Map(),
    });

    this.mirror.updateSessionStatus(session.id, "working");
    this.mirror.appendUserMessage({
      sessionId: session.id,
      turnId,
      text,
      sentAt: new Date().toISOString(),
    });

    if (!fromQueue) {
      await this.safeSendMessage(chatId, "已发送。");
    }
    return true;
  }

  private async createNewSession(chatId: number, text: string): Promise<void> {
    const context = this.stateStore.getChatContext(chatId);
    const workspaceId = context.composeWorkspaceId ?? context.activeWorkspaceId;
    if (!workspaceId) {
      await this.showWorkspaces(chatId, "先选一个 workspace。");
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

      await this.safeSendMessage(chatId, `已创建新 session：${title}`);
      await this.submitPrompt(chatId, session, text, false);
    } catch (error) {
      if (threadId) {
        await this.codex.archiveThread(threadId).catch(() => undefined);
      }
      logger.error("failed to create new session", error);
      await this.safeSendMessage(chatId, "创建新 session 失败。");
    }
  }

  private async sendSteerFromContext(chatId: number, text: string, successText: string): Promise<void> {
    const context = this.stateStore.getChatContext(chatId);
    if (!context.composeTargetSessionId || !context.composeTargetThreadId || !context.composeTargetTurnId) {
      this.stateStore.clearComposeMode(chatId);
      await this.safeSendMessage(chatId, "当前没有活跃回合可修改。");
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
      await this.safeSendMessage(chatId, "当前没有需要修改的 plan。");
      return;
    }

    this.stateStore.setComposeMode(chatId, "plan_feedback", {
      composeTargetSessionId: session.id,
      composeTargetThreadId: runtime.threadId,
      composeTargetTurnId: runtime.turnId,
    });
    await this.safeSendMessage(chatId, "发下一条文本作为计划修改意见。");
  }

  private async approvePlan(chatId: number): Promise<void> {
    const session = this.resolveSelectedSession(chatId);
    if (!session) {
      await this.safeSendMessage(chatId, "先选一个 session。");
      return;
    }

    const pendingRequest = this.pendingInputRequests.get(session.id);
    if (pendingRequest) {
      const approvalText = pendingRequest.questions[0]?.options?.[0]?.label ?? "计划可以，继续实现。";
      await this.answerInputRequest(chatId, session, pendingRequest, approvalText);
      return;
    }

    const runtime = this.runtimes.get(session.id);
    if (!runtime) {
      await this.safeSendMessage(chatId, "当前没有活跃 plan。");
      return;
    }

    await this.codex.steerTurn({
      threadId: runtime.threadId,
      expectedTurnId: runtime.turnId,
      input: "计划可以，继续实现。",
    });
    runtime.status = "active";
    this.mirror.updateSessionStatus(session.id, "working");
    await this.safeSendMessage(chatId, "已发送批准。");
  }

  private async prepareReply(chatId: number): Promise<void> {
    const session = this.resolveSelectedSession(chatId);
    const runtime = session ? this.runtimes.get(session.id) : null;
    const pendingRequest = session ? this.pendingInputRequests.get(session.id) : null;
    if (!session || !runtime || !pendingRequest) {
      await this.safeSendMessage(chatId, "当前没有待回答的问题。");
      return;
    }

    this.stateStore.setComposeMode(chatId, "reply_required", {
      composeTargetSessionId: session.id,
      composeTargetThreadId: runtime.threadId,
      composeTargetTurnId: runtime.turnId,
    });
    await this.safeSendMessage(chatId, "发下一条文本作为回答。");
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
    await this.safeSendMessage(chatId, "已发送回答。");
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

    const lines = ["需要你回复："];
    for (const question of questions) {
      lines.push(`- ${question.header}: ${question.question}`);
      if (question.options?.length) {
        lines.push(`  选项: ${question.options.map((option) => option.label).join(" / ")}`);
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
        runtime.assistantText = extractHumanText(error) || "执行失败。";
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
      runtime.assistantText = "底层 thread 进入 systemError。";
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
      liveMessages: existing?.liveMessages ?? new Map(),
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
        ? "等待你的回复。"
        : runtime.status === "waiting_plan"
          ? "等待你确认计划。"
          : "处理中…");

    const text = truncate(
      `${formatStatusLine(
        workspace ? formatWorkspaceLabel(workspace, { includeDirectory: true }) : null,
        session.title ?? null,
        this.sessionStatusLabel(session, runtime),
      )}\n\n${body}`,
      3800,
    );
    const markup =
      keyboard ??
      (runtime.status === "waiting_plan"
        ? planKeyboard()
        : runtime.status === "waiting_user_input"
          ? replyKeyboard()
          : undefined);

    const chatIds = this.stateStore.listFollowingChats(runtime.sessionId);
    for (const chatId of chatIds) {
      const live = runtime.liveMessages.get(chatId);
      if (live && live.lastText === text) {
        continue;
      }

      if (live) {
        try {
          await this.telegram.editMessageText(chatId, live.messageId, text, markup);
          live.lastText = text;
          continue;
        } catch (error) {
          logger.warn("failed to edit telegram message, sending new", error);
        }
      }

      const messageId = await this.telegram.sendMessage(
        chatId,
        text,
        markup ? { reply_markup: { inline_keyboard: markup } } : undefined,
      );
      if (messageId) {
        runtime.liveMessages.set(chatId, {
          messageId,
          lastText: text,
        });
      }
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

  private async safeSendMessage(
    chatId: number,
    text: string,
    keyboard?: ReturnType<typeof homeKeyboard>,
  ): Promise<void> {
    await this.telegram.sendMessage(
      chatId,
      truncate(text, 3800),
      keyboard ? { reply_markup: { inline_keyboard: keyboard } } : undefined,
    );
  }
}

const bridge = new TelegramConductorBridge();
void bridge.start().catch((error) => {
  logger.error("bridge crashed", error);
  process.exitCode = 1;
});
