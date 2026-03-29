import { describe, expect, it } from "vitest";
import { truncate, sanitizeSessionTitle, extractHumanText, formatStatusLine, formatPlan } from "./text.js";

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
