import Database from "better-sqlite3";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type {
  ConductorSessionRef,
  RepositoryRef,
  SessionDefaults,
  SessionMessageRecord,
  SessionSeed,
  SessionStatus,
  WorkspaceRef,
} from "../types.js";

interface DbSessionRow {
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

export class ConductorRegistryAdapter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  private readonly workspacesRoot: string;
  private readonly defaultFallbackModel: string;
  private readonly defaultPermissionMode: string;

  constructor(
    conductorDbPath: string,
    options: {
      workspacesRoot: string;
      defaultFallbackModel: string;
      defaultPermissionMode: string;
    },
  ) {
    this.db = new Database(conductorDbPath);
    this.db.pragma("busy_timeout = 5000");
    this.workspacesRoot = options.workspacesRoot;
    this.defaultFallbackModel = options.defaultFallbackModel;
    this.defaultPermissionMode = options.defaultPermissionMode;
  }

  listWorkspaces(limit: number): WorkspaceRef[] {
    return this.db
      .prepare(
        `
          SELECT
            w.id,
            w.directory_name as directoryName,
            w.branch as branch,
            w.repository_id as repositoryId,
            w.active_session_id as activeSessionId,
            w.updated_at as updatedAt,
            r.root_path as rootPath,
            r.name as repositoryName
          FROM workspaces w
          JOIN repos r ON r.id = w.repository_id
          WHERE IFNULL(r.hidden, 0) = 0
          ORDER BY w.updated_at DESC
          LIMIT ?
        `,
      )
      .all(limit) as WorkspaceRef[];
  }

  listRepositories(limit: number): RepositoryRef[] {
    return this.db
      .prepare(
        `
          SELECT
            r.id,
            r.name as repositoryName,
            r.root_path as rootPath,
            MAX(w.updated_at) as updatedAt
          FROM workspaces w
          JOIN repos r ON r.id = w.repository_id
          WHERE IFNULL(r.hidden, 0) = 0
          GROUP BY r.id, r.name, r.root_path
          ORDER BY MAX(w.updated_at) DESC
          LIMIT ?
        `,
      )
      .all(limit) as RepositoryRef[];
  }

  getWorkspaceById(workspaceId: string): WorkspaceRef | null {
    const row = this.db
      .prepare(
        `
          SELECT
            w.id,
            w.directory_name as directoryName,
            w.branch as branch,
            w.repository_id as repositoryId,
            w.active_session_id as activeSessionId,
            w.updated_at as updatedAt,
            r.root_path as rootPath,
            r.name as repositoryName
          FROM workspaces w
          JOIN repos r ON r.id = w.repository_id
          WHERE w.id = ?
          LIMIT 1
        `,
      )
      .get(workspaceId) as WorkspaceRef | undefined;
    return row ?? null;
  }

  listWorkspacesForRepository(repositoryId: string, limit: number): WorkspaceRef[] {
    return this.db
      .prepare(
        `
          SELECT
            w.id,
            w.directory_name as directoryName,
            w.branch as branch,
            w.repository_id as repositoryId,
            w.active_session_id as activeSessionId,
            w.updated_at as updatedAt,
            r.root_path as rootPath,
            r.name as repositoryName
          FROM workspaces w
          JOIN repos r ON r.id = w.repository_id
          WHERE w.repository_id = ?
            AND IFNULL(r.hidden, 0) = 0
          ORDER BY w.updated_at DESC
          LIMIT ?
        `,
      )
      .all(repositoryId, limit) as WorkspaceRef[];
  }

  listSessions(workspaceId: string, limit: number): ConductorSessionRef[] {
    return this.db
      .prepare(
        `
          SELECT
            id,
            workspace_id as workspaceId,
            status,
            agent_type as agentType,
            model,
            permission_mode as permissionMode,
            title,
            claude_session_id as claudeSessionId,
            updated_at as updatedAt,
            last_user_message_at as lastUserMessageAt
          FROM sessions
          WHERE workspace_id = ?
            AND IFNULL(is_hidden, 0) = 0
          ORDER BY updated_at DESC
          LIMIT ?
        `,
      )
      .all(workspaceId, limit) as ConductorSessionRef[];
  }

  getSessionById(sessionId: string): ConductorSessionRef | null {
    const row = this.db
      .prepare(
        `
          SELECT
            id,
            workspace_id as workspaceId,
            status,
            agent_type as agentType,
            model,
            permission_mode as permissionMode,
            title,
            claude_session_id as claudeSessionId,
            updated_at as updatedAt,
            last_user_message_at as lastUserMessageAt
          FROM sessions
          WHERE id = ?
          LIMIT 1
        `,
      )
      .get(sessionId) as DbSessionRow | undefined;
    return row ?? null;
  }

  findSessionByThreadId(threadId: string): ConductorSessionRef | null {
    const row = this.db
      .prepare(
        `
          SELECT
            id,
            workspace_id as workspaceId,
            status,
            agent_type as agentType,
            model,
            permission_mode as permissionMode,
            title,
            claude_session_id as claudeSessionId,
            updated_at as updatedAt,
            last_user_message_at as lastUserMessageAt
          FROM sessions
          WHERE claude_session_id = ?
          LIMIT 1
        `,
      )
      .get(threadId) as DbSessionRow | undefined;
    return row ?? null;
  }

  getInboxSessions(limit: number): ConductorSessionRef[] {
    return this.db
      .prepare(
        `
          SELECT
            id,
            workspace_id as workspaceId,
            status,
            agent_type as agentType,
            model,
            permission_mode as permissionMode,
            title,
            claude_session_id as claudeSessionId,
            updated_at as updatedAt,
            last_user_message_at as lastUserMessageAt
          FROM sessions
          WHERE status IN ('needs_user_input', 'needs_plan_response', 'error')
            AND IFNULL(is_hidden, 0) = 0
          ORDER BY updated_at DESC
          LIMIT ?
        `,
      )
      .all(limit) as ConductorSessionRef[];
  }

  getSessionDefaults(workspaceId: string): SessionDefaults {
    const active = this.db
      .prepare(
        `
          SELECT
            s.model as model,
            s.permission_mode as permissionMode
          FROM workspaces w
          LEFT JOIN sessions s
            ON s.id = w.active_session_id
          WHERE w.id = ?
          LIMIT 1
        `,
      )
      .get(workspaceId) as { model: string | null; permissionMode: string | null } | undefined;

    const settingsRows = this.db
      .prepare(
        `
          SELECT key, value
          FROM settings
          WHERE key IN ('default_model', 'default_plan_mode')
        `,
      )
      .all() as Array<{ key: string; value: string }>;

    const settings = new Map(settingsRows.map((row) => [row.key, row.value]));
    const defaultModel = settings.get("default_model");
    const defaultPlanMode = settings.get("default_plan_mode");

    const permissionFromSetting =
      defaultPlanMode === "true" || defaultPlanMode === "1" ? "plan" : this.defaultPermissionMode;

    return {
      model: active?.model ?? defaultModel ?? this.defaultFallbackModel,
      permissionMode: active?.permissionMode ?? permissionFromSetting,
    };
  }

  resolveWorkspacePath(workspaceId: string): string {
    const workspace = this.getWorkspaceById(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found.`);
    }
    return path.join(this.workspacesRoot, workspace.repositoryName, workspace.directoryName);
  }

  updateWorkspaceActiveSession(workspaceId: string, sessionId: string): void {
    this.db
      .prepare(
        `
          UPDATE workspaces
          SET active_session_id = ?,
              updated_at = datetime('now')
          WHERE id = ?
        `,
      )
      .run(sessionId, workspaceId);
  }

  updateSessionStatus(sessionId: string, status: SessionStatus): void {
    this.db
      .prepare(
        `
          UPDATE sessions
          SET status = ?,
              updated_at = datetime('now')
          WHERE id = ?
        `,
      )
      .run(status, sessionId);
  }

  updateSessionLastUserMessageAt(sessionId: string, sentAtIso: string): void {
    this.db
      .prepare(
        `
          UPDATE sessions
          SET last_user_message_at = ?,
              updated_at = datetime('now')
          WHERE id = ?
        `,
      )
      .run(sentAtIso, sessionId);
  }

  createSession(workspaceId: string, threadId: string, seed: SessionSeed): ConductorSessionRef {
    const sessionId = randomUUID();

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `
            INSERT INTO sessions (
              id,
              status,
              claude_session_id,
              workspace_id,
              agent_type,
              model,
              permission_mode,
              title,
              last_user_message_at,
              created_at,
              updated_at
            )
            VALUES (?, 'idle', ?, ?, 'codex', ?, ?, ?, datetime('now'), datetime('now'), datetime('now'))
          `,
        )
        .run(sessionId, threadId, workspaceId, seed.model, seed.permissionMode, seed.title);

      this.db
        .prepare(
          `
            UPDATE workspaces
            SET active_session_id = ?,
                updated_at = datetime('now')
            WHERE id = ?
          `,
        )
        .run(sessionId, workspaceId);
    });

    tx();
    const created = this.getSessionById(sessionId);
    if (!created) {
      throw new Error(`Failed to read back created session ${sessionId}.`);
    }
    return created;
  }

  appendSessionMessage(params: {
    sessionId: string;
    role: "user" | "assistant";
    content: string;
    turnId: string;
    model: string | null;
    sentAt: string;
  }): string {
    const messageId = randomUUID();
    this.db
      .prepare(
        `
          INSERT INTO session_messages (
            id,
            session_id,
            role,
            content,
            sent_at,
            turn_id,
            model,
            created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        messageId,
        params.sessionId,
        params.role,
        params.content,
        params.sentAt,
        params.turnId,
        params.model,
        params.sentAt,
      );
    return messageId;
  }

  listSessionMessages(sessionId: string, limit: number): SessionMessageRecord[] {
    return this.db
      .prepare(
        `
          SELECT
            role,
            content,
            sent_at as sentAt,
            turn_id as turnId,
            model
          FROM session_messages
          WHERE session_id = ?
            AND cancelled_at IS NULL
          ORDER BY COALESCE(sent_at, created_at) DESC
          LIMIT ?
        `,
      )
      .all(sessionId, limit) as SessionMessageRecord[];
  }
}
