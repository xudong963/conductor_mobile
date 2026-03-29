import type { WorkspaceRef } from "../types.js";

export function truncate(input: string, max = 4000): string {
  if (input.length <= max) {
    return input;
  }
  return `${input.slice(0, Math.max(0, max - 1))}…`;
}

export function sanitizeSessionTitle(prompt: string): string {
  const first = prompt
    .split("\n")
    .map((x) => x.trim())
    .find(Boolean);
  if (!first) {
    return "Untitled";
  }
  return first.replace(/\s+/g, " ").slice(0, 48);
}

export function extractHumanText(payload: unknown): string {
  if (typeof payload === "string") {
    return payload;
  }
  if (payload === null || payload === undefined) {
    return "";
  }
  if (Array.isArray(payload)) {
    return payload
      .map((x) => extractHumanText(x))
      .filter(Boolean)
      .join("\n");
  }
  if (typeof payload === "object") {
    const maybe = payload as Record<string, unknown>;
    const preferredKeys = ["text", "message", "prompt", "question", "content"];
    const fromPreferred = preferredKeys
      .map((key) => maybe[key])
      .map((value) => extractHumanText(value))
      .find(Boolean);
    if (fromPreferred) {
      return fromPreferred;
    }
    return (
      Object.values(maybe)
        .map((value) => extractHumanText(value))
        .find(Boolean) ?? ""
    );
  }
  return String(payload);
}

export function formatStatusLine(
  workspaceName: string | null,
  sessionTitle: string | null,
  status: string | null,
): string {
  return `${workspaceName ?? "No workspace"} / ${sessionTitle ?? "No session"} / ${status ?? "idle"}`;
}

export function formatWorkspaceLabel(
  workspace: Pick<WorkspaceRef, "repositoryName" | "directoryName"> | null | undefined,
  options?: { includeDirectory?: boolean },
): string {
  if (!workspace) {
    return "No workspace";
  }

  const repositoryName = workspace.repositoryName.trim();
  const directoryName = workspace.directoryName.trim();
  if (!repositoryName) {
    return directoryName || "No workspace";
  }

  if (options?.includeDirectory && directoryName && directoryName !== repositoryName) {
    return `${repositoryName} [${directoryName}]`;
  }

  return repositoryName;
}

export function formatPlan(plan: Array<{ step: string; status: string }>, explanation?: string | null): string {
  const lines: string[] = [];
  if (explanation) {
    lines.push(explanation.trim());
    lines.push("");
  }
  for (const item of plan) {
    const marker = item.status === "completed" ? "x" : item.status === "inProgress" ? "~" : " ";
    lines.push(`- [${marker}] ${item.step}`);
  }
  return lines.join("\n").trim();
}
