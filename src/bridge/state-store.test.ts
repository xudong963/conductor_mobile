import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BridgeStateStore } from "./state-store.js";

const cleanups: Array<() => void> = [];

function createStore(): { store: BridgeStateStore; cleanup: () => void } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "state-store-test-"));
  const dbPath = path.join(tempDir, "bridge.db");
  const store = new BridgeStateStore(dbPath);
  store.init();

  const cleanup = () => {
    (store as unknown as { db: { close: () => void } }).db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  };

  cleanups.push(cleanup);
  return { store, cleanup };
}

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

describe("BridgeStateStore conversation contexts", () => {
  it("keeps root chats and topics isolated", () => {
    const { store } = createStore();
    const root = { chatId: 42, messageThreadId: null };
    const topic = { chatId: 42, messageThreadId: 9_001 };

    store.setConversationActiveWorkspace(root, "workspace-root");
    store.setConversationActiveSession(root, "session-root");
    store.setConversationActiveWorkspace(topic, "workspace-topic");
    store.setConversationActiveSession(topic, "session-topic");

    expect(store.getConversationContext(root)).toMatchObject({
      activeWorkspaceId: "workspace-root",
      activeSessionId: "session-root",
      messageThreadId: null,
    });
    expect(store.getConversationContext(topic)).toMatchObject({
      activeWorkspaceId: "workspace-topic",
      activeSessionId: "session-topic",
      messageThreadId: 9_001,
    });
  });

  it("lists all following conversations for a session", () => {
    const { store } = createStore();
    const root = { chatId: 42, messageThreadId: null };
    const topic = { chatId: 42, messageThreadId: 7 };

    store.setConversationActiveSession(root, "session-1");
    store.setConversationActiveSession(topic, "session-1");

    expect(store.listFollowingConversations("session-1")).toEqual([
      { chatId: 42, messageThreadId: null },
      { chatId: 42, messageThreadId: 7 },
    ]);
  });

  it("stores a dedicated topic per session and chat", () => {
    const { store } = createStore();
    const topic = { chatId: 42, messageThreadId: 7 };

    store.bindSessionTopic("session-1", topic);

    expect(store.getSessionTopic("session-1", 42)).toEqual(topic);
  });

  it("can bootstrap a topic binding from an existing following topic", () => {
    const { store } = createStore();
    const root = { chatId: 42, messageThreadId: null };
    const topic = { chatId: 42, messageThreadId: 8 };

    store.setConversationActiveSession(root, "session-1");
    store.setConversationActiveSession(topic, "session-1");

    expect(store.findFollowingTopic("session-1", 42)).toEqual(topic);
  });

  it("migrates legacy root chat contexts into conversation contexts", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "state-store-migrate-"));
    const dbPath = path.join(tempDir, "bridge.db");
    const firstStore = new BridgeStateStore(dbPath);
    firstStore.init();
    firstStore.setActiveWorkspace(42, "workspace-1");
    firstStore.setActiveSession(42, "session-1");
    (firstStore as unknown as { db: { close: () => void } }).db.close();

    const migratedStore = new BridgeStateStore(dbPath);
    migratedStore.init();

    const cleanup = () => {
      (migratedStore as unknown as { db: { close: () => void } }).db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    };
    cleanups.push(cleanup);

    expect(migratedStore.getConversationContext({ chatId: 42, messageThreadId: null })).toMatchObject({
      activeWorkspaceId: "workspace-1",
      activeSessionId: "session-1",
      followSessionId: "session-1",
      messageThreadId: null,
    });
  });

  it("requeues started prompts for retry", () => {
    const { store } = createStore();
    const promptId = store.enqueuePrompt("session-1", "thread-1", "normal", "Retry me");

    store.markPromptStarted(promptId);
    store.retryPrompt(promptId);

    expect(store.getNextQueuedPrompt("session-1")).toMatchObject({
      id: promptId,
      status: "queued",
      startedAt: null,
      finishedAt: null,
    });
  });
});
