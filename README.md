# Telegram Conductor Bridge

Control the local Conductor instance from Telegram. The current version supports:

- Browsing repos
- Browsing and switching branches with workspace descriptions
- Browsing and switching chats
- Continuing existing Codex sessions
- Creating a new Conductor chat on the current branch
- Automatically creating a Telegram topic for a new Conductor chat when the current conversation supports topics
- Basic queueing
- Streamed text updates on a reusable single-message status panel
- A single-message paginated context viewer
- Basic `requestUserInput` and plan feedback flows
- Telegram slash command syncing

## Prerequisites

- Conductor is already installed and has been used on macOS
- The local Conductor DB exists at:
  `~/Library/Application Support/com.conductor.app/conductor.db`
- The local Codex binary exists at:
  `~/Library/Application Support/com.conductor.app/bin/codex`
- A Telegram Bot token is available

## Setup

1. Install dependencies

```bash
npm install
```

2. Copy the environment template and fill it in

```bash
cp .env.example .env
```

3. Set at least these two variables

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ALLOWED_CHAT_IDS`

Set `TELEGRAM_ALLOWED_CHAT_IDS` to the Telegram chat IDs that may use the bridge. Separate multiple IDs with commas.

`BRIDGE_DB_PATH` defaults to `.context/bridge.db`. The current version creates this directory on startup, so `.context/` does not need to exist in advance.

## Run

```bash
npm start
```

Development mode:

```bash
npm run dev
```

## Telegram Commands

- `/start` or `/home`: return to the home screen
- `/repos` or `/workspaces`: choose a repo
- `/branches`: choose a branch
- `/chats` or `/sessions`: choose a chat
- `/status`: open or refresh the current chat's single-message status panel
- `/queue`: inspect the current chat queue
- `/context [N]`: open a paginated single-message context viewer with older/newer, refresh, and close controls
- `/new`: make the next plain-text message create a new chat on the current branch
- `/help`: show help

On startup the bridge calls Telegram `setMyCommands`, so these slash commands also appear in the mobile command picker.

## Basic Flow

1. Open a private chat with the bot in Telegram, or a forum-enabled supergroup where the bot is present, and send `/start`
2. Tap `Switch Repo`
3. Select a repo
4. Tap `Switch Branch`
5. Select a branch in that repo
6. Tap `Switch Chat`
7. Select an existing chat
8. Send plain text and the bridge will continue the current chat
9. For a quick command reference, send `/help` or tap `Help` on the home screen

Create a new chat:

1. Select a repo and branch first
2. Tap `New Chat Here` or send `/new`
3. Your next message will create a new Conductor chat and switch to it automatically
4. If the current Telegram conversation supports topics, the bridge also creates a dedicated topic for that new chat and sends follow-up updates there

## Output Model

- `/status` creates or refreshes a reusable status panel; subsequent runtime output edits that same message instead of appending a new one.
- `/context [N]` opens a separate context preview card; paging and refresh actions only update that single message.
- In topic-enabled chats, both panels are scoped to the current topic instead of the whole Telegram chat.
- Both the status panel and the context preview can be closed to keep the Telegram chat tidy.

## Notes

- The current version supports a single user across the allowed Telegram chats
- The current version only supports Codex sessions
- The process will not start if `TELEGRAM_BOT_TOKEN` is not set
- If the token is invalid, the bridge starts but Telegram long polling will keep returning `401`
