import type {
  ActorIdentity,
  AgentDefinition,
  AgentEndpoint,
  CollaborationRecord,
  ConversationBinding,
  ConversationDefinition,
  FlightRecord,
  InvocationRequest,
  MessageRecord,
  ConversationReadCursor,
} from "@openscout/protocol";
import type { NodeDefinition } from "@openscout/protocol";

export interface RuntimeRegistrySnapshot {
  nodes: Record<string, NodeDefinition>;
  actors: Record<string, ActorIdentity>;
  agents: Record<string, AgentDefinition>;
  endpoints: Record<string, AgentEndpoint>;
  conversations: Record<string, ConversationDefinition>;
  bindings: Record<string, ConversationBinding>;
  messages: Record<string, MessageRecord>;
  readCursors: Record<string, ConversationReadCursor>;
  invocations: Record<string, InvocationRequest>;
  flights: Record<string, FlightRecord>;
  collaborationRecords: Record<string, CollaborationRecord>;
}

export interface RuntimeRegistrySnapshotQuery {
  since?: number | null;
}

export function createRuntimeRegistrySnapshot(
  value: Partial<RuntimeRegistrySnapshot> = {},
): RuntimeRegistrySnapshot {
  return {
    nodes: value.nodes ?? {},
    actors: value.actors ?? {},
    agents: value.agents ?? {},
    endpoints: value.endpoints ?? {},
    conversations: value.conversations ?? {},
    bindings: value.bindings ?? {},
    messages: value.messages ?? {},
    readCursors: value.readCursors ?? {},
    invocations: value.invocations ?? {},
    flights: value.flights ?? {},
    collaborationRecords: value.collaborationRecords ?? {},
  };
}

const ACTIVE_FLIGHT_STATES = new Set(["queued", "waking", "running", "waiting"]);
const TERMINAL_COLLABORATION_STATES = new Set(["done", "cancelled", "closed", "declined"]);
const SNAPSHOT_TIMESTAMP_KEYS = [
  "createdAt",
  "updatedAt",
  "startedAt",
  "completedAt",
  "lastSeenAt",
  "registeredAt",
  "staleAt",
  "retiredAt",
  "lastStartedAt",
  "lastCompletedAt",
  "lastFailedAt",
] as const;

function finiteTimestamp(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function recordTimestamp(value: { metadata?: Record<string, unknown> }): number {
  const record = value as object as Record<string, unknown>;
  let latest = 0;
  for (const key of SNAPSHOT_TIMESTAMP_KEYS) {
    latest = Math.max(
      latest,
      finiteTimestamp(record[key]) ?? 0,
      finiteTimestamp(value.metadata?.[key]) ?? 0,
    );
  }
  return latest;
}

function recordById<T extends { id: string }>(values: Iterable<T>): Record<string, T> {
  return Object.fromEntries([...values].map((value) => [value.id, value]));
}

function currentAgent(agent: AgentDefinition): boolean {
  return agent.metadata?.staleLocalRegistration !== true
    && agent.metadata?.retiredFromFleet !== true;
}

function currentOrRecentEndpoint(endpoint: AgentEndpoint, since: number): boolean {
  return endpoint.metadata?.staleLocalRegistration !== true
    && (endpoint.state !== "offline" || recordTimestamp(endpoint) >= since);
}

function activeCollaboration(record: CollaborationRecord): boolean {
  return !TERMINAL_COLLABORATION_STATES.has(record.state);
}

/**
 * Return a coherent working-set view of the registry from a cutoff timestamp.
 * Current routable agents/endpoints are retained regardless of age; historical
 * coordination records are bounded and their referenced actors/conversations
 * are pulled in to keep the result usable without loading lifetime history.
 */
export function queryRuntimeRegistrySnapshot(
  snapshot: RuntimeRegistrySnapshot,
  query: RuntimeRegistrySnapshotQuery = {},
): RuntimeRegistrySnapshot {
  const since = finiteTimestamp(query.since);
  if (since === null) {
    return snapshot;
  }

  const messages = Object.values(snapshot.messages)
    .filter((message) => message.createdAt >= since);
  const recentInvocationIds = new Set(
    Object.values(snapshot.invocations)
      .filter((invocation) => invocation.createdAt >= since)
      .map((invocation) => invocation.id),
  );
  const flights = Object.values(snapshot.flights)
    .filter((flight) =>
      ACTIVE_FLIGHT_STATES.has(flight.state)
      || recordTimestamp(flight) >= since
      || recentInvocationIds.has(flight.invocationId)
    );
  const retainedInvocationIds = new Set([
    ...recentInvocationIds,
    ...flights.map((flight) => flight.invocationId),
  ]);
  const invocations = Object.values(snapshot.invocations)
    .filter((invocation) => retainedInvocationIds.has(invocation.id));
  const collaborationRecords = Object.values(snapshot.collaborationRecords)
    .filter((record) => activeCollaboration(record) || record.updatedAt >= since);

  const conversationIds = new Set<string>();
  for (const message of messages) conversationIds.add(message.conversationId);
  for (const invocation of invocations) {
    if (invocation.conversationId) conversationIds.add(invocation.conversationId);
  }
  for (const record of collaborationRecords) {
    if (record.conversationId) conversationIds.add(record.conversationId);
  }
  for (const conversation of Object.values(snapshot.conversations)) {
    // Records written before timestamps were stamped carry no timestamp at
    // all; treating them as "unknown age" keeps them visible instead of
    // silently dropping them from every incremental snapshot.
    const timestamp = recordTimestamp(conversation);
    if (timestamp === 0 || timestamp >= since) conversationIds.add(conversation.id);
  }

  const conversations: ConversationDefinition[] = [];
  const pendingConversationIds = [...conversationIds];
  while (pendingConversationIds.length > 0) {
    const conversationId = pendingConversationIds.pop()!;
    const conversation = snapshot.conversations[conversationId];
    if (!conversation || conversations.some((candidate) => candidate.id === conversationId)) continue;
    conversations.push(conversation);
    if (conversation.parentConversationId && !conversationIds.has(conversation.parentConversationId)) {
      conversationIds.add(conversation.parentConversationId);
      pendingConversationIds.push(conversation.parentConversationId);
    }
  }

  const actorIds = new Set<string>();
  const agentIds = new Set<string>();
  for (const agent of Object.values(snapshot.agents)) {
    if (currentAgent(agent)) agentIds.add(agent.id);
  }
  const endpoints = Object.values(snapshot.endpoints)
    .filter((endpoint) => currentOrRecentEndpoint(endpoint, since));
  for (const endpoint of endpoints) agentIds.add(endpoint.agentId);
  for (const message of messages) actorIds.add(message.actorId);
  for (const invocation of invocations) {
    actorIds.add(invocation.requesterId);
    agentIds.add(invocation.targetAgentId);
  }
  for (const flight of flights) {
    actorIds.add(flight.requesterId);
    agentIds.add(flight.targetAgentId);
  }
  for (const record of collaborationRecords) {
    actorIds.add(record.createdById);
    if (record.ownerId) actorIds.add(record.ownerId);
    if (record.nextMoveOwnerId) actorIds.add(record.nextMoveOwnerId);
  }
  for (const conversation of conversations) {
    for (const participantId of conversation.participantIds) actorIds.add(participantId);
  }
  for (const agentId of agentIds) actorIds.add(agentId);

  const agents = Object.values(snapshot.agents)
    .filter((agent) => agentIds.has(agent.id) || actorIds.has(agent.id));
  for (const agent of agents) {
    agentIds.add(agent.id);
    actorIds.add(agent.id);
    if (agent.ownerId) actorIds.add(agent.ownerId);
  }

  return createRuntimeRegistrySnapshot({
    nodes: snapshot.nodes,
    actors: recordById(Object.values(snapshot.actors).filter((actor) => actorIds.has(actor.id))),
    agents: recordById(agents),
    endpoints: recordById(endpoints.filter((endpoint) => agentIds.has(endpoint.agentId))),
    conversations: recordById(conversations),
    bindings: recordById(
      Object.values(snapshot.bindings).filter((binding) => conversationIds.has(binding.conversationId)),
    ),
    messages: recordById(messages),
    readCursors: Object.fromEntries(
      Object.entries(snapshot.readCursors)
        .filter(([, cursor]) => conversationIds.has(cursor.conversationId)),
    ),
    invocations: recordById(invocations),
    flights: recordById(flights),
    collaborationRecords: recordById(collaborationRecords),
  });
}
