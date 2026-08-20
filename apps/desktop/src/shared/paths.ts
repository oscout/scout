import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type PackageJson = {
  name?: unknown;
  workspaces?: unknown;
};

export type ScoutPathResolutionOptions = {
  currentDirectory?: string | null;
  env?: NodeJS.ProcessEnv;
  moduleDirectory?: string | null;
};

function looksLikeWorkspaceRoot(candidate: string): boolean {
  const packageJsonPath = join(candidate, "package.json");
  if (!existsSync(packageJsonPath)) {
    return false;
  }

  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as PackageJson;
    return Array.isArray(parsed.workspaces);
  } catch {
    return false;
  }
}

function looksLikePackagedAppRoot(candidate: string): boolean {
  const packageJsonPath = join(candidate, "package.json");
  if (!existsSync(packageJsonPath)) {
    return false;
  }

  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as PackageJson;
    return parsed.name === "@openscout/scout" || parsed.name === "@openscout/cli";
  } catch {
    return false;
  }
}

function looksLikeInstalledCliRoot(candidate: string): boolean {
  const packageJsonPath = join(candidate, "package.json");
  if (!existsSync(packageJsonPath)) {
    return false;
  }

  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as PackageJson;
    return parsed.name === "@openscout/scout" || parsed.name === "@openscout/cli";
  } catch {
    return false;
  }
}

function looksLikeSourceAppRoot(candidate: string): boolean {
  return existsSync(join(candidate, "bin", "scout.ts"));
}

function findMatchingAncestor(
  startDirectory: string,
  predicate: (candidate: string) => boolean,
): string | null {
  let current = resolve(startDirectory);

  while (true) {
    if (predicate(current)) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function defaultModuleDirectory(): string {
  return dirname(fileURLToPath(import.meta.url));
}

function uniqueResolutionStarts(options: ScoutPathResolutionOptions): string[] {
  const starts = [
    options.currentDirectory?.trim(),
    options.env?.OPENSCOUT_SETUP_CWD?.trim(),
    process.cwd(),
    options.moduleDirectory?.trim(),
  ];
  const resolvedStarts = starts
    .filter((value): value is string => Boolean(value))
    .map((value) => resolve(value));
  return [...new Set(resolvedStarts)];
}

export function resolveScoutWorkspaceRoot(options: ScoutPathResolutionOptions = {}): string {
  const starts = uniqueResolutionStarts({
    ...options,
    moduleDirectory: options.moduleDirectory ?? defaultModuleDirectory(),
  });

  for (const start of starts) {
    const workspaceRoot = findMatchingAncestor(start, looksLikeWorkspaceRoot);
    if (workspaceRoot) {
      return workspaceRoot;
    }
  }

  throw new Error("Unable to locate the Scout workspace root.");
}

export function resolveScoutAppRoot(options: ScoutPathResolutionOptions = {}): string {
  const starts = uniqueResolutionStarts({
    ...options,
    moduleDirectory: options.moduleDirectory ?? defaultModuleDirectory(),
  });

  for (const start of starts) {
    const packagedRoot = findMatchingAncestor(start, looksLikePackagedAppRoot);
    if (packagedRoot) {
      return packagedRoot;
    }
  }

  const workspaceRoot = resolveScoutWorkspaceRoot(options);
  for (const relativePath of [["apps", "desktop"], ["apps", "scout"], ["packages", "cli"]] as const) {
    const candidate = resolve(workspaceRoot, ...relativePath);
    if (looksLikeSourceAppRoot(candidate)) {
      return candidate;
    }
  }

  throw new Error("Unable to locate the Scout app root.");
}
