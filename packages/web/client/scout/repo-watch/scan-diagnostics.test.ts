import { describe, expect, test } from "bun:test";

import { summarizeScanDiagnostics } from "./scan-diagnostics.ts";

describe("summarizeScanDiagnostics", () => {
  test("groups stale missing repo-watch path permutations by home root", () => {
    const diagnostics = summarizeScanDiagnostics([
      "Skipped missing repo-watch path: /Users/arach",
      "Skipped missing repo-watch path: /Users/arach/dev/action",
      "Skipped missing repo-watch path: /Users/arach/dev/arach.dev",
      "Skipped missing repo-watch path: /Users/arach/dev/arach.io",
      "Skipped missing repo-watch path: /Users/arach/dev/contextual",
      "Skipped unreadable worktree: /Users/art/dev/private",
    ]);

    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]).toMatchObject({
      message: "Skipped 5 missing repo-watch paths under /Users/arach/*. These look like stale broker hints.",
      examples: [
        "/Users/arach",
        "/Users/arach/dev/action",
        "/Users/arach/dev/arach.dev",
        "/Users/arach/dev/arach.io",
        "+1 more",
      ],
      rawCount: 5,
    });
    expect(diagnostics[1]).toMatchObject({
      message: "Skipped unreadable worktree: /Users/art/dev/private",
      rawCount: 1,
    });
  });

  test("keeps single missing paths explicit", () => {
    expect(summarizeScanDiagnostics([
      "Skipped missing repo-watch path: /Volumes/External/project",
    ])).toEqual([{
      message: "Skipped missing repo-watch path: /Volumes/External/project",
      examples: [],
      rawCount: 1,
    }]);
  });
});
