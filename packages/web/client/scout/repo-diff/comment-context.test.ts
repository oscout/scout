import { describe, expect, test } from "bun:test";

import {
  buildRepoDiffCommentBody,
  defaultRepoDiffCommentTarget,
  repoDiffContextSnippet,
  repoDiffCommentTargets,
} from "./comment-context.ts";
import type { ScoutRepoDiffSnapshot } from "./types.ts";

function snapshot(overrides: Partial<ScoutRepoDiffSnapshot> = {}): ScoutRepoDiffSnapshot {
  return {
    schema: "openscout.repo.diff/v1",
    generatedAt: 1_780_000_000_000,
    worktreePath: "/Users/art/dev/openscout",
    coverage: {
      requestedLayers: 2,
      emittedLayers: 2,
      files: 2,
      patchBytes: 1234,
      truncatedLayers: 0,
      scanBudgetReached: false,
    },
    diagnostics: [],
    layers: [
      {
        kind: "unstaged",
        baseLabel: null,
        compareLabel: "worktree",
        command: ["git", "diff"],
        patchOid: "patch-unstaged",
        rawPatch: null,
        rawPatchBytes: 0,
        truncated: false,
        shortstat: null,
        files: [{
          oldPath: "packages/web/client/App.tsx",
          newPath: "packages/web/client/App.tsx",
          status: "modified",
          oldOid: null,
          newOid: null,
          oldMode: null,
          newMode: null,
          similarity: null,
          binary: false,
          additions: 12,
          deletions: 3,
          hunks: [],
          truncated: false,
        }],
      },
      {
        kind: "staged",
        baseLabel: null,
        compareLabel: "index",
        command: ["git", "diff", "--cached"],
        patchOid: "patch-staged",
        rawPatch: null,
        rawPatchBytes: 0,
        truncated: false,
        shortstat: null,
        files: [],
      },
    ],
    scout: {
      worktreeId: "wt-openscout",
      projectId: "project-openscout",
      agents: [
        { id: "agent-idle", name: "Idle Agent", state: "idle", harness: "codex" },
        { id: "agent-active", name: "Active Agent", state: "active", harness: "claude" },
      ],
      sessions: [{ id: "session-active", source: "codex", harness: "codex" }],
      hints: [{ path: "/Users/art/dev/openscout", source: "endpoint", agentId: "agent-idle" }],
    },
    render: {
      renderKey: "render-key",
      cachePolicy: "local-disposable",
      preferredTheme: "github-dark",
      preferredLayout: "split",
    },
    ...overrides,
  };
}

describe("repo diff comment context", () => {
  test("prefers the scoped session agent over another active agent", () => {
    const targets = repoDiffCommentTargets(snapshot({
      scope: {
        kind: "session",
        label: "Codex session",
        worktreePath: "/Users/art/dev/openscout",
        refId: null,
        agentId: "agent-idle",
        sessionId: "session-idle",
        filteredPaths: ["packages/web/client/App.tsx"],
        touchedFiles: 4,
        changedFiles: 1,
        include: "changed",
        caveat: "path-filtered-not-hunk-provenance",
      },
    }));

    expect(targets.map((target) => target.id)).toEqual(["agent-idle", "agent-active"]);
    expect(defaultRepoDiffCommentTarget(snapshot())?.id).toBe("agent-active");
  });

  test("builds a compact ask body with selected file and diff facts", () => {
    const sample = snapshot();
    const body = buildRepoDiffCommentBody({
      comment: "Please check whether this state change is the right fix.",
      snapshot: sample,
      activeLayer: "unstaged",
      selectedFile: sample.layers[0]!.files[0]!,
    });

    expect(body).toContain("Operator comment on repo diff:");
    expect(body).toContain("Please check whether this state change is the right fix.");
    expect(body).toContain("- Worktree: /Users/art/dev/openscout");
    expect(body).toContain("- Active layer: unstaged");
    expect(body).toContain("- Selected file: modified: packages/web/client/App.tsx (+12 -3)");
    expect(body).toContain("- Layers: unstaged: 1 file, +12 -3; staged: 0 files, +0 -0");
    expect(body).toContain("- Attached agents: @idle-agent, @active-agent");
  });

  test("formats a compact snippet for include-in-comment actions", () => {
    const sample = snapshot({
      scope: {
        kind: "session",
        label: "Codex session",
        worktreePath: "/Users/art/dev/openscout",
        refId: "ref-1",
        agentId: "agent-active",
        sessionId: "session-active",
        filteredPaths: ["packages/web/client/App.tsx"],
        touchedFiles: 2,
        changedFiles: 1,
        include: "changed",
        caveat: "path-filtered-not-hunk-provenance",
      },
    });

    expect(repoDiffContextSnippet({
      snapshot: sample,
      activeLayer: "unstaged",
      file: sample.layers[0]!.files[0]!,
    })).toBe(
      "[Diff context: unstaged · modified: packages/web/client/App.tsx (+12 -3) · session session-active]",
    );
  });
});
