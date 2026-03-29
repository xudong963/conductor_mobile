# Telegram Conductor Bridge

Control the local Conductor instance from a Telegram private chat on your phone. The current version supports:

- Browsing repos
- Browsing and switching branches
- Browsing and switching chats
- Continuing existing Codex sessions
- Creating a new Conductor chat on the current branch
- Basic queueing
- Basic streamed text updates
- Basic `requestUserInput` and plan feedback flows

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

Set `TELEGRAM_ALLOWED_CHAT_IDS` to your own Telegram chat ID. Separate multiple IDs with commas.

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

- `/start`
- `/home`
- `/repos`
- `/branches`
- `/chats`
- `/workspaces`
- `/sessions`
- `/status`
- `/queue`
- `/context [N]`
- `/new`
- `/help`

## Basic Flow

1. Open a private chat with the bot in Telegram and send `/start`
2. Tap `Switch Repo`
3. Select a repo
4. Tap `Switch Branch`
5. Select a branch in that repo
6. Tap `Switch Chat`
7. Select an existing chat
8. Send plain text and the bridge will continue the current chat

Create a new chat:

1. Select a repo and branch first
2. Tap `New Chat Here` or send `/new`
3. Your next message will create a new Conductor chat and switch to it automatically

## Notes

- The current version supports a single user in a single private chat
- The current version only supports Codex sessions
- The process will not start if `TELEGRAM_BOT_TOKEN` is not set
- If the token is invalid, the bridge starts but Telegram long polling will keep returning `401`
