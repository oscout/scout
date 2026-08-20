import type { RuntimeEnv } from "./portable-types.js";
import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type OpenScoutResolutionSource =
  | "env"
  | "path"
  | "common-path"
  | "execPath"
  | "bundled"
  | "repo"
  | "node-modules";

export type JavaScriptRuntimeKind = "bun" | "node";

export type ResolvedExecutable = {
  path: string;
  source: OpenScoutResolutionSource;
};

export type ResolvedJavaScriptRuntime = ResolvedExecutable & {
  kind: JavaScriptRuntimeKind;
};

type ResolveExecutableOptions = {
  env?: RuntimeEnv;
  envKeys?: string[];
  names: string[];
  extraDirectories?: string[];
  commonDirectories?: string[];
};

type ResolveJavaScriptRuntimeOptions = {
  env?: RuntimeEnv;
  explicitEnvKeys?: string[];
  allowNode?: boolean;
  allowBun?: boolean;
  preferCurrentExecutable?: boolean;
};

type ResolveRepoRootOptions = {
  startDirectories?: Array<string | null | undefined>;
};

const DEFAULT_COMMON_EXECUTABLE_DIRECTORIES = [
  join(homedir(), ".bun", "bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
] as const;

function commonClaudeExecutableDirectories(env: RuntimeEnv): string[] {
  const home = env.HOME ?? homedir();
  return [
    join(home, ".local", "bin"),
    join(home, ".claude", "local"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(home, ".bun", "bin"),
  ];
}

export function expandHomePath(value: string, env: RuntimeEnv = process.env): string {
  const home = env.HOME ?? homedir();
  if (value === "~") {
    return home;
  }
  if (value.startsWith("~/")) {
    return join(home, value.slice(2));
  }
  return value;
}

export function isExecutablePath(candidate: string | null | undefined): candidate is string {
  if (!candidate) {
    return false;
  }

  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function splitPathEntries(env: RuntimeEnv = process.env): string[] {
  const separator = process.platform === "win32" ? ";" : ":";
  return (env.PATH ?? "").split(separator).filter(Boolean);
}

function dedupeDirectories(values: string[], env: RuntimeEnv): string[] {
  const seen = new Set<string>();
  const resolvedEntries: string[] = [];

  for (const value of values) {
    const normalized = resolve(expandHomePath(value, env));
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    resolvedEntries.push(normalized);
  }

  return resolvedEntries;
}

export function resolveExecutableFromSearch(options: ResolveExecutableOptions): ResolvedExecutable | null {
  const env = options.env ?? process.env;
  const envKeys = options.envKeys ?? [];

  for (const envKey of envKeys) {
    const explicit = env[envKey]?.trim();
    if (!explicit) {
      continue;
    }

    const expanded = expandHomePath(explicit, env);
    if (isExecutablePath(expanded)) {
      return { path: resolve(expanded), source: "env" };
    }

    const foundOnPath = findExecutableOnSearchPath(explicit, env);
    if (foundOnPath) {
      return { path: foundOnPath.path, source: "env" };
    }
  }

  const commonDirectories = dedupeDirectories(
    [...(options.commonDirectories ?? DEFAULT_COMMON_EXECUTABLE_DIRECTORIES)],
    env,
  );
  const searchDirectories = dedupeDirectories(
    [
      ...splitPathEntries(env),
      ...(options.extraDirectories ?? []),
      ...commonDirectories,
    ],
    env,
  );

  for (const directory of searchDirectories) {
    for (const name of options.names) {
      const candidate = join(directory, name);
      if (isExecutablePath(candidate)) {
        return {
          path: candidate,
          source: commonDirectories.includes(directory) ? "common-path" : "path",
        };
      }
    }
  }

  return null;
}

function resolveExecutableFromDirectories(
  directories: string[],
  names: string[],
  env: RuntimeEnv,
  source: OpenScoutResolutionSource,
): ResolvedExecutable | null {
  for (const directory of dedupeDirectories(directories, env)) {
    for (const name of names) {
      const candidate = join(directory, name);
      if (isExecutablePath(candidate)) {
        return { path: candidate, source };
      }
    }
  }

  return null;
}

export function resolveBunExecutable(env: RuntimeEnv = process.env): ResolvedExecutable | null {
  return resolveExecutableFromSearch({
    env,
    envKeys: ["OPENSCOUT_BUN_BIN", "SCOUT_BUN_BIN", "BUN_BIN"],
    names: ["bun"],
  });
}

export function resolveClaudeExecutable(env: RuntimeEnv = process.env): ResolvedExecutable | null {
  for (const envKey of ["OPENSCOUT_CLAUDE_BIN", "SCOUT_CLAUDE_BIN", "CLAUDE_BIN"]) {
    const explicit = env[envKey]?.trim();
    if (!explicit) {
      continue;
    }

    const expanded = expandHomePath(explicit, env);
    if (isExecutablePath(expanded)) {
      return { path: resolve(expanded), source: "env" };
    }

    const foundOnPath = findExecutableOnSearchPath(explicit, env);
    if (foundOnPath) {
      return { path: foundOnPath.path, source: "env" };
    }
  }

  return resolveExecutableFromDirectories(commonClaudeExecutableDirectories(env), ["claude"], env, "common-path")
    ?? resolveExecutableFromSearch({ env, names: ["claude"], commonDirectories: [] });
}

export function resolveJavaScriptRuntime(options: ResolveJavaScriptRuntimeOptions = {}): ResolvedJavaScriptRuntime | null {
  const env = options.env ?? process.env;
  const allowNode = options.allowNode ?? true;
  const allowBun = options.allowBun ?? true;
  const explicitEnvKeys = options.explicitEnvKeys ?? [];

  for (const envKey of explicitEnvKeys) {
    const explicit = env[envKey]?.trim();
    if (!explicit) {
      continue;
    }

    const expanded = expandHomePath(explicit, env);
    const resolvedExplicit = isExecutablePath(expanded)
      ? resolve(expanded)
      : findExecutableOnSearchPath(explicit, env)?.path;
    if (!resolvedExplicit) {
      continue;
    }

    const kind = javascriptRuntimeKindForPath(resolvedExplicit);
    if ((kind === "node" && allowNode) || (kind === "bun" && allowBun)) {
      return {
        path: resolvedExplicit,
        kind,
        source: "env",
      };
    }
  }

  if (options.preferCurrentExecutable ?? true) {
    const currentExecutable = process.execPath;
    const kind = javascriptRuntimeKindForPath(currentExecutable);
    if ((kind === "node" && allowNode) || (kind === "bun" && allowBun)) {
      return {
        path: currentExecutable,
        kind,
        source: "execPath",
      };
    }
  }

  const searchNames: string[] = [];
  if (allowNode) {
    searchNames.push("node");
  }
  if (allowBun) {
    searchNames.push("bun");
  }

  const resolvedExecutable = resolveExecutableFromSearch({
    env,
    names: searchNames,
  });
  if (!resolvedExecutable) {
    return null;
  }

  return {
    path: resolvedExecutable.path,
    kind: javascriptRuntimeKindForPath(resolvedExecutable.path),
    source: resolvedExecutable.source,
  };
}

export function resolveBundledEntrypoint(moduleUrl: string | URL, filename: string): string | null {
  const moduleDirectory = dirname(fileURLToPath(moduleUrl.toString()));
  const candidate = join(moduleDirectory, filename);
  return existsSync(candidate) ? candidate : null;
}

export function resolveOpenScoutRepoRoot(options: ResolveRepoRootOptions = {}): string | null {
  const starts = options.startDirectories
    ?.map((entry) => entry?.trim())
    .filter((entry): entry is string => Boolean(entry));
  if (!starts || starts.length === 0) {
    return null;
  }

  for (const start of starts) {
    let current = resolve(start);
    while (true) {
      const scoutEntry = join(current, "apps", "desktop", "bin", "scout.ts");
      const runtimeEntry = join(current, "packages", "runtime", "bin", "openscout-runtime.mjs");
      if (existsSync(scoutEntry) && existsSync(runtimeEntry)) {
        return current;
      }

      const parent = dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }

  return null;
}

export function resolveRepoEntrypoint(repoRoot: string | null, relativePath: string): string | null {
  if (!repoRoot) {
    return null;
  }

  const candidate = join(repoRoot, relativePath);
  return existsSync(candidate) ? candidate : null;
}

export function resolveNodeModulesPackageEntrypoint(
  moduleUrl: string | URL,
  packageSegments: string[],
  entryRelativePath: string,
): string | null {
  let current = dirname(fileURLToPath(moduleUrl.toString()));
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const candidate = join(current, "node_modules", ...packageSegments, entryRelativePath);
    if (existsSync(candidate)) {
      return candidate;
    }

    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return null;
}

function javascriptRuntimeKindForPath(filePath: string): JavaScriptRuntimeKind {
  return basename(filePath).toLowerCase().startsWith("bun") ? "bun" : "node";
}

function findExecutableOnSearchPath(name: string, env: RuntimeEnv): ResolvedExecutable | null {
  const searchDirectories = dedupeDirectories(
    [
      ...splitPathEntries(env),
      ...DEFAULT_COMMON_EXECUTABLE_DIRECTORIES,
    ],
    env,
  );

  for (const directory of searchDirectories) {
    const candidate = join(directory, name);
    if (isExecutablePath(candidate)) {
      return { path: candidate, source: "path" };
    }
  }

  return null;
}
