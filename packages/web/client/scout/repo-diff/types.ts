/**
 * Repo Diff (SCO-065) — frontend types for the on-demand diff viewer.
 *
 * STRUCTURALLY IDENTICAL to the real backend contract exported from
 * `@openscout/runtime` (`packages/runtime/src/repo-diff/index.ts`). TypeScript
 * is structural, so a live `ScoutRepoDiffSnapshot` from the broker is assignable
 * to these and the viewer drops straight onto the real
 * `/api/repo-diff/worktree` response — no adapter, no reshaping. Keep this a
 * faithful mirror; if the runtime contract changes, change it here too.
 *
 * No Pierre/Shiki types live here (those are loaded at runtime; see ./pierre.ts).
 * No React here.
 */

import type {
  RepoWatchAgentRef,
  RepoWatchHintSummary,
  RepoWatchSessionRef,
} from "../repo-watch/types.ts";

/** Which diff layer a `RepoDiffLayer` describes. */
export type RepoDiffLayerKind = "unstaged" | "staged" | "branch";

/** Per-file change classification from the native `--raw` parse. */
export type RepoDiffFileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "typechange"
  | "conflict"
  | "unknown";

/** A single `@@ … @@` hunk summary (navigation/stat only; the body is parsed
 *  client-side from `RepoDiffLayer.rawPatch` by Pierre). */
export interface RepoDiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  section: string | null;
  additions: number;
  deletions: number;
  truncated: boolean;
}

/** One changed file's identity + summary. `binary` files carry a marker and no
 *  renderable hunks; `truncated` files were capped by the native budget. */
export interface RepoDiffFile {
  oldPath: string | null;
  newPath: string | null;
  status: RepoDiffFileStatus;
  oldOid: string | null;
  newOid: string | null;
  oldMode: string | null;
  newMode: string | null;
  similarity: number | null;
  binary: boolean;
  additions: number | null;
  deletions: number | null;
  hunks: RepoDiffHunk[];
  truncated: boolean;
}

/** One diff layer (unstaged / staged / branch). `rawPatch` is Git-compatible
 *  unified patch text fed to Pierre; null when the layer was excluded or capped.
 *  `truncated` means the native producer hit a byte/file budget. */
export interface RepoDiffLayer {
  kind: RepoDiffLayerKind;
  baseLabel: string | null;
  compareLabel: string | null;
  command: string[];
  patchOid: string;
  rawPatch: string | null;
  rawPatchBytes: number;
  truncated: boolean;
  files: RepoDiffFile[];
  shortstat: string | null;
}

export interface RepoDiffCoverage {
  requestedLayers: number;
  emittedLayers: number;
  files: number;
  patchBytes: number;
  truncatedLayers: number;
  scanBudgetReached: boolean;
}

export interface RepoDiffDiagnostic {
  level: "info" | "warning";
  kind: string;
  message: string;
  path: string | null;
}

/** The raw native facts (`openscout.repo.diff/v1`) before Scout context. */
export interface RepoDiffResponse {
  schema: "openscout.repo.diff/v1" | string;
  generatedAt: number;
  worktreePath: string;
  layers: RepoDiffLayer[];
  coverage: RepoDiffCoverage;
  diagnostics: RepoDiffDiagnostic[];
}

/** Scout-owned annotations joined onto the raw facts (read-only at v0). */
export interface RepoDiffScoutContext {
  worktreeId: string | null;
  projectId: string | null;
  agents: RepoWatchAgentRef[];
  sessions: RepoWatchSessionRef[];
  hints: RepoWatchHintSummary[];
}

/** Render hints. `renderKey` is a content-stable id used as the local Pierre
 *  cache key; `preferredTheme` is a Pierre/Shiki theme name. */
export interface RepoDiffRenderHints {
  renderKey: string;
  cachePolicy: "local-disposable";
  preferredTheme: string;
  preferredLayout: "split" | "stacked";
}

export type RepoDiffScope =
  | {
      kind: "worktree";
      label: string;
      worktreePath: string;
      filteredPaths: string[];
    }
  | {
      kind: "session";
      label: string;
      worktreePath: string;
      refId: string | null;
      agentId: string | null;
      sessionId: string | null;
      filteredPaths: string[];
      touchedFiles: number;
      changedFiles: number;
      include: "changed" | "all";
      caveat: "path-filtered-not-hunk-provenance";
    };

/** The full UI/API contract returned by `GET /api/repo-diff/worktree`. */
export type ScoutRepoDiffSnapshot = RepoDiffResponse & {
  scout: RepoDiffScoutContext;
  render: RepoDiffRenderHints;
  scope?: RepoDiffScope;
};
