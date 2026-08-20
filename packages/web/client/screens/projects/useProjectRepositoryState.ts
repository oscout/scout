import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchRepoPullRequests,
  fetchRepoWatchSnapshot,
  getCachedRepoPullRequests,
  getCachedRepoWatchSnapshot,
  type RepoPullRequestItem,
  type RepoPullRequestSnapshot,
} from "../../scout/repo-watch/api.ts";
import type { RepoWatchProject, RepoWatchSnapshot } from "../../scout/repo-watch/types.ts";
import { fetchRepoDiffSnapshot } from "../../scout/repo-diff/cache.ts";
import type { ScoutRepoDiffSnapshot } from "../../scout/repo-diff/types.ts";
import { repoProjectForRoot } from "./project-overview-helpers.ts";

const REFRESH_MS = 10_000;
const DIFF_REFRESH_MS = 20_000;
const PR_REFRESH_MS = 60_000;
const SCAN_TIMEOUT_MS = 15_000;
const EXPANDED_SCAN_TIMEOUT_MS = 45_000;
const DIFF_LAYERS = ["branch", "unstaged", "staged"] as const;

/** Run the callback when the tab returns to the foreground — pairs with
   visibility-gated intervals so background tabs stay quiet but the surface
   catches up the moment it is visible again. */
export function onVisible(callback: () => void): () => void {
  const handler = () => {
    if (document.visibilityState === "visible") callback();
  };
  window.addEventListener("focus", handler);
  document.addEventListener("visibilitychange", handler);
  return () => {
    window.removeEventListener("focus", handler);
    document.removeEventListener("visibilitychange", handler);
  };
}

function normalizedPaths(projectRoot: string | null, worktreePaths: readonly string[]): string[] {
  const paths = new Set<string>();
  for (const path of [projectRoot, ...worktreePaths]) {
    const trimmed = path?.trim();
    if (trimmed) paths.add(trimmed.replace(/\/+$/u, ""));
  }
  return [...paths].slice(0, 6);
}

function pathLeaf(path: string): string {
  return path.replace(/\/+$/u, "").split("/").pop()?.toLocaleLowerCase() ?? path.toLocaleLowerCase();
}

function pullRequestMatchesProject(
  pr: RepoPullRequestItem,
  projectRoot: string,
  project: RepoWatchProject | null,
): boolean {
  if (pr.path === projectRoot || project?.worktrees.some((worktree) => worktree.path === pr.path)) return true;
  const repoLeaf = pr.repo.split("/").pop()?.toLocaleLowerCase();
  return repoLeaf === (project?.name.toLocaleLowerCase() ?? pathLeaf(projectRoot));
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "name" in error && error.name === "AbortError") {
    return "The repository scan timed out.";
  }
  return error instanceof Error ? error.message : String(error);
}

export type ProjectRepositoryState = {
  project: RepoWatchProject | null;
  pullRequests: RepoPullRequestItem[];
  pullRequestsLoading: boolean;
  pullRequestWarnings: string[];
  repoLoading: boolean;
  repoError: string | null;
  diffSnapshots: ReadonlyMap<string, ScoutRepoDiffSnapshot>;
  diffErrors: ReadonlyMap<string, string>;
  diffLoading: boolean;
  refresh: () => void;
};

export function useProjectRepositoryState(
  projectRoot: string | null,
  worktreePaths: readonly string[] = [],
): ProjectRepositoryState {
  const pathsKey = normalizedPaths(projectRoot, worktreePaths).join("\0");
  const paths = useMemo(() => pathsKey ? pathsKey.split("\0") : [], [pathsKey]);
  const [snapshot, setSnapshot] = useState<RepoWatchSnapshot | null>(() => getCachedRepoWatchSnapshot());
  const [pullRequestSnapshot, setPullRequestSnapshot] = useState<RepoPullRequestSnapshot | null>(() => getCachedRepoPullRequests());
  const [repoLoading, setRepoLoading] = useState(Boolean(projectRoot && !repoProjectForRoot(snapshot, projectRoot)));
  const [pullRequestsLoading, setPullRequestsLoading] = useState(Boolean(projectRoot));
  const [diffLoading, setDiffLoading] = useState(Boolean(projectRoot));
  const [repoError, setRepoError] = useState<string | null>(null);
  const [pullRequestError, setPullRequestError] = useState<string | null>(null);
  const [diffSnapshots, setDiffSnapshots] = useState<Map<string, ScoutRepoDiffSnapshot>>(() => new Map());
  const [diffErrors, setDiffErrors] = useState<Map<string, string>>(() => new Map());
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const expandedRoot = useRef<string | null>(null);

  const refresh = useCallback(() => {
    expandedRoot.current = null;
    setRefreshEpoch((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!projectRoot) {
      setRepoLoading(false);
      setRepoError(null);
      return;
    }
    let cancelled = false;
    let inFlight = false;
    let firstLoad = true;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      if (!cancelled) {
        setRepoLoading(true);
        setRepoError(null);
      }
      let lastError: string | null = null;
      try {
        let next: RepoWatchSnapshot | null = null;
        const force = refreshEpoch > 0 && firstLoad;
        firstLoad = false;
        try {
          next = await fetchRepoWatchSnapshot("standard", force, SCAN_TIMEOUT_MS);
        } catch (error) {
          lastError = errorMessage(error);
        }
        if ((!next || !repoProjectForRoot(next, projectRoot)) && expandedRoot.current !== projectRoot) {
          expandedRoot.current = projectRoot;
          try {
            const expanded = await fetchRepoWatchSnapshot("expanded", force, EXPANDED_SCAN_TIMEOUT_MS);
            if (repoProjectForRoot(expanded, projectRoot)) next = expanded;
          } catch (error) {
            lastError = errorMessage(error);
          }
        }
        if (!cancelled && next) {
          setSnapshot((current) => {
            if (repoProjectForRoot(next, projectRoot)) return next;
            return current && repoProjectForRoot(current, projectRoot) ? current : next;
          });
        }
        if (!cancelled && !repoProjectForRoot(next, projectRoot)) {
          setRepoError(lastError ?? "Repo Watch did not include this project in its latest scan.");
        }
      } finally {
        inFlight = false;
        if (!cancelled) setRepoLoading(false);
      }
    };
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, REFRESH_MS);
    const offVisible = onVisible(() => void load());
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      offVisible();
    };
  }, [projectRoot, refreshEpoch]);

  useEffect(() => {
    if (paths.length === 0) {
      setDiffLoading(false);
      setDiffErrors(new Map());
      return;
    }
    let cancelled = false;
    let inFlight = false;
    let firstLoad = true;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      if (!cancelled) setDiffLoading(true);
      const results = await Promise.allSettled(
        paths.map((path) => fetchRepoDiffSnapshot(path, [...DIFF_LAYERS], {
          force: refreshEpoch > 0 && firstLoad,
          tier: "summary",
        })),
      );
      firstLoad = false;
      if (!cancelled) {
        const nextSnapshots = new Map<string, ScoutRepoDiffSnapshot>();
        const nextErrors = new Map<string, string>();
        results.forEach((result, index) => {
          const path = paths[index]!;
          if (result.status === "fulfilled") nextSnapshots.set(path, result.value.snapshot);
          else nextErrors.set(path, errorMessage(result.reason));
        });
        setDiffSnapshots((current) => {
          const next = new Map(current);
          for (const path of paths) next.delete(path);
          for (const [path, value] of nextSnapshots) next.set(path, value);
          return next;
        });
        setDiffErrors(nextErrors);
        setDiffLoading(false);
      }
      inFlight = false;
    };
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, DIFF_REFRESH_MS);
    const offVisible = onVisible(() => void load());
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      offVisible();
    };
  }, [paths, refreshEpoch]);

  useEffect(() => {
    if (paths.length === 0) {
      setPullRequestsLoading(false);
      setPullRequestError(null);
      return;
    }
    let cancelled = false;
    let inFlight = false;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await fetchRepoPullRequests(paths);
        if (!cancelled) {
          setPullRequestSnapshot(next);
          setPullRequestError(null);
        }
      } catch (error) {
        if (!cancelled) setPullRequestError(errorMessage(error));
      } finally {
        inFlight = false;
        if (!cancelled) setPullRequestsLoading(false);
      }
    };
    setPullRequestsLoading(true);
    setPullRequestError(null);
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, PR_REFRESH_MS);
    const offVisible = onVisible(() => void load());
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      offVisible();
    };
  }, [paths, refreshEpoch]);

  const project = useMemo(() => repoProjectForRoot(snapshot, projectRoot), [projectRoot, snapshot]);
  const pullRequests = useMemo(
    () => projectRoot
      ? (pullRequestSnapshot?.pullRequests ?? []).filter((pr) => pullRequestMatchesProject(pr, projectRoot, project))
      : [],
    [project, projectRoot, pullRequestSnapshot],
  );
  const pullRequestWarnings = useMemo(() => {
    const warnings = pullRequestSnapshot?.paths.some((path) => paths.includes(path))
      ? pullRequestSnapshot.warnings
      : [];
    return pullRequestError ? [pullRequestError, ...warnings] : warnings;
  }, [paths, pullRequestError, pullRequestSnapshot]);

  return {
    project,
    pullRequests,
    pullRequestsLoading,
    pullRequestWarnings,
    repoLoading,
    repoError,
    diffSnapshots,
    diffErrors,
    diffLoading,
    refresh,
  };
}
