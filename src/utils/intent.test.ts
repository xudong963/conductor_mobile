import { describe, expect, it } from "vitest";

import { isStatusProbeText } from "./intent.js";

describe("isStatusProbeText", () => {
  it("matches short status prompts in English", () => {
    expect(isStatusProbeText("status")).toBe(true);
    expect(isStatusProbeText("What's the current status?")).toBe(true);
    expect(isStatusProbeText("progress...")).toBe(true);
  });

  it("matches short status prompts in Chinese", () => {
    expect(isStatusProbeText("目前什么状态")).toBe(true);
    expect(isStatusProbeText("现在什么状态？")).toBe(true);
    expect(isStatusProbeText("进度如何")).toBe(true);
  });

  it("rejects ordinary prompts", () => {
    expect(isStatusProbeText("帮我看看目前什么状态，然后继续把登录页做完")).toBe(false);
    expect(isStatusProbeText("Build a status page for the dashboard")).toBe(false);
    expect(isStatusProbeText("")).toBe(false);
  });
});
