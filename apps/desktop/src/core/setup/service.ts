import { lookup } from "node:dns/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Socket } from "node:net";
import {
  DEFAULT_SCOUT_WEB_PORTAL_HOST,
  resolveConfiguredScoutWebHostname,
  resolveScoutWebNamedHostname,
} from "@openscout/runtime/local-config";
import {
  SCOUT_RUNTIME_CATALOG,
  scoutRuntimeDefaultHarness,
  scoutRuntimeDefaultModel,
  scoutRuntimeDefaultReasoningEffort,
  scoutRuntimeDefaultsByHarness,
  scoutRuntimeEffortCatalog,
  scoutRuntimeModelCatalog,
  type ScoutCapabilityMatrixSnapshot,
  type ScoutRuntimeCapabilityCatalog,
} from "@openscout/protocol";
import { resolveOpenScoutLocalEdgeConfig } from "@openscout/runtime/local-edge";
import {
  loadResolvedRelayAgents,
  type ClaudeStatuslineInstallReport,
  type ProjectInventoryEntry,
  type ProjectInventoryError,
  type SetupResult,
  type ScoutSkillInstallReport,
} from "@openscout/runtime/setup";
import { runOpenScoutOnboardingSetup } from "@openscout/runtime/onboarding";
import { loadHarnessCatalogSnapshot } from "@openscout/runtime/harness-catalog";
import type { BrokerServiceStatus } from "@openscout/runtime/broker-process-manager";
import {
  getRuntimeBrokerServiceStatus,
} from "../../app/host/runtime-service-client.ts";
import { resolveOpenScoutSupportPaths } from "@openscout/runtime/support-paths";
import {
  loadSystemProbeDoctorReport,
  type SystemProbeDoctorReport,
} from "@openscout/runtime/system-probes";
import { withScoutCoreCommandLock } from "./command-lock.ts";
import {
  ensureScoutLocalEdgeDependencies,
  inspectScoutLocalEdgeDependencies,
  type ScoutLocalEdgeDependencyReport,
} from "./local-edge-dependencies.ts";
import {
  inspectScoutTerminalPtyDependencies,
  type ScoutTerminalPtyReport,
} from "./terminal-pty-dependencies.ts";
import { readScoutCapabilityMatrix, readScoutRuntimeCatalog } from "../broker/service.ts";

export type ScoutLocalEdgeDoctorReport = {
  state: "ready" | "degraded" | "missing";
  portalHost: string;
  nodeHost: string;
  caddyfilePath: string;
  dependency: ScoutLocalEdgeDependencyReport;
  dns: {
    portal: ScoutLocalEdgeHostResolution;
    node: ScoutLocalEdgeHostResolution;
  };
  listeners: {
    http: ScoutLocalEdgePortProbe;
    https: ScoutLocalEdgePortProbe;
  };
  hints: string[];
};

export type ScoutLocalEdgeHostResolution = {
  host: string;
  resolved: boolean;
  addresses: string[];
  error: string | null;
};

export type ScoutLocalEdgePortProbe = {
  port: number;
  listening: boolean;
};

export type ScoutDoctorReport = {
  currentDirectory: string;
  repoRoot: string;
  supportPaths: ReturnType<typeof resolveOpenScoutSupportPaths>;
  broker: BrokerServiceStatus;
  localEdge: ScoutLocalEdgeDoctorReport;
  terminalPty: ScoutTerminalPtyReport;
  systemProbes: SystemProbeDoctorReport;
  setup: Awaited<ReturnType<typeof loadResolvedRelayAgents>>;
  catalog: Awaited<ReturnType<typeof loadHarnessCatalogSnapshot>>;
  capabilities: ScoutCapabilityMatrixSnapshot | null;
};

export type ScoutSetupReport = {
  currentDirectory: string;
  setup: SetupResult;
  broker: BrokerServiceStatus;
  brokerWarning: string | null;
  localEdge: ScoutLocalEdgeDependencyReport;
  catalog: Awaited<ReturnType<typeof loadHarnessCatalogSnapshot>>;
  scoutSkill: ScoutSkillInstallReport;
  claudeStatusline: ClaudeStatuslineInstallReport;
};

export type ScoutRuntimesReport = {
  currentDirectory: string;
  harnessCatalogPath: string;
  catalog: Awaited<ReturnType<typeof loadHarnessCatalogSnapshot>>;
  capabilities: ScoutCapabilityMatrixSnapshot | null;
  runtimeCapabilities: ScoutRuntimeCapabilityCatalog;
};

export type ScoutProjectInventoryEntry = ProjectInventoryEntry;

export async function loadScoutDoctorReport(input: {
  currentDirectory: string;
  repoRoot: string;
  env?: NodeJS.ProcessEnv;
  onProjectInventoryEntry?: (entry: ProjectInventoryEntry) => void | Promise<void>;
  onProjectInventoryError?: (error: ProjectInventoryError) => void | Promise<void>;
}): Promise<ScoutDoctorReport> {
  return withScoutCoreCommandLock("doctor", async () => {
    const [broker, localEdge, terminalPty, systemProbes, setup, catalog, capabilities] = await Promise.all([
      getRuntimeBrokerServiceStatus(),
      loadScoutLocalEdgeDoctorReport(input.env ?? process.env),
      Promise.resolve(inspectScoutTerminalPtyDependencies({ env: input.env ?? process.env })),
      loadSystemProbeDoctorReport({ repoRoot: input.repoRoot }),
      loadResolvedRelayAgents({
        currentDirectory: input.currentDirectory,
        onProjectInventoryEntry: input.onProjectInventoryEntry,
        onProjectInventoryError: input.onProjectInventoryError,
      }),
      loadHarnessCatalogSnapshot(),
      readScoutCapabilityMatrix(),
    ]);

    return {
      currentDirectory: input.currentDirectory,
      repoRoot: input.repoRoot,
      supportPaths: resolveOpenScoutSupportPaths(),
      broker,
      localEdge,
      terminalPty,
      systemProbes,
      setup,
      catalog,
      capabilities,
    };
  });
}

async function loadScoutLocalEdgeDoctorReport(env: NodeJS.ProcessEnv): Promise<ScoutLocalEdgeDoctorReport> {
  const dependency = inspectScoutLocalEdgeDependencies({ env });
  const nodeHost = env.OPENSCOUT_WEB_ADVERTISED_HOST?.trim()
    || (env.OPENSCOUT_WEB_LOCAL_NAME?.trim()
      ? resolveScoutWebNamedHostname(env.OPENSCOUT_WEB_LOCAL_NAME)
      : resolveConfiguredScoutWebHostname());
  const localEdgeConfig = resolveOpenScoutLocalEdgeConfig({
    portalHost: env.OPENSCOUT_WEB_PORTAL_HOST?.trim() || DEFAULT_SCOUT_WEB_PORTAL_HOST,
    nodeHost,
  });
  const portalHost = localEdgeConfig.portalHost;

  const [portalDns, nodeDns, http, https] = await Promise.all([
    resolveLocalEdgeHost(portalHost),
    resolveLocalEdgeHost(localEdgeConfig.nodeHost),
    probeTcpPort(80),
    probeTcpPort(443),
  ]);

  const hints: string[] = [];
  const caddyAvailable = dependency.status === "ready" || dependency.status === "installed";
  const httpsTrustReady = dependency.trust.status === "trusted" || dependency.trust.status === "installed";
  if (!caddyAvailable) {
    hints.push(dependency.detail);
  }
  if (https.listening && !httpsTrustReady) {
    hints.push(`${dependency.trust.detail} Run \`scout server trust\` if you intended to use HTTPS.`);
  }
  if (!portalDns.resolved || !nodeDns.resolved || (!http.listening && !https.listening)) {
    hints.push("Start the local edge with `scout server edge`.");
  }

  const state = caddyAvailable
    && portalDns.resolved
    && nodeDns.resolved
    && (http.listening || https.listening)
    && (!https.listening || httpsTrustReady)
    ? "ready"
    : caddyAvailable || portalDns.resolved || nodeDns.resolved || http.listening || https.listening
      ? "degraded"
      : "missing";

  return {
    state,
    portalHost,
    nodeHost: localEdgeConfig.nodeHost,
    caddyfilePath: join(homedir(), ".scout", "local-edge", "Caddyfile"),
    dependency,
    dns: {
      portal: portalDns,
      node: nodeDns,
    },
    listeners: {
      http,
      https,
    },
    hints,
  };
}

async function resolveLocalEdgeHost(host: string): Promise<ScoutLocalEdgeHostResolution> {
  try {
    const entries = await withTimeout(lookup(host, { all: true }), 1_500);
    const addresses = [...new Set(entries.map((entry) => entry.address))];
    return {
      host,
      resolved: addresses.length > 0,
      addresses,
      error: null,
    };
  } catch (error) {
    return {
      host,
      resolved: false,
      addresses: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function probeTcpPort(port: number): Promise<ScoutLocalEdgePortProbe> {
  const listening = await new Promise<boolean>((resolve) => {
    const socket = new Socket();
    const done = (result: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(350);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
    socket.connect(port, "127.0.0.1");
  });

  return {
    port,
    listening,
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export async function runScoutSetup(input: {
  currentDirectory: string;
  sourceRoots: string[];
  defaultHarness?: string | null;
}): Promise<ScoutSetupReport> {
  return withScoutCoreCommandLock("setup", async () => {
    const setupResult = await runOpenScoutOnboardingSetup({
      currentDirectory: input.currentDirectory,
      sourceRoots: input.sourceRoots,
      defaultHarness: input.defaultHarness,
    });
    const localEdge = ensureScoutLocalEdgeDependencies({ trustLocalHttps: false });

    return {
      currentDirectory: input.currentDirectory,
      setup: setupResult.setup,
      broker: setupResult.broker,
      brokerWarning: setupResult.brokerWarning,
      localEdge,
      catalog: setupResult.catalog,
      scoutSkill: setupResult.scoutSkill,
      claudeStatusline: setupResult.claudeStatusline,
    };
  });
}

export async function loadScoutRuntimesReport(currentDirectory: string): Promise<ScoutRuntimesReport> {
  return withScoutCoreCommandLock("runtimes", async () => {
    const [catalog, liveCatalog] = await Promise.all([
      loadHarnessCatalogSnapshot(),
      readScoutRuntimeCatalog(),
    ]);
    const runtimeCatalog = liveCatalog?.catalog ?? SCOUT_RUNTIME_CATALOG;
    const defaultHarness = scoutRuntimeDefaultHarness(runtimeCatalog);
    const defaultModel = scoutRuntimeDefaultModel(defaultHarness ?? "", runtimeCatalog);
    return {
      currentDirectory,
      harnessCatalogPath: resolveOpenScoutSupportPaths().harnessCatalogPath,
      catalog,
      capabilities: await readScoutCapabilityMatrix(),
      runtimeCapabilities: {
        schemaVersion: "openscout.runtime-capabilities.v1",
        catalogVersion: runtimeCatalog.schemaVersion,
        catalogRevision: runtimeCatalog.revision,
        generatedAt: Date.now(),
        scope: "global",
        defaults: {
          ...(defaultHarness ? { harness: defaultHarness } : {}),
          model: defaultModel,
          reasoningEffort: scoutRuntimeDefaultReasoningEffort(defaultHarness ?? "", defaultModel, runtimeCatalog),
        },
        defaultsByHarness: scoutRuntimeDefaultsByHarness(runtimeCatalog),
        harnesses: runtimeCatalog.harnesses
          .filter((entry) => entry.enabled && entry.listed !== false)
          .map((entry) => {
            const readiness = catalog.entries.find((candidate) => candidate.harness === entry.id);
            return {
              id: entry.id,
              name: readiness?.name,
              label: entry.label,
              description: readiness?.description,
              state: readiness?.readinessReport.state,
              ready: readiness?.readinessReport.ready,
              detail: readiness?.readinessReport.detail,
            };
          }),
        models: scoutRuntimeModelCatalog(runtimeCatalog).map((model) => ({ ...model, harnesses: [...model.harnesses] })),
        efforts: scoutRuntimeEffortCatalog(runtimeCatalog).map((effort) => ({
          ...effort,
          harnesses: [...effort.harnesses],
          ...(effort.models ? { models: [...effort.models] } : {}),
        })),
        ...(liveCatalog?.warnings.length ? { warnings: liveCatalog.warnings } : {}),
      },
    };
  });
}
