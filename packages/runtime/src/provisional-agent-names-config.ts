import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import {
  PROVISIONAL_AGENT_NAMES,
  normalizeProvisionalAgentNameCandidates,
  parseProvisionalAgentNamesJson,
} from "@openscout/protocol";

import {
  loadUserConfig,
  type OpenScoutUserConfig,
  type ProvisionalAgentNamesMode,
} from "./user-config.js";

export type ProvisionalAgentNamePoolSource =
  | "default"
  | "user-settings-replace"
  | "user-settings-extend"
  | "env-file"
  | "user-config-file"
  | "home-json";

export type ResolvedProvisionalAgentNamePool = {
  names: readonly string[];
  source: ProvisionalAgentNamePoolSource;
  sourcePath?: string;
  mode?: ProvisionalAgentNamesMode;
};

export function openScoutHome(): string {
  return process.env.OPENSCOUT_HOME ?? join(homedir(), ".openscout");
}

/** Default drop-in location for a custom name pool JSON file. */
export function defaultProvisionalAgentNamesPath(): string {
  return join(openScoutHome(), "provisional-agent-names.json");
}

export function resolveProvisionalAgentNamesMode(
  config: OpenScoutUserConfig,
): ProvisionalAgentNamesMode {
  return config.provisionalAgentNamesMode === "extend" ? "extend" : "replace";
}

export function normalizeProvisionalAgentNamesSetting(
  names: Iterable<string> | undefined,
): string[] {
  if (!names) return [];
  return normalizeProvisionalAgentNameCandidates(names);
}

export function mergeProvisionalAgentNamePool(
  customNames: readonly string[],
  mode: ProvisionalAgentNamesMode,
): string[] {
  if (mode === "replace") {
    return [...customNames];
  }

  const seen = new Set(customNames);
  const merged = [...customNames];
  for (const name of PROVISIONAL_AGENT_NAMES) {
    if (!seen.has(name)) {
      seen.add(name);
      merged.push(name);
    }
  }
  return merged;
}

function resolvePoolFilePath(filePath: string): string {
  const trimmed = filePath.trim();
  return isAbsolute(trimmed) ? trimmed : resolve(openScoutHome(), trimmed);
}

function readProvisionalAgentNamesJsonFile(filePath: string): string[] {
  return parseProvisionalAgentNamesJson(readFileSync(filePath, "utf8"));
}

function loadInlineProvisionalAgentNames(
  config: OpenScoutUserConfig,
): {
  names: string[];
  source: ProvisionalAgentNamePoolSource;
  mode: ProvisionalAgentNamesMode;
} | null {
  const customNames = normalizeProvisionalAgentNamesSetting(config.provisionalAgentNames);
  if (customNames.length === 0) {
    return null;
  }

  const mode = resolveProvisionalAgentNamesMode(config);
  return {
    names: mergeProvisionalAgentNamePool(customNames, mode),
    source: mode === "extend" ? "user-settings-extend" : "user-settings-replace",
    mode,
  };
}

function loadFileProvisionalAgentNames(
  config: OpenScoutUserConfig = loadUserConfig(),
): {
  names: string[];
  source: ProvisionalAgentNamePoolSource;
  sourcePath: string;
} | null {
  const envFile = process.env.OPENSCOUT_PROVISIONAL_AGENT_NAMES_FILE?.trim();
  if (envFile && existsSync(envFile)) {
    const names = readProvisionalAgentNamesJsonFile(envFile);
    if (names.length > 0) {
      return { names, source: "env-file", sourcePath: envFile };
    }
  }

  if (config.provisionalAgentNamesFile?.trim()) {
    const filePath = resolvePoolFilePath(config.provisionalAgentNamesFile);
    if (existsSync(filePath)) {
      const names = readProvisionalAgentNamesJsonFile(filePath);
      if (names.length > 0) {
        return { names, source: "user-config-file", sourcePath: filePath };
      }
    }
  }

  const homeJson = defaultProvisionalAgentNamesPath();
  if (existsSync(homeJson)) {
    const names = readProvisionalAgentNamesJsonFile(homeJson);
    if (names.length > 0) {
      return { names, source: "home-json", sourcePath: homeJson };
    }
  }

  return null;
}

export function resolveProvisionalAgentNamePool(
  config: OpenScoutUserConfig = loadUserConfig(),
): ResolvedProvisionalAgentNamePool {
  const inline = loadInlineProvisionalAgentNames(config);
  if (inline) {
    return {
      names: inline.names,
      source: inline.source,
      mode: inline.mode,
    };
  }

  const filePool = loadFileProvisionalAgentNames(config);
  if (filePool) {
    return {
      names: filePool.names,
      source: filePool.source,
      sourcePath: filePool.sourcePath,
    };
  }

  return {
    names: PROVISIONAL_AGENT_NAMES,
    source: "default",
  };
}

export function loadProvisionalAgentNamePool(
  config: OpenScoutUserConfig = loadUserConfig(),
): readonly string[] {
  return resolveProvisionalAgentNamePool(config).names;
}

export function describeProvisionalAgentNamePool(
  config: OpenScoutUserConfig = loadUserConfig(),
): string {
  const resolved = resolveProvisionalAgentNamePool(config);
  const preview = resolved.names.slice(0, 6).join(", ");
  const suffix = resolved.names.length > 6 ? ", …" : "";
  const pathLabel = resolved.sourcePath ? ` (${resolved.sourcePath})` : "";
  const modeLabel = resolved.mode ? `, ${resolved.mode}` : "";
  return `${resolved.names.length} names from ${resolved.source}${modeLabel}${pathLabel}${preview ? ` — ${preview}${suffix}` : ""}`;
}

/** Seed inline Scout settings with a starter or full built-in pool. */
export function seedProvisionalAgentNamesInUserConfig(input: {
  config?: OpenScoutUserConfig;
  empty?: boolean;
  mode?: ProvisionalAgentNamesMode;
} = {}): OpenScoutUserConfig {
  const config = { ...(input.config ?? loadUserConfig()) };
  config.provisionalAgentNames = input.empty
    ? ["ada", "grace", "linus"]
    : [...PROVISIONAL_AGENT_NAMES];
  config.provisionalAgentNamesMode = input.mode ?? "replace";
  return config;
}

/** Write a bring-your-own JSON pool file. `init` seeds the built-in list; `--empty` writes a tiny starter. */
export function writeProvisionalAgentNamesFile(input: {
  path?: string;
  empty?: boolean;
  names?: readonly string[];
} = {}): string {
  const targetPath = input.path?.trim() || defaultProvisionalAgentNamesPath();
  mkdirSync(openScoutHome(), { recursive: true });
  const names = input.empty
    ? ["ada", "grace", "linus"]
    : [...(input.names ?? PROVISIONAL_AGENT_NAMES)];
  const payload = {
    names,
    ...(input.empty
      ? {
        readme:
          "Bring your own provisional agent name pool. Edit names[], save, and Scout rotates through it for ephemeral agents.",
      }
      : {}),
  };
  writeFileSync(targetPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return targetPath;
}

export function formatProvisionalAgentNamePoolSource(
  resolved: ResolvedProvisionalAgentNamePool,
): string {
  switch (resolved.source) {
    case "default":
      return "built-in Scout pool";
    case "user-settings-replace":
      return "Scout settings (replace)";
    case "user-settings-extend":
      return "Scout settings (extend with Scout defaults)";
    case "env-file":
      return resolved.sourcePath ?? "OPENSCOUT_PROVISIONAL_AGENT_NAMES_FILE";
    case "user-config-file":
      return resolved.sourcePath ?? "provisionalAgentNamesFile";
    case "home-json":
      return resolved.sourcePath ?? defaultProvisionalAgentNamesPath();
    default:
      return resolved.source;
  }
}

export function applyProvisionalAgentNamesFromBody(
  config: OpenScoutUserConfig,
  body: Record<string, unknown>,
): void {
  if ("provisionalAgentNames" in body) {
    const raw = body.provisionalAgentNames;
    if (Array.isArray(raw)) {
      const names = normalizeProvisionalAgentNamesSetting(
        raw.filter((entry): entry is string => typeof entry === "string"),
      );
      if (names.length > 0) {
        config.provisionalAgentNames = names;
      } else {
        delete config.provisionalAgentNames;
      }
    } else if (typeof raw === "string") {
      const names = normalizeProvisionalAgentNameCandidates(raw.split(/\r?\n/u));
      if (names.length > 0) {
        config.provisionalAgentNames = names;
      } else {
        delete config.provisionalAgentNames;
      }
    } else if (raw === null) {
      delete config.provisionalAgentNames;
    }
  }

  if ("provisionalAgentNamesMode" in body) {
    const mode = body.provisionalAgentNamesMode;
    if (mode === "extend" || mode === "replace") {
      config.provisionalAgentNamesMode = mode;
    } else {
      delete config.provisionalAgentNamesMode;
    }
  }
}

export function provisionalAgentNamesApiFields(
  config: OpenScoutUserConfig = loadUserConfig(),
): {
  provisionalAgentNames: string[];
  provisionalAgentNamesMode: ProvisionalAgentNamesMode;
  provisionalAgentNamesResolvedCount: number;
  provisionalAgentNamesPreview: string[];
  provisionalAgentNamesSource: ProvisionalAgentNamePoolSource;
} {
  const resolved = resolveProvisionalAgentNamePool(config);
  return {
    provisionalAgentNames: normalizeProvisionalAgentNamesSetting(config.provisionalAgentNames),
    provisionalAgentNamesMode: resolveProvisionalAgentNamesMode(config),
    provisionalAgentNamesResolvedCount: resolved.names.length,
    provisionalAgentNamesPreview: resolved.names.slice(0, 8),
    provisionalAgentNamesSource: resolved.source,
  };
}