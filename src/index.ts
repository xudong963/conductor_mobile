import process from "node:process";
import { pathToFileURL } from "node:url";

import { ConductorMirrorWriter } from "./adapters/conductor-mirror.js";
import { CodexAppServerAdapter } from "./adapters/codex-app-server.js";
import { ConductorRegistryAdapter } from "./adapters/conductor-registry.js";
import { BridgeStateStore } from "./bridge/state-store.js";
import { config } from "./config.js";
import {
  isTelegramMessageNotModifiedError,
  isTransientTelegramError,
  summarizeTelegramError,
  TelegramClient,
} from "./telegram/client.js";
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
  TelegramConversationTarget,
  TelegramInlineKeyboard,
  TelegramMessage,
  TelegramUpdate,
  WorkspaceRef,
} from "./types.js";
import { logger } from "./utils/logger.js";
import { KeyedSerialTaskQueue } from "./utils/keyed-serial-task-queue.js";
import { isStatusProbeText } from "./utils/intent.js";
import { normalizeTelegramCommand } from "./utils/telegram-command.js";
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
  entryCount: number;
  keyboardFingerprint: string | null;
  lastText: string | null;
  limit: number;
  location: TelegramConversationTarget;
  messageId: number | null;
  pageIndex: number;
  pages: string[];
  sessionId: string;
  sessionTitle: string;
}

interface SessionPanelState {
  keyboardFingerprint: string;
  lastText: string;
  lastSentAt: number;
  messageId: number | null;
  sessionId: string | null;
}

interface SessionStreamState {
  keyboardFingerprint: string | null;
  lastSentAt: number;
  lastText: string;
  messageId: number | null;
  sessionId: string | null;
  turnId: string | null;
}

interface RuntimeState {
  activityText: string | null;
  assistantText: string;
  lastEventAt: string | null;
  model: string | null;
  planText: string | null;
  sessionId: string;
  status: "active" | "cancelling" | "waiting_user_input" | "waiting_plan" | "completed" | "failed";
  threadId: string;
  turnId: string;
}

interface CodexServerRequest {
  id: number | string;
  method: string;
  params: Record<string, unknown>;
}

type PromptSubmitResult = "submitted" | "queued" | "retryable_failure" | "permanent_failure";

interface BridgeDependencies {
  codex?: CodexAppServerAdapter;
  mirror?: ConductorMirrorWriter;
  registry?: ConductorRegistryAdapter;
  stateStore?: BridgeStateStore;
  telegram?: TelegramClient;
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

function formatRuntimeEventAt(value: string | null): string | null {
  if (!value) {
    return null;
  }
  return value.length >= 16 ? value.slice(0, 16).replace("T", " ") : value;
}

function describeRuntimeActivity(item: Record<string, unknown>, phase: "started" | "completed"): string | null {
  const itemType = asString(item.type);
  if (!itemType) {
    return null;
  }

  switch (itemType) {
    case "agentMessage":
      return phase === "started" ? "Composing reply..." : null;
    case "commandExecution": {
      const command = truncate(asString(item.command) ?? "command", 120);
      const exitCode = typeof item.exitCode === "number" ? item.exitCode : null;
      if (phase === "started") {
        return `Running command: ${command}`;
      }
      return `Command finished${exitCode !== null ? ` (exit ${exitCode})` : ""}: ${command}`;
    }
    case "mcpToolCall":
    case "dynamicToolCall":
    case "collabAgentToolCall": {
      const label = [asString(item.server), asString(item.tool) ?? asString(item.name)]
        .filter((part): part is string => Boolean(part))
        .join("/");
      if (phase === "started") {
        return `Calling tool: ${label || "tool"}`;
      }
      return `Tool finished: ${label || "tool"}`;
    }
    case "webSearch": {
      const query = truncate(asString(item.query) ?? "query", 120);
      if (phase === "started") {
        return `Searching the web: ${query}`;
      }
      return `Search finished: ${query}`;
    }
    case "fileChange":
      return phase === "started" ? "Applying file changes..." : "File changes prepared.";
    case "reasoning":
      return phase === "started" ? "Reasoning..." : "Reasoning step finished.";
    case "plan":
      return phase === "started" ? "Preparing plan..." : "Plan ready for review.";
    default:
      return phase === "started" ? `Working on ${itemType}...` : `Finished ${itemType}.`;
  }
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

function toConversationTarget(
  message: Pick<TelegramMessage, "chat" | "is_topic_message" | "message_thread_id">,
): TelegramConversationTarget {
  return {
    chatId: message.chat.id,
    // Telegram's built-in General forum topic must be addressed like the parent supergroup.
    messageThreadId: message.is_topic_message ? (message.message_thread_id ?? null) : null,
  };
}

function conversationKey(target: TelegramConversationTarget): string {
  return `${target.chatId}:${target.messageThreadId ?? 0}`;
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

function queueDrainStatus(result: PromptSubmitResult): "finished" | "retry" | "failed" {
  switch (result) {
    case "submitted":
      return "finished";
    case "retryable_failure":
      return "retry";
    case "queued":
    case "permanent_failure":
      return "failed";
  }
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
  { command: "stop", description: "Interrupt the current turn" },
  { command: "queue", description: "Show the current chat queue" },
  { command: "context", description: "Open the recent context viewer" },
  { command: "new", description: "Create a new chat with the next message" },
  { command: "new_workspace", description: "Create a new workspace from the next message" },
  { command: "help", description: "Show help" },
];

const STREAM_EDIT_INTERVAL_MS = 400;
const STREAM_EAGER_EDIT_CHARS = 120;
const PANEL_EDIT_INTERVAL_MS = 350;
const PANEL_EAGER_EDIT_CHARS = 140;
const TOPIC_LOCKED_CALLBACK_TEXT = "This topic is locked to its current chat. Use the main chat.";
const TOPIC_LOCKED_MESSAGE =
  "This topic is locked to its current chat. Use the main chat to switch repos, branches, open inbox, or select or create another chat.";

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
    "/stop  Interrupt the current turn",
    "/queue  Show the current chat queue",
    "/context [N]  Open the paginated recent context viewer",
    "/new  Make the next message create a new chat on the current branch",
    "/new_workspace  Make the next message create a new workspace in the current repo",
    "/help  Show help",
    "",
    "You can also tap Help on the home screen.",
    "Plain text continues the currently selected chat.",
    "Short status questions like 'status' or '目前什么状态' refresh the status panel.",
    "In forum-enabled supergroups, each chat streams in its dedicated topic.",
  ].join("\n");
}

export class TelegramConductorBridge {
  private readonly codex: CodexAppServerAdapter;
  private readonly mirror: ConductorMirrorWriter;
  private readonly registry: ConductorRegistryAdapter;
  private readonly stateStore: BridgeStateStore;
  private readonly telegram: TelegramClient;
  private readonly runtimes = new Map<string, RuntimeState>();
  private readonly pendingInputRequests = new Map<string, PendingInputRequest>();
  private readonly sessionIdByThreadId = new Map<string, string>();
  private readonly contextViewers = new Map<string, ContextViewerState>();
  private readonly interactionQueue = new KeyedSerialTaskQueue<string>();
  private readonly queueDrainQueue = new KeyedSerialTaskQueue<string>();
  private readonly sessionPanels = new Map<string, SessionPanelState>();
  private readonly sessionPanelQueue = new KeyedSerialTaskQueue<string>();
  private readonly sessionStreams = new Map<string, SessionStreamState>();
  private readonly sessionStreamQueue = new KeyedSerialTaskQueue<string>();
  private readonly backgroundTasks = new Set<Promise<void>>();
  private queueTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(deps: BridgeDependencies = {}) {
    this.codex = deps.codex ?? new CodexAppServerAdapter(config.codexBin);
    this.registry =
      deps.registry ??
      new ConductorRegistryAdapter(config.conductorDbPath, {
        workspacesRoot: config.workspacesRoot,
        defaultFallbackModel: config.defaultFallbackModel,
        defaultPermissionMode: config.defaultPermissionMode,
      });
    this.stateStore = deps.stateStore ?? new BridgeStateStore(config.bridgeDbPath);
    this.telegram = deps.telegram ?? new TelegramClient(config.telegramToken);
    this.mirror = deps.mirror ?? new ConductorMirrorWriter(this.registry, this.stateStore);
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
    void this.drainQueues().catch((error) => {
      logger.error("failed to drain queue", error);
    });

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
    if (this.backgroundTasks.size > 0) {
      await Promise.allSettled(this.backgroundTasks);
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
        if (isTransientTelegramError(error)) {
          logger.warn("telegram polling interrupted; retrying", summarizeTelegramError(error));
        } else {
          logger.error("telegram polling failed", error);
        }
        await sleep(2000);
        continue;
      }

      for (const update of updates) {
        const processed = await this.processPolledUpdate(update);
        if (!processed) {
          await sleep(2000);
          break;
        }
        offset = update.update_id + 1;
      }
    }
  }

  private async processPolledUpdate(update: TelegramUpdate): Promise<boolean> {
    try {
      await this.handleUpdate(update);
      this.stateStore.setTelegramCursor(update.update_id);
      return true;
    } catch (error) {
      logger.error("failed to handle telegram update", {
        updateId: update.update_id,
        error,
      });
      const failedMessage = update.message ?? update.callback_query?.message;
      if (failedMessage) {
        await this.safeSendMessage(
          toConversationTarget(failedMessage),
          "Failed to process that message. Please try again.",
        ).catch(() => undefined);
      }
      return false;
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
    const location = toConversationTarget(message);
    if (!this.isAuthorized(location.chatId)) {
      await this.safeSendMessage(location, "Unauthorized.");
      return;
    }
    if (message.chat.type !== "private" && message.chat.type !== "supergroup") {
      await this.safeSendMessage(location, "Only Telegram private chats and supergroups are supported.");
      return;
    }
    if (!message.text) {
      return;
    }

    const text = message.text.trim();
    if (!text) {
      return;
    }

    this.enqueueConversationTask(location, async () => {
      if (text.startsWith("/")) {
        await this.handleCommand(location, text);
        return;
      }

      await this.handlePlainText(location, text);
    });
  }

  private async handleCallback(callback: TelegramCallbackQuery): Promise<void> {
    const message = callback.message;
    if (!message) {
      return;
    }
    const location = toConversationTarget(message);
    if (!this.isAuthorized(location.chatId)) {
      await this.telegram.answerCallbackQuery(callback.id, "Unauthorized");
      return;
    }

    const data = callback.data ?? "";

    if (data.startsWith("context:")) {
      await this.handleContextViewerCallback(callback, location, data);
      return;
    }

    if (data.startsWith("panel:")) {
      await this.handleSessionPanelCallback(callback, location, data);
      return;
    }

    if (data === "home:help") {
      await this.telegram.answerCallbackQuery(callback.id);
      this.enqueueConversationTask(location, async () => {
        await this.safeSendMessage(location, buildHelpText());
      });
      return;
    }

    if (this.isDedicatedTopicLocation(location) && this.isTopicLockedCallback(data)) {
      await this.rejectTopicLockedAction(location, callback.id);
      return;
    }

    if (data === "home:workspaces" || data === "home:repos") {
      await this.telegram.answerCallbackQuery(callback.id);
      this.enqueueConversationTask(location, async () => {
        await this.showRepositories(location);
      });
      return;
    }

    if (data === "home:branches") {
      await this.telegram.answerCallbackQuery(callback.id);
      this.enqueueConversationTask(location, async () => {
        await this.showBranches(location);
      });
      return;
    }

    if (data === "home:sessions" || data === "home:chats") {
      await this.telegram.answerCallbackQuery(callback.id);
      this.enqueueConversationTask(location, async () => {
        await this.showChats(location);
      });
      return;
    }

    if (data === "home:inbox") {
      await this.telegram.answerCallbackQuery(callback.id);
      this.enqueueConversationTask(location, async () => {
        await this.showInbox(location);
      });
      return;
    }

    if (data === "home:continue") {
      await this.telegram.answerCallbackQuery(callback.id);
      this.enqueueConversationTask(location, async () => {
        const session = this.resolveSelectedSession(location);
        if (!session) {
          if (this.isDedicatedTopicLocation(location)) {
            await this.safeSendMessage(location, TOPIC_LOCKED_MESSAGE);
            return;
          }
          const context = this.stateStore.getConversationContext(location);
          if (context.activeWorkspaceId) {
            await this.showChats(location, "Select a chat first.");
          } else {
            await this.showRepositories(location, "Select a repo and branch before selecting a chat.");
          }
          return;
        }
        if (
          await this.moveSessionToDedicatedTopicIfNeeded(
            location,
            session,
            `Continuing: ${formatSessionTitle(session.title)}`,
          )
        ) {
          return;
        }
        this.activateSessionLocation(location, session);
        await this.showHome(location, `Continuing: ${formatSessionTitle(session.title)}`);
      });
      return;
    }

    if (data === "home:new") {
      await this.telegram.answerCallbackQuery(callback.id);
      this.enqueueConversationTask(location, async () => {
        const context = this.stateStore.getConversationContext(location);
        if (!context.activeWorkspaceId) {
          await this.showRepositories(location, "Select a repo and branch before creating a new chat.");
          return;
        }
        this.stateStore.setConversationComposeMode(location, "new_session", {
          composeWorkspaceId: context.activeWorkspaceId,
        });
        await this.safeSendMessage(location, "Your next message will create a new chat on the current branch.");
      });
      return;
    }

    if (data === "home:new-workspace") {
      await this.telegram.answerCallbackQuery(callback.id);
      this.enqueueConversationTask(location, async () => {
        await this.prepareNewWorkspace(location);
      });
      return;
    }

    if (data === "home:stop") {
      await this.telegram.answerCallbackQuery(callback.id, "Stopping...");
      this.enqueueConversationTask(location, async () => {
        const text = await this.interruptCurrentTurn(location, { suppressMessage: true });
        if (text !== "Interrupt requested.") {
          await this.safeSendMessage(location, text);
        }
      });
      return;
    }

    if (data === "back:home") {
      await this.telegram.answerCallbackQuery(callback.id);
      this.enqueueConversationTask(location, async () => {
        await this.showHome(location);
      });
      return;
    }

    if (data === "plan:approve") {
      await this.telegram.answerCallbackQuery(callback.id);
      this.enqueueConversationTask(location, async () => {
        await this.approvePlan(location);
      });
      return;
    }

    if (data === "plan:revise") {
      await this.telegram.answerCallbackQuery(callback.id);
      this.enqueueConversationTask(location, async () => {
        await this.preparePlanRevision(location);
      });
      return;
    }

    if (data === "reply:now") {
      await this.telegram.answerCallbackQuery(callback.id);
      this.enqueueConversationTask(location, async () => {
        await this.prepareReply(location);
      });
      return;
    }

    if (data.startsWith("repo:")) {
      await this.telegram.answerCallbackQuery(callback.id);
      this.enqueueConversationTask(location, async () => {
        await this.selectRepository(location, data.slice("repo:".length));
      });
      return;
    }

    if (data.startsWith("repo-new:")) {
      await this.telegram.answerCallbackQuery(callback.id);
      this.enqueueConversationTask(location, async () => {
        await this.prepareNewWorkspace(location, data.slice("repo-new:".length));
      });
      return;
    }

    if (data.startsWith("branch:")) {
      await this.telegram.answerCallbackQuery(callback.id);
      this.enqueueConversationTask(location, async () => {
        await this.selectBranch(location, data.slice("branch:".length));
      });
      return;
    }

    if (data.startsWith("workspace:")) {
      await this.telegram.answerCallbackQuery(callback.id);
      this.enqueueConversationTask(location, async () => {
        const id = data.slice("workspace:".length);
        if (this.registry.getWorkspaceById(id)) {
          await this.selectBranch(location, id);
          return;
        }
        await this.selectRepository(location, id);
      });
      return;
    }

    if (data.startsWith("session:")) {
      await this.telegram.answerCallbackQuery(callback.id);
      this.enqueueConversationTask(location, async () => {
        const id = data.slice("session:".length);
        if (this.registry.getSessionById(id)) {
          await this.selectChat(location, id);
          return;
        }
        if (this.registry.getWorkspaceById(id)) {
          await this.selectBranch(location, id);
          return;
        }
        await this.safeSendMessage(location, "Chat not found.");
      });
      return;
    }

    await this.telegram.answerCallbackQuery(callback.id, "Not implemented yet");
  }

  private async handleCommand(location: TelegramConversationTarget, rawCommand: string): Promise<void> {
    const command = normalizeTelegramCommand(rawCommand);
    if (this.isDedicatedTopicLocation(location) && this.isTopicLockedCommand(command)) {
      await this.rejectTopicLockedAction(location);
      return;
    }

    switch (command) {
      case "/start":
      case "/home":
        await this.showHome(location);
        return;
      case "/repos":
      case "/workspaces":
        await this.showRepositories(location);
        return;
      case "/branches":
        await this.showBranches(location);
        return;
      case "/chats":
      case "/sessions":
        await this.showChats(location);
        return;
      case "/status":
        await this.showStatus(location);
        return;
      case "/stop":
        await this.interruptCurrentTurn(location);
        return;
      case "/queue":
        await this.showQueue(location);
        return;
      case "/context":
        await this.showContext(location, rawCommand);
        return;
      case "/new": {
        const context = this.stateStore.getConversationContext(location);
        if (!context.activeWorkspaceId) {
          await this.showRepositories(location, "Select a repo and branch before creating a new chat.");
          return;
        }
        this.stateStore.setConversationComposeMode(location, "new_session", {
          composeWorkspaceId: context.activeWorkspaceId,
        });
        await this.safeSendMessage(location, "Your next message will create a new chat on the current branch.");
        return;
      }
      case "/new_workspace":
        await this.prepareNewWorkspace(location);
        return;
      case "/help":
        await this.safeSendMessage(location, buildHelpText());
        return;
      default:
        await this.safeSendMessage(location, `Unknown command: ${command}`);
    }
  }

  private async handlePlainText(location: TelegramConversationTarget, text: string): Promise<void> {
    if (isStatusProbeText(text)) {
      await this.showStatus(location);
      return;
    }

    const context = this.stateStore.getConversationContext(location);
    if (
      this.isDedicatedTopicLocation(location) &&
      (context.composeMode === "new_session" || context.composeMode === "new_workspace")
    ) {
      this.stateStore.clearConversationComposeMode(location);
      await this.rejectTopicLockedAction(location);
      return;
    }

    const session = this.resolveSelectedSession(location);

    if (session) {
      const pendingRequest = this.pendingInputRequests.get(session.id);
      if (pendingRequest) {
        await this.answerInputRequest(location, session, pendingRequest, text);
        return;
      }
    }

    if (context.composeMode === "new_session") {
      await this.createNewSession(location, text);
      return;
    }

    if (context.composeMode === "new_workspace") {
      await this.createNewWorkspace(location, text);
      return;
    }

    if (context.composeMode === "plan_feedback") {
      await this.sendSteerFromContext(location, text, "Plan feedback sent.");
      return;
    }

    if (context.composeMode === "reply_required") {
      if (session) {
        const pendingRequest = this.pendingInputRequests.get(session.id);
        if (pendingRequest) {
          await this.answerInputRequest(location, session, pendingRequest, text);
          return;
        }
      }
      this.stateStore.clearConversationComposeMode(location);
      await this.safeSendMessage(location, "There is no pending question right now.");
      return;
    }

    if (!session) {
      if (this.isDedicatedTopicLocation(location)) {
        await this.rejectTopicLockedAction(location);
        return;
      }
      if (context.activeWorkspaceId) {
        await this.showHome(
          location,
          "There is no chat to continue on the current branch. Tap New Chat Here to create one.",
        );
        return;
      }
      await this.showRepositories(location, "Select a repo, branch, and chat first.");
      return;
    }

    if (location.messageThreadId === null) {
      const topicLocation = await this.ensureSessionTopicLocation(location, session);
      if (topicLocation) {
        this.activateSessionLocation(location, session, { follow: false });
      }
    }

    await this.submitPrompt(location, session, text, false);
  }

  private resolveSelectedSession(location: TelegramConversationTarget): ConductorSessionRef | null {
    const context = this.stateStore.getConversationContext(location);
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

    const session = this.registry.getSessionById(workspace.activeSessionId);
    if (!session) {
      return null;
    }

    const dedicatedTopic = this.getKnownSessionTopicLocation(location, session);
    if (
      location.messageThreadId !== null &&
      dedicatedTopic &&
      conversationKey(dedicatedTopic) !== conversationKey(location)
    ) {
      return null;
    }

    this.activateSessionLocation(location, session, {
      follow: !dedicatedTopic || conversationKey(dedicatedTopic) === conversationKey(location),
    });
    return session;
  }

  private async selectRepository(location: TelegramConversationTarget, repositoryId: string): Promise<void> {
    const workspaces = this.registry.listWorkspacesForRepository(repositoryId, config.pageSize);
    if (workspaces.length === 0) {
      await this.safeSendMessage(location, "Repo not found.");
      return;
    }

    await this.showBranches(location, `Switched to repo: ${formatRepositoryLabel(workspaces[0])}`, repositoryId);
  }

  private async selectBranch(
    location: TelegramConversationTarget,
    workspaceId: string,
    options?: { prefix?: string },
  ): Promise<void> {
    const workspace = this.registry.getWorkspaceById(workspaceId);
    if (!workspace) {
      await this.safeSendMessage(location, "Workspace not found.");
      return;
    }

    this.stateStore.setConversationActiveWorkspace(location, workspace.id);
    if (workspace.activeSessionId) {
      const session = this.registry.getSessionById(workspace.activeSessionId);
      const dedicatedTopic = session ? this.getKnownSessionTopicLocation(location, session) : null;
      if (session) {
        this.activateSessionLocation(location, session, {
          follow: !dedicatedTopic || conversationKey(dedicatedTopic) === conversationKey(location),
        });
      } else {
        this.stateStore.updateConversationContext(location, { activeSessionId: null, followSessionId: null });
      }
    } else {
      this.stateStore.updateConversationContext(location, { activeSessionId: null, followSessionId: null });
    }
    this.stateStore.clearConversationComposeMode(location);

    const workspaceName = formatWorkspaceOptionName(workspace);
    const branchName = formatBranchName(workspace);
    const prefix =
      options?.prefix ??
      (workspaceName === branchName
        ? `Switched to branch: ${branchName}`
        : `Switched to branch: ${branchName}\nWorkspace: ${workspaceName}`);

    await this.showChats(location, prefix, workspace.id);
  }

  private async selectChat(location: TelegramConversationTarget, sessionId: string): Promise<void> {
    const session = this.registry.getSessionById(sessionId);
    if (!session) {
      await this.safeSendMessage(location, "Chat not found.");
      return;
    }

    if (
      await this.moveSessionToDedicatedTopicIfNeeded(
        location,
        session,
        `Switched to chat: ${formatSessionTitle(session.title)}`,
      )
    ) {
      return;
    }

    this.activateSessionLocation(location, session);
    await this.showHome(location, `Switched to chat: ${formatSessionTitle(session.title)}`);
  }

  private activateSessionLocation(
    location: TelegramConversationTarget,
    session: ConductorSessionRef,
    options?: { follow?: boolean },
  ): void {
    this.stateStore.updateConversationContext(location, {
      activeWorkspaceId: session.workspaceId,
      activeSessionId: session.id,
      composeMode: "none",
      composeWorkspaceId: null,
      followSessionId: options?.follow === false ? null : session.id,
      composeTargetSessionId: null,
      composeTargetThreadId: null,
      composeTargetTurnId: null,
    });
    this.registry.updateWorkspaceActiveSession(session.workspaceId, session.id);
    if (session.claudeSessionId) {
      this.sessionIdByThreadId.set(session.claudeSessionId, session.id);
    }
  }

  private getKnownSessionTopicLocation(
    location: TelegramConversationTarget,
    session: ConductorSessionRef,
  ): TelegramConversationTarget | null {
    const existingTopic = this.stateStore.getSessionTopic(session.id, location.chatId);
    if (existingTopic) {
      return existingTopic;
    }

    const legacyTopic = this.stateStore.findFollowingTopic(session.id, location.chatId);
    if (!legacyTopic) {
      return null;
    }

    try {
      return this.stateStore.bindSessionTopic(session.id, legacyTopic);
    } catch (error) {
      logger.warn("failed to bootstrap legacy session topic binding", {
        chatId: location.chatId,
        messageThreadId: legacyTopic.messageThreadId,
        sessionId: session.id,
        error: extractErrorMessage(error),
      });
      return legacyTopic.messageThreadId !== null ? legacyTopic : null;
    }
  }

  private async ensureSessionTopicLocation(
    location: TelegramConversationTarget,
    session: ConductorSessionRef,
  ): Promise<TelegramConversationTarget | null> {
    const knownTopic = this.getKnownSessionTopicLocation(location, session);
    if (knownTopic) {
      this.activateSessionLocation(knownTopic, session);
      return knownTopic;
    }

    const topicLocation = await this.createSessionTopic(location, formatSessionTitle(session.title));
    if (!topicLocation) {
      return null;
    }

    try {
      this.stateStore.bindSessionTopic(session.id, topicLocation);
    } catch (error) {
      logger.warn("failed to persist session topic binding", {
        chatId: location.chatId,
        messageThreadId: topicLocation.messageThreadId,
        sessionId: session.id,
        error: extractErrorMessage(error),
      });
    }
    this.activateSessionLocation(topicLocation, session);
    return topicLocation;
  }

  private async moveSessionToDedicatedTopicIfNeeded(
    location: TelegramConversationTarget,
    session: ConductorSessionRef,
    prefix: string,
  ): Promise<boolean> {
    const topicLocation = await this.ensureSessionTopicLocation(location, session);
    if (!topicLocation || conversationKey(topicLocation) === conversationKey(location)) {
      return false;
    }

    if (location.messageThreadId === null) {
      this.activateSessionLocation(location, session, { follow: false });
    }

    await this.safeSendMessage(location, `${prefix}\nContinue in the dedicated Telegram topic.`);
    await this.showHome(topicLocation, prefix);
    return true;
  }

  private async showHome(location: TelegramConversationTarget, prefix?: string): Promise<void> {
    const context = this.stateStore.getConversationContext(location);
    const workspace = context.activeWorkspaceId ? this.registry.getWorkspaceById(context.activeWorkspaceId) : null;
    const session = this.resolveSelectedSession(location);
    const runtime = session ? (this.runtimes.get(session.id) ?? null) : null;
    const dedicatedTopic = session ? this.getKnownSessionTopicLocation(location, session) : null;

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
    if (this.isDedicatedTopicLocation(location)) {
      lines.push("Topic Lock: This topic can only continue its current chat.");
    }
    if (dedicatedTopic && conversationKey(dedicatedTopic) !== conversationKey(location)) {
      lines.push(`Dedicated Topic: ${dedicatedTopic.messageThreadId}`);
    }
    if (location.messageThreadId !== null) {
      lines.push(`Topic: ${location.messageThreadId}`);
    }
    await this.safeSendMessage(
      location,
      lines.join("\n"),
      homeKeyboard({
        showStop: this.canInterruptTurn(runtime),
        topicLocked: this.isDedicatedTopicLocation(location),
      }),
    );
  }

  private async showRepositories(location: TelegramConversationTarget, prefix?: string): Promise<void> {
    const repositories = this.registry.listRepositories(config.pageSize);
    if (repositories.length === 0) {
      await this.safeSendMessage(location, "No repos are available.");
      return;
    }
    const text = [prefix, "Select a repo:"].filter(Boolean).join("\n\n");
    await this.safeSendMessage(location, text, repositoriesKeyboard(repositories));
  }

  private async showBranches(
    location: TelegramConversationTarget,
    prefix?: string,
    repositoryId?: string,
  ): Promise<void> {
    const context = this.stateStore.getConversationContext(location);
    const currentWorkspace = context.activeWorkspaceId
      ? this.registry.getWorkspaceById(context.activeWorkspaceId)
      : null;
    const targetRepositoryId = repositoryId ?? currentWorkspace?.repositoryId ?? null;
    if (!targetRepositoryId) {
      await this.showRepositories(location, prefix ?? "Select a repo first.");
      return;
    }

    const workspaces = this.registry.listWorkspacesForRepository(targetRepositoryId, config.pageSize);
    if (workspaces.length === 0) {
      await this.safeSendMessage(
        location,
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
    await this.safeSendMessage(
      location,
      text,
      branchesKeyboard(workspaces, { newWorkspaceRepositoryId: targetRepositoryId }),
    );
  }

  private async showChats(location: TelegramConversationTarget, prefix?: string, workspaceId?: string): Promise<void> {
    const context = this.stateStore.getConversationContext(location);
    const targetWorkspaceId = workspaceId ?? context.activeWorkspaceId ?? null;
    if (!targetWorkspaceId) {
      await this.showRepositories(location, prefix ?? "Select a repo and branch first.");
      return;
    }

    const workspace = this.registry.getWorkspaceById(targetWorkspaceId);
    if (!workspace) {
      await this.showRepositories(location, prefix ?? "Branch not found.");
      return;
    }

    const sessions = this.registry.listSessions(targetWorkspaceId, config.pageSize);
    if (sessions.length === 0) {
      await this.safeSendMessage(
        location,
        this.isDedicatedTopicLocation(location)
          ? `${prefix ? `${prefix}\n\n` : ""}This topic is locked to its current chat. Use the main chat to create or select another chat.`
          : `${prefix ? `${prefix}\n\n` : ""}There are no chats on the current branch. Tap New Chat Here to create a new Conductor chat.`,
        homeKeyboard({ topicLocked: this.isDedicatedTopicLocation(location) }),
      );
      return;
    }

    const text = formatSessionPickerText(sessions, {
      activeSessionId: context.activeSessionId ?? workspace.activeSessionId,
      heading: "Select a chat:",
      prefix,
    });
    await this.safeSendMessage(location, text, sessionsKeyboard(sessions));
  }

  private async showInbox(location: TelegramConversationTarget): Promise<void> {
    const sessions = this.registry.getInboxSessions(config.pageSize);
    if (sessions.length === 0) {
      await this.safeSendMessage(location, "Inbox is empty.");
      return;
    }
    await this.safeSendMessage(location, "Chats that need your attention:", inboxKeyboard(sessions));
  }

  private async showStatus(location: TelegramConversationTarget): Promise<void> {
    await this.renderSessionPanel(location);
  }

  private async showQueue(location: TelegramConversationTarget): Promise<void> {
    const session = this.resolveSelectedSession(location);
    if (!session) {
      await this.safeSendMessage(location, "Select a chat first.");
      return;
    }
    const runtime = this.runtimes.get(session.id) ?? null;
    const items = this.stateStore.listQueueForSession(session.id, 10);
    if (items.length === 0 && !runtime) {
      await this.safeSendMessage(location, "The current chat has no queue.");
      return;
    }

    const lines: string[] = [];
    if (runtime) {
      lines.push("Current execution:");
      lines.push(
        runtime.activityText
          ? runtime.activityText
          : this.sessionStatusLabel(session, runtime) === "working"
            ? "Working..."
            : this.sessionStatusLabel(session, runtime),
      );
      if (runtime.lastEventAt) {
        lines.push(`Last event: ${formatRuntimeEventAt(runtime.lastEventAt)}`);
      }
      if (runtime.turnId) {
        lines.push(`Turn: ${runtime.turnId}`);
      }
    }

    if (items.length > 0) {
      if (lines.length > 0) {
        lines.push("");
      }
      lines.push("Current queue:");
      for (const item of items.reverse()) {
        lines.push(`${item.status} · ${item.text.slice(0, 80)}`);
      }
    }
    await this.safeSendMessage(location, lines.join("\n"));
  }

  private async showContext(location: TelegramConversationTarget, rawCommand: string): Promise<void> {
    const session = this.resolveSelectedSession(location);
    if (!session) {
      await this.safeSendMessage(location, "Select a chat first.");
      return;
    }

    const limit = this.parseContextLimit(rawCommand);
    if (limit === null) {
      await this.safeSendMessage(location, "Usage: /context or /context 12");
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
      await this.safeSendMessage(location, "There is no visible context for the current chat yet.");
      return;
    }

    const key = conversationKey(location);
    const existing = this.contextViewers.get(key);
    const viewer: ContextViewerState = {
      entryCount: entries.length,
      keyboardFingerprint: existing?.keyboardFingerprint ?? null,
      lastText: existing?.lastText ?? null,
      limit,
      location,
      messageId: existing?.messageId ?? null,
      pageIndex: 0,
      pages: this.splitTextForTelegram(entries.join("\n\n"), 3200),
      sessionId: session.id,
      sessionTitle: formatSessionTitle(session.title),
    };
    viewer.pageIndex = Math.max(0, viewer.pages.length - 1);
    this.contextViewers.set(key, viewer);
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
    location: TelegramConversationTarget,
    session: ConductorSessionRef,
    text: string,
    fromQueue: boolean,
    options?: {
      allowMissingRollout?: boolean;
      suppressSentConfirmation?: boolean;
    },
  ): Promise<PromptSubmitResult> {
    if (session.agentType && session.agentType !== "codex") {
      await this.safeSendMessage(location, "Only Codex sessions are supported right now.");
      return "permanent_failure";
    }
    if (!session.claudeSessionId) {
      await this.safeSendMessage(location, "This chat is missing its underlying thread ID and cannot continue.");
      return "permanent_failure";
    }

    if (!fromQueue && this.shouldQueueSession(session)) {
      this.stateStore.enqueuePrompt(session.id, session.claudeSessionId, "normal", text);
      await this.safeSendMessage(
        location,
        "The current chat is busy. Your message was added to the queue. Use /status or /queue to check progress.",
      );
      return "queued";
    }

    const workspacePath = this.registry.resolveWorkspacePath(session.workspaceId);
    let turnId: string;
    try {
      await this.codex.resumeThread({
        threadId: session.claudeSessionId,
        cwd: workspacePath,
        model: session.model,
        ...(options?.allowMissingRollout ? { allowMissingRollout: true } : {}),
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
        chatId: location.chatId,
        messageThreadId: location.messageThreadId,
        sessionId: session.id,
        threadId: session.claudeSessionId,
        fromQueue,
        error,
      });

      if (errorMessage.includes("no rollout found for thread id")) {
        const context = this.stateStore.getConversationContext(location);
        if (context.activeSessionId === session.id) {
          this.stateStore.setConversationActiveSession(location, null);
        }
        if (this.isDedicatedTopicLocation(location)) {
          await this.safeSendMessage(
            location,
            "This topic is locked to its current chat, but that chat's underlying thread is no longer valid. Use the main chat to select or create another chat.",
          );
          return "permanent_failure";
        }
        await this.showChats(
          location,
          "The underlying thread for this chat is no longer valid. Switch to another chat or tap New Chat Here to create a new one.",
        );
        return "permanent_failure";
      }

      if (!fromQueue) {
        await this.safeSendMessage(location, "Send failed. Please try again later.");
      }
      return "retryable_failure";
    }

    this.sessionIdByThreadId.set(session.claudeSessionId, session.id);
    const existingRuntime = this.runtimes.get(session.id);
    const runtime =
      existingRuntime && existingRuntime.turnId === turnId
        ? {
            ...existingRuntime,
            model: session.model,
            sessionId: session.id,
            threadId: session.claudeSessionId,
            turnId,
          }
        : {
            activityText: null,
            sessionId: session.id,
            threadId: session.claudeSessionId,
            turnId,
            status: "active" as const,
            assistantText: "",
            lastEventAt: null,
            planText: null,
            model: session.model,
          };
    this.runtimes.set(session.id, runtime);

    this.mirror.updateSessionStatus(session.id, "working");
    this.mirror.appendUserMessage({
      sessionId: session.id,
      turnId,
      text,
      sentAt: new Date().toISOString(),
    });
    await this.pushRuntimeUpdate(runtime);
    return "submitted";
  }

  private async createNewSession(location: TelegramConversationTarget, text: string): Promise<void> {
    const context = this.stateStore.getConversationContext(location);
    const workspaceId = context.composeWorkspaceId ?? context.activeWorkspaceId;
    if (!workspaceId) {
      await this.showRepositories(location, "Select a repo and branch first.");
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

      this.sessionIdByThreadId.set(threadId, session.id);
      const topicLocation = await this.ensureSessionTopicLocation(location, session);
      const sessionLocation = topicLocation ?? location;

      if (!topicLocation || conversationKey(topicLocation) === conversationKey(location)) {
        this.activateSessionLocation(location, session);
      } else if (location.messageThreadId === null) {
        this.activateSessionLocation(location, session, { follow: false });
      } else {
        this.stateStore.clearConversationComposeMode(location);
      }

      if (topicLocation && conversationKey(topicLocation) !== conversationKey(location)) {
        this.activateSessionLocation(topicLocation, session);
      }

      if (topicLocation) {
        await this.safeSendMessage(location, `Created chat: ${title}\nContinue in the new Telegram topic.`);
        await this.safeSendMessage(topicLocation, `Created chat: ${title}`);
      } else {
        await this.safeSendMessage(location, `Created chat: ${title}`);
      }

      await this.submitPrompt(sessionLocation, session, text, false, {
        allowMissingRollout: true,
        suppressSentConfirmation: true,
      });
    } catch (error) {
      if (threadId) {
        await this.codex.archiveThread(threadId).catch(() => undefined);
      }
      logger.error("failed to create new session", error);
      await this.safeSendMessage(location, "Failed to create a new chat.");
    }
  }

  private async prepareNewWorkspace(
    location: TelegramConversationTarget,
    repositoryIdFromPicker?: string,
  ): Promise<void> {
    const context = this.stateStore.getConversationContext(location);
    const repositoryId = repositoryIdFromPicker ?? this.resolveWorkspaceCreationRepositoryId(context);
    if (!repositoryId) {
      await this.showRepositories(location, "Select a repo and branch first.");
      return;
    }

    const repository = this.registry.getRepositoryById(repositoryId);
    if (!repository) {
      await this.showRepositories(location, "Repo not found.");
      return;
    }

    this.stateStore.setConversationComposeMode(location, "new_workspace", {
      composeWorkspaceId: repositoryId,
    });

    await this.safeSendMessage(
      location,
      `Send the branch name for the new workspace in ${formatRepositoryLabel(repository)}. It will be created from ${
        repository.defaultBranch?.trim() || "master"
      }.`,
    );
  }

  private resolveWorkspaceCreationRepositoryId(
    context: ReturnType<BridgeStateStore["getConversationContext"]>,
  ): string | null {
    const composeId = context.composeWorkspaceId?.trim();
    if (composeId) {
      const workspace = this.registry.getWorkspaceById(composeId);
      if (workspace) {
        return workspace.repositoryId;
      }
      if (this.registry.getRepositoryById(composeId)) {
        return composeId;
      }
    }

    if (!context.activeWorkspaceId) {
      return null;
    }

    return this.registry.getWorkspaceById(context.activeWorkspaceId)?.repositoryId ?? null;
  }

  private async createNewWorkspace(location: TelegramConversationTarget, text: string): Promise<void> {
    const requestedBranch = text
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean);

    if (!requestedBranch) {
      await this.safeSendMessage(location, "Send a branch name like berlin or feature/demo.");
      return;
    }

    const context = this.stateStore.getConversationContext(location);
    const repositoryId = this.resolveWorkspaceCreationRepositoryId(context);
    if (!repositoryId) {
      this.stateStore.clearConversationComposeMode(location);
      await this.showRepositories(location, "Select a repo and branch first.");
      return;
    }

    const existingWorkspace = this.registry.findWorkspaceByBranch(repositoryId, requestedBranch);
    if (existingWorkspace) {
      this.stateStore.clearConversationComposeMode(location);
      await this.selectBranch(location, existingWorkspace.id, {
        prefix: `Workspace already exists: ${formatBranchName(existingWorkspace)}`,
      });
      return;
    }

    try {
      const workspace = this.registry.createWorkspace(repositoryId, requestedBranch);
      this.stateStore.clearConversationComposeMode(location);
      await this.selectBranch(location, workspace.id, {
        prefix:
          workspace.directoryName === formatBranchName(workspace)
            ? `Created workspace: ${formatBranchName(workspace)}`
            : `Created workspace: ${formatBranchName(workspace)}\nDirectory: ${workspace.directoryName}`,
      });
    } catch (error) {
      const message = extractErrorMessage(error);
      logger.error("failed to create workspace", {
        chatId: location.chatId,
        messageThreadId: location.messageThreadId,
        requestedBranch,
        error,
      });
      await this.safeSendMessage(location, `Failed to create workspace: ${message}`);
    }
  }

  private async sendSteerFromContext(
    location: TelegramConversationTarget,
    text: string,
    successText: string,
  ): Promise<void> {
    const context = this.stateStore.getConversationContext(location);
    if (!context.composeTargetSessionId || !context.composeTargetThreadId || !context.composeTargetTurnId) {
      this.stateStore.clearConversationComposeMode(location);
      await this.safeSendMessage(location, "There is no active turn to revise.");
      return;
    }

    await this.codex.steerTurn({
      threadId: context.composeTargetThreadId,
      expectedTurnId: context.composeTargetTurnId,
      input: text,
    });
    this.stateStore.clearConversationComposeMode(location);
    const runtime = this.runtimes.get(context.composeTargetSessionId);
    if (runtime) {
      runtime.status = "active";
    }
    this.mirror.updateSessionStatus(context.composeTargetSessionId, "working");
    await this.safeSendMessage(location, successText);
  }

  private async preparePlanRevision(location: TelegramConversationTarget): Promise<void> {
    const session = this.resolveSelectedSession(location);
    const runtime = session ? this.runtimes.get(session.id) : null;
    if (!session || !runtime) {
      await this.safeSendMessage(location, "There is no plan to revise right now.");
      return;
    }

    this.stateStore.setConversationComposeMode(location, "plan_feedback", {
      composeTargetSessionId: session.id,
      composeTargetThreadId: runtime.threadId,
      composeTargetTurnId: runtime.turnId,
    });
    await this.safeSendMessage(location, "Send your next message as plan feedback.");
  }

  private async approvePlan(location: TelegramConversationTarget): Promise<void> {
    const session = this.resolveSelectedSession(location);
    if (!session) {
      await this.safeSendMessage(location, "Select a chat first.");
      return;
    }

    const pendingRequest = this.pendingInputRequests.get(session.id);
    if (pendingRequest) {
      const approvalText =
        pendingRequest.questions[0]?.options?.[0]?.label ?? "The plan looks good. Please continue to implementation.";
      await this.answerInputRequest(location, session, pendingRequest, approvalText);
      return;
    }

    const runtime = this.runtimes.get(session.id);
    if (!runtime) {
      await this.safeSendMessage(location, "There is no active plan right now.");
      return;
    }

    await this.codex.steerTurn({
      threadId: runtime.threadId,
      expectedTurnId: runtime.turnId,
      input: "The plan looks good. Please continue to implementation.",
    });
    runtime.status = "active";
    this.mirror.updateSessionStatus(session.id, "working");
    await this.safeSendMessage(location, "Approval sent.");
  }

  private async prepareReply(location: TelegramConversationTarget): Promise<void> {
    const session = this.resolveSelectedSession(location);
    const runtime = session ? this.runtimes.get(session.id) : null;
    const pendingRequest = session ? this.pendingInputRequests.get(session.id) : null;
    if (!session || !runtime || !pendingRequest) {
      await this.safeSendMessage(location, "There is no pending question right now.");
      return;
    }

    this.stateStore.setConversationComposeMode(location, "reply_required", {
      composeTargetSessionId: session.id,
      composeTargetThreadId: runtime.threadId,
      composeTargetTurnId: runtime.turnId,
    });
    await this.safeSendMessage(location, "Send your next message as the reply.");
  }

  private canInterruptTurn(runtime: RuntimeState | null): boolean {
    return Boolean(runtime && !["completed", "failed"].includes(runtime.status));
  }

  private async interruptCurrentTurn(
    location: TelegramConversationTarget,
    options?: { suppressMessage?: boolean },
  ): Promise<string> {
    const session = this.resolveSelectedSession(location);
    if (!session) {
      const text = "Select a chat first.";
      if (!options?.suppressMessage) {
        await this.safeSendMessage(location, text);
      }
      return text;
    }

    const runtime = this.runtimes.get(session.id) ?? null;
    if (!runtime?.turnId) {
      const text =
        session.status === "working" || session.status === "cancelling"
          ? "This chat is busy, but the active turn cannot be interrupted from the bridge right now."
          : "There is no active turn to interrupt.";
      if (!options?.suppressMessage) {
        await this.safeSendMessage(location, text);
      }
      return text;
    }

    if (runtime.status === "cancelling") {
      const text = "Interrupt already requested.";
      if (!options?.suppressMessage) {
        await this.safeSendMessage(location, text);
      }
      return text;
    }

    await this.codex.interruptTurn({
      threadId: runtime.threadId,
      turnId: runtime.turnId,
    });
    runtime.status = "cancelling";
    this.pendingInputRequests.delete(session.id);
    this.stateStore.clearConversationComposeMode(location);
    this.mirror.updateSessionStatus(session.id, "cancelling");
    await this.pushRuntimeUpdate(runtime, "Interrupt requested...");

    const text = "Interrupt requested.";
    if (!options?.suppressMessage) {
      await this.safeSendMessage(location, text);
    }
    return text;
  }

  private isDedicatedTopicLocation(location: TelegramConversationTarget): boolean {
    return location.messageThreadId !== null;
  }

  private isTopicLockedCommand(command: string): boolean {
    return ["/repos", "/workspaces", "/branches", "/chats", "/sessions", "/new", "/new_workspace"].includes(command);
  }

  private isTopicLockedCallback(data: string): boolean {
    return (
      data === "home:workspaces" ||
      data === "home:repos" ||
      data === "home:branches" ||
      data === "home:sessions" ||
      data === "home:chats" ||
      data === "home:new" ||
      data === "home:new-workspace" ||
      data === "home:inbox" ||
      data.startsWith("repo:") ||
      data.startsWith("repo-new:") ||
      data.startsWith("branch:") ||
      data.startsWith("workspace:") ||
      data.startsWith("session:")
    );
  }

  private async rejectTopicLockedAction(location: TelegramConversationTarget, callbackId?: string): Promise<void> {
    if (callbackId) {
      await this.telegram.answerCallbackQuery(callbackId, TOPIC_LOCKED_CALLBACK_TEXT);
      return;
    }
    await this.safeSendMessage(location, TOPIC_LOCKED_MESSAGE);
  }

  private enqueueConversationTask(location: TelegramConversationTarget, task: () => Promise<void>): void {
    const queued = this.interactionQueue.run(conversationKey(location), task).catch(async (error) => {
      logger.error("failed to handle conversation task", {
        chatId: location.chatId,
        messageThreadId: location.messageThreadId,
        error,
      });
      await this.safeSendMessage(location, "Failed to process that message. Please try again.").catch(() => undefined);
    });

    this.trackBackgroundTask(queued);
  }

  private requestQueueDrain(sessionId: string): void {
    const queued = this.queueDrainQueue.run(sessionId, async () => {
      await this.drainQueueForSession(sessionId);
    });

    this.trackBackgroundTask(queued);
  }

  private trackBackgroundTask(task: Promise<void>): void {
    this.backgroundTasks.add(task);
    void task.finally(() => {
      this.backgroundTasks.delete(task);
    });
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
    location: TelegramConversationTarget,
    session: ConductorSessionRef,
    request: PendingInputRequest,
    text: string,
  ): Promise<void> {
    const answers = this.buildInputAnswers(request.questions, text);
    await this.codex.respond(request.requestId, { answers });
    this.pendingInputRequests.delete(session.id);
    this.stateStore.clearConversationComposeMode(location);
    const runtime = this.runtimes.get(session.id);
    if (runtime) {
      runtime.status = "active";
    }
    this.mirror.updateSessionStatus(session.id, "working");
    await this.safeSendMessage(location, "Reply sent.");
  }

  private async handleCodexServerRequest(request: CodexServerRequest): Promise<void> {
    if (request.method !== "item/tool/requestUserInput") {
      logger.info("ignoring unsupported server request", { method: request.method });
      await this.codex.respondError(request.id, {
        code: -32601,
        message: `Unsupported server request: ${request.method}`,
      });
      return;
    }

    const threadId = asString(request.params.threadId);
    const turnId = asString(request.params.turnId);
    const itemId = asString(request.params.itemId);
    const rawQuestions = Array.isArray(request.params.questions) ? request.params.questions : [];
    if (!threadId || !turnId || !itemId) {
      await this.codex.respondError(request.id, {
        code: -32602,
        message: "requestUserInput is missing threadId, turnId, or itemId",
      });
      return;
    }

    const sessionId = this.resolveSessionIdByThreadId(threadId);
    if (!sessionId) {
      await this.codex.respondError(request.id, {
        code: -32001,
        message: `Unable to resolve a session for thread ${threadId}`,
      });
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

    if (questions.length === 0) {
      const fallbackQuestion = asString(request.params.question);
      if (fallbackQuestion) {
        questions.push({
          id: itemId,
          header: "Reply",
          question: fallbackQuestion,
          options: null,
        });
      }
    }

    if (questions.length === 0) {
      await this.codex.respondError(request.id, {
        code: -32602,
        message: "requestUserInput did not include any usable questions",
      });
      return;
    }

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
    this.recordRuntimeEvent(runtime, null);
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
      case "item/started":
        await this.onItemStarted(notification.params);
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
    this.recordRuntimeEvent(runtime, "Turn started. Waiting for the first update...");
    this.mirror.updateSessionStatus(sessionId, "working");
    await this.pushRuntimeUpdate(runtime);
  }

  private async onItemStarted(params: Record<string, unknown>): Promise<void> {
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
    runtime.status = "active";
    this.recordRuntimeEvent(runtime, describeRuntimeActivity(item, "started"));
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
    this.recordRuntimeEvent(runtime, "Composing reply...");
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
      this.recordRuntimeEvent(runtime, null);
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
        this.recordRuntimeEvent(runtime, "Plan ready for review.");
        await this.pushRuntimeUpdate(runtime, text, planKeyboard());
      }
      return;
    }

    this.recordRuntimeEvent(runtime, describeRuntimeActivity(item, "completed"));
    await this.pushRuntimeUpdate(runtime);
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
    this.recordRuntimeEvent(runtime, null);
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
        this.recordRuntimeEvent(runtime, "Resumed after your reply.");
        await this.pushRuntimeUpdate(runtime);
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
      this.recordRuntimeEvent(runtime, null);
      if (!runtime.assistantText) {
        runtime.assistantText = extractHumanText(error) || "Execution failed.";
      }
      this.mirror.updateSessionStatus(sessionId, "error");
      await this.pushRuntimeUpdate(runtime);
    } else {
      runtime.status = "completed";
      this.recordRuntimeEvent(runtime, null);
      this.mirror.updateSessionStatus(sessionId, "idle");
      await this.pushRuntimeUpdate(runtime);
    }

    this.pendingInputRequests.delete(sessionId);
    this.runtimes.delete(sessionId);
    this.requestQueueDrain(sessionId);
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
      this.recordRuntimeEvent(runtime, null);
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
      activityText: existing?.activityText ?? null,
      sessionId,
      threadId,
      turnId,
      status: "active",
      assistantText: existing?.assistantText ?? "",
      lastEventAt: existing?.lastEventAt ?? null,
      planText: existing?.planText ?? null,
      model,
    };
    this.runtimes.set(sessionId, runtime);
    return runtime;
  }

  private recordRuntimeEvent(runtime: RuntimeState, activityText?: string | null): void {
    runtime.lastEventAt = new Date().toISOString();
    if (activityText !== undefined) {
      runtime.activityText = activityText;
    }
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
      case "cancelling":
        return "cancelling";
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

  private resolveRuntimeBody(
    runtime: RuntimeState,
    bodyOverride: string | undefined,
    activePlaceholder: string | null,
  ): string | null {
    const activityBlock = this.resolveRuntimeActivityBlock(runtime);
    if (bodyOverride !== undefined) {
      if (!activityBlock) {
        return bodyOverride;
      }
      return bodyOverride ? `${activityBlock}\n\n${bodyOverride}` : activityBlock;
    }
    if (runtime.planText) {
      return activityBlock ? `${activityBlock}\n\n${runtime.planText}` : runtime.planText;
    }
    if (runtime.assistantText) {
      if (!activityBlock) {
        return runtime.assistantText;
      }
      return `${activityBlock}\n\nLatest assistant text:\n${runtime.assistantText}`;
    }
    if (runtime.status === "waiting_user_input") {
      return "Waiting for your reply.";
    }
    if (runtime.status === "waiting_plan") {
      return "Waiting for your plan approval.";
    }
    if (runtime.status === "cancelling") {
      return activityBlock ? `${activityBlock}\n\nInterrupt requested...` : "Interrupt requested...";
    }
    if (activityBlock) {
      return activityBlock;
    }
    return activePlaceholder;
  }

  private resolveRuntimeActivityBlock(runtime: RuntimeState): string | null {
    if (!runtime.activityText) {
      return null;
    }

    const lines = [`Current activity: ${runtime.activityText}`];
    const lastEventAt = formatRuntimeEventAt(runtime.lastEventAt);
    if (lastEventAt) {
      lines.push(`Last event: ${lastEventAt}`);
    }
    return lines.join("\n");
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
    const panelBody = this.resolveRuntimeBody(runtime, bodyOverride, "Working...");
    const streamBody = this.resolveRuntimeBody(runtime, bodyOverride, null);

    const markup =
      keyboard ??
      (runtime.status === "waiting_plan"
        ? planKeyboard()
        : runtime.status === "waiting_user_input"
          ? replyKeyboard()
          : undefined);
    const _workspace = workspace;
    const locations = this.stateStore.listFollowingConversations(runtime.sessionId);
    for (const location of locations) {
      if (location.messageThreadId !== null) {
        if (!streamBody) {
          continue;
        }
        await this.upsertSessionStream(location, runtime, streamBody, markup);
        continue;
      }
      await this.renderSessionPanel(location, {
        runtime,
        session,
        workspace: _workspace,
        ...(panelBody !== null ? { bodyOverride: panelBody } : {}),
        ...(markup ? { keyboard: markup } : {}),
      });
    }
  }

  private async drainQueues(): Promise<void> {
    for (const sessionId of this.stateStore.listQueuedSessionIds()) {
      this.requestQueueDrain(sessionId);
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

    const location = this.stateStore.listFollowingConversations(sessionId)[0];
    if (!location) {
      return;
    }

    this.stateStore.markPromptStarted(next.id);
    try {
      const result = await this.submitPrompt(location, session, next.text, true);
      const status = queueDrainStatus(result);
      if (status === "finished") {
        this.stateStore.markPromptFinished(next.id, "finished");
      } else if (status === "retry") {
        this.stateStore.retryPrompt(next.id);
      } else {
        this.stateStore.markPromptFinished(next.id, "failed");
      }
    } catch (error) {
      logger.error("queued prompt failed", error);
      this.stateStore.markPromptFinished(next.id, "failed");
    }
  }

  private async safeSendMessage(
    target: number | TelegramConversationTarget,
    text: string,
    keyboard?: TelegramInlineKeyboard,
  ): Promise<void> {
    const location = typeof target === "number" ? { chatId: target, messageThreadId: null } : target;
    await this.telegram.sendMessage(location.chatId, truncate(text, 3800), {
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
      ...(location.messageThreadId !== null ? { message_thread_id: location.messageThreadId } : {}),
    });
  }

  private async createSessionTopic(
    location: TelegramConversationTarget,
    title: string,
  ): Promise<TelegramConversationTarget | null> {
    try {
      const topic = await this.telegram.createForumTopic(location.chatId, title.slice(0, 128));
      const messageThreadId =
        typeof topic?.message_thread_id === "number" && Number.isInteger(topic.message_thread_id)
          ? topic.message_thread_id
          : null;
      if (!messageThreadId || messageThreadId <= 0) {
        logger.warn("telegram createForumTopic returned an invalid message_thread_id", {
          chatId: location.chatId,
          title,
          topic,
        });
        return null;
      }
      return {
        chatId: location.chatId,
        messageThreadId,
      };
    } catch (error) {
      logger.warn("failed to create telegram forum topic; continuing in the current conversation", {
        chatId: location.chatId,
        messageThreadId: location.messageThreadId,
        error: extractErrorMessage(error),
      });
      return null;
    }
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
    location: TelegramConversationTarget,
    data: string,
  ): Promise<void> {
    const panel = this.sessionPanels.get(conversationKey(location));
    const messageId = callback.message?.message_id;
    if (!messageId || !panel || panel.messageId !== messageId) {
      await this.telegram.answerCallbackQuery(callback.id, "That status panel is no longer active.");
      return;
    }

    switch (data) {
      case "panel:refresh":
        await this.telegram.answerCallbackQuery(callback.id, "Refreshing...");
        this.enqueueConversationTask(location, async () => {
          await this.renderSessionPanel(location);
        });
        return;
      case "panel:interrupt": {
        await this.telegram.answerCallbackQuery(callback.id, "Stopping...");
        this.enqueueConversationTask(location, async () => {
          const text = await this.interruptCurrentTurn(location, { suppressMessage: true });
          if (text !== "Interrupt requested.") {
            await this.safeSendMessage(location, text);
          }
        });
        return;
      }
      case "panel:close":
        await this.telegram.answerCallbackQuery(callback.id);
        this.enqueueConversationTask(location, async () => {
          await this.closeSessionPanel(location);
        });
        return;
      default:
        await this.telegram.answerCallbackQuery(callback.id, "Not implemented yet");
    }
  }

  private async renderSessionPanel(
    location: TelegramConversationTarget,
    options?: {
      bodyOverride?: string;
      keyboard?: TelegramInlineKeyboard;
      runtime?: RuntimeState | null;
      session?: ConductorSessionRef | null;
      workspace?: WorkspaceRef | null;
    },
  ): Promise<void> {
    const context = this.stateStore.getConversationContext(location);
    const workspace =
      options?.workspace ??
      (context.activeWorkspaceId ? this.registry.getWorkspaceById(context.activeWorkspaceId) : null);
    const session = options?.session ?? this.resolveSelectedSession(location);
    const runtime = options?.runtime ?? (session ? (this.runtimes.get(session.id) ?? null) : null);
    const queueCount = session ? this.stateStore.countQueuedPrompts(session.id) : 0;
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
    if (runtime?.activityText) {
      lines.push(`Activity: ${truncate(runtime.activityText, 120)}`);
    }
    if (runtime?.lastEventAt) {
      lines.push(`Last Event: ${formatRuntimeEventAt(runtime.lastEventAt)}`);
    }
    if (location.messageThreadId !== null) {
      lines.push(`Topic: ${location.messageThreadId}`);
    }
    const text = truncate(`${lines.join("\n")}\n\n${body}`, 3800);
    const keyboard = this.sessionPanelKeyboard(options?.keyboard, this.canInterruptTurn(runtime));
    await this.upsertSessionPanel(location, session?.id ?? null, text, keyboard);
  }

  private async upsertSessionStream(
    location: TelegramConversationTarget,
    runtime: RuntimeState,
    text: string,
    keyboard?: TelegramInlineKeyboard,
  ): Promise<void> {
    const key = conversationKey(location);
    const nextText = truncate(text, 3800);
    const keyboardFingerprint = keyboard ? JSON.stringify(keyboard) : null;
    await this.sessionStreamQueue.run(key, async () => {
      const now = Date.now();
      const existing = this.sessionStreams.get(key);

      if (
        existing &&
        existing.messageId &&
        existing.sessionId === runtime.sessionId &&
        existing.turnId === runtime.turnId &&
        existing.lastText === nextText &&
        existing.keyboardFingerprint === keyboardFingerprint
      ) {
        return;
      }

      if (
        existing &&
        existing.messageId &&
        existing.sessionId === runtime.sessionId &&
        existing.turnId === runtime.turnId &&
        runtime.status === "active" &&
        existing.keyboardFingerprint === keyboardFingerprint &&
        now - existing.lastSentAt < STREAM_EDIT_INTERVAL_MS &&
        nextText.length - existing.lastText.length < STREAM_EAGER_EDIT_CHARS
      ) {
        return;
      }

      if (existing?.messageId && existing.sessionId === runtime.sessionId && existing.turnId === runtime.turnId) {
        const persistExistingMessage = () => {
          this.sessionStreams.set(key, {
            keyboardFingerprint,
            lastSentAt: now,
            lastText: nextText,
            messageId: existing.messageId,
            sessionId: runtime.sessionId,
            turnId: runtime.turnId,
          });
        };

        try {
          await this.telegram.editMessageText(location.chatId, existing.messageId, nextText, keyboard);
          persistExistingMessage();
          return;
        } catch (error) {
          if (isTelegramMessageNotModifiedError(error)) {
            persistExistingMessage();
            return;
          }
          const details = summarizeTelegramError(error);

          logger.warn("failed to edit session stream", {
            chatId: location.chatId,
            messageId: existing.messageId,
            messageThreadId: location.messageThreadId,
            sessionId: runtime.sessionId,
            turnId: runtime.turnId,
            error: details,
          });

          if (runtime.status === "active" || isTransientTelegramError(error)) {
            return;
          }

          await sleep(250);
          try {
            await this.telegram.editMessageText(location.chatId, existing.messageId, nextText, keyboard);
            persistExistingMessage();
            return;
          } catch (retryError) {
            logger.warn("failed to retry session stream edit", {
              chatId: location.chatId,
              messageId: existing.messageId,
              messageThreadId: location.messageThreadId,
              sessionId: runtime.sessionId,
              turnId: runtime.turnId,
              error: summarizeTelegramError(retryError),
            });
          }

          try {
            await this.telegram.deleteMessage(location.chatId, existing.messageId);
          } catch (deleteError) {
            logger.warn("failed to delete stale session stream", {
              chatId: location.chatId,
              messageId: existing.messageId,
              messageThreadId: location.messageThreadId,
              sessionId: runtime.sessionId,
              turnId: runtime.turnId,
              error: summarizeTelegramError(deleteError),
            });
          }
        }
      }

      const messageId = await this.telegram.sendMessage(location.chatId, nextText, {
        ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
        ...(location.messageThreadId !== null ? { message_thread_id: location.messageThreadId } : {}),
      });
      this.sessionStreams.set(key, {
        keyboardFingerprint,
        lastSentAt: now,
        lastText: nextText,
        messageId,
        sessionId: runtime.sessionId,
        turnId: runtime.turnId,
      });
    });
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
            : runtime.status === "cancelling"
              ? "Interrupt requested..."
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

  private sessionPanelKeyboard(extraKeyboard?: TelegramInlineKeyboard, showInterrupt = false): TelegramInlineKeyboard {
    const keyboard = extraKeyboard ? extraKeyboard.map((row) => [...row]) : [];
    if (showInterrupt) {
      keyboard.push([{ text: "Stop Current Turn", callback_data: "panel:interrupt" }]);
    }
    keyboard.push([
      { text: "Refresh Status", callback_data: "panel:refresh" },
      { text: "Hide Panel", callback_data: "panel:close" },
    ]);
    return keyboard;
  }

  private async upsertSessionPanel(
    location: TelegramConversationTarget,
    sessionId: string | null,
    text: string,
    keyboard: TelegramInlineKeyboard,
  ): Promise<void> {
    const key = conversationKey(location);
    await this.sessionPanelQueue.run(key, async () => {
      const now = Date.now();
      const keyboardFingerprint = JSON.stringify(keyboard);
      const existing = this.sessionPanels.get(key);
      if (
        existing &&
        existing.messageId &&
        existing.sessionId === sessionId &&
        existing.lastText === text &&
        existing.keyboardFingerprint === keyboardFingerprint
      ) {
        return;
      }

      if (
        existing &&
        existing.messageId &&
        existing.sessionId === sessionId &&
        now - existing.lastSentAt < PANEL_EDIT_INTERVAL_MS &&
        existing.keyboardFingerprint === keyboardFingerprint &&
        text.length - existing.lastText.length < PANEL_EAGER_EDIT_CHARS
      ) {
        return;
      }

      if (existing?.messageId) {
        try {
          await this.telegram.editMessageText(location.chatId, existing.messageId, text, keyboard);
          this.sessionPanels.set(key, {
            keyboardFingerprint,
            lastText: text,
            lastSentAt: now,
            messageId: existing.messageId,
            sessionId,
          });
          return;
        } catch (error) {
          if (isTelegramMessageNotModifiedError(error)) {
            this.sessionPanels.set(key, {
              keyboardFingerprint,
              lastText: text,
              lastSentAt: now,
              messageId: existing.messageId,
              sessionId,
            });
            return;
          }
          logger.warn("failed to edit session panel, sending new message", error);
        }
      }

      const messageId = await this.telegram.sendMessage(location.chatId, text, {
        reply_markup: { inline_keyboard: keyboard },
        ...(location.messageThreadId !== null ? { message_thread_id: location.messageThreadId } : {}),
      });
      this.sessionPanels.set(key, {
        keyboardFingerprint,
        lastText: text,
        lastSentAt: now,
        messageId,
        sessionId,
      });
    });
  }

  private async closeSessionPanel(location: TelegramConversationTarget): Promise<void> {
    const key = conversationKey(location);
    const panel = this.sessionPanels.get(key);
    if (!panel) {
      return;
    }
    this.sessionPanels.delete(key);
    if (!panel.messageId) {
      return;
    }

    try {
      await this.telegram.deleteMessage(location.chatId, panel.messageId);
    } catch (error) {
      logger.warn("failed to delete session panel", error);
      try {
        await this.telegram.editMessageText(location.chatId, panel.messageId, "Status panel hidden.");
      } catch (editError) {
        logger.warn("failed to mark session panel as hidden", editError);
      }
    }
  }

  private async handleContextViewerCallback(
    callback: TelegramCallbackQuery,
    location: TelegramConversationTarget,
    data: string,
  ): Promise<void> {
    const messageId = callback.message?.message_id;
    const viewer = this.contextViewers.get(conversationKey(location));

    if (!messageId || !viewer || viewer.messageId !== messageId) {
      await this.telegram.answerCallbackQuery(callback.id, "That context preview is no longer active.");
      return;
    }

    switch (data) {
      case "context:older":
        if (viewer.pageIndex <= 0) {
          await this.telegram.answerCallbackQuery(callback.id, "Already at the oldest page.");
          return;
        }
        viewer.pageIndex -= 1;
        await this.telegram.answerCallbackQuery(callback.id);
        break;
      case "context:newer":
        if (viewer.pageIndex >= viewer.pages.length - 1) {
          await this.telegram.answerCallbackQuery(callback.id, "Already at the newest page.");
          return;
        }
        viewer.pageIndex += 1;
        await this.telegram.answerCallbackQuery(callback.id);
        break;
      case "context:refresh":
        await this.telegram.answerCallbackQuery(callback.id, "Refreshing...");
        break;
      case "context:close":
        await this.telegram.answerCallbackQuery(callback.id);
        this.enqueueConversationTask(location, async () => {
          await this.closeContextViewer(viewer);
        });
        return;
      default:
        await this.telegram.answerCallbackQuery(callback.id, "Not implemented yet");
        return;
    }

    this.enqueueConversationTask(location, async () => {
      if (data === "context:refresh") {
        const notice = await this.refreshContextViewer(viewer);
        await this.renderContextViewer(viewer);
        if (notice && notice !== "Refreshed.") {
          await this.safeSendMessage(location, notice);
        }
        return;
      }

      await this.renderContextViewer(viewer);
    });
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
    const keyboardFingerprint = JSON.stringify(keyboard);

    if (viewer.messageId && viewer.lastText === text && viewer.keyboardFingerprint === keyboardFingerprint) {
      return;
    }

    if (viewer.messageId) {
      try {
        await this.telegram.editMessageText(viewer.location.chatId, viewer.messageId, text, keyboard);
        viewer.lastText = text;
        viewer.keyboardFingerprint = keyboardFingerprint;
        return;
      } catch (error) {
        if (isTelegramMessageNotModifiedError(error)) {
          viewer.lastText = text;
          viewer.keyboardFingerprint = keyboardFingerprint;
          return;
        }
        logger.warn("failed to edit context viewer, sending new message", error);
        viewer.messageId = null;
      }
    }

    const messageId = await this.telegram.sendMessage(viewer.location.chatId, text, {
      reply_markup: { inline_keyboard: keyboard },
      ...(viewer.location.messageThreadId !== null ? { message_thread_id: viewer.location.messageThreadId } : {}),
    });
    viewer.messageId = messageId;
    viewer.lastText = text;
    viewer.keyboardFingerprint = keyboardFingerprint;
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
    this.contextViewers.delete(conversationKey(viewer.location));
    if (!viewer.messageId) {
      return;
    }

    try {
      await this.telegram.deleteMessage(viewer.location.chatId, viewer.messageId);
    } catch (error) {
      logger.warn("failed to delete context viewer", error);
      try {
        await this.telegram.editMessageText(viewer.location.chatId, viewer.messageId, "Context preview closed.");
      } catch (editError) {
        logger.warn("failed to mark context viewer as closed", editError);
      }
    }
  }
}

export async function runBridge(): Promise<void> {
  const bridge = new TelegramConductorBridge();
  await bridge.start();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runBridge().catch((error) => {
    logger.error("bridge crashed", error);
    process.exitCode = 1;
  });
}
