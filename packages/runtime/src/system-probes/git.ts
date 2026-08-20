import { execProbeFile, execSystemFile, ProbeCommandError } from "./exec.js";
import { canonicalRepoRoot } from "./git-build-info.js";
import { defineProbeFamily, type ProbeCtx } from "./registry.js";
import { runWithScoutdFallback } from "./scoutd-client.js";

const GIT_PROBE_TTL_MS = 60_000;
const DEFAULT_GIT_TIMEOUT_MS = 5_000;
const DEFAULT_GIT_STDOUT_BYTES = 1024 * 1024;
const DEFAULT_GIT_STDERR_BYTES = 256 * 1024;

export type GitCommandOptions = {
  maxAgeMs?: number;
  maxStdoutBytes?: number;
  timeoutMs?: number;
};

export type GitRevParseKind =
  | "showToplevel"
  | "gitDir"
  | "gitCommonDir"
  | "isInsideWorkTree"
  | "shortHead"
  | "abbrevRefHead"
  | "upstreamSymbolicFullName"
  | "verifyCommit";

export type GitRevParseInput = {
  repoRoot: string;
  kind: GitRevParseKind;
  ref?: string;
  quiet?: boolean;
};

export type GitDiffSelector =
  | { kind: "unstaged" }
  | { kind: "staged" }
  | { kind: "fromRef"; ref: string }
  | { kind: "twoRefs"; baseRef: string; compareRef: string }
  | { kind: "range"; notation: "dotdot" | "ellipsis"; baseRef: string; compareRef: string };

export type GitDiffInput = {
  repoRoot: string;
  selector: GitDiffSelector;
  paths?: readonly string[];
};

export type GitStatusPorcelainInput = {
  repoRoot: string;
  version: "v1" | "v2";
  branch?: boolean;
  z?: boolean;
  untrackedMode?: "normal";
  paths?: readonly string[];
};

export type GitLogNameOnlyInput = {
  repoRoot: string;
  baseRef: string;
  compareRef: string;
  notation?: "dotdot" | "ellipsis";
  paths?: readonly string[];
};

export type GitMergeBaseInput = {
  repoRoot: string;
  baseRef: string;
  compareRef: string;
};

export class GitCatalogValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitCatalogValidationError";
  }
}

function gitBin(): string {
  return process.env.OPENSCOUT_GIT_BIN?.trim() || "git";
}

function isUnavailable(error: unknown): boolean {
  return error instanceof ProbeCommandError
    && (error.code === "ENOENT" || error.code === "spawn" || error.code === "exit");
}

function validateNoNul(value: string, label: string): void {
  if (value.includes("\0")) {
    throw new GitCatalogValidationError(`${label} contains a NUL byte`);
  }
}

export function validateGitRefValue(value: string | undefined, label = "git ref"): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    throw new GitCatalogValidationError(`${label} is required`);
  }
  validateNoNul(trimmed, label);
  if (trimmed.startsWith("-")) {
    throw new GitCatalogValidationError(`${label} must not start with '-'`);
  }
  return trimmed;
}

export function validateGitPathspecValue(value: string | undefined, label = "git pathspec"): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    throw new GitCatalogValidationError(`${label} is required`);
  }
  validateNoNul(trimmed, label);
  if (trimmed.startsWith("-")) {
    throw new GitCatalogValidationError(`${label} must not start with '-'`);
  }
  return trimmed;
}

function validateGitPathspecs(paths: readonly string[] | undefined): string[] {
  return (paths ?? []).map((path, index) => validateGitPathspecValue(path, `git pathspec ${index + 1}`));
}

function normalizeRepoRoot(repoRoot: string): string {
  return canonicalRepoRoot(repoRoot);
}

function normalizedRevParseInput(input: GitRevParseInput): GitRevParseInput {
  const repoRoot = normalizeRepoRoot(input.repoRoot);
  if (input.kind === "verifyCommit") {
    return {
      repoRoot,
      kind: input.kind,
      ref: validateGitRefValue(input.ref, "git verify ref"),
      quiet: input.quiet === true,
    };
  }
  return { repoRoot, kind: input.kind };
}

function normalizeRevParseKey(input: GitRevParseInput): string {
  return JSON.stringify(normalizedRevParseInput(input));
}

function parseRevParseKey(key: string): GitRevParseInput {
  return JSON.parse(key) as GitRevParseInput;
}

function normalizedDiffSelector(selector: GitDiffSelector): GitDiffSelector {
  switch (selector.kind) {
    case "unstaged":
    case "staged":
      return selector;
    case "fromRef":
      return { kind: selector.kind, ref: validateGitRefValue(selector.ref, "git diff ref") };
    case "twoRefs":
      return {
        kind: selector.kind,
        baseRef: validateGitRefValue(selector.baseRef, "git diff base ref"),
        compareRef: validateGitRefValue(selector.compareRef, "git diff compare ref"),
      };
    case "range":
      return {
        kind: selector.kind,
        notation: selector.notation,
        baseRef: validateGitRefValue(selector.baseRef, "git diff base ref"),
        compareRef: validateGitRefValue(selector.compareRef, "git diff compare ref"),
      };
  }
}

function normalizedDiffInput(input: GitDiffInput): GitDiffInput {
  return {
    repoRoot: normalizeRepoRoot(input.repoRoot),
    selector: normalizedDiffSelector(input.selector),
    paths: validateGitPathspecs(input.paths),
  };
}

function normalizeDiffShortstatKey(input: GitDiffInput): string {
  return JSON.stringify(normalizedDiffInput(input));
}

function parseDiffKey(key: string): GitDiffInput {
  return JSON.parse(key) as GitDiffInput;
}

function normalizedMergeBaseInput(input: GitMergeBaseInput): GitMergeBaseInput {
  return {
    repoRoot: normalizeRepoRoot(input.repoRoot),
    baseRef: validateGitRefValue(input.baseRef, "git merge-base base ref"),
    compareRef: validateGitRefValue(input.compareRef, "git merge-base compare ref"),
  };
}

function normalizeMergeBaseKey(input: GitMergeBaseInput): string {
  return JSON.stringify(normalizedMergeBaseInput(input));
}

function parseMergeBaseKey(key: string): GitMergeBaseInput {
  return JSON.parse(key) as GitMergeBaseInput;
}

function validateGitStatusVersion(value: GitStatusPorcelainInput["version"]): "v1" | "v2" {
  if (value === "v1" || value === "v2") return value;
  throw new GitCatalogValidationError("git status porcelain version must be v1 or v2");
}

function normalizedStatusPorcelainInput(input: GitStatusPorcelainInput): GitStatusPorcelainInput {
  const untrackedMode = input.untrackedMode;
  if (untrackedMode !== undefined && untrackedMode !== "normal") {
    throw new GitCatalogValidationError("git status untrackedMode must be normal when provided");
  }
  return {
    repoRoot: normalizeRepoRoot(input.repoRoot),
    version: validateGitStatusVersion(input.version),
    branch: input.branch === true ? true : undefined,
    z: input.z === true ? true : undefined,
    untrackedMode,
    paths: validateGitPathspecs(input.paths),
  };
}

function normalizeStatusPorcelainKey(input: GitStatusPorcelainInput): string {
  return JSON.stringify(normalizedStatusPorcelainInput(input));
}

function parseStatusPorcelainKey(key: string): GitStatusPorcelainInput {
  return JSON.parse(key) as GitStatusPorcelainInput;
}

function revParseArgs(input: GitRevParseInput): string[] {
  switch (input.kind) {
    case "showToplevel":
      return ["rev-parse", "--show-toplevel"];
    case "gitDir":
      return ["rev-parse", "--git-dir"];
    case "gitCommonDir":
      return ["rev-parse", "--git-common-dir"];
    case "isInsideWorkTree":
      return ["rev-parse", "--is-inside-work-tree"];
    case "shortHead":
      return ["rev-parse", "--short", "HEAD"];
    case "abbrevRefHead":
      return ["rev-parse", "--abbrev-ref", "HEAD"];
    case "upstreamSymbolicFullName":
      return ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"];
    case "verifyCommit":
      return [
        "rev-parse",
        "--verify",
        ...(input.quiet === true ? ["--quiet"] : []),
        "--end-of-options",
        `${validateGitRefValue(input.ref, "git verify ref")}^{commit}`,
      ];
  }
}

function diffSelectorArgs(selector: GitDiffSelector): string[] {
  const normalized = normalizedDiffSelector(selector);
  switch (normalized.kind) {
    case "unstaged":
      return [];
    case "staged":
      return ["--cached"];
    case "fromRef":
      return ["--end-of-options", normalized.ref];
    case "twoRefs":
      return ["--end-of-options", normalized.baseRef, normalized.compareRef];
    case "range": {
      const operator = normalized.notation === "ellipsis" ? "..." : "..";
      return ["--end-of-options", `${normalized.baseRef}${operator}${normalized.compareRef}`];
    }
  }
}

function pathspecArgs(paths: readonly string[] | undefined): string[] {
  const normalized = validateGitPathspecs(paths);
  return normalized.length > 0 ? ["--", ...normalized] : [];
}

export function gitRevParseCommandArgs(input: GitRevParseInput): string[] {
  return revParseArgs(normalizedRevParseInput(input));
}

export function gitDiffCommandArgs(input: GitDiffInput & { output: "rawZ" | "numstat" | "numstatZ" | "shortstat" | "patch" }): string[] {
  const normalized = normalizedDiffInput(input);
  const outputArgs = (() => {
    switch (input.output) {
      case "rawZ":
        return ["--raw", "-z"];
      case "numstat":
        return ["--numstat"];
      case "numstatZ":
        return ["--numstat", "-z"];
      case "shortstat":
        return ["--shortstat"];
      case "patch":
        return ["--no-color", "--no-ext-diff", "--default-prefix", "--full-index", "-U3"];
    }
  })();
  return ["diff", ...outputArgs, ...diffSelectorArgs(normalized.selector), ...pathspecArgs(normalized.paths)];
}

function mergeBaseArgs(input: GitMergeBaseInput): string[] {
  const normalized = normalizedMergeBaseInput(input);
  return [
    "merge-base",
    "--end-of-options",
    normalized.baseRef,
    normalized.compareRef,
  ];
}

function statusPorcelainArgs(input: GitStatusPorcelainInput): string[] {
  const normalized = normalizedStatusPorcelainInput(input);
  const paths = normalized.paths ?? [];
  const args = ["status", `--porcelain=${normalized.version}`];
  if (normalized.branch) args.push("--branch");
  if (normalized.z) args.push("-z");
  if (normalized.untrackedMode === "normal") args.push("-unormal");
  if (paths.length > 0) args.push("--", ...paths);
  return args;
}

function logNameOnlyArgs(input: GitLogNameOnlyInput): string[] {
  const notation = input.notation ?? "dotdot";
  const operator = notation === "ellipsis" ? "..." : "..";
  const baseRef = validateGitRefValue(input.baseRef, "git log base ref");
  const compareRef = validateGitRefValue(input.compareRef, "git log compare ref");
  return [
    "log",
    "--name-only",
    "--pretty=format:",
    "--diff-filter=ACMRTUXB",
    "--end-of-options",
    `${baseRef}${operator}${compareRef}`,
    ...pathspecArgs(input.paths),
  ];
}

async function runGitCommandLocal(
  repoRoot: string,
  args: readonly string[],
  options: Required<Pick<GitCommandOptions, "maxStdoutBytes" | "timeoutMs">>,
): Promise<string | null> {
  try {
    const result = await execSystemFile(gitBin(), ["-C", normalizeRepoRoot(repoRoot), ...args], {
      timeoutMs: options.timeoutMs,
      maxStdoutBytes: options.maxStdoutBytes,
      maxStderrBytes: DEFAULT_GIT_STDERR_BYTES,
      probeId: "git.catalog",
    });
    return result.stdout;
  } catch (error) {
    if (isUnavailable(error)) return null;
    throw error;
  }
}

async function runGitProbeCommandLocal(
  ctx: ProbeCtx,
  repoRoot: string,
  args: readonly string[],
  maxStdoutBytes: number,
): Promise<string | null> {
  try {
    const result = await execProbeFile(ctx, gitBin(), ["-C", normalizeRepoRoot(repoRoot), ...args], {
      maxStdoutBytes,
      maxStderrBytes: DEFAULT_GIT_STDERR_BYTES,
    });
    return result.stdout;
  } catch (error) {
    if (isUnavailable(error)) return null;
    throw error;
  }
}

function trimOutput(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed : null;
}

export const gitRevParseProbe = defineProbeFamily<GitRevParseInput, string | null>({
  id: "git.revParse",
  ttlMs: GIT_PROBE_TTL_MS,
  timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
  maxKeys: 256,
  idleKeyTtlMs: 10 * 60_000,
  maxConcurrentKeys: 4,
  normalizeKey: normalizeRevParseKey,
  run: (key, ctx) => runWithScoutdFallback({
    probeId: "git.revParse",
    key,
    ctx,
    local: async () => {
      const input = parseRevParseKey(key);
      return trimOutput(await runGitProbeCommandLocal(ctx, input.repoRoot, revParseArgs(input), 256 * 1024));
    },
  }),
});

export const gitDiffShortstatProbe = defineProbeFamily<GitDiffInput, string | null>({
  id: "git.diffShortstat",
  ttlMs: GIT_PROBE_TTL_MS,
  timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
  maxKeys: 256,
  idleKeyTtlMs: 10 * 60_000,
  maxConcurrentKeys: 4,
  normalizeKey: normalizeDiffShortstatKey,
  run: (key, ctx) => runWithScoutdFallback({
    probeId: "git.diffShortstat",
    key,
    ctx,
    local: async () => {
      const input = parseDiffKey(key);
      return trimOutput(await runGitProbeCommandLocal(ctx, input.repoRoot, gitDiffCommandArgs({ ...input, output: "shortstat" }), 256 * 1024));
    },
  }),
});

export const gitMergeBaseProbe = defineProbeFamily<GitMergeBaseInput, string | null>({
  id: "git.mergeBase",
  ttlMs: GIT_PROBE_TTL_MS,
  timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
  maxKeys: 256,
  idleKeyTtlMs: 10 * 60_000,
  maxConcurrentKeys: 4,
  normalizeKey: normalizeMergeBaseKey,
  run: (key, ctx) => runWithScoutdFallback({
    probeId: "git.mergeBase",
    key,
    ctx,
    local: async () => {
      const input = parseMergeBaseKey(key);
      return trimOutput(await runGitProbeCommandLocal(ctx, input.repoRoot, mergeBaseArgs(input), 256 * 1024));
    },
  }),
});

export const gitStatusPorcelainProbe = defineProbeFamily<GitStatusPorcelainInput, string | null>({
  id: "git.statusPorcelain",
  ttlMs: GIT_PROBE_TTL_MS,
  timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
  maxKeys: 256,
  idleKeyTtlMs: 10 * 60_000,
  maxConcurrentKeys: 4,
  normalizeKey: normalizeStatusPorcelainKey,
  run: (key, ctx) => runWithScoutdFallback({
    probeId: "git.statusPorcelain",
    key,
    ctx,
    local: async () => {
      const input = parseStatusPorcelainKey(key);
      return await runGitProbeCommandLocal(ctx, input.repoRoot, statusPorcelainArgs(input), DEFAULT_GIT_STDOUT_BYTES);
    },
  }),
});

export const gitLogLastCommitUnixProbe = defineProbeFamily<string, string | null>({
  id: "git.logLastCommitUnix",
  ttlMs: GIT_PROBE_TTL_MS,
  timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
  maxKeys: 256,
  idleKeyTtlMs: 10 * 60_000,
  maxConcurrentKeys: 4,
  normalizeKey: (repoRoot) => normalizeRepoRoot(repoRoot),
  run: (repoRoot, ctx) => runWithScoutdFallback({
    probeId: "git.logLastCommitUnix",
    key: repoRoot,
    ctx,
    local: async () => trimOutput(await runGitProbeCommandLocal(ctx, repoRoot, ["log", "-1", "--format=%ct"], 64 * 1024)),
  }),
});

export const gitWorktreeListPorcelainProbe = defineProbeFamily<string, string | null>({
  id: "git.worktreeListPorcelain",
  ttlMs: GIT_PROBE_TTL_MS,
  timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
  maxKeys: 256,
  idleKeyTtlMs: 10 * 60_000,
  maxConcurrentKeys: 4,
  normalizeKey: (repoRoot) => normalizeRepoRoot(repoRoot),
  run: (repoRoot, ctx) => runWithScoutdFallback({
    probeId: "git.worktreeListPorcelain",
    key: repoRoot,
    ctx,
    local: async () => await runGitProbeCommandLocal(ctx, repoRoot, ["worktree", "list", "--porcelain"], DEFAULT_GIT_STDOUT_BYTES),
  }),
});

export async function gitRevParse(input: GitRevParseInput, options: GitCommandOptions = {}): Promise<string | null> {
  const snapshot = await gitRevParseProbe.for(input).fresh({ maxAgeMs: options.maxAgeMs ?? GIT_PROBE_TTL_MS });
  return snapshot.value ?? null;
}

export async function gitDiffShortstat(input: GitDiffInput, options: GitCommandOptions = {}): Promise<string | null> {
  const snapshot = await gitDiffShortstatProbe.for(input).fresh({ maxAgeMs: options.maxAgeMs ?? GIT_PROBE_TTL_MS });
  return snapshot.value ?? null;
}

export async function gitMergeBase(input: GitMergeBaseInput, options: GitCommandOptions = {}): Promise<string | null> {
  const snapshot = await gitMergeBaseProbe.for(input).fresh({ maxAgeMs: options.maxAgeMs ?? GIT_PROBE_TTL_MS });
  return snapshot.value ?? null;
}

export async function gitStatusPorcelain(input: GitStatusPorcelainInput, options: GitCommandOptions = {}): Promise<string | null> {
  const snapshot = await gitStatusPorcelainProbe.for(input).fresh({ maxAgeMs: options.maxAgeMs ?? GIT_PROBE_TTL_MS });
  return snapshot.value ?? null;
}

export async function gitDiffRaw(input: GitDiffInput, options: GitCommandOptions = {}): Promise<string | null> {
  return await runGitCommandLocal(input.repoRoot, gitDiffCommandArgs({ ...input, output: "rawZ" }), {
    maxStdoutBytes: options.maxStdoutBytes ?? DEFAULT_GIT_STDOUT_BYTES,
    timeoutMs: options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
  });
}

export async function gitDiffNumstat(input: GitDiffInput & { z?: boolean }, options: GitCommandOptions = {}): Promise<string | null> {
  return await runGitCommandLocal(input.repoRoot, gitDiffCommandArgs({ ...input, output: input.z ? "numstatZ" : "numstat" }), {
    maxStdoutBytes: options.maxStdoutBytes ?? DEFAULT_GIT_STDOUT_BYTES,
    timeoutMs: options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
  });
}

export async function gitDiffPatch(input: GitDiffInput, options: GitCommandOptions = {}): Promise<string | null> {
  return await runGitCommandLocal(input.repoRoot, gitDiffCommandArgs({ ...input, output: "patch" }), {
    maxStdoutBytes: options.maxStdoutBytes ?? DEFAULT_GIT_STDOUT_BYTES,
    timeoutMs: options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
  });
}

export async function gitLogNameOnly(input: GitLogNameOnlyInput, options: GitCommandOptions = {}): Promise<string | null> {
  return await runGitCommandLocal(input.repoRoot, logNameOnlyArgs(input), {
    maxStdoutBytes: options.maxStdoutBytes ?? DEFAULT_GIT_STDOUT_BYTES,
    timeoutMs: options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
  });
}

export async function gitLogLastCommitUnix(repoRoot: string, options: GitCommandOptions = {}): Promise<string | null> {
  const snapshot = await gitLogLastCommitUnixProbe.for(repoRoot).fresh({ maxAgeMs: options.maxAgeMs ?? GIT_PROBE_TTL_MS });
  return snapshot.value ?? null;
}

export async function gitWorktreeListPorcelain(repoRoot: string, options: GitCommandOptions = {}): Promise<string | null> {
  const snapshot = await gitWorktreeListPorcelainProbe.for(repoRoot).fresh({ maxAgeMs: options.maxAgeMs ?? GIT_PROBE_TTL_MS });
  return snapshot.value ?? null;
}

export async function gitRemoteGetUrlOrigin(repoRoot: string, options: GitCommandOptions = {}): Promise<string | null> {
  return trimOutput(await runGitCommandLocal(repoRoot, ["remote", "get-url", "origin"], {
    maxStdoutBytes: options.maxStdoutBytes ?? 256 * 1024,
    timeoutMs: options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
  }));
}
