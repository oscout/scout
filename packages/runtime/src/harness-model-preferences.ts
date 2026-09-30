/**
 * Harness model preferences — read-only observation of each harness's own
 * on-disk config, feeding the runtime picker's shortlist and presets.
 *
 * Every reader is best-effort: a missing or malformed file is an empty result,
 * never a throw and never log spam. These files belong to other tools; Scout
 * borrows their model choices, it does not interpret their semantics beyond
 * "this harness was configured with these models".
 *
 * Codex and Kimi are TOML (smol-toml), Claude and OpenCode are JSON:
 *
 *   codex    <codex home>/config.toml — model, model_reasoning_effort,
 *            [profiles.<name>].model / .model_reasoning_effort
 *   claude   ${CLAUDE_CONFIG_DIR ?? ~/.claude}/settings.json — model
 *            (may be an alias like "opus"; catalog matching happens later)
 *   opencode ${XDG_STATE_HOME ?? ~/.local/state}/opencode/model.json —
 *            favorite[] then recent[] entries of {providerID, modelID}. Each
 *            entry emits both `providerID/modelID` and bare `modelID`; the
 *            catalog keeps whichever form it knows (Scout ids are qualified,
 *            e.g. `opencode-go/glm-5.2`).
 *   kimi     ${KIMI_CODE_HOME ?? ~/.kimi-code}/config.toml — default_model,
 *            keys of [models.*]
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { operatorCodexHome } from "./local-agents.js";
import { resolveOpenScoutSupportPaths } from "./support-paths.js";

export interface HarnessPreferenceProfile {
  id: string;
  label: string;
  model?: string;
  effort?: string;
}

export interface HarnessModelPreferences {
  /** The harness's own configured default model (`model` / `default_model`). */
  defaultModel?: string;
  defaultEffort?: string;
  favorites: string[];
  recent: string[];
  profiles: HarnessPreferenceProfile[];
  /** File the preferences were read from, for diagnostics. */
  source?: string;
}

export type HarnessModelPreferenceMap = Record<string, HarnessModelPreferences>;

export interface HarnessModelPreferenceOptions {
  /** Environment view; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** `~` for resolution purposes; defaults to `env.HOME` then `os.homedir()`. */
  homeDir?: string;
  /** Read seam for tests — return null for a missing/unreadable file. */
  readFile?: HarnessPreferenceReader;
}

export type HarnessPreferenceReader = (path: string) => Promise<string | null>;

const defaultReadFile = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
};

function expandTilde(value: string, env: NodeJS.ProcessEnv, home: string): string {
  const base = env.HOME?.trim() || home;
  if (value === "~") return base;
  if (value.startsWith("~/")) return join(base, value.slice(2));
  return value;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function table(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * The operator's own Codex home — the one holding `config.toml` worth reading.
 * Mirrors `operatorCodexHome` when an env/home bag is supplied (tests), and
 * delegates to it outright otherwise so the managed-runtime exclusion stays
 * single-sourced.
 */
function codexConfigDirectory(
  env: NodeJS.ProcessEnv,
  home: string,
  bagProvided: boolean,
): string | null {
  if (!bagProvided) {
    try {
      return operatorCodexHome();
    } catch {
      return null;
    }
  }
  const explicit = env.OPENSCOUT_CODEX_HOME_SOURCE?.trim();
  if (explicit) return resolve(expandTilde(explicit, env, home));
  const incoming = env.CODEX_HOME?.trim();
  if (incoming) {
    const resolvedIncoming = resolve(expandTilde(incoming, env, home));
    const managedRuntime = resolve(resolveOpenScoutSupportPaths().runtimeDirectory);
    if (resolvedIncoming !== managedRuntime && !resolvedIncoming.startsWith(`${managedRuntime}/`)) {
      return resolvedIncoming;
    }
  }
  return join(resolve(home), ".codex");
}

function emptyPreferences(source: string): HarnessModelPreferences {
  return { favorites: [], recent: [], profiles: [], source };
}

async function readCodexPreferences(
  directory: string | null,
  read: HarnessPreferenceReader,
): Promise<HarnessModelPreferences | null> {
  if (!directory) return null;
  const source = join(directory, "config.toml");
  const content = await read(source);
  if (content == null) return null;
  try {
    const parsed = parseToml(content);
    const preferences = emptyPreferences(source);
    const defaultModel = text(parsed.model);
    if (defaultModel) preferences.defaultModel = defaultModel;
    const defaultEffort = text(parsed.model_reasoning_effort);
    if (defaultEffort) preferences.defaultEffort = defaultEffort;
    const profiles = table(parsed.profiles);
    if (profiles) {
      for (const [name, entry] of Object.entries(profiles)) {
        const profile = table(entry);
        if (!profile) continue;
        preferences.profiles.push({
          id: name,
          label: name,
          ...(text(profile.model) ? { model: text(profile.model) } : {}),
          ...(text(profile.model_reasoning_effort)
            ? { effort: text(profile.model_reasoning_effort) }
            : {}),
        });
      }
    }
    return preferences;
  } catch {
    return null;
  }
}

async function readClaudePreferences(
  directory: string,
  read: HarnessPreferenceReader,
): Promise<HarnessModelPreferences | null> {
  const source = join(directory, "settings.json");
  const content = await read(source);
  if (content == null) return null;
  try {
    const parsed = table(JSON.parse(content));
    if (!parsed) return null;
    const preferences = emptyPreferences(source);
    const model = text(parsed.model);
    if (model) preferences.defaultModel = model;
    return preferences;
  } catch {
    return null;
  }
}

/**
 * OpenCode state carries `{providerID, modelID}` pairs. Catalog ids are the
 * qualified `providerID/modelID` form (`opencode-go/glm-5.2`); the bare id is
 * emitted as a fallback candidate for catalogs that list unqualified models.
 */
function openCodeModelCandidates(entry: unknown): string[] {
  const record = table(entry);
  if (!record) return [];
  const modelID = text(record.modelID);
  if (!modelID) return [];
  const providerID = text(record.providerID);
  return providerID ? [`${providerID}/${modelID}`, modelID] : [modelID];
}

async function readOpenCodePreferences(
  stateDirectory: string,
  read: HarnessPreferenceReader,
): Promise<HarnessModelPreferences | null> {
  const source = join(stateDirectory, "opencode", "model.json");
  const content = await read(source);
  if (content == null) return null;
  try {
    const parsed = table(JSON.parse(content));
    if (!parsed) return null;
    const preferences = emptyPreferences(source);
    const entries = (key: "favorite" | "recent"): string[] =>
      (Array.isArray(parsed[key]) ? parsed[key] : [])
        .flatMap(openCodeModelCandidates);
    preferences.favorites = entries("favorite");
    preferences.recent = entries("recent");
    return preferences;
  } catch {
    return null;
  }
}

async function readKimiPreferences(
  directory: string,
  read: HarnessPreferenceReader,
): Promise<HarnessModelPreferences | null> {
  const source = join(directory, "config.toml");
  const content = await read(source);
  if (content == null) return null;
  try {
    const parsed = parseToml(content);
    const preferences = emptyPreferences(source);
    const defaultModel = text(parsed.default_model);
    if (defaultModel) preferences.defaultModel = defaultModel;
    // Configured [models.*] entries are the operator's chosen set — the
    // closest thing Kimi has to a favorite list.
    const models = table(parsed.models);
    if (models) preferences.favorites = Object.keys(models);
    return preferences;
  } catch {
    return null;
  }
}

export async function readHarnessModelPreferences(
  options: HarnessModelPreferenceOptions = {},
): Promise<HarnessModelPreferenceMap> {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? env.HOME?.trim() ?? homedir();
  const read = options.readFile ?? defaultReadFile;
  const bagProvided = Boolean(options.env || options.homeDir);

  const codexDirectory = codexConfigDirectory(env, home, bagProvided);
  const claudeDirectory = env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude");
  const openCodeStateDirectory = env.XDG_STATE_HOME?.trim() || join(home, ".local", "state");
  const kimiDirectory = env.KIMI_CODE_HOME?.trim() || join(home, ".kimi-code");

  const [codex, claude, opencode, kimi] = await Promise.all([
    readCodexPreferences(codexDirectory, read),
    readClaudePreferences(claudeDirectory, read),
    readOpenCodePreferences(openCodeStateDirectory, read),
    readKimiPreferences(kimiDirectory, read),
  ]);

  const map: HarnessModelPreferenceMap = {};
  if (codex) map.codex = codex;
  if (claude) map.claude = claude;
  if (opencode) map.opencode = opencode;
  if (kimi) map.kimi = kimi;
  return map;
}
