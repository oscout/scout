import { basename, isAbsolute, relative, resolve } from "node:path";
import { realpathSync, statSync } from "node:fs";

import type { Context, Hono } from "hono";
import {
  getRepoDiffSnapshot,
  type RepoDiffFile,
  type RepoDiffLayer,
  type RepoDiffLayerKind,
  type RepoDiffSnapshotOptions,
  type ScoutRepoDiffSnapshot,
} from "@openscout/runtime";
import {
  execSystemFile,
  gitDiffCommandArgs,
  gitDiffNumstat,
  gitDiffPatch,
  gitDiffRaw,
  gitDiffShortstat,
  gitLogNameOnly,
  gitMergeBase,
  gitRemoteGetUrlOrigin,
  gitRevParse,
  gitStatusPorcelain,
} from "@openscout/runtime/system-probes";

import {
  loadRevealObservePayload,
  observedWorktreePath,
  sessionDiffInclude,
  sessionDiffTouchedPaths,
} from "../observe-payload.ts";
import { stableHash } from "../util/stable-hash.ts";

export type RepoPullRequestLoadOptions = {
  paths: string[];
  limitPerRepo: number;
};

export type RepoPullRequestLoadDeps = {
  gitRemoteGetUrlOrigin: typeof gitRemoteGetUrlOrigin;
  gitCommonDir: (repoRoot: string) => Promise<string | null>;
  execSystemFile: typeof execSystemFile;
};

export type RepoPullRequestSnapshot = {
  generatedAt: number;
  source: "gh";
  paths: string[];
  pullRequests: RepoPullRequestItem[];
  warnings: string[];
};

type RepoPullRequestItem = {
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

type GhPullRequest = {
  number?: number;
  title?: string;
  url?: string;
  state?: string;
  isDraft?: boolean;
  headRefName?: string;
  baseRefName?: string;
  updatedAt?: string;
  author?: { login?: string | null } | null;
};

export type RepoDiffRouteDeps = {
  currentDirectory: string;
  repoDiffSnapshot?: (options: RepoDiffSnapshotOptions) => Promise<ScoutRepoDiffSnapshot>;
  repoPullRequests?: (options: RepoPullRequestLoadOptions) => Promise<RepoPullRequestSnapshot>;
};

const REPO_DIFF_VIEWER_LIMITS: NonNullable<RepoDiffSnapshotOptions["limits"]> = {
  timeoutMs: 15_000,
  includeBinaryPatch: false,
};

const REPO_DIFF_SUMMARY_LIMITS: NonNullable<RepoDiffSnapshotOptions["limits"]> = {
  ...REPO_DIFF_VIEWER_LIMITS,
  includeRawPatch: false,
  includeParsedHunks: false,
};

const REPO_DIFF_CACHE_MAX_ENTRIES = 64;
const REPO_DIFF_GIT_MAX_BUFFER = 16 * 1024 * 1024;
const DEFAULT_REPO_DIFF_LAYERS: RepoDiffLayerKind[] = ["branch", "unstaged", "staged"];
const REPO_PRS_MAX_PATHS = 16;
const REPO_PRS_DEFAULT_LIMIT = 12;

const REPO_DIFF_TRUNK_REFS = [
  "origin/main",
  "main",
  "origin/master",
  "master",
  "origin/trunk",
  "trunk",
];

type RepoDiffCacheMode = "reload" | "prefer" | "only";
type RepoDiffTier = "patch" | "summary";
type RepoDiffCacheEntry = {
  snapshot: ScoutRepoDiffSnapshot;
  storedAt: number;
};

type RepoDiffScopeMetadata =
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

type ScopedRepoDiffSnapshot = ScoutRepoDiffSnapshot & {
  scope?: RepoDiffScopeMetadata;
};

function parseOptionalPositiveInt(
  value: string | null | undefined,
  fallback: number,
): number | undefined {
  if (value == null || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseRepoDiffCacheMode(value: string | undefined, force: string | undefined): RepoDiffCacheMode {
  if (force === "1" || force === "true") return "reload";
  switch (value) {
    case "only":
      return "only";
    case "prefer":
      return "prefer";
    case "reload":
    case "refresh":
    case "live":
      return "reload";
    default:
      return "reload";
  }
}

function parseRepoDiffTier(value: string | undefined): RepoDiffTier {
  return value === "summary" ? "summary" : "patch";
}

function wantsRepoDiffRehydrate(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

function repoDiffCacheKey(input: {
  worktreePath: string;
  layers: readonly RepoDiffLayerKind[];
  baseRef: string | undefined;
  compareRef: string | undefined;
  tier: RepoDiffTier;
  stateKey: string | undefined;
  paths?: readonly string[];
}): string {
  return [
    input.worktreePath.trim(),
    input.layers.join(","),
    input.baseRef ?? "",
    input.compareRef ?? "",
    input.tier,
    input.stateKey ?? "",
    ...(input.paths?.length ? [input.paths.join("\n")] : []),
  ].join("\u0000");
}

async function resolveGitCommitRef(worktreePath: string, ref: string): Promise<string | null> {
  return await gitRevParse({ repoRoot: worktreePath, kind: "verifyCommit", ref });
}

async function preferredRepoDiffBaseRef(worktreePath: string): Promise<string | null> {
  const upstream = await gitRevParse({ repoRoot: worktreePath, kind: "upstreamSymbolicFullName" });
  for (const candidate of [...REPO_DIFF_TRUNK_REFS, upstream].filter(Boolean) as string[]) {
    if (candidate === "HEAD") continue;
    if (await resolveGitCommitRef(worktreePath, candidate)) return candidate;
  }
  return null;
}

async function resolveRepoDiffBranchRefs(input: {
  worktreePath: string;
  layers: readonly RepoDiffLayerKind[];
  baseRef?: string;
  compareRef?: string;
}): Promise<{ baseRef?: string; compareRef?: string }> {
  if (!input.layers.includes("branch")) {
    return { baseRef: input.baseRef, compareRef: input.compareRef };
  }
  const compareRef = input.compareRef?.trim() || "HEAD";
  const compareOid = await resolveGitCommitRef(input.worktreePath, compareRef);
  if (!compareOid) {
    return { baseRef: input.baseRef, compareRef: input.compareRef };
  }
  const baseCandidate = input.baseRef?.trim() || await preferredRepoDiffBaseRef(input.worktreePath);
  if (!baseCandidate) {
    return { compareRef: compareOid };
  }
  const baseOid = await resolveGitCommitRef(input.worktreePath, baseCandidate);
  if (!baseOid) {
    return { baseRef: baseCandidate, compareRef: compareOid };
  }
  const mergeBase = await gitMergeBase({
    repoRoot: input.worktreePath,
    baseRef: baseOid,
    compareRef: compareOid,
  });
  return {
    baseRef: mergeBase ?? baseOid,
    compareRef: compareOid,
  };
}

async function repoDiffStateKey(input: {
  worktreePath: string;
  layers: readonly RepoDiffLayerKind[];
  baseRef?: string;
  compareRef?: string;
  paths?: readonly string[];
}): Promise<string> {
  const parts: string[] = [];
  if (input.layers.includes("branch")) {
    parts.push(`branch:${input.baseRef ?? ""}..${input.compareRef ?? ""}`);
  }
  if (input.layers.includes("staged")) {
    const staged = await gitDiffRaw({
      repoRoot: input.worktreePath,
      selector: { kind: "staged" },
      paths: input.paths,
    });
    parts.push(`staged:${stableHash(staged ?? "unavailable")}`);
  }
  if (input.layers.includes("unstaged")) {
    const status = await gitStatusPorcelain({
      repoRoot: input.worktreePath,
      version: "v2",
      z: true,
      paths: input.paths,
    });
    const diff = await gitDiffNumstat({
      repoRoot: input.worktreePath,
      selector: { kind: "unstaged" },
      paths: input.paths,
      z: true,
    });
    parts.push(`unstaged:${stableHash(`${status ?? "unavailable"}\0${diff ?? ""}`)}`);
  }
  return parts.join("|");
}

function uniqueNonEmpty(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function normalizeRepoDiffPathFilters(worktreePath: string, rawPaths: readonly string[]): string[] {
  const worktreeRoot = resolve(worktreePath);
  const paths: string[] = [];
  for (const rawPath of rawPaths) {
    const trimmed = rawPath.trim();
    if (!trimmed) continue;
    const absolute = isAbsolute(trimmed)
      ? resolve(trimmed)
      : resolve(worktreeRoot, trimmed);
    const relativePath = relative(worktreeRoot, absolute);
    if (!relativePath || relativePath === "." || relativePath.startsWith("..") || isAbsolute(relativePath)) {
      continue;
    }
    paths.push(relativePath.replace(/\\/g, "/"));
  }
  return uniqueNonEmpty(paths);
}

function repoDiffPathFiltersFromQuery(c: Context, worktreePath: string): string[] {
  return normalizeRepoDiffPathFilters(worktreePath, [
    ...(c.req.queries("file") ?? []),
    ...(c.req.queries("pathspec") ?? []),
  ]);
}

function withRepoDiffScope(
  snapshot: ScoutRepoDiffSnapshot,
  scope: RepoDiffScopeMetadata,
): ScopedRepoDiffSnapshot {
  return { ...snapshot, scope };
}

function repoDiffLayerLabels(kind: RepoDiffLayerKind): { base: string | null; compare: string | null } {
  switch (kind) {
    case "unstaged":
      return { base: "index", compare: "working tree" };
    case "staged":
      return { base: "HEAD", compare: "index" };
    case "branch":
      return { base: null, compare: null };
  }
}

type RepoDiffGitSelectorResult = {
  selector: Parameters<typeof gitDiffRaw>[0]["selector"];
  baseLabel: string | null;
  compareLabel: string | null;
  missing?: string;
};

function repoDiffGitSelector(input: {
  kind: RepoDiffLayerKind;
  baseRef?: string;
  compareRef?: string;
}): RepoDiffGitSelectorResult {
  switch (input.kind) {
    case "unstaged":
      return { selector: { kind: "unstaged" }, baseLabel: "index", compareLabel: "working tree" };
    case "staged":
      return { selector: { kind: "staged" }, baseLabel: "HEAD", compareLabel: "index" };
    case "branch": {
      const base = input.baseRef?.trim();
      if (!base) {
        return {
          selector: { kind: "unstaged" },
          baseLabel: null,
          compareLabel: input.compareRef ?? null,
          missing: "Branch layer requires a base ref.",
        };
      }
      const compare = input.compareRef?.trim() || "HEAD";
      return {
        selector: { kind: "twoRefs", baseRef: base, compareRef: compare },
        baseLabel: base,
        compareLabel: compare,
      };
    }
  }
}

function repoDiffFileStatus(statusCode: string): RepoDiffFile["status"] {
  switch (statusCode.charAt(0)) {
    case "A":
      return "added";
    case "M":
      return "modified";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "typechange";
    case "U":
      return "conflict";
    default:
      return "unknown";
  }
}

type RepoDiffNumstat = {
  additions: number | null;
  deletions: number | null;
  binary: boolean;
};

function parseRepoDiffNumstatZ(output: string): Map<string, RepoDiffNumstat> {
  const stats = new Map<string, RepoDiffNumstat>();
  const tokens = output.split("\0");
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    const parts = token.split("\t");
    if (parts.length < 3) continue;
    let path = parts.slice(2).join("\t");
    if (!path && index + 2 < tokens.length) {
      index += 2;
      path = tokens[index] || tokens[index - 1] || "";
    }
    if (!path) continue;
    const binary = parts[0] === "-" || parts[1] === "-";
    stats.set(path, {
      additions: binary ? null : Number(parts[0]) || 0,
      deletions: binary ? null : Number(parts[1]) || 0,
      binary,
    });
  }
  return stats;
}

function parseRepoDiffRawZ(output: string, numstat: Map<string, RepoDiffNumstat>): RepoDiffFile[] {
  const files: RepoDiffFile[] = [];
  const tokens = output.split("\0");
  for (let index = 0; index < tokens.length; index += 1) {
    const meta = tokens[index];
    if (!meta?.startsWith(":")) continue;
    const fields = meta.slice(1).split(/\s+/);
    if (fields.length < 5) continue;
    const statusCode = fields[4] ?? "";
    const status = repoDiffFileStatus(statusCode);
    const twoPathRecord = status === "renamed" || status === "copied";
    const firstPath = tokens[index + 1] || null;
    const secondPath = twoPathRecord ? (tokens[index + 2] || null) : null;
    index += twoPathRecord ? 2 : 1;

    let oldPath = firstPath;
    let newPath = twoPathRecord ? secondPath : firstPath;
    if (status === "added") oldPath = null;
    if (status === "deleted") newPath = null;

    const stat = numstat.get(newPath ?? "") ?? numstat.get(oldPath ?? "");
    files.push({
      oldPath,
      newPath,
      status,
      oldOid: fields[2] ?? null,
      newOid: fields[3] ?? null,
      oldMode: fields[0] ?? null,
      newMode: fields[1] ?? null,
      similarity: twoPathRecord ? Number.parseInt(statusCode.slice(1), 10) || null : null,
      binary: stat?.binary ?? false,
      additions: stat?.additions ?? null,
      deletions: stat?.deletions ?? null,
      hunks: [],
      truncated: false,
    });
  }
  return files;
}

function repoDiffDisplayPath(file: RepoDiffFile): string {
  return file.newPath ?? file.oldPath ?? "";
}

async function recentBranchDiffPaths(input: {
  worktreePath: string;
  baseRef?: string;
  compareRef?: string;
  paths?: readonly string[];
}): Promise<string[]> {
  if (!input.baseRef) return [];
  const output = await gitLogNameOnly({
    repoRoot: input.worktreePath,
    baseRef: input.baseRef,
    compareRef: input.compareRef || "HEAD",
    paths: input.paths,
  }, { maxStdoutBytes: REPO_DIFF_GIT_MAX_BUFFER });
  return uniqueNonEmpty((output ?? "").split(/\r?\n/));
}

function sortRepoDiffFilesRecentFirst(files: RepoDiffFile[], recentPaths: readonly string[]): RepoDiffFile[] {
  if (recentPaths.length === 0) return files;
  const rank = new Map(recentPaths.map((path, index) => [path, index]));
  return files
    .map((file, index) => ({ file, index }))
    .sort((left, right) => {
      const leftRank = rank.get(repoDiffDisplayPath(left.file)) ?? Number.MAX_SAFE_INTEGER;
      const rightRank = rank.get(repoDiffDisplayPath(right.file)) ?? Number.MAX_SAFE_INTEGER;
      if (leftRank !== rightRank) return leftRank - rightRank;
      return left.index - right.index;
    })
    .map((entry) => entry.file);
}

async function buildGitRepoDiffLayer(input: {
  worktreePath: string;
  kind: RepoDiffLayerKind;
  baseRef?: string;
  compareRef?: string;
  paths?: readonly string[];
  tier: RepoDiffTier;
  diagnostics: Array<{ level: "info" | "warning"; kind: string; message: string; path: string | null }>;
}): Promise<RepoDiffLayer | null> {
  const resolved = repoDiffGitSelector(input);
  if (resolved.missing) {
    input.diagnostics.push({
      level: "warning",
      kind: "branch_refs_missing",
      message: resolved.missing,
      path: null,
    });
    return null;
  }
  const diffInput = {
    repoRoot: input.worktreePath,
    selector: resolved.selector,
    paths: input.paths,
  };
  const raw = await gitDiffRaw(diffInput, { maxStdoutBytes: REPO_DIFF_GIT_MAX_BUFFER }) ?? "";
  const numstat = await gitDiffNumstat({ ...diffInput, z: true }, { maxStdoutBytes: REPO_DIFF_GIT_MAX_BUFFER }) ?? "";
  const shortstat = await gitDiffShortstat(diffInput);
  let files = parseRepoDiffRawZ(raw, parseRepoDiffNumstatZ(numstat));
  if (input.kind === "branch") {
    files = sortRepoDiffFilesRecentFirst(files, await recentBranchDiffPaths(input));
  }

  const patchArgs = gitDiffCommandArgs({ ...diffInput, output: "patch" });
  const command = ["git", ...patchArgs];
  let rawPatch: string | null = null;
  let rawPatchBytes = 0;
  let truncated = false;

  if (input.tier === "patch") {
    const patch = await gitDiffPatch(diffInput, { maxStdoutBytes: REPO_DIFF_GIT_MAX_BUFFER }) ?? "";
    rawPatchBytes = Buffer.byteLength(patch);
    const maxPatchBytes = REPO_DIFF_VIEWER_LIMITS.maxPatchBytes ?? 2_000_000;
    if (rawPatchBytes > maxPatchBytes) {
      truncated = true;
      rawPatch = patch.slice(0, maxPatchBytes);
      input.diagnostics.push({
        level: "warning",
        kind: "patch_truncated",
        message: `Patch text truncated to ${maxPatchBytes} of ${rawPatchBytes} bytes.`,
        path: null,
      });
    } else {
      rawPatch = patch;
    }
  }

  return {
    kind: input.kind,
    baseLabel: resolved.baseLabel,
    compareLabel: resolved.compareLabel,
    command,
    patchOid: stableHash(`${command.join("\0")}\0${raw}\0${numstat}\0${shortstat ?? ""}\0${rawPatch ?? ""}`),
    rawPatch,
    rawPatchBytes,
    truncated,
    files,
    shortstat,
  };
}

async function buildGitRepoDiffSnapshot(input: {
  worktreePath: string;
  layers: readonly RepoDiffLayerKind[];
  baseRef?: string;
  compareRef?: string;
  tier: RepoDiffTier;
  paths?: readonly string[];
}): Promise<ScoutRepoDiffSnapshot> {
  const diagnostics: Array<{ level: "info" | "warning"; kind: string; message: string; path: string | null }> = [];
  const layers = (await Promise.all(input.layers
    .map((kind) => buildGitRepoDiffLayer({
      worktreePath: input.worktreePath,
      kind,
      baseRef: input.baseRef,
      compareRef: input.compareRef,
      paths: input.paths,
      tier: input.tier,
      diagnostics,
    }))))
    .filter((layer): layer is RepoDiffLayer => Boolean(layer));

  if (input.tier === "summary" && layers.some((layer) => layer.files.length > 100)) {
    diagnostics.push({
      level: "info",
      kind: "large_diff_strategy",
      message: "Loaded a recent-first file inventory; select a file to fetch its patch text.",
      path: null,
    });
  }

  const renderKey = stableHash([
    "git-repo-diff",
    input.worktreePath,
    input.tier,
    input.baseRef ?? "",
    input.compareRef ?? "",
    input.paths?.join("\n") ?? "",
    layers.map((layer) => `${layer.kind}:${layer.patchOid}`).join("|"),
  ].join("\0"));

  return {
    schema: "openscout.repo.diff/v1",
    generatedAt: Date.now(),
    worktreePath: input.worktreePath,
    layers,
    coverage: {
      requestedLayers: input.layers.length,
      emittedLayers: layers.length,
      files: layers.reduce((sum, layer) => sum + layer.files.length, 0),
      patchBytes: layers.reduce((sum, layer) => sum + layer.rawPatchBytes, 0),
      truncatedLayers: layers.filter((layer) => layer.truncated).length,
      scanBudgetReached: false,
    },
    diagnostics,
    scout: { worktreeId: `worktree:${stableHash(input.worktreePath)}`, projectId: null, agents: [], sessions: [], hints: [] },
    render: {
      renderKey,
      cachePolicy: "local-disposable",
      preferredTheme: "pierre-dark", // client remaps via resolvePierreDiffTheme for light UI
      preferredLayout: "split",
    },
  };
}

function shouldUseGitRepoDiffFallback(input: {
  tier: RepoDiffTier;
  paths?: readonly string[];
  useInjectedSnapshot: boolean;
}): boolean {
  if (input.useInjectedSnapshot) return false;
  return input.tier === "summary" || (input.paths?.length ?? 0) > 0;
}

function emptyRepoDiffSnapshot(input: {
  worktreePath: string;
  layers: readonly RepoDiffLayerKind[];
  scope: RepoDiffScopeMetadata;
}): ScopedRepoDiffSnapshot {
  const layers = input.layers.map((kind) => {
    const labels = repoDiffLayerLabels(kind);
    return {
      kind,
      baseLabel: labels.base,
      compareLabel: labels.compare,
      command: ["git", "diff"],
      patchOid: stableHash(`empty:${input.worktreePath}:${kind}:${input.scope.kind}`),
      rawPatch: "",
      rawPatchBytes: 0,
      truncated: false,
      files: [],
      shortstat: null,
    };
  });
  return {
    schema: "openscout.repo.diff/v1",
    generatedAt: Date.now(),
    worktreePath: input.worktreePath,
    layers,
    coverage: {
      requestedLayers: input.layers.length,
      emittedLayers: layers.length,
      files: 0,
      patchBytes: 0,
      truncatedLayers: 0,
      scanBudgetReached: false,
    },
    diagnostics: [],
    scout: { worktreeId: null, projectId: null, agents: [], sessions: [], hints: [] },
    render: {
      renderKey: stableHash(`empty-render:${input.worktreePath}:${input.layers.join(",")}:${input.scope.kind}`),
      cachePolicy: "local-disposable",
      preferredTheme: "pierre-dark",
      preferredLayout: "split",
    },
    scope: input.scope,
  };
}

function trimRepoDiffCache(cache: Map<string, RepoDiffCacheEntry>): void {
  while (cache.size > REPO_DIFF_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

async function repoPullRequestRoot(rawPath: string): Promise<string | null> {
  const trimmed = rawPath.trim();
  if (!trimmed) return null;
  const candidate = resolve(trimmed);
  try {
    if (!statSync(candidate).isDirectory()) return null;
  } catch {
    return null;
  }
  return await gitRevParse({ repoRoot: candidate, kind: "showToplevel" }) ?? candidate;
}

async function normalizeRepoPullRequestPaths(rawPaths: readonly string[], fallbackPath: string): Promise<string[]> {
  const sourcePaths = rawPaths.length > 0 ? rawPaths : [fallbackPath];
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const rawPath of sourcePaths) {
    const root = await repoPullRequestRoot(rawPath);
    if (!root) continue;
    const key = realpathSync(root);
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(root);
    if (roots.length >= REPO_PRS_MAX_PATHS) break;
  }
  return roots;
}

function repoNameFromGitRemote(remote: string | null, fallbackPath: string): string {
  if (remote) {
    const ssh = /^git@[^:]+:([^/]+\/.+?)(?:\.git)?$/.exec(remote);
    if (ssh) return ssh[1];
    try {
      const url = new URL(remote);
      const path = url.pathname.replace(/^\/+/, "").replace(/\.git$/, "");
      if (path.includes("/")) return path;
    } catch {
      const local = remote.replace(/\.git$/, "");
      if (local.includes("/")) return local.split("/").slice(-2).join("/");
    }
  }
  return basename(fallbackPath);
}

function parseGhPullRequests(stdout: string, repo: string, path: string): RepoPullRequestItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const items: RepoPullRequestItem[] = [];
  for (const raw of parsed as GhPullRequest[]) {
    if (
      typeof raw.number !== "number" ||
      typeof raw.title !== "string" ||
      typeof raw.url !== "string"
    ) {
      continue;
    }
    items.push({
      id: `${repo}#${raw.number}`,
      repo,
      path,
      number: raw.number,
      title: raw.title,
      url: raw.url,
      state: typeof raw.state === "string" ? raw.state : "OPEN",
      isDraft: Boolean(raw.isDraft),
      headRefName: typeof raw.headRefName === "string" ? raw.headRefName : "",
      baseRefName: typeof raw.baseRefName === "string" ? raw.baseRefName : "",
      author: typeof raw.author?.login === "string" ? raw.author.login : null,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
    });
  }
  return items;
}

const DEFAULT_REPO_PULL_REQUEST_LOAD_DEPS: RepoPullRequestLoadDeps = {
  gitRemoteGetUrlOrigin,
  gitCommonDir: (repoRoot) => gitRevParse({ repoRoot, kind: "gitCommonDir" }),
  execSystemFile,
};

function repoPullRequestCommonDirKey(path: string, commonDir: string | null): string {
  const trimmed = commonDir?.trim();
  if (!trimmed) {
    try {
      return `path:${realpathSync(path)}`;
    } catch {
      return `path:${resolve(path)}`;
    }
  }
  const absolute = isAbsolute(trimmed) ? trimmed : resolve(path, trimmed);
  try {
    return `common-dir:${realpathSync(absolute)}`;
  } catch {
    return `common-dir:${absolute}`;
  }
}

export async function loadRepoPullRequests(
  options: RepoPullRequestLoadOptions,
  deps: RepoPullRequestLoadDeps = DEFAULT_REPO_PULL_REQUEST_LOAD_DEPS,
): Promise<RepoPullRequestSnapshot> {
  const paths = options.paths.slice(0, REPO_PRS_MAX_PATHS);
  const limit = Math.max(1, Math.min(50, options.limitPerRepo || REPO_PRS_DEFAULT_LIMIT));
  const identities = await Promise.all(paths.map(async (path) => {
    const remote = (await deps.gitRemoteGetUrlOrigin(path))?.trim() || null;
    const commonDir = remote ? null : await deps.gitCommonDir(path).catch(() => null);
    return {
      key: remote ? `remote:${remote}` : repoPullRequestCommonDirKey(path, commonDir),
      path,
      repo: repoNameFromGitRemote(remote, path),
    };
  }));
  const repos = new Map<string, { path: string; repo: string }>();
  for (const identity of identities) {
    if (!repos.has(identity.key)) {
      repos.set(identity.key, { path: identity.path, repo: identity.repo });
    }
  }

  const results = await Promise.all([...repos.values()].map(async ({ path, repo }) => {
    try {
      const result = await deps.execSystemFile("gh", [
        "pr",
        "list",
        "--state",
        "open",
        "--limit",
        String(limit),
        "--json",
        "number,title,url,state,isDraft,headRefName,baseRefName,author,updatedAt",
      ], {
        cwd: path,
        timeoutMs: 2_500,
        maxStdoutBytes: 512 * 1024,
        maxStderrBytes: 128 * 1024,
      });
      return {
        pullRequests: parseGhPullRequests(result.stdout, repo, path),
        warning: null,
      };
    } catch {
      return {
        pullRequests: [],
        warning: `${repo}: open PRs unavailable`,
      };
    }
  }));

  const pullRequests = results.flatMap((result) => result.pullRequests);
  const warnings = results
    .map((result) => result.warning)
    .filter((warning): warning is string => Boolean(warning));

  return {
    generatedAt: Date.now(),
    source: "gh",
    paths,
    pullRequests: pullRequests.sort((left, right) => {
      const leftTime = left.updatedAt ? Date.parse(left.updatedAt) : 0;
      const rightTime = right.updatedAt ? Date.parse(right.updatedAt) : 0;
      return rightTime - leftTime || left.repo.localeCompare(right.repo) || right.number - left.number;
    }),
    warnings,
  };
}

export function mountRepoDiffRoutes(app: Hono, deps: RepoDiffRouteDeps): void {
  const repoDiffCache = new Map<string, RepoDiffCacheEntry>();
  const repoDiffInFlight = new Map<string, Promise<ScoutRepoDiffSnapshot>>();

  const runCachedRepoDiff = (
    key: string,
    runRepoDiff: (options: RepoDiffSnapshotOptions) => Promise<ScoutRepoDiffSnapshot>,
    snapshotOptions: RepoDiffSnapshotOptions,
  ): Promise<ScoutRepoDiffSnapshot> => {
    const active = repoDiffInFlight.get(key);
    if (active) return active;
    const request = runRepoDiff(snapshotOptions)
      .then((snapshot) => {
        repoDiffCache.delete(key);
        repoDiffCache.set(key, { snapshot, storedAt: Date.now() });
        trimRepoDiffCache(repoDiffCache);
        return snapshot;
      })
      .finally(() => {
        repoDiffInFlight.delete(key);
      });
    repoDiffInFlight.set(key, request);
    return request;
  };

  const serveRepoDiffSnapshot = async (
    c: Context,
    input: {
      worktreePath: string;
      layers: readonly RepoDiffLayerKind[];
      baseRef?: string;
      compareRef?: string;
      tier: RepoDiffTier;
      cacheMode: RepoDiffCacheMode;
      rehydrate: boolean;
      stateKey?: string;
      paths?: readonly string[];
      scope?: RepoDiffScopeMetadata;
    },
  ) => {
    const runRepoDiff = deps.repoDiffSnapshot ?? getRepoDiffSnapshot;
    const useInjectedSnapshot = Boolean(deps.repoDiffSnapshot);
    const cacheKey = repoDiffCacheKey({
      worktreePath: input.worktreePath,
      layers: input.layers,
      baseRef: input.baseRef,
      compareRef: input.compareRef,
      tier: input.tier,
      stateKey: input.stateKey,
      paths: input.paths,
    });
    const snapshotOptions: RepoDiffSnapshotOptions = {
      worktreePath: input.worktreePath,
      layers: input.layers.length > 0 ? [...input.layers] : undefined,
      baseRef: input.baseRef,
      compareRef: input.compareRef,
      paths: input.paths && input.paths.length > 0 ? [...input.paths] : undefined,
      limits: input.tier === "summary" ? REPO_DIFF_SUMMARY_LIMITS : REPO_DIFF_VIEWER_LIMITS,
    };

    if (shouldUseGitRepoDiffFallback({
      tier: input.tier,
      paths: input.paths,
      useInjectedSnapshot,
    })) {
      const snapshot = await buildGitRepoDiffSnapshot({
        worktreePath: input.worktreePath,
        layers: input.layers,
        baseRef: input.baseRef,
        compareRef: input.compareRef,
        tier: input.tier,
        paths: input.paths,
      });
      c.header("x-openscout-repo-diff-cache", "git");
      return c.json(input.scope ? withRepoDiffScope(snapshot, input.scope) : snapshot);
    }

    if (input.cacheMode !== "reload") {
      const cached = repoDiffCache.get(cacheKey);
      if (cached) {
        c.header("x-openscout-repo-diff-cache", "hit");
        c.header("x-openscout-repo-diff-cached-at", String(cached.storedAt));
        if (input.rehydrate) {
          c.header("x-openscout-repo-diff-rehydrate", "queued");
          void runCachedRepoDiff(cacheKey, runRepoDiff, snapshotOptions).catch(() => undefined);
        }
        return c.json(input.scope ? withRepoDiffScope(cached.snapshot, input.scope) : cached.snapshot);
      }
      if (input.cacheMode === "only") {
        c.header("x-openscout-repo-diff-cache", "miss");
        const warming = repoDiffInFlight.has(cacheKey);
        return c.json({
          status: warming ? "warming" : "missing",
          worktreePath: input.worktreePath,
          tier: input.tier,
          layers: input.layers,
          paths: input.paths ?? [],
        }, warming ? 202 : 404);
      }
    }

    try {
      const snapshot = await runCachedRepoDiff(cacheKey, runRepoDiff, snapshotOptions);
      c.header("x-openscout-repo-diff-cache", "miss");
      return c.json(input.scope ? withRepoDiffScope(snapshot, input.scope) : snapshot);
    } catch (error) {
      return c.json(
        { error: `repo-diff failed: ${error instanceof Error ? error.message : String(error)}` },
        502,
      );
    }
  };

  app.get("/api/repo-prs", async (c) => {
    const paths = await normalizeRepoPullRequestPaths(c.req.queries("path") ?? [], deps.currentDirectory);
    const limitPerRepo = parseOptionalPositiveInt(c.req.query("limit"), REPO_PRS_DEFAULT_LIMIT)
      ?? REPO_PRS_DEFAULT_LIMIT;
    if (paths.length === 0) {
      return c.json({
        generatedAt: Date.now(),
        source: "gh",
        paths: [],
        pullRequests: [],
        warnings: ["No git repositories available for open PR lookup."],
      } satisfies RepoPullRequestSnapshot);
    }
    const loadPullRequests = deps.repoPullRequests ?? loadRepoPullRequests;
    try {
      return c.json(await loadPullRequests({ paths, limitPerRepo }));
    } catch (error) {
      return c.json({
        generatedAt: Date.now(),
        source: "gh",
        paths,
        pullRequests: [],
        warnings: [error instanceof Error ? error.message : "open PR lookup failed"],
      } satisfies RepoPullRequestSnapshot);
    }
  });

  app.get("/api/repo-diff/session", async (c) => {
    const refId = c.req.query("sessionId")?.trim()
      || c.req.query("refId")?.trim()
      || c.req.query("ref")?.trim()
      || null;
    const agentId = c.req.query("agentId")?.trim() || null;
    if (!refId && !agentId) {
      return c.json({ error: "repo-diff session scope requires sessionId/refId or agentId" }, 400);
    }
    const payload = await loadRevealObservePayload({ agentId, sessionId: refId });
    if (!payload) {
      return c.json({ error: "observed session not found" }, 404);
    }
    const worktreePath = observedWorktreePath(payload);
    if (!worktreePath) {
      return c.json({ error: "observed session has no worktree path" }, 422);
    }
    const layers = (c.req.queries("layer") ?? []).filter(
      (value): value is RepoDiffLayerKind =>
        value === "unstaged" || value === "staged" || value === "branch",
    );
    const baseRef = c.req.query("baseRef");
    const compareRef = c.req.query("compareRef");
    const tier = parseRepoDiffTier(c.req.query("tier"));
    const cacheMode = parseRepoDiffCacheMode(c.req.query("cache"), c.req.query("force"));
    const rehydrate = wantsRepoDiffRehydrate(c.req.query("rehydrate"));
    const resolvedLayers = layers.length > 0 ? layers : DEFAULT_REPO_DIFF_LAYERS;
    const trimmedBaseRef = baseRef && baseRef.trim() ? baseRef.trim() : undefined;
    const trimmedCompareRef = compareRef && compareRef.trim() ? compareRef.trim() : undefined;
    const include = sessionDiffInclude(c.req.query("include"));
    const paths = normalizeRepoDiffPathFilters(worktreePath, sessionDiffTouchedPaths(payload, include));
    const changedFiles = payload.data.files.filter((file) => file.state !== "read").length;
    const scope: RepoDiffScopeMetadata = {
      kind: "session",
      label: include === "all" ? "Session-touched diff" : "Session changed-files diff",
      worktreePath,
      refId,
      agentId: payload.agentId,
      sessionId: payload.sessionId,
      filteredPaths: paths,
      touchedFiles: payload.data.files.length,
      changedFiles,
      include,
      caveat: "path-filtered-not-hunk-provenance",
    };
    if (paths.length === 0) {
      c.header("x-openscout-repo-diff-cache", "skip");
      return c.json(emptyRepoDiffSnapshot({ worktreePath, layers: resolvedLayers, scope }));
    }
    const resolvedRefs = await resolveRepoDiffBranchRefs({
      worktreePath,
      layers: resolvedLayers,
      baseRef: trimmedBaseRef,
      compareRef: trimmedCompareRef,
    });
    const stateKey = await repoDiffStateKey({
      worktreePath,
      layers: resolvedLayers,
      baseRef: resolvedRefs.baseRef,
      compareRef: resolvedRefs.compareRef,
      paths,
    });
    return serveRepoDiffSnapshot(c, {
      worktreePath,
      layers: resolvedLayers,
      baseRef: resolvedRefs.baseRef,
      compareRef: resolvedRefs.compareRef,
      tier,
      cacheMode,
      rehydrate,
      stateKey,
      paths,
      scope,
    });
  });

  app.get("/api/repo-diff/worktree", async (c) => {
    const path = c.req.query("path");
    if (!path || !path.trim()) {
      return c.json({ error: "repo-diff requires a worktree path" }, 400);
    }
    const layers = (c.req.queries("layer") ?? []).filter(
      (value): value is RepoDiffLayerKind =>
        value === "unstaged" || value === "staged" || value === "branch",
    );
    const baseRef = c.req.query("baseRef");
    const compareRef = c.req.query("compareRef");
    const tier = parseRepoDiffTier(c.req.query("tier"));
    const cacheMode = parseRepoDiffCacheMode(c.req.query("cache"), c.req.query("force"));
    const rehydrate = wantsRepoDiffRehydrate(c.req.query("rehydrate"));
    const resolvedLayers = layers.length > 0 ? layers : DEFAULT_REPO_DIFF_LAYERS;
    const trimmedPath = path.trim();
    const trimmedBaseRef = baseRef && baseRef.trim() ? baseRef.trim() : undefined;
    const trimmedCompareRef = compareRef && compareRef.trim() ? compareRef.trim() : undefined;
    const paths = repoDiffPathFiltersFromQuery(c, trimmedPath);
    const scope: RepoDiffScopeMetadata = {
      kind: "worktree",
      label: paths.length > 0 ? "Filtered worktree diff" : "Worktree diff",
      worktreePath: trimmedPath,
      filteredPaths: paths,
    };
    const resolvedRefs = await resolveRepoDiffBranchRefs({
      worktreePath: trimmedPath,
      layers: resolvedLayers,
      baseRef: trimmedBaseRef,
      compareRef: trimmedCompareRef,
    });
    const stateKey = await repoDiffStateKey({
      worktreePath: trimmedPath,
      layers: resolvedLayers,
      baseRef: resolvedRefs.baseRef,
      compareRef: resolvedRefs.compareRef,
      paths,
    });
    return serveRepoDiffSnapshot(c, {
      worktreePath: trimmedPath,
      layers: resolvedLayers,
      baseRef: resolvedRefs.baseRef,
      compareRef: resolvedRefs.compareRef,
      tier,
      cacheMode,
      rehydrate,
      stateKey,
      paths,
      scope,
    });
  });
}
