import { describe, expect, test } from "bun:test";

import { repoWatchUrl } from "./api.ts";

describe("repoWatchUrl", () => {
  test("quick scan is the light decoration query used by the code browser", () => {
    expect(repoWatchUrl("quick", false)).toBe("/api/repo-watch?includeDiff=1&native=0");
  });

  test("standard scan adds last-commit metadata without expanding the walk", () => {
    const url = repoWatchUrl("standard", false);
    expect(url).toContain("includeLastCommit=1");
    expect(url).not.toContain("maxRoots=");
    expect(url).not.toContain("scanBudgetMs=");
  });

  test("expanded scan raises root, worktree, and time budgets", () => {
    const url = repoWatchUrl("expanded", true);
    expect(url).toContain("maxRoots=32");
    expect(url).toContain("maxWorktrees=12");
    expect(url).toContain("scanBudgetMs=30000");
    expect(url).toContain("force=1");
  });
});
