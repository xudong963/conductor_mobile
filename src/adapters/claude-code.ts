import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import readline from "node:readline";

import type { CodexNotification } from "../types.js";
import { logger } from "../utils/logger.js";
import { buildCodexChildEnv } from "./codex-app-server.js";

interface ResumeThreadOptions {
  threadId: string;
  cwd?: string | null;
  model?: string | null;
  allowMissingRollout?: boolean;
}

interface StartTurnOptions {
  threadId: string;
  input: string;
  cwd?: string | null;
  model?: string | null;
}

interface InterruptTurnOptions {
  threadId: string;
  turnId: string;
}

interface ClaudeToolState {
  id: string;
  index: number;
  inputJson: string;
  item: Record<string, unknown>;
  name: string;
}

interface ClaudeBlockState {
  currentText?: string;
  tool?: ClaudeToolState;
  type: "text" | "thinking" | "tool_use";
}

interface ActiveClaudeTurn {
  assistantText: string;
  blocks: Map<number, ClaudeBlockState>;
  child: ChildProcessWithoutNullStreams;
  cwd: string | null;
  interrupted: boolean;
  pendingTools: Map<string, ClaudeToolState>;
  resultSeen: boolean;
  rl: readline.Interface;
  threadId: string;
  turnId: string;
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

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function buildToolItem(toolName: string, rawInput: string): Record<string, unknown> {
  const input = parseJsonObject(rawInput);
  if (toolName === "Bash") {
    return {
      type: "commandExecution",
      command: asString(input?.command) ?? "command",
    };
  }
  if (toolName === "WebSearch") {
    return {
      type: "webSearch",
      query: asString(input?.query) ?? "query",
    };
  }
  return {
    type: "dynamicToolCall",
    server: "claude",
    tool: toolName,
    name: toolName,
  };
}

export class ClaudeCodeAdapter extends EventEmitter {
  private readonly activeTurns = new Map<string, ActiveClaudeTurn>();
  private readonly claudeBin: string;
  private readonly pendingNewSessions = new Set<string>();

  constructor(claudeBin: string) {
    super();
    this.claudeBin = claudeBin;
  }

  async start(): Promise<void> {
    return;
  }

  async stop(): Promise<void> {
    for (const turn of this.activeTurns.values()) {
      turn.interrupted = true;
      turn.child.kill("SIGTERM");
      turn.rl.close();
    }
    this.activeTurns.clear();
  }

  async startThread(): Promise<string> {
    return randomUUID();
  }

  async resumeThread(options: ResumeThreadOptions): Promise<void> {
    if (options.allowMissingRollout) {
      this.pendingNewSessions.add(options.threadId);
    }
  }

  async archiveThread(): Promise<void> {
    return;
  }

  async startTurn(options: StartTurnOptions): Promise<{ turnId: string }> {
    const turnId = randomUUID();
    const args = [
      "-p",
      "--verbose",
      "--output-format=stream-json",
      "--include-partial-messages",
      "--permission-mode",
      "bypassPermissions",
      ...(options.model ? ["--model", options.model] : []),
      ...(this.pendingNewSessions.delete(options.threadId)
        ? ["--session-id", options.threadId]
        : ["--resume", options.threadId]),
      options.input,
    ];

    const child = spawn(this.claudeBin, args, {
      cwd: options.cwd ?? undefined,
      env: buildCodexChildEnv(process.env),
      stdio: ["pipe", "pipe", "pipe"],
    });

    const rl = readline.createInterface({ input: child.stdout });
    const turn: ActiveClaudeTurn = {
      assistantText: "",
      blocks: new Map(),
      child,
      cwd: options.cwd ?? null,
      interrupted: false,
      pendingTools: new Map(),
      resultSeen: false,
      rl,
      threadId: options.threadId,
      turnId,
    };
    this.activeTurns.set(options.threadId, turn);

    child.stderr.on("data", (buf) => {
      const text = buf.toString("utf8").trim();
      if (!text) {
        return;
      }
      logger.debug("claude stderr", text);
    });
    rl.on("line", (line) => this.onLine(turn, line));

    child.on("exit", (code, signal) => {
      if (turn.resultSeen) {
        return;
      }
      const message = turn.interrupted
        ? "Interrupted."
        : `claude exited unexpectedly (${code ?? "null"}, ${signal ?? "null"})`;
      void this.completeTurn(turn, "failed", message);
    });
    child.on("error", (error) => {
      if (turn.resultSeen) {
        return;
      }
      void this.completeTurn(turn, "failed", error instanceof Error ? error.message : String(error));
    });

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });

    this.emitNotification("turn/started", {
      threadId: options.threadId,
      turn: {
        id: turnId,
      },
    });

    return { turnId };
  }

  async steerTurn(): Promise<void> {
    throw new Error("Claude sessions do not support steerTurn via the bridge.");
  }

  async interruptTurn(options: InterruptTurnOptions): Promise<void> {
    const active = this.activeTurns.get(options.threadId);
    if (!active || active.turnId !== options.turnId) {
      throw new Error(`No active Claude turn for ${options.threadId}/${options.turnId}`);
    }
    active.interrupted = true;
    active.child.kill("SIGTERM");
  }

  async respond(): Promise<void> {
    throw new Error("Claude sessions do not support respond via the bridge.");
  }

  async respondError(): Promise<void> {
    throw new Error("Claude sessions do not support respondError via the bridge.");
  }

  private emitNotification(method: string, params: Record<string, unknown>): void {
    const notification: CodexNotification = { method, params };
    this.emit("notification", notification);
  }

  private onLine(turn: ActiveClaudeTurn, line: string): void {
    const payload = parseJsonObject(line);
    if (!payload) {
      logger.warn("failed to parse claude stream-json line", { line });
      return;
    }

    const type = asString(payload.type);
    if (!type) {
      return;
    }

    if (type === "stream_event") {
      this.handleStreamEvent(turn, asRecord(payload.event));
      return;
    }

    if (type === "user") {
      this.handleUserEvent(turn, payload);
      return;
    }

    if (type === "result") {
      const isError = payload.is_error === true || asString(payload.subtype) !== "success";
      const message = asString(payload.result) ?? (turn.interrupted ? "Interrupted." : "Execution failed.");
      void this.completeTurn(turn, isError ? "failed" : "completed", message);
    }
  }

  private handleStreamEvent(turn: ActiveClaudeTurn, event: Record<string, unknown> | null): void {
    if (!event) {
      return;
    }

    const eventType = asString(event.type);
    if (!eventType) {
      return;
    }

    if (eventType === "content_block_start") {
      const index = typeof event.index === "number" ? event.index : null;
      const block = asRecord(event.content_block);
      const blockType = asString(block?.type);
      if (index === null || !blockType) {
        return;
      }

      if (blockType === "text") {
        turn.blocks.set(index, { currentText: "", type: "text" });
        this.emitNotification("item/started", {
          threadId: turn.threadId,
          turnId: turn.turnId,
          item: { type: "agentMessage" },
        });
        return;
      }

      if (blockType === "thinking") {
        turn.blocks.set(index, { type: "thinking" });
        this.emitNotification("item/started", {
          threadId: turn.threadId,
          turnId: turn.turnId,
          item: { type: "reasoning" },
        });
        return;
      }

      if (blockType === "tool_use") {
        const name = asString(block?.name) ?? "tool";
        const toolState: ClaudeToolState = {
          id: asString(block?.id) ?? `${turn.turnId}:${index}`,
          index,
          inputJson: "",
          item: {
            type: "dynamicToolCall",
            server: "claude",
            tool: name,
            name,
          },
          name,
        };
        turn.blocks.set(index, { tool: toolState, type: "tool_use" });
        this.emitNotification("item/started", {
          threadId: turn.threadId,
          turnId: turn.turnId,
          item: toolState.item,
        });
      }
      return;
    }

    if (eventType === "content_block_delta") {
      const index = typeof event.index === "number" ? event.index : null;
      const delta = asRecord(event.delta);
      const deltaType = asString(delta?.type);
      const block = index === null ? null : (turn.blocks.get(index) ?? null);
      if (!block || !deltaType) {
        return;
      }

      if (deltaType === "text_delta") {
        const text = asString(delta?.text) ?? "";
        if (!text) {
          return;
        }
        block.currentText = `${block.currentText ?? ""}${text}`;
        turn.assistantText += text;
        this.emitNotification("item/agentMessage/delta", {
          threadId: turn.threadId,
          turnId: turn.turnId,
          delta: text,
        });
        return;
      }

      if (deltaType === "input_json_delta" && block.tool) {
        block.tool.inputJson += asString(delta?.partial_json) ?? "";
      }
      return;
    }

    if (eventType === "content_block_stop") {
      const index = typeof event.index === "number" ? event.index : null;
      if (index === null) {
        return;
      }
      const block = turn.blocks.get(index);
      if (!block) {
        return;
      }
      turn.blocks.delete(index);

      if (block.type === "text") {
        if (turn.assistantText) {
          this.emitNotification("item/completed", {
            threadId: turn.threadId,
            turnId: turn.turnId,
            item: {
              type: "agentMessage",
              text: turn.assistantText,
            },
          });
        }
        return;
      }

      if (block.type === "thinking") {
        this.emitNotification("item/completed", {
          threadId: turn.threadId,
          turnId: turn.turnId,
          item: { type: "reasoning" },
        });
        return;
      }

      if (block.tool) {
        block.tool.item = buildToolItem(block.tool.name, block.tool.inputJson);
        turn.pendingTools.set(block.tool.id, block.tool);
        this.emitNotification("item/started", {
          threadId: turn.threadId,
          turnId: turn.turnId,
          item: block.tool.item,
        });
      }
    }
  }

  private handleUserEvent(turn: ActiveClaudeTurn, payload: Record<string, unknown>): void {
    const message = asRecord(payload.message);
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const item of content) {
      const record = asRecord(item);
      if (!record || asString(record.type) !== "tool_result") {
        continue;
      }
      const toolUseId = asString(record.tool_use_id);
      if (!toolUseId) {
        continue;
      }
      const tool = turn.pendingTools.get(toolUseId);
      if (!tool) {
        continue;
      }
      turn.pendingTools.delete(toolUseId);
      this.emitNotification("item/completed", {
        threadId: turn.threadId,
        turnId: turn.turnId,
        item: tool.item,
      });
    }
  }

  private async completeTurn(turn: ActiveClaudeTurn, status: "completed" | "failed", message: string): Promise<void> {
    if (turn.resultSeen) {
      return;
    }
    turn.resultSeen = true;
    turn.rl.close();
    this.activeTurns.delete(turn.threadId);

    if (status === "failed" && !turn.assistantText && message) {
      turn.assistantText = message;
    }

    this.emitNotification("turn/completed", {
      threadId: turn.threadId,
      turn: {
        error: status === "failed" ? { message } : null,
        id: turn.turnId,
        status,
      },
    });
  }
}
