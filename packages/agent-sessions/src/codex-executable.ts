import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

export type CodexExecutableSource =
  | "env:OPENSCOUT_CODEX_BIN"
  | "env:CODEX_BIN"
  | "codex_app_bundle"
  | "path"
  | "common"
  | "fallback";

export type CodexExecutableCandidate = {
  path: string;
  source: CodexExecutableSource;
  executable: boolean;
  version: string | null;
  versionRaw: string | null;
};

export type CodexExecutableInventory = {
  selectedPath: string;
  selected: CodexExecutableCandidate | null;
  candidates: CodexExecutableCandidate[];
};

type CandidateInput = {
  path: string;
  source: CodexExecutableSource;
};

function isExecutable(filePath: string | undefined): boolean {
  if (!filePath) return false;
  if (filePath === "codex") return true;

  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function readCodexVersion(candidate: string): { version: string | null; versionRaw: string | null } {
  if (!isExecutable(candidate)) {
    return { version: null, versionRaw: null };
  }

  try {
    const raw = execFileSync(candidate, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3_000,
    }).trim();
    const version = raw.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/)?.[1] ?? null;
    return { version, versionRaw: raw || null };
  } catch {
    return { version: null, versionRaw: null };
  }
}

function uniqueCandidates(candidates: CandidateInput[]): CandidateInput[] {
  const seen = new Set<string>();
  const unique: CandidateInput[] = [];
  for (const candidate of candidates) {
    if (!candidate.path || seen.has(candidate.path)) continue;
    seen.add(candidate.path);
    unique.push(candidate);
  }
  return unique;
}

function codexAppBundleCandidates(env: Record<string, string | undefined>): CandidateInput[] {
  const appNames = ["Codex.app", "ChatGPT.app"];
  const candidates = appNames.flatMap((appName): CandidateInput[] => [
    {
      path: join("/Applications", appName, "Contents", "Resources", "codex"),
      source: "codex_app_bundle",
    },
    {
      path: join(env.HOME ?? "", "Applications", appName, "Contents", "Resources", "codex"),
      source: "codex_app_bundle",
    },
  ]);
  return candidates.filter((candidate) => candidate.path.trim().length > 0);
}

function pathCandidates(env: Record<string, string | undefined>): CandidateInput[] {
  return (env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => ({
      path: join(directory, "codex"),
      source: "path" as const,
    }));
}

function commonCandidates(env: Record<string, string | undefined>): CandidateInput[] {
  return [
    `${env.HOME ?? ""}/.local/bin`,
    `${env.HOME ?? ""}/.bun/bin`,
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ]
    .filter(Boolean)
    .map((directory) => ({
      path: join(directory, "codex"),
      source: "common" as const,
    }));
}

export function resolveCodexExecutableCandidateInputs(
  env: Record<string, string | undefined> = process.env,
): CandidateInput[] {
  const explicit: CandidateInput[] = [];
  if (env.OPENSCOUT_CODEX_BIN) {
    explicit.push({ path: env.OPENSCOUT_CODEX_BIN, source: "env:OPENSCOUT_CODEX_BIN" });
  }
  if (env.CODEX_BIN) {
    explicit.push({ path: env.CODEX_BIN, source: "env:CODEX_BIN" });
  }

  return uniqueCandidates([
    ...explicit,
    ...codexAppBundleCandidates(env),
    ...pathCandidates(env),
    ...commonCandidates(env),
    { path: "codex", source: "fallback" },
  ]);
}

export function resolveCodexExecutableCandidates(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return resolveCodexExecutableCandidateInputs(env).map((candidate) => candidate.path);
}

function parseVersion(value: string | null): { major: number; minor: number; patch: number; prerelease: string | null } | null {
  if (!value) return null;
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

function compareVersions(left: string | null, right: string | null): number {
  const lhs = parseVersion(left);
  const rhs = parseVersion(right);
  if (!lhs && !rhs) return 0;
  if (!lhs) return -1;
  if (!rhs) return 1;

  for (const key of ["major", "minor", "patch"] as const) {
    if (lhs[key] !== rhs[key]) {
      return lhs[key] - rhs[key];
    }
  }

  if (lhs.prerelease === rhs.prerelease) return 0;
  if (!lhs.prerelease) return 1;
  if (!rhs.prerelease) return -1;
  return lhs.prerelease.localeCompare(rhs.prerelease);
}

function sourceRank(source: CodexExecutableSource): number {
  switch (source) {
    case "env:OPENSCOUT_CODEX_BIN":
      return 0;
    case "env:CODEX_BIN":
      return 1;
    case "codex_app_bundle":
      return 2;
    case "path":
      return 3;
    case "common":
      return 4;
    case "fallback":
      return 5;
  }
}

function selectCodexCandidate(candidates: CodexExecutableCandidate[]): CodexExecutableCandidate | null {
  const executable = candidates.filter((candidate) => candidate.executable);
  if (executable.length === 0) return null;

  const explicit = executable.find((candidate) =>
    candidate.source === "env:OPENSCOUT_CODEX_BIN" || candidate.source === "env:CODEX_BIN"
  );
  if (explicit) return explicit;

  return executable
    .slice()
    .sort((left, right) => {
      const versionComparison = compareVersions(right.version, left.version);
      if (versionComparison !== 0) return versionComparison;
      return sourceRank(left.source) - sourceRank(right.source);
    })[0] ?? null;
}

export function resolveCodexExecutableInventory(
  env: Record<string, string | undefined> = process.env,
): CodexExecutableInventory {
  const candidates = resolveCodexExecutableCandidateInputs(env).map((candidate) => {
    const executable = isExecutable(candidate.path);
    const version = readCodexVersion(candidate.path);
    return {
      ...candidate,
      executable,
      version: version.version,
      versionRaw: version.versionRaw,
    };
  });
  const selected = selectCodexCandidate(candidates);
  return {
    selectedPath: selected?.path ?? "codex",
    selected,
    candidates,
  };
}

export function resolveCodexExecutable(env: Record<string, string | undefined> = process.env): string {
  return resolveCodexExecutableInventory(env).selectedPath;
}
