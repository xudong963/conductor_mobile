import { describe, expect, it } from "vitest";

import { normalizeTelegramCommand } from "./telegram-command.js";

describe("normalizeTelegramCommand", () => {
  it("strips bot mentions and trailing arguments from Telegram commands", () => {
    expect(normalizeTelegramCommand("/stop")).toBe("/stop");
    expect(normalizeTelegramCommand("/stop@conductor_coding_bot")).toBe("/stop");
    expect(normalizeTelegramCommand("/stop@conductor_coding_bot please")).toBe("/stop");
    expect(normalizeTelegramCommand("  /stop@conductor_coding_bot   please ")).toBe("/stop");
  });
});
