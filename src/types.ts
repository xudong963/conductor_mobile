export type ComposeMode = "none" | "new_session" | "plan_feedback" | "reply_required";

export type QueueKind = "normal" | "new_session";

export type SessionStatus = "idle" | "working" | "needs_user_input" | "needs_plan_response" | "error" | "cancelling";

export interface RepositoryRef {
  id: string;
  repositoryName: string;
  rootPath: string;
  updatedAt: string;
}

export interface WorkspaceRef {
  id: string;
  directoryName: string;
  branch: string | null;
  prTitle?: string | null;
  repositoryId: string;
  activeSessionId: string | null;
  updatedAt: string;
  rootPath: string;
  repositoryName: string;
}

export interface ConductorSessionRef {
  id: string;
  workspaceId: string;
  status: SessionStatus;
  agentType: string | null;
  model: string | null;
  permissionMode: string | null;
  title: string | null;
  claudeSessionId: string | null;
  updatedAt: string;
  lastUserMessageAt: string | null;
}

export interface SessionMessageRecord {
  role: "user" | "assistant";
  content: string;
  sentAt: string | null;
  turnId: string | null;
  model: string | null;
}

export interface ChatContext {
  chatId: number;
  activeWorkspaceId: string | null;
  activeSessionId: string | null;
  composeMode: ComposeMode;
  composeWorkspaceId: string | null;
  followSessionId: string | null;
  composeTargetSessionId: string | null;
  composeTargetThreadId: string | null;
  composeTargetTurnId: string | null;
  updatedAt: string;
}

export interface QueueItem {
  id: number;
  conductorSessionId: string;
  codexThreadId: string;
  kind: QueueKind;
  text: string;
  status: "queued" | "started" | "finished" | "failed" | "cancelled";
  enqueuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface SessionOffset {
  chatId: number;
  conductorSessionId: string;
  codexThreadId: string;
  fileOffset: number;
  lastTurnId: string | null;
  lastEventTs: string | null;
}

export interface SessionSeed {
  model: string;
  permissionMode: string;
  title: string;
}

export interface SessionDefaults {
  model: string;
  permissionMode: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramInlineKeyboardButton {
  text: string;
  callback_data: string;
}

export type TelegramInlineKeyboard = TelegramInlineKeyboardButton[][];

export interface TelegramSendMessageOptions {
  reply_markup?: {
    inline_keyboard: TelegramInlineKeyboard;
  };
  disable_web_page_preview?: boolean;
}

export interface TelegramBotCommand {
  command: string;
  description: string;
}

export interface CodexNotification {
  method: string;
  params: Record<string, unknown>;
}

export interface TurnRuntime {
  sessionId: string;
  threadId: string;
  turnId: string;
  status: "active" | "waiting_user_input" | "waiting_plan" | "completed" | "failed";
  assistantText: string;
  planText: string | null;
}
