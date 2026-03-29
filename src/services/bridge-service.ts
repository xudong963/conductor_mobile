import { setTimeout as delay } from "node:timers/promises";

import { CodexAppServerAdapter } from "../adapters/codex-app-server.js";
import { ConductorMirrorWriter } from "../adapters/conductor-mirror.js";
import { ConductorRegistryAdapter } from "../adapters/conductor-registry.js";
import { BridgeStateStore } from "../bridge/state-store.js";
import { isTransientTelegramNetworkError, summarizeTelegramNetworkError, TelegramClient } from "../telegram/client.js";
import {
  homeKeyboard,
  inboxKeyboard,
  planKeyboard,
  replyKeyboard,
  sessionsKeyboard,
  workspacesKeyboard,
} from "../telegram/ui.js";
import type {
  ChatContext,
  CodexNotification,
  ConductorSessionRef,
  SessionStatus,
  TelegramCallbackQuery,
  TelegramInlineKeyboard,
  TelegramMessage,
  TelegramUpdate,
} from "../types.js";
import {
  extractHumanText,
  formatPlan,
  formatSessionPickerText,
  formatStatusLine,
  formatWorkspaceLabel,
  sanitizeSessionTitle,
  truncate,
} from "../utils/text.js";
import { logger } from "../utils/logger.js";

interface BridgeConfig {
  pollTimeoutSeconds: number;
  queueTickMs: number;
  pageSize: number;
  allowedChatIds: Set<number> | null;
}

interface RuntimeState {
  sessionId: string;
  workspaceId: string;
  threadId: string;
  model: string | null;
  activeTurnId: string | null;
  waitingUserInput: boolean;
  waitingPlan: boolean;
  planText: string | null;
  currentQueueItemId: number | null;
  turnBuffers: Map<string, string>;
  streamByChat: Map<number, { turnId: string; messageId: number; lastAt: number; lastText: string }>;
}

export class TelegramBridgeService {
  private running = true;
  private queueTickHandle: NodeJS.Timeout | null = null;
  private readonly queueLocks = new Set<string>();
  private readonly runtimeBySession = new Map<string, RuntimeState>();
  private readonly threadToSession = new Map<string, string>();

  constructor(
    private readonly telegram: TelegramClient,
    private readonly stateStore: BridgeStateStore,
    private readonly registry: ConductorRegistryAdapter,
    private readonly mirror: ConductorMirrorWriter,
    private readonly codex: CodexAppServerAdapter,
    private readonly config: BridgeConfig,
  ) {}

  async start(): Promise<void> {
    this.stateStore.init();
    await this.codex.start();
    this.codex.on("notification", (notification: CodexNotification) => {
      void this.handleCodexNotification(notification);
    });

    this.queueTickHandle = setInterval(() => {
      void this.processAllQueues();
    }, this.config.queueTickMs);

    await this.pollLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.queueTickHandle) {
      clearInterval(this.queueTickHandle);
      this.queueTickHandle = null;
    }
    await this.codex.stop();
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const offset = this.stateStore.getTelegramCursor() + 1;
        const updates = await this.telegram.getUpdates(offset, this.config.pollTimeoutSeconds);
        for (const update of updates) {
          await this.handleUpdate(update);
          this.stateStore.setTelegramCursor(update.update_id);
        }
      } catch (error) {
        if (isTransientTelegramNetworkError(error)) {
          logger.warn("telegram polling interrupted; retrying", summarizeTelegramNetworkError(error));
        } else {
          logger.error("poll loop failed", error);
        }
        await delay(1500);
      }
    }
  }

  private isAllowed(chatId: number): boolean {
    if (!this.config.allowedChatIds) {
      return true;
    }
    return this.config.allowedChatIds.has(chatId);
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.message?.text) {
      await this.handleIncomingMessage(update.message);
      return;
    }
    if (update.callback_query) {
      await this.handleCallback(update.callback_query);
    }
  }

  private async handleIncomingMessage(message: TelegramMessage): Promise<void> {
    const chatId = message.chat.id;
    if (!this.isAllowed(chatId)) {
      await this.telegram.sendMessage(chatId, "未授权账号，无法访问 Conductor。");
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
      await this.handleCommand(chatId, text);
      return;
    }

    await this.handlePlainText(chatId, text);
  }

  private async handleCallback(query: TelegramCallbackQuery): Promise<void> {
    const chatId = query.message?.chat.id ?? query.from.id;
    if (!this.isAllowed(chatId)) {
      await this.telegram.answerCallbackQuery(query.id, "未授权");
      return;
    }

    const data = query.data ?? "";
    try {
      if (data === "home:continue") {
        this.stateStore.clearComposeMode(chatId);
        await this.showHome(chatId);
      } else if (data === "home:new") {
        const ctx = this.stateStore.getChatContext(chatId);
        if (!ctx.activeWorkspaceId) {
          await this.showWorkspaces(chatId, "先选 workspace，再创建新会话。");
        } else {
          this.stateStore.setComposeMode(chatId, "new_session", { composeWorkspaceId: ctx.activeWorkspaceId });
          await this.telegram.sendMessage(
            chatId,
            "New Chat Here 已激活。下一条消息会在当前 workspace 创建新 session。",
          );
        }
      } else if (data === "home:sessions") {
        await this.showSessions(chatId);
      } else if (data === "home:workspaces") {
        await this.showWorkspaces(chatId, "选择 workspace");
      } else if (data === "home:inbox") {
        await this.showInbox(chatId);
      } else if (data === "back:home") {
        await this.showHome(chatId);
      } else if (data.startsWith("workspace:")) {
        const workspaceId = data.slice("workspace:".length);
        await this.selectWorkspace(chatId, workspaceId);
      } else if (data.startsWith("session:")) {
        const sessionId = data.slice("session:".length);
        await this.selectSession(chatId, sessionId);
      } else if (data === "plan:revise") {
        await this.enterPlanFeedbackMode(chatId);
      } else if (data === "plan:approve") {
        await this.approvePlan(chatId);
      } else if (data === "reply:now") {
        await this.enterReplyRequiredMode(chatId);
      }
      await this.telegram.answerCallbackQuery(query.id);
    } catch (error) {
      logger.error("callback handling failed", { data, error });
      await this.telegram.answerCallbackQuery(query.id, "操作失败");
    }
  }

  private async handleCommand(chatId: number, commandText: string): Promise<void> {
    const command = commandText.split(/\s+/, 1)[0] ?? "";
    switch (command) {
      case "/start":
      case "/home":
        await this.showHome(chatId);
        break;
      case "/workspaces":
        await this.showWorkspaces(chatId, "选择 workspace");
        break;
      case "/sessions":
        await this.showSessions(chatId);
        break;
      case "/new": {
        const ctx = this.stateStore.getChatContext(chatId);
        if (!ctx.activeWorkspaceId) {
          await this.showWorkspaces(chatId, "先选 workspace，再创建新会话。");
          return;
        }
        this.stateStore.setComposeMode(chatId, "new_session", { composeWorkspaceId: ctx.activeWorkspaceId });
        await this.telegram.sendMessage(chatId, "下一条消息会创建当前 workspace 下的新 session。");
        break;
      }
      case "/inbox":
        await this.showInbox(chatId);
        break;
      case "/queue":
        await this.showQueue(chatId);
        break;
      case "/cancel":
        this.stateStore.clearComposeMode(chatId);
        await this.telegram.sendMessage(chatId, "已退出一次性输入模式。");
        break;
      case "/help":
      default:
        await this.telegram.sendMessage(
          chatId,
          [
            "/home",
            "/workspaces",
            "/sessions",
            "/new",
            "/inbox",
            "/queue",
            "/cancel",
            "",
            "默认直接发文本即可继续当前 session。",
          ].join("\n"),
        );
        break;
    }
  }

  private async handlePlainText(chatId: number, text: string): Promise<void> {
    const ctx = this.stateStore.getChatContext(chatId);

    if (ctx.composeMode === "new_session") {
      const workspaceId = ctx.composeWorkspaceId ?? ctx.activeWorkspaceId;
      if (!workspaceId) {
        await this.showWorkspaces(chatId, "请先选择 workspace。");
        return;
      }
      await this.createNewSession(chatId, workspaceId, text);
      return;
    }

    if (ctx.composeMode === "plan_feedback") {
      await this.sendSteerInput(chatId, text, "plan_feedback");
      return;
    }

    if (ctx.composeMode === "reply_required") {
      await this.sendSteerInput(chatId, text, "reply_required");
      return;
    }

    const resolved = await this.ensureContextSession(chatId, ctx);
    if (!resolved.session) {
      await this.showWorkspaces(chatId, "还没有当前 session，先选 workspace。");
      return;
    }

    await this.routeTextToSession(chatId, resolved.session, text);
  }

  private async routeTextToSession(chatId: number, session: ConductorSessionRef, text: string): Promise<void> {
    const runtime = this.ensureRuntime(session);
    if (!session.claudeSessionId) {
      await this.telegram.sendMessage(chatId, "这个 session 缺少底层 thread id，无法继续。");
      return;
    }

    if (runtime.waitingPlan || session.status === "needs_plan_response") {
      await this.telegram.sendMessage(chatId, "当前回合在等你确认计划，请点 Approve Plan 或 Revise Plan。", {
        reply_markup: { inline_keyboard: planKeyboard() },
      });
      return;
    }

    if (runtime.waitingUserInput || session.status === "needs_user_input") {
      await this.telegram.sendMessage(chatId, "当前回合在等你补充输入，请点 Reply Now。", {
        reply_markup: { inline_keyboard: replyKeyboard() },
      });
      return;
    }

    if (runtime.activeTurnId || (session.status === "working" && runtime.activeTurnId === null)) {
      this.stateStore.enqueuePrompt(session.id, session.claudeSessionId, "normal", text);
      await this.telegram.sendMessage(chatId, "当前 session 正在工作，新消息已入队。");
      return;
    }

    await this.startPrompt(session, text, null);
  }

  private async createNewSession(chatId: number, workspaceId: string, openingPrompt: string): Promise<void> {
    const defaults = this.registry.getSessionDefaults(workspaceId);
    const title = sanitizeSessionTitle(openingPrompt);
    const workspacePath = this.registry.resolveWorkspacePath(workspaceId);

    const threadId = await this.codex.startThread({
      cwd: workspacePath,
      model: defaults.model,
    });

    let session: ConductorSessionRef;
    try {
      session = this.registry.createSession(workspaceId, threadId, {
        model: defaults.model,
        permissionMode: defaults.permissionMode,
        title,
      });
    } catch (error) {
      try {
        await this.codex.archiveThread(threadId);
      } catch (archiveError) {
        logger.warn("failed to archive thread after db failure", archiveError);
      }
      throw error;
    }

    this.stateStore.updateChatContext(chatId, {
      activeWorkspaceId: workspaceId,
      activeSessionId: session.id,
      followSessionId: session.id,
    });
    this.stateStore.clearComposeMode(chatId);

    this.ensureRuntime(session);
    await this.telegram.sendMessage(
      chatId,
      `已新建 session: ${session.title ?? session.id.slice(0, 8)}，开始执行首轮。`,
    );

    try {
      await this.startPrompt(session, openingPrompt, null);
    } catch (error) {
      this.mirror.updateSessionStatus(session.id, "error");
      await this.telegram.sendMessage(chatId, `首轮执行失败：${extractHumanText(error)}`);
    }
  }

  private async sendSteerInput(chatId: number, input: string, mode: "plan_feedback" | "reply_required"): Promise<void> {
    const ctx = this.stateStore.getChatContext(chatId);
    if (!ctx.composeTargetSessionId || !ctx.composeTargetThreadId || !ctx.composeTargetTurnId) {
      this.stateStore.clearComposeMode(chatId);
      await this.telegram.sendMessage(chatId, "没有可继续的目标回合，已退出输入模式。");
      return;
    }

    await this.codex.steerTurn({
      threadId: ctx.composeTargetThreadId,
      expectedTurnId: ctx.composeTargetTurnId,
      input,
    });
    this.stateStore.clearComposeMode(chatId);

    const runtime = this.runtimeBySession.get(ctx.composeTargetSessionId);
    if (runtime) {
      runtime.waitingPlan = false;
      runtime.waitingUserInput = false;
    }
    this.mirror.updateSessionStatus(ctx.composeTargetSessionId, "working");
    await this.telegram.sendMessage(chatId, mode === "plan_feedback" ? "已提交计划修改意见。" : "已提交输入。");
  }

  private async showHome(chatId: number): Promise<void> {
    let ctx = this.stateStore.getChatContext(chatId);
    const resolved = await this.ensureContextSession(chatId, ctx);
    ctx = resolved.context;

    const workspace = ctx.activeWorkspaceId ? this.registry.getWorkspaceById(ctx.activeWorkspaceId) : null;
    const session = resolved.session;
    const statusLine = formatStatusLine(
      workspace ? formatWorkspaceLabel(workspace, { includeDirectory: true }) : null,
      session?.title ?? null,
      session?.status ?? null,
    );

    const modeText = ctx.composeMode === "none" ? "" : `\nmode: ${ctx.composeMode} (下一条文本生效后自动退出)\n`;

    const text = [`Home`, statusLine, modeText, `发送文本可继续当前 session。`].join("\n");
    await this.telegram.sendMessage(chatId, text, {
      reply_markup: { inline_keyboard: homeKeyboard() },
    });
  }

  private async showWorkspaces(chatId: number, title: string): Promise<void> {
    const workspaces = this.registry.listWorkspaces(this.config.pageSize);
    if (workspaces.length === 0) {
      await this.telegram.sendMessage(chatId, "没有可用 workspace。");
      return;
    }
    await this.telegram.sendMessage(chatId, title, {
      reply_markup: { inline_keyboard: workspacesKeyboard(workspaces) },
    });
  }

  private async showSessions(chatId: number): Promise<void> {
    const ctx = this.stateStore.getChatContext(chatId);
    if (!ctx.activeWorkspaceId) {
      await this.showWorkspaces(chatId, "先选择 workspace");
      return;
    }
    const sessions = this.registry.listSessions(ctx.activeWorkspaceId, this.config.pageSize);
    if (sessions.length === 0) {
      await this.telegram.sendMessage(chatId, "当前 workspace 没有 session。");
      return;
    }
    await this.telegram.sendMessage(
      chatId,
      formatSessionPickerText(sessions, {
        activeSessionId: ctx.activeSessionId,
        heading: "选择 session",
      }),
      {
        reply_markup: { inline_keyboard: sessionsKeyboard(sessions) },
      },
    );
  }

  private async showInbox(chatId: number): Promise<void> {
    const sessions = this.registry.getInboxSessions(this.config.pageSize);
    if (sessions.length === 0) {
      await this.telegram.sendMessage(chatId, "Inbox 为空。");
      return;
    }
    await this.telegram.sendMessage(chatId, "Inbox", {
      reply_markup: { inline_keyboard: inboxKeyboard(sessions) },
    });
  }

  private async showQueue(chatId: number): Promise<void> {
    const ctx = this.stateStore.getChatContext(chatId);
    if (!ctx.activeSessionId) {
      await this.telegram.sendMessage(chatId, "当前没有 session。");
      return;
    }
    const items = this.stateStore.listQueueForSession(ctx.activeSessionId, 12);
    if (items.length === 0) {
      await this.telegram.sendMessage(chatId, "当前队列为空。");
      return;
    }
    const lines = items.map((item) => `#${item.id} [${item.status}] ${truncate(item.text, 90).replaceAll("\n", " ")}`);
    await this.telegram.sendMessage(chatId, lines.join("\n"));
  }

  private async selectWorkspace(chatId: number, workspaceId: string): Promise<void> {
    const workspace = this.registry.getWorkspaceById(workspaceId);
    if (!workspace) {
      await this.telegram.sendMessage(chatId, "workspace 不存在。");
      return;
    }
    const sessionId = workspace.activeSessionId;
    this.stateStore.updateChatContext(chatId, {
      activeWorkspaceId: workspace.id,
      activeSessionId: sessionId ?? null,
      followSessionId: sessionId ?? null,
    });
    this.stateStore.clearComposeMode(chatId);
    if (sessionId) {
      const session = this.registry.getSessionById(sessionId);
      if (session) {
        this.ensureRuntime(session);
      }
    }
    await this.showHome(chatId);
  }

  private async selectSession(chatId: number, sessionId: string): Promise<void> {
    const session = this.registry.getSessionById(sessionId);
    if (!session) {
      await this.telegram.sendMessage(chatId, "session 不存在。");
      return;
    }
    this.stateStore.updateChatContext(chatId, {
      activeWorkspaceId: session.workspaceId,
      activeSessionId: session.id,
      followSessionId: session.id,
    });
    this.stateStore.clearComposeMode(chatId);
    this.registry.updateWorkspaceActiveSession(session.workspaceId, session.id);
    this.ensureRuntime(session);
    await this.showHome(chatId);
  }

  private async enterPlanFeedbackMode(chatId: number): Promise<void> {
    const ctx = this.stateStore.getChatContext(chatId);
    const session = ctx.activeSessionId ? this.registry.getSessionById(ctx.activeSessionId) : null;
    if (!session || !session.claudeSessionId) {
      await this.telegram.sendMessage(chatId, "当前没有可操作 session。");
      return;
    }
    const runtime = this.ensureRuntime(session);
    if (!runtime.activeTurnId) {
      await this.telegram.sendMessage(chatId, "当前没有活跃 turn。");
      return;
    }
    this.stateStore.setComposeMode(chatId, "plan_feedback", {
      composeTargetSessionId: session.id,
      composeTargetThreadId: session.claudeSessionId,
      composeTargetTurnId: runtime.activeTurnId,
    });
    await this.telegram.sendMessage(chatId, "已进入 Revise Plan 模式。下一条文本将作为计划反馈。");
  }

  private async enterReplyRequiredMode(chatId: number): Promise<void> {
    const ctx = this.stateStore.getChatContext(chatId);
    const session = ctx.activeSessionId ? this.registry.getSessionById(ctx.activeSessionId) : null;
    if (!session || !session.claudeSessionId) {
      await this.telegram.sendMessage(chatId, "当前没有可操作 session。");
      return;
    }
    const runtime = this.ensureRuntime(session);
    if (!runtime.activeTurnId) {
      await this.telegram.sendMessage(chatId, "当前没有活跃 turn。");
      return;
    }
    this.stateStore.setComposeMode(chatId, "reply_required", {
      composeTargetSessionId: session.id,
      composeTargetThreadId: session.claudeSessionId,
      composeTargetTurnId: runtime.activeTurnId,
    });
    await this.telegram.sendMessage(chatId, "已进入 Reply 模式。下一条文本会直接回复当前请求。");
  }

  private async approvePlan(chatId: number): Promise<void> {
    const ctx = this.stateStore.getChatContext(chatId);
    const session = ctx.activeSessionId ? this.registry.getSessionById(ctx.activeSessionId) : null;
    if (!session || !session.claudeSessionId) {
      await this.telegram.sendMessage(chatId, "当前没有可操作 session。");
      return;
    }
    const runtime = this.ensureRuntime(session);
    if (!runtime.activeTurnId) {
      await this.telegram.sendMessage(chatId, "没有可批准的计划回合。");
      return;
    }
    await this.codex.steerTurn({
      threadId: session.claudeSessionId,
      expectedTurnId: runtime.activeTurnId,
      input: "Plan approved. Please proceed to implementation.",
    });
    runtime.waitingPlan = false;
    this.mirror.updateSessionStatus(session.id, "working");
    await this.telegram.sendMessage(chatId, "计划已批准，已进入实现阶段。");
  }

  private async startPrompt(session: ConductorSessionRef, text: string, queueItemId: number | null): Promise<void> {
    if (!session.claudeSessionId) {
      throw new Error(`Session ${session.id} missing thread id`);
    }
    const runtime = this.ensureRuntime(session);
    if (runtime.activeTurnId) {
      throw new Error(`Session ${session.id} already has active turn ${runtime.activeTurnId}`);
    }

    const workspacePath = this.registry.resolveWorkspacePath(session.workspaceId);
    this.mirror.updateSessionStatus(session.id, "working");
    runtime.waitingPlan = false;
    runtime.waitingUserInput = false;
    runtime.currentQueueItemId = queueItemId;

    await this.codex.resumeThread({
      threadId: session.claudeSessionId,
      cwd: workspacePath,
      model: session.model,
    });
    const { turnId } = await this.codex.startTurn({
      threadId: session.claudeSessionId,
      input: text,
      cwd: workspacePath,
      model: session.model,
    });

    runtime.activeTurnId = turnId;
    runtime.turnBuffers.set(turnId, "");
    this.mirror.appendUserMessage({
      sessionId: session.id,
      turnId,
      text,
      sentAt: new Date().toISOString(),
    });
  }

  private async processAllQueues(): Promise<void> {
    const sessionIds = this.stateStore.listQueuedSessionIds();
    for (const sessionId of sessionIds) {
      await this.processSessionQueue(sessionId);
    }
  }

  private async processSessionQueue(sessionId: string): Promise<void> {
    if (this.queueLocks.has(sessionId)) {
      return;
    }
    this.queueLocks.add(sessionId);
    try {
      const session = this.registry.getSessionById(sessionId);
      if (!session || !session.claudeSessionId) {
        return;
      }
      const runtime = this.ensureRuntime(session);
      if (runtime.activeTurnId || runtime.waitingPlan || runtime.waitingUserInput) {
        return;
      }
      if (session.status === "working" && runtime.activeTurnId === null) {
        return;
      }

      const queueItem = this.stateStore.getNextQueuedPrompt(sessionId);
      if (!queueItem) {
        return;
      }
      this.stateStore.markPromptStarted(queueItem.id);
      try {
        await this.startPrompt(session, queueItem.text, queueItem.id);
      } catch (error) {
        this.stateStore.markPromptFinished(queueItem.id, "failed");
        this.mirror.updateSessionStatus(session.id, "error");
        await this.notifyFollowers(session.id, `队列任务失败：${extractHumanText(error)}`);
      }
    } finally {
      this.queueLocks.delete(sessionId);
    }
  }

  private async handleCodexNotification(notification: CodexNotification): Promise<void> {
    const method = notification.method.toLowerCase();

    if (method.includes("agentmessagedelta") || method.includes("item/agentmessage/delta")) {
      await this.handleAgentMessageDelta(notification.params);
      return;
    }
    if (method.includes("turnstarted") || method.includes("turn/started")) {
      this.handleTurnStarted(notification.params);
      return;
    }
    if (method.includes("turncompleted") || method.includes("turn/completed")) {
      await this.handleTurnCompleted(notification.params);
      return;
    }
    if (method.includes("turnplanupdated") || method.includes("turn/plan/updated")) {
      await this.handleTurnPlanUpdated(notification.params);
      return;
    }
    if (method.includes("requestuserinput") || method.includes("item/tool/requestuserinput")) {
      await this.handleNeedsUserInput(notification.params);
      return;
    }
    if (method.includes("threadstatuschanged") || method.includes("thread/status/changed")) {
      await this.handleThreadStatusChanged(notification.params);
    }
  }

  private handleTurnStarted(params: Record<string, unknown>): void {
    const threadId = typeof params.threadId === "string" ? params.threadId : null;
    const turn = params.turn as { id?: string } | undefined;
    if (!threadId || !turn?.id) {
      return;
    }
    const session = this.resolveSessionByThread(threadId);
    if (!session) {
      return;
    }
    const runtime = this.ensureRuntime(session);
    runtime.activeTurnId = turn.id;
    runtime.waitingPlan = false;
    runtime.waitingUserInput = false;
  }

  private async handleAgentMessageDelta(params: Record<string, unknown>): Promise<void> {
    const threadId = typeof params.threadId === "string" ? params.threadId : null;
    const turnId = typeof params.turnId === "string" ? params.turnId : null;
    const delta = typeof params.delta === "string" ? params.delta : "";
    if (!threadId || !turnId || !delta) {
      return;
    }

    const session = this.resolveSessionByThread(threadId);
    if (!session) {
      return;
    }
    const runtime = this.ensureRuntime(session);
    const next = `${runtime.turnBuffers.get(turnId) ?? ""}${delta}`;
    runtime.turnBuffers.set(turnId, next);
    await this.streamDeltaToFollowers(runtime, turnId, next);
  }

  private async handleTurnPlanUpdated(params: Record<string, unknown>): Promise<void> {
    const threadId = typeof params.threadId === "string" ? params.threadId : null;
    const turnId = typeof params.turnId === "string" ? params.turnId : null;
    const plan = Array.isArray(params.plan) ? params.plan : [];
    if (!threadId || !turnId) {
      return;
    }

    const session = this.resolveSessionByThread(threadId);
    if (!session) {
      return;
    }
    const runtime = this.ensureRuntime(session);
    runtime.activeTurnId = turnId;
    runtime.waitingPlan = true;
    runtime.planText = formatPlan(
      plan
        .filter((x): x is { step: string; status: string } => {
          if (!x || typeof x !== "object") {
            return false;
          }
          const row = x as Record<string, unknown>;
          return typeof row.step === "string" && typeof row.status === "string";
        })
        .map((x) => ({ step: x.step, status: x.status })),
      typeof params.explanation === "string" ? params.explanation : null,
    );
    this.mirror.updateSessionStatus(session.id, "needs_plan_response");

    const text = runtime.planText ? `需要计划确认：\n${runtime.planText}` : "需要计划确认。";
    await this.notifyFollowers(session.id, text, planKeyboard());
  }

  private async handleNeedsUserInput(params: Record<string, unknown>): Promise<void> {
    const threadId = typeof params.threadId === "string" ? params.threadId : null;
    if (!threadId) {
      return;
    }
    const session = this.resolveSessionByThread(threadId);
    if (!session) {
      return;
    }
    const runtime = this.ensureRuntime(session);
    runtime.waitingUserInput = true;
    const turnId = typeof params.turnId === "string" ? params.turnId : runtime.activeTurnId;
    runtime.activeTurnId = turnId;
    this.mirror.updateSessionStatus(session.id, "needs_user_input");

    const question = extractHumanText(params);
    await this.notifyFollowers(
      session.id,
      question ? `需要你的输入：\n${question}` : "当前回合需要你的输入。",
      replyKeyboard(),
    );
  }

  private async handleThreadStatusChanged(params: Record<string, unknown>): Promise<void> {
    const threadId = typeof params.threadId === "string" ? params.threadId : null;
    if (!threadId) {
      return;
    }
    const session = this.resolveSessionByThread(threadId);
    if (!session) {
      return;
    }

    const status = params.status as { type?: string; activeFlags?: unknown[] } | undefined;
    if (!status || typeof status.type !== "string") {
      return;
    }

    const runtime = this.ensureRuntime(session);
    if (status.type === "active" && Array.isArray(status.activeFlags)) {
      if (status.activeFlags.includes("waitingOnUserInput")) {
        runtime.waitingUserInput = true;
        this.mirror.updateSessionStatus(session.id, "needs_user_input");
      }
      if (status.activeFlags.includes("waitingOnApproval")) {
        runtime.waitingPlan = true;
        this.mirror.updateSessionStatus(session.id, "needs_plan_response");
      }
    }
  }

  private async handleTurnCompleted(params: Record<string, unknown>): Promise<void> {
    const threadId = typeof params.threadId === "string" ? params.threadId : null;
    const turn = params.turn as { id?: string; status?: string; error?: { message?: string } } | undefined;
    if (!threadId || !turn?.id || !turn.status) {
      return;
    }
    const session = this.resolveSessionByThread(threadId);
    if (!session) {
      return;
    }
    const runtime = this.ensureRuntime(session);
    const turnId = turn.id;
    const buffer = runtime.turnBuffers.get(turnId) ?? "";

    if (buffer.trim()) {
      this.mirror.appendAssistantMessage({
        sessionId: session.id,
        threadId,
        turnId,
        text: buffer,
        sentAt: new Date().toISOString(),
        model: session.model,
      });
    }

    await this.flushFinalStream(runtime, turnId, buffer);

    const failed = turn.status === "failed" || turn.status === "interrupted";
    let nextStatus: SessionStatus;
    if (runtime.waitingUserInput) {
      nextStatus = "needs_user_input";
    } else if (runtime.waitingPlan) {
      nextStatus = "needs_plan_response";
    } else if (failed) {
      nextStatus = "error";
    } else {
      nextStatus = "idle";
    }
    this.mirror.updateSessionStatus(session.id, nextStatus);

    if (runtime.currentQueueItemId !== null) {
      this.stateStore.markPromptFinished(runtime.currentQueueItemId, failed ? "failed" : "finished");
      runtime.currentQueueItemId = null;
    }
    if (failed && turn.error?.message) {
      await this.notifyFollowers(session.id, `回合失败：${turn.error.message}`);
    }

    if (!runtime.waitingPlan && !runtime.waitingUserInput) {
      runtime.activeTurnId = null;
      runtime.turnBuffers.delete(turnId);
      runtime.planText = null;
    }

    if (nextStatus === "idle") {
      await this.processSessionQueue(session.id);
    }
  }

  private async streamDeltaToFollowers(runtime: RuntimeState, turnId: string, text: string): Promise<void> {
    const chats = this.stateStore.listFollowingChats(runtime.sessionId);
    if (chats.length === 0) {
      return;
    }
    const preview = truncate(text, 3500);
    const now = Date.now();

    for (const chatId of chats) {
      const existing = runtime.streamByChat.get(chatId);
      if (!existing || existing.turnId !== turnId) {
        const messageId = await this.telegram.sendMessage(chatId, preview || "...");
        if (messageId) {
          runtime.streamByChat.set(chatId, {
            turnId,
            messageId,
            lastAt: now,
            lastText: preview,
          });
        }
        continue;
      }

      if (now - existing.lastAt < 1200) {
        continue;
      }
      if (existing.lastText === preview) {
        continue;
      }
      await this.telegram.editMessageText(chatId, existing.messageId, preview || "...");
      existing.lastAt = now;
      existing.lastText = preview;
    }
  }

  private async flushFinalStream(runtime: RuntimeState, turnId: string, text: string): Promise<void> {
    const finalText = truncate(text, 3500);
    const chats = this.stateStore.listFollowingChats(runtime.sessionId);
    for (const chatId of chats) {
      const existing = runtime.streamByChat.get(chatId);
      if (existing && existing.turnId === turnId) {
        if (finalText && finalText !== existing.lastText) {
          await this.telegram.editMessageText(chatId, existing.messageId, finalText);
        }
        runtime.streamByChat.delete(chatId);
      } else if (finalText) {
        await this.telegram.sendMessage(chatId, finalText);
      }
    }
  }

  private resolveSessionByThread(threadId: string): ConductorSessionRef | null {
    const knownSessionId = this.threadToSession.get(threadId);
    if (knownSessionId) {
      const session = this.registry.getSessionById(knownSessionId);
      if (session) {
        return session;
      }
      this.threadToSession.delete(threadId);
    }
    const fromDb = this.registry.findSessionByThreadId(threadId);
    if (fromDb) {
      this.threadToSession.set(threadId, fromDb.id);
      return fromDb;
    }
    return null;
  }

  private ensureRuntime(session: ConductorSessionRef): RuntimeState {
    const existing = this.runtimeBySession.get(session.id);
    if (existing) {
      return existing;
    }
    const runtime: RuntimeState = {
      sessionId: session.id,
      workspaceId: session.workspaceId,
      threadId: session.claudeSessionId ?? "",
      model: session.model,
      activeTurnId: null,
      waitingPlan: session.status === "needs_plan_response",
      waitingUserInput: session.status === "needs_user_input",
      planText: null,
      currentQueueItemId: null,
      turnBuffers: new Map(),
      streamByChat: new Map(),
    };
    this.runtimeBySession.set(session.id, runtime);
    if (session.claudeSessionId) {
      this.threadToSession.set(session.claudeSessionId, session.id);
    }
    return runtime;
  }

  private async ensureContextSession(
    chatId: number,
    ctx: ChatContext,
  ): Promise<{ context: ChatContext; session: ConductorSessionRef | null }> {
    if (ctx.activeSessionId) {
      const session = this.registry.getSessionById(ctx.activeSessionId);
      if (session) {
        this.ensureRuntime(session);
        return { context: ctx, session };
      }
    }

    if (!ctx.activeWorkspaceId) {
      return { context: ctx, session: null };
    }

    const workspace = this.registry.getWorkspaceById(ctx.activeWorkspaceId);
    if (!workspace) {
      return { context: ctx, session: null };
    }

    if (workspace.activeSessionId) {
      const active = this.registry.getSessionById(workspace.activeSessionId);
      if (active) {
        const next = this.stateStore.updateChatContext(chatId, {
          activeSessionId: active.id,
          followSessionId: active.id,
        });
        this.ensureRuntime(active);
        return { context: next, session: active };
      }
    }

    const sessions = this.registry.listSessions(workspace.id, 2);
    if (sessions.length === 1) {
      const single = sessions[0];
      if (single) {
        const next = this.stateStore.updateChatContext(chatId, {
          activeSessionId: single.id,
          followSessionId: single.id,
        });
        this.ensureRuntime(single);
        return { context: next, session: single };
      }
    }

    return { context: ctx, session: null };
  }

  private async notifyFollowers(sessionId: string, text: string, keyboard?: TelegramInlineKeyboard): Promise<void> {
    const chats = this.stateStore.listFollowingChats(sessionId);
    for (const chatId of chats) {
      await this.telegram.sendMessage(
        chatId,
        text,
        keyboard ? { reply_markup: { inline_keyboard: keyboard } } : undefined,
      );
    }
  }
}
