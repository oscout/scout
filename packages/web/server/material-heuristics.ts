import { existsSync, mkdirSync, readFileSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createRequire } from "node:module";

import type { WorkMaterialKind } from "./work-materials.ts";

const require = createRequire(import.meta.url);
const picomatch = require("picomatch") as (
  pattern: string | string[],
  options?: { dot?: boolean; nocase?: boolean },
) => (input: string) => boolean;

export type HeuristicsConfig = {
  classify?: {
    exclude?: string[];
    planning?: { include?: string[]; exclude?: string[] };
    spec?: { include?: string[]; exclude?: string[] };
    doc?: { include?: string[]; exclude?: string[] };
  };
};

export type ParsedHeuristicsFile = {
  path: string;
  raw: string;
  config: HeuristicsConfig;
};

export type HeuristicsParseError = {
  error: string;
  lineNumber?: number;
};

export type HeuristicsFileResult = ParsedHeuristicsFile | (HeuristicsParseError & { path: string; raw: string });

type ResolvedBucketRules = {
  include: string[];
  exclude: string[];
};

type ResolvedHeuristics = {
  classify: {
    exclude: string[];
    planning: ResolvedBucketRules;
    spec: ResolvedBucketRules;
    doc: ResolvedBucketRules;
  };
};

export const DEFAULT_MATERIAL_CLASSIFIER: HeuristicsConfig = {
  classify: {
    exclude: [
      "node_modules/**",
      "dist/**",
      "build/**",
      ".git/**",
      "vendor/**",
      ".next/**",
      ".cache/**",
    ],
    planning: {
      include: ["**/plans/**", "**/planning/**", "*.plan.md"],
    },
    spec: {
      include: [
        "**/specs/**",
        "**/rfcs/**",
        "**/proposals/**",
        "*.spec.md",
        "*.rfc.md",
        "*.proposal.md",
      ],
    },
    doc: {
      include: [
        "README*",
        "CHANGELOG*",
        "AGENTS.md",
        "LICENSE*",
        "**/docs/**/*.md",
        "**/docs/**/*.mdx",
      ],
    },
  },
};

let globalCachePath: string | null = null;
let globalCache: HeuristicsConfig | null = null;
let globalWatcher: FSWatcher | null = null;

function globalHeuristicsPath(): string {
  return join(process.env.HOME ?? homedir(), ".openscout", "heuristics.json");
}

function normalizePathForGlob(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function emptyResolvedRules(): ResolvedBucketRules {
  return { include: [], exclude: [] };
}

function mergeRules(base: ResolvedBucketRules, next?: { include?: string[]; exclude?: string[] }): ResolvedBucketRules {
  return {
    include: [...base.include, ...(next?.include ?? [])],
    exclude: [...base.exclude, ...(next?.exclude ?? [])],
  };
}

function mergeResolved(base: ResolvedHeuristics, next: HeuristicsConfig): ResolvedHeuristics {
  const classify = next.classify;
  if (!classify) {
    return base;
  }
  return {
    classify: {
      exclude: [...base.classify.exclude, ...(classify.exclude ?? [])],
      planning: mergeRules(base.classify.planning, classify.planning),
      spec: mergeRules(base.classify.spec, classify.spec),
      doc: mergeRules(base.classify.doc, classify.doc),
    },
  };
}

function resolveConfig(layers: HeuristicsConfig[]): ResolvedHeuristics {
  let resolved: ResolvedHeuristics = {
    classify: {
      exclude: [],
      planning: emptyResolvedRules(),
      spec: emptyResolvedRules(),
      doc: emptyResolvedRules(),
    },
  };
  for (const layer of layers) {
    resolved = mergeResolved(resolved, layer);
  }
  return resolved;
}

function validatePatternArray(value: unknown, path: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${path} must be an array of strings`);
  }
  return value;
}

function validateBucket(value: unknown, path: string): { include?: string[]; exclude?: string[] } | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  const record = value as Record<string, unknown>;
  return {
    include: validatePatternArray(record.include, `${path}.include`),
    exclude: validatePatternArray(record.exclude, `${path}.exclude`),
  };
}

export function validateHeuristicsConfig(value: unknown): HeuristicsConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("heuristics config must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.classify === undefined) {
    return {};
  }
  if (!record.classify || typeof record.classify !== "object" || Array.isArray(record.classify)) {
    throw new Error("classify must be an object");
  }
  const classify = record.classify as Record<string, unknown>;
  return {
    classify: {
      exclude: validatePatternArray(classify.exclude, "classify.exclude"),
      planning: validateBucket(classify.planning, "classify.planning"),
      spec: validateBucket(classify.spec, "classify.spec"),
      doc: validateBucket(classify.doc, "classify.doc"),
    },
  };
}

function lineNumberForJsonError(raw: string, error: unknown): number | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const position = /position (\d+)/u.exec(message)?.[1];
  if (!position) {
    return raw.split(/\r?\n/u).length;
  }
  const index = Number.parseInt(position, 10);
  if (!Number.isFinite(index)) {
    return undefined;
  }
  return raw.slice(0, index).split(/\r?\n/u).length;
}

export function parseHeuristicsConfig(raw: string): HeuristicsConfig {
  return validateHeuristicsConfig(JSON.parse(raw));
}

function parseHeuristicsFile(path: string, raw: string): ParsedHeuristicsFile | (HeuristicsParseError & { path: string; raw: string }) {
  try {
    return { path, raw, config: parseHeuristicsConfig(raw) };
  } catch (error) {
    return {
      path,
      raw,
      error: error instanceof SyntaxError ? "invalid JSON" : error instanceof Error ? error.message : String(error),
      lineNumber: error instanceof SyntaxError ? lineNumberForJsonError(raw, error) : undefined,
    };
  }
}

function readConfigIfValid(path: string): HeuristicsConfig | null {
  if (!existsSync(path)) {
    return null;
  }
  const result = parseHeuristicsFile(path, readFileSync(path, "utf8"));
  return "config" in result ? result.config : null;
}

function loadGlobalConfigFromDisk(): HeuristicsConfig | null {
  const path = globalHeuristicsPath();
  globalCachePath = path;
  globalCache = readConfigIfValid(path);
  return globalCache;
}

function invalidateGlobalConfig(): void {
  globalCache = null;
  loadGlobalConfigFromDisk();
}

export function startGlobalHeuristicsWatcher(): void {
  const path = globalHeuristicsPath();
  if (globalWatcher && globalCachePath === path) {
    return;
  }
  globalWatcher?.close();
  globalWatcher = null;
  loadGlobalConfigFromDisk();
  const directory = dirname(path);
  try {
    mkdirSync(directory, { recursive: true });
    globalWatcher = watch(directory, (eventType, fileName) => {
      if (eventType === "rename" || eventType === "change") {
        if (!fileName || fileName.toString() === "heuristics.json") {
          invalidateGlobalConfig();
        }
      }
    });
    globalWatcher.unref?.();
  } catch {
    // The API can still read/write on demand even if fs.watch is unavailable.
  }
}

export function readGlobalHeuristicsConfig(): HeuristicsConfig | null {
  const path = globalHeuristicsPath();
  if (globalCachePath !== path) {
    loadGlobalConfigFromDisk();
  }
  return globalCache;
}

export function readHeuristicsFile(path: string): HeuristicsFileResult {
  if (!existsSync(path)) {
    return { path, raw: "", config: {} };
  }
  return parseHeuristicsFile(path, readFileSync(path, "utf8"));
}

export function writeHeuristicsFile(path: string, raw: string): HeuristicsFileResult {
  const parsed = parseHeuristicsFile(path, raw);
  if (!("config" in parsed)) {
    return parsed;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, raw, "utf8");
  if (path === globalHeuristicsPath()) {
    globalCachePath = path;
    globalCache = parsed.config;
  }
  return parsed;
}

export function globalHeuristicsFile(): HeuristicsFileResult {
  return readHeuristicsFile(globalHeuristicsPath());
}

export function writeGlobalHeuristicsFile(raw: string): HeuristicsFileResult {
  return writeHeuristicsFile(globalHeuristicsPath(), raw);
}

export function projectHeuristicsPath(workspaceRoot: string): string {
  const expanded = workspaceRoot.startsWith("~/")
    ? join(process.env.HOME ?? homedir(), workspaceRoot.slice(2))
    : workspaceRoot;
  const root = isAbsolute(expanded) ? resolve(expanded) : resolve(expanded);
  return join(root, ".openscout", "heuristics.json");
}

export function projectHeuristicsFile(workspaceRoot: string): HeuristicsFileResult {
  return readHeuristicsFile(projectHeuristicsPath(workspaceRoot));
}

export function writeProjectHeuristicsFile(workspaceRoot: string, raw: string): HeuristicsFileResult {
  const configPath = projectHeuristicsPath(workspaceRoot);
  const root = dirname(dirname(configPath));
  try {
    if (!statSync(root).isDirectory()) {
      return { path: configPath, raw, error: "workspaceRoot is not a directory" };
    }
  } catch {
    return { path: configPath, raw, error: "workspaceRoot does not exist" };
  }
  return writeHeuristicsFile(configPath, raw);
}

function patternMatches(pattern: string, path: string): boolean {
  const normalizedPath = normalizePathForGlob(path);
  const normalizedPattern = normalizePathForGlob(pattern);
  const matches = picomatch(normalizedPattern, { dot: true, nocase: true });
  if (matches(normalizedPath)) {
    return true;
  }
  if (!normalizedPattern.includes("/") && matches(basename(normalizedPath))) {
    return true;
  }
  if (normalizedPattern.startsWith("**/") && picomatch(normalizedPattern.slice(3), { dot: true, nocase: true })(normalizedPath)) {
    return true;
  }
  if (!normalizedPattern.startsWith("/") && picomatch(`**/${normalizedPattern}`, { dot: true, nocase: true })(normalizedPath)) {
    return true;
  }
  return false;
}

function anyPatternMatches(patterns: string[], path: string): boolean {
  return patterns.some((pattern) => patternMatches(pattern, path));
}

export type MaterialClassifier = {
  config: ResolvedHeuristics;
  projectRoot: string | null;
};

export function resolveMaterialClassifier(projectRoot: string | null): MaterialClassifier {
  const globalConfig = readGlobalHeuristicsConfig();
  const projectConfig = projectRoot ? readConfigIfValid(projectHeuristicsPath(projectRoot)) : null;
  return {
    config: resolveConfig([
      DEFAULT_MATERIAL_CLASSIFIER,
      ...(globalConfig ? [globalConfig] : []),
      ...(projectConfig ? [projectConfig] : []),
    ]),
    projectRoot,
  };
}

export function materialExcludePatterns(classifier: MaterialClassifier): string[] {
  return classifier.config.classify.exclude;
}

export function isMaterialExcluded(path: string, classifier: MaterialClassifier): boolean {
  return anyPatternMatches(classifier.config.classify.exclude, path);
}

function matchesBucket(path: string, rules: ResolvedBucketRules): boolean {
  if (anyPatternMatches(rules.exclude, path)) {
    return false;
  }
  return anyPatternMatches(rules.include, path);
}

export function classifyMaterialPath(path: string, classifier: MaterialClassifier): WorkMaterialKind | null {
  const normalizedPath = normalizePathForGlob(path);
  const fileName = basename(normalizedPath).toLowerCase();
  if (isMaterialExcluded(normalizedPath, classifier)) {
    return null;
  }
  if (matchesBucket(normalizedPath, classifier.config.classify.planning)) {
    return "plan";
  }
  if (matchesBucket(normalizedPath, classifier.config.classify.spec)) {
    return "spec";
  }
  if (matchesBucket(normalizedPath, classifier.config.classify.doc)) {
    return "doc";
  }
  if (
    normalizedPath.includes("/test/")
    || normalizedPath.includes("/tests/")
    || normalizedPath.includes("__tests__")
    || /\b(test|spec)\.[jt]sx?$/u.test(fileName)
    || fileName.endsWith(".test.ts")
    || fileName.endsWith(".test.tsx")
  ) {
    return "test";
  }
  if (
    fileName === "package.json"
    || fileName.endsWith(".config.ts")
    || fileName.endsWith(".config.js")
    || fileName.endsWith(".config.mjs")
    || fileName.endsWith(".json")
    || fileName.endsWith(".jsonc")
    || fileName.endsWith(".yaml")
    || fileName.endsWith(".yml")
    || fileName.endsWith(".toml")
    || fileName.endsWith(".lock")
  ) {
    return "config";
  }
  if (/\.(ts|tsx|js|jsx|mjs|cjs|py|swift|kt|java|go|rs|css|scss|html|sql|sh)$/u.test(fileName)) {
    return "code";
  }
  if (/\.(png|jpg|jpeg|gif|svg|webp|avif)$/u.test(fileName)) {
    return "asset";
  }
  return "other";
}

export function defaultHeuristicsResponse(): { path: null; raw: string; config: HeuristicsConfig } {
  return {
    path: null,
    raw: `${JSON.stringify(DEFAULT_MATERIAL_CLASSIFIER, null, 2)}\n`,
    config: DEFAULT_MATERIAL_CLASSIFIER,
  };
}
