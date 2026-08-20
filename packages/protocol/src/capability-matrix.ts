import type { AgentHarness } from "./actors.js";
import type { MetadataMap, ScoutId } from "./common.js";
import type { HarnessFeatureSupportMap } from "./harness-feature-support.js";

export type ScoutCapabilityProviderKind =
  | "broker"
  | "mcp"
  | "harness"
  | "shell"
  | "app_connector"
  | "extension_pack"
  | "remote_peer"
  | "provider"
  | "model"
  | "runtime_probe";

export type ScoutCapabilitySourceKind =
  | "broker"
  | "mcp_server"
  | "harness_adapter"
  | "provider_catalog"
  | "model_catalog"
  | "project_manifest"
  | "extension_pack"
  | "runtime_probe"
  | "observed_execution"
  | "human_annotation";

export type ScoutCapabilityEvidenceKind =
  | "protocol_discovery"
  | "adapter_report"
  | "catalog"
  | "project_manifest"
  | "extension_pack"
  | "runtime_probe"
  | "observed_execution"
  | "human_annotation"
  | "upstream";

export type ScoutCapabilityEvidenceTrust =
  | "verified"
  | "observed"
  | "declared"
  | "advisory"
  | "unknown";

export interface ScoutCapabilityEvidence {
  kind: ScoutCapabilityEvidenceKind;
  ref: string;
  sourceId?: string;
  observedAt?: number;
  protocol?: string;
  protocolVersion?: string;
  trust?: ScoutCapabilityEvidenceTrust;
  metadata?: MetadataMap;
}

export interface ScoutCapabilityScope {
  projectRoot?: string;
  workspaceRoot?: string;
  agentId?: ScoutId;
  sessionId?: ScoutId;
  harness?: AgentHarness | (string & {});
  machineId?: ScoutId;
  permissionProfile?: string;
  channelId?: ScoutId;
  environmentId?: ScoutId;
}

export type ScoutCapabilityEffect =
  | "read"
  | "write"
  | "execute"
  | "network"
  | "notify"
  | "admin"
  | "unknown";

export interface ScoutCapabilityMethodHints {
  readOnly?: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  openWorld?: boolean;
  annotationsTrusted?: boolean;
}

export interface ScoutCapabilityMethod {
  name: string;
  displayName?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  effects: ScoutCapabilityEffect[];
  idempotent?: boolean;
  requiresApproval?: boolean;
  hints?: ScoutCapabilityMethodHints;
  metadata?: MetadataMap;
}

export type ScoutCapabilityReadinessState =
  | "ready"
  | "degraded"
  | "missing"
  | "disabled"
  | "unknown";

export interface ScoutCapabilityReadiness {
  state: ScoutCapabilityReadinessState;
  detail?: string;
  checkedAt?: number;
  missing?: string[];
  evidence?: ScoutCapabilityEvidence[];
}

export type ScoutCapabilityEnforcementLevel =
  | "broker_native"
  | "mcp_server"
  | "harness_native"
  | "sandbox_native"
  | "container"
  | "remote_authority"
  | "advisory"
  | "unknown";

export type ScoutCapabilityPolicyTrust =
  | "enforced"
  | "declared"
  | "advisory"
  | "unknown";

export interface ScoutCapabilityEnforcement {
  level: ScoutCapabilityEnforcementLevel;
  trust: ScoutCapabilityPolicyTrust;
  reason?: string;
}

export interface ScoutCapabilityProvenance {
  sourceKind: ScoutCapabilitySourceKind;
  sourceId: string;
  sourceName?: string;
  capturedAt: number;
  protocol?: string;
  protocolVersion?: string;
  evidence?: ScoutCapabilityEvidence[];
}

export interface ScoutCapabilityDefinition {
  id: ScoutId;
  name: string;
  displayName: string;
  description?: string;
  provider: ScoutCapabilityProviderKind;
  providerId?: string;
  methods: ScoutCapabilityMethod[];
  scope?: ScoutCapabilityScope;
  readiness: ScoutCapabilityReadiness;
  enforcement: ScoutCapabilityEnforcement;
  provenance: ScoutCapabilityProvenance;
  enabled: boolean;
  version?: string;
  metadata?: MetadataMap;
}

export interface ScoutCapabilityMatrixSource {
  kind: ScoutCapabilitySourceKind;
  id: string;
  name?: string;
  capturedAt: number;
  protocol?: string;
  protocolVersion?: string;
  raw?: unknown;
  metadata?: MetadataMap;
}

export interface ScoutCapabilityMatrixSnapshot {
  generatedAt: number;
  scope?: ScoutCapabilityScope;
  sources: ScoutCapabilityMatrixSource[];
  capabilities: ScoutCapabilityDefinition[];
  harnessSupport?: Record<string, HarnessFeatureSupportMap>;
  warnings: string[];
}

export interface McpServerCapabilities {
  tools?: { listChanged?: boolean; [key: string]: unknown } | boolean;
  resources?: { subscribe?: boolean; listChanged?: boolean; [key: string]: unknown } | boolean;
  prompts?: { listChanged?: boolean; [key: string]: unknown } | boolean;
  logging?: Record<string, unknown> | boolean;
  completions?: Record<string, unknown> | boolean;
  tasks?: Record<string, unknown> | boolean;
  [key: string]: unknown;
}

export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  [key: string]: unknown;
}

export interface McpToolDefinition {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: McpToolAnnotations;
  icons?: unknown[];
  _meta?: MetadataMap;
  [key: string]: unknown;
}

export interface McpToolsListResult {
  tools?: readonly McpToolDefinition[];
  nextCursor?: string;
  [key: string]: unknown;
}

export interface NormalizeMcpToolsOptions {
  serverId: string;
  serverName?: string;
  protocolVersion?: string;
  capturedAt?: number;
  scope?: ScoutCapabilityScope;
  serverCapabilities?: McpServerCapabilities;
  tools: readonly McpToolDefinition[] | McpToolsListResult;
  enabled?: boolean;
  readiness?: Partial<ScoutCapabilityReadiness>;
}

export type ScoutModelModality =
  | "text"
  | "image"
  | "audio"
  | "video"
  | "file"
  | "embedding"
  | "unknown";

export interface ScoutModelFeatureSupport {
  streaming?: boolean;
  toolCalling?: boolean;
  structuredOutput?: boolean;
  embeddings?: boolean;
  usageTelemetry?: boolean;
}

export interface ScoutModelCatalogEntry {
  providerId: string;
  modelId: string;
  displayName?: string;
  inputModalities?: ScoutModelModality[];
  outputModalities?: ScoutModelModality[];
  features?: ScoutModelFeatureSupport;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  metadata?: MetadataMap;
}

export interface NormalizeModelCatalogOptions {
  sourceId: string;
  sourceName?: string;
  capturedAt?: number;
  scope?: ScoutCapabilityScope;
  models: readonly ScoutModelCatalogEntry[];
  enabled?: boolean;
}

export type ScoutCapabilityAvailabilityDecision =
  | {
      decision: "allow";
      capabilityId: ScoutId;
      methodName: string;
      reason: string;
    }
  | {
      decision: "deny";
      capabilityId?: ScoutId;
      methodName?: string;
      reason:
        | "capability_missing"
        | "capability_disabled"
        | "method_missing"
        | "readiness_missing"
        | "readiness_disabled";
      detail: string;
    }
  | {
      decision: "require_approval";
      capabilityId: ScoutId;
      methodName: string;
      reason: "method_requires_approval";
      detail: string;
    }
  | {
      decision: "downgrade";
      capabilityId: ScoutId;
      methodName: string;
      reason: "readiness_degraded";
      detail: string;
    }
  | {
      decision: "unknown";
      capabilityId: ScoutId;
      methodName: string;
      reason: "readiness_unknown";
      detail: string;
    };

export interface EvaluateScoutCapabilityAvailabilityOptions {
  capabilityId: ScoutId;
  methodName?: string;
  requireReady?: boolean;
}

export function makeMcpToolCapabilityId(serverId: string, toolName: string): ScoutId {
  return `cap:mcp:${encodeURIComponent(serverId)}:tool:${encodeURIComponent(toolName)}`;
}

export function makeModelCapabilityId(providerId: string, modelId: string): ScoutId {
  return `cap:model:${encodeURIComponent(providerId)}:${encodeURIComponent(modelId)}`;
}

export function inferMcpToolEffects(annotations: McpToolAnnotations | undefined): ScoutCapabilityEffect[] {
  const effects: ScoutCapabilityEffect[] = [];
  if (annotations?.readOnlyHint === true) {
    effects.push("read");
  }
  if (annotations?.destructiveHint === true) {
    effects.push("write");
  }
  if (annotations?.openWorldHint === true) {
    effects.push("network");
  }
  return effects.length > 0 ? effects : ["unknown"];
}

export function normalizeMcpToolsToScoutCapabilities(options: NormalizeMcpToolsOptions): ScoutCapabilityDefinition[] {
  const capturedAt = options.capturedAt ?? Date.now();
  const tools = getMcpToolDefinitions(options.tools);
  const evidence = buildMcpDiscoveryEvidence(options, capturedAt);

  return tools
    .filter((tool) => typeof tool.name === "string" && tool.name.trim().length > 0)
    .map((tool) => {
      const toolName = tool.name.trim();
      const annotations = tool.annotations;
      const effects = inferMcpToolEffects(annotations);
      const methodHints = buildMcpMethodHints(annotations);
      const readinessEvidence = [
        evidence,
        ...(options.readiness?.evidence ?? []),
      ];

      return {
        id: makeMcpToolCapabilityId(options.serverId, toolName),
        name: `mcp.${options.serverId}.${toolName}`,
        displayName: tool.title ?? annotations?.title ?? toolName,
        description: tool.description,
        provider: "mcp",
        providerId: options.serverId,
        methods: [{
          name: "call",
          displayName: tool.title ?? annotations?.title ?? toolName,
          description: tool.description,
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema,
          effects,
          idempotent: inferMcpIdempotence(annotations),
          requiresApproval: annotations?.destructiveHint === true ? true : undefined,
          hints: methodHints,
          metadata: {
            mcpToolName: toolName,
          },
        }],
        scope: options.scope,
        readiness: {
          state: "unknown",
          detail: "Discovered from MCP tools/list; runtime readiness has not been probed.",
          checkedAt: capturedAt,
          ...options.readiness,
          evidence: readinessEvidence,
        },
        enforcement: {
          level: "mcp_server",
          trust: "advisory",
          reason: "MCP tool metadata and annotations are advisory; Scout policy still decides availability.",
        },
        provenance: {
          sourceKind: "mcp_server",
          sourceId: options.serverId,
          sourceName: options.serverName,
          capturedAt,
          protocol: "mcp",
          protocolVersion: options.protocolVersion,
          evidence: [evidence],
        },
        enabled: options.enabled ?? true,
        metadata: {
          mcpServerCapabilities: options.serverCapabilities,
          mcpTool: {
            name: toolName,
            icons: tool.icons,
            meta: tool._meta,
          },
        },
      } satisfies ScoutCapabilityDefinition;
    });
}

export function buildMcpCapabilityMatrixSnapshot(options: NormalizeMcpToolsOptions): ScoutCapabilityMatrixSnapshot {
  const generatedAt = options.capturedAt ?? Date.now();
  const capabilities = normalizeMcpToolsToScoutCapabilities({
    ...options,
    capturedAt: generatedAt,
  });

  return {
    generatedAt,
    scope: options.scope,
    sources: [{
      kind: "mcp_server",
      id: options.serverId,
      name: options.serverName,
      capturedAt: generatedAt,
      protocol: "mcp",
      protocolVersion: options.protocolVersion,
      raw: {
        capabilities: options.serverCapabilities,
        tools: options.tools,
      },
    }],
    capabilities,
    warnings: [],
  };
}

export function normalizeModelCatalogToScoutCapabilities(
  options: NormalizeModelCatalogOptions,
): ScoutCapabilityDefinition[] {
  const capturedAt = options.capturedAt ?? Date.now();
  const evidence = {
    kind: "catalog" as const,
    ref: `model-catalog:${options.sourceId}`,
    sourceId: options.sourceId,
    observedAt: capturedAt,
    trust: "declared" as const,
  };

  return options.models
    .filter((model) => model.providerId.trim() && model.modelId.trim())
    .map((model) => {
      const providerId = model.providerId.trim();
      const modelId = model.modelId.trim();
      return {
        id: makeModelCapabilityId(providerId, modelId),
        name: `model.${providerId}.${modelId}`,
        displayName: model.displayName ?? modelId,
        provider: "model",
        providerId,
        methods: [{
          name: "invoke",
          displayName: "Invoke model",
          effects: ["execute"],
          metadata: {
            inputModalities: model.inputModalities ?? ["unknown"],
            outputModalities: model.outputModalities ?? ["unknown"],
            features: model.features ?? {},
            contextWindowTokens: model.contextWindowTokens,
            maxOutputTokens: model.maxOutputTokens,
          },
        }],
        scope: options.scope,
        readiness: {
          state: "unknown",
          detail: "Declared by model catalog; provider readiness has not been probed.",
          checkedAt: capturedAt,
          evidence: [evidence],
        },
        enforcement: {
          level: "remote_authority",
          trust: "declared",
          reason: "Model metadata is catalog-declared; Scout must still verify provider readiness and policy.",
        },
        provenance: {
          sourceKind: "model_catalog",
          sourceId: options.sourceId,
          sourceName: options.sourceName,
          capturedAt,
          evidence: [evidence],
        },
        enabled: options.enabled ?? true,
        metadata: {
          model: {
            providerId,
            modelId,
            inputModalities: model.inputModalities ?? ["unknown"],
            outputModalities: model.outputModalities ?? ["unknown"],
            features: model.features ?? {},
            contextWindowTokens: model.contextWindowTokens,
            maxOutputTokens: model.maxOutputTokens,
            metadata: model.metadata,
          },
        },
      } satisfies ScoutCapabilityDefinition;
    });
}

export function evaluateScoutCapabilityAvailability(
  snapshot: ScoutCapabilityMatrixSnapshot,
  options: EvaluateScoutCapabilityAvailabilityOptions,
): ScoutCapabilityAvailabilityDecision {
  const capability = snapshot.capabilities.find((candidate) => candidate.id === options.capabilityId);
  if (!capability) {
    return {
      decision: "deny",
      capabilityId: options.capabilityId,
      reason: "capability_missing",
      detail: "Capability is not present in the current matrix snapshot.",
    };
  }
  if (!capability.enabled) {
    return {
      decision: "deny",
      capabilityId: capability.id,
      reason: "capability_disabled",
      detail: "Capability is disabled in the current matrix snapshot.",
    };
  }

  const methodName = options.methodName ?? capability.methods[0]?.name;
  const method = methodName ? capability.methods.find((candidate) => candidate.name === methodName) : undefined;
  if (!methodName || !method) {
    return {
      decision: "deny",
      capabilityId: capability.id,
      methodName,
      reason: "method_missing",
      detail: "Requested method is not present on the capability.",
    };
  }
  if (method.requiresApproval) {
    return {
      decision: "require_approval",
      capabilityId: capability.id,
      methodName,
      reason: "method_requires_approval",
      detail: "Capability method requires operator approval before execution.",
    };
  }

  switch (capability.readiness.state) {
    case "ready":
      return {
        decision: "allow",
        capabilityId: capability.id,
        methodName,
        reason: "Capability is ready.",
      };
    case "degraded":
      return {
        decision: "downgrade",
        capabilityId: capability.id,
        methodName,
        reason: "readiness_degraded",
        detail: capability.readiness.detail ?? "Capability readiness is degraded.",
      };
    case "missing":
      return {
        decision: "deny",
        capabilityId: capability.id,
        methodName,
        reason: "readiness_missing",
        detail: capability.readiness.detail ?? "Capability readiness is missing.",
      };
    case "disabled":
      return {
        decision: "deny",
        capabilityId: capability.id,
        methodName,
        reason: "readiness_disabled",
        detail: capability.readiness.detail ?? "Capability readiness is disabled.",
      };
    case "unknown":
      if (options.requireReady === false) {
        return {
          decision: "allow",
          capabilityId: capability.id,
          methodName,
          reason: "Capability readiness is unknown but this check does not require ready state.",
        };
      }
      return {
        decision: "unknown",
        capabilityId: capability.id,
        methodName,
        reason: "readiness_unknown",
        detail: capability.readiness.detail ?? "Capability readiness is unknown.",
      };
  }
}

function getMcpToolDefinitions(tools: NormalizeMcpToolsOptions["tools"]): readonly McpToolDefinition[] {
  return isMcpToolDefinitionArray(tools) ? tools : tools.tools ?? [];
}

function isMcpToolDefinitionArray(
  value: NormalizeMcpToolsOptions["tools"],
): value is readonly McpToolDefinition[] {
  return Array.isArray(value);
}

function buildMcpDiscoveryEvidence(
  options: Pick<NormalizeMcpToolsOptions, "serverId" | "protocolVersion">,
  observedAt: number,
): ScoutCapabilityEvidence {
  return {
    kind: "protocol_discovery",
    ref: `mcp:${options.serverId}:tools/list`,
    sourceId: options.serverId,
    observedAt,
    protocol: "mcp",
    protocolVersion: options.protocolVersion,
    trust: "declared",
  };
}

function buildMcpMethodHints(annotations: McpToolAnnotations | undefined): ScoutCapabilityMethodHints | undefined {
  if (!annotations) {
    return undefined;
  }
  return {
    readOnly: annotations.readOnlyHint,
    destructive: annotations.destructiveHint,
    idempotent: annotations.idempotentHint,
    openWorld: annotations.openWorldHint,
    annotationsTrusted: false,
  };
}

function inferMcpIdempotence(annotations: McpToolAnnotations | undefined): boolean | undefined {
  if (annotations?.idempotentHint !== undefined) {
    return annotations.idempotentHint;
  }
  return annotations?.readOnlyHint === true ? true : undefined;
}
