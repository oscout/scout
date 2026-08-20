import {
  buildMcpCapabilityMatrixSnapshot,
  normalizeModelCatalogToScoutCapabilities,
  unsupportedHarnessFeature,
  type AgentCapability,
  type HarnessFeatureSupport,
  type HarnessFeatureSupportMap,
  type McpServerCapabilities,
  type McpToolDefinition,
  type McpToolsListResult,
  type ScoutModelCatalogEntry,
  type ScoutCapabilityReadiness,
  type ScoutCapabilityDefinition,
  type ScoutCapabilityMatrixSnapshot,
  type ScoutCapabilityMatrixSource,
  type ScoutCapabilityScope,
} from "@openscout/protocol";

import type {
  HarnessCatalogEntry,
  HarnessCatalogSnapshot,
  ResolvedHarnessCatalogEntry,
} from "./harness-catalog.js";

export type RuntimeMcpToolDiscoveryInput = {
  kind: "mcp_tools";
  serverId: string;
  serverName?: string;
  protocolVersion?: string;
  capturedAt?: number;
  scope?: ScoutCapabilityScope;
  serverCapabilities?: McpServerCapabilities;
  tools: readonly McpToolDefinition[] | McpToolsListResult;
  enabled?: boolean;
  readiness?: Partial<ScoutCapabilityReadiness>;
};

export type RuntimeHarnessSupportInput = {
  kind: "harness_support";
  id: string;
  name?: string;
  capturedAt?: number;
  support: HarnessFeatureSupportMap;
  raw?: unknown;
};

export type RuntimeProviderCatalogInput = {
  kind: "provider_catalog";
  id: string;
  name?: string;
  capturedAt?: number;
  raw: unknown;
};

export type RuntimeModelCatalogInput = {
  kind: "model_catalog";
  id: string;
  name?: string;
  capturedAt?: number;
  raw: unknown;
  models?: readonly ScoutModelCatalogEntry[];
};

export type RuntimeProbeInput = {
  kind: "runtime_probe";
  id: string;
  name?: string;
  capturedAt?: number;
  raw: unknown;
};

export type RuntimeAnnotationInput = {
  kind: "human_annotation";
  id: string;
  name?: string;
  capturedAt?: number;
  raw: unknown;
};

export type RuntimeCapabilityMatrixInput =
  | RuntimeMcpToolDiscoveryInput
  | RuntimeHarnessSupportInput
  | RuntimeProviderCatalogInput
  | RuntimeModelCatalogInput
  | RuntimeProbeInput
  | RuntimeAnnotationInput;

export type BuildRuntimeCapabilityMatrixOptions = {
  generatedAt?: number;
  scope?: ScoutCapabilityScope;
  inputs: RuntimeCapabilityMatrixInput[];
  warnings?: string[];
};

export function buildRuntimeCapabilityMatrixSnapshot(
  options: BuildRuntimeCapabilityMatrixOptions,
): ScoutCapabilityMatrixSnapshot {
  const generatedAt = options.generatedAt ?? Date.now();
  const sources: ScoutCapabilityMatrixSource[] = [];
  const capabilitiesById = new Map<string, ScoutCapabilityDefinition>();
  const harnessSupport: Record<string, HarnessFeatureSupportMap> = {};
  const warnings = [...(options.warnings ?? [])];

  for (const input of options.inputs) {
    switch (input.kind) {
      case "mcp_tools": {
        const snapshot = buildMcpCapabilityMatrixSnapshot({
          serverId: input.serverId,
          serverName: input.serverName,
          protocolVersion: input.protocolVersion,
          capturedAt: input.capturedAt ?? generatedAt,
          scope: input.scope ?? options.scope,
          serverCapabilities: input.serverCapabilities,
          tools: input.tools,
          enabled: input.enabled,
          readiness: input.readiness,
        });
        sources.push(...snapshot.sources);
        warnings.push(...snapshot.warnings);
        for (const capability of snapshot.capabilities) {
          capabilitiesById.set(capability.id, capability);
        }
        break;
      }

      case "harness_support": {
        const capturedAt = input.capturedAt ?? generatedAt;
        harnessSupport[input.id] = input.support;
        sources.push({
          kind: "harness_adapter",
          id: input.id,
          name: input.name,
          capturedAt,
          raw: input.raw ?? input.support,
        });
        break;
      }

      case "provider_catalog": {
        sources.push(makeGenericSource(input, "provider_catalog", generatedAt));
        break;
      }

      case "model_catalog": {
        sources.push(makeGenericSource(input, "model_catalog", generatedAt));
        if (input.models) {
          for (const capability of normalizeModelCatalogToScoutCapabilities({
            sourceId: input.id,
            sourceName: input.name,
            capturedAt: input.capturedAt ?? generatedAt,
            scope: options.scope,
            models: input.models,
          })) {
            capabilitiesById.set(capability.id, capability);
          }
        }
        break;
      }

      case "runtime_probe": {
        sources.push(makeGenericSource(input, "runtime_probe", generatedAt));
        break;
      }

      case "human_annotation": {
        sources.push(makeGenericSource(input, "human_annotation", generatedAt));
        break;
      }
    }
  }

  return {
    generatedAt,
    scope: options.scope,
    sources,
    capabilities: [...capabilitiesById.values()],
    harnessSupport: Object.keys(harnessSupport).length > 0 ? harnessSupport : undefined,
    warnings,
  };
}

export function buildHarnessSupportInputFromCatalogEntry(
  entry: HarnessCatalogEntry | ResolvedHarnessCatalogEntry,
  options: { capturedAt?: number } = {},
): RuntimeHarnessSupportInput {
  return {
    kind: "harness_support",
    id: String(entry.harness || entry.name),
    name: entry.label,
    capturedAt: options.capturedAt,
    support: buildHarnessFeatureSupportMapFromCatalogEntry(entry),
    raw: {
      name: entry.name,
      harness: entry.harness,
      support: entry.support,
      capabilities: entry.capabilities,
      readinessReport: "readinessReport" in entry ? entry.readinessReport : undefined,
      source: "source" in entry ? entry.source : undefined,
    },
  };
}

export function buildHarnessSupportInputsFromCatalogSnapshot(
  snapshot: HarnessCatalogSnapshot,
): RuntimeHarnessSupportInput[] {
  return snapshot.entries.map((entry) =>
    buildHarnessSupportInputFromCatalogEntry(entry, { capturedAt: snapshot.generatedAt })
  );
}

export function buildHarnessReadinessProbeInputFromCatalogEntry(
  entry: ResolvedHarnessCatalogEntry,
  options: { capturedAt?: number } = {},
): RuntimeProbeInput {
  const report = entry.readinessReport;
  return {
    kind: "runtime_probe",
    id: `harness:${entry.harness || entry.name}:readiness`,
    name: `${entry.label} readiness`,
    capturedAt: options.capturedAt,
    raw: {
      target: "harness",
      name: entry.name,
      harness: entry.harness,
      state: report.state,
      installed: report.installed,
      configured: report.configured,
      ready: report.ready,
      detail: report.detail,
      missing: report.missing,
      binaryPath: report.binaryPath,
      binaryVersion: report.binaryVersion,
      binarySource: report.binarySource,
      loginCommand: report.loginCommand,
    },
  };
}

export function buildHarnessReadinessProbeInputsFromCatalogSnapshot(
  snapshot: HarnessCatalogSnapshot,
): RuntimeProbeInput[] {
  return snapshot.entries.map((entry) =>
    buildHarnessReadinessProbeInputFromCatalogEntry(entry, { capturedAt: snapshot.generatedAt })
  );
}

export function buildHarnessFeatureSupportMapFromCatalogEntry(
  entry: HarnessCatalogEntry | ResolvedHarnessCatalogEntry,
): HarnessFeatureSupportMap {
  const evidence = [{ kind: "catalog" as const, ref: `harness-catalog:${entry.name}` }];
  const capabilities = new Set<AgentCapability>(entry.capabilities);
  const authRequirements = [
    ...(entry.readiness?.allOf ?? []),
    ...(entry.readiness?.anyOf ?? []),
  ];

  return {
    prompts: {
      systemPrompt: unknownFeature("Harness catalog does not declare system prompt support.", evidence),
      agentInstructions: unknownFeature("Harness catalog does not declare agent instruction support.", evidence),
      promptFiles: unknownFeature("Harness catalog does not declare prompt file support.", evidence),
      images: unknownFeature("Harness catalog does not declare image input support.", evidence),
    },
    session: {
      start: capabilities.has("invoke")
        ? supportedFeature("Harness catalog advertises invocation support.", evidence)
        : unsupportedHarnessFeature("Harness catalog does not advertise invocation support.", evidence),
      resume: entry.resume
        ? supportedFeature("Harness catalog declares a resume command.", evidence)
        : unsupportedHarnessFeature("Harness catalog does not declare a resume command.", evidence),
      interrupt: unknownFeature("Harness catalog does not declare interrupt support.", evidence),
      shutdown: unknownFeature("Harness catalog does not declare shutdown support.", evidence),
      concurrentTurns: unknownFeature("Harness catalog does not declare concurrent turn support.", evidence),
      traceObserve: unknownFeature("Harness catalog does not declare trace observation support.", evidence),
    },
    interaction: {
      questions: unknownFeature("Harness catalog does not declare question support.", evidence),
      approvals: unknownFeature("Harness catalog does not declare approval support.", evidence),
      serverRequests: unknownFeature("Harness catalog does not declare server request support.", evidence),
    },
    tools: {
      command: capabilities.has("execute")
        ? partialFeature("Harness catalog advertises execution, but command boundaries are adapter-specific.", evidence)
        : unsupportedHarnessFeature("Harness catalog does not advertise execution support.", evidence),
      fileChange: entry.support.files
        ? partialFeature("Harness catalog advertises file support, but read/write boundaries are adapter-specific.", evidence)
        : unsupportedHarnessFeature("Harness catalog does not advertise file support.", evidence),
      subagent: unknownFeature("Harness catalog does not declare subagent support.", evidence),
      mcpStdio: unknownFeature("Harness catalog does not declare MCP stdio support.", evidence),
      mcpSse: unknownFeature("Harness catalog does not declare MCP SSE support.", evidence),
      mcpStreamableHttp: unknownFeature("Harness catalog does not declare MCP streamable HTTP support.", evidence),
    },
    auth: {
      apiKey: authRequirements.some((requirement) => requirement.kind === "env")
        ? supportedFeature("Harness catalog declares environment-based authentication.", evidence)
        : unknownFeature("Harness catalog does not declare environment-based authentication.", evidence),
      authFile: authRequirements.some((requirement) => requirement.kind === "file")
        ? supportedFeature("Harness catalog declares file-based authentication.", evidence)
        : unknownFeature("Harness catalog does not declare file-based authentication.", evidence),
      localLogin: entry.readiness?.loginCommand
        ? supportedFeature("Harness catalog declares a login command.", evidence)
        : unknownFeature("Harness catalog does not declare a login command.", evidence),
    },
    debug: {
      tmuxAttach: unknownFeature("Harness catalog does not declare tmux attach support.", evidence),
      logs: unknownFeature("Harness catalog does not declare log access support.", evidence),
      rawTranscript: unknownFeature("Harness catalog does not declare raw transcript access.", evidence),
    },
  };
}

function makeGenericSource(
  input: RuntimeProviderCatalogInput | RuntimeModelCatalogInput | RuntimeProbeInput | RuntimeAnnotationInput,
  kind: ScoutCapabilityMatrixSource["kind"],
  defaultCapturedAt: number,
): ScoutCapabilityMatrixSource {
  return {
    kind,
    id: input.id,
    name: input.name,
    capturedAt: input.capturedAt ?? defaultCapturedAt,
    raw: input.raw,
  };
}

function supportedFeature(
  reason: string,
  evidence: NonNullable<HarnessFeatureSupport["evidence"]>,
): HarnessFeatureSupport {
  return { level: "yes", reason, evidence, downgrade: "native" };
}

function partialFeature(
  reason: string,
  evidence: NonNullable<HarnessFeatureSupport["evidence"]>,
): HarnessFeatureSupport {
  return { level: "partial", reason, evidence, downgrade: "embedded" };
}

function unknownFeature(
  reason: string,
  evidence: NonNullable<HarnessFeatureSupport["evidence"]>,
): HarnessFeatureSupport {
  return { level: "unknown", reason, evidence };
}
