import { setTimeout as delay } from "node:timers/promises";

import { CodexAppServerAdapter } from "../adapters/codex-app-server.js";
import { ConductorMirrorWriter } from "../adapters/conductor-mirror.js";
import { ConductorRegistryAdapter } from "../adapters/conductor-registry.js";
import { BridgeStateStore } from "../bridge/state-store.js";
import { isTransientTelegramError, summarizeTelegramError, TelegramClient } from "../telegram/client.js";
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
import { isStatusProbeText } from "../utils/intent.js";
import { logger } from "../utils/logger.js";
import { normalizeTelegramCommand } from "../utils/telegram-command.js";

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
        if (isTransientTelegramError(error)) {
          logger.warn("telegram polling interrupted; retrying", summarizeTelegramError(error));
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
      await this.telegram.sendMessage(chatId, "Unauthorized account. Access to Conductor is disabled.");
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
      await this.telegram.answerCallbackQuery(query.id, "Unauthorized");
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
          await this.showWorkspaces(chatId, "Select a workspace before creating a new session.");
        } else {
          this.stateStore.setComposeMode(chatId, "new_session", { composeWorkspaceId: ctx.activeWorkspaceId });
          await this.telegram.sendMessage(
            chatId,
            "New Chat Here is active. Your next message will create a new session in the current workspace.",
          );
        }
      } else if (data === "home:sessions") {
        await this.showSessions(chatId);
      } else if (data === "home:branches") {
        await this.showWorkspaces(chatId, "Select a branch");
      } else if (data === "home:workspaces") {
        await this.showWorkspaces(chatId, "Select a repo");
      } else if (data === "home:inbox") {
        await this.showInbox(chatId);
      } else if (data === "home:help") {
        await this.telegram.sendMessage(
          chatId,
          [
            "/home",
            "/workspaces",
            "/sessions",
            "/new",
            "/inbox",
            "/stop",
            "/queue",
            "/cancel",
            "/help",
            "",
            "Plain text continues the currently selected session.",
            "Short status questions like 'status' or '目前什么状态' show the current status.",
          ].join("\n"),
        );
      } else if (data === "home:stop") {
        const text = await this.interruptCurrentTurn(chatId, { suppressMessage: true });
        await this.telegram.answerCallbackQuery(query.id, text);
        return;
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
      await this.telegram.answerCallbackQuery(query.id, "Action failed");
    }
  }

  private async handleCommand(chatId: number, commandText: string): Promise<void> {
    const command = normalizeTelegramCommand(commandText);
    switch (command) {
      case "/start":
      case "/home":
        await this.showHome(chatId);
        break;
      case "/repos":
      case "/workspaces":
        await this.showWorkspaces(chatId, "Select a repo");
        break;
      case "/branches":
        await this.showWorkspaces(chatId, "Select a branch");
        break;
      case "/chats":
      case "/sessions":
        await this.showSessions(chatId);
        break;
      case "/new": {
        const ctx = this.stateStore.getChatContext(chatId);
        if (!ctx.activeWorkspaceId) {
          await this.showWorkspaces(chatId, "Select a workspace before creating a new session.");
          return;
        }
        this.stateStore.setComposeMode(chatId, "new_session", { composeWorkspaceId: ctx.activeWorkspaceId });
        await this.telegram.sendMessage(
          chatId,
          "Your next message will create a new session in the current workspace.",
        );
        break;
      }
      case "/inbox":
        await this.showInbox(chatId);
        break;
      case "/stop":
        await this.interruptCurrentTurn(chatId);
        break;
      case "/queue":
        await this.showQueue(chatId);
        break;
      case "/cancel":
        this.stateStore.clearComposeMode(chatId);
        await this.telegram.sendMessage(chatId, "Exited one-shot input mode.");
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
            "/stop",
            "/inbox",
            "/queue",
            "/cancel",
            "",
            "Send text directly to continue the current session.",
            "Short status questions like 'status' or '目前什么状态' show the current status.",
          ].join("\n"),
        );
        break;
    }
  }

  private async handlePlainText(chatId: number, text: string): Promise<void> {
    if (isStatusProbeText(text)) {
      await this.showHome(chatId);
      return;
    }

    const ctx = this.stateStore.getChatContext(chatId);

    if (ctx.composeMode === "new_session") {
      const workspaceId = ctx.composeWorkspaceId ?? ctx.activeWorkspaceId;
      if (!workspaceId) {
        await this.showWorkspaces(chatId, "Please select a workspace first.");
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
      await this.showWorkspaces(chatId, "There is no current session yet. Select a workspace first.");
      return;
    }

    await this.routeTextToSession(chatId, resolved.session, text);
  }

  private async routeTextToSession(chatId: number, session: ConductorSessionRef, text: string): Promise<void> {
    const runtime = this.ensureRuntime(session);
    if (!session.claudeSessionId) {
      await this.telegram.sendMessage(chatId, "This session is missing its underlying thread ID and cannot continue.");
      return;
    }

    if (runtime.waitingPlan || session.status === "needs_plan_response") {
      await this.telegram.sendMessage(
        chatId,
        "This turn is waiting for plan confirmation. Tap Approve Plan or Revise Plan.",
        {
          reply_markup: { inline_keyboard: planKeyboard() },
        },
      );
      return;
    }

    if (runtime.waitingUserInput || session.status === "needs_user_input") {
      await this.telegram.sendMessage(chatId, "This turn is waiting for more input. Tap Reply Now.", {
        reply_markup: { inline_keyboard: replyKeyboard() },
      });
      return;
    }

    if (runtime.activeTurnId || (session.status === "working" && runtime.activeTurnId === null)) {
      this.stateStore.enqueuePrompt(session.id, session.claudeSessionId, "normal", text);
      await this.telegram.sendMessage(chatId, "The current session is working. Your message has been queued.");
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
      `Created session: ${session.title ?? session.id.slice(0, 8)}. Starting the first turn.`,
    );

    try {
      await this.startPrompt(session, openingPrompt, null, {
        allowMissingRollout: true,
      });
    } catch (error) {
      this.mirror.updateSessionStatus(session.id, "error");
      await this.telegram.sendMessage(chatId, `The first turn failed: ${extractHumanText(error)}`);
    }
  }

  private async sendSteerInput(chatId: number, input: string, mode: "plan_feedback" | "reply_required"): Promise<void> {
    const ctx = this.stateStore.getChatContext(chatId);
    if (!ctx.composeTargetSessionId || !ctx.composeTargetThreadId || !ctx.composeTargetTurnId) {
      this.stateStore.clearComposeMode(chatId);
      await this.telegram.sendMessage(chatId, "There is no target turn to continue. Exited input mode.");
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
    await this.telegram.sendMessage(chatId, mode === "plan_feedback" ? "Submitted plan feedback." : "Submitted input.");
  }

  private canInterruptTurn(runtime: RuntimeState | null): boolean {
    return Boolean(runtime?.activeTurnId);
  }

  private async interruptCurrentTurn(chatId: number, options?: { suppressMessage?: boolean }): Promise<string> {
    const ctx = this.stateStore.getChatContext(chatId);
    const session = ctx.activeSessionId ? this.registry.getSessionById(ctx.activeSessionId) : null;
    if (!session) {
      const text = "Select a chat first.";
      if (!options?.suppressMessage) {
        await this.telegram.sendMessage(chatId, text);
      }
      return text;
    }

    const runtime = this.ensureRuntime(session);
    if (!runtime.activeTurnId) {
      const text =
        session.status === "working" || session.status === "cancelling"
          ? "This session is busy, but the active turn cannot be interrupted from the bridge right now."
          : "There is no active turn to interrupt.";
      if (!options?.suppressMessage) {
        await this.telegram.sendMessage(chatId, text);
      }
      return text;
    }

    await this.codex.interruptTurn({
      threadId: runtime.threadId,
      turnId: runtime.activeTurnId,
    });
    runtime.waitingPlan = false;
    runtime.waitingUserInput = false;
    this.stateStore.clearComposeMode(chatId);
    this.mirror.updateSessionStatus(session.id, "cancelling");

    const text = "Interrupt requested.";
    if (!options?.suppressMessage) {
      await this.telegram.sendMessage(chatId, text);
    }
    return text;
  }

  private async showHome(chatId: number): Promise<void> {
    let ctx = this.stateStore.getChatContext(chatId);
    const resolved = await this.ensureContextSession(chatId, ctx);
    ctx = resolved.context;

    const workspace = ctx.activeWorkspaceId ? this.registry.getWorkspaceById(ctx.activeWorkspaceId) : null;
    const session = resolved.session;
    const runtime = session ? (this.runtimeBySession.get(session.id) ?? null) : null;
    const statusLine = formatStatusLine(
      workspace ? formatWorkspaceLabel(workspace, { includeDirectory: true }) : null,
      session?.title ?? null,
      session?.status ?? null,
    );

    const modeText = ctx.composeMode === "none" ? "" : `\nmode: ${ctx.composeMode} (exits after the next message)\n`;

    const text = [
      "Home",
      statusLine,
      modeText,
      "Send text to continue the current session.",
      "Short status questions like 'status' or '目前什么状态' show the current status.",
    ].join("\n");
    await this.telegram.sendMessage(chatId, text, {
      reply_markup: { inline_keyboard: homeKeyboard({ showStop: this.canInterruptTurn(runtime) }) },
    });
  }

  private async showWorkspaces(chatId: number, title: string): Promise<void> {
    const workspaces = this.registry.listWorkspaces(this.config.pageSize);
    if (workspaces.length === 0) {
      await this.telegram.sendMessage(chatId, "No workspaces are available.");
      return;
    }
    await this.telegram.sendMessage(chatId, title, {
      reply_markup: { inline_keyboard: workspacesKeyboard(workspaces) },
    });
  }

  private async showSessions(chatId: number): Promise<void> {
    const ctx = this.stateStore.getChatContext(chatId);
    if (!ctx.activeWorkspaceId) {
      await this.showWorkspaces(chatId, "Select a workspace first.");
      return;
    }
    const sessions = this.registry.listSessions(ctx.activeWorkspaceId, this.config.pageSize);
    if (sessions.length === 0) {
      await this.telegram.sendMessage(chatId, "The current workspace has no sessions.");
      return;
    }
    await this.telegram.sendMessage(
      chatId,
      formatSessionPickerText(sessions, {
        activeSessionId: ctx.activeSessionId,
        heading: "Select a session",
      }),
      {
        reply_markup: { inline_keyboard: sessionsKeyboard(sessions) },
      },
    );
  }

  private async showInbox(chatId: number): Promise<void> {
    const sessions = this.registry.getInboxSessions(this.config.pageSize);
    if (sessions.length === 0) {
      await this.telegram.sendMessage(chatId, "Inbox is empty.");
      return;
    }
    await this.telegram.sendMessage(chatId, "Inbox", {
      reply_markup: { inline_keyboard: inboxKeyboard(sessions) },
    });
  }

  private async showQueue(chatId: number): Promise<void> {
    const ctx = this.stateStore.getChatContext(chatId);
    if (!ctx.activeSessionId) {
      await this.telegram.sendMessage(chatId, "There is no current session.");
      return;
    }
    const items = this.stateStore.listQueueForSession(ctx.activeSessionId, 12);
    if (items.length === 0) {
      await this.telegram.sendMessage(chatId, "The current queue is empty.");
      return;
    }
    const lines = items.map((item) => `#${item.id} [${item.status}] ${truncate(item.text, 90).replaceAll("\n", " ")}`);
    await this.telegram.sendMessage(chatId, lines.join("\n"));
  }

  private async selectWorkspace(chatId: number, workspaceId: string): Promise<void> {
    const workspace = this.registry.getWorkspaceById(workspaceId);
    if (!workspace) {
      await this.telegram.sendMessage(chatId, "Workspace not found.");
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
      await this.telegram.sendMessage(chatId, "Session not found.");
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
      await this.telegram.sendMessage(chatId, "There is no actionable session.");
      return;
    }
    const runtime = this.ensureRuntime(session);
    if (!runtime.activeTurnId) {
      await this.telegram.sendMessage(chatId, "There is no active turn.");
      return;
    }
    this.stateStore.setComposeMode(chatId, "plan_feedback", {
      composeTargetSessionId: session.id,
      composeTargetThreadId: session.claudeSessionId,
      composeTargetTurnId: runtime.activeTurnId,
    });
    await this.telegram.sendMessage(
      chatId,
      "Entered Revise Plan mode. Your next message will be sent as plan feedback.",
    );
  }

  private async enterReplyRequiredMode(chatId: number): Promise<void> {
    const ctx = this.stateStore.getChatContext(chatId);
    const session = ctx.activeSessionId ? this.registry.getSessionById(ctx.activeSessionId) : null;
    if (!session || !session.claudeSessionId) {
      await this.telegram.sendMessage(chatId, "There is no actionable session.");
      return;
    }
    const runtime = this.ensureRuntime(session);
    if (!runtime.activeTurnId) {
      await this.telegram.sendMessage(chatId, "There is no active turn.");
      return;
    }
    this.stateStore.setComposeMode(chatId, "reply_required", {
      composeTargetSessionId: session.id,
      composeTargetThreadId: session.claudeSessionId,
      composeTargetTurnId: runtime.activeTurnId,
    });
    await this.telegram.sendMessage(chatId, "Entered Reply mode. Your next message will be sent as a direct reply.");
  }

  private async approvePlan(chatId: number): Promise<void> {
    const ctx = this.stateStore.getChatContext(chatId);
    const session = ctx.activeSessionId ? this.registry.getSessionById(ctx.activeSessionId) : null;
    if (!session || !session.claudeSessionId) {
      await this.telegram.sendMessage(chatId, "There is no actionable session.");
      return;
    }
    const runtime = this.ensureRuntime(session);
    if (!runtime.activeTurnId) {
      await this.telegram.sendMessage(chatId, "There is no approvable plan turn.");
      return;
    }
    await this.codex.steerTurn({
      threadId: session.claudeSessionId,
      expectedTurnId: runtime.activeTurnId,
      input: "Plan approved. Please proceed to implementation.",
    });
    runtime.waitingPlan = false;
    this.mirror.updateSessionStatus(session.id, "working");
    await this.telegram.sendMessage(chatId, "Plan approved. Moving to implementation.");
  }

  private async startPrompt(
    session: ConductorSessionRef,
    text: string,
    queueItemId: number | null,
    options?: {
      allowMissingRollout?: boolean;
    },
  ): Promise<void> {
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
      ...(options?.allowMissingRollout ? { allowMissingRollout: true } : {}),
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
        await this.notifyFollowers(session.id, `Queued task failed: ${extractHumanText(error)}`);
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

    const text = runtime.planText ? `Plan approval required:\n${runtime.planText}` : "Plan approval required.";
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
      question ? `Input required:\n${question}` : "This turn needs your input.",
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

    const failed = turn.status === "failed";
    const interrupted = turn.status === "interrupted";
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
      this.stateStore.markPromptFinished(
        runtime.currentQueueItemId,
        failed ? "failed" : interrupted ? "cancelled" : "finished",
      );
      runtime.currentQueueItemId = null;
    }
    if (failed && turn.error?.message) {
      await this.notifyFollowers(session.id, `Turn failed: ${turn.error.message}`);
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
