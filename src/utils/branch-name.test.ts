import { describe, expect, it } from "vitest";

import { branchLookupCandidates, matchesRemoteBranchName, stripOmittedBranchPrefix } from "./branch-name.js";

describe("stripOmittedBranchPrefix", () => {
  it("removes the xudong963 prefix from branch labels", () => {
    expect(stripOmittedBranchPrefix("xudong963/berlin")).toBe("berlin");
  });

  it("leaves other branch names unchanged", () => {
    expect(stripOmittedBranchPrefix("feature/demo")).toBe("feature/demo");
  });
});

describe("branchLookupCandidates", () => {
  it("looks up simple branch names with and without the omitted prefix", () => {
    expect(branchLookupCandidates("berlin")).toEqual(["berlin", "xudong963/berlin"]);
  });

  it("does not alias already-qualified branch names", () => {
    expect(branchLookupCandidates("feature/demo")).toEqual(["feature/demo"]);
  });
});

describe("matchesRemoteBranchName", () => {
  it("matches the branch name after the remote name", () => {
    expect(matchesRemoteBranchName("origin/xudong963/berlin", "xudong963/berlin")).toBe(true);
  });

  it("does not match a prefixed branch when the requested branch is unqualified", () => {
    expect(matchesRemoteBranchName("origin/xudong963/berlin", "berlin")).toBe(false);
  });
});
