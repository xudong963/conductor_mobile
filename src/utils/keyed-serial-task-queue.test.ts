import { describe, expect, it } from "vitest";

import { KeyedSerialTaskQueue } from "./keyed-serial-task-queue.js";

describe("KeyedSerialTaskQueue", () => {
  it("runs tasks for the same key in order", async () => {
    const queue = new KeyedSerialTaskQueue<string>();
    const steps: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.run("panel", async () => {
      steps.push("first:start");
      await firstGate;
      steps.push("first:end");
      return "first";
    });
    const second = queue.run("panel", async () => {
      steps.push("second:start");
      steps.push("second:end");
      return "second";
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(steps).toEqual(["first:start"]);

    releaseFirst?.();
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(steps).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  it("keeps draining the queue after a task fails", async () => {
    const queue = new KeyedSerialTaskQueue<string>();
    const steps: string[] = [];

    await expect(
      queue.run("panel", async () => {
        steps.push("first");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    await expect(
      queue.run("panel", async () => {
        steps.push("second");
        return "ok";
      }),
    ).resolves.toBe("ok");

    expect(steps).toEqual(["first", "second"]);
  });
});
