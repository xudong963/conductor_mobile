import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";

import type { CodexNotification } from "../types.js";
import { logger } from "../utils/logger.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  method: string;
}

interface ServerRequestEnvelope {
  id: number | string;
  method: string;
  params: Record<string, unknown>;
}

interface StartThreadOptions {
  cwd: string;
  model: string;
}

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

interface SteerTurnOptions {
  threadId: string;
  expectedTurnId: string;
  input: string;
}

interface InterruptTurnOptions {
  threadId: string;
  turnId: string;
}

export class CodexAppServerAdapter extends EventEmitter {
  private process: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<number | string, PendingRequest>();
  private readonly codexBin: string;

  constructor(codexBin: string) {
    super();
    this.codexBin = codexBin;
  }

  async start(): Promise<void> {
    if (this.process) {
      return;
    }
    this.process = spawn(this.codexBin, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    this.process.stderr.on("data", (buf) => {
      const text = buf.toString("utf8").trim();
      if (!text) {
        return;
      }
      logger.debug("codex stderr", text);
    });

    this.process.on("exit", (code, signal) => {
      logger.warn("codex app-server exited", { code, signal });
      for (const [id, pending] of this.pending) {
        pending.reject(new Error(`codex app-server exited while waiting for ${pending.method} (${id})`));
      }
      this.pending.clear();
      this.process = null;
    });

    const rl = readline.createInterface({ input: this.process.stdout });
    rl.on("line", (line) => this.onLine(line));

    await this.request("initialize", {
      clientInfo: {
        name: "telegram-bridge",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
  }

  async stop(): Promise<void> {
    if (!this.process) {
      return;
    }
    this.process.kill("SIGTERM");
    this.process = null;
  }

  async startThread(options: StartThreadOptions): Promise<string> {
    const result = (await this.request("thread/start", {
      cwd: options.cwd,
      model: options.model,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    })) as { thread?: { id?: string } };
    const threadId = result?.thread?.id;
    if (!threadId) {
      throw new Error(`thread/start did not return thread.id: ${JSON.stringify(result)}`);
    }
    return threadId;
  }

  async resumeThread(options: ResumeThreadOptions): Promise<void> {
    try {
      await this.request("thread/resume", {
        threadId: options.threadId,
        cwd: options.cwd ?? null,
        model: options.model ?? null,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (options.allowMissingRollout && message.includes("no rollout found for thread id")) {
        return;
      }
      throw error;
    }
  }

  async archiveThread(threadId: string): Promise<void> {
    await this.request("thread/archive", { threadId });
  }

  async respond(id: number | string, result: Record<string, unknown>): Promise<void> {
    if (!this.process) {
      throw new Error("codex app-server is not started");
    }

    const payload = `${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`;
    await new Promise<void>((resolve, reject) => {
      this.process?.stdin.write(payload, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  async startTurn(options: StartTurnOptions): Promise<{ turnId: string }> {
    const response = (await this.request("turn/start", {
      threadId: options.threadId,
      cwd: options.cwd ?? null,
      model: options.model ?? null,
      input: [{ type: "text", text: options.input }],
    })) as { turn?: { id?: string } };

    const turnId = response?.turn?.id;
    if (!turnId) {
      throw new Error(`turn/start did not return turn.id: ${JSON.stringify(response)}`);
    }
    return { turnId };
  }

  async steerTurn(options: SteerTurnOptions): Promise<void> {
    await this.request("turn/steer", {
      threadId: options.threadId,
      expectedTurnId: options.expectedTurnId,
      input: [{ type: "text", text: options.input }],
    });
  }

  async interruptTurn(options: InterruptTurnOptions): Promise<void> {
    await this.request("turn/interrupt", {
      threadId: options.threadId,
      turnId: options.turnId,
    });
  }

  private onLine(line: string): void {
    if (!line.trim()) {
      return;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(line) as Record<string, unknown>;
    } catch (error) {
      logger.warn("failed to parse codex json line", { line, error });
      return;
    }

    const hasId = Object.prototype.hasOwnProperty.call(payload, "id");
    const hasMethod = typeof payload.method === "string";
    const id = (payload.id ?? null) as number | string | null;

    if (hasId && id !== null && this.pending.has(id)) {
      const pending = this.pending.get(id);
      if (!pending) {
        return;
      }
      this.pending.delete(id);
      if (payload.error) {
        pending.reject(new Error(JSON.stringify(payload.error)));
      } else {
        pending.resolve(payload.result);
      }
      return;
    }

    if (hasId && id !== null && hasMethod) {
      const params = (payload.params ?? {}) as Record<string, unknown>;
      const request: ServerRequestEnvelope = {
        id,
        method: payload.method as string,
        params,
      };
      this.emit("server-request", request);
      return;
    }

    if (hasMethod) {
      const params = (payload.params ?? {}) as Record<string, unknown>;
      const notification: CodexNotification = { method: payload.method as string, params };
      this.emit("notification", notification);
      return;
    }
  }

  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.process) {
      throw new Error("codex app-server is not started");
    }

    const id = `client-${this.nextId++}`;
    const requestPayload = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    const payload = `${JSON.stringify(requestPayload)}\n`;

    return await new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.process?.stdin.write(payload, (error) => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }
}
