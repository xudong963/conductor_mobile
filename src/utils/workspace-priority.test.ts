import { describe, expect, it } from "vitest";

import type { SessionStatus } from "../types.js";
import {
  isWorkspaceBranchMerged,
  sortRepositoryWorkspaces,
  type RepositoryWorkspacePriorityRef,
} from "./workspace-priority.js";

function makeWorkspace(
  id: string,
  options?: {
    activeSessionStatus?: SessionStatus | null;
    archiveCommit?: string | null;
    branch?: string | null;
    hasLocalUserMessages?: boolean;
    state?: string | null;
    updatedAt?: string;
  },
): RepositoryWorkspacePriorityRef {
  return {
    id,
    directoryName: id,
    branch: options?.branch ?? `feature/${id}`,
    prTitle: null,
    repositoryId: "repo-1",
    activeSessionId: `${id}-session`,
    updatedAt: options?.updatedAt ?? "2026-03-29 03:00:00",
    rootPath: "/tmp/repo",
    repositoryName: "demo",
    activeSessionStatus: options?.activeSessionStatus ?? "idle",
    archiveCommit: options?.archiveCommit ?? null,
    hasLocalUserMessages: options?.hasLocalUserMessages ?? true,
    state: options?.state ?? "ready",
  };
}

describe("isWorkspaceBranchMerged", () => {
  it("uses git branch membership when available", () => {
    expect(
      isWorkspaceBranchMerged(
        makeWorkspace("merged", {
          branch: "feature/merged",
        }),
        new Set(["feature/merged"]),
      ),
    ).toBe(true);
  });

  it("treats archived workspaces as merged even without a git ref", () => {
    expect(
      isWorkspaceBranchMerged(
        makeWorkspace("archived", {
          branch: "feature/missing",
          state: "archived",
        }),
        new Set<string>(),
      ),
    ).toBe(true);
  });
});

describe("sortRepositoryWorkspaces", () => {
  it("prioritizes busy, unmerged, and untouched branches before older handled work", () => {
    const workspaces = [
      makeWorkspace("merged", {
        branch: "feature/merged",
        hasLocalUserMessages: true,
        updatedAt: "2026-03-29 03:05:00",
      }),
      makeWorkspace("handled", {
        branch: "feature/handled",
        hasLocalUserMessages: true,
        updatedAt: "2026-03-29 03:04:00",
      }),
      makeWorkspace("fresh", {
        branch: "feature/fresh",
        hasLocalUserMessages: false,
        updatedAt: "2026-03-29 03:03:00",
      }),
      makeWorkspace("busy", {
        branch: "feature/busy",
        activeSessionStatus: "working",
        hasLocalUserMessages: true,
        updatedAt: "2026-03-29 03:01:00",
      }),
    ];

    const result = sortRepositoryWorkspaces(workspaces, new Set(["feature/merged"]));

    expect(result.map((workspace) => workspace.id)).toEqual(["busy", "fresh", "handled", "merged"]);
  });

  it("falls back to recency within the same priority bucket", () => {
    const result = sortRepositoryWorkspaces(
      [
        makeWorkspace("older", {
          branch: "feature/older",
          hasLocalUserMessages: false,
          updatedAt: "2026-03-29 03:01:00",
        }),
        makeWorkspace("newer", {
          branch: "feature/newer",
          hasLocalUserMessages: false,
          updatedAt: "2026-03-29 03:02:00",
        }),
      ],
      new Set<string>(),
    );

    expect(result.map((workspace) => workspace.id)).toEqual(["newer", "older"]);
  });
});
