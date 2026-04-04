import type { ConductorSessionRef, RepositoryRef, SessionMessageRecord, WorkspaceRef } from "../types.js";
import { stripOmittedBranchPrefix } from "./branch-name.js";

type ContextRenderMode = "preview" | "full";

interface ContextRenderLimits {
  rawMessage: number | null;
  structuredText: number | null;
  toolInput: number | null;
  toolResult: number | null;
  fallback: number | null;
}

const PREVIEW_CONTEXT_LIMITS: ContextRenderLimits = {
  rawMessage: 1400,
  structuredText: 1400,
  toolInput: 240,
  toolResult: 900,
  fallback: 900,
};

const FULL_CONTEXT_LIMITS: ContextRenderLimits = {
  rawMessage: null,
  structuredText: null,
  toolInput: 1200,
  toolResult: 2000,
  fallback: null,
};

export function truncate(input: string, max = 4000): string {
  if (input.length <= max) {
    return input;
  }
  return `${input.slice(0, Math.max(0, max - 1))}…`;
}

export function formatSessionTitle(title: string | null | undefined): string {
  const normalized = title?.trim();
  return normalized ? normalized : "Untitled";
}

export function formatSessionStatus(status: string): string {
  return status.replaceAll("_", " ");
}

export function formatSessionButtonLabel(session: Pick<ConductorSessionRef, "title">, index: number, max = 28): string {
  return truncate(`${index + 1}. ${formatSessionTitle(session.title)}`, max);
}

export function formatBranchName(workspace: Pick<WorkspaceRef, "branch" | "directoryName"> | null | undefined): string {
  if (!workspace) {
    return "No branch";
  }
  const branchName = workspace.branch?.trim();
  if (branchName) {
    return stripOmittedBranchPrefix(branchName);
  }
  const directoryName = workspace.directoryName.trim();
  return directoryName || "No branch";
}

export function formatWorkspaceOptionName(
  workspace: Pick<WorkspaceRef, "prTitle" | "activeSessionTitle" | "directoryName" | "branch"> | null | undefined,
): string {
  if (!workspace) {
    return "No workspace";
  }

  const prTitle = workspace.prTitle?.trim();
  if (prTitle) {
    return prTitle;
  }

  const activeSessionTitle = workspace.activeSessionTitle?.trim();
  if (activeSessionTitle) {
    return activeSessionTitle;
  }

  const directoryName = workspace.directoryName.trim();
  if (directoryName) {
    return directoryName;
  }

  return formatBranchName(workspace);
}

export function formatBranchButtonLabel(
  workspace: Pick<WorkspaceRef, "prTitle" | "activeSessionTitle" | "branch" | "directoryName">,
  index: number,
  max = 60,
): string {
  const branchName = formatBranchName(workspace);
  const workspaceName = formatWorkspaceOptionName(workspace);
  const label = workspaceName !== branchName ? `${branchName} · ${workspaceName}` : branchName;
  return truncate(`${index + 1}. ${label}`, max);
}

export function formatSessionPickerText(
  sessions: Array<Pick<ConductorSessionRef, "id" | "title" | "status">>,
  options?: {
    activeSessionId?: string | null | undefined;
    heading?: string | undefined;
    prefix?: string | undefined;
  },
): string {
  const blocks = sessions.map((session, index) => {
    const meta = [`Status: ${formatSessionStatus(session.status)}`];
    if (session.id === options?.activeSessionId) {
      meta.push("Current");
    }
    return [
      `${index + 1}. ${truncate(formatSessionTitle(session.title), 120)}`,
      meta.join(" · "),
      `ID: ${session.id.slice(0, 8)}`,
    ].join("\n");
  });

  return [options?.prefix, options?.heading ?? "Select a session:", ...blocks, "Tap a button below to choose."]
    .filter(Boolean)
    .join("\n\n");
}

export function formatBranchPickerText(
  workspaces: Array<Pick<WorkspaceRef, "id" | "prTitle" | "activeSessionTitle" | "branch" | "directoryName">>,
  options?: {
    activeWorkspaceId?: string | null | undefined;
    heading?: string | undefined;
    prefix?: string | undefined;
  },
): string {
  const blocks = workspaces.map((workspace, index) => {
    const branchName = formatBranchName(workspace);
    const workspaceName = formatWorkspaceOptionName(workspace);
    const meta: string[] = [];
    if (workspace.id === options?.activeWorkspaceId) {
      meta.push("Current");
    }

    const directoryName = workspace.directoryName.trim();
    const details =
      directoryName && directoryName !== workspaceName && directoryName !== branchName
        ? `Directory: ${directoryName}`
        : null;

    return [
      `${index + 1}. ${truncate(branchName, 120)}`,
      workspaceName !== branchName ? truncate(workspaceName, 120) : null,
      meta.join(" · ") || null,
      details,
    ]
      .filter(Boolean)
      .join("\n");
  });

  return [options?.prefix, options?.heading ?? "Select a branch:", ...blocks, "Tap a button below to choose."]
    .filter(Boolean)
    .join("\n\n");
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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function truncateContextBlock(input: string, max: number | null): string {
  if (max === null) {
    return input;
  }
  return truncate(input, max);
}

function formatPathLocation(fragment: string): string | null {
  const match = fragment.match(/^L(\d+)(?:C(\d+))?$/i);
  if (!match) {
    return null;
  }
  const line = match[1];
  const column = match[2];
  if (!line) {
    return null;
  }
  return column ? `${line}:${column}` : line;
}

function formatLocalPathReference(target: string): string | null {
  const trimmed = target.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const [rawFilePath, rawFragment] = trimmed.split("#", 2);
  const filePath = rawFilePath ?? "";
  const fragment = rawFragment ?? "";
  const segments = filePath.split("/").filter(Boolean);
  const fileName = segments.at(-1);
  if (!fileName) {
    return null;
  }

  const location = formatPathLocation(fragment);
  return location ? `${fileName}:${location}` : fileName;
}

function normalizeMarkdownLink(label: string, target: string): string {
  const cleanLabel = label.replace(/`/g, "").trim();
  const localReference = formatLocalPathReference(target);
  if (localReference) {
    if (!cleanLabel) {
      return localReference;
    }
    if (cleanLabel === localReference || localReference.startsWith(`${cleanLabel}:`)) {
      return localReference;
    }
    return `${cleanLabel} (${localReference})`;
  }

  return cleanLabel || target.trim();
}

function normalizeContextText(input: string): string {
  return input
    .replace(/@⟦([^⟧]+)⟧\(attachment:[^)]+\)/g, "[Attachment: $1]")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, target: string) =>
      normalizeMarkdownLink(label, target),
    )
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatContextTimestamp(sentAt: string | null): string | null {
  if (!sentAt) {
    return null;
  }
  return sentAt.length >= 16 ? sentAt.slice(0, 16).replace("T", " ") : sentAt;
}

function formatContextHeader(label: string, sentAt: string | null): string {
  const timestamp = formatContextTimestamp(sentAt);
  return timestamp ? `[${label} · ${timestamp}]` : `[${label}]`;
}

function summarizeToolInput(input: unknown, maxLength: number | null): string {
  const record = asRecord(input);
  const command = asString(record?.command);
  if (command) {
    return truncateContextBlock(command, maxLength);
  }

  const summary = normalizeContextText(extractHumanText(input));
  return summary ? truncateContextBlock(summary, maxLength) : "";
}

function formatStructuredMessageBlocks(content: unknown, limits: ContextRenderLimits): string[] {
  if (!Array.isArray(content)) {
    const fallback = normalizeContextText(extractHumanText(content));
    return fallback ? [truncateContextBlock(fallback, limits.fallback)] : [];
  }

  const lines: string[] = [];
  for (const item of content) {
    const record = asRecord(item);
    const blockType = asString(record?.type);

    if (blockType === "text") {
      const text = normalizeContextText(asString(record?.text) ?? "");
      if (text) {
        lines.push(truncateContextBlock(text, limits.structuredText));
      }
      continue;
    }

    if (blockType === "tool_use") {
      const toolName = asString(record?.name) ?? "tool";
      const inputSummary = summarizeToolInput(record?.input, limits.toolInput);
      lines.push(inputSummary ? `[Tool ${toolName}] ${inputSummary}` : `[Tool ${toolName}]`);
      continue;
    }

    if (blockType === "tool_result") {
      const result = normalizeContextText(extractHumanText(record?.content));
      if (!result) {
        if (record?.is_error === true) {
          lines.push("[Tool result error]");
        }
        continue;
      }
      lines.push(
        `[Tool result${record?.is_error === true ? " error" : ""}] ${truncateContextBlock(result, limits.toolResult)}`,
      );
      continue;
    }

    const fallback = normalizeContextText(extractHumanText(item));
    if (fallback) {
      lines.push(truncateContextBlock(fallback, limits.fallback));
    }
  }

  return lines;
}

export function formatSessionContextEntry(
  message: SessionMessageRecord,
  mode: ContextRenderMode = "preview",
): string | null {
  const limits = mode === "full" ? FULL_CONTEXT_LIMITS : PREVIEW_CONTEXT_LIMITS;
  const fallbackLabel = message.role === "user" ? "User" : "Assistant";
  const rawText = normalizeContextText(message.content);
  if (!rawText) {
    return null;
  }

  try {
    const parsed = JSON.parse(message.content) as unknown;
    const record = asRecord(parsed);
    const envelopeType = asString(record?.type);

    if (envelopeType === "system" || envelopeType === "result") {
      return null;
    }

    if (envelopeType === "error") {
      const errorText = normalizeContextText(extractHumanText(record?.content));
      return `${formatContextHeader("Error", message.sentAt)}\n${truncateContextBlock(
        errorText || "Unknown error",
        limits.fallback,
      )}`;
    }

    if (envelopeType === "assistant" || envelopeType === "user") {
      const nestedMessage = asRecord(record?.message);
      const lines = formatStructuredMessageBlocks(nestedMessage?.content, limits);
      if (lines.length === 0) {
        return null;
      }
      const label = envelopeType === "assistant" ? "Assistant" : "User";
      return `${formatContextHeader(label, message.sentAt)}\n${lines.join("\n\n")}`;
    }
  } catch {
    // Not JSON; fall back to the raw message content below.
  }

  return `${formatContextHeader(fallbackLabel, message.sentAt)}\n${truncateContextBlock(rawText, limits.rawMessage)}`;
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

export function formatRepositoryLabel(
  repository: Pick<RepositoryRef, "repositoryName"> | Pick<WorkspaceRef, "repositoryName"> | null | undefined,
): string {
  const repositoryName = repository?.repositoryName?.trim();
  return repositoryName || "No workspace";
}

export function formatPlan(plan: Array<{ step: string; status: string }>, explanation?: string | null): string {
  const lines: string[] = [];
  if (explanation) {
    lines.push(explanation.trim());
    lines.push("");
  }
  for (const item of plan) {
    const normalizedStatus = item.status.trim().toLowerCase();
    const marker =
      normalizedStatus === "completed"
        ? "x"
        : normalizedStatus === "inprogress" || normalizedStatus === "in_progress"
          ? "~"
          : " ";
    lines.push(`- [${marker}] ${item.step}`);
  }
  return lines.join("\n").trim();
}
