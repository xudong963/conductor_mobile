const OMITTED_BRANCH_PREFIX = "xudong963/";

export function stripOmittedBranchPrefix(branchName: string): string {
  const normalized = branchName.trim();
  if (!normalized) {
    return normalized;
  }
  return normalized.startsWith(OMITTED_BRANCH_PREFIX) ? normalized.slice(OMITTED_BRANCH_PREFIX.length) : normalized;
}

export function branchLookupCandidates(branchName: string): string[] {
  const normalized = branchName.trim();
  if (!normalized) {
    return [];
  }
  if (normalized.includes("/")) {
    return [normalized];
  }
  return [normalized, `${OMITTED_BRANCH_PREFIX}${normalized}`];
}

export function matchesRemoteBranchName(remoteRef: string, branchName: string): boolean {
  const normalizedRef = remoteRef.trim();
  const normalizedBranch = branchName.trim();
  if (!normalizedRef || !normalizedBranch) {
    return false;
  }

  const remoteSeparatorIndex = normalizedRef.indexOf("/");
  if (remoteSeparatorIndex < 0 || remoteSeparatorIndex === normalizedRef.length - 1) {
    return false;
  }

  return normalizedRef.slice(remoteSeparatorIndex + 1) === normalizedBranch;
}
