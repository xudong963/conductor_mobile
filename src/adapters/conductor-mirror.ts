import type { BridgeStateStore } from "../bridge/state-store.js";
import type { ConductorRegistryAdapter } from "./conductor-registry.js";
import type { SessionStatus } from "../types.js";

export class ConductorMirrorWriter {
  constructor(
    private readonly registry: ConductorRegistryAdapter,
    private readonly stateStore: BridgeStateStore,
  ) {}

  appendUserMessage(params: { sessionId: string; turnId: string; text: string; sentAt: string }): "ok" | "duplicate" {
    const fingerprint = this.stateStore.buildFingerprint(params.sessionId, params.turnId, "user", params.text);
    if (this.stateStore.hasFingerprint(fingerprint)) {
      return "duplicate";
    }

    this.registry.appendSessionMessage({
      sessionId: params.sessionId,
      role: "user",
      content: params.text,
      turnId: params.turnId,
      model: null,
      sentAt: params.sentAt,
    });
    this.stateStore.addFingerprint(fingerprint, params.sessionId, params.turnId, "user");
    this.registry.updateSessionLastUserMessageAt(params.sessionId, params.sentAt);
    return "ok";
  }

  appendAssistantMessage(params: {
    sessionId: string;
    threadId: string;
    turnId: string;
    text: string;
    sentAt: string;
    model: string | null;
  }): "ok" | "duplicate" {
    const content = JSON.stringify({
      type: "assistant",
      session_id: params.threadId,
      message: {
        role: "assistant",
        content: [{ type: "text", text: params.text }],
      },
    });
    const fingerprint = this.stateStore.buildFingerprint(params.sessionId, params.turnId, "assistant", content);
    if (this.stateStore.hasFingerprint(fingerprint)) {
      return "duplicate";
    }

    this.registry.appendSessionMessage({
      sessionId: params.sessionId,
      role: "assistant",
      content,
      turnId: params.turnId,
      model: params.model,
      sentAt: params.sentAt,
    });
    this.stateStore.addFingerprint(fingerprint, params.sessionId, params.turnId, "assistant");
    return "ok";
  }

  updateSessionStatus(sessionId: string, status: SessionStatus): void {
    this.registry.updateSessionStatus(sessionId, status);
  }
}
