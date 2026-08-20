import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { defineProbeFamily, type ProbeCtx } from "./registry.js";
import { execProbeFile, ProbeCommandError } from "./exec.js";
import { runWithScoutdFallback } from "./scoutd-client.js";

export type GitBuildInfo = {
  repoRoot: string;
  commit: string | null;
  bootBranch: string | null;
  branch: string | null;
  dirty: boolean | null;
  metadataAt: number;
  statusAt: number | null;
};

type StaticGitBuildMetadata = {
  commit: string | null;
  bootBranch: string | null;
  metadataAt: number;
};

const staticMetadataByRepo = new Map<string, StaticGitBuildMetadata>();

function realpathOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function directoryOrParent(path: string): string {
  const resolved = resolve(path);
  try {
    const stat = statSync(resolved);
    return stat.isDirectory() ? resolved : dirname(resolved);
  } catch {
    return resolved;
  }
}

export function canonicalRepoRoot(rawPath: string): string {
  let current = realpathOrResolved(directoryOrParent(rawPath));
  while (true) {
    if (existsSync(resolve(current, ".git"))) {
      return realpathOrResolved(current);
    }
    const parent = dirname(current);
    if (parent === current) {
      return realpathOrResolved(directoryOrParent(rawPath));
    }
    current = parent;
  }
}

async function gitOutput(repoRoot: string, args: readonly string[], ctx: ProbeCtx): Promise<string | null> {
  try {
    const gitBin = process.env.OPENSCOUT_GIT_BIN?.trim() || "git";
    const { stdout } = await execProbeFile(ctx, gitBin, ["-C", repoRoot, ...args], {
      maxStdoutBytes: 256 * 1024,
      maxStderrBytes: 64 * 1024,
    });
    return stdout;
  } catch (error) {
    if (error instanceof ProbeCommandError && (error.code === "ENOENT" || error.code === "spawn" || error.code === "exit")) {
      return null;
    }
    throw error;
  }
}

async function gitValue(repoRoot: string, args: readonly string[], ctx: ProbeCtx): Promise<string | null> {
  const output = await gitOutput(repoRoot, args, ctx);
  const value = output?.trim() ?? "";
  return value.length > 0 ? value : null;
}

async function loadStaticMetadata(repoRoot: string, ctx: ProbeCtx): Promise<StaticGitBuildMetadata> {
  const cached = staticMetadataByRepo.get(repoRoot);
  if (cached) {
    return cached;
  }
  const metadata: StaticGitBuildMetadata = {
    commit: await gitValue(repoRoot, ["rev-parse", "--short", "HEAD"], ctx),
    bootBranch: await gitValue(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"], ctx),
    metadataAt: Date.now(),
  };
  staticMetadataByRepo.set(repoRoot, metadata);
  return metadata;
}

export function resetGitBuildInfoProbeForTests(): void {
  staticMetadataByRepo.clear();
}

export const gitBuildInfoProbe = defineProbeFamily<string, GitBuildInfo>({
  id: "git.buildInfo",
  ttlMs: 60_000,
  timeoutMs: 1_500,
  maxKeys: 64,
  idleKeyTtlMs: 10 * 60_000,
  maxConcurrentKeys: 2,
  normalizeKey: canonicalRepoRoot,
  run: async (repoRoot, ctx) => runWithScoutdFallback({
    probeId: "git.buildInfo",
    key: repoRoot,
    ctx,
    local: async () => {
      const metadata = await loadStaticMetadata(repoRoot, ctx);
      const [branch, dirtyStatus] = await Promise.all([
        gitValue(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"], ctx),
        gitOutput(repoRoot, ["status", "--porcelain"], ctx),
      ]);
      return {
        repoRoot,
        commit: metadata.commit,
        bootBranch: metadata.bootBranch,
        branch: branch ?? metadata.bootBranch,
        dirty: dirtyStatus === null ? null : dirtyStatus.trim().length > 0,
        metadataAt: metadata.metadataAt,
        statusAt: Date.now(),
      };
    },
  }),
});
