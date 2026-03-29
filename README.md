# Telegram Conductor Bridge

在手机上的 Telegram 私聊里控制本机 Conductor，当前版本支持：

- 浏览 workspace
- 浏览并切换 session
- 继续已有 Codex session
- 在当前 workspace 下创建新的 Conductor session
- 基础队列
- 基础流式文本回推
- 基础 `requestUserInput` / plan 反馈

## Prerequisites

- macOS 上已经安装并使用过 Conductor
- 本机存在 Conductor DB：
  `~/Library/Application Support/com.conductor.app/conductor.db`
- 本机存在 Codex 二进制：
  `~/Library/Application Support/com.conductor.app/bin/codex`
- 有一个 Telegram Bot token

## Setup

1. 安装依赖

```bash
npm install
```

2. 复制环境变量模板并填写

```bash
cp .env.example .env
```

3. 至少设置这两个变量

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ALLOWED_CHAT_IDS`

`TELEGRAM_ALLOWED_CHAT_IDS` 填你自己的 Telegram chat id，多个用逗号分隔。

默认 `BRIDGE_DB_PATH` 是 `.context/bridge.db`。当前版本会在启动时自动创建这个目录，不需要你手动先建 `.context/`。

## Run

```bash
npm start
```

开发模式：

```bash
npm run dev
```

## Telegram Commands

- `/start`
- `/home`
- `/workspaces`
- `/sessions`
- `/status`
- `/queue`
- `/new`
- `/help`

## Basic Flow

1. 在 Telegram 私聊 bot，输入 `/start`
2. 点 `Switch Workspace`
3. 选一个 workspace
4. 点 `Switch Session`
5. 选一个已有 session
6. 直接发文本，bridge 会把它继续发到当前 session

创建新 session：

1. 先选定 workspace
2. 点 `New Chat Here` 或发 `/new`
3. 下一条文本会创建一个新的 Conductor session，并自动切过去

## Notes

- 当前版本只支持单用户、单私聊
- 当前版本只支持 Codex session
- 若 `TELEGRAM_BOT_TOKEN` 未设置，进程不会启动
- 若 token 无效，bridge 会启动，但 Telegram long polling 会持续返回 401
