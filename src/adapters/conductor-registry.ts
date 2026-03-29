import { execFileSync } from "node:child_process";
import fs from "node:fs";
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
import { sortRepositoryWorkspaces, type RepositoryWorkspacePriorityRef } from "../utils/workspace-priority.js";

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

interface DbWorkspacePriorityRow extends WorkspaceRef {
  activeSessionStatus: SessionStatus | null;
  archiveCommit: string | null;
  hasLocalUserMessages: number;
  state: string | null;
  defaultBranch: string;
}

interface DbRepositoryRow extends RepositoryRef {
  defaultBranch: string | null;
  remote: string | null;
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
            w.pr_title as prTitle,
            s.title as activeSessionTitle,
            w.repository_id as repositoryId,
            w.active_session_id as activeSessionId,
            w.updated_at as updatedAt,
            r.root_path as rootPath,
            r.name as repositoryName
          FROM workspaces w
          JOIN repos r ON r.id = w.repository_id
          LEFT JOIN sessions s ON s.id = w.active_session_id
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
            MAX(w.updated_at) as updatedAt,
            r.default_branch as defaultBranch,
            r.remote as remote
          FROM workspaces w
          JOIN repos r ON r.id = w.repository_id
          WHERE IFNULL(r.hidden, 0) = 0
          GROUP BY r.id, r.name, r.root_path, r.default_branch, r.remote
          ORDER BY MAX(w.updated_at) DESC
          LIMIT ?
        `,
      )
      .all(limit) as RepositoryRef[];
  }

  getRepositoryById(repositoryId: string): RepositoryRef | null {
    const row = this.db
      .prepare(
        `
          SELECT
            id,
            name as repositoryName,
            root_path as rootPath,
            updated_at as updatedAt,
            default_branch as defaultBranch,
            remote as remote
          FROM repos
          WHERE id = ?
            AND IFNULL(hidden, 0) = 0
          LIMIT 1
        `,
      )
      .get(repositoryId) as DbRepositoryRow | undefined;
    return row ?? null;
  }

  getWorkspaceById(workspaceId: string): WorkspaceRef | null {
    const row = this.db
      .prepare(
        `
          SELECT
            w.id,
            w.directory_name as directoryName,
            w.branch as branch,
            w.pr_title as prTitle,
            s.title as activeSessionTitle,
            w.repository_id as repositoryId,
            w.active_session_id as activeSessionId,
            w.updated_at as updatedAt,
            r.root_path as rootPath,
            r.name as repositoryName
          FROM workspaces w
          JOIN repos r ON r.id = w.repository_id
          LEFT JOIN sessions s ON s.id = w.active_session_id
          WHERE w.id = ?
          LIMIT 1
        `,
      )
      .get(workspaceId) as WorkspaceRef | undefined;
    return row ?? null;
  }

  findWorkspaceByBranch(repositoryId: string, branchName: string): WorkspaceRef | null {
    const row = this.db
      .prepare(
        `
          SELECT
            w.id,
            w.directory_name as directoryName,
            w.branch as branch,
            w.pr_title as prTitle,
            s.title as activeSessionTitle,
            w.repository_id as repositoryId,
            w.active_session_id as activeSessionId,
            w.updated_at as updatedAt,
            r.root_path as rootPath,
            r.name as repositoryName
          FROM workspaces w
          JOIN repos r ON r.id = w.repository_id
          LEFT JOIN sessions s ON s.id = w.active_session_id
          WHERE w.repository_id = ?
            AND w.branch = ?
          LIMIT 1
        `,
      )
      .get(repositoryId, branchName.trim()) as WorkspaceRef | undefined;
    return row ?? null;
  }

  listWorkspacesForRepository(repositoryId: string, limit: number): WorkspaceRef[] {
    const rows = this.db
      .prepare(
        `
          SELECT
            w.id,
            w.directory_name as directoryName,
            w.branch as branch,
            w.pr_title as prTitle,
            active.title as activeSessionTitle,
            w.repository_id as repositoryId,
            w.active_session_id as activeSessionId,
            active.status as activeSessionStatus,
            w.updated_at as updatedAt,
            w.state as state,
            w.archive_commit as archiveCommit,
            EXISTS (
              SELECT 1
              FROM sessions handled
              WHERE handled.workspace_id = w.id
                AND handled.last_user_message_at IS NOT NULL
            ) as hasLocalUserMessages,
            r.default_branch as defaultBranch,
            r.root_path as rootPath,
            r.name as repositoryName
          FROM workspaces w
          JOIN repos r ON r.id = w.repository_id
          LEFT JOIN sessions active ON active.id = w.active_session_id
          WHERE w.repository_id = ?
            AND IFNULL(r.hidden, 0) = 0
        `,
      )
      .all(repositoryId) as DbWorkspacePriorityRow[];

    if (rows.length === 0) {
      return [];
    }

    const repositoryRootPath = rows[0]?.rootPath;
    const defaultBranch = rows[0]?.defaultBranch;
    if (!repositoryRootPath) {
      return rows.slice(0, limit);
    }

    const mergedBranchNames = this.getMergedBranchNames(repositoryRootPath, defaultBranch);
    const sortableRows: RepositoryWorkspacePriorityRef[] = rows.map((row) => ({
      id: row.id,
      directoryName: row.directoryName,
      branch: row.branch,
      ...(row.prTitle !== undefined ? { prTitle: row.prTitle } : {}),
      ...(row.activeSessionTitle !== undefined ? { activeSessionTitle: row.activeSessionTitle } : {}),
      repositoryId: row.repositoryId,
      activeSessionId: row.activeSessionId,
      updatedAt: row.updatedAt,
      rootPath: row.rootPath,
      repositoryName: row.repositoryName,
      activeSessionStatus: row.activeSessionStatus,
      archiveCommit: row.archiveCommit,
      hasLocalUserMessages: Boolean(row.hasLocalUserMessages),
      state: row.state,
      defaultBranch: row.defaultBranch,
    }));

    return sortRepositoryWorkspaces(sortableRows, mergedBranchNames)
      .filter((workspace) => !this.shouldHideWorkspaceFromRepositoryBranches(workspace, mergedBranchNames))
      .slice(0, limit);
  }

  private getMergedBranchNames(rootPath: string, defaultBranch: string | null | undefined): Set<string> {
    const normalizedDefaultBranch = defaultBranch?.trim() || "master";

    for (const targetRef of [normalizedDefaultBranch, `origin/${normalizedDefaultBranch}`]) {
      try {
        const output = execFileSync(
          "git",
          [
            "-C",
            rootPath,
            "for-each-ref",
            `--merged=${targetRef}`,
            "--format=%(refname)",
            "refs/heads",
            "refs/remotes",
          ],
          { encoding: "utf8" },
        );

        return new Set(
          output
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
            .flatMap((refName) => {
              if (refName.startsWith("refs/heads/")) {
                return [refName.slice("refs/heads/".length)];
              }
              if (refName.startsWith("refs/remotes/")) {
                const remotePath = refName.slice("refs/remotes/".length);
                const firstSlash = remotePath.indexOf("/");
                return firstSlash >= 0 ? [remotePath.slice(firstSlash + 1)] : [];
              }
              return [];
            }),
        );
      } catch {
        continue;
      }
    }

    return new Set<string>();
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
    return this.resolveWorkspaceDirectoryPath(workspace);
  }

  private resolveWorkspaceDirectoryPath(workspace: Pick<WorkspaceRef, "repositoryName" | "directoryName">): string {
    return path.join(this.workspacesRoot, workspace.repositoryName, workspace.directoryName);
  }

  private shouldHideWorkspaceFromRepositoryBranches(
    workspace: Pick<RepositoryWorkspacePriorityRef, "branch" | "archiveCommit" | "state" | "prTitle" | "defaultBranch">,
    mergedBranchNames: ReadonlySet<string>,
  ): boolean {
    const branch = workspace.branch?.trim();
    const defaultBranch = workspace.defaultBranch?.trim();
    if (branch && branch !== defaultBranch && mergedBranchNames.has(branch)) {
      return true;
    }

    const isArchived = workspace.state?.trim().toLowerCase() === "archived" || Boolean(workspace.archiveCommit);
    return isArchived && Boolean(workspace.prTitle?.trim());
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

  createWorkspace(repositoryId: string, branchName: string): WorkspaceRef {
    const repository = this.getRepositoryById(repositoryId);
    if (!repository) {
      throw new Error("Repository not found.");
    }

    const normalizedBranch = branchName.trim();
    if (!normalizedBranch) {
      throw new Error("Branch name is required.");
    }

    this.assertValidBranchName(repository.rootPath, normalizedBranch);

    const existingWorkspace = this.findWorkspaceByBranch(repositoryId, normalizedBranch);
    if (existingWorkspace) {
      return existingWorkspace;
    }

    const directoryName = this.allocateWorkspaceDirectoryName(
      repositoryId,
      repository.repositoryName,
      normalizedBranch,
    );
    const workspacePath = path.join(this.workspacesRoot, repository.repositoryName, directoryName);
    const branchExistsLocally = this.refExists(repository.rootPath, `refs/heads/${normalizedBranch}`);
    const branchStartPoint = branchExistsLocally
      ? normalizedBranch
      : (this.findRemoteBranchRef(repository.rootPath, normalizedBranch, repository.remote) ??
        this.resolveBaseBranchRef(repository.rootPath, repository.defaultBranch, repository.remote));

    let worktreeCreated = false;
    try {
      fs.mkdirSync(path.dirname(workspacePath), { recursive: true });
      execFileSync(
        "git",
        branchExistsLocally
          ? ["-C", repository.rootPath, "worktree", "add", workspacePath, normalizedBranch]
          : ["-C", repository.rootPath, "worktree", "add", "-b", normalizedBranch, workspacePath, branchStartPoint],
        { stdio: "ignore" },
      );
      worktreeCreated = true;

      const workspaceId = randomUUID();
      this.db
        .prepare(
          `
            INSERT INTO workspaces (
              id,
              repository_id,
              directory_name,
              active_session_id,
              branch,
              placeholder_branch_name,
              state,
              initialization_parent_branch,
              created_at,
              updated_at
            )
            VALUES (?, ?, ?, NULL, ?, ?, 'ready', ?, datetime('now'), datetime('now'))
          `,
        )
        .run(
          workspaceId,
          repositoryId,
          directoryName,
          normalizedBranch,
          normalizedBranch,
          repository.defaultBranch?.trim() || "master",
        );

      const created = this.getWorkspaceById(workspaceId);
      if (!created) {
        throw new Error(`Failed to read back created workspace ${workspaceId}.`);
      }
      return created;
    } catch (error) {
      if (worktreeCreated) {
        this.removeWorktree(repository.rootPath, workspacePath);
      } else {
        fs.rmSync(workspacePath, { recursive: true, force: true });
      }
      throw error;
    }
  }

  private assertValidBranchName(rootPath: string, branchName: string): void {
    try {
      execFileSync("git", ["-C", rootPath, "check-ref-format", "--branch", branchName], { stdio: "ignore" });
    } catch {
      throw new Error(`Invalid branch name: ${branchName}`);
    }
  }

  private refExists(rootPath: string, refName: string): boolean {
    try {
      execFileSync("git", ["-C", rootPath, "rev-parse", "--verify", "--quiet", refName], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  private findRemoteBranchRef(
    rootPath: string,
    branchName: string,
    preferredRemote: string | null | undefined,
  ): string | null {
    let output: string;
    try {
      output = execFileSync("git", ["-C", rootPath, "for-each-ref", "--format=%(refname:short)", "refs/remotes"], {
        encoding: "utf8",
      });
    } catch {
      return null;
    }

    const suffix = `/${branchName}`;
    const refs = output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && line !== "origin/HEAD")
      .filter((line) => line.endsWith(suffix))
      .sort((left, right) => {
        const preferred = preferredRemote?.trim();
        const preferredRef = preferred ? `${preferred}/${branchName}` : null;
        const rank = (value: string): number => {
          if (preferredRef && value === preferredRef) {
            return 0;
          }
          if (value === `origin/${branchName}`) {
            return 1;
          }
          return 2;
        };
        return rank(left) - rank(right) || left.localeCompare(right);
      });

    return refs[0] ?? null;
  }

  private resolveBaseBranchRef(
    rootPath: string,
    defaultBranch: string | null | undefined,
    preferredRemote: string | null | undefined,
  ): string {
    const normalizedDefaultBranch = defaultBranch?.trim() || "master";
    if (this.refExists(rootPath, `refs/heads/${normalizedDefaultBranch}`)) {
      return normalizedDefaultBranch;
    }

    const remoteRef = this.findRemoteBranchRef(rootPath, normalizedDefaultBranch, preferredRemote);
    if (remoteRef) {
      return remoteRef;
    }

    throw new Error(`Base branch not found: ${normalizedDefaultBranch}`);
  }

  private allocateWorkspaceDirectoryName(repositoryId: string, repositoryName: string, branchName: string): string {
    const repositoryRoot = path.join(this.workspacesRoot, repositoryName);
    const existingRows = this.db
      .prepare(
        `
          SELECT directory_name as directoryName
          FROM workspaces
          WHERE repository_id = ?
        `,
      )
      .all(repositoryId) as Array<{ directoryName: string }>;
    const existingNames = new Set(existingRows.map((row) => row.directoryName.toLowerCase()));
    const baseName = this.slugWorkspaceDirectory(branchName);

    const firstPath = path.join(repositoryRoot, baseName);
    if (!existingNames.has(baseName.toLowerCase()) && !fs.existsSync(firstPath)) {
      return baseName;
    }

    for (let index = 1; index < 1000; index += 1) {
      const candidate = `${baseName}-v${index}`;
      if (existingNames.has(candidate.toLowerCase())) {
        continue;
      }
      if (!fs.existsSync(path.join(repositoryRoot, candidate))) {
        return candidate;
      }
    }

    throw new Error(`Could not allocate a workspace directory for ${branchName}`);
  }

  private slugWorkspaceDirectory(branchName: string): string {
    const tail = branchName.split("/").at(-1) ?? branchName;
    const slug = tail
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return slug || "workspace";
  }

  private removeWorktree(rootPath: string, workspacePath: string): void {
    try {
      execFileSync("git", ["-C", rootPath, "worktree", "remove", "--force", workspacePath], { stdio: "ignore" });
    } catch {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }
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
