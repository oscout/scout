import { basename } from "node:path";
import {
  channelNaturalKeyFromMetadata,
  directChannelNaturalKey,
  epochMs,
  type AgentEndpoint,
} from "@openscout/protocol";
import { endpointMetadataRecord, selectPreferredAgentEndpoint, type EndpointPreference } from "./core/agent-endpoints.ts";
import { resolveTerminalSurface } from "./core/terminal-surfaces.ts";
import type { WebAgent } from "./db-queries.ts";
import { compact as compactPath, resolveHarnessSessionIdForAgent } from "./db/internal/paths.ts";
import type { ScoutBrokerContext } from "./core/broker/service.ts";
import {
  recordInput,
  firstMetadataString,
  ACTIVE_BROKER_FLIGHT_STATES,
  metadataRecordValue,
} from "./web-flights.ts";
import {
  metadataTimestampMs,
  metadataStringValue,
  metadataBooleanValue,
  metadataStringArrayValue,
  metadataRecordArrayValue,
} from "./metadata-values.ts";

export function agentEndpointMetadata(endpoint: AgentEndpoint | null | undefined): Record<string, unknown> {
  return endpointMetadataRecord(endpoint);
}

export function activeEndpointForAgent(
  snapshot: { endpoints?: Record<string, AgentEndpoint> },
  agentId: string,
  preference?: EndpointPreference,
): AgentEndpoint | null {
  return selectPreferredAgentEndpoint(snapshot, agentId, preference);
}

export function isBrokerAgentVisibleInWeb(agent: ScoutBrokerContext["snapshot"]["agents"][string]): boolean {
  const metadata = recordInput(agent.metadata);
  return metadataBooleanValue(metadata, "brokerRegistered")
    && !metadataBooleanValue(metadata, "staleLocalRegistration")
    && !metadataBooleanValue(metadata, "retiredFromFleet");
}

export function latestBrokerAgentTimestamp(
  agent: ScoutBrokerContext["snapshot"]["agents"][string],
  endpoint: AgentEndpoint | null,
): number | null {
  const agentMetadata = recordInput(agent.metadata);
  const endpointMetadata = agentEndpointMetadata(endpoint);
  const timestamps = [
    agentMetadata?.createdAt,
    agentMetadata?.registeredAt,
    agentMetadata?.updatedAt,
    endpointMetadata.lastSeenAt,
    endpointMetadata.lastEnsuredAt,
    endpointMetadata.startedAt,
    endpointMetadata.lastStartedAt,
    endpointMetadata.lastCompletedAt,
    endpointMetadata.lastFailedAt,
  ].map(metadataTimestampMs).filter((value): value is number => value !== undefined);
  return timestamps.length > 0 ? Math.max(...timestamps) : null;
}

export function brokerAgentFlightPhase(
  broker: ScoutBrokerContext,
  agentId: string,
): "in_turn" | "in_flight" | null {
  let phase: "in_turn" | "in_flight" | null = null;
  for (const flight of Object.values(broker.snapshot.flights ?? {})) {
    if (flight.targetAgentId !== agentId || !ACTIVE_BROKER_FLIGHT_STATES.has(flight.state)) {
      continue;
    }
    if (flight.state === "running") {
      return "in_turn";
    }
    phase = "in_flight";
  }
  return phase;
}

export function summarizeBrokerAgentState(
  agent: ScoutBrokerContext["snapshot"]["agents"][string],
  endpoint: AgentEndpoint | null,
  flightPhase: "in_turn" | "in_flight" | null,
): string {
  if (flightPhase === "in_turn") {
    return "working";
  }
  if (flightPhase === "in_flight") {
    return "in_flight";
  }
  void agent;
  void endpoint;
  return "available";
}

export function brokerNodeName(
  broker: ScoutBrokerContext,
  nodeId: string | null | undefined,
): string | null {
  if (!nodeId) {
    return null;
  }
  return broker.snapshot.nodes?.[nodeId]?.name ?? null;
}

export function brokerActorDisplay(
  broker: ScoutBrokerContext,
  actorId: string | null | undefined,
): { name: string | null; handle: string | null } {
  const actor = actorId ? broker.snapshot.actors?.[actorId] : null;
  return {
    name: actor?.displayName ?? null,
    handle: actor?.handle ?? null,
  };
}

export function projectNameFromRoot(path: string | null): string | null {
  const normalized = path?.trim();
  return normalized ? basename(normalized) : null;
}

export function brokerAgentCapabilitiesForWeb(
  agent: ScoutBrokerContext["snapshot"]["agents"][string],
  metadata: Record<string, unknown> | null,
): string[] {
  const explicit = Array.isArray(agent.capabilities)
    ? agent.capabilities.map((capability) => String(capability).trim()).filter(Boolean)
    : [];
  if (explicit.length > 0) {
    return explicit;
  }
  const metadataCapabilities = metadataStringArrayValue(metadata, "capabilities");
  return metadataCapabilities.length > 0 ? metadataCapabilities : ["chat", "invoke"];
}

export function brokerAgentCardMetadata(
  metadata: Record<string, unknown> | null,
): Record<string, unknown> | null {
  return metadataRecordValue(metadata, "a2aAgentCard")
    ?? metadataRecordValue(metadata, "agentCard");
}

export function brokerAgentProvider(
  metadata: Record<string, unknown> | null,
  card: Record<string, unknown> | null,
): { name: string | null; url: string | null } {
  const provider = metadataRecordValue(card, "provider")
    ?? metadataRecordValue(metadata, "provider");
  return {
    name: firstMetadataString(
      metadataStringValue(provider, "organization"),
      metadataStringValue(provider, "name"),
      metadataStringValue(metadata, "providerName"),
    ),
    url: firstMetadataString(
      metadataStringValue(provider, "url"),
      metadataStringValue(metadata, "providerUrl"),
    ),
  };
}

export function brokerAgentProtocol(
  metadata: Record<string, unknown> | null,
  endpointMetadata: Record<string, unknown>,
): string | null {
  const supportedInterfaces = metadataRecordArrayValue(metadata, "supportedInterfaces")
    .concat(metadataRecordArrayValue(endpointMetadata, "supportedInterfaces"));
  const protocol = firstMetadataString(
    ...supportedInterfaces.map((entry) => metadataStringValue(entry, "protocol")),
    metadataStringValue(metadata, "protocol"),
    metadataStringValue(endpointMetadata, "protocol"),
  );
  if (protocol?.toLowerCase() === "a2a" || metadataStringValue(metadata, "a2aExecutionUrl")) {
    return "A2A";
  }
  return protocol;
}

export function brokerAgentSkillNames(
  metadata: Record<string, unknown> | null,
  card: Record<string, unknown> | null,
): string[] {
  const skills = metadataRecordArrayValue(card, "skills")
    .concat(metadataRecordArrayValue(metadata, "skills"));
  return Array.from(new Set(
    skills
      .map((skill) => firstMetadataString(
        metadataStringValue(skill, "name"),
        metadataStringValue(skill, "id"),
      ))
      .filter((skill): skill is string => Boolean(skill)),
  ));
}

export function brokerAgentAuthorityProfile(
  metadata: Record<string, unknown> | null,
): WebAgent["authorityProfile"] {
  const roleConfig = metadataRecordValue(metadata, "roleConfig");
  const grants = metadataRecordValue(roleConfig, "grants");
  const roleId = metadataStringValue(roleConfig, "roleId");
  if (!roleId || !grants) return null;
  return {
    roleId,
    readTools: metadataStringArrayValue(grants, "read"),
    writeTools: metadataStringArrayValue(grants, "write"),
    shell: grants.shell === true,
    codebaseWrites: grants.codebaseWrites === true,
  };
}

export function brokerAgentRuntimePolicy(
  endpointMetadata: Record<string, unknown>,
): WebAgent["runtimePolicy"] {
  const approvalPolicy = metadataStringValue(endpointMetadata, "approvalPolicy");
  const sandbox = metadataStringValue(endpointMetadata, "sandbox");
  const shellTool = typeof endpointMetadata.shellTool === "boolean"
    ? endpointMetadata.shellTool
    : null;
  return approvalPolicy || sandbox || shellTool !== null
    ? { approvalPolicy, sandbox, shellTool }
    : null;
}

export function brokerAgentActivity(
  broker: ScoutBrokerContext,
  agentId: string,
): NonNullable<WebAgent["brokerActivity"]> {
  const activity: NonNullable<WebAgent["brokerActivity"]> = [];
  for (const message of Object.values(broker.snapshot.messages ?? {})) {
    if (message.actorId !== agentId) continue;
    const at = epochMs(message.createdAt);
    if (!at) continue;
    activity.push({
      id: message.id,
      kind: "message",
      at,
      state: null,
      summary: message.body.trim() || "Message sent",
      conversationId: message.conversationId ?? null,
    });
  }
  for (const invocation of Object.values(broker.snapshot.invocations ?? {})) {
    if (invocation.targetAgentId !== agentId) continue;
    const at = epochMs(invocation.createdAt);
    if (!at) continue;
    activity.push({
      id: invocation.id,
      kind: "invocation",
      at,
      state: null,
      summary: invocation.task?.trim() || invocation.action || "Invocation received",
      conversationId: invocation.conversationId ?? null,
    });
  }
  for (const flight of Object.values(broker.snapshot.flights ?? {})) {
    if (flight.targetAgentId !== agentId) continue;
    const invocation = broker.snapshot.invocations?.[flight.invocationId];
    const at = epochMs(flight.completedAt)
      ?? epochMs(flight.startedAt)
      ?? epochMs(invocation?.createdAt);
    if (!at) continue;
    activity.push({
      id: flight.id,
      kind: "flight",
      at,
      state: flight.state,
      summary: flight.summary?.trim() || invocation?.task?.trim() || `Flight ${flight.state}`,
      conversationId: invocation?.conversationId ?? null,
    });
  }
  return activity
    .sort((left, right) => left.at - right.at || left.id.localeCompare(right.id))
    .slice(-80);
}

export function brokerDirectConversationIdForAgent(
  broker: ScoutBrokerContext,
  agentId: string,
): string | null {
  const naturalKey = directChannelNaturalKey(["operator", agentId]);
  const conversation = Object.values(broker.snapshot.conversations ?? {}).find(
    (candidate) => channelNaturalKeyFromMetadata(candidate.metadata) === naturalKey,
  );
  return conversation?.id ?? null;
}

export function brokerAgentCardToWebAgent(
  broker: ScoutBrokerContext,
  agent: ScoutBrokerContext["snapshot"]["agents"][string],
): WebAgent | null {
  if (!isBrokerAgentVisibleInWeb(agent)) {
    return null;
  }

  const endpoint = activeEndpointForAgent(broker.snapshot, agent.id);
  const agentMetadata = recordInput(agent.metadata);
  const endpointMetadata = agentEndpointMetadata(endpoint);
  const cardMetadata = brokerAgentCardMetadata(agentMetadata);
  const provider = brokerAgentProvider(agentMetadata, cardMetadata);
  const protocol = brokerAgentProtocol(agentMetadata, endpointMetadata);
  const skills = brokerAgentSkillNames(agentMetadata, cardMetadata);
  const projectRoot = firstMetadataString(
    endpoint?.projectRoot,
    metadataStringValue(endpointMetadata, "projectRoot"),
    metadataStringValue(agentMetadata, "projectRoot"),
  );
  const cwd = firstMetadataString(
    endpoint?.cwd,
    metadataStringValue(endpointMetadata, "currentDirectory"),
    metadataStringValue(endpointMetadata, "cwd"),
    metadataStringValue(agentMetadata, "currentDirectory"),
    metadataStringValue(agentMetadata, "cwd"),
    projectRoot,
  );
  const owner = brokerActorDisplay(broker, agent.ownerId);
  const brokerActivity = brokerAgentActivity(broker, agent.id);
  const createdAt = metadataTimestampMs(agentMetadata?.createdAt)
    ?? metadataTimestampMs(agentMetadata?.registeredAt)
    ?? null;
  const updatedAt = Math.max(
    latestBrokerAgentTimestamp(agent, endpoint) ?? 0,
    brokerActivity.at(-1)?.at ?? 0,
    createdAt ?? 0,
  ) || null;

  return {
    id: agent.id,
    definitionId: agent.definitionId,
    name: agent.displayName,
    handle: agent.handle ?? null,
    agentClass: agent.agentClass,
    harness: endpoint?.harness ?? metadataStringValue(agentMetadata, "harness"),
    state: summarizeBrokerAgentState(agent, endpoint, brokerAgentFlightPhase(broker, agent.id)),
    projectRoot: compactPath(projectRoot),
    cwd: compactPath(cwd),
    updatedAt,
    createdAt,
    transport: endpoint?.transport ?? metadataStringValue(agentMetadata, "transport"),
    selector: agent.selector ?? metadataStringValue(agentMetadata, "selector"),
    defaultSelector: agent.defaultSelector ?? metadataStringValue(agentMetadata, "defaultSelector"),
    nodeQualifier: agent.nodeQualifier ?? metadataStringValue(agentMetadata, "nodeQualifier"),
    workspaceQualifier: agent.workspaceQualifier ?? metadataStringValue(agentMetadata, "workspaceQualifier"),
    wakePolicy: agent.wakePolicy,
    capabilities: brokerAgentCapabilitiesForWeb(agent, agentMetadata),
    project: metadataStringValue(agentMetadata, "project") ?? projectNameFromRoot(projectRoot),
    branch: metadataStringValue(agentMetadata, "branch") ?? metadataStringValue(endpointMetadata, "branch"),
    role: metadataStringValue(agentMetadata, "role"),
    model: metadataStringValue(endpointMetadata, "model") ?? metadataStringValue(agentMetadata, "model"),
    modelProvider: metadataStringValue(endpointMetadata, "provider") ?? metadataStringValue(agentMetadata, "provider"),
    harnessSessionId: resolveHarnessSessionIdForAgent(
      endpoint?.transport ?? metadataStringValue(agentMetadata, "transport"),
      endpoint?.sessionId ?? null,
      {
        ...agentMetadata,
        ...endpointMetadata,
      },
      summarizeBrokerAgentState(agent, endpoint, brokerAgentFlightPhase(broker, agent.id)),
    ),
    terminalSurface: resolveTerminalSurface({
      transport: endpoint?.transport ?? metadataStringValue(agentMetadata, "transport"),
      endpointSessionId: endpoint?.sessionId ?? null,
      metadata: {
        ...agentMetadata,
        ...endpointMetadata,
      },
    }),
    harnessLogPath: null,
    conversationId: brokerDirectConversationIdForAgent(broker, agent.id),
    authorityNodeId: agent.authorityNodeId ?? null,
    authorityNodeName: brokerNodeName(broker, agent.authorityNodeId),
    homeNodeId: agent.homeNodeId ?? null,
    homeNodeName: brokerNodeName(broker, agent.homeNodeId),
    ownerId: agent.ownerId ?? null,
    ownerName: owner.name,
    ownerHandle: owner.handle,
    staleLocalRegistration: metadataBooleanValue(agentMetadata, "staleLocalRegistration"),
    retiredFromFleet: metadataBooleanValue(agentMetadata, "retiredFromFleet"),
    replacedByAgentId: metadataStringValue(agentMetadata, "replacedByAgentId"),
    providerName: provider.name,
    providerUrl: provider.url,
    protocol,
    skills,
    brokerActivity,
    authorityProfile: brokerAgentAuthorityProfile(agentMetadata),
    runtimePolicy: brokerAgentRuntimePolicy(endpointMetadata),
  };
}

export function brokerCardAgentsForWeb(broker: ScoutBrokerContext): WebAgent[] {
  return Object.values(broker.snapshot.agents ?? {})
    .map((agent) => brokerAgentCardToWebAgent(broker, agent))
    .filter((agent): agent is WebAgent => Boolean(agent))
    .sort((left, right) =>
      (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
      || left.name.localeCompare(right.name),
    );
}

export function mergeBrokerAgentProjection(local: WebAgent, broker: WebAgent | undefined): WebAgent {
  if (!broker) return local;
  return {
    ...broker,
    ...local,
    // Broker flights own work lifecycle. A local endpoint can remain `active`
    // for the lifetime of an attached harness session, so its projected
    // `working` value must not outlive the completed flight in list views.
    state: broker.state,
    ...(broker.transport === "tmux" ? {
      harnessSessionId: broker.harnessSessionId,
      harnessLogPath: broker.harnessLogPath,
    } : {}),
    updatedAt: Math.max(local.updatedAt ?? 0, broker.updatedAt ?? 0) || null,
    role: local.role ?? broker.role,
    brokerActivity: broker.brokerActivity,
    authorityProfile: broker.authorityProfile,
    runtimePolicy: broker.runtimePolicy,
  };
}
