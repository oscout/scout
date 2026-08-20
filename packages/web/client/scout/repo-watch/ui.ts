/**
 * Repo Watch — shared presentation helpers.
 *
 * Maps the backend's mechanical attention model onto the studio's token
 * vocabulary, and derives the display-only bits the wire format doesn't send
 * (a handle + "live" flag from an agent's state, a short badge from a file's
 * status label). Treatments import from here so four layouts read as one system
 * and so the same code works against the live `/v1/repo-watch/snapshot`.
 *
 * Tokens resolve to CSS vars in `app/globals.css`:
 *   --status-{ok,warn,error,info,neutral}-{fg,bg}, --scout-accent, --studio-*.
 */

import type {
  RepoWatchAgentRef,
  RepoWatchAttentionLevel,
  RepoWatchBranchSummary,
  RepoWatchProject,
  RepoWatchSessionRef,
  RepoWatchWorktree,
} from "./types.ts";

export type StatusTone = "ok" | "warn" | "error" | "info" | "neutral" | "accent";

/** Console palette permutation — warm / cool / mono (see console.css). Owned by
 *  ReposScreen, shared here so the screen and every view agree on the union. */
export type Tone = "warm" | "cool" | "mono";

/** Integer formatting with thousands separators ("1,024"). */
export const fmt = (n: number): string => n.toLocaleString("en-US");

export interface AttentionVisual {
  label: string;
  tone: StatusTone;
  fg: string;
  bg: string;
  rank: number;
  glyph: string;
  gloss: string;
}

export const ATTENTION: Record<RepoWatchAttentionLevel, AttentionVisual> = {
  critical: {
    label: "CRITICAL",
    tone: "error",
    fg: "var(--status-error-fg)",
    bg: "var(--status-error-bg)",
    rank: 0,
    glyph: "●",
    gloss: "Merge conflicts or unmerged status — work is stuck.",
  },
  attention: {
    label: "ATTENTION",
    tone: "warn",
    fg: "var(--studio-ink)",
    bg: "var(--status-neutral-bg)",
    rank: 1,
    glyph: "▲",
    gloss: "Dirty main, diverged branch, or status couldn't be read.",
  },
  active: {
    label: "ACTIVE",
    tone: "accent",
    fg: "var(--scout-accent)",
    bg: "var(--scout-accent-soft)",
    rank: 2,
    glyph: "◆",
    gloss: "Live work — dirty, ahead/behind, or an agent is attached.",
  },
  quiet: {
    label: "QUIET",
    tone: "neutral",
    fg: "var(--studio-ink-faint)",
    bg: "var(--status-neutral-bg)",
    rank: 3,
    glyph: "·",
    gloss: "Clean and idle — nothing pulling for attention.",
  },
  unknown: {
    label: "UNKNOWN",
    tone: "neutral",
    fg: "var(--studio-ink-faint)",
    bg: "var(--status-neutral-bg)",
    rank: 4,
    glyph: "?",
    gloss: "Discovered but couldn't be scanned enough to classify.",
  },
};

export function attentionRank(level: RepoWatchAttentionLevel): number {
  return ATTENTION[level].rank;
}

/* ── Agent presence — derived, since the wire format sends neither ──────── */

const LIVE_AGENT_STATES = new Set([
  "active",
  "working",
  "running",
  "in_turn",
  "in_flight",
  "queued",
  "waking",
  "dispatching",
]);

/** Live = the broker reports the agent as actively working or queued into work.
 *  Idle / waiting / offline / null render unlifted. */
export function agentLive(agent: RepoWatchAgentRef): boolean {
  return LIVE_AGENT_STATES.has((agent.state ?? "").trim().toLowerCase());
}

/** A display handle — the wire format has no handle, so build one from the
 *  agent's name (falling back to its id). */
export function agentHandle(agent: RepoWatchAgentRef): string {
  if (agent.name && agent.name.trim()) {
    return "@" + agent.name.trim().toLowerCase().replace(/\s+/g, "-");
  }
  return agent.id;
}

/** Compact label for attached harness sessions. These are not first-class
 *  Scout agents, so keep the source/harness visible when we show them. */
export function sessionHandle(session: RepoWatchSessionRef): string {
  const source = (session.harness ?? session.source ?? "session").trim() || "session";
  const shortId = session.id.length > 12 ? `${session.id.slice(0, 12)}…` : session.id;
  return `${source}:${shortId}`;
}

/** Live-first, de-duplicated agent list. The wire format repeats a name across
 *  many worktree-scoped ids; collapse by display handle so each agent appears
 *  once, with live ones first. Every view shows agents this way. */
export function uniqueAgents(wt: RepoWatchWorktree): RepoWatchAgentRef[] {
  const seen = new Set<string>();
  const out: RepoWatchAgentRef[] = [];
  for (const a of [...wt.agents].sort(
    (x, y) => Number(agentLive(y)) - Number(agentLive(x)),
  )) {
    const handle = agentHandle(a);
    if (seen.has(handle)) continue;
    seen.add(handle);
    out.push(a);
  }
  return out;
}

/* ── Branch / path formatting ──────────────────────────────────────────── */

/** Leaf of an absolute path — the worktree's short name. */
export function pathLeaf(p: string): string {
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}

/** Distinguishing worktree label within a grouped repo row — strips a shared
 *  project prefix when the path leaf repeats it (e.g. `openscout-fix` → `fix`). */
export function worktreeDisplayLeaf(
  wt: RepoWatchWorktree,
  project: RepoWatchProject,
): string {
  const leaf = pathLeaf(wt.path);
  if (leaf === project.name) return leaf;
  if (leaf.startsWith(project.name + "-")) return leaf.slice(project.name.length + 1);
  return leaf;
}

/** Sort key for the table's name column — project name across groups, leaf
 *  within a group. `sign` is 1 for ascending, −1 for descending. */
export function compareWorktreeNames(
  a: { wt: RepoWatchWorktree; project: RepoWatchProject },
  b: { wt: RepoWatchWorktree; project: RepoWatchProject },
  sign: number,
): number {
  const an =
    a.project.id === b.project.id
      ? worktreeDisplayLeaf(a.wt, a.project)
      : a.project.name;
  const bn =
    b.project.id === b.project.id
      ? worktreeDisplayLeaf(b.wt, b.project)
      : b.project.name;
  return an.localeCompare(bn) * sign;
}

/** Abbreviated path for display (…/dev/openscout/foo). */
export function shortPath(p: string, segments = 3): string {
  const parts = p.replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts.length <= segments) return p;
  return "…/" + parts.slice(-segments).join("/");
}

/** Relative "ago" from an epoch-**milliseconds** timestamp, against a fixed now
 *  (also ms). Deterministic — pass the snapshot's generatedAt so studies don't
 *  depend on wall-clock and screenshots stay byte-stable. */
export function agoFromMillis(epochMs: number | null, nowMs: number): string {
  if (epochMs == null) return "—";
  const deltaSec = Math.max(0, Math.round((nowMs - epochMs) / 1000));
  if (deltaSec < 60) return `${deltaSec}s`;
  const min = Math.round(deltaSec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h`;
  const d = Math.round(hr / 24);
  return `${d}d`;
}

/* ── File status — the backend sends human labels, not raw porcelain ─────
 * Values seen: "untracked" · "conflict" · "staged" · "unstaged" ·
 * "staged+unstaged" · "changed". Map to a tone + a one-glyph badge. */

export function fileStatusTone(status: string): StatusTone {
  const s = status.toLowerCase();
  if (s.includes("conflict")) return "error";
  if (s === "untracked") return "info";
  if (s === "staged") return "ok";
  if (s.includes("unstaged") || s === "changed" || s === "modified") return "warn";
  return "warn";
}

/** One-character badge for a status label (used in dense file cells). */
export function fileStatusBadge(status: string): string {
  const s = status.toLowerCase();
  if (s.includes("conflict")) return "U";
  if (s === "untracked") return "?";
  if (s === "staged+unstaged") return "±";
  if (s === "staged") return "S";
  if (s === "unstaged") return "M";
  if (s === "changed" || s === "modified") return "~";
  return "•";
}

export function toneFg(tone: StatusTone): string {
  return tone === "accent" ? "var(--scout-accent)" : `var(--status-${tone}-fg)`;
}

export function toneBg(tone: StatusTone): string {
  return tone === "accent" ? "var(--scout-accent-soft)" : `var(--status-${tone}-bg)`;
}

/* ── Worktree state — the worst-of derivation behind every view's status dot ─
 * Error wins (a scan we can't trust), then a live agent, then any dirtiness or
 * drift, else clean. The table, drift ruler, and context pane all read this. */

export type WtState = "error" | "live" | "dirty" | "clean";

export function wtState(wt: RepoWatchWorktree): WtState {
  if (wt.error != null) return "error";
  if (wt.agents.some(agentLive)) return "live";
  if (!wt.status.clean || wt.branch.ahead > 0 || wt.branch.behind > 0) return "dirty";
  return "clean";
}

/* ── Churn — parse `git diff --shortstat` and sum staged + unstaged ──────── */

interface Shortstat {
  files: number;
  ins: number;
  del: number;
}

function parseShortstat(text: string | null): Shortstat | null {
  if (!text) return null;
  const files = /(\d+)\s+files?\s+changed/.exec(text);
  const ins = /(\d+)\s+insertions?\(\+\)/.exec(text);
  const del = /(\d+)\s+deletions?\(-\)/.exec(text);
  if (!files && !ins && !del) return null;
  return {
    files: files ? Number(files[1]) : 0,
    ins: ins ? Number(ins[1]) : 0,
    del: del ? Number(del[1]) : 0,
  };
}

export interface Churn {
  add: number;
  del: number;
  total: number;
  files: number;
  /** Whether there's any churn at all (`total > 0`). */
  has: boolean;
}

/** Working-tree churn for a worktree — staged + unstaged insertions/deletions
 *  parsed from the diff shortstats (null on the fast path → zero). */
export function churnOf(wt: RepoWatchWorktree): Churn {
  const staged = parseShortstat(wt.diff.stagedShortstat);
  const unstaged = parseShortstat(wt.diff.unstagedShortstat);
  const add = (staged?.ins ?? 0) + (unstaged?.ins ?? 0);
  const del = (staged?.del ?? 0) + (unstaged?.del ?? 0);
  const files = (staged?.files ?? 0) + (unstaged?.files ?? 0);
  return { add, del, files, total: add + del, has: add > 0 || del > 0 };
}

/** Committed branch churn from the branch merge-base to HEAD. */
export function branchChurnOf(wt: RepoWatchWorktree): Churn {
  const branch = parseShortstat(wt.diff.branchShortstat);
  const add = branch?.ins ?? 0;
  const del = branch?.del ?? 0;
  const files = branch?.files ?? 0;
  return { add, del, files, total: add + del, has: add > 0 || del > 0 };
}

/** Reviewable churn: committed branch delta plus staged/unstaged work. */
export function reviewChurnOf(wt: RepoWatchWorktree): Churn {
  const branch = branchChurnOf(wt);
  const worktree = churnOf(wt);
  const add = branch.add + worktree.add;
  const del = branch.del + worktree.del;
  const files = branch.files + worktree.files;
  return { add, del, files, total: add + del, has: add > 0 || del > 0 };
}

/* ── Branch identity — split a ref into a dimmed path prefix + meaningful leaf,
 * e.g. "codex/repo-watch" → { prefix: "codex/", leaf: "repo-watch" } so the
 * distinguishing part reads first. Detached heads surface a short sha instead.
 * Pure — the <BranchLabel> in parts.tsx renders the result. ──────────────── */

export interface BranchParts {
  detached: boolean;
  sha: string | null;
  prefix: string;
  leaf: string;
}

export function branchParts(
  branch: RepoWatchBranchSummary,
  fallback: string,
): BranchParts {
  if (branch.detached) {
    return {
      detached: true,
      sha: branch.head ? branch.head.slice(0, 7) : null,
      prefix: "",
      leaf: "",
    };
  }
  const name = branch.name ?? fallback;
  const slash = name.lastIndexOf("/");
  if (slash >= 0) {
    return {
      detached: false,
      sha: null,
      prefix: name.slice(0, slash + 1),
      leaf: name.slice(slash + 1),
    };
  }
  return { detached: false, sha: null, prefix: "", leaf: name };
}
