import { existsSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  isScoutRuntimeHarnessEnabled,
  parseScoutRuntimeCatalog,
  SCOUT_RESERVED_RUNTIME_PROFILE_IDS,
  SCOUT_RUNTIME_CATALOG,
  scoutRuntimeDefaultHarness,
  scoutRuntimeDefaultModel,
  scoutRuntimeDefaultReasoningEffort,
  scoutRuntimeDefaultsByHarness,
  scoutRuntimeEffortCatalog,
  scoutRuntimeModelCatalog,
  type ScoutRuntimeCapabilityCatalog,
  type ScoutRuntimeHarnessPresentation,
  type ScoutRuntimeModelPresentation,
  type ScoutOwnedRuntimeCatalog,
} from "@openscout/protocol";
import { queryAgents } from "./db-queries.ts";
import { resolveScoutBrokerUrl } from "./core/broker/service.ts";
import { loadUserConfigFresh } from "@openscout/runtime/user-config";
import { readHarnessModelPreferences } from "@openscout/runtime/harness-model-preferences";
import { resolveRuntimeListPreferences } from "@openscout/runtime/runtime-list-preferences";
import { resolveBrokerRuntimeProfile, type BrokerRuntimeProfile } from "@openscout/runtime/broker-runtime-profiles";
import { readOpenScoutSettings, readProjectConfig } from "@openscout/runtime/setup";
import { expandHomePath } from "./local-paths.ts";

export type HudRunnerHarnessOption = {
  id: string;
  name: string | null;
  label: string;
  description: string | null;
  state: string | null;
  ready: boolean | null;
  detail: string | null;
  presentation?: ScoutRuntimeHarnessPresentation;
};

export type HudRunnerModelOption = {
  id: string;
  label: string;
  harnesses: string[];
  source: string;
  family?: string;
  version?: string;
  isDefault?: boolean;
  presentation?: ScoutRuntimeModelPresentation;
};

export type HudRunnerProjectOption = {
  id: string;
  title: string;
  root: string;
  source: string | null;
  registrationKind: string | null;
  defaultHarness: string | null;
};

export type HudRunnerAgentOption = {
  id: string;
  name: string;
  handle: string | null;
  status: string | null;
  harness: string | null;
  model: string | null;
  projectRoot: string | null;
  cwd: string | null;
  harnessSessionId: string | null;
};

export const HUD_PROJECT_MARKERS = [
  ".git",
  ".openscout/project.json",
  "AGENTS.md",
  "package.json",
  "Package.swift",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
] as const;

export async function loadBrokerRuntimeCatalog(): Promise<{
  catalog: ScoutOwnedRuntimeCatalog;
  warnings: string[];
} | null> {
  try {
    const response = await fetch(new URL("/v1/runtime-catalog", resolveScoutBrokerUrl()), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return null;
    const value = await response.json() as { catalog?: unknown; warnings?: unknown };
    const parsed = parseScoutRuntimeCatalog(value.catalog);
    if (!parsed.ok) return null;
    return {
      catalog: parsed.catalog,
      warnings: Array.isArray(value.warnings)
        ? value.warnings.filter((entry): entry is string => typeof entry === "string")
        : [],
    };
  } catch {
    return null;
  }
}

export function defaultHudRunnerModel(
  harness: string | null | undefined,
  models: HudRunnerModelOption[],
  catalog: ScoutOwnedRuntimeCatalog,
): string | null {
  const catalogDefault = scoutRuntimeDefaultModel(harness ?? "", catalog);
  if (catalogDefault && models.some((model) => (
    model.id === catalogDefault && model.harnesses.includes(harness ?? "")
  ))) return catalogDefault;
  return models.find((model) => model.harnesses.includes(harness ?? ""))?.id ?? null;
}

export function normalizeHudRunnerRoot(root: string): string {
  return resolve(expandHomePath(root.trim()));
}

export function isLikelyHudProjectRoot(root: string): boolean {
  const normalized = normalizeHudRunnerRoot(root);
  try {
    if (!statSync(normalized).isDirectory()) return false;
  } catch {
    return false;
  }
  return HUD_PROJECT_MARKERS.some((marker) => existsSync(join(normalized, marker)));
}

export function currentDirectoryProjectOption(
  currentDirectory: string,
  defaultHarness: string,
): HudRunnerProjectOption | null {
  const trimmed = currentDirectory.trim();
  if (!trimmed || !isLikelyHudProjectRoot(trimmed)) return null;
  const root = normalizeHudRunnerRoot(trimmed);
  return {
    id: `current:${root}`,
    title: basename(root) || root,
    root,
    source: "currentDirectory",
    registrationKind: "current",
    defaultHarness,
  };
}

export function dedupeHudRunnerProjects(projects: HudRunnerProjectOption[]): HudRunnerProjectOption[] {
  const seen = new Set<string>();
  const result: HudRunnerProjectOption[] = [];
  for (const project of projects) {
    const root = normalizeHudRunnerRoot(project.root);
    if (!seen.add(root)) continue;
    result.push({ ...project, root });
  }
  return result;
}

export async function buildHudRunnerOptions(
  currentDirectory: string,
  input: {
    scope?: ScoutRuntimeCapabilityCatalog["scope"];
    projectRoot?: string;
  } = {},
) {
  // This endpoint sits on the global-hotkey path, so it deliberately avoids
  // the workspace scan performed by the full agent-configuration snapshot.
  const scope = input.scope ?? "global+project";
  const scopedProjectRoot = normalizeHudRunnerRoot(input.projectRoot ?? currentDirectory);
  const [
    settingsResult,
    runtimeCatalogResult,
    userConfigResult,
    projectConfigResult,
    harnessPreferencesResult,
  ] = await Promise.allSettled([
    readOpenScoutSettings({ currentDirectory }),
    loadBrokerRuntimeCatalog(),
    Promise.resolve().then(() => loadUserConfigFresh()),
    readProjectConfig(scopedProjectRoot),
    readHarnessModelPreferences(),
  ]);
  const settings = settingsResult.status === "fulfilled" ? settingsResult.value : null;
  const liveRuntimeCatalog = runtimeCatalogResult.status === "fulfilled" ? runtimeCatalogResult.value : null;
  const runtimeCatalog = liveRuntimeCatalog?.catalog ?? SCOUT_RUNTIME_CATALOG;
  const allAgents = queryAgents(50);
  const projectAgents = allAgents.filter((agent) => {
    const root = agent.projectRoot ?? agent.cwd;
    return Boolean(root) && normalizeHudRunnerRoot(root!) === scopedProjectRoot;
  });
  const configuredDefaultHarness = settings?.agents.defaultHarness?.trim() ?? "";
  const defaultHarness = isScoutRuntimeHarnessEnabled(configuredDefaultHarness, runtimeCatalog)
    ? configuredDefaultHarness
    : scoutRuntimeDefaultHarness(runtimeCatalog) ?? "claude";

  const harnessesById = new Map<string, HudRunnerHarnessOption>();
  for (const entry of runtimeCatalog.harnesses) {
    // Hidden transports remain valid for exact launches and resume, but they
    // are not a second operator-facing choice in the HUD composer.
    if (!entry.enabled || entry.listed === false) continue;
    harnessesById.set(entry.id, {
      id: entry.id,
      name: entry.id,
      label: entry.label,
      description: null,
      // Full harness readiness executes local health checks and can take
      // several seconds across the installed fleet. New task only needs the
      // broker-owned launch catalog; launch remains the final authority.
      state: null,
      ready: null,
      detail: null,
      ...(entry.presentation ? { presentation: entry.presentation } : {}),
    });
  }

  const projectOptions: HudRunnerProjectOption[] = allAgents
    .map((agent) => agent.projectRoot ?? agent.cwd)
    .filter((root): root is string => typeof root === "string" && root.trim().length > 0)
    .map((root) => {
      const normalizedRoot = normalizeHudRunnerRoot(root);
      return {
        id: `agent:${normalizedRoot}`,
        title: basename(normalizedRoot) || normalizedRoot,
        root: normalizedRoot,
        source: "agent",
        registrationKind: null,
        defaultHarness,
      };
    });
  const currentProject = currentDirectoryProjectOption(currentDirectory, defaultHarness);
  if (currentProject) projectOptions.unshift(currentProject);
  const projects = dedupeHudRunnerProjects(projectOptions);
  const defaultDirectory = projects[0]?.root ?? normalizeHudRunnerRoot(currentDirectory);
  const models = scoutRuntimeModelCatalog(runtimeCatalog);
  const harnesses = Array.from(harnessesById.values());
  const defaultModel = defaultHudRunnerModel(defaultHarness, models, runtimeCatalog);

  const brokerProfiles = SCOUT_RESERVED_RUNTIME_PROFILE_IDS
    .map((id) => resolveBrokerRuntimeProfile(id))
    .filter((profile): profile is BrokerRuntimeProfile => Boolean(profile));
  const runtimeLists = resolveRuntimeListPreferences({
    catalog: runtimeCatalog,
    user: userConfigResult.status === "fulfilled" ? userConfigResult.value : undefined,
    project: projectConfigResult.status === "fulfilled"
      ? projectConfigResult.value?.agent?.runtime ?? null
      : null,
    harness: harnessPreferencesResult.status === "fulfilled"
      ? harnessPreferencesResult.value
      : undefined,
    brokerProfiles,
  });
  const warnings = [
    ...(liveRuntimeCatalog?.warnings ?? []),
    ...runtimeLists.warnings,
  ];

  return {
    schemaVersion: "openscout.runtime-capabilities.v1" as const,
    catalogVersion: runtimeCatalog.schemaVersion,
    catalogRevision: runtimeCatalog.revision,
    generatedAt: Date.now(),
    scope,
    ...(scope !== "global" ? { projectRoot: scopedProjectRoot } : {}),
    defaults: {
      runner: "scout",
      directory: defaultDirectory,
      harness: defaultHarness,
      model: defaultModel,
      reasoningEffort: scoutRuntimeDefaultReasoningEffort(
        defaultHarness,
        defaultModel,
        runtimeCatalog,
      ) ?? "",
      persistence: "sticky",
    },
    defaultsByHarness: scoutRuntimeDefaultsByHarness(runtimeCatalog),
    runners: [{
      id: "scout",
      label: "Scout",
      description: "Start a broker-owned Scout session",
      supports: harnesses.map((harness) => harness.id),
    }],
    harnesses,
    models,
    efforts: scoutRuntimeEffortCatalog(runtimeCatalog).map((effort) => ({
      ...effort,
      harnesses: [...effort.harnesses],
      ...(effort.models ? { models: [...effort.models] } : {}),
    })),
    projects,
    shortlist: runtimeLists.shortlist,
    presets: runtimeLists.presets,
    ...(warnings.length ? { warnings } : {}),
    agents: (scope === "global" ? allAgents : projectAgents).map((agent): HudRunnerAgentOption => ({
      id: agent.id,
      name: agent.name,
      handle: agent.handle,
      status: agent.state,
      harness: agent.harness,
      model: agent.model,
      projectRoot: agent.projectRoot ? normalizeHudRunnerRoot(agent.projectRoot) : null,
      cwd: agent.cwd ? normalizeHudRunnerRoot(agent.cwd) : null,
      harnessSessionId: agent.harnessSessionId,
    })),
  };
}
