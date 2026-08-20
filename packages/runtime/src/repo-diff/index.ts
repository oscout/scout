// Repo Diff (SCO-065) — the broker-side join for the on-demand diff viewer.
//
// The Rust `openscout-repo-service diff` command produces raw, bounded Git diff
// facts (`openscout.repo.diff/v1`). This module launches it for a single
// worktree and wraps the raw facts with Scout context (attached agents /
// sessions / hints) and render hints, producing a `ScoutRepoDiffSnapshot`.
//
// Ownership mirrors repo-watch: Rust observes the machine, TypeScript
// interprets Scout. Raw patch text is never persisted here.

import {
  normalizeHints,
  normalizePath,
  pathContains,
  refsForHints,
  type RepoWatchAgentRef,
  type RepoWatchHintSummary,
  type RepoWatchPathHint,
  type RepoWatchSessionRef,
} from "../repo-watch/index.js";
import {
  repoServiceTransportMetadata,
  resolveRepoServiceCommand,
  runRepoServiceJson,
} from "../repo-service/process.js";
import { gitMergeBase, gitRevParse, GitCatalogValidationError, type GitCommandOptions, type GitMergeBaseInput, type GitRevParseInput } from "../system-probes/git.js";

// ── Native contract (mirrors crates/openscout-repo-service/src/diff.rs) ─────

export type RepoDiffLayerKind = "unstaged" | "staged" | "branch";

export type RepoDiffFileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "typechange"
  | "conflict"
  | "unknown";

export type RepoDiffLimits = {
  maxPatchBytes?: number;
  maxFiles?: number;
  maxHunksPerFile?: number;
  maxLinesPerHunk?: number;
  timeoutMs?: number;
  includeRawPatch?: boolean;
  includeParsedHunks?: boolean;
  includeBinaryPatch?: boolean;
};

export type RepoDiffNativeRequest = {
  schema?: "openscout.repo.diff.request/v1";
  worktreePath: string;
  layers?: RepoDiffLayerKind[];
  baseRef?: string | null;
  compareRef?: string | null;
  paths?: string[];
  limits?: RepoDiffLimits;
};

export type RepoDiffHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  section: string | null;
  additions: number;
  deletions: number;
  truncated: boolean;
};

export type RepoDiffFile = {
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
};

export type RepoDiffLayer = {
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
};

export type RepoDiffCoverage = {
  requestedLayers: number;
  emittedLayers: number;
  files: number;
  patchBytes: number;
  truncatedLayers: number;
  scanBudgetReached: boolean;
};

export type RepoDiffDiagnostic = {
  level: "info" | "warning";
  kind: string;
  message: string;
  path: string | null;
};

export type RepoDiffResponse = {
  schema: "openscout.repo.diff/v1" | string;
  generatedAt: number;
  worktreePath: string;
  layers: RepoDiffLayer[];
  coverage: RepoDiffCoverage;
  diagnostics: RepoDiffDiagnostic[];
};

// ── Scout-wrapped snapshot (the UI/API contract) ───────────────────────────

export type RepoDiffScoutContext = {
  worktreeId: string | null;
  projectId: string | null;
  agents: RepoWatchAgentRef[];
  sessions: RepoWatchSessionRef[];
  hints: RepoWatchHintSummary[];
};

export type RepoDiffRenderHints = {
  renderKey: string;
  cachePolicy: "local-disposable";
  preferredTheme: string;
  preferredLayout: "split" | "stacked";
};

export type ScoutRepoDiffSnapshot = RepoDiffResponse & {
  scout: RepoDiffScoutContext;
  render: RepoDiffRenderHints;
};

export type RepoDiffNativeExec = (
  request: RepoDiffNativeRequest,
) => Promise<RepoDiffResponse>;

export type RepoDiffGitExec = {
  revParse: (input: GitRevParseInput, options?: GitCommandOptions) => Promise<string | null>;
  mergeBase: (input: GitMergeBaseInput, options?: GitCommandOptions) => Promise<string | null>;
};

export type RepoDiffSnapshotOptions = {
  worktreePath: string;
  layers?: RepoDiffLayerKind[];
  baseRef?: string | null;
  compareRef?: string | null;
  paths?: string[];
  limits?: RepoDiffLimits;
  hints?: RepoWatchPathHint[];
  preferredTheme?: string;
  preferredLayout?: "split" | "stacked";
  nativeDiff?: RepoDiffNativeExec;
  git?: RepoDiffGitExec;
  now?: () => number;
};

const DEFAULT_NATIVE_TIMEOUT_MS = 15_000;
const RENDER_OPTIONS_VERSION = 1;
const DEFAULT_PREFERRED_THEME = "pierre-dark";
const DEFAULT_PREFERRED_LAYOUT: "split" | "stacked" = "split";
const DEFAULT_REPO_DIFF_LAYERS: RepoDiffLayerKind[] = ["branch", "unstaged", "staged"];
const TRUNK_REFS = [
  "origin/main",
  "main",
  "origin/master",
  "master",
  "origin/trunk",
  "trunk",
];

async function defaultNativeRepoDiff(request: RepoDiffNativeRequest): Promise<RepoDiffResponse> {
  const command = resolveRepoServiceCommand("diff");
  const timeoutMs = Math.max(2_000, (request.limits?.timeoutMs ?? DEFAULT_NATIVE_TIMEOUT_MS) + 1_500);
  const output = await runRepoServiceJson(command, request, timeoutMs, "diff");

  if (!output || typeof output !== "object") {
    throw new Error("Repo service returned a non-object response.");
  }
  const response = output as RepoDiffResponse;
  if (response.schema !== "openscout.repo.diff/v1" || !Array.isArray(response.layers)) {
    throw new Error("Repo service returned an unsupported diff response.");
  }
  const transport = repoServiceTransportMetadata(output);
  if (transport?.backend === "spawn-fallback") {
    response.diagnostics = [
      ...(response.diagnostics ?? []),
      {
        level: "warning",
        kind: "repo_service_transport_fallback",
        message: `Repo service used spawn fallback because scoutd was unavailable: ${transport.fallbackReason ?? "unknown reason"}`,
        path: null,
      },
    ];
  }
  return response;
}

/**
 * Produce a Scout-wrapped diff snapshot for one worktree. Rust supplies the raw
 * diff facts; this attaches the agents/sessions/hints near the worktree and a
 * content-stable render key for the local Pierre cache.
 */
export async function getRepoDiffSnapshot(
  options: RepoDiffSnapshotOptions,
): Promise<ScoutRepoDiffSnapshot> {
  const nativeDiff = options.nativeDiff ?? defaultNativeRepoDiff;
  const worktreePath = normalizePath(options.worktreePath);
  const layers = options.layers && options.layers.length > 0
    ? options.layers
    : DEFAULT_REPO_DIFF_LAYERS;
  const resolvedRefs = await resolveBranchLayerRefs(worktreePath, {
    ...options,
    layers,
  });

  const request: RepoDiffNativeRequest = {
    schema: "openscout.repo.diff.request/v1",
    worktreePath,
  };
  request.layers = layers;
  if (resolvedRefs.baseRef != null) request.baseRef = resolvedRefs.baseRef;
  if (resolvedRefs.compareRef != null) request.compareRef = resolvedRefs.compareRef;
  if (options.paths && options.paths.length > 0) request.paths = options.paths;
  if (options.limits) request.limits = options.limits;

  const response = await nativeDiff(request);

  const scout = buildScoutContext(worktreePath, options.hints ?? []);
  const render = buildRenderHints(response, worktreePath, options);

  return { ...response, scout, render };
}

const defaultGit: RepoDiffGitExec = {
  revParse: gitRevParse,
  mergeBase: gitMergeBase,
};

async function safeGit(run: () => Promise<string | null>): Promise<string | null> {
  try {
    const output = await run();
    return output?.trim() ? output.trim() : null;
  } catch (error) {
    if (error instanceof GitCatalogValidationError) throw error;
    return null;
  }
}

async function resolveCommit(
  git: RepoDiffGitExec,
  cwd: string,
  ref: string,
): Promise<string | null> {
  return safeGit(() => git.revParse({ repoRoot: cwd, kind: "verifyCommit", ref }, { maxAgeMs: 0 }));
}

async function preferredBranchBaseRef(
  git: RepoDiffGitExec,
  cwd: string,
): Promise<string | null> {
  const upstream = await safeGit(() => git.revParse({ repoRoot: cwd, kind: "upstreamSymbolicFullName" }, { maxAgeMs: 0 }));
  const candidates = [
    ...TRUNK_REFS,
    upstream,
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    if (candidate === "HEAD") continue;
    const oid = await resolveCommit(git, cwd, candidate);
    if (oid) return candidate;
  }
  return null;
}

async function resolveBranchLayerRefs(
  worktreePath: string,
  options: RepoDiffSnapshotOptions,
): Promise<{ baseRef?: string; compareRef?: string }> {
  if (!options.layers?.includes("branch")) {
    return {
      baseRef: options.baseRef ?? undefined,
      compareRef: options.compareRef ?? undefined,
    };
  }

  const git = options.git ?? defaultGit;
  const compareRef = options.compareRef?.trim() || "HEAD";
  const compareOid = await resolveCommit(git, worktreePath, compareRef);
  if (!compareOid) {
    return {
      baseRef: options.baseRef ?? undefined,
      compareRef: options.compareRef ?? undefined,
    };
  }

  const baseCandidate = options.baseRef?.trim()
    || await preferredBranchBaseRef(git, worktreePath);
  if (!baseCandidate) {
    return { compareRef: compareOid };
  }
  const baseOid = await resolveCommit(git, worktreePath, baseCandidate);
  if (!baseOid) {
    return { baseRef: baseCandidate, compareRef: compareOid };
  }
  const mergeBase = await safeGit(() => git.mergeBase({
    repoRoot: worktreePath,
    baseRef: baseOid,
    compareRef: compareOid,
  }));
  return {
    baseRef: mergeBase ?? baseOid,
    compareRef: compareOid,
  };
}

function buildScoutContext(
  worktreePath: string,
  rawHints: RepoWatchPathHint[],
): RepoDiffScoutContext {
  const matched = normalizeHints(rawHints).filter(
    (hint) => pathContains(worktreePath, hint.path) || pathContains(hint.path, worktreePath),
  );
  const { agents, sessions } = refsForHints(matched);
  return {
    worktreeId: stableId(`worktree:${worktreePath}`),
    projectId: null,
    agents,
    sessions,
    hints: matched,
  };
}

function buildRenderHints(
  response: RepoDiffResponse,
  worktreePath: string,
  options: RepoDiffSnapshotOptions,
): RepoDiffRenderHints {
  // Content identity for the local render cache. The client appends its own
  // theme/layout per SCO-065 §12; this is the shared, path+content portion. The
  // render-options version lets a Pierre/Shiki upgrade invalidate every key.
  const layerIdentity = response.layers
    .map((layer) => `${layer.kind}:${layer.patchOid}`)
    .join("|");
  const renderKey = stableId(
    `openscout-diff:v${RENDER_OPTIONS_VERSION}:${worktreePath}:${layerIdentity}`,
  );
  return {
    renderKey,
    cachePolicy: "local-disposable",
    preferredTheme: options.preferredTheme ?? DEFAULT_PREFERRED_THEME,
    preferredLayout: options.preferredLayout ?? DEFAULT_PREFERRED_LAYOUT,
  };
}

// FNV-1a (32-bit) — a short, stable, non-cryptographic id. Mirrors the
// hashing repo-watch uses for worktree ids; client cache ids never expose
// absolute paths (SCO-065 §12).
function stableId(input: string): string {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
