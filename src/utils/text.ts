import type { ConductorSessionRef, SessionMessageRecord, WorkspaceRef } from "../types.js";

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

export function formatSessionPickerText(
  sessions: Array<Pick<ConductorSessionRef, "id" | "title" | "status">>,
  options?: {
    activeSessionId?: string | null | undefined;
    heading?: string | undefined;
    prefix?: string | undefined;
  },
): string {
  const blocks = sessions.map((session, index) => {
    const meta = [`状态: ${formatSessionStatus(session.status)}`];
    if (session.id === options?.activeSessionId) {
      meta.push("当前");
    }
    return [
      `${index + 1}. ${truncate(formatSessionTitle(session.title), 120)}`,
      meta.join(" · "),
      `ID: ${session.id.slice(0, 8)}`,
    ].join("\n");
  });

  return [options?.prefix, options?.heading ?? "选择一个 session：", ...blocks, "点下方按钮选择。"]
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

function normalizeContextText(input: string): string {
  return input
    .replace(/@⟦([^⟧]+)⟧\(attachment:[^)]+\)/g, "[Attachment: $1]")
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

function summarizeToolInput(input: unknown): string {
  const record = asRecord(input);
  const command = asString(record?.command);
  if (command) {
    return truncate(command, 240);
  }

  const summary = normalizeContextText(extractHumanText(input));
  return summary ? truncate(summary, 240) : "";
}

function formatStructuredMessageBlocks(content: unknown): string[] {
  if (!Array.isArray(content)) {
    const fallback = normalizeContextText(extractHumanText(content));
    return fallback ? [truncate(fallback, 1400)] : [];
  }

  const lines: string[] = [];
  for (const item of content) {
    const record = asRecord(item);
    const blockType = asString(record?.type);

    if (blockType === "text") {
      const text = normalizeContextText(asString(record?.text) ?? "");
      if (text) {
        lines.push(truncate(text, 1400));
      }
      continue;
    }

    if (blockType === "tool_use") {
      const toolName = asString(record?.name) ?? "tool";
      const inputSummary = summarizeToolInput(record?.input);
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
      lines.push(`[Tool result${record?.is_error === true ? " error" : ""}] ${truncate(result, 900)}`);
      continue;
    }

    const fallback = normalizeContextText(extractHumanText(item));
    if (fallback) {
      lines.push(truncate(fallback, 900));
    }
  }

  return lines;
}

export function formatSessionContextEntry(message: SessionMessageRecord): string | null {
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
      return `${formatContextHeader("Error", message.sentAt)}\n${errorText || "Unknown error"}`;
    }

    if (envelopeType === "assistant" || envelopeType === "user") {
      const nestedMessage = asRecord(record?.message);
      const lines = formatStructuredMessageBlocks(nestedMessage?.content);
      if (lines.length === 0) {
        return null;
      }
      const label = envelopeType === "assistant" ? "Assistant" : "User";
      return `${formatContextHeader(label, message.sentAt)}\n${lines.join("\n\n")}`;
    }
  } catch {
    // Not JSON; fall back to the raw message content below.
  }

  return `${formatContextHeader(fallbackLabel, message.sentAt)}\n${truncate(rawText, 1400)}`;
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
