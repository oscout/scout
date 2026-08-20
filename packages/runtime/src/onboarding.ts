import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { AgentHarness } from "@openscout/protocol";

import {
  brokerServiceStatus,
  startBrokerService,
  type BrokerServiceStatus,
} from "./broker-process-manager.js";
import {
  DEFAULT_LOCAL_CONFIG,
  loadLocalConfig,
  localConfigExists,
  localConfigPath,
  writeLocalConfig,
  type LocalConfig,
} from "./local-config.js";
import {
  loadHarnessCatalogSnapshot,
  type HarnessCatalogSnapshot,
} from "./harness-catalog.js";
import {
  DEFAULT_OPERATOR_NAME,
  installClaudeStatuslineTool,
  initializeOpenScoutSetup,
  installScoutSkillToHarnesses,
  readOpenScoutSettings,
  type ClaudeStatuslineInstallReport,
  type RelayRuntimeTransport,
  writeOpenScoutSettings,
  type SetupResult,
  type ScoutSkillInstallReport,
} from "./setup.js";
import {
  loadUserConfig,
  resolveOperatorName,
  saveUserConfig,
} from "./user-config.js";

export type OpenScoutOnboardingStepId =
  | "local-config"
  | "identity"
  | "project"
  | "setup"
  | "doctor"
  | "runtimes";

export type OpenScoutOnboardingStep = {
  id: OpenScoutOnboardingStepId;
  title: string;
  detail: string;
  complete: boolean;
};

export type OpenScoutOnboardingState = {
  currentDirectory: string;
  contextRoot: string | null;
  sourceRoots: string[];
  defaultHarness: AgentHarness;
  hasLocalConfig: boolean;
  localConfigPath: string;
  localConfig: LocalConfig | null;
  hasOperatorName: boolean;
  operatorName: string | null;
  operatorNameSuggestion: string;
  operatorNameSource: "user-config" | "env" | "settings" | "default";
  hasProjectConfig: boolean;
  projectRoot: string | null;
  projectConfigPath: string | null;
  brokerReachable: boolean;
  hasReadyRuntime: boolean;
  readyRuntimeCount: number;
  skippedAt: number | null;
  completedAt: number | null;
  needed: boolean;
  steps: OpenScoutOnboardingStep[];
};

export type OpenScoutOnboardingSetupResult = {
  setup: SetupResult;
  broker: BrokerServiceStatus;
  brokerWarning: string | null;
  catalog: HarnessCatalogSnapshot;
  scoutSkill: ScoutSkillInstallReport;
  claudeStatusline: ClaudeStatuslineInstallReport;
  state: OpenScoutOnboardingState;
};

export type OpenScoutOnboardingCommandName = "setup" | "doctor" | "runtimes";

function nowMs(): number {
  return Date.now();
}

function expandHomePath(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

function normalizePath(value: string): string {
  return resolve(expandHomePath(value.trim() || "."));
}

function projectConfigPath(projectRoot: string): string {
  return join(projectRoot, ".openscout", "project.json");
}

function normalizeDefaultHarness(value: string | undefined | null): AgentHarness {
  return value === "codex"
    ? "codex"
    : value === "cursor"
      ? "cursor"
      : value === "opencode"
        ? "opencode"
        : value === "pi"
          ? "pi"
          : "claude";
}

function defaultTransportForHarness(harness: AgentHarness): RelayRuntimeTransport {
  if (harness === "codex") return "codex_app_server";
  if (harness === "cursor") return "cursor_acp";
  if (harness === "opencode") return "opencode_acp";
  if (harness === "pi") return "pi_rpc";
  return "tmux";
}

async function nearestProjectConfig(startDirectory: string | null | undefined): Promise<{
  projectRoot: string;
  projectConfigPath: string;
} | null> {
  const trimmed = startDirectory?.trim();
  if (!trimmed) return null;

  let current = normalizePath(trimmed);
  while (true) {
    const candidate = projectConfigPath(current);
    if (existsSync(candidate)) {
      return {
        projectRoot: current,
        projectConfigPath: candidate,
      };
    }

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return null;
}

async function resolveProjectConfig(input: {
  currentDirectory: string;
  contextRoot: string | null;
}): Promise<{ projectRoot: string; projectConfigPath: string } | null> {
  const direct = await nearestProjectConfig(input.currentDirectory);
  if (direct) return direct;

  const configured = await nearestProjectConfig(input.contextRoot);
  if (configured) return configured;

  return null;
}

function operatorNameFromSettings(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed || trimmed === DEFAULT_OPERATOR_NAME) return null;
  return trimmed;
}

function buildSteps(input: {
  hasLocalConfig: boolean;
  hasOperatorName: boolean;
  operatorName: string | null;
  sourceRoots: string[];
  defaultHarness: AgentHarness;
  hasProjectConfig: boolean;
  projectConfigPath: string | null;
  setupRan: boolean;
  doctorRan: boolean;
  brokerReachable: boolean;
  hasReadyRuntime: boolean;
  readyRuntimeCount: number;
}): OpenScoutOnboardingStep[] {
  return [
    {
      id: "local-config",
      title: "Create local config",
      detail: input.hasLocalConfig
        ? `Local config exists at ${localConfigPath()}.`
        : "Create ~/.openscout/config.json with broker, web, and pairing defaults.",
      complete: input.hasLocalConfig,
    },
    {
      id: "identity",
      title: "Set operator identity",
      detail: input.hasOperatorName
        ? `Scout will call you ${input.operatorName ?? "operator"}.`
        : "Tell Scout what to call you across CLI, web, desktop, and prompts.",
      complete: input.hasOperatorName,
    },
    {
      id: "project",
      title: "Choose project context",
      detail: input.hasProjectConfig
        ? `Project config exists at ${input.projectConfigPath}.`
        : "Choose scan folders and create a local .openscout/project.json for this context.",
      complete: input.hasProjectConfig,
    },
    {
      id: "setup",
      title: "Run setup",
      detail: input.brokerReachable
        ? "Broker service is reachable."
        : "Run setup to install skills, create project config, and start the broker service.",
      complete: input.setupRan && input.brokerReachable,
    },
    {
      id: "doctor",
      title: "Run doctor",
      detail: input.doctorRan
        ? "Doctor has been run for this onboarding pass."
        : "Run doctor to verify broker health, project discovery, and local support files.",
      complete: input.doctorRan,
    },
    {
      id: "runtimes",
      title: "Verify runtimes",
      detail: input.hasReadyRuntime
        ? `${input.readyRuntimeCount} runtime${input.readyRuntimeCount === 1 ? "" : "s"} ready.`
        : "Install or sign into a supported harness such as Claude Code or Codex.",
      complete: input.hasReadyRuntime,
    },
  ];
}

export async function loadOpenScoutOnboardingState(options: {
  currentDirectory?: string;
  broker?: BrokerServiceStatus | null;
  catalog?: HarnessCatalogSnapshot | null;
} = {}): Promise<OpenScoutOnboardingState> {
  const currentDirectory = normalizePath(options.currentDirectory ?? process.cwd());
  const settings = await readOpenScoutSettings({ currentDirectory });
  const userConfig = loadUserConfig();
  const explicitUserName = userConfig.name?.trim() ?? "";
  const envOperatorName = process.env.OPENSCOUT_OPERATOR_NAME?.trim() ?? "";
  const answeredSettingsOperatorName = settings.onboarding.operatorAnsweredAt
    ? settings.profile.operatorName?.trim() ?? ""
    : "";
  const settingsOperatorName = operatorNameFromSettings(settings.profile.operatorName);
  const operatorName = explicitUserName || envOperatorName || settingsOperatorName || answeredSettingsOperatorName;
  const operatorNameSource = explicitUserName
    ? "user-config"
    : envOperatorName
      ? "env"
      : settingsOperatorName || answeredSettingsOperatorName
        ? "settings"
        : "default";

  const contextRoot = settings.discovery.contextRoot ?? null;
  const project = await resolveProjectConfig({ currentDirectory, contextRoot });
  const [broker, catalog] = await Promise.all([
    options.broker ?? brokerServiceStatus().catch(() => null),
    options.catalog ?? loadHarnessCatalogSnapshot().catch(() => null),
  ]);
  const readyRuntimeCount = catalog?.entries.filter((entry) => entry.readinessReport.ready).length ?? 0;
  const hasReadyRuntime = readyRuntimeCount > 0;
  const hasLocalConfig = localConfigExists();
  const hasOperatorName = Boolean(operatorName || settings.onboarding.operatorAnsweredAt);
  const hasProjectConfig = Boolean(project);
  const brokerReachable = Boolean(broker?.reachable);
  const coreComplete = hasLocalConfig
    && hasOperatorName
    && hasProjectConfig
    && brokerReachable
    && hasReadyRuntime;

  const steps = buildSteps({
    hasLocalConfig,
    hasOperatorName,
    operatorName: operatorName || null,
    sourceRoots: settings.discovery.workspaceRoots,
    defaultHarness: settings.agents.defaultHarness,
    hasProjectConfig,
    projectConfigPath: project?.projectConfigPath ?? null,
    setupRan: Boolean(settings.onboarding.initRanAt),
    doctorRan: Boolean(settings.onboarding.doctorRanAt),
    brokerReachable,
    hasReadyRuntime,
    readyRuntimeCount,
  });

  return {
    currentDirectory,
    contextRoot,
    sourceRoots: [...settings.discovery.workspaceRoots],
    defaultHarness: settings.agents.defaultHarness,
    hasLocalConfig,
    localConfigPath: localConfigPath(),
    localConfig: hasLocalConfig ? loadLocalConfig() : null,
    hasOperatorName,
    operatorName: operatorName || null,
    operatorNameSuggestion: resolveOperatorName(),
    operatorNameSource,
    hasProjectConfig,
    projectRoot: project?.projectRoot ?? null,
    projectConfigPath: project?.projectConfigPath ?? null,
    brokerReachable,
    hasReadyRuntime,
    readyRuntimeCount,
    skippedAt: settings.onboarding.skippedAt,
    completedAt: settings.onboarding.completedAt,
    needed: !(settings.onboarding.skippedAt || settings.onboarding.completedAt || coreComplete),
    steps,
  };
}

export async function ensureOpenScoutOnboardingLocalConfig(options: {
  currentDirectory?: string;
  host?: string;
  ports?: { broker?: number; web?: number; pairing?: number };
  broker?: BrokerServiceStatus | null;
  catalog?: HarnessCatalogSnapshot | null;
  now?: number;
} = {}): Promise<OpenScoutOnboardingState> {
  const shouldWrite = !localConfigExists() || Boolean(options.host || options.ports);
  if (shouldWrite) {
    const current = loadLocalConfig();
    writeLocalConfig({
      version: 1,
      host: options.host ?? current.host ?? DEFAULT_LOCAL_CONFIG.host,
      ports: {
        broker: options.ports?.broker ?? current.ports?.broker ?? DEFAULT_LOCAL_CONFIG.ports.broker,
        web: options.ports?.web ?? current.ports?.web ?? DEFAULT_LOCAL_CONFIG.ports.web,
        pairing: options.ports?.pairing ?? current.ports?.pairing ?? DEFAULT_LOCAL_CONFIG.ports.pairing,
      },
    });
  }
  await writeOpenScoutSettings({
    onboarding: {
      initRanAt: options.now ?? nowMs(),
    },
  }, {
    currentDirectory: options.currentDirectory,
  });
  return loadOpenScoutOnboardingState({
    currentDirectory: options.currentDirectory,
    broker: options.broker,
    catalog: options.catalog,
  });
}

export async function saveOpenScoutOnboardingIdentity(input: {
  name: string;
  currentDirectory?: string;
  now?: number;
  broker?: BrokerServiceStatus | null;
  catalog?: HarnessCatalogSnapshot | null;
}): Promise<OpenScoutOnboardingState> {
  const name = input.name.trim();
  if (!name) {
    throw new Error("Operator name is required.");
  }

  const userConfig = loadUserConfig();
  userConfig.name = name;
  saveUserConfig(userConfig);
  await writeOpenScoutSettings({
    profile: {
      operatorName: name,
    },
    onboarding: {
      operatorAnsweredAt: input.now ?? nowMs(),
    },
  }, {
    currentDirectory: input.currentDirectory,
  });

  return loadOpenScoutOnboardingState({
    currentDirectory: input.currentDirectory,
    broker: input.broker,
    catalog: input.catalog,
  });
}

export async function saveOpenScoutOnboardingProject(input: {
  currentDirectory?: string;
  contextRoot: string;
  sourceRoots: string[];
  defaultHarness?: string | null;
  now?: number;
  broker?: BrokerServiceStatus | null;
  catalog?: HarnessCatalogSnapshot | null;
}): Promise<OpenScoutOnboardingState> {
  const contextRoot = normalizePath(input.contextRoot);
  const sourceRoots = Array.from(new Set(input.sourceRoots.map(normalizePath).filter(Boolean)));
  const existingSettings = await readOpenScoutSettings({
    currentDirectory: input.currentDirectory ?? contextRoot,
  });
  const defaultHarness = normalizeDefaultHarness(input.defaultHarness ?? existingSettings.agents.defaultHarness);
  const now = input.now ?? nowMs();

  // An empty `sourceRoots` means "this caller has nothing to say about roots" —
  // e.g. `scout setup --default-harness codex` on an already-configured machine
  // — not "forget the configured roots". Writing the empty array through was a
  // silent data loss: the read path re-seeds a plausible-looking default
  // (setup.ts `seedWorkspaceRoots`), so a curated list vanished with no error
  // and `sourceRootsAnsweredAt` reset, re-arming the first-run prompt.
  // An explicit clear needs its own settings contract; this onboarding writer
  // treats omission/empty input as preservation.
  const rootsProvided = sourceRoots.length > 0;

  await writeOpenScoutSettings({
    discovery: {
      contextRoot,
      ...(rootsProvided ? { workspaceRoots: sourceRoots } : {}),
    },
    agents: {
      defaultHarness,
      defaultTransport: defaultTransportForHarness(defaultHarness),
    },
    onboarding: {
      ...(rootsProvided ? { sourceRootsAnsweredAt: now } : {}),
      harnessChosenAt: now,
      inputsSavedAt: now,
    },
  }, {
    currentDirectory: input.currentDirectory ?? contextRoot,
  });

  return loadOpenScoutOnboardingState({
    currentDirectory: contextRoot,
    broker: input.broker,
    catalog: input.catalog,
  });
}

/**
 * One-off project registration: appends a root to discovery.workspaceRoots
 * and touches nothing else — unlike saveOpenScoutOnboardingProject, which is
 * the onboarding writer and REPLACES the roots array wholesale.
 */
export async function addOpenScoutWorkspaceRoot(input: {
  root: string;
  currentDirectory?: string;
}): Promise<{ root: string; workspaceRoots: string[]; alreadyRegistered: boolean }> {
  const root = normalizePath(input.root);
  const settings = await readOpenScoutSettings({ currentDirectory: input.currentDirectory });
  const existing = settings.discovery.workspaceRoots.map(normalizePath);
  const alreadyRegistered = existing.includes(root);
  if (!alreadyRegistered) {
    await writeOpenScoutSettings({
      discovery: {
        workspaceRoots: [...existing, root],
      },
    }, {
      currentDirectory: input.currentDirectory,
    });
  }
  return {
    root,
    workspaceRoots: alreadyRegistered ? existing : [...existing, root],
    alreadyRegistered,
  };
}

async function triggerMeshDiscovery(broker: BrokerServiceStatus): Promise<void> {
  if (!broker.reachable || !broker.brokerUrl) return;
  try {
    await fetch(new URL("/v1/mesh/discover", broker.brokerUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Best effort: setup should still succeed if mesh discovery is unavailable.
  }
}

export async function runOpenScoutOnboardingSetup(input: {
  currentDirectory: string;
  sourceRoots?: string[];
  contextRoot?: string;
  defaultHarness?: string | null;
  now?: number;
}): Promise<OpenScoutOnboardingSetupResult> {
  const contextRoot = normalizePath(input.contextRoot ?? input.currentDirectory);
  const sourceRoots = input.sourceRoots ?? [];
  if (sourceRoots.length > 0 || input.defaultHarness || input.contextRoot) {
    await saveOpenScoutOnboardingProject({
      currentDirectory: input.currentDirectory,
      contextRoot,
      sourceRoots,
      defaultHarness: input.defaultHarness,
      now: input.now,
    });
  }

  await ensureOpenScoutOnboardingLocalConfig({
    currentDirectory: contextRoot,
    now: input.now,
  });

  const setup = await initializeOpenScoutSetup({ currentDirectory: contextRoot });
  const [scoutSkill, claudeStatusline] = await Promise.all([
    installScoutSkillToHarnesses(),
    installClaudeStatuslineTool(),
  ]);
  const catalog = await loadHarnessCatalogSnapshot();
  let broker = await brokerServiceStatus();
  let brokerWarning: string | null = null;
  try {
    broker = await startBrokerService();
  } catch (error) {
    brokerWarning = error instanceof Error ? error.message : String(error);
    broker = await brokerServiceStatus();
  }
  await triggerMeshDiscovery(broker);

  await markOpenScoutOnboardingCommand({
    command: "setup",
    currentDirectory: contextRoot,
    broker,
    catalog,
    now: input.now,
  });

  return {
    setup,
    broker,
    brokerWarning,
    catalog,
    scoutSkill,
    claudeStatusline,
    state: await loadOpenScoutOnboardingState({
      currentDirectory: contextRoot,
      broker,
      catalog,
    }),
  };
}

export async function markOpenScoutOnboardingCommand(input: {
  command: OpenScoutOnboardingCommandName;
  currentDirectory?: string;
  broker?: BrokerServiceStatus | null;
  catalog?: HarnessCatalogSnapshot | null;
  now?: number;
}): Promise<OpenScoutOnboardingState> {
  const now = input.now ?? nowMs();
  const onboarding = input.command === "setup"
    ? { initRanAt: now }
    : input.command === "doctor"
      ? { doctorRanAt: now }
      : { runtimesRanAt: now };

  await writeOpenScoutSettings({
    onboarding,
  }, {
    currentDirectory: input.currentDirectory,
  });

  const state = await loadOpenScoutOnboardingState({
    currentDirectory: input.currentDirectory,
    broker: input.broker,
    catalog: input.catalog,
  });
  if (!state.completedAt && !state.skippedAt) {
    const complete = state.hasLocalConfig
      && state.hasOperatorName
      && state.hasProjectConfig
      && state.brokerReachable
      && state.hasReadyRuntime;
    if (complete) {
      await writeOpenScoutSettings({
        onboarding: {
          completedAt: now,
        },
      }, {
        currentDirectory: input.currentDirectory,
      });
      return loadOpenScoutOnboardingState({
        currentDirectory: input.currentDirectory,
        broker: input.broker,
        catalog: input.catalog,
      });
    }
  }
  return state;
}

/**
 * Persist onboarding completion once the core steps are all satisfied.
 *
 * Returning users can briefly see a broker dip (mid-session restart, sleep)
 * that would otherwise re-arm the takeover. Stamping `completedAt` the moment
 * everything is green makes completion sticky, so a later transient failure
 * cannot resurrect first-run for someone who already finished. No-op once
 * `completedAt`/`skippedAt` is set, or while any core step is still open.
 */
export async function ensureOpenScoutOnboardingCompletion(options: {
  currentDirectory?: string;
  now?: number;
} = {}): Promise<OpenScoutOnboardingState> {
  const state = await loadOpenScoutOnboardingState({ currentDirectory: options.currentDirectory });
  if (state.completedAt || state.skippedAt) {
    return state;
  }
  const complete = state.hasLocalConfig
    && state.hasOperatorName
    && state.hasProjectConfig
    && state.brokerReachable
    && state.hasReadyRuntime;
  if (!complete) {
    return state;
  }
  await writeOpenScoutSettings({
    onboarding: {
      completedAt: options.now ?? nowMs(),
    },
  }, {
    currentDirectory: options.currentDirectory,
  });
  return loadOpenScoutOnboardingState({ currentDirectory: options.currentDirectory });
}

export async function skipOpenScoutOnboarding(options: {
  currentDirectory?: string;
  now?: number;
} = {}): Promise<OpenScoutOnboardingState> {
  await writeOpenScoutSettings({
    onboarding: {
      skippedAt: options.now ?? nowMs(),
    },
  }, {
    currentDirectory: options.currentDirectory,
  });
  return loadOpenScoutOnboardingState({ currentDirectory: options.currentDirectory });
}

export async function restartOpenScoutOnboarding(options: {
  currentDirectory?: string;
} = {}): Promise<OpenScoutOnboardingState> {
  await writeOpenScoutSettings({
    onboarding: {
      operatorAnsweredAt: null,
      sourceRootsAnsweredAt: null,
      harnessChosenAt: null,
      inputsSavedAt: null,
      initRanAt: null,
      doctorRanAt: null,
      runtimesRanAt: null,
      completedAt: null,
      skippedAt: null,
    },
  }, {
    currentDirectory: options.currentDirectory,
  });
  return loadOpenScoutOnboardingState({ currentDirectory: options.currentDirectory });
}
