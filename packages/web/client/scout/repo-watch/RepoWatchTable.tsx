/**
 * Repo Watch — "Fleet Table", Scout operator-console treatment.
 *
 * Adapted from the Claude Design handoff ("Scout · Repos", the dark
 * operator-console / RFC-document theme). It keeps the real snapshot data,
 * column sorting, and clean-tray fold from the original Fleet Table, re-skinned
 * in the design's vocabulary:
 *
 *   · a serif (Spectral) STAT STRIP — repos · changed · working · open PRs
 *   · repos grouped, with an indented WORKTREE TREE (connector guides) under
 *     any multi-worktree repo; single-worktree repos stay one clean line
 *   · a readable split CHURN bar (+adds mint / −dels coral) beside the numerals
 *   · DRIFT pills (↑ahead mint / ↓behind amber)
 *   · semantic state DOTS (live = mint, dirty = amber, error = coral,
 *     clean = hollow ring) and SCAN ERR / DETACHED / LOCAL tags
 *
 * The warm palette + fonts live in ./console.css, scoped to `.rw-table`. Clicking
 * a row selects it; the right-hand CONTEXT panel (see RepoWatchContext) renders
 * its commits, per-file churn, attention reasons, and any scan error.
 */

import { useMemo, useState } from "react";
import "./console.css";
import type {
  RepoWatchSnapshot,
  RepoWatchWorktree,
  RepoWatchProject,
  RepoWatchAgentRef,
} from "./types.ts";
import {
  attentionRank,
  shortPath,
  agentLive,
  agentHandle,
  sessionHandle,
  uniqueAgents,
  churnOf,
  branchChurnOf,
  reviewChurnOf,
  wtState,
  fmt,
  compareWorktreeNames,
  type WtState,
} from "./ui.ts";
import { BranchLabel } from "./parts.tsx";
import { summarizeScanDiagnostics } from "./scan-diagnostics.ts";

/* ── Row model — one flattened row per worktree, carrying its parent repo ─── */
interface Row {
  wt: RepoWatchWorktree;
  project: RepoWatchProject;
  state: WtState;
  add: number;
  del: number;
  churn: number;
  files: number;
  live: number;
  agentsUnique: RepoWatchAgentRef[];
}

/* ── Sort state ─────────────────────────────────────────────────────────── */
type SortKey = "attention" | "name" | "churn" | "files" | "drift" | "attached";
type SortDir = "asc" | "desc";

const SORT_DEFAULT_DIR: Record<SortKey, SortDir> = {
  // `score` maps higher = more significant (critical attention, more churn, …),
  // so every data column defaults to descending; only name sorts A→Z.
  attention: "desc", // worst (critical / error) first
  name: "asc",
  churn: "desc",
  files: "desc",
  drift: "desc",
  attached: "desc",
};

/* The view opens sorted by attention so the worst worktrees surface first. */
const DEFAULT_SORT_KEY: SortKey = "attention";

/* A worktree is "going on" when there's something live or unfinished in it. */
function hasActivity(wt: RepoWatchWorktree): boolean {
  return (
    !wt.status.clean ||
    wt.branch.ahead > 0 ||
    wt.branch.behind > 0 ||
    wt.agents.some(agentLive) ||
    wt.sessions.length > 0 ||
    wt.error != null
  );
}

function buildRow(wt: RepoWatchWorktree, project: RepoWatchProject): Row {
  const worktreeChurn = churnOf(wt);
  const branchChurn = branchChurnOf(wt);
  const { add, del, total } = reviewChurnOf(wt);
  const agentsUnique = uniqueAgents(wt);
  return {
    wt,
    project,
    state: wtState(wt),
    add,
    del,
    churn: total,
    files: branchChurn.files + Math.max(worktreeChurn.files, wt.status.changedFiles),
    live: agentsUnique.filter(agentLive).length,
    agentsUnique,
  };
}

function isBlocked(wt: RepoWatchWorktree): boolean {
  return wt.status.conflicts > 0 || wt.error != null;
}

function blockedStatTitle(projects: RepoWatchProject[]): string {
  const rows = projects.flatMap((project) =>
    project.worktrees
      .filter(isBlocked)
      .map((wt) => {
        const branch = wt.branch.name ?? wt.name;
        if (wt.status.conflicts > 0) {
          return `${project.name}/${branch}: ${fmt(wt.status.conflicts)} conflict${wt.status.conflicts === 1 ? "" : "s"}`;
        }
        return `${project.name}/${branch}: scan error`;
      }),
  );
  const head = "Worktrees blocked by conflicts or scan errors.";
  if (rows.length === 0) return head;
  const visible = rows.slice(0, 8);
  const hidden = rows.length - visible.length;
  return [
    head,
    ...visible,
    hidden > 0 ? `+${hidden} more` : null,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

export default function RepoWatchTable({
  snapshot,
  selectedId,
  onSelect,
  onViewDiff,
  scanDepth,
  scanMorePending,
  onScanMore,
  openPullRequestCount,
  openPullRequestTitle,
}: {
  snapshot: RepoWatchSnapshot;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Open the SCO-065 diff viewer for a worktree path (per-row affordance). */
  onViewDiff?: (path: string) => void;
  scanDepth: "standard" | "expanded";
  scanMorePending: boolean;
  onScanMore: () => void;
  openPullRequestCount?: number | null;
  openPullRequestTitle?: string | null;
}) {
  const [sortKey, setSortKey] = useState<SortKey>(DEFAULT_SORT_KEY);
  const [sortDir, setSortDir] = useState<SortDir>(SORT_DEFAULT_DIR[DEFAULT_SORT_KEY]);
  const [showClean, setShowClean] = useState(false);

  // Flatten + partition the snapshot. Active worktrees feed the table; clean &
  // idle ones fold into a tray. Stat-strip counts are derived in the same pass.
  const { liveRows, cleanRows, stats, blockedTitle } = useMemo(() => {
    const liveRows: Row[] = [];
    const cleanRows: Row[] = [];
    let live = 0;
    let blocked = 0;
    let changedFiles = 0;
    for (const project of snapshot.projects) {
      for (const wt of project.worktrees) {
        const row = buildRow(wt, project);
        changedFiles += row.files;
        if (row.live > 0) live++;
        if (isBlocked(wt)) blocked++;
        (hasActivity(wt) ? liveRows : cleanRows).push(row);
      }
    }
    const t = snapshot.totals;
    const stats = {
      repos: t.projects,
      worktrees: t.worktrees,
      dirtyWorktrees: t.dirtyWorktrees,
      changedFiles,
      live,
      blocked,
    };
    return {
      liveRows,
      cleanRows,
      stats,
      blockedTitle: blockedStatTitle(snapshot.projects),
    };
  }, [snapshot.projects, snapshot.totals]);

  // Sort, keeping each repo's worktrees adjacent, then group by project so a
  // multi-worktree repo renders as a header + indented tree.
  const groups = useMemo(() => {
    const sorted = sortRows(liveRows, sortKey, sortDir);
    const m = new Map<string, Row[]>();
    for (const r of sorted) {
      const g = m.get(r.project.id);
      if (g) g.push(r);
      else m.set(r.project.id, [r]);
    }
    return [...m.values()];
  }, [liveRows, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir(SORT_DEFAULT_DIR[key]);
    }
  }
  const empty = liveRows.length === 0 && cleanRows.length === 0;

  return (
    <section className="rw-table">
      {/* ── Head: stat strip + tone / clean toggles ── */}
      <div className="rw-head">
        <div className="rw-head-top">
          <span className="rw-eyebrow">STATE OF REPOS</span>
          {cleanRows.length > 0 ? (
            <button
              type="button"
              className="rw-clean"
              style={{ marginLeft: "auto" }}
              onClick={() => setShowClean((v) => !v)}
              aria-pressed={showClean}
            >
              {showClean ? "hide" : "show"} clean &amp; idle ({cleanRows.length})
            </button>
          ) : null}
        </div>
        <div className="stats">
          <Stat v={stats.repos} k="REPOS" />
          {stats.worktrees > stats.repos ? (
            <Stat
              v={stats.worktrees}
              k="WORKTREES"
              title={`${fmt(stats.worktrees)} worktrees across ${fmt(stats.repos)} repos.`}
            />
          ) : null}
          <Stat
            v={stats.changedFiles}
            k="CHANGED"
            title={`${fmt(stats.changedFiles)} changed files across ${fmt(stats.dirtyWorktrees)} dirty worktree${stats.dirtyWorktrees === 1 ? "" : "s"}.`}
          />
          {stats.live > 0 ? <Stat v={stats.live} k="WORKING" tone="mint" /> : null}
          {(openPullRequestCount ?? 0) > 0 ? (
            <Stat
              v={openPullRequestCount ?? 0}
              k="OPEN PRS"
              tone="amber"
              title={openPullRequestTitle ?? undefined}
            />
          ) : null}
          {stats.blocked > 0 ? (
            <Stat v={stats.blocked} k="BLOCKED" tone="coral" title={blockedTitle} />
          ) : null}
        </div>
      </div>

      {/* ── Table ── */}
      <div className="tbl-wrap">
        <div className="tbl-head">
          <SortTh label="REPO / BRANCH · WORKTREE" k="name" sortKey={sortKey} dir={sortDir} onSort={toggleSort} />
          <SortTh label="CHURN" k="churn" sortKey={sortKey} dir={sortDir} onSort={toggleSort} align="r" />
          <SortTh label="FILES" k="files" sortKey={sortKey} dir={sortDir} onSort={toggleSort} align="c" />
          <SortTh label="DRIFT" k="drift" sortKey={sortKey} dir={sortDir} onSort={toggleSort} align="c" />
          <SortTh label="ATTACHED" k="attached" sortKey={sortKey} dir={sortDir} onSort={toggleSort} />
        </div>

        {empty ? (
          <div className="rw-empty">No repositories discovered yet.</div>
        ) : (
          groups.map((group) =>
            group.length > 1 ? (
              <RepoGroup
                key={group[0].project.id}
                group={group}
                selectedId={selectedId}
                onSelect={onSelect}
                onViewDiff={onViewDiff}
              />
            ) : (
              <WorktreeRow
                key={group[0].wt.id}
                row={group[0]}
                top
                selected={selectedId === group[0].wt.id}
                onSelect={() => onSelect(group[0].wt.id)}
                onViewDiff={onViewDiff}
              />
            ),
          )
        )}

        {/* ── Clean & idle tray ── */}
        {showClean && cleanRows.length > 0 ? (
          <>
            <div className="tbl-head" style={{ position: "static" }}>
              <span>CLEAN &amp; IDLE · {cleanRows.length}</span>
            </div>
            {cleanRows.map((row) => (
              <WorktreeRow
                key={row.wt.id}
                row={row}
                top
                clean
                selected={selectedId === row.wt.id}
                onSelect={() => onSelect(row.wt.id)}
                onViewDiff={onViewDiff}
              />
            ))}
          </>
        ) : null}

        <ScanCoverage
          snapshot={snapshot}
          scanDepth={scanDepth}
          scanMorePending={scanMorePending}
          onScanMore={onScanMore}
        />
      </div>
    </section>
  );
}

function ScanCoverage({
  snapshot,
  scanDepth,
  scanMorePending,
  onScanMore,
}: {
  snapshot: RepoWatchSnapshot;
  scanDepth: "standard" | "expanded";
  scanMorePending: boolean;
  onScanMore: () => void;
}) {
  const coverage = scanCoverage(snapshot);
  const diagnostics = summarizeScanDiagnostics(snapshot.warnings);
  const rawDiagnosticCount = diagnostics.reduce((total, diagnostic) => total + diagnostic.rawCount, 0);
  return (
    <div className="scan-coverage">
      <div className="scan-coverage-row">
        <b>SCAN</b>
        <span className="scan-main">{coverage.summary}</span>
        {coverage.canScanMore && scanDepth === "standard" ? (
          <button type="button" onClick={onScanMore} disabled={scanMorePending}>
            {scanMorePending ? "Scanning" : "Scan more"}
          </button>
        ) : (
          <span className="scan-chip">{scanDepth === "expanded" ? "expanded" : "standard"}</span>
        )}
      </div>
      {diagnostics.length > 0 ? (
        <details className="scan-details">
          <summary>
            {fmt(diagnostics.length)} diagnostic group{diagnostics.length === 1 ? "" : "s"}
            {rawDiagnosticCount !== diagnostics.length ? ` (${fmt(rawDiagnosticCount)} raw)` : ""}
          </summary>
          <ul>
            {diagnostics.map((diagnostic, index) => (
              <li key={`${index}:${diagnostic.message}`}>
                <span>{diagnostic.message}</span>
                {diagnostic.examples.length > 0 ? (
                  <span className="scan-detail-examples">
                    {diagnostic.examples.join(" · ")}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function scanCoverage(snapshot: RepoWatchSnapshot): { summary: string; canScanMore: boolean } {
  let discoveryLimit: string | null = null;
  let worktreeCaps = 0;
  let unreadableWorktrees = 0;
  let missingPaths = 0;
  let budgetStops = 0;
  let unresolvedGitDirs = 0;
  let other = 0;

  for (const warning of snapshot.warnings) {
    const discovery = /limited discovery to (\d+) repositories/i.exec(warning);
    if (discovery) {
      discoveryLimit = `discovery capped at ${discovery[1]}`;
      continue;
    }
    if (/limited .* to \d+ worktrees/i.test(warning)) {
      worktreeCaps++;
      continue;
    }
    if (/skipped unreadable worktree/i.test(warning)) {
      unreadableWorktrees++;
      continue;
    }
    if (/skipped missing repo-watch path/i.test(warning)) {
      missingPaths++;
      continue;
    }
    if (/scan budget|stopped discovery|stopped scanning/i.test(warning)) {
      budgetStops++;
      continue;
    }
    if (/could not resolve git common directory/i.test(warning)) {
      unresolvedGitDirs++;
      continue;
    }
    other++;
  }

  const parts = [
    `${fmt(snapshot.totals.projects)} repo${snapshot.totals.projects === 1 ? "" : "s"}`,
    `${fmt(snapshot.totals.worktrees)} worktree${snapshot.totals.worktrees === 1 ? "" : "s"}`,
  ];
  if (discoveryLimit) parts.push(discoveryLimit);
  if (worktreeCaps) parts.push(`${fmt(worktreeCaps)} repo${worktreeCaps === 1 ? "" : "s"} at worktree cap`);
  if (unreadableWorktrees) {
    parts.push(`${fmt(unreadableWorktrees)} unreadable worktree${unreadableWorktrees === 1 ? "" : "s"} skipped`);
  }
  if (missingPaths) parts.push(`${fmt(missingPaths)} missing path${missingPaths === 1 ? "" : "s"}`);
  if (unresolvedGitDirs) parts.push(`${fmt(unresolvedGitDirs)} unresolved git dir${unresolvedGitDirs === 1 ? "" : "s"}`);
  if (budgetStops) parts.push("scan budget reached");
  if (other) parts.push(`${fmt(other)} other diagnostic${other === 1 ? "" : "s"}`);

  return {
    summary: parts.join(" · "),
    canScanMore: discoveryLimit !== null || worktreeCaps > 0 || budgetStops > 0,
  };
}

/* ── Repo group: header + indented worktree tree ──────────────────────────── */
function RepoGroup({
  group,
  selectedId,
  onSelect,
  onViewDiff,
}: {
  group: Row[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onViewDiff?: (path: string) => void;
}) {
  const project = group[0].project;
  const attn = group.some((r) => r.state === "error");
  const add = group.reduce((s, r) => s + r.add, 0);
  const del = group.reduce((s, r) => s + r.del, 0);
  const liveTot = group.reduce((s, r) => s + (r.live ? 1 : 0), 0);

  return (
    <div>
      <div className={"repo-grp" + (attn ? " attn" : "")}>
        <div className="rg-name">
          <span className="rg-tw" aria-hidden>
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none" style={{ transform: "rotate(90deg)" }}>
              <path d="M3 2l4 3.5L3 9" stroke="currentColor" strokeWidth="1.3" fill="none" />
            </svg>
          </span>
          <span className={"dot " + worstState(group)} />
          <span className="rg-nm">{project.name}</span>
          <span className="rg-path">{shortPath(project.root, 3)}</span>
          <span className="rg-badge">{project.worktrees.length} worktrees</span>
        </div>
        <div className="rg-agg">
          {add || del ? (
            <span>
              <span style={{ color: "var(--mint-dim)" }}>+{fmt(add)}</span>{" "}
              <span style={{ color: "var(--coral-dim)" }}>−{fmt(del)}</span>
            </span>
          ) : (
            "—"
          )}
        </div>
        <div />
        <div />
        <div className="rg-agg" style={{ textAlign: "left" }}>
          {liveTot ? `${liveTot} working` : ""}
        </div>
      </div>
      {group.map((row, i) => (
        <WorktreeRow
          key={row.wt.id}
          row={row}
          guide
          last={i === group.length - 1}
          selected={selectedId === row.wt.id}
          onSelect={() => onSelect(row.wt.id)}
          onViewDiff={onViewDiff}
        />
      ))}
    </div>
  );
}

/* ── A worktree (or single-repo) row ──────────────────────────────────────── */
function WorktreeRow({
  row,
  top,
  guide,
  last,
  clean,
  selected,
  onSelect,
  onViewDiff,
}: {
  row: Row;
  top?: boolean;
  guide?: boolean;
  last?: boolean;
  clean?: boolean;
  selected?: boolean;
  onSelect?: () => void;
  onViewDiff?: (path: string) => void;
}) {
  const { wt, project } = row;
  const b = wt.branch;
  const branchChurn = branchChurnOf(wt);
  const canDiff = !!onViewDiff && (
    row.files > 0 ||
    branchChurn.has ||
    wt.branch.ahead > 0
  );

  return (
    <>
      <div
        className={[
          "wt",
          selected ? "sel" : "",
          row.state === "error" ? "attn" : "",
        ].join(" ")}
        style={top && !clean ? { borderTop: "1px solid var(--line)" } : undefined}
        onClick={onSelect}
        role="button"
        tabIndex={0}
        onKeyDown={
          onSelect
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect();
                }
              }
            : undefined
        }
      >
        {/* identity */}
        <div className="wt-name">
          {guide ? <span className={"tw-guide" + (last ? " last" : "")} /> : null}
          <div className="inner">
            <span className={"dot " + row.state} />
            <span className="br">
              {top && !guide ? <span className="lead">{project.name}&nbsp;&nbsp;</span> : null}
              <BranchLabel branch={wt.branch} fallback={wt.name} />
            </span>
            <Tags wt={wt} />
          </div>
        </div>

        {/* churn */}
        <Churn add={row.add} del={row.del} />

        {/* files */}
        <div className="files">
          {row.files > 0 ? (
            <span>
              {row.files}
              {wt.status.conflicts > 0 ? (
                <span className="conf"> ⚠{wt.status.conflicts}</span>
              ) : null}
            </span>
          ) : (
            <span className="dash">—</span>
          )}
        </div>

        {/* drift */}
        <Drift ahead={b.ahead} behind={b.behind} />

        {/* attached handles/sessions + per-row diff affordance */}
        <div className="agents-cell">
          <Agents row={row} />
          {canDiff ? (
            <button
              type="button"
              className="wt-diff"
              title={`View diff · ${row.files} changed file${row.files === 1 ? "" : "s"}`}
              aria-label="View diff"
              onClick={(e) => {
                // Don't let the row's onSelect fire — opening the diff is a
                // distinct action from selecting the row.
                e.stopPropagation();
                onViewDiff?.(wt.path);
              }}
            >
              diff
            </button>
          ) : null}
        </div>
      </div>
    </>
  );
}

/* ── Small pieces ─────────────────────────────────────────────────────────── */
function Stat({
  v,
  k,
  tone,
  title,
}: {
  v: number;
  k: string;
  tone?: "amber" | "mint" | "coral";
  title?: string;
}) {
  return (
    <div className="stat" title={title} aria-label={title ? `${fmt(v)} ${k}. ${title}` : undefined}>
      <span className={"v" + (tone ? " " + tone : "")}>{fmt(v)}</span>
      <span className="k">{k}</span>
    </div>
  );
}

function SortTh({
  label,
  k,
  sortKey,
  dir,
  onSort,
  align,
}: {
  label: string;
  k: SortKey;
  sortKey: SortKey;
  dir: SortDir;
  onSort: (k: SortKey) => void;
  align?: "r" | "c";
}) {
  const on = sortKey === k;
  return (
    <div className={align === "r" ? "r" : align === "c" ? "c" : ""}>
      <button type="button" className={on ? "on" : ""} onClick={() => onSort(k)}>
        <span>{label}</span>
        <span className="caret" aria-hidden>
          {dir === "asc" ? "▲" : "▼"}
        </span>
      </button>
    </div>
  );
}

function Churn({ add, del }: { add: number; del: number }) {
  if (!add && !del) {
    return (
      <div className="churn">
        <span className="dash">—</span>
      </div>
    );
  }
  const tot = add + del || 1;
  return (
    <div className="churn">
      <span className="nums">
        <span className="add">+{fmt(add)}</span>
        <span className="sl">/</span>
        <span className="del">−{fmt(del)}</span>
      </span>
      <span className="cbar" title={`+${fmt(add)} −${fmt(del)}`}>
        <span className="g" style={{ width: (add / tot) * 100 + "%" }} />
        <span className="r" style={{ width: (del / tot) * 100 + "%" }} />
      </span>
    </div>
  );
}

function Drift({ ahead, behind }: { ahead: number; behind: number }) {
  if (!ahead && !behind) {
    return (
      <div className="drift">
        <span className="dash">—</span>
      </div>
    );
  }
  return (
    <div className="drift">
      {ahead ? <span className="dp ahead">↑{ahead}</span> : null}
      {behind ? <span className="dp behind">↓{behind}</span> : null}
    </div>
  );
}

const MAX_HANDLES = 2;

function Agents({ row }: { row: Row }) {
  const agents = row.agentsUnique;
  const sessions = row.wt.sessions;
  const title = [
    ...agents.map((a) => `${agentHandle(a)} (${a.state ?? "—"})`),
    ...sessions.map((session) => `session ${sessionHandle(session)}`),
  ].join("\n");
  if (agents.length === 0) {
    return (
      <div className="agents" title={title}>
        {sessions.length > 0 ? (
          <span className="ahandle">
            {sessions.length} session{sessions.length === 1 ? "" : "s"}
          </span>
        ) : (
          <span className="dash">—</span>
        )}
      </div>
    );
  }
  const shown = agents.slice(0, MAX_HANDLES);
  const overflow = agents.length - shown.length;
  return (
    <div className="agents" title={title}>
      {row.live > 0 ? (
        <span className="alive">
          <span className="d" />
          {row.live}
        </span>
      ) : null}
      <span className="ahandle">{shown.map((a) => agentHandle(a)).join(" ")}</span>
      {overflow > 0 ? <span className="amore">+{overflow}</span> : null}
    </div>
  );
}

function Tags({ wt }: { wt: RepoWatchWorktree }) {
  const tags: { label: string; cls: string }[] = [];
  if (wt.branch.detached) tags.push({ label: "DETACHED", cls: "" });
  else if (!wt.branch.upstream) tags.push({ label: "LOCAL", cls: "" });
  if (wt.error != null) tags.push({ label: "SCAN ERR", cls: "err" });
  if (wt.isBare) tags.push({ label: "BARE", cls: "" });
  return (
    <>
      {tags.map((t) => (
        <span key={t.label} className={"tag " + t.cls}>
          {t.label}
        </span>
      ))}
    </>
  );
}

/* ── Sorting (groups kept adjacent; see original Fleet Table) ──────────────── */
const STATE_RANK: Record<WtState, number> = { error: 3, live: 2, dirty: 1, clean: 0 };
function worstState(group: Row[]): WtState {
  return group.reduce<WtState>(
    (a, r) => (STATE_RANK[r.state] > STATE_RANK[a] ? r.state : a),
    "clean",
  );
}

function sortRows(rows: Row[], key: SortKey, dir: SortDir): Row[] {
  const sign = dir === "asc" ? 1 : -1;

  const score = (r: Row): number => {
    switch (key) {
      case "attention":
        return -attentionRank(r.wt.attention);
      case "churn":
        return r.churn;
      case "files":
        return r.files;
      case "drift":
        return r.wt.branch.ahead + r.wt.branch.behind;
      case "attached":
        return r.live * 1_000_000 + r.agentsUnique.length * 1_000 + r.wt.sessions.length;
      case "name":
      default:
        return 0;
    }
  };

  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const g = groups.get(r.project.id);
    if (g) g.push(r);
    else groups.set(r.project.id, [r]);
  }

  const cmp = (a: Row, b: Row): number => {
    if (key === "name") return compareWorktreeNames(a, b, sign);
    const d = (score(a) - score(b)) * sign;
    if (d !== 0) return d;
    const ar = attentionRank(a.wt.attention) - attentionRank(b.wt.attention);
    if (ar !== 0) return ar;
    return a.wt.path.localeCompare(b.wt.path);
  };

  const projectScore = (g: Row[]): number =>
    g.reduce((best, r) => Math.max(best, score(r)), -Infinity);

  const ordered = [...groups.values()].sort((ga, gb) => {
    if (key === "name") return ga[0].project.name.localeCompare(gb[0].project.name) * sign;
    const d = (projectScore(ga) - projectScore(gb)) * sign;
    if (d !== 0) return d;
    return ga[0].project.name.localeCompare(gb[0].project.name);
  });

  const out: Row[] = [];
  for (const g of ordered) out.push(...[...g].sort(cmp));
  return out;
}
