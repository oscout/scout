/**
 * Repo Watch — frontend types for SCO-061.
 *
 * STRUCTURALLY IDENTICAL to the real backend contract exported from
 * `@openscout/runtime` (`packages/runtime/src/repo-watch/index.ts`). TypeScript
 * is structural, so a live `RepoWatchSnapshot` from the broker is assignable to
 * these and the studio components drop straight into the web app against the
 * real `/v1/repo-watch/snapshot` response — no adapter, no reshaping. Keep this
 * a faithful mirror; if the runtime contract changes, change it here too.
 *
 * Presentation helpers (attention → tone/glyph, "ago", live/handle derivation)
 * live in `./ui.ts`. The mock snapshot lives in `./mock.ts`. No React here.
 */

/** §6 Attention Rules — the backend's mechanical severity classifier. The UI
 *  sorts by this rank without inventing product semantics. */
export type RepoWatchAttentionLevel =
  | "critical" // merge conflicts / unmerged
  | "attention" // dirty main|master, diverged branch, or status errored
  | "active" // dirty, ahead/behind, or a live agent/session attached
  | "quiet" // clean and idle
  | "unknown"; // discovered but couldn't be scanned

/** Where a worktree was discovered from (broker endpoint, tail, env, …). */
export type RepoWatchHintSource =
  | "agent"
  | "endpoint"
  | "tail-process"
  | "tail-transcript"
  | "environment";

/** A discovery hint attached to a project/worktree. Loose by design at v0. */
export interface RepoWatchHintSummary {
  path: string;
  source: RepoWatchHintSource;
  sourceLabel?: string;
  agentId?: string;
  agentName?: string;
  agentState?: string;
  sessionId?: string;
  harness?: string;
  runtimeSource?: string;
}

/** A Scout agent inferred as attached to a worktree. `state` is the broker's
 *  agent state ("active" | "idle" | "waiting" | "offline" | …); the UI derives
 *  "live" from it (see `agentLive` in ui.ts). No display handle is sent — the
 *  UI builds one from `name`/`id`. */
export interface RepoWatchAgentRef {
  id: string;
  name: string | null;
  state: string | null;
  harness: string | null;
}

/** A harness session attached to a worktree. */
export interface RepoWatchSessionRef {
  id: string;
  source: string | null;
  harness: string | null;
}

/** A changed-file preview row. `status` is a human label from the backend's
 *  porcelain=v2 parse ("modified", "untracked", "conflict", "staged+unstaged",
 *  …) — NOT the raw two-letter code. A small preview list, not a diff browser. */
export interface RepoWatchChangedFile {
  path: string;
  status: string;
}

export interface RepoWatchBranchSummary {
  name: string | null;
  upstream: string | null;
  head: string | null;
  detached: boolean;
  ahead: number;
  behind: number;
  isMain: boolean;
  diverged: boolean;
}

export interface RepoWatchStatusSummary {
  clean: boolean;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicts: number;
  changedFiles: number;
  files: RepoWatchChangedFile[];
}

export interface RepoWatchDiffSummary {
  /** `git diff --shortstat <merge-base>..HEAD` for committed branch delta. */
  branchShortstat: string | null;
  /** `git diff --shortstat` — null on the fast path unless includeDiff=1. */
  unstagedShortstat: string | null;
  /** `git diff --cached --shortstat` — null on the fast path. */
  stagedShortstat: string | null;
}

export interface RepoWatchWorktree {
  id: string;
  path: string;
  name: string;
  isBare: boolean;
  branch: RepoWatchBranchSummary;
  status: RepoWatchStatusSummary;
  diff: RepoWatchDiffSummary;
  attention: RepoWatchAttentionLevel;
  attentionReasons: string[];
  agents: RepoWatchAgentRef[];
  sessions: RepoWatchSessionRef[];
  hints: RepoWatchHintSummary[];
  /** Epoch **milliseconds** (backend multiplies %ct seconds by 1000); null
   *  unless includeLastCommit=1. Use `agoFromMillis(t, generatedAt)`. */
  lastCommitAt: number | null;
  scannedAt: number;
  error: string | null;
}

export interface RepoWatchProjectStats {
  worktrees: number;
  dirtyWorktrees: number;
  conflictedWorktrees: number;
  attachedAgents: number;
  attachedSessions: number;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicts: number;
}

export interface RepoWatchProject {
  id: string;
  name: string;
  root: string;
  commonGitDir: string;
  attention: RepoWatchAttentionLevel;
  attentionReasons: string[];
  worktrees: RepoWatchWorktree[];
  stats: RepoWatchProjectStats;
  hints: RepoWatchHintSummary[];
}

export interface RepoWatchTotals {
  projects: number;
  worktrees: number;
  dirtyWorktrees: number;
  conflictedWorktrees: number;
  attentionWorktrees: number;
  attachedAgents: number;
  attachedSessions: number;
}

export interface RepoWatchSnapshot {
  /** Epoch ms the snapshot was generated. */
  generatedAt: number;
  projects: RepoWatchProject[];
  totals: RepoWatchTotals;
  warnings: string[];
}
