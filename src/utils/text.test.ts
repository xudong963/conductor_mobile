import { describe, expect, it } from "vitest";
import {
  extractHumanText,
  formatPlan,
  formatSessionButtonLabel,
  formatSessionContextEntry,
  formatSessionPickerText,
  formatSessionStatus,
  formatStatusLine,
  sanitizeSessionTitle,
  truncate,
} from "./text.js";

describe("truncate", () => {
  it("returns short strings unchanged", () => {
    expect(truncate("hello")).toBe("hello");
  });

  it("truncates long strings with ellipsis", () => {
    const result = truncate("abcdef", 4);
    expect(result).toBe("abc…");
    expect(result.length).toBe(4);
  });
});

describe("formatSessionStatus", () => {
  it("humanizes underscored statuses", () => {
    expect(formatSessionStatus("needs_user_input")).toBe("needs user input");
  });
});

describe("formatSessionButtonLabel", () => {
  it("numbers and truncates button labels", () => {
    expect(formatSessionButtonLabel({ title: "A very long session title that keeps going" }, 1, 18)).toBe(
      "2. A very long se…",
    );
  });

  it("falls back to Untitled", () => {
    expect(formatSessionButtonLabel({ title: null }, 0, 20)).toBe("1. Untitled");
  });
});

describe("formatSessionPickerText", () => {
  it("renders session previews with current marker", () => {
    const result = formatSessionPickerText(
      [
        { id: "session-12345678", title: "Continue session chat", status: "idle" },
        { id: "session-abcdef12", title: null, status: "needs_user_input" },
      ],
      {
        activeSessionId: "session-12345678",
        prefix: "已切换到 workspace：demo",
      },
    );

    expect(result).toContain("已切换到 workspace：demo");
    expect(result).toContain("1. Continue session chat");
    expect(result).toContain("状态: idle · 当前");
    expect(result).toContain("2. Untitled");
    expect(result).toContain("状态: needs user input");
    expect(result).toContain("ID: session-");
    expect(result).toContain("点下方按钮选择。");
  });
});

describe("sanitizeSessionTitle", () => {
  it("returns first non-empty line trimmed", () => {
    expect(sanitizeSessionTitle("  hello world  \nsecond line")).toBe("hello world");
  });

  it("returns Untitled for empty input", () => {
    expect(sanitizeSessionTitle("")).toBe("Untitled");
    expect(sanitizeSessionTitle("   \n  ")).toBe("Untitled");
  });

  it("truncates to 48 chars", () => {
    const long = "a".repeat(100);
    expect(sanitizeSessionTitle(long).length).toBe(48);
  });
});

describe("extractHumanText", () => {
  it("returns strings as-is", () => {
    expect(extractHumanText("hello")).toBe("hello");
  });

  it("returns empty string for null/undefined", () => {
    expect(extractHumanText(null)).toBe("");
    expect(extractHumanText(undefined)).toBe("");
  });

  it("extracts from preferred keys", () => {
    expect(extractHumanText({ text: "found" })).toBe("found");
    expect(extractHumanText({ content: "found" })).toBe("found");
  });

  it("joins array elements", () => {
    expect(extractHumanText(["a", "b"])).toBe("a\nb");
  });
});

describe("formatStatusLine", () => {
  it("formats all parts", () => {
    expect(formatStatusLine("ws", "sess", "running")).toBe("ws / sess / running");
  });

  it("uses defaults for nulls", () => {
    expect(formatStatusLine(null, null, null)).toBe("No workspace / No session / idle");
  });
});

describe("formatPlan", () => {
  it("formats plan steps with markers", () => {
    const plan = [
      { step: "step1", status: "completed" },
      { step: "step2", status: "inProgress" },
      { step: "step3", status: "pending" },
    ];
    const result = formatPlan(plan);
    expect(result).toContain("[x] step1");
    expect(result).toContain("[~] step2");
    expect(result).toContain("[ ] step3");
  });

  it("includes explanation when provided", () => {
    const result = formatPlan([{ step: "s", status: "pending" }], "Why this plan");
    expect(result).toMatch(/^Why this plan/);
  });
});

describe("formatSessionContextEntry", () => {
  it("formats raw user messages", () => {
    const result = formatSessionContextEntry({
      role: "user",
      content: "hello world",
      sentAt: "2026-03-29T10:23:00.000Z",
      turnId: null,
      model: null,
    });

    expect(result).toContain("[User");
    expect(result).toContain("hello world");
  });

  it("formats structured assistant text", () => {
    const result = formatSessionContextEntry({
      role: "assistant",
      content: JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "working on it" }],
        },
      }),
      sentAt: "2026-03-29T10:24:00.000Z",
      turnId: "turn-1",
      model: "gpt-5",
    });

    expect(result).toContain("[Assistant");
    expect(result).toContain("working on it");
  });

  it("formats tool calls and tool results", () => {
    const toolUse = formatSessionContextEntry({
      role: "assistant",
      content: JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Bash", input: { command: "git status" } }],
        },
      }),
      sentAt: null,
      turnId: "turn-1",
      model: "gpt-5",
    });
    const toolResult = formatSessionContextEntry({
      role: "assistant",
      content: JSON.stringify({
        type: "user",
        message: {
          content: [{ type: "tool_result", content: "clean", is_error: false }],
        },
      }),
      sentAt: null,
      turnId: "turn-1",
      model: "gpt-5",
    });

    expect(toolUse).toContain("[Tool Bash] git status");
    expect(toolResult).toContain("[Tool result] clean");
  });

  it("skips internal system records", () => {
    const result = formatSessionContextEntry({
      role: "assistant",
      content: JSON.stringify({ type: "system" }),
      sentAt: null,
      turnId: null,
      model: null,
    });

    expect(result).toBeNull();
  });
});
