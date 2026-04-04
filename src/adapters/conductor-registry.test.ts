import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { ConductorRegistryAdapter } from "./conductor-registry.js";

const cleanups: Array<() => void> = [];

function createRegistryFixture(): {
  adapter: ConductorRegistryAdapter;
  db: InstanceType<typeof Database>;
  dbPath: string;
  tempDir: string;
} {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-registry-test-"));
  const dbPath = path.join(tempDir, "conductor.db");
  const workspacesRoot = path.join(tempDir, "workspaces");
  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE repos (
      id TEXT PRIMARY KEY,
      name TEXT,
      root_path TEXT,
      default_branch TEXT,
      updated_at TEXT,
      remote TEXT,
      hidden INTEGER DEFAULT 0
    );

    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      status TEXT,
      title TEXT,
      last_user_message_at TEXT,
      is_hidden INTEGER DEFAULT 0
    );

    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      repository_id TEXT,
      directory_name TEXT,
      branch TEXT,
      placeholder_branch_name TEXT,
      initialization_parent_branch TEXT,
      pr_title TEXT,
      archive_commit TEXT,
      active_session_id TEXT,
      created_at TEXT,
      updated_at TEXT NOT NULL,
      state TEXT
    );
  `);

  const adapter = new ConductorRegistryAdapter(dbPath, {
    workspacesRoot,
    defaultFallbackModel: "gpt-5.4",
    defaultPermissionMode: "default",
  });

  const cleanup = () => {
    (adapter as unknown as { db: { close: () => void } }).db.close();
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  };

  cleanups.push(cleanup);
  return { adapter, db, dbPath, tempDir };
}

function runGit(args: string[], cwd: string): void {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
  });
}

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

describe("ConductorRegistryAdapter", () => {
  it("hides archived PR workspaces from repository branch listings by default", () => {
    const { adapter, db, tempDir } = createRegistryFixture();
    const repositoryRoot = path.join(tempDir, "repo-root");

    fs.mkdirSync(repositoryRoot, { recursive: true });
    runGit(["init", "--initial-branch=master"], repositoryRoot);
    runGit(["config", "user.name", "Test User"], repositoryRoot);
    runGit(["config", "user.email", "test@example.com"], repositoryRoot);
    fs.writeFileSync(path.join(repositoryRoot, "README.md"), "initial\n", "utf8");
    runGit(["add", "README.md"], repositoryRoot);
    runGit(["commit", "-m", "initial"], repositoryRoot);

    db.prepare(
      `INSERT INTO repos (id, name, root_path, default_branch, updated_at, remote, hidden) VALUES (?, ?, ?, ?, ?, ?, ?);`,
    ).run("repo-1", "telegram-bridge", repositoryRoot, "master", "2026-03-29T04:00:00.000Z", "origin", 0);
    db.prepare(
      `INSERT INTO repos (id, name, root_path, default_branch, updated_at, remote, hidden) VALUES (?, ?, ?, ?, ?, ?, ?);`,
    ).run("repo-2", "other-repo", "/repos/other-repo", "master", "2026-03-29T05:00:00.000Z", "origin", 0);

    const insertWorkspace = db.prepare(`
      INSERT INTO workspaces (
        id,
        repository_id,
        directory_name,
        branch,
        pr_title,
        archive_commit,
        active_session_id,
        updated_at,
        state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
    `);

    insertWorkspace.run(
      "workspace-main",
      "repo-1",
      "telegram-bridge",
      "master",
      null,
      null,
      null,
      "2026-03-29T04:00:00.000Z",
      "ready",
    );
    insertWorkspace.run(
      "workspace-archived-branch",
      "repo-1",
      "legacy-branch",
      "xudong963/legacy-branch",
      null,
      null,
      null,
      "2026-03-29T03:00:00.000Z",
      "archived",
    );
    insertWorkspace.run(
      "workspace-merged-pr",
      "repo-1",
      "merged-pr",
      "xudong963/merged-pr",
      "Hide merged PR branches",
      null,
      null,
      "2026-03-29T02:00:00.000Z",
      "archived",
    );
    insertWorkspace.run(
      "workspace-open-pr",
      "repo-1",
      "open-pr",
      "xudong963/open-pr",
      "Keep open PR branches visible",
      null,
      null,
      "2026-03-29T01:00:00.000Z",
      "ready",
    );
    insertWorkspace.run(
      "workspace-other-repo",
      "repo-2",
      "other-repo",
      "master",
      "Other repo PR",
      null,
      null,
      "2026-03-29T05:00:00.000Z",
      "archived",
    );
    const workspaces = adapter.listWorkspacesForRepository("repo-1", 10);

    expect(workspaces.map((workspace) => workspace.id)).toEqual([
      "workspace-open-pr",
      "workspace-main",
      "workspace-archived-branch",
    ]);
  });

  it("hides merged branches even when the workspace record is still ready", () => {
    const { adapter, db, tempDir } = createRegistryFixture();
    const repositoryName = "telegram-bridge";
    const sourceRepoPath = path.join(tempDir, "source-repo");
    const repoWorkspaceRoot = path.join(tempDir, "workspaces", repositoryName);

    fs.mkdirSync(sourceRepoPath, { recursive: true });
    fs.mkdirSync(repoWorkspaceRoot, { recursive: true });

    runGit(["init", "--initial-branch=master"], sourceRepoPath);
    runGit(["config", "user.name", "Test User"], sourceRepoPath);
    runGit(["config", "user.email", "test@example.com"], sourceRepoPath);

    fs.writeFileSync(path.join(sourceRepoPath, "README.md"), "initial\n", "utf8");
    runGit(["add", "README.md"], sourceRepoPath);
    runGit(["commit", "-m", "initial"], sourceRepoPath);

    runGit(["switch", "-c", "xudong963/merged-branch"], sourceRepoPath);
    fs.writeFileSync(path.join(sourceRepoPath, "merged.txt"), "merged\n", "utf8");
    runGit(["add", "merged.txt"], sourceRepoPath);
    runGit(["commit", "-m", "merged branch"], sourceRepoPath);
    runGit(["switch", "master"], sourceRepoPath);
    runGit(["merge", "--no-ff", "xudong963/merged-branch", "-m", "merge merged branch"], sourceRepoPath);

    runGit(["switch", "-c", "xudong963/open-branch"], sourceRepoPath);
    fs.writeFileSync(path.join(sourceRepoPath, "open.txt"), "open\n", "utf8");
    runGit(["add", "open.txt"], sourceRepoPath);
    runGit(["commit", "-m", "open branch"], sourceRepoPath);
    runGit(["switch", "master"], sourceRepoPath);

    runGit(["worktree", "add", "--detach", path.join(repoWorkspaceRoot, "master-workspace"), "master"], sourceRepoPath);
    runGit(
      ["worktree", "add", path.join(repoWorkspaceRoot, "merged-workspace"), "xudong963/merged-branch"],
      sourceRepoPath,
    );
    runGit(
      ["worktree", "add", path.join(repoWorkspaceRoot, "open-workspace"), "xudong963/open-branch"],
      sourceRepoPath,
    );

    db.prepare(
      `INSERT INTO repos (id, name, root_path, default_branch, updated_at, remote, hidden) VALUES (?, ?, ?, ?, ?, ?, ?);`,
    ).run("repo-1", repositoryName, sourceRepoPath, "master", "2026-03-29T04:00:00.000Z", "origin", 0);

    const insertWorkspace = db.prepare(`
      INSERT INTO workspaces (
        id,
        repository_id,
        directory_name,
        branch,
        pr_title,
        archive_commit,
        active_session_id,
        updated_at,
        state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
    `);

    insertWorkspace.run(
      "workspace-master",
      "repo-1",
      "master-workspace",
      "master",
      null,
      null,
      null,
      "2026-03-29T04:00:00.000Z",
      "ready",
    );
    insertWorkspace.run(
      "workspace-merged",
      "repo-1",
      "merged-workspace",
      "xudong963/merged-branch",
      "Merged branch",
      null,
      null,
      "2026-03-29T03:00:00.000Z",
      "ready",
    );
    insertWorkspace.run(
      "workspace-open",
      "repo-1",
      "open-workspace",
      "xudong963/open-branch",
      "Open branch",
      null,
      null,
      "2026-03-29T02:00:00.000Z",
      "ready",
    );

    const workspaces = adapter.listWorkspacesForRepository("repo-1", 10);

    expect(workspaces.map((workspace) => workspace.id)).toEqual(["workspace-open", "workspace-master"]);
  });

  it("creates a new workspace worktree and persists the workspace record", () => {
    const { adapter, db, tempDir } = createRegistryFixture();
    const repositoryName = "telegram-bridge";
    const sourceRepoPath = path.join(tempDir, "source-repo");

    fs.mkdirSync(sourceRepoPath, { recursive: true });
    runGit(["init", "--initial-branch=master"], sourceRepoPath);
    runGit(["config", "user.name", "Test User"], sourceRepoPath);
    runGit(["config", "user.email", "test@example.com"], sourceRepoPath);

    fs.writeFileSync(path.join(sourceRepoPath, "README.md"), "initial\n", "utf8");
    runGit(["add", "README.md"], sourceRepoPath);
    runGit(["commit", "-m", "initial"], sourceRepoPath);

    db.prepare(
      `INSERT INTO repos (id, name, root_path, default_branch, updated_at, remote, hidden) VALUES (?, ?, ?, ?, ?, ?, ?);`,
    ).run("repo-1", repositoryName, sourceRepoPath, "master", "2026-03-29T04:00:00.000Z", "origin", 0);

    const workspace = adapter.createWorkspace("repo-1", "xudong963/berlin");

    expect(workspace.branch).toBe("xudong963/berlin");
    expect(workspace.directoryName).toBe("berlin");
    expect(fs.existsSync(path.join(tempDir, "workspaces", repositoryName, "berlin", ".git"))).toBeTruthy();

    const row = db
      .prepare(
        `
          SELECT
            branch,
            directory_name as directoryName,
            placeholder_branch_name as placeholderBranchName,
            state,
            initialization_parent_branch as initializationParentBranch
          FROM workspaces
          WHERE id = ?
        `,
      )
      .get(workspace.id) as
      | {
          branch: string;
          directoryName: string;
          placeholderBranchName: string;
          state: string;
          initializationParentBranch: string;
        }
      | undefined;

    expect(row).toEqual({
      branch: "xudong963/berlin",
      directoryName: "berlin",
      placeholderBranchName: "xudong963/berlin",
      state: "ready",
      initializationParentBranch: "master",
    });
  });

  it("finds an existing prefixed workspace when the branch name omits xudong963", () => {
    const { adapter, db, tempDir } = createRegistryFixture();
    const repositoryName = "telegram-bridge";
    const sourceRepoPath = path.join(tempDir, "source-repo");

    fs.mkdirSync(sourceRepoPath, { recursive: true });
    runGit(["init", "--initial-branch=master"], sourceRepoPath);
    runGit(["config", "user.name", "Test User"], sourceRepoPath);
    runGit(["config", "user.email", "test@example.com"], sourceRepoPath);

    fs.writeFileSync(path.join(sourceRepoPath, "README.md"), "initial\n", "utf8");
    runGit(["add", "README.md"], sourceRepoPath);
    runGit(["commit", "-m", "initial"], sourceRepoPath);

    db.prepare(
      `INSERT INTO repos (id, name, root_path, default_branch, updated_at, remote, hidden) VALUES (?, ?, ?, ?, ?, ?, ?);`,
    ).run("repo-1", repositoryName, sourceRepoPath, "master", "2026-03-29T04:00:00.000Z", "origin", 0);
    db.prepare(
      `
        INSERT INTO workspaces (
          id,
          repository_id,
          directory_name,
          branch,
          pr_title,
          archive_commit,
          active_session_id,
          updated_at,
          state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
      `,
    ).run("workspace-1", "repo-1", "berlin", "xudong963/berlin", null, null, null, "2026-03-29T04:00:00.000Z", "ready");

    const workspace = adapter.findWorkspaceByBranch("repo-1", "berlin");

    expect(workspace?.id).toBe("workspace-1");
    expect(workspace?.branch).toBe("xudong963/berlin");
  });

  it("creates an unqualified branch from the base branch instead of a prefixed remote-tracking branch", () => {
    const { adapter, db, tempDir } = createRegistryFixture();
    const repositoryName = "telegram-bridge";
    const sourceRepoPath = path.join(tempDir, "source-repo");

    fs.mkdirSync(sourceRepoPath, { recursive: true });
    runGit(["init", "--initial-branch=master"], sourceRepoPath);
    runGit(["config", "user.name", "Test User"], sourceRepoPath);
    runGit(["config", "user.email", "test@example.com"], sourceRepoPath);

    fs.writeFileSync(path.join(sourceRepoPath, "README.md"), "initial\n", "utf8");
    runGit(["add", "README.md"], sourceRepoPath);
    runGit(["commit", "-m", "initial"], sourceRepoPath);

    const masterCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: sourceRepoPath,
      encoding: "utf8",
    }).trim();

    runGit(["switch", "-c", "personal-branch"], sourceRepoPath);
    fs.writeFileSync(path.join(sourceRepoPath, "feature.txt"), "feature\n", "utf8");
    runGit(["add", "feature.txt"], sourceRepoPath);
    runGit(["commit", "-m", "personal branch"], sourceRepoPath);
    const personalCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: sourceRepoPath,
      encoding: "utf8",
    }).trim();
    runGit(["switch", "master"], sourceRepoPath);
    runGit(["update-ref", "refs/remotes/origin/xudong963/berlin", personalCommit], sourceRepoPath);

    db.prepare(
      `INSERT INTO repos (id, name, root_path, default_branch, updated_at, remote, hidden) VALUES (?, ?, ?, ?, ?, ?, ?);`,
    ).run("repo-1", repositoryName, sourceRepoPath, "master", "2026-03-29T04:00:00.000Z", "origin", 0);

    const workspace = adapter.createWorkspace("repo-1", "berlin");
    const workspaceHead = execFileSync(
      "git",
      ["-C", path.join(tempDir, "workspaces", repositoryName, "berlin"), "rev-parse", "HEAD"],
      {
        encoding: "utf8",
      },
    ).trim();

    expect(workspace.branch).toBe("berlin");
    expect(workspaceHead).toBe(masterCommit);
    expect(workspaceHead).not.toBe(personalCommit);
  });

  it("allocates a versioned directory name when the branch tail is already taken", () => {
    const { adapter, db, tempDir } = createRegistryFixture();
    const repositoryName = "telegram-bridge";
    const sourceRepoPath = path.join(tempDir, "source-repo");

    fs.mkdirSync(sourceRepoPath, { recursive: true });
    runGit(["init", "--initial-branch=master"], sourceRepoPath);
    runGit(["config", "user.name", "Test User"], sourceRepoPath);
    runGit(["config", "user.email", "test@example.com"], sourceRepoPath);

    fs.writeFileSync(path.join(sourceRepoPath, "README.md"), "initial\n", "utf8");
    runGit(["add", "README.md"], sourceRepoPath);
    runGit(["commit", "-m", "initial"], sourceRepoPath);

    db.prepare(
      `INSERT INTO repos (id, name, root_path, default_branch, updated_at, remote, hidden) VALUES (?, ?, ?, ?, ?, ?, ?);`,
    ).run("repo-1", repositoryName, sourceRepoPath, "master", "2026-03-29T04:00:00.000Z", "origin", 0);
    db.prepare(
      `
        INSERT INTO workspaces (
          id,
          repository_id,
          directory_name,
          branch,
          pr_title,
          archive_commit,
          active_session_id,
          updated_at,
          state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
      `,
    ).run("workspace-1", "repo-1", "berlin", "xudong963/berlin", null, null, null, "2026-03-29T04:00:00.000Z", "ready");

    const workspace = adapter.createWorkspace("repo-1", "xudong963/berlin-followup");

    expect(workspace.directoryName).toBe("berlin-followup");

    const other = adapter.createWorkspace("repo-1", "demo/berlin");
    expect(other.directoryName).toBe("berlin-v1");
  });
});
