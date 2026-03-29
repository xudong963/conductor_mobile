import type { ConductorSessionRef, TelegramInlineKeyboard, WorkspaceRef } from "../types.js";

export function homeKeyboard(): TelegramInlineKeyboard {
  return [
    [
      { text: "Continue Here", callback_data: "home:continue" },
      { text: "New Chat Here", callback_data: "home:new" },
    ],
    [
      { text: "Switch Session", callback_data: "home:sessions" },
      { text: "Switch Workspace", callback_data: "home:workspaces" },
    ],
    [{ text: "Inbox", callback_data: "home:inbox" }],
  ];
}

export function workspacesKeyboard(workspaces: WorkspaceRef[]): TelegramInlineKeyboard {
  const rows = workspaces.map((workspace) => [
    {
      text: workspace.directoryName,
      callback_data: `workspace:${workspace.id}`,
    },
  ]);
  rows.push([{ text: "Back", callback_data: "back:home" }]);
  return rows;
}

export function sessionsKeyboard(sessions: ConductorSessionRef[]): TelegramInlineKeyboard {
  const rows = sessions.map((session) => [
    {
      text: `${session.title ?? "Untitled"} (${session.status})`,
      callback_data: `session:${session.id}`,
    },
  ]);
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
  rows.push([{ text: "Refresh", callback_data: "home:inbox" }, { text: "Back", callback_data: "back:home" }]);
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
