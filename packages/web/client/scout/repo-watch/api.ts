import { api } from "../../lib/api.ts";
import type { RepoWatchSnapshot } from "./types.ts";

let cachedRepoWatchSnapshot: RepoWatchSnapshot | null = null;
let cachedPullRequestSnapshot: RepoPullRequestSnapshot | null = null;

export type RepoWatchScanDepth = "standard" | "expanded";

export type RepoPullRequestItem = {
  id: string;
  repo: string;
  path: string;
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  author: string | null;
  updatedAt: string | null;
};

export type RepoPullRequestSnapshot = {
  generatedAt: number;
  source: "gh";
  paths: string[];
  pullRequests: RepoPullRequestItem[];
  warnings: string[];
};

export function repoWatchUrl(depth: RepoWatchScanDepth, force: boolean): string {
  const params = new URLSearchParams({ includeDiff: "1", native: "0" });
  if (depth === "standard") params.set("includeLastCommit", "1");
  if (force) params.set("force", "1");
  if (depth === "expanded") {
    params.set("maxRoots", "32");
    params.set("maxWorktrees", "12");
    params.set("scanBudgetMs", "30000");
  }
  return `/api/repo-watch?${params.toString()}`;
}

export async function fetchRepoWatchSnapshot(
  depth: RepoWatchScanDepth,
  force: boolean,
  timeoutMs: number,
): Promise<RepoWatchSnapshot> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const snapshot = await api<RepoWatchSnapshot>(repoWatchUrl(depth, force), { signal: controller.signal });
    cachedRepoWatchSnapshot = snapshot;
    return snapshot;
  } finally {
    window.clearTimeout(timeout);
  }
}

export function getCachedRepoWatchSnapshot(): RepoWatchSnapshot | null {
  return cachedRepoWatchSnapshot;
}

export function repoPrUrl(paths: readonly string[]): string {
  const params = new URLSearchParams({ limit: "8" });
  for (const path of paths.slice(0, 12)) params.append("path", path);
  return `/api/repo-prs?${params.toString()}`;
}

export async function fetchRepoPullRequests(paths: readonly string[]): Promise<RepoPullRequestSnapshot> {
  const snapshot = await api<RepoPullRequestSnapshot>(repoPrUrl(paths));
  cachedPullRequestSnapshot = snapshot;
  return snapshot;
}

export function getCachedRepoPullRequests(): RepoPullRequestSnapshot | null {
  return cachedPullRequestSnapshot;
}
