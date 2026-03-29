import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import crypto from "node:crypto";

import type {
  ChatContext,
  ComposeMode,
  QueueItem,
  QueueKind,
  TelegramConversationContext,
  TelegramConversationTarget,
} from "../types.js";

export class BridgeStateStore {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
  }

  init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_context (
        chat_id INTEGER PRIMARY KEY,
        active_workspace_id TEXT,
        active_session_id TEXT,
        compose_mode TEXT NOT NULL DEFAULT 'none',
        compose_workspace_id TEXT,
        follow_session_id TEXT,
        compose_target_session_id TEXT,
        compose_target_thread_id TEXT,
        compose_target_turn_id TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS prompt_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conductor_session_id TEXT NOT NULL,
        codex_thread_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        enqueued_at TEXT NOT NULL DEFAULT (datetime('now')),
        started_at TEXT,
        finished_at TEXT
      );

      CREATE TABLE IF NOT EXISTS session_offsets (
        chat_id INTEGER NOT NULL,
        conductor_session_id TEXT NOT NULL,
        codex_thread_id TEXT NOT NULL,
        file_offset INTEGER NOT NULL DEFAULT 0,
        last_turn_id TEXT,
        last_event_ts TEXT,
        PRIMARY KEY (chat_id, conductor_session_id)
      );

      CREATE TABLE IF NOT EXISTS message_fingerprints (
        fingerprint TEXT PRIMARY KEY,
        conductor_session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS telegram_cursor (
        singleton_key TEXT PRIMARY KEY,
        last_update_id INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conversation_context (
        location_key TEXT PRIMARY KEY,
        chat_id INTEGER NOT NULL,
        message_thread_id INTEGER NOT NULL DEFAULT 0,
        active_workspace_id TEXT,
        active_session_id TEXT,
        compose_mode TEXT NOT NULL DEFAULT 'none',
        compose_workspace_id TEXT,
        follow_session_id TEXT,
        compose_target_session_id TEXT,
        compose_target_thread_id TEXT,
        compose_target_turn_id TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS conversation_context_follow_session_idx
      ON conversation_context (follow_session_id);

      CREATE TABLE IF NOT EXISTS session_topic_binding (
        session_id TEXT NOT NULL,
        chat_id INTEGER NOT NULL,
        message_thread_id INTEGER NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (session_id, chat_id),
        UNIQUE (chat_id, message_thread_id)
      );
    `);

    this.db.exec(`
      INSERT OR IGNORE INTO conversation_context (
        location_key,
        chat_id,
        message_thread_id,
        active_workspace_id,
        active_session_id,
        compose_mode,
        compose_workspace_id,
        follow_session_id,
        compose_target_session_id,
        compose_target_thread_id,
        compose_target_turn_id,
        updated_at
      )
      SELECT
        CAST(chat_id AS TEXT) || ':0',
        chat_id,
        0,
        active_workspace_id,
        active_session_id,
        compose_mode,
        compose_workspace_id,
        follow_session_id,
        compose_target_session_id,
        compose_target_thread_id,
        compose_target_turn_id,
        updated_at
      FROM chat_context
    `);
  }

  getChatContext(chatId: number): ChatContext {
    const row = this.db
      .prepare(
        `
          SELECT
            chat_id as chatId,
            active_workspace_id as activeWorkspaceId,
            active_session_id as activeSessionId,
            compose_mode as composeMode,
            compose_workspace_id as composeWorkspaceId,
            follow_session_id as followSessionId,
            compose_target_session_id as composeTargetSessionId,
            compose_target_thread_id as composeTargetThreadId,
            compose_target_turn_id as composeTargetTurnId,
            updated_at as updatedAt
          FROM chat_context
          WHERE chat_id = ?
        `,
      )
      .get(chatId) as ChatContext | undefined;

    if (row) {
      return row;
    }

    this.db
      .prepare(
        `
          INSERT INTO chat_context (chat_id, compose_mode)
          VALUES (?, 'none')
        `,
      )
      .run(chatId);
    return this.getChatContext(chatId);
  }

  updateChatContext(chatId: number, patch: Partial<Omit<ChatContext, "chatId" | "updatedAt">>): ChatContext {
    const current = this.getChatContext(chatId);
    const merged: ChatContext = {
      ...current,
      ...patch,
      chatId,
      updatedAt: new Date().toISOString(),
    };

    this.db
      .prepare(
        `
          INSERT INTO chat_context (
            chat_id,
            active_workspace_id,
            active_session_id,
            compose_mode,
            compose_workspace_id,
            follow_session_id,
            compose_target_session_id,
            compose_target_thread_id,
            compose_target_turn_id,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(chat_id) DO UPDATE SET
            active_workspace_id = excluded.active_workspace_id,
            active_session_id = excluded.active_session_id,
            compose_mode = excluded.compose_mode,
            compose_workspace_id = excluded.compose_workspace_id,
            follow_session_id = excluded.follow_session_id,
            compose_target_session_id = excluded.compose_target_session_id,
            compose_target_thread_id = excluded.compose_target_thread_id,
            compose_target_turn_id = excluded.compose_target_turn_id,
            updated_at = excluded.updated_at
        `,
      )
      .run(
        merged.chatId,
        merged.activeWorkspaceId,
        merged.activeSessionId,
        merged.composeMode,
        merged.composeWorkspaceId,
        merged.followSessionId,
        merged.composeTargetSessionId,
        merged.composeTargetThreadId,
        merged.composeTargetTurnId,
        merged.updatedAt,
      );

    return this.getChatContext(chatId);
  }

  setActiveWorkspace(chatId: number, workspaceId: string | null): ChatContext {
    return this.updateChatContext(chatId, { activeWorkspaceId: workspaceId });
  }

  setActiveSession(chatId: number, sessionId: string | null): ChatContext {
    return this.updateChatContext(chatId, { activeSessionId: sessionId, followSessionId: sessionId });
  }

  setComposeMode(
    chatId: number,
    composeMode: ComposeMode,
    options?: {
      composeWorkspaceId?: string | null;
      composeTargetSessionId?: string | null;
      composeTargetThreadId?: string | null;
      composeTargetTurnId?: string | null;
    },
  ): ChatContext {
    return this.updateChatContext(chatId, {
      composeMode,
      composeWorkspaceId: options?.composeWorkspaceId ?? null,
      composeTargetSessionId: options?.composeTargetSessionId ?? null,
      composeTargetThreadId: options?.composeTargetThreadId ?? null,
      composeTargetTurnId: options?.composeTargetTurnId ?? null,
    });
  }

  clearComposeMode(chatId: number): ChatContext {
    return this.updateChatContext(chatId, {
      composeMode: "none",
      composeWorkspaceId: null,
      composeTargetSessionId: null,
      composeTargetThreadId: null,
      composeTargetTurnId: null,
    });
  }

  getConversationContext(target: TelegramConversationTarget): TelegramConversationContext {
    const messageThreadId = this.normalizeMessageThreadId(target.messageThreadId);
    const row = this.db
      .prepare(
        `
          SELECT
            chat_id as chatId,
            NULLIF(message_thread_id, 0) as messageThreadId,
            active_workspace_id as activeWorkspaceId,
            active_session_id as activeSessionId,
            compose_mode as composeMode,
            compose_workspace_id as composeWorkspaceId,
            follow_session_id as followSessionId,
            compose_target_session_id as composeTargetSessionId,
            compose_target_thread_id as composeTargetThreadId,
            compose_target_turn_id as composeTargetTurnId,
            updated_at as updatedAt
          FROM conversation_context
          WHERE location_key = ?
        `,
      )
      .get(this.conversationKey(target.chatId, messageThreadId)) as TelegramConversationContext | undefined;

    if (row) {
      return row;
    }

    this.db
      .prepare(
        `
          INSERT INTO conversation_context (
            location_key,
            chat_id,
            message_thread_id,
            compose_mode
          )
          VALUES (?, ?, ?, 'none')
        `,
      )
      .run(this.conversationKey(target.chatId, messageThreadId), target.chatId, messageThreadId);

    return this.getConversationContext(target);
  }

  updateConversationContext(
    target: TelegramConversationTarget,
    patch: Partial<Omit<TelegramConversationContext, "chatId" | "messageThreadId" | "updatedAt">>,
  ): TelegramConversationContext {
    const current = this.getConversationContext(target);
    const messageThreadId = this.normalizeMessageThreadId(target.messageThreadId);
    const merged: TelegramConversationContext = {
      ...current,
      ...patch,
      chatId: target.chatId,
      messageThreadId: target.messageThreadId ?? null,
      updatedAt: new Date().toISOString(),
    };

    this.db
      .prepare(
        `
          INSERT INTO conversation_context (
            location_key,
            chat_id,
            message_thread_id,
            active_workspace_id,
            active_session_id,
            compose_mode,
            compose_workspace_id,
            follow_session_id,
            compose_target_session_id,
            compose_target_thread_id,
            compose_target_turn_id,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(location_key) DO UPDATE SET
            active_workspace_id = excluded.active_workspace_id,
            active_session_id = excluded.active_session_id,
            compose_mode = excluded.compose_mode,
            compose_workspace_id = excluded.compose_workspace_id,
            follow_session_id = excluded.follow_session_id,
            compose_target_session_id = excluded.compose_target_session_id,
            compose_target_thread_id = excluded.compose_target_thread_id,
            compose_target_turn_id = excluded.compose_target_turn_id,
            updated_at = excluded.updated_at
        `,
      )
      .run(
        this.conversationKey(target.chatId, messageThreadId),
        merged.chatId,
        messageThreadId,
        merged.activeWorkspaceId,
        merged.activeSessionId,
        merged.composeMode,
        merged.composeWorkspaceId,
        merged.followSessionId,
        merged.composeTargetSessionId,
        merged.composeTargetThreadId,
        merged.composeTargetTurnId,
        merged.updatedAt,
      );

    return this.getConversationContext(target);
  }

  setConversationActiveWorkspace(
    target: TelegramConversationTarget,
    workspaceId: string | null,
  ): TelegramConversationContext {
    return this.updateConversationContext(target, { activeWorkspaceId: workspaceId });
  }

  setConversationActiveSession(
    target: TelegramConversationTarget,
    sessionId: string | null,
  ): TelegramConversationContext {
    return this.updateConversationContext(target, {
      activeSessionId: sessionId,
      followSessionId: sessionId,
    });
  }

  setConversationComposeMode(
    target: TelegramConversationTarget,
    composeMode: ComposeMode,
    options?: {
      composeWorkspaceId?: string | null;
      composeTargetSessionId?: string | null;
      composeTargetThreadId?: string | null;
      composeTargetTurnId?: string | null;
    },
  ): TelegramConversationContext {
    return this.updateConversationContext(target, {
      composeMode,
      composeWorkspaceId: options?.composeWorkspaceId ?? null,
      composeTargetSessionId: options?.composeTargetSessionId ?? null,
      composeTargetThreadId: options?.composeTargetThreadId ?? null,
      composeTargetTurnId: options?.composeTargetTurnId ?? null,
    });
  }

  clearConversationComposeMode(target: TelegramConversationTarget): TelegramConversationContext {
    return this.updateConversationContext(target, {
      composeMode: "none",
      composeWorkspaceId: null,
      composeTargetSessionId: null,
      composeTargetThreadId: null,
      composeTargetTurnId: null,
    });
  }

  listFollowingConversations(sessionId: string): TelegramConversationTarget[] {
    return this.db
      .prepare(
        `
          SELECT
            chat_id as chatId,
            NULLIF(message_thread_id, 0) as messageThreadId
          FROM conversation_context
          WHERE follow_session_id = ?
          ORDER BY chat_id ASC, message_thread_id ASC
        `,
      )
      .all(sessionId) as TelegramConversationTarget[];
  }

  findFollowingTopic(sessionId: string, chatId: number): TelegramConversationTarget | null {
    const row = this.db
      .prepare(
        `
          SELECT
            chat_id as chatId,
            NULLIF(message_thread_id, 0) as messageThreadId
          FROM conversation_context
          WHERE follow_session_id = ?
            AND chat_id = ?
            AND message_thread_id != 0
          ORDER BY updated_at DESC
          LIMIT 1
        `,
      )
      .get(sessionId, chatId) as TelegramConversationTarget | undefined;
    return row ?? null;
  }

  getSessionTopic(sessionId: string, chatId: number): TelegramConversationTarget | null {
    const row = this.db
      .prepare(
        `
          SELECT
            chat_id as chatId,
            NULLIF(message_thread_id, 0) as messageThreadId
          FROM session_topic_binding
          WHERE session_id = ?
            AND chat_id = ?
          LIMIT 1
        `,
      )
      .get(sessionId, chatId) as TelegramConversationTarget | undefined;
    return row ?? null;
  }

  bindSessionTopic(sessionId: string, target: TelegramConversationTarget): TelegramConversationTarget {
    const messageThreadId = this.normalizeMessageThreadId(target.messageThreadId);
    if (messageThreadId === 0) {
      throw new Error("Session topics must target a Telegram topic.");
    }

    const updatedAt = new Date().toISOString();
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `
            DELETE FROM session_topic_binding
            WHERE (session_id = ? AND chat_id = ?)
               OR (chat_id = ? AND message_thread_id = ?)
          `,
        )
        .run(sessionId, target.chatId, target.chatId, messageThreadId);

      this.db
        .prepare(
          `
            INSERT INTO session_topic_binding (
              session_id,
              chat_id,
              message_thread_id,
              updated_at
            )
            VALUES (?, ?, ?, ?)
          `,
        )
        .run(sessionId, target.chatId, messageThreadId, updatedAt);
    });

    tx();
    return {
      chatId: target.chatId,
      messageThreadId,
    };
  }

  listFollowingChats(sessionId: string): number[] {
    const rows = this.db
      .prepare(
        `
          SELECT chat_id as chatId
          FROM chat_context
          WHERE follow_session_id = ?
        `,
      )
      .all(sessionId) as Array<{ chatId: number }>;
    return rows.map((row) => row.chatId);
  }

  enqueuePrompt(conductorSessionId: string, codexThreadId: string, kind: QueueKind, text: string): number {
    const result = this.db
      .prepare(
        `
          INSERT INTO prompt_queue (
            conductor_session_id,
            codex_thread_id,
            kind,
            text,
            status
          )
          VALUES (?, ?, ?, ?, 'queued')
        `,
      )
      .run(conductorSessionId, codexThreadId, kind, text);

    return Number(result.lastInsertRowid);
  }

  getNextQueuedPrompt(sessionId: string): QueueItem | null {
    const row = this.db
      .prepare(
        `
          SELECT
            id,
            conductor_session_id as conductorSessionId,
            codex_thread_id as codexThreadId,
            kind,
            text,
            status,
            enqueued_at as enqueuedAt,
            started_at as startedAt,
            finished_at as finishedAt
          FROM prompt_queue
          WHERE conductor_session_id = ?
            AND status = 'queued'
          ORDER BY id ASC
          LIMIT 1
        `,
      )
      .get(sessionId) as QueueItem | undefined;
    return row ?? null;
  }

  markPromptStarted(id: number): void {
    this.db
      .prepare(
        `
          UPDATE prompt_queue
          SET status = 'started',
              started_at = datetime('now')
          WHERE id = ?
        `,
      )
      .run(id);
  }

  retryPrompt(id: number): void {
    this.db
      .prepare(
        `
          UPDATE prompt_queue
          SET status = 'queued',
              started_at = NULL,
              finished_at = NULL
          WHERE id = ?
        `,
      )
      .run(id);
  }

  markPromptFinished(id: number, status: "finished" | "failed" | "cancelled"): void {
    this.db
      .prepare(
        `
          UPDATE prompt_queue
          SET status = ?,
              finished_at = datetime('now')
          WHERE id = ?
        `,
      )
      .run(status, id);
  }

  listQueuedSessionIds(): string[] {
    const rows = this.db
      .prepare(
        `
          SELECT conductor_session_id as sessionId, MIN(id) as firstId
          FROM prompt_queue
          WHERE status = 'queued'
          GROUP BY conductor_session_id
          ORDER BY firstId ASC
        `,
      )
      .all() as Array<{ sessionId: string; firstId: number }>;
    return rows.map((row) => row.sessionId);
  }

  listQueueForSession(sessionId: string, limit = 20): QueueItem[] {
    return this.db
      .prepare(
        `
          SELECT
            id,
            conductor_session_id as conductorSessionId,
            codex_thread_id as codexThreadId,
            kind,
            text,
            status,
            enqueued_at as enqueuedAt,
            started_at as startedAt,
            finished_at as finishedAt
          FROM prompt_queue
          WHERE conductor_session_id = ?
          ORDER BY id DESC
          LIMIT ?
        `,
      )
      .all(sessionId, limit) as QueueItem[];
  }

  getTelegramCursor(): number {
    const row = this.db
      .prepare(
        `
          SELECT last_update_id as lastUpdateId
          FROM telegram_cursor
          WHERE singleton_key = 'default'
        `,
      )
      .get() as { lastUpdateId: number } | undefined;
    return row?.lastUpdateId ?? 0;
  }

  setTelegramCursor(lastUpdateId: number): void {
    this.db
      .prepare(
        `
          INSERT INTO telegram_cursor (singleton_key, last_update_id)
          VALUES ('default', ?)
          ON CONFLICT(singleton_key) DO UPDATE SET
            last_update_id = excluded.last_update_id
        `,
      )
      .run(lastUpdateId);
  }

  buildFingerprint(sessionId: string, turnId: string, role: string, content: string): string {
    const digest = crypto.createHash("sha256").update(content).digest("hex");
    return `${sessionId}|${turnId}|${role}|${digest}`;
  }

  hasFingerprint(fingerprint: string): boolean {
    const row = this.db
      .prepare(
        `
          SELECT 1
          FROM message_fingerprints
          WHERE fingerprint = ?
        `,
      )
      .get(fingerprint) as { 1: number } | undefined;
    return Boolean(row);
  }

  addFingerprint(fingerprint: string, sessionId: string, turnId: string, role: string): void {
    this.db
      .prepare(
        `
          INSERT OR IGNORE INTO message_fingerprints (
            fingerprint,
            conductor_session_id,
            turn_id,
            role
          )
          VALUES (?, ?, ?, ?)
        `,
      )
      .run(fingerprint, sessionId, turnId, role);
  }

  private normalizeMessageThreadId(messageThreadId: number | null | undefined): number {
    return messageThreadId ?? 0;
  }

  private conversationKey(chatId: number, messageThreadId: number): string {
    return `${chatId}:${messageThreadId}`;
  }
}
