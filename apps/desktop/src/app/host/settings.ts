import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { type AgentHarness } from "@openscout/protocol";
import type { BrokerServiceStatus } from "@openscout/runtime/broker-process-manager";
import { loadHarnessCatalogSnapshot } from "@openscout/runtime/harness-catalog";
import {
  SUPPORTED_LOCAL_AGENT_HARNESSES,
} from "@openscout/runtime/local-agents";
import {
  loadResolvedRelayAgents,
  readOpenScoutSettings,
  writeOpenScoutSettings,
  DEFAULT_OPERATOR_NAME,
} from "@openscout/runtime/setup";
import {
  markOpenScoutOnboardingCommand,
  restartOpenScoutOnboarding,
  saveOpenScoutOnboardingIdentity,
  skipOpenScoutOnboarding,
} from "@openscout/runtime/onboarding";
import { resolveOpenScoutSupportPaths } from "@openscout/runtime/support-paths";

import { getRuntimeBrokerServiceStatus } from "./runtime-service-client.ts";
import { SCOUT_PRODUCT_NAME } from "../../shared/product.ts";
import { syncScoutBrokerBindings } from "../../core/broker/service.ts";
import {
  deriveScoutHostTelegramRuntimeState as deriveScoutDesktopTelegramRuntimeState,
  normalizeScoutHostTelegramConfig as normalizeScoutDesktopTelegramConfig,
  type ScoutHostTelegramRuntimeState as ScoutDesktopTelegramRuntimeState,
} from "./telegram.ts";

const SCOUT_CLI_COMMAND = "scout";

export type SetupAgentSummary = {
  id: string;
  title: string;
  root: string;
  source: string;
  registrationKind: "configured" | "discovered";
  harness: string;
  sessionId: string;
  projectConfigPath: string | null;
};

export type SetupProjectHarnessSummary = {
  harness: string;
  source: "manifest" | "marker" | "default";
  detail: string;
  readinessState: "ready" | "configured" | "installed" | "missing" | null;
  readinessDetail: string | null;
};

export type SetupProjectSummary = {
  id: string;
  definitionId: string;
  title: string;
  projectName: string;
  root: string;
  sourceRoot: string;
  relativePath: string;
  source: string;
  registrationKind: "configured" | "discovered";
  defaultHarness: string;
  projectConfigPath: string | null;
  harnesses: SetupProjectHarnessSummary[];
};

export type SetupRuntimeSummary = {
  name: string;
  label: string;
  readinessState: "ready" | "configured" | "installed" | "missing";
  readinessDetail: string;
};

export type HiddenProjectSummary = {
  root: string;
  title: string;
  projectConfigPath: string | null;
};

export type SetupOnboardingStep = {
  id: string;
  title: string;
  detail: string;
  complete: boolean;
};

export type SetupOnboardingState = {
  needed: boolean;
  title: string;
  detail: string;
  commands: string[];
  steps: SetupOnboardingStep[];
};

export type OnboardingCommandName = "setup" | "doctor" | "runtimes";

export type RunOnboardingCommandInput = {
  command: OnboardingCommandName;
  contextRoot?: string;
  sourceRoots?: string[];
};

export type OnboardingCommandResult = {
  command: OnboardingCommandName;
  commandLine: string;
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  output: string;
};

export type AppSettingsState = {
  operatorId: string;
  operatorName: string;
  operatorNameDefault: string;
  note: string | null;
  settingsPath: string;
  relayAgentsPath: string;
  relayHubPath: string;
  supportDirectory: string;
  controlPlaneSqlitePath: string;
  onboardingContextRoot: string;
  currentProjectConfigPath: string | null;
  workspaceInventoryLoaded: boolean;
  workspaceRoots: string[];
  hiddenProjects: HiddenProjectSummary[];
  workspaceRootsNote: string | null;
  includeCurrentRepo: boolean;
  defaultHarness: string;
  defaultTransport: string;
  defaultCapabilities: string[];
  sessionPrefix: string;
  telegram: {
    enabled: boolean;
    mode: "auto" | "webhook" | "polling";
    botToken: string;
    secretToken: string;
    apiBaseUrl: string;
    userName: string;
    defaultConversationId: string;
    ownerNodeId: string;
    configured: boolean;
    running: boolean;
    runtimeMode: "webhook" | "polling" | null;
    detail: string;
    lastError: string | null;
    bindingCount: number;
    pendingDeliveries: number;
  };
  openScoutNetwork: {
    discoveryEnabled: boolean;
    rendezvousUrl: string;
    pairingRelayUrl: string;
    keepPairingRelayRunning: boolean;
  };
  discoveredAgents: SetupAgentSummary[];
  projectInventory: SetupProjectSummary[];
  runtimeCatalog: SetupRuntimeSummary[];
  onboarding: SetupOnboardingState;
  broker: {
    label: string;
    url: string;
    installed: boolean;
    loaded: boolean;
    reachable: boolean;
    launchAgentPath: string;
    stdoutLogPath: string;
    stderrLogPath: string;
  };
};

type ScoutDesktopSettingsBase = {
  settingsDirectory: string;
  onboardingContextRoot: string;
  currentProjectConfigPath: string | null;
  supportPaths: ReturnType<typeof resolveOpenScoutSupportPaths>;
  record: Awaited<ReturnType<typeof readOpenScoutSettings>>;
  status: BrokerServiceStatus;
  catalog: Awaited<ReturnType<typeof loadHarnessCatalogSnapshot>>;
  readinessByHarness: Map<string, Awaited<ReturnType<typeof loadHarnessCatalogSnapshot>>["entries"][number]["readinessReport"]>;
  workspaceRoots: string[];
  hiddenProjectRoots: string[];
  onboardingSteps: SetupOnboardingStep[];
  onboardingNeeded: boolean;
  telegram: Awaited<ReturnType<typeof resolveTelegramSettingsState>>;
};

export type UpdateAppSettingsInput = {
  operatorName: string;
  onboardingContextRoot: string;
  workspaceRootsText: string;
  includeCurrentRepo: boolean;
  defaultHarness: string;
  defaultCapabilitiesText: string;
  sessionPrefix: string;
  telegram: {
    enabled: boolean;
    mode: "auto" | "webhook" | "polling";
    botToken: string;
    secretToken: string;
    apiBaseUrl: string;
    userName: string;
    defaultConversationId: string;
    ownerNodeId: string;
  };
  openScoutNetwork?: {
    discoveryEnabled?: boolean;
    rendezvousUrl?: string;
    pairingRelayUrl?: string;
    keepPairingRelayRunning?: boolean;
  };
};

export type ScoutDesktopSettingsService = {
  getTelegramRuntimeState?: () => Promise<ScoutDesktopTelegramRuntimeState> | ScoutDesktopTelegramRuntimeState;
  refreshTelegramConfiguration?: () => Promise<void> | void;
};

function compactHomePath(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const home = process.env.HOME ?? "";
  return home && value.startsWith(home) ? value.replace(home, "~") : value;
}

function expandHomePath(value: string): string {
  if (value === "~") {
    return process.env.HOME ?? value;
  }
  if (value.startsWith("~/")) {
    return path.join(process.env.HOME ?? "", value.slice(2));
  }
  return value;
}

function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function splitDelimitedTokens(value: string): string[] {
  return value
    .split(/[\n,]/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizedHiddenProjectRoots(
  value: string[] | null | undefined,
): string[] {
  return uniqueNormalizedPaths(Array.isArray(value) ? value : []);
}

function uniqueNormalizedPaths(values: string[]): string[] {
  return Array.from(new Set(values.map((entry) => path.resolve(expandHomePath(entry.trim()))).filter(Boolean)));
}

function normalizeOperatorName(value: string | undefined | null): string {
  const trimmed = value?.trim() ?? "";
  return trimmed || DEFAULT_OPERATOR_NAME;
}

function normalizeSessionPrefix(value: string | undefined): string {
  const trimmed = (value ?? "").trim().replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "");
  return trimmed || "relay";
}

function defaultOnboardingContextRoot(
  explicitRoot: string | null | undefined,
  workspaceRoots: string[],
  fallback: string,
): string {
  const chosenRoot = explicitRoot?.trim()
    || workspaceRoots.find((entry) => entry.trim().length > 0)
    || fallback;
  return path.resolve(expandHomePath(chosenRoot));
}

function isExecutable(candidate: string): boolean {
  return existsSync(candidate);
}

function resolveScoutDesktopScoutExecutable(): string {
  const explicit = process.env.OPENSCOUT_SCOUT_BIN ?? process.env.SCOUT_BIN;
  if (explicit?.trim()) {
    return explicit.trim();
  }

  const pathEntries = (process.env.PATH ?? "").split(":").filter(Boolean);
  const commonDirectories = [
    path.join(homedir(), ".bun", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];

  for (const directory of [...pathEntries, ...commonDirectories]) {
    const candidate = path.join(directory.replace(/^~(?=$|\/)/, homedir()), SCOUT_CLI_COMMAND);
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  throw new Error(buildMissingScoutCliMessage());
}

function resolveScoutDesktopBunInstallCommand(): string {
  const pathEntries = (process.env.PATH ?? "").split(":").filter(Boolean);
  const brewCandidates = [
    ...pathEntries.map((entry) => path.join(entry, "brew")),
    "/opt/homebrew/bin/brew",
    "/usr/local/bin/brew",
  ];

  for (const candidate of brewCandidates) {
    if (isExecutable(candidate)) {
      return "brew install bun";
    }
  }

  return "curl -fsSL https://bun.sh/install | bash";
}

function buildMissingScoutCliMessage(): string {
  const bunInstallCommand = resolveScoutDesktopBunInstallCommand();
  return [
    "Scout CLI was not found on this Mac.",
    "Install Bun, then install the Scout package globally:",
    `1. ${bunInstallCommand}`,
    "2. bun add -g @openscout/scout",
    "3. scout version",
  ].join("\n");
}

function resolveSettingsDirectory(input?: string): string {
  const trimmed = input?.trim();
  if (trimmed) {
    return trimmed;
  }

  const configured = process.env.OPENSCOUT_SETUP_CWD?.trim();
  return configured || process.cwd();
}

function buildOnboardingSteps(input: {
  operatorName: string;
  operatorAnswered: boolean;
  sourceRootsAnswered: boolean;
  harnessChosen: boolean;
  inputsSaved: boolean;
  initRan: boolean;
  doctorRan: boolean;
  runtimesRan: boolean;
  hasSourceRoots: boolean;
  hasReadyRuntime: boolean;
  hasCurrentProjectConfig: boolean;
  workspaceRootCount: number;
  projectInventoryCount: number;
  defaultHarness: string;
}): SetupOnboardingStep[] {
  return [
    {
      id: "welcome",
      title: "Say hi",
      detail: input.operatorAnswered
        ? `${SCOUT_PRODUCT_NAME} will call you ${input.operatorName}.`
        : `Tell ${SCOUT_PRODUCT_NAME} what to call you across the app, desktop surfaces, and prompts.`,
      complete: input.operatorAnswered,
    },
    {
      id: "source-roots",
      title: "Choose folders to scan",
      detail: input.hasSourceRoots
        ? `${input.workspaceRootCount} scan folder${input.workspaceRootCount === 1 ? "" : "s"} currently configured.`
        : `Add the parent folders ${SCOUT_PRODUCT_NAME} should scan for repos, then choose where this context should live.`,
      complete: input.sourceRootsAnswered,
    },
    {
      id: "harness",
      title: "Choose a default harness",
      detail: `Current default harness: ${input.defaultHarness}.`,
      complete: input.harnessChosen,
    },
    {
      id: "confirm",
      title: "Confirm this context",
      detail: input.inputsSaved
        ? "Your scan folders and context location have been saved for onboarding."
        : "Review the scan folders and context location before Scout saves them and moves into the command steps.",
      complete: input.inputsSaved,
    },
    {
      id: "setup",
      title: "Run setup",
      detail: input.hasCurrentProjectConfig
        ? "The selected context root already has a local `.openscout/project.json`."
        : "Run `scout setup` from this screen to create a local `.openscout/project.json` at your selected context root.",
      complete: input.initRan,
    },
    {
      id: "doctor",
      title: "Run doctor",
      detail: input.projectInventoryCount > 0
        ? `${input.projectInventoryCount} project${input.projectInventoryCount === 1 ? "" : "s"} currently appear in inventory.`
        : `${SCOUT_PRODUCT_NAME} has not discovered any projects from the configured scan folders yet.`,
      complete: input.doctorRan,
    },
    {
      id: "runtimes",
      title: "Run runtimes",
      detail: input.hasReadyRuntime
        ? "At least one harness is installed and authenticated."
        : "Install or sign into Claude or Codex so the broker can start local agent sessions.",
      complete: input.runtimesRan,
    },
  ];
}

function resolveCurrentProjectConfigPath(onboardingContextRoot: string): string | null {
  const candidate = path.join(onboardingContextRoot, ".openscout", "project.json");
  return existsSync(candidate) ? candidate : null;
}

async function loadScoutDesktopSettingsBase(
  currentDirectory?: string,
  services: ScoutDesktopSettingsService = {},
  input: {
    projectInventoryCount?: number;
  } = {},
): Promise<ScoutDesktopSettingsBase> {
  const settingsDirectory = resolveSettingsDirectory(currentDirectory);
  const supportPaths = resolveOpenScoutSupportPaths();
  const record = await readOpenScoutSettings({ currentDirectory: settingsDirectory });
  const onboardingContextRoot = defaultOnboardingContextRoot(
    record.discovery.contextRoot,
    record.discovery.workspaceRoots,
    settingsDirectory,
  );
  const currentProjectConfigPath = resolveCurrentProjectConfigPath(onboardingContextRoot);
  const [status, catalog] = await Promise.all([
    getRuntimeBrokerServiceStatus(),
    loadHarnessCatalogSnapshot(),
  ]);

  const readinessByHarness = new Map(
    catalog.entries.map((entry) => [entry.harness, entry.readinessReport] as const),
  );
  const workspaceRoots = Array.isArray(record.discovery.workspaceRoots)
    ? record.discovery.workspaceRoots
    : [];
  const hiddenProjectRoots = Array.isArray(record.discovery.hiddenProjectRoots)
    ? record.discovery.hiddenProjectRoots
    : [];
  const hasSourceRoots = workspaceRoots.length > 0;
  const hasReadyRuntime = catalog.entries.some((entry) => entry.readinessReport.ready);
  const onboardingProgress = record.onboarding;
  const onboardingSteps = buildOnboardingSteps({
    operatorName: normalizeOperatorName(record.profile.operatorName),
    operatorAnswered: Boolean(onboardingProgress.operatorAnsweredAt),
    sourceRootsAnswered: Boolean(onboardingProgress.sourceRootsAnsweredAt),
    harnessChosen: Boolean(onboardingProgress.harnessChosenAt),
    inputsSaved: Boolean(onboardingProgress.inputsSavedAt),
    initRan: Boolean(onboardingProgress.initRanAt),
    doctorRan: Boolean(onboardingProgress.doctorRanAt),
    runtimesRan: Boolean(onboardingProgress.runtimesRanAt),
    hasSourceRoots,
    hasReadyRuntime,
    hasCurrentProjectConfig: Boolean(currentProjectConfigPath),
    workspaceRootCount: workspaceRoots.length,
    projectInventoryCount: input.projectInventoryCount ?? 0,
    defaultHarness: record.agents.defaultHarness,
  });
  const onboardingNeeded = !(onboardingProgress.completedAt || onboardingProgress.skippedAt);
  const telegram = await resolveTelegramSettingsState({
    enabled: record.bridges.telegram.enabled,
    mode: record.bridges.telegram.mode,
    botToken: record.bridges.telegram.botToken,
    secretToken: record.bridges.telegram.secretToken,
    apiBaseUrl: record.bridges.telegram.apiBaseUrl,
    userName: record.bridges.telegram.userName,
    defaultConversationId: record.bridges.telegram.defaultConversationId,
    ownerNodeId: record.bridges.telegram.ownerNodeId,
    configured: false,
    running: false,
    runtimeMode: null,
    detail: "",
    lastError: null,
    bindingCount: 0,
    pendingDeliveries: 0,
  }, services, {
    brokerReachable: status.reachable,
    localNodeId: status.health.nodeId ?? null,
  });

  return {
    settingsDirectory,
    onboardingContextRoot,
    currentProjectConfigPath,
    supportPaths,
    record,
    status,
    catalog,
    readinessByHarness,
    workspaceRoots,
    hiddenProjectRoots,
    onboardingSteps,
    onboardingNeeded,
    telegram,
  };
}

function buildScoutDesktopAppSettingsState(
  base: ScoutDesktopSettingsBase,
  input: {
    workspaceInventoryLoaded: boolean;
    discoveredAgents?: SetupAgentSummary[];
    projectInventory?: SetupProjectSummary[];
  },
): AppSettingsState {
  const discoveredAgents = input.discoveredAgents ?? [];
  const projectInventory = input.projectInventory ?? [];
  return {
    operatorId: "operator",
    operatorName: normalizeOperatorName(base.record.profile.operatorName),
    operatorNameDefault: DEFAULT_OPERATOR_NAME,
    note: "Shown across Scout surfaces. Clear it to fall back to the default name.",
    settingsPath: base.supportPaths.settingsPath,
    relayAgentsPath: base.supportPaths.relayAgentsRegistryPath,
    relayHubPath: base.supportPaths.relayHubDirectory,
    supportDirectory: base.supportPaths.supportDirectory,
    controlPlaneSqlitePath: path.join(base.supportPaths.controlHome, "control-plane.sqlite"),
    onboardingContextRoot: compactHomePath(base.onboardingContextRoot) ?? base.onboardingContextRoot,
    currentProjectConfigPath: base.currentProjectConfigPath,
    workspaceInventoryLoaded: input.workspaceInventoryLoaded,
    workspaceRoots: base.workspaceRoots.map((root) => compactHomePath(root) ?? root),
    hiddenProjects: base.hiddenProjectRoots.map((root) => {
      const normalizedRoot = path.resolve(root);
      const projectConfigFilePath = path.join(normalizedRoot, ".openscout", "project.json");
      return {
        root: compactHomePath(normalizedRoot) ?? normalizedRoot,
        title: path.basename(normalizedRoot) || normalizedRoot,
        projectConfigPath: existsSync(projectConfigFilePath)
          ? (compactHomePath(projectConfigFilePath) ?? projectConfigFilePath)
          : null,
      };
    }),
    workspaceRootsNote: "Scan folders are user-configured. Scout walks them recursively to find repos, project roots, and harness evidence.",
    includeCurrentRepo: base.record.discovery.includeCurrentRepo,
    defaultHarness: base.record.agents.defaultHarness,
    defaultTransport: base.record.agents.defaultTransport,
    defaultCapabilities: [...base.record.agents.defaultCapabilities],
    sessionPrefix: base.record.agents.sessionPrefix,
    telegram: base.telegram,
    openScoutNetwork: {
      discoveryEnabled: base.record.network.openScoutNetwork.discoveryEnabled,
      rendezvousUrl: base.record.network.openScoutNetwork.rendezvousUrl,
      pairingRelayUrl: base.record.network.openScoutNetwork.pairingRelayUrl,
      keepPairingRelayRunning: base.record.network.openScoutNetwork.keepPairingRelayRunning,
    },
    discoveredAgents: discoveredAgents.map((agent) => ({
      id: agent.id,
      title: agent.title,
      root: compactHomePath(agent.root) ?? agent.root,
      source: agent.source,
      registrationKind: agent.registrationKind,
      harness: agent.harness,
      sessionId: agent.sessionId,
      projectConfigPath: agent.projectConfigPath ? compactHomePath(agent.projectConfigPath) ?? agent.projectConfigPath : null,
    })),
    projectInventory: projectInventory.map((project) => ({
      id: project.id,
      definitionId: project.definitionId,
      title: project.title,
      projectName: project.projectName,
      root: compactHomePath(project.root) ?? project.root,
      sourceRoot: compactHomePath(project.sourceRoot) ?? project.sourceRoot,
      relativePath: project.relativePath,
      source: project.source,
      registrationKind: project.registrationKind,
      defaultHarness: project.defaultHarness,
      projectConfigPath: project.projectConfigPath ? compactHomePath(project.projectConfigPath) ?? project.projectConfigPath : null,
      harnesses: project.harnesses.map((harness) => ({
        harness: harness.harness,
        source: harness.source,
        detail: harness.detail,
        readinessState: base.readinessByHarness.get(harness.harness)?.state ?? null,
        readinessDetail: base.readinessByHarness.get(harness.harness)?.detail ?? null,
      })),
    })),
    runtimeCatalog: base.catalog.entries.map((entry) => ({
      name: entry.name,
      label: entry.label,
      readinessState: entry.readinessReport.state,
      readinessDetail: entry.readinessReport.detail,
    })),
    onboarding: {
      needed: base.onboardingNeeded,
      title: base.onboardingNeeded ? "Finish First-Run Setup" : `${SCOUT_PRODUCT_NAME} Is Ready`,
      detail: base.onboardingNeeded
        ? "Use the same `scout setup`, `scout doctor`, and `scout runtimes` commands from this screen. The wizard tracks explicit progress instead of guessing from current machine state."
        : `${SCOUT_PRODUCT_NAME} onboarding has been completed or skipped for this machine. You can still revisit the setup screens any time.`,
      commands: [
        "scout setup --source-root ~/dev",
        "scout doctor",
        "scout runtimes",
      ],
      steps: base.onboardingSteps,
    },
    broker: {
      label: base.status.label,
      url: base.status.brokerUrl,
      installed: base.status.installed,
      loaded: base.status.loaded,
      reachable: base.status.reachable,
      launchAgentPath: compactHomePath(base.status.launchAgentPath) ?? base.status.launchAgentPath,
      stdoutLogPath: compactHomePath(base.status.stdoutLogPath) ?? base.status.stdoutLogPath,
      stderrLogPath: compactHomePath(base.status.stderrLogPath) ?? base.status.stderrLogPath,
    },
  };
}

function deriveFallbackTelegramState(input: {
  enabled: boolean;
  mode: "auto" | "webhook" | "polling";
  botToken: string;
  secretToken: string;
  apiBaseUrl: string;
  userName: string;
  defaultConversationId: string;
  ownerNodeId: string;
}, readiness: {
  brokerReachable: boolean;
  localNodeId: string | null;
}): ScoutDesktopTelegramRuntimeState {
  const config = normalizeScoutDesktopTelegramConfig({
    enabled: input.enabled,
    mode: input.mode,
    botToken: input.botToken,
    secretToken: input.secretToken,
    apiBaseUrl: input.apiBaseUrl,
    userName: input.userName,
    defaultConversationId: input.defaultConversationId,
    ownerNodeId: input.ownerNodeId,
  });
  return deriveScoutDesktopTelegramRuntimeState({
    config,
    readiness: {
      brokerReachable: readiness.brokerReachable,
      localNodeId: readiness.localNodeId,
      ownerNodeId: config.ownerNodeId || null,
      ownerPinned: Boolean(config.ownerNodeId),
    },
    running: readiness.brokerReachable && config.enabled && config.configured,
    runtimeMode: config.mode === "webhook" ? "webhook" : config.mode === "polling" ? "polling" : null,
    bindingCount: 0,
    pendingDeliveries: 0,
    lastError: null,
  });
}

async function resolveTelegramSettingsState(
  input: AppSettingsState["telegram"],
  services: ScoutDesktopSettingsService,
  readiness: {
    brokerReachable: boolean;
    localNodeId: string | null;
  },
): Promise<AppSettingsState["telegram"]> {
  const runtimeState = services.getTelegramRuntimeState
    ? await services.getTelegramRuntimeState()
    : deriveFallbackTelegramState(input, readiness);

  return {
    enabled: input.enabled,
    mode: input.mode,
    botToken: input.botToken,
    secretToken: input.secretToken,
    apiBaseUrl: input.apiBaseUrl,
    userName: input.userName,
    defaultConversationId: input.defaultConversationId,
    ownerNodeId: input.ownerNodeId,
    configured: runtimeState.configured,
    running: runtimeState.running,
    runtimeMode: runtimeState.runtimeMode,
    detail: runtimeState.detail,
    lastError: runtimeState.lastError,
    bindingCount: runtimeState.bindingCount,
    pendingDeliveries: runtimeState.pendingDeliveries,
  };
}

export async function getScoutDesktopAppSettings(
  currentDirectory?: string,
  services: ScoutDesktopSettingsService = {},
): Promise<AppSettingsState> {
  const base = await loadScoutDesktopSettingsBase(currentDirectory, services);
  return buildScoutDesktopAppSettingsState(base, {
    workspaceInventoryLoaded: false,
  });
}

export async function refreshScoutDesktopAppSettingsInventory(
  currentDirectory?: string,
  services: ScoutDesktopSettingsService = {},
): Promise<AppSettingsState> {
  const base = await loadScoutDesktopSettingsBase(currentDirectory, services);
  const setup = await loadResolvedRelayAgents({
    currentDirectory: base.onboardingContextRoot,
  });
  const projectInventory = Array.isArray(setup.projectInventory)
    ? setup.projectInventory.map((project) => ({
      id: project.agentId,
      definitionId: project.definitionId,
      title: project.displayName,
      projectName: project.projectName,
      root: project.projectRoot,
      sourceRoot: project.sourceRoot,
      relativePath: project.relativePath,
      source: project.source,
      registrationKind: project.registrationKind,
      defaultHarness: project.defaultHarness,
      projectConfigPath: project.projectConfigPath ?? null,
      harnesses: project.harnesses.map((harness) => ({
        harness: harness.harness,
        source: harness.source,
        detail: harness.detail,
        readinessState: null,
        readinessDetail: null,
      })),
    } satisfies SetupProjectSummary))
    : [];
  const discoveredAgents = Array.isArray(setup.discoveredAgents)
    ? setup.discoveredAgents.map((agent) => ({
      id: agent.agentId,
      title: agent.displayName,
      root: agent.projectRoot,
      source: agent.source,
      registrationKind: agent.registrationKind,
      harness: agent.runtime.harness,
      sessionId: agent.runtime.sessionId,
      projectConfigPath: agent.projectConfigPath ?? null,
    } satisfies SetupAgentSummary))
    : [];

  return buildScoutDesktopAppSettingsState(
    await loadScoutDesktopSettingsBase(currentDirectory, services, {
      projectInventoryCount: projectInventory.length,
    }),
    {
      workspaceInventoryLoaded: true,
      discoveredAgents,
      projectInventory,
    },
  );
}

export async function runScoutDesktopOnboardingCommand(
  input: RunOnboardingCommandInput,
  currentDirectory?: string,
): Promise<OnboardingCommandResult> {
  const settingsDirectory = resolveSettingsDirectory(currentDirectory);
  const contextRoot = path.resolve(expandHomePath(
    input.contextRoot?.trim()
    || defaultOnboardingContextRoot(null, input.sourceRoots ?? [], settingsDirectory),
  ));
  const scoutExecutable = resolveScoutDesktopScoutExecutable();
  const cliCommand = input.command === "setup" ? "setup" : input.command;
  const normalizedSourceRoots = Array.from(new Set(
    (input.sourceRoots ?? [])
      .map((entry) => expandHomePath(entry).trim())
      .filter(Boolean),
  ));

  const displayArgs = [SCOUT_CLI_COMMAND, input.command, "--context-root", compactHomePath(contextRoot) ?? contextRoot];
  const execArgs = [cliCommand, "--context-root", contextRoot];
  if (input.command === "setup") {
    for (const sourceRoot of normalizedSourceRoots) {
      displayArgs.push("--source-root", compactHomePath(sourceRoot) ?? sourceRoot);
      execArgs.push("--source-root", sourceRoot);
    }
  }

  const result = await new Promise<OnboardingCommandResult>((resolvePromise, reject) => {
    const child = spawn(scoutExecutable, execArgs, {
      cwd: settingsDirectory,
      env: {
        ...process.env,
        OPENSCOUT_SETUP_CWD: contextRoot,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      const stdoutText = stdout.trim();
      const stderrText = stderr.trim();
      const output = [stdoutText, stderrText].filter(Boolean).join("\n\n").trim();
      resolvePromise({
        command: input.command,
        commandLine: displayArgs.join(" "),
        cwd: compactHomePath(contextRoot) ?? contextRoot,
        exitCode: code ?? 0,
        stdout: stdoutText,
        stderr: stderrText,
        output: output || "(no output)",
      });
    });
  });

  if (result.exitCode === 0) {
    const brokerStatus = input.command === "runtimes"
      ? await getRuntimeBrokerServiceStatus()
      : null;
    const catalog = input.command === "runtimes"
      ? await loadHarnessCatalogSnapshot()
      : null;
    await markOpenScoutOnboardingCommand({
      command: input.command,
      currentDirectory: contextRoot,
      broker: brokerStatus,
      catalog,
    });
  }

  return result;
}

export async function skipScoutDesktopOnboarding(
  currentDirectory?: string,
  services: ScoutDesktopSettingsService = {},
): Promise<AppSettingsState> {
  await skipOpenScoutOnboarding({
    currentDirectory: resolveSettingsDirectory(currentDirectory),
  });
  return getScoutDesktopAppSettings(currentDirectory, services);
}

export async function restartScoutDesktopOnboarding(
  currentDirectory?: string,
  services: ScoutDesktopSettingsService = {},
): Promise<AppSettingsState> {
  await restartOpenScoutOnboarding({
    currentDirectory: resolveSettingsDirectory(currentDirectory),
  });
  return getScoutDesktopAppSettings(currentDirectory, services);
}

export async function updateScoutDesktopAppSettings(
  input: UpdateAppSettingsInput,
  currentDirectory?: string,
  services: ScoutDesktopSettingsService = {},
): Promise<AppSettingsState> {
  const trimmedOperatorName = input.operatorName?.trim() ?? "";
  const trimmedContextRoot = input.onboardingContextRoot?.trim() ?? "";
  const defaultHarness: AgentHarness = SUPPORTED_LOCAL_AGENT_HARNESSES.includes(input.defaultHarness as AgentHarness)
    ? input.defaultHarness as AgentHarness
    : "claude";
  const now = Date.now();
  const settingsDirectory = resolveSettingsDirectory(currentDirectory);
  const workspaceRoots = splitLines(input.workspaceRootsText).map((entry) => expandHomePath(entry));
  const onboardingContextRoot = defaultOnboardingContextRoot(
    trimmedContextRoot || null,
    workspaceRoots,
    settingsDirectory,
  );

  await writeOpenScoutSettings({
    profile: {
      operatorName: trimmedOperatorName || DEFAULT_OPERATOR_NAME,
    },
    onboarding: {
      operatorAnsweredAt: now,
      sourceRootsAnsweredAt: splitLines(input.workspaceRootsText).length > 0 ? now : null,
      harnessChosenAt: now,
      inputsSavedAt: now,
    },
    discovery: {
      contextRoot: trimmedContextRoot ? expandHomePath(trimmedContextRoot) : null,
      workspaceRoots,
      includeCurrentRepo: input.includeCurrentRepo,
    },
    agents: {
      defaultHarness,
      defaultTransport: defaultHarness === "codex" ? "codex_app_server" : "tmux",
      defaultCapabilities: splitDelimitedTokens(input.defaultCapabilitiesText) as Array<"chat" | "invoke" | "deliver" | "speak" | "listen" | "bridge" | "summarize" | "review" | "execute">,
      sessionPrefix: normalizeSessionPrefix(input.sessionPrefix),
    },
    bridges: {
      telegram: {
        enabled: input.telegram.enabled,
        mode: input.telegram.mode,
        botToken: input.telegram.botToken,
        secretToken: input.telegram.secretToken,
        apiBaseUrl: input.telegram.apiBaseUrl,
        userName: input.telegram.userName,
        defaultConversationId: input.telegram.defaultConversationId,
        ownerNodeId: input.telegram.ownerNodeId,
      },
    },
    ...(input.openScoutNetwork
      ? {
          network: {
            openScoutNetwork: {
              ...(typeof input.openScoutNetwork.discoveryEnabled === "boolean"
                ? { discoveryEnabled: input.openScoutNetwork.discoveryEnabled }
                : {}),
              ...(input.openScoutNetwork.rendezvousUrl !== undefined
                ? { rendezvousUrl: input.openScoutNetwork.rendezvousUrl }
                : {}),
              ...(input.openScoutNetwork.pairingRelayUrl !== undefined
                ? { pairingRelayUrl: input.openScoutNetwork.pairingRelayUrl }
                : {}),
              ...(typeof input.openScoutNetwork.keepPairingRelayRunning === "boolean"
                ? { keepPairingRelayRunning: input.openScoutNetwork.keepPairingRelayRunning }
                : {}),
            },
          },
        }
      : {}),
  }, {
    currentDirectory: settingsDirectory,
  });
  await saveOpenScoutOnboardingIdentity({
    name: trimmedOperatorName || DEFAULT_OPERATOR_NAME,
    currentDirectory: settingsDirectory,
  });

  if (services.refreshTelegramConfiguration) {
    await services.refreshTelegramConfiguration();
  }

  const broker = await getRuntimeBrokerServiceStatus();
  if (broker.reachable) {
    try {
      await syncScoutBrokerBindings({
        currentDirectory: onboardingContextRoot,
        operatorId: "operator",
        operatorName: trimmedOperatorName || DEFAULT_OPERATOR_NAME,
      });
    } catch {
      // Persisting settings should not fail just because the live broker actor could not refresh.
    }
  }

  return getScoutDesktopAppSettings(currentDirectory, services);
}

async function updateHiddenProjectRoots(
  nextHiddenProjectRoots: string[],
  currentDirectory?: string,
  services: ScoutDesktopSettingsService = {},
): Promise<AppSettingsState> {
  const settingsDirectory = resolveSettingsDirectory(currentDirectory);
  const currentSettings = await readOpenScoutSettings({ currentDirectory: settingsDirectory });
  await writeOpenScoutSettings({
    discovery: {
      hiddenProjectRoots: normalizedHiddenProjectRoots(nextHiddenProjectRoots),
    },
  }, {
    currentDirectory: settingsDirectory,
  });

  if (services.refreshTelegramConfiguration) {
    await services.refreshTelegramConfiguration();
  }

  const onboardingContextRoot = defaultOnboardingContextRoot(
    currentSettings.discovery.contextRoot,
    currentSettings.discovery.workspaceRoots,
    settingsDirectory,
  );
  const broker = await getRuntimeBrokerServiceStatus();
  if (broker.reachable) {
    try {
      await syncScoutBrokerBindings({
        currentDirectory: onboardingContextRoot,
        operatorId: "operator",
        operatorName: normalizeOperatorName(currentSettings.profile.operatorName),
      });
    } catch {
      // Hiding/restoring a project should still persist even if the live broker refresh fails.
    }
  }

  return refreshScoutDesktopAppSettingsInventory(currentDirectory, services);
}

export async function retireScoutDesktopProject(
  projectRoot: string,
  currentDirectory?: string,
  services: ScoutDesktopSettingsService = {},
): Promise<AppSettingsState> {
  const settingsDirectory = resolveSettingsDirectory(currentDirectory);
  const currentSettings = await readOpenScoutSettings({ currentDirectory: settingsDirectory });
  return updateHiddenProjectRoots(
    [...normalizedHiddenProjectRoots(currentSettings.discovery.hiddenProjectRoots), projectRoot],
    currentDirectory,
    services,
  );
}

export async function restoreScoutDesktopProject(
  projectRoot: string,
  currentDirectory?: string,
  services: ScoutDesktopSettingsService = {},
): Promise<AppSettingsState> {
  const settingsDirectory = resolveSettingsDirectory(currentDirectory);
  const currentSettings = await readOpenScoutSettings({ currentDirectory: settingsDirectory });
  const normalizedProjectRoot = path.resolve(expandHomePath(projectRoot));
  return updateHiddenProjectRoots(
    normalizedHiddenProjectRoots(currentSettings.discovery.hiddenProjectRoots)
      .filter((entry) => path.resolve(expandHomePath(entry)) !== normalizedProjectRoot),
    currentDirectory,
    services,
  );
}
