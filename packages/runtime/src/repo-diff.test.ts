import { describe, expect, test } from "bun:test";

import { getRepoDiffSnapshot, type RepoDiffResponse } from "./repo-diff/index.js";

function nativeResponse(worktree: string): RepoDiffResponse {
  return {
    schema: "openscout.repo.diff/v1",
    generatedAt: 1_780_000_000_000,
    worktreePath: worktree,
    layers: [
      {
        kind: "unstaged",
        baseLabel: "index",
        compareLabel: "working tree",
        command: ["git", "diff", "--no-color"],
        patchOid: "abc123",
        rawPatch: "diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new\n",
        rawPatchBytes: 42,
        truncated: false,
        files: [
          {
            oldPath: "x",
            newPath: "x",
            status: "modified",
            oldOid: null,
            newOid: null,
            oldMode: "100644",
            newMode: "100644",
            similarity: null,
            binary: false,
            additions: 1,
            deletions: 1,
            hunks: [],
            truncated: false,
          },
        ],
        shortstat: "1 file changed, 1 insertion(+), 1 deletion(-)",
      },
    ],
    coverage: {
      requestedLayers: 1,
      emittedLayers: 1,
      files: 1,
      patchBytes: 42,
      truncatedLayers: 0,
      scanBudgetReached: false,
    },
    diagnostics: [],
  };
}

describe("getRepoDiffSnapshot", () => {
  test("wraps native diff facts with scout context and render hints", async () => {
    const worktree = "/tmp/openscout-diff-demo";
    let captured: unknown = null;

    const snapshot = await getRepoDiffSnapshot({
      worktreePath: worktree,
      layers: ["unstaged"],
      hints: [
        {
          path: worktree,
          source: "endpoint",
          agentId: "agent.codex",
          agentName: "Codex",
          agentState: "active",
          sessionId: "session-1",
          harness: "codex",
        },
        {
          // A hint for an unrelated repo must not leak into this worktree.
          path: "/tmp/some-other-repo",
          source: "endpoint",
          agentId: "agent.other",
          sessionId: "session-2",
        },
      ],
      nativeDiff: async (request) => {
        captured = request;
        return nativeResponse(worktree);
      },
    });

    // Request shape handed to the native binary.
    expect(captured).toMatchObject({
      schema: "openscout.repo.diff.request/v1",
      worktreePath: worktree,
      layers: ["unstaged"],
    });

    // Raw facts are preserved verbatim.
    expect(snapshot.schema).toBe("openscout.repo.diff/v1");
    expect(snapshot.layers[0]!.patchOid).toBe("abc123");
    expect(snapshot.layers[0]!.files[0]!.status).toBe("modified");

    // Only the worktree-matching hint contributes Scout context.
    expect(snapshot.scout.agents.map((agent) => agent.id)).toEqual(["agent.codex"]);
    expect(snapshot.scout.sessions.map((session) => session.id)).toEqual(["session-1"]);
    expect(snapshot.scout.hints).toHaveLength(1);
    expect(snapshot.scout.worktreeId).toBeTruthy();

    // Render hints for the local Pierre cache.
    expect(snapshot.render.cachePolicy).toBe("local-disposable");
    expect(snapshot.render.preferredLayout).toBe("split");
    expect(snapshot.render.renderKey).toBeTruthy();
  });

  test("render key is stable for identical content and shifts when patch content changes", async () => {
    const worktree = "/tmp/openscout-diff-demo";
    const base = nativeResponse(worktree);
    const first = await getRepoDiffSnapshot({
      worktreePath: worktree,
      nativeDiff: async () => base,
    });
    const same = await getRepoDiffSnapshot({
      worktreePath: worktree,
      nativeDiff: async () => base,
    });
    const changed = await getRepoDiffSnapshot({
      worktreePath: worktree,
      nativeDiff: async () => ({
        ...base,
        layers: [{ ...base.layers[0]!, patchOid: "different-oid" }],
      }),
    });

    expect(first.render.renderKey).toBe(same.render.renderKey);
    expect(first.render.renderKey).not.toBe(changed.render.renderKey);
  });

  test("resolves branch layer refs to merge-base and head commits", async () => {
    const worktree = "/tmp/openscout-diff-demo";
    let captured: unknown = null;
    const snapshot = await getRepoDiffSnapshot({
      worktreePath: worktree,
      layers: ["branch"],
      git: {
        revParse: async (input) => {
          if (input.kind === "verifyCommit" && input.ref === "HEAD") return "head-sha";
          if (input.kind === "verifyCommit" && input.ref === "origin/main") return "trunk-sha";
          return null;
        },
        mergeBase: async (input) => {
          if (input.baseRef === "trunk-sha" && input.compareRef === "head-sha") return "base-sha";
          return null;
        },
      },
      nativeDiff: async (request) => {
        captured = request;
        return {
          ...nativeResponse(worktree),
          layers: [{
            ...nativeResponse(worktree).layers[0]!,
            kind: "branch",
            baseLabel: "base-sha",
            compareLabel: "head-sha",
          }],
        };
      },
    });

    expect(captured).toMatchObject({
      layers: ["branch"],
      baseRef: "base-sha",
      compareRef: "head-sha",
    });
    expect(snapshot.layers[0]?.kind).toBe("branch");
  });
});
