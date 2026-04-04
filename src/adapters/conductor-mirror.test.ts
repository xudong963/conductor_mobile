import { describe, expect, it, vi } from "vitest";

import { ConductorMirrorWriter } from "./conductor-mirror.js";

describe("ConductorMirrorWriter", () => {
  it("stores Claude assistant messages using Claude-style structured content", () => {
    const registry = {
      appendSessionMessage: vi.fn(),
      updateSessionLastUserMessageAt: vi.fn(),
      updateSessionStatus: vi.fn(),
    };
    const stateStore = {
      addFingerprint: vi.fn(),
      buildFingerprint: vi.fn((_sessionId, _turnId, _role, content) => content),
      hasFingerprint: vi.fn().mockReturnValue(false),
    };

    const mirror = new ConductorMirrorWriter(registry as never, stateStore as never);

    mirror.appendAssistantMessage({
      agentType: "claude",
      sessionId: "session-1",
      threadId: "thread-1",
      turnId: "turn-1",
      text: "Hello from Claude",
      sentAt: "2026-04-04T07:40:00.000Z",
      model: "opus-1m",
    });

    expect(registry.appendSessionMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('"type":"assistant"'),
        model: "opus-1m",
        role: "assistant",
      }),
    );
    const content = registry.appendSessionMessage.mock.calls[0]?.[0]?.content;
    expect(content).toContain('"session_id":"thread-1"');
    expect(content).toContain('"type":"message"');
    expect(content).toContain("Hello from Claude");
  });
});
