import type { ConductorSessionRef, RepositoryRef, TelegramInlineKeyboard, WorkspaceRef } from "../types.js";
import {
  formatBranchButtonLabel,
  formatRepositoryLabel,
  formatSessionButtonLabel,
  formatWorkspaceLabel,
} from "../utils/text.js";

export function homeKeyboard(options?: { showStop?: boolean; topicLocked?: boolean }): TelegramInlineKeyboard {
  if (options?.topicLocked) {
    const rows: TelegramInlineKeyboard = [
      [{ text: "Continue Here", callback_data: "home:continue" }],
      [{ text: "Help", callback_data: "home:help" }],
    ];
    if (options.showStop) {
      rows.splice(1, 0, [{ text: "Stop Current Turn", callback_data: "home:stop" }]);
    }
    return rows;
  }

  const rows: TelegramInlineKeyboard = [
    [
      { text: "Continue Here", callback_data: "home:continue" },
      { text: "New Chat Here", callback_data: "home:new" },
    ],
    [
      { text: "New Workspace", callback_data: "home:new-workspace" },
      { text: "Switch Repo", callback_data: "home:workspaces" },
    ],
    [
      { text: "Switch Branch", callback_data: "home:branches" },
      { text: "Switch Chat", callback_data: "home:sessions" },
    ],
    [
      { text: "Inbox", callback_data: "home:inbox" },
      { text: "Help", callback_data: "home:help" },
    ],
  ];
  if (options?.showStop) {
    rows.splice(1, 0, [{ text: "Stop Current Turn", callback_data: "home:stop" }]);
  }
  return rows;
}

export function workspacesKeyboard(workspaces: WorkspaceRef[]): TelegramInlineKeyboard {
  const repositoryCounts = new Map<string, number>();
  for (const workspace of workspaces) {
    repositoryCounts.set(workspace.repositoryName, (repositoryCounts.get(workspace.repositoryName) ?? 0) + 1);
  }

  const rows = workspaces.map((workspace) => [
    {
      text: formatWorkspaceLabel(workspace, {
        includeDirectory: (repositoryCounts.get(workspace.repositoryName) ?? 0) > 1,
      }),
      callback_data: `workspace:${workspace.id}`,
    },
  ]);
  rows.push([{ text: "Back", callback_data: "back:home" }]);
  return rows;
}

export function repositoriesKeyboard(repositories: RepositoryRef[]): TelegramInlineKeyboard {
  const rows = repositories.map((repository) => [
    {
      text: formatRepositoryLabel(repository),
      callback_data: `repo:${repository.id}`,
    },
  ]);
  rows.push([{ text: "Back", callback_data: "back:home" }]);
  return rows;
}

export function sessionsKeyboard(sessions: ConductorSessionRef[]): TelegramInlineKeyboard {
  const rows = sessions.map((session, index) => [
    {
      text: formatSessionButtonLabel(session, index),
      callback_data: `session:${session.id}`,
    },
  ]);
  rows.push([{ text: "Back", callback_data: "back:home" }]);
  return rows;
}

export function branchesKeyboard(
  workspaces: WorkspaceRef[],
  options?: { newWorkspaceRepositoryId?: string | null },
): TelegramInlineKeyboard {
  const rows = workspaces.map((workspace, index) => [
    {
      text: formatBranchButtonLabel(workspace, index),
      callback_data: `branch:${workspace.id}`,
    },
  ]);
  if (options?.newWorkspaceRepositoryId) {
    rows.push([{ text: "New Workspace Here", callback_data: `repo-new:${options.newWorkspaceRepositoryId}` }]);
  }
  rows.push([{ text: "Back", callback_data: "back:home" }]);
  return rows;
}

export function inboxKeyboard(sessions: ConductorSessionRef[]): TelegramInlineKeyboard {
  const rows = sessions.map((session) => [
    {
      text: `${session.status} · ${session.title ?? session.id.slice(0, 8)}`,
      callback_data: `session:${session.id}`,
    },
  ]);
  rows.push([
    { text: "Refresh", callback_data: "home:inbox" },
    { text: "Back", callback_data: "back:home" },
  ]);
  return rows;
}

function formatReasoningEffortButton(effort: string): string {
  switch (effort) {
    case "none":
      return "Off";
    case "minimal":
      return "Min";
    case "medium":
      return "Med";
    case "xhigh":
      return "XHigh";
    default:
      return effort[0]?.toUpperCase() + effort.slice(1);
  }
}

export function newSessionModelKeyboard(
  models: string[],
  selectedModel: string,
  efforts?: string[],
  selectedEffort?: string | null,
): TelegramInlineKeyboard {
  const rows: TelegramInlineKeyboard = [];
  for (let index = 0; index < models.length; index += 2) {
    rows.push(
      models.slice(index, index + 2).map((model) => ({
        text: `${model === selectedModel ? "[x]" : "[ ]"} ${model}`,
        callback_data: `new-model:${encodeURIComponent(model)}`,
      })),
    );
  }
  if (efforts && efforts.length > 0) {
    for (let index = 0; index < efforts.length; index += 3) {
      rows.push(
        efforts.slice(index, index + 3).map((effort) => ({
          text: `${effort === selectedEffort ? "[x]" : "[ ]"} ${formatReasoningEffortButton(effort)}`,
          callback_data: `new-effort:${encodeURIComponent(effort)}`,
        })),
      );
    }
  }
  rows.push([{ text: "Cancel", callback_data: "new:cancel" }]);
  return rows;
}

export function planKeyboard(): TelegramInlineKeyboard {
  return [
    [
      { text: "Approve Plan", callback_data: "plan:approve" },
      { text: "Revise Plan", callback_data: "plan:revise" },
    ],
    [{ text: "Back", callback_data: "back:home" }],
  ];
}

export function replyKeyboard(): TelegramInlineKeyboard {
  return [[{ text: "Reply Now", callback_data: "reply:now" }], [{ text: "Back", callback_data: "back:home" }]];
}
