import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { RefreshCw, SlidersHorizontal } from "lucide-react";
import type { Route } from "../../lib/types.ts";
import { EmptyState } from "../../components/EmptyState.tsx";
import { useContextMenu } from "../../components/ContextMenu.tsx";
import type {
  RepoWatchSnapshot,
  RepoWatchWorktree,
  RepoWatchProject,
} from "../../scout/repo-watch/types.ts";
import {
  fetchRepoPullRequests,
  fetchRepoWatchSnapshot,
  type RepoPullRequestItem,
  type RepoPullRequestSnapshot,
  type RepoWatchScanDepth,
} from "../../scout/repo-watch/api.ts";
import {
  buildPullRequestMenuItems,
  type PullRequestWorktreeMatch,
} from "../../scout/repo-watch/pull-request-actions.ts";
import { PullRequestAssignDialog } from "../../scout/repo-watch/PullRequestAssignDialog.tsx";
import RepoWatchTable from "../../scout/repo-watch/RepoWatchTable.tsx";
import RepoWatchDrift from "../../scout/repo-watch/RepoWatchDrift.tsx";
import {
  clearRepoWatchSelection,
  publishRepoWatchSelection,
} from "../../scout/repo-watch/selection-bridge.ts";
import { agoFromMillis, attentionRank, type Tone } from "../../scout/repo-watch/ui.ts";
import { SlidePanel } from "../../components/SlidePanel/SlidePanel.tsx";
import { RepoDiffViewerLazy } from "../../scout/repo-diff/RepoDiffViewerLazy.tsx";
import { prefetchRepoDiffSnapshots } from "../../scout/repo-diff/cache.ts";
import { useScout } from "../../scout/Provider.tsx";


/**
 * Repo Watch / State of Repos (SCO-061) — the live web view.
 *
 * Polls `GET /api/repo-watch` and renders the Fleet Table: every repo and
 * worktree on the machine in one operator-console panel — repos grouped with an
 * indented worktree tree, churn / drift / agents per row, sorted so unfinished
 * work floats to the top. The `--studio-*` / `--status-*` tokens are supplied by
 * `.repo-watch-scope` (see scout/repo-watch/repo-watch.css); the table itself
 * carries its own warm operator-console palette scoped to `.rw-table`.
 */

const REFRESH_MS = 10_000;
const STANDARD_SCAN_TIMEOUT_MS = 15_000;
const EXPANDED_SCAN_TIMEOUT_MS = 45_000;
const INITIAL_FALLBACK_TIMEOUT_MS = 45_000;
const TONE_KEY = "openscout.repos.tone";
const TONES: readonly Tone[] = ["warm", "cool", "mono"];

type ReposView = "table" | "drift";
const VIEW_KEY = "openscout.repos.view";
const VIEWS: readonly ReposView[] = ["table", "drift"];
const DIFF_WARMUP_LIMIT = 12;

function isBudgetLimitedSnapshot(snapshot: RepoWatchSnapshot): boolean {
  return snapshot.warnings.some((warning) =>
    /scan budget|stopped discovery|stopped scanning/i.test(warning),
  );
}

function isSmallerSnapshot(
  next: RepoWatchSnapshot,
  previous: RepoWatchSnapshot,
): boolean {
  return next.totals.worktrees < previous.totals.worktrees ||
    next.totals.projects < previous.totals.projects;
}

function repoWatchErrorMessage(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  ) {
    return "Repo Watch scan timed out; keeping the last available snapshot.";
  }
  return error instanceof Error ? error.message : String(error);
}

/** A bit of UI state mirrored to localStorage, validated against `allowed` so a
 *  stale or garbage stored value can never wedge the view. SSR-safe. */
function usePersistedState<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === "undefined") return fallback;
    try {
      const stored = window.localStorage.getItem(key) as T | null;
      return stored && allowed.includes(stored) ? stored : fallback;
    } catch {
      // Safari private mode / sandboxed iframes can throw on access.
      return fallback;
    }
  });
  const set = useCallback(
    (next: T) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, next);
      } catch {
        /* ignore private-mode / quota failures */
      }
    },
    [key],
  );
  return [value, set];
}

/* The default selection — the most-relevant worktree so the context pane isn't
 * empty on load: worst attention first, then live-agent count, then churn. */
function pickDefaultWorktree(
  projects: readonly RepoWatchProject[],
): RepoWatchWorktree | null {
  let best: RepoWatchWorktree | null = null;
  let bestScore = -Infinity;
  for (const project of projects) {
    for (const wt of project.worktrees) {
      const liveAgents = wt.agents.filter(
        (a) => (a.state ?? "").toLowerCase() === "active",
      ).length;
      const score =
        (4 - attentionRank(wt.attention)) * 1_000_000 +
        liveAgents * 10_000 +
        wt.status.changedFiles;
      if (score > bestScore) {
        bestScore = score;
        best = wt;
      }
    }
  }
  return best;
}

function findById(
  snapshot: RepoWatchSnapshot | null,
  id: string | null,
): { worktree: RepoWatchWorktree | null; project: RepoWatchProject | null } {
  if (!snapshot || !id) return { worktree: null, project: null };
  for (const project of snapshot.projects) {
    for (const wt of project.worktrees) {
      if (wt.id === id) return { worktree: wt, project };
    }
  }
  return { worktree: null, project: null };
}

function shortstatFiles(shortstat: string | null): number {
  if (!shortstat) return 0;
  const match = /(\d+)\s+files?\s+changed/.exec(shortstat);
  return match ? Number(match[1]) : 0;
}

function repoPrPaths(snapshot: RepoWatchSnapshot): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const project of snapshot.projects) {
    const path = project.worktrees[0]?.path ?? project.root;
    if (!path || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  return paths;
}

function prUpdatedAgo(updatedAt: string | null, generatedAt: number): string {
  if (!updatedAt) return "updated";
  const time = Date.parse(updatedAt);
  return Number.isFinite(time) ? agoFromMillis(time, generatedAt) : "updated";
}

function openPullRequestStatTitle(snapshot: RepoPullRequestSnapshot | null): string | null {
  const pullRequests = snapshot?.pullRequests ?? [];
  if (pullRequests.length === 0) return null;
  const visible = pullRequests.slice(0, 8).map((pr) =>
    `${pr.repo}#${pr.number}: ${pr.title}`,
  );
  const hidden = pullRequests.length - visible.length;
  return [
    "Open pull requests from gh.",
    ...visible,
    hidden > 0 ? `+${hidden} more` : null,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function pullRequestMatchesProject(
  pr: RepoPullRequestItem,
  project: RepoWatchProject | null,
): boolean {
  if (!project) return false;
  if (pr.path === project.root || project.worktrees.some((wt) => wt.path === pr.path)) {
    return true;
  }
  const repoLeaf = pr.repo.split("/").pop()?.toLowerCase();
  return repoLeaf === project.name.toLowerCase();
}

function pullRequestMatchesBranch(
  pr: RepoPullRequestItem,
  worktree: RepoWatchWorktree | null,
): boolean {
  const branch = worktree?.branch.name?.trim();
  return Boolean(branch && pr.headRefName === branch);
}

function matchingWorktreeForPullRequest(
  pr: RepoPullRequestItem,
  snapshot: RepoWatchSnapshot | null | undefined,
): PullRequestWorktreeMatch | null {
  if (!snapshot) return null;
  const head = pr.headRefName?.trim();
  if (!head) return null;
  const matches: PullRequestWorktreeMatch[] = [];
  for (const project of snapshot.projects) {
    for (const worktree of project.worktrees) {
      if (worktree.branch.name?.trim() !== head) continue;
      matches.push({
        id: worktree.id,
        path: worktree.path,
        branch: head,
      });
    }
  }
  if (matches.length === 0) return null;
  if (pr.path) {
    const exact = matches.find((item) => item.path === pr.path);
    if (exact) return exact;
  }
  return matches[0] ?? null;
}

function prefetchWorktreePaths(
  snapshot: RepoWatchSnapshot,
  selectedId: string | null,
): string[] {
  const scored: Array<{ path: string; score: number }> = [];
  for (const project of snapshot.projects) {
    for (const wt of project.worktrees) {
      const dirty =
        wt.status.staged +
        wt.status.unstaged +
        wt.status.untracked +
        wt.status.conflicts;
      const liveAgents = wt.agents.filter(
        (a) => (a.state ?? "").toLowerCase() === "active",
      ).length;
      const branchFiles = shortstatFiles(wt.diff.branchShortstat);
      const workingFiles = Math.max(
        wt.status.changedFiles,
        shortstatFiles(wt.diff.stagedShortstat) + shortstatFiles(wt.diff.unstagedShortstat),
      );
      const drift = wt.branch.ahead + wt.branch.behind;
      const attached = liveAgents + wt.sessions.length;
      if (dirty === 0 && attached === 0 && branchFiles === 0 && drift === 0) continue;
      scored.push({
        path: wt.path,
        score:
          (wt.id === selectedId ? 10_000_000 : 0) +
          (4 - attentionRank(wt.attention)) * 100_000 +
          liveAgents * 10_000 +
          wt.sessions.length * 5_000 +
          drift * 1_000 +
          branchFiles * 250 +
          dirty * 100 +
          workingFiles,
      });
    }
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .map((item) => item.path);
}

// SCO-083: Repos lives under Projects, not Ops — no OpsSubnav. Keep the s-ops
// body scroll shell so the sticky context panel still has a scroll container.
function ReposOpsShell({
  children,
}: {
  navigate: (route: Route) => void;
  children?: ReactNode;
}) {
  return (
    <div className="s-ops">
      <div className="s-ops-body" style={{ overflowY: "auto" }}>
        {children}
      </div>
    </div>
  );
}

function RepoWatchEmptyNextSteps({ error }: { error?: string | null }) {
  return (
    <div className="rw-empty-next">
      <p className="rw-empty-copy">
        Repos is waiting on the local Scout Services layer. Restart the broker
        from the menu bar app, then rescan.
      </p>
      <ol className="rw-empty-steps">
        <li>
          Click <span className="rw-empty-action-name">Restart broker</span> to
          hand off to the menu bar app.
        </li>
        <li>
          Wait for Scout Services to report the broker online.
        </li>
        <li>
          If nothing opens, run <code>scout doctor</code> and follow the repair
          command it prints.
        </li>
      </ol>
      {error ? <p className="rw-empty-error">{error}</p> : null}
    </div>
  );
}

function ReposOpenPullRequests({
  snapshot,
  loading,
  error,
  selectedProject,
  selectedWorktree,
  repoSnapshot,
  onSelectWorktree,
  onOpenDiff,
  navigate,
}: {
  snapshot: RepoPullRequestSnapshot | null;
  loading: boolean;
  error: string | null;
  selectedProject: RepoWatchProject | null;
  selectedWorktree: RepoWatchWorktree | null;
  repoSnapshot: RepoWatchSnapshot | null;
  onSelectWorktree: (worktreeId: string) => void;
  onOpenDiff: (path: string) => void;
  navigate: (route: Route) => void;
}) {
  const { agents } = useScout();
  const showContextMenu = useContextMenu();
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const [assignPr, setAssignPr] = useState<RepoPullRequestItem | null>(null);
  const [assignPending, setAssignPending] = useState(false);
  const [assignError, setAssignError] = useState<string | null>(null);
  const statusTimer = useRef<number | null>(null);

  const reportStatus = useCallback((message: string | null) => {
    setActionStatus(message);
    if (statusTimer.current != null) window.clearTimeout(statusTimer.current);
    if (message) {
      statusTimer.current = window.setTimeout(() => setActionStatus(null), 6_000);
    }
  }, []);

  useEffect(() => () => {
    if (statusTimer.current != null) window.clearTimeout(statusTimer.current);
  }, []);

  const closeAssign = useCallback(() => {
    if (assignPending) return;
    setAssignPr(null);
    setAssignError(null);
  }, [assignPending]);

  const projectsForAssign = useMemo(
    () => (repoSnapshot?.projects ?? []).map((project) => ({
      root: project.root,
      name: project.name,
    })),
    [repoSnapshot],
  );

  const pullRequests = snapshot?.pullRequests ?? [];
  const selectedBranch = selectedWorktree?.branch.name ?? null;
  const selectedProjectPullRequests = pullRequests.filter((pr) =>
    pullRequestMatchesProject(pr, selectedProject),
  );
  const branchPullRequests = selectedProjectPullRequests.filter((pr) =>
    pullRequestMatchesBranch(pr, selectedWorktree),
  );
  const projectPullRequests = selectedProjectPullRequests.filter((pr) =>
    !pullRequestMatchesBranch(pr, selectedWorktree),
  );
  const otherPullRequests = pullRequests.filter((pr) =>
    !pullRequestMatchesProject(pr, selectedProject),
  );
  const groups = [
    branchPullRequests.length > 0 ? {
      key: "branch",
      label: selectedBranch ? `Selected branch · ${selectedBranch}` : "Selected branch",
      items: branchPullRequests,
    } : null,
    projectPullRequests.length > 0 ? {
      key: "project",
      label: selectedProject ? `${selectedProject.name} PRs` : "Selected project",
      items: projectPullRequests,
    } : null,
    otherPullRequests.length > 0 ? {
      key: "other",
      label: selectedProjectPullRequests.length > 0 ? "Other open PRs" : "Open PRs",
      items: otherPullRequests,
    } : null,
  ].filter((group): group is { key: string; label: string; items: RepoPullRequestItem[] } =>
    Boolean(group),
  );
  if (!loading && !error && pullRequests.length === 0) return null;

  const openPrMenu = (event: ReactMouseEvent, pr: RepoPullRequestItem) => {
    event.preventDefault();
    showContextMenu(event, buildPullRequestMenuItems(pr, {
      matchingWorktree: matchingWorktreeForPullRequest(pr, repoSnapshot),
      onBeginAssign: (next) => {
        setAssignError(null);
        setAssignPr(next);
      },
      onSelectWorktreeId: onSelectWorktree,
      onOpenDiff,
      onStatus: reportStatus,
    }));
  };

  return (
    <section className="rw-open-prs" aria-label="Open pull requests">
      <div className="rw-open-prs-head">
        <div>
          <div className="rw-open-prs-eyebrow">Open PRs</div>
          <div className="rw-open-prs-title">
            {loading && pullRequests.length === 0 ? "Checking GitHub" : `${pullRequests.length} open`}
          </div>
          {actionStatus ? (
            <div className="rw-open-prs-status" role="status">{actionStatus}</div>
          ) : null}
        </div>
        {snapshot ? <span className="rw-open-prs-meta">gh</span> : null}
      </div>
      {pullRequests.length > 0 ? (
        <div className="rw-open-prs-list">
          {groups.map((group) => (
            <div key={group.key} className="rw-open-pr-group">
              {groups.length > 1 ? (
                <div className="rw-open-pr-group-label">{group.label}</div>
              ) : null}
              {group.items.map((pr) => (
                <button
                  key={pr.id}
                  type="button"
                  className="rw-open-pr"
                  title={`${pr.title} — click for actions`}
                  onClick={(event) => openPrMenu(event, pr)}
                  onContextMenu={(event) => openPrMenu(event, pr)}
                >
                  <span className="rw-open-pr-main">
                    <span className="rw-open-pr-number">#{pr.number}</span>
                    <span className="rw-open-pr-title" title={pr.title}>{pr.title}</span>
                  </span>
                  <span className="rw-open-pr-detail">
                    <span>{pr.repo}</span>
                    <span>{pr.headRefName || "head"} → {pr.baseRefName || "base"}</span>
                    {pr.isDraft ? <span>draft</span> : <span>open</span>}
                    {pr.author ? <span>@{pr.author}</span> : null}
                    <span>{prUpdatedAgo(pr.updatedAt, snapshot?.generatedAt ?? Date.now())}</span>
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      ) : (
        <div className="rw-open-prs-empty">
          {error ?? "No open pull requests returned."}
        </div>
      )}

      {assignPr ? (
        <PullRequestAssignDialog
          pr={assignPr}
          agents={agents}
          projects={projectsForAssign}
          pending={assignPending}
          error={assignError}
          onClose={closeAssign}
          onPendingChange={setAssignPending}
          onError={setAssignError}
          onAssigned={(result) => {
            setAssignPr(null);
            setAssignError(null);
            reportStatus(result.message);
            if (result.flightId || result.conversationId || result.targetAgentId) {
              navigate({
                view: "follow",
                ...(result.flightId ? { flightId: result.flightId } : {}),
                ...(result.conversationId ? { conversationId: result.conversationId } : {}),
                ...(result.targetAgentId ? { targetAgentId: result.targetAgentId } : {}),
              });
            }
          }}
        />
      ) : null}
    </section>
  );
}

export function ReposScreen({
  navigate,
  focusRoot = null,
}: {
  navigate: (route: Route) => void;
  /** Absolute project root to pre-select (deep link from a project surface). */
  focusRoot?: string | null;
}) {
  const [snapshot, setSnapshot] = useState<RepoWatchSnapshot | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const hasData = useRef(false);
  const emptyStreak = useRef(0);
  const snapshotRef = useRef<RepoWatchSnapshot | null>(null);
  const loadInFlight = useRef(false);

  // Tone + view persist to localStorage; selection is shared across both views.
  // All three reach the table and the context pane through the `.rw-scope`
  // wrapper (which carries the tone palette vars).
  const [tone, setTone] = usePersistedState<Tone>(TONE_KEY, TONES, "warm");
  const [view, setView] = usePersistedState<ReposView>(VIEW_KEY, VIEWS, "table");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [scanDepth, setScanDepth] = useState<RepoWatchScanDepth>("standard");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshReceipt, setRefreshReceipt] = useState<string | null>(null);
  const [scanMorePending, setScanMorePending] = useState(false);
  const [serviceRestartPending, setServiceRestartPending] = useState(false);
  const [serviceRestartError, setServiceRestartError] = useState<string | null>(null);
  const [pullRequests, setPullRequests] = useState<RepoPullRequestSnapshot | null>(null);
  const [pullRequestsLoading, setPullRequestsLoading] = useState(false);
  const [pullRequestsError, setPullRequestsError] = useState<string | null>(null);
  // SCO-065: the worktree path whose diff is open in the slide-in viewer.
  const [diffPath, setDiffPath] = useState<string | null>(null);

  const load = useCallback(async (options: {
    depth?: RepoWatchScanDepth;
    force?: boolean;
    scanMore?: boolean;
  } = {}) => {
    if (loadInFlight.current && !options.force) return;
    loadInFlight.current = true;
    const depth = options.depth ?? scanDepth;
    if (options.scanMore) setScanMorePending(true);
    if (options.force && !options.scanMore) setRefreshing(true);
    try {
      let data = await fetchRepoWatchSnapshot(
        depth,
        options.force ?? false,
        depth === "expanded" ? EXPANDED_SCAN_TIMEOUT_MS : STANDARD_SCAN_TIMEOUT_MS,
      );
      let acceptedDepth = depth;
      if (!hasData.current && depth === "standard" && !options.force && data.projects.length === 0) {
        try {
          const expanded = await fetchRepoWatchSnapshot(
            "expanded",
            true,
            INITIAL_FALLBACK_TIMEOUT_MS,
          );
          if (expanded.projects.length > 0) {
            data = expanded;
            acceptedDepth = "expanded";
          }
        } catch {
          // Fall through to the empty-state controls; don't leave the page in
          // an indefinite "Scanning" phase when the broker scan is saturated.
        }
      }
      const previous = snapshotRef.current;
      if (
        previous &&
        isBudgetLimitedSnapshot(data) &&
        (data.projects.length === 0 || isSmallerSnapshot(data, previous))
      ) {
        setError("Scan budget was reached; keeping the last fuller Repo Watch snapshot.");
        setPhase("ready");
        return;
      }
      // The broker scan intermittently returns an empty (or sharply smaller)
      // snapshot even while repos exist — its filesystem scan races a budget.
      // Don't let a transient empty result wipe a good snapshot we already
      // showed; keep the last good data until a non-empty scan lands.
      if (!options.force && data.projects.length === 0 && hasData.current && emptyStreak.current < 3) {
        // Ride out a few transient empty scans before believing repos are gone,
        // so the page doesn't flicker to empty — but don't get stuck forever.
        emptyStreak.current += 1;
        setPhase("ready");
        return;
      }
      emptyStreak.current = 0;
      hasData.current = true;
      snapshotRef.current = data;
      setSnapshot(data);
      setError(null);
      setPhase("ready");
      if (options.scanMore || acceptedDepth !== depth) {
        setScanDepth(acceptedDepth);
      }
      if (options.force && !options.scanMore) {
        setRefreshReceipt(`Fresh ${new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })}`);
      }
    } catch (err) {
      const message = repoWatchErrorMessage(err);
      setError(message);
      // Keep showing the last good snapshot if a refresh fails.
      if (!hasData.current) setPhase("error");
    } finally {
      if (options.scanMore) setScanMorePending(false);
      if (options.force && !options.scanMore) setRefreshing(false);
      loadInFlight.current = false;
    }
  }, [scanDepth]);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  // Seed the selection once a snapshot lands (or if the selected worktree
  // vanished from a later scan) so the context pane is never blank. A deep
  // link's focusRoot wins once per value — then the operator is free to
  // click around without the effect yanking the selection back.
  const appliedFocusRoot = useRef<string | null>(null);
  useEffect(() => {
    if (!snapshot) return;
    if (focusRoot && appliedFocusRoot.current !== focusRoot) {
      const focusProject = snapshot.projects.find(
        (p) => p.root === focusRoot || p.worktrees.some((w) => w.path === focusRoot),
      );
      // Snapshot may predate the project appearing in a scan — retry on the
      // next one instead of marking the root consumed.
      if (!focusProject) return;
      appliedFocusRoot.current = focusRoot;
      if (!focusProject.worktrees.some((w) => w.id === selectedId)) {
        setSelectedId(pickDefaultWorktree([focusProject])?.id ?? null);
        return;
      }
    }
    const stillThere = snapshot.projects.some((p) =>
      p.worktrees.some((w) => w.id === selectedId),
    );
    if (!stillThere) {
      setSelectedId(pickDefaultWorktree(snapshot.projects)?.id ?? null);
    }
  }, [snapshot, selectedId, focusRoot]);

  useEffect(() => {
    if (!snapshot || snapshot.projects.length === 0) return;
    prefetchRepoDiffSnapshots(
      prefetchWorktreePaths(snapshot, selectedId),
      undefined,
      { limit: DIFF_WARMUP_LIMIT },
    );
  }, [snapshot, selectedId]);

  const pullRequestPaths = useMemo(
    () => snapshot ? repoPrPaths(snapshot) : [],
    [snapshot],
  );
  const pullRequestPathKey = pullRequestPaths.join("\0");

  useEffect(() => {
    if (pullRequestPaths.length === 0) {
      setPullRequests(null);
      setPullRequestsError(null);
      setPullRequestsLoading(false);
      return;
    }

    let cancelled = false;
    setPullRequestsLoading(true);
    setPullRequestsError(null);
    fetchRepoPullRequests(pullRequestPaths)
      .then((data) => {
        if (cancelled) return;
        setPullRequests(data);
      })
      .catch((err) => {
        if (cancelled) return;
        setPullRequestsError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setPullRequestsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [pullRequestPathKey]);

  const selection = useMemo(
    () => findById(snapshot, selectedId),
    [snapshot, selectedId],
  );
  const openPullRequestTitle = useMemo(
    () => openPullRequestStatTitle(pullRequests),
    [pullRequests],
  );

  // The worktree CONTEXT panel lives in the app's global right Inspector rail
  // (see scout/inspector/ReposInspector.tsx). Publish the live selection there
  // rather than re-fetching the snapshot in the rail; clear it on unmount.
  useEffect(() => {
    publishRepoWatchSelection({
      worktree: selection.worktree,
      project: selection.project,
      generatedAt: snapshot?.generatedAt ?? 0,
      tone,
    });
  }, [selection.worktree, selection.project, snapshot?.generatedAt, tone]);

  useEffect(() => clearRepoWatchSelection, []);

  const scanMore = useCallback(() => {
    void load({ depth: "expanded", force: true, scanMore: true });
  }, [load]);

  const scanNow = useCallback(() => {
    void load({ force: true });
  }, [load]);

  const restartBrokerFromMenu = useCallback(async () => {
    if (serviceRestartPending) return;
    setServiceRestartPending(true);
    setServiceRestartError(null);

    try {
      const response = await fetch("/api/scout-services/restart-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target: "broker" }),
      });
      if (!response.ok) {
        throw new Error(`Scout Services link failed (${response.status})`);
      }
      const data = await response.json() as { url?: string };
      if (!data.url?.startsWith("scout://services/restart/")) {
        throw new Error("Scout Services link was not returned.");
      }
      window.location.assign(data.url);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setServiceRestartError(`${message} Run scout doctor if the menu app did not open.`);
    } finally {
      setServiceRestartPending(false);
    }
  }, [serviceRestartPending]);

  if (phase === "loading") {
    return (
      <ReposOpsShell navigate={navigate}>
        <div className="repo-watch-scope" style={{ padding: "24px" }}>
          <EmptyState
            title="Scanning repositories…"
            body="Reading worktree state from the broker."
          />
        </div>
      </ReposOpsShell>
    );
  }

  if (phase === "error" && !snapshot) {
    return (
      <ReposOpsShell navigate={navigate}>
        <div className="repo-watch-scope" style={{ padding: "24px" }}>
          <EmptyState
            className="sys-state-card-error"
            title="Couldn’t load Repo Watch"
            body={error ?? "The broker did not return a snapshot."}
            action={
              <button
                type="button"
                className="s-btn"
                onClick={() => {
                  setPhase("loading");
                  void load();
                }}
              >
                Retry
              </button>
            }
          />
        </div>
      </ReposOpsShell>
    );
  }

  if (snapshot && snapshot.projects.length === 0) {
    return (
      <ReposOpsShell navigate={navigate}>
        <div className="repo-watch-scope" style={{ padding: "24px" }}>
          <EmptyState
            title="Scout Services need attention"
            body={<RepoWatchEmptyNextSteps error={serviceRestartError} />}
            action={
              <>
                <button
                  type="button"
                  className="s-btn s-btn-primary"
                  onClick={() => void restartBrokerFromMenu()}
                  disabled={serviceRestartPending}
                >
                  {serviceRestartPending ? "Opening…" : "Restart broker"}
                </button>
                <button
                  type="button"
                  className="s-btn"
                  onClick={scanNow}
                  disabled={refreshing || scanMorePending}
                >
                  {refreshing ? "Scanning…" : "Scan again"}
                </button>
                <button
                  type="button"
                  className="s-btn"
                  onClick={scanMore}
                  disabled={refreshing || scanMorePending}
                >
                  {scanMorePending ? "Scanning…" : "Scan more"}
                </button>
              </>
            }
          />
        </div>
      </ReposOpsShell>
    );
  }

  if (!snapshot) return <ReposOpsShell navigate={navigate} />;

  return (
    <ReposOpsShell navigate={navigate}>
    <div className="repo-watch-scope">
      <div className={"rw-scope tone-" + tone}>
        <div className="rw-page-shell">
          {/* Refresh is the primary action; view/tone live in a minor display menu. */}
          <div className="rw-toolbar">
            <button
              type="button"
              className="rw-refresh-main"
              onClick={scanNow}
              disabled={refreshing || scanMorePending}
            >
              <RefreshCw
                size={14}
                aria-hidden="true"
                className={refreshing ? "rw-refresh-spin" : undefined}
              />
              <span>{refreshing ? "Scanning" : "Refresh"}</span>
            </button>
            {refreshReceipt ? (
              <span className="rw-refresh-receipt">{refreshReceipt}</span>
            ) : null}
            <details className="rw-display-menu">
              <summary aria-label="Display options">
                <SlidersHorizontal size={14} aria-hidden="true" />
                <span>Display</span>
              </summary>
              <div className="rw-display-panel">
                <div className="rw-display-row">
                  <span className="rw-display-label">View</span>
                  <div className="rw-tone" role="group" aria-label="View">
                    {VIEWS.map((v) => (
                      <button
                        key={v}
                        type="button"
                        className={v === view ? "on" : ""}
                        aria-pressed={v === view}
                        onClick={() => setView(v)}
                      >
                        {v}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="rw-display-row">
                  <span className="rw-display-label">Tone</span>
                  <div className="rw-tone" role="group" aria-label="Console tone">
                    {TONES.map((t) => (
                      <button
                        key={t}
                        type="button"
                        className={t === tone ? "on" : ""}
                        aria-pressed={t === tone}
                        onClick={() => setTone(t)}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </details>
          </div>
          {/* The worktree CONTEXT panel now lives in the global Inspector rail
              (scout/inspector/ReposInspector.tsx), so the table/drift view fills
              the full content width here. */}
          <div className="min-w-0">
            {view === "drift" ? (
              <RepoWatchDrift
                snapshot={snapshot}
                selectedId={selectedId}
                onSelect={setSelectedId}
              />
            ) : (
              <>
                <RepoWatchTable
                  snapshot={snapshot}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  onViewDiff={setDiffPath}
                  scanDepth={scanDepth}
                  scanMorePending={scanMorePending}
                  onScanMore={scanMore}
                  openPullRequestCount={pullRequests?.pullRequests.length ?? null}
                  openPullRequestTitle={openPullRequestTitle}
                />
                <ReposOpenPullRequests
                  snapshot={pullRequests}
                  loading={pullRequestsLoading}
                  error={pullRequestsError}
                  selectedProject={selection.project}
                  selectedWorktree={selection.worktree}
                  repoSnapshot={snapshot}
                  onSelectWorktree={setSelectedId}
                  onOpenDiff={setDiffPath}
                  navigate={navigate}
                />
              </>
            )}
          </div>
        </div>
      </div>

      {/* SCO-065 — the diff viewer slides in from the right. Lazy-loaded inside
          the panel so Pierre/Shiki only import when a row's "diff" is clicked. */}
      <SlidePanel
        open={diffPath != null}
        onClose={() => setDiffPath(null)}
        side="right"
        owner="openscout.repos-diff-viewer"
        resizable
        defaultSize={840}
        maxSize={1280}
        minSize={420}
        ariaLabel="Worktree diff"
      >
        {diffPath != null ? (
          <RepoDiffViewerLazy
            key={diffPath}
            path={diffPath}
            onClose={() => setDiffPath(null)}
            onOpenAsPage={() => {
              if (diffPath) {
                navigate({ view: "repo-diff", path: diffPath });
                setDiffPath(null);
              }
            }}
          />
        ) : null}
      </SlidePanel>
    </div>
    </ReposOpsShell>
  );
}

export default ReposScreen;
