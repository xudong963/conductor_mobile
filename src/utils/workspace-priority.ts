import type { SessionStatus, WorkspaceRef } from "../types.js";

export interface RepositoryWorkspacePriorityRef extends WorkspaceRef {
  activeSessionStatus: SessionStatus | null;
  archiveCommit: string | null;
  hasLocalUserMessages: boolean;
  state: string | null;
}

export function isWorkspaceBranchMerged(
  workspace: Pick<RepositoryWorkspacePriorityRef, "branch" | "archiveCommit" | "state">,
  mergedBranchNames: ReadonlySet<string>,
): boolean {
  if (workspace.state?.trim().toLowerCase() === "archived" || Boolean(workspace.archiveCommit)) {
    return true;
  }

  const branchName = workspace.branch?.trim();
  if (!branchName) {
    return false;
  }

  return mergedBranchNames.has(branchName);
}

function branchStatusPriority(status: SessionStatus | null | undefined): number {
  return status && status !== "idle" ? 0 : 1;
}

function mergedPriority(
  workspace: Pick<RepositoryWorkspacePriorityRef, "branch" | "archiveCommit" | "state">,
  mergedBranchNames: ReadonlySet<string>,
): number {
  return isWorkspaceBranchMerged(workspace, mergedBranchNames) ? 1 : 0;
}

function handledPriority(hasLocalUserMessages: boolean): number {
  return hasLocalUserMessages ? 1 : 0;
}

export function sortRepositoryWorkspaces(
  workspaces: RepositoryWorkspacePriorityRef[],
  mergedBranchNames: ReadonlySet<string>,
): RepositoryWorkspacePriorityRef[] {
  return [...workspaces].sort((left, right) => {
    const statusOrder =
      branchStatusPriority(left.activeSessionStatus) - branchStatusPriority(right.activeSessionStatus);
    if (statusOrder !== 0) {
      return statusOrder;
    }

    const mergedOrder = mergedPriority(left, mergedBranchNames) - mergedPriority(right, mergedBranchNames);
    if (mergedOrder !== 0) {
      return mergedOrder;
    }

    const handledOrder = handledPriority(left.hasLocalUserMessages) - handledPriority(right.hasLocalUserMessages);
    if (handledOrder !== 0) {
      return handledOrder;
    }

    const updatedAtOrder = right.updatedAt.localeCompare(left.updatedAt);
    if (updatedAtOrder !== 0) {
      return updatedAtOrder;
    }

    return left.id.localeCompare(right.id);
  });
}
