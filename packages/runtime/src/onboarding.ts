export { assessSetupCompletion, hasUsableScoutApp, type SetupCompletion } from "./setup-completion.js";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { SCOUT_RUNTIME_CATALOG, type AgentHarness } from "@openscout/protocol";

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
  resolveHarnessSessionDefaults,
  type HarnessCatalogSnapshot,
  type HarnessReadinessState,
} from "./harness-catalog.js";
import {
  DEFAULT_OPERATOR_NAME,
  findOnboardingProjectRoot,
  installClaudeStatuslineTool,
  initializeOpenScoutSetup,
  installScoutSkillToHarnesses,
  MANAGED_AGENT_HARNESSES,
  readOpenScoutSettings,
  type ManagedAgentHarness,
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
  /** Saved/explicit context or a real project; null requires a user choice. */
  suggestedContextRoot: string | null;
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
  /** Local readiness of the chosen default harness, not any installed agent. */
  hasReadyRuntime: boolean;
  readyRuntimeCount: number;
  selectedHarness: OnboardingHarnessObservation | null;
  skippedAt: number | null;
  completedAt: number | null;
  needed: boolean;
  steps: OpenScoutOnboardingStep[];
  /** Setup choices with the readiness this read observed; absent if the catalog couldn't load. */
  harnesses?: OnboardingHarnessObservation[];
};

export type OpenScoutOnboardingSetupResult = {
  setup: SetupResult;
  broker: BrokerServiceStatus;
  brokerWarning: string | null;
  /**
   * Set when the service adapter leaves broker start to a foreground process
   * (headless-foreground) and none is running yet: setup did its part and the
   * operator starts the broker. An expected handoff, not a broker failure.
   */
  brokerHandoff: OpenScoutBrokerHandoff | null;
  catalog: HarnessCatalogSnapshot;
  scoutSkill: ScoutSkillInstallReport;
  claudeStatusline: ClaudeStatuslineInstallReport;
  state: OpenScoutOnboardingState;
};

export type OpenScoutBrokerHandoff = {
  command: string;
  detail: string;
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

/**
 * Harnesses first-run setup offers, in catalog order: the Scout runtime
 * catalog's enabled, listed harnesses that Scout can run as a managed agent.
 * The catalog is the authority; there is no second list here.
 */
export const ONBOARDING_HARNESS_CHOICES: readonly ManagedAgentHarness[] = SCOUT_RUNTIME_CATALOG.harnesses
  .filter((entry) => entry.enabled !== false && entry.listed !== false)
  .map((entry) => entry.id)
  .filter((id): id is ManagedAgentHarness => (MANAGED_AGENT_HARNESSES as readonly string[]).includes(id));

export class OnboardingHarnessError extends Error {
  readonly value: string;
  constructor(value: string) {
    super(`Unknown harness "${value}". Choose one of: ${ONBOARDING_HARNESS_CHOICES.join(", ")}.`);
    this.name = "OnboardingHarnessError";
    this.value = value;
  }
}

/**
 * Canonical onboarding harness for a user-supplied name, or null. Catalog
 * aliases resolve to their session harness (`grok` → `grok-acp`); anything
 * not offered is null rather than quietly becoming Claude.
 */
export function parseOnboardingHarness(value: string | null | undefined): ManagedAgentHarness | null {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) return null;
  const canonical = resolveHarnessSessionDefaults(trimmed)?.harness ?? trimmed;
  return ONBOARDING_HARNESS_CHOICES.find((choice) => choice === canonical) ?? null;
}

/** The transport the runtime harness catalog launches this harness with. */
export function onboardingTransportForHarness(harness: ManagedAgentHarness): RelayRuntimeTransport {
  const transport = resolveHarnessSessionDefaults(harness)?.transport;
  if (!transport) {
    throw new Error(`Harness catalog has no session defaults for "${harness}".`);
  }
  return transport as RelayRuntimeTransport;
}

/**
 * What the state read already observed about one setup choice. Local evidence
 * only (see `localOnly` readiness): no vault, provider status or network call.
 * `configured` with `ready: false` means installed but sign-in unverified
 * locally (e.g. Cursor); only `ready: true` counts toward setup completion.
 */
export type OnboardingHarnessObservation = {
  id: ManagedAgentHarness;
  label: string;
  state: HarnessReadinessState;
  ready: boolean;
  detail: string;
  installCommand?: string | null;
  loginCommand?: string | null;
  homepage?: string | null;
};

/** The setup choices, in catalog order, from a snapshot the caller already has. */
export function onboardingHarnessObservations(catalog: HarnessCatalogSnapshot): OnboardingHarnessObservation[] {
  return ONBOARDING_HARNESS_CHOICES.flatMap((id) => {
    const entry = catalog.entries.find((candidate) => candidate.name === id);
    if (!entry) return [];
    const label = SCOUT_RUNTIME_CATALOG.harnesses.find((harness) => harness.id === id)?.label ?? entry.label;
    const report = entry.readinessReport;
    const installCommand = process.platform === "win32"
      ? entry.install?.windows
      : process.platform === "darwin" ? entry.install?.macos : entry.install?.linux;
    const detail = report.ready
      ? `${label}'s local setup was found. Sign-in and task execution are confirmed when an agent starts.`
      : report.detail;
    return [{ id, label, state: report.state, ready: report.ready, detail,
      installCommand: installCommand ?? null, loginCommand: report.loginCommand, homepage: entry.homepage ?? null }];
  });
}

async function nearestProjectConfig(startDirectory: string | null | undefined, stopAtHome = false): Promise<{
  projectRoot: string;
  projectConfigPath: string;
} | null> {
  const trimmed = startDirectory?.trim();
  if (!trimmed) return null;

  let current = normalizePath(trimmed);
  const home = normalizePath(process.env.HOME?.trim() || homedir());
  while (true) {
    if (stopAtHome && (current === home || current === dirname(home))) break;
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
  currentDirectory: string | null;
  contextRoot: string | null;
}): Promise<{ projectRoot: string; projectConfigPath: string } | null> {
  const configured = await nearestProjectConfig(input.contextRoot);
  if (configured) return configured;

  const direct = await nearestProjectConfig(input.currentDirectory, true);
  if (direct) return direct;

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
  selectedHarness: OnboardingHarnessObservation | null;
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
      title: "Check your coding agent",
      detail: input.selectedHarness?.detail
        ?? "Scout couldn't check your chosen coding agent. Check again before your first task.",
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

  // The broker also injects this variable from its own startup directory. It
  // is a safe inference fallback, never authority over a saved user choice.
  const startupContext = process.env.OPENSCOUT_SETUP_CWD?.trim();
  const inferredStartupRoot = !settings.discovery.contextRoot && startupContext
    ? await findOnboardingProjectRoot(startupContext) : null;
  const contextRoot = settings.discovery.contextRoot ?? inferredStartupRoot;
  const inferredProjectRoot = await findOnboardingProjectRoot(currentDirectory);
  const suggestedContextRoot = contextRoot ?? inferredProjectRoot;
  // A removed saved folder must return to project selection, even if an
  // ancestor or the service cwd happens to contain another project config.
  const contextExists = contextRoot ? statSync(contextRoot, { throwIfNoEntry: false })?.isDirectory() === true : true;
  const project = contextExists
    ? await resolveProjectConfig({ currentDirectory: inferredProjectRoot ? currentDirectory : null, contextRoot }) : null;
  const broker = options.broker ?? await brokerServiceStatus().catch(() => null);
  // This read is polled while setup is on screen (the Mac app's gate), so it
  // counts ready runtimes from local evidence without harness auth/status calls.
  const catalog = options.catalog ?? await loadHarnessCatalogSnapshot({ localOnly: true }).catch(() => null);
  const readyRuntimeCount = catalog?.entries.filter((entry) => entry.readinessReport.ready).length ?? 0;
  const harnesses = catalog ? onboardingHarnessObservations(catalog) : undefined;
  const selectedHarnessId = parseOnboardingHarness(settings.agents.defaultHarness) ?? settings.agents.defaultHarness;
  const selectedHarness = harnesses?.find((entry) => entry.id === selectedHarnessId) ?? null;
  const hasReadyRuntime = selectedHarness?.ready === true;
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
    selectedHarness,
  });

  return {
    currentDirectory,
    contextRoot,
    suggestedContextRoot,
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
    selectedHarness,
    skippedAt: settings.onboarding.skippedAt,
    completedAt: settings.onboarding.completedAt,
    needed: !(settings.onboarding.skippedAt || settings.onboarding.completedAt || coreComplete),
    steps,
    ...(harnesses ? { harnesses } : {}),
  };
}

export async function ensureOpenScoutOnboardingLocalConfig(options: {
  currentDirectory?: string;
  host?: string;
  ports?: { broker?: number; web?: number; pairing?: number };
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
  return loadOpenScoutOnboardingState({ currentDirectory: options.currentDirectory });
}

export async function saveOpenScoutOnboardingIdentity(input: {
  name: string;
  currentDirectory?: string;
  now?: number;
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

  return loadOpenScoutOnboardingState({ currentDirectory: input.currentDirectory });
}

export async function saveOpenScoutOnboardingProject(input: {
  currentDirectory?: string;
  contextRoot: string;
  sourceRoots: string[];
  defaultHarness?: string | null;
  now?: number;
}): Promise<OpenScoutOnboardingState> {
  const contextRoot = normalizePath(input.contextRoot);
  const sourceRoots = Array.from(new Set(input.sourceRoots.map(normalizePath).filter(Boolean)));
  const existingSettings = await readOpenScoutSettings({
    currentDirectory: input.currentDirectory ?? contextRoot,
  });
  // An explicit choice must be one setup offers; a stored one is kept as is
  // (with its stored transport) so existing configurations don't shift.
  const chosenHarness = input.defaultHarness?.trim() ? parseOnboardingHarness(input.defaultHarness) : null;
  if (input.defaultHarness?.trim() && !chosenHarness) {
    throw new OnboardingHarnessError(input.defaultHarness.trim());
  }
  const agents = chosenHarness
    ? { defaultHarness: chosenHarness, defaultTransport: onboardingTransportForHarness(chosenHarness) }
    : {
      defaultHarness: existingSettings.agents.defaultHarness,
      defaultTransport: existingSettings.agents.defaultTransport,
    };
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
    agents,
    onboarding: {
      ...(rootsProvided ? { sourceRootsAnsweredAt: now } : {}),
      harnessChosenAt: now,
      inputsSavedAt: now,
    },
  }, {
    currentDirectory: input.currentDirectory ?? contextRoot,
  });

  return loadOpenScoutOnboardingState({ currentDirectory: contextRoot });
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
  let broker = await brokerServiceStatus();
  let brokerWarning: string | null = null;
  let brokerHandoff: OpenScoutBrokerHandoff | null = null;
  if (broker.serviceAdapter === "headless-foreground" && !broker.reachable) {
    // This adapter has no start lifecycle: the broker runs as a foreground
    // process the operator owns. Hand that step over instead of attempting an
    // unsupported start. A reachable-but-unhealthy broker is still a failure.
    brokerHandoff = {
      command: "openscout-runtime broker",
      detail: "Next step: run `openscout-runtime broker` in this shell or under your process manager. "
        + "The headless service adapter leaves broker start to that foreground process.",
    };
  } else {
    try {
      // A healthy existing broker needs no lifecycle action on a rerun,
      // including an externally supervised foreground broker.
      if (!broker.health.ok) {
        broker = await startBrokerService();
      }
    } catch (error) {
      brokerWarning = error instanceof Error ? error.message : String(error);
      broker = await brokerServiceStatus();
    }
  }
  // Verify the post-start observation, not a pre-start snapshot.
  broker = await brokerServiceStatus();
  // A broker that appeared during setup is no longer a foreground handoff.
  // Its current health must decide success, including a reachable failure.
  if (broker.reachable) brokerHandoff = null;
  const catalog = await loadHarnessCatalogSnapshot({ localOnly: true });
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
    brokerHandoff,
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
  broker?: BrokerServiceStatus | null;
  catalog?: HarnessCatalogSnapshot | null;
} = {}): Promise<OpenScoutOnboardingState> {
  const observed = { broker: options.broker, catalog: options.catalog };
  const state = await loadOpenScoutOnboardingState({ currentDirectory: options.currentDirectory, ...observed });
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
  return loadOpenScoutOnboardingState({ currentDirectory: options.currentDirectory, ...observed });
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
