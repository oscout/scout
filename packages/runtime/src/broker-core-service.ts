import { evaluateScoutCapabilityAvailability } from "@openscout/protocol";
import type {
  AgentBrokerFeed,
  AgentBrokerFeedCounts,
  AgentBrokerFeedEndpointStatus,
  AgentBrokerFeedItem,
  AgentBrokerFeedSeverity,
  AgentDefinition,
  CollaborationRecord,
  ControlCommand,
  DeliveryAttempt,
  DeliveryIntent,
  FlightRecord,
  InvocationRequest,
  MessageRecord,
  NodeDefinition,
  ScoutCapabilityAvailabilityDecision,
  ScoutCapabilityMatrixSnapshot,
  ScoutDeliverRequest,
  ScoutDeliverResponse,
  ScoutDispatchRecord,
  ThreadEventEnvelope,
  ThreadSnapshot,
  ThreadWatchCloseRequest,
  ThreadWatchOpenRequest,
  ThreadWatchOpenResponse,
  ThreadWatchRenewRequest,
  ThreadWatchRenewResponse,
} from "@openscout/protocol";

import type {
  ActiveScoutBrokerService,
  ScoutBrokerActivityQuery,
  ScoutBrokerBuildIdentity,
  ScoutBrokerCapabilitiesQuery,
  ScoutBrokerCapabilityAvailabilityQuery,
  ScoutBrokerChildServiceSnapshots,
  ScoutBrokerCollaborationEventQuery,
  ScoutBrokerCollaborationRecordQuery,
  ScoutBrokerAgentFeedQuery,
  ScoutBrokerMessageQuery,
  ScoutBrokerProjectionStatus,
} from "./broker-api.js";
import { loadOpenScoutRuntimeBuildIdentity } from "./build-info.js";
import { readInvocationLifecycle as readInvocationLifecycleModel } from "./invocation-lifecycle-read-model.js";
import { listBrokerMessages } from "./broker-core-message-read-model.js";
import type { BrokerRouteTargetInput } from "./scout-dispatcher.js";
import { queryRuntimeRegistrySnapshot, type RuntimeRegistrySnapshot } from "./registry.js";
import type { ActivityItem } from "./sqlite-store.js";
import type { BrokerRuntimeCatalogSnapshot } from "./broker-runtime-catalog-service.js";

type BrokerCoreRuntime = {
  snapshot: () => RuntimeRegistrySnapshot;
};

type BrokerCoreProjection = {
  listActivityItems: (options?: {
    limit?: number;
    agentId?: string;
    actorId?: string;
    conversationId?: string;
  }) => Promise<ActivityItem[]>;
};

type BrokerCoreJournal = {
  listCollaborationRecords: (options?: {
    limit?: number;
    kind?: CollaborationRecord["kind"];
    state?: string;
    ownerId?: string;
    nextMoveOwnerId?: string;
  }) => unknown;
  listCollaborationEvents: (options?: {
    limit?: number;
    recordId?: string;
  }) => unknown;
  listDeliveries: (options?: {
    transport?: DeliveryIntent["transport"];
    status?: DeliveryIntent["status"];
    limit?: number;
  }) => DeliveryIntent[];
  listDeliveryAttempts: (deliveryId: string) => DeliveryAttempt[];
  listScoutDispatches: (options?: {
    limit?: number;
    askedLabel?: string;
  }) => ScoutDispatchRecord[];
};

type BrokerCoreThreadEvents = {
  replay: (input: {
    conversationId: string;
    afterSeq: number;
    limit: number;
  }) => Promise<ThreadEventEnvelope[]>;
  snapshot: (conversationId: string) => Promise<ThreadSnapshot>;
  openWatch: (
    request: ThreadWatchOpenRequest,
  ) => Promise<ThreadWatchOpenResponse>;
  renewWatch: (
    request: ThreadWatchRenewRequest,
  ) => Promise<ThreadWatchRenewResponse>;
  closeWatch: (request: ThreadWatchCloseRequest) => Promise<void>;
};

export type BrokerCoreServiceDeps = {
  baseUrl: string;
  nodeId: string;
  meshId: string;
  localNode: NodeDefinition;
  runtime: BrokerCoreRuntime;
  projection: BrokerCoreProjection;
  journal: BrokerCoreJournal;
  threadEvents: BrokerCoreThreadEvents;
  isReconciledStaleFlightActivityItem: (item: ActivityItem) => boolean;
  build?: ScoutBrokerBuildIdentity;
  readChildServices?: () => ScoutBrokerChildServiceSnapshots;
  readProjectionStatus?: () => ScoutBrokerProjectionStatus;
  readHome?: () => Promise<unknown>;
  readCapabilities?: (
    query?: ScoutBrokerCapabilitiesQuery,
  ) => Promise<ScoutCapabilityMatrixSnapshot>;
  readRuntimeCatalog?: (
    query?: ScoutBrokerCapabilitiesQuery,
  ) => Promise<BrokerRuntimeCatalogSnapshot>;
  readCapabilityAvailability?: (
    query: ScoutBrokerCapabilityAvailabilityQuery,
  ) => Promise<ScoutCapabilityAvailabilityDecision>;
  executeCommand: (command: ControlCommand) => Promise<unknown>;
  postConversationMessage?: (message: MessageRecord) => Promise<unknown>;
  deliver?: (
    request: ScoutDeliverRequest,
    options?: { signal?: AbortSignal },
  ) => Promise<ScoutDeliverResponse>;
  invokeAgent?: (
    request: InvocationRequest & BrokerRouteTargetInput,
  ) => Promise<unknown>;
};

function normalizeLimit(limit?: number): number {
  return typeof limit === "number" && Number.isFinite(limit) && limit > 0
    ? Math.min(limit, 500)
    : 100;
}

async function listBrokerActivity(
  projection: BrokerCoreProjection,
  isReconciledStaleFlightActivityItem: (item: ActivityItem) => boolean,
  input: ScoutBrokerActivityQuery,
) {
  const items = await projection.listActivityItems({
    limit: normalizeLimit(input.limit),
    agentId: input.agentId,
    actorId: input.actorId,
    conversationId: input.conversationId,
  });
  return items.filter((item) => !isReconciledStaleFlightActivityItem(item));
}

function listBrokerCollaborationRecords(
  journal: BrokerCoreJournal,
  input: ScoutBrokerCollaborationRecordQuery,
) {
  return journal.listCollaborationRecords({
    limit: normalizeLimit(input.limit),
    kind: input.kind as CollaborationRecord["kind"] | undefined,
    state: input.state,
    ownerId: input.ownerId,
    nextMoveOwnerId: input.nextMoveOwnerId,
  });
}

function listBrokerCollaborationEvents(
  journal: BrokerCoreJournal,
  input: ScoutBrokerCollaborationEventQuery,
) {
  return journal.listCollaborationEvents({
    limit: normalizeLimit(input.limit),
    recordId: input.recordId,
  });
}

function normalizeSince(since?: number | null): number | null {
  return typeof since === "number" && Number.isFinite(since) && since > 0
    ? since
    : null;
}

function compactText(value: string | null | undefined, fallback: string): string {
  const text = value?.replace(/\s+/g, " ").trim();
  if (!text) {
    return fallback;
  }
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

function metadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function metadataNumber(
  metadata: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function metadataBoolean(
  metadata: Record<string, unknown> | undefined,
  key: string,
): boolean {
  return metadata?.[key] === true;
}

function metadataRecord(
  metadata: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const value = metadata?.[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

type BrokerAgentCounts = {
  agents: number;
  agentRecords: number;
  rawAgentRecords: number;
  configuredAgents: number;
  scoutManagedAgents: number;
  currentAgentRegistrations: number;
  localAgentRegistrations: number;
  remoteAgentRegistrations: number;
  staleAgentRegistrations: number;
  retiredAgentRegistrations: number;
  oneTimeAgentCards: number;
  persistentAgentCards: number;
};

function agentCardLifecycleKind(agent: AgentDefinition): "persistent" | "one_time" | null {
  const lifecycle = metadataRecord(agent.metadata, "cardLifecycle");
  const kind = metadataString(lifecycle, "kind");
  return kind === "persistent" || kind === "one_time" ? kind : null;
}

function summarizeBrokerAgentCounts(
  snapshot: RuntimeRegistrySnapshot,
  localNodeId: string,
): BrokerAgentCounts {
  const counts: BrokerAgentCounts = {
    agents: 0,
    agentRecords: 0,
    rawAgentRecords: 0,
    configuredAgents: 0,
    scoutManagedAgents: 0,
    currentAgentRegistrations: 0,
    localAgentRegistrations: 0,
    remoteAgentRegistrations: 0,
    staleAgentRegistrations: 0,
    retiredAgentRegistrations: 0,
    oneTimeAgentCards: 0,
    persistentAgentCards: 0,
  };

  for (const agent of Object.values(snapshot.agents)) {
    counts.agentRecords += 1;
    counts.rawAgentRecords += 1;

    const retired = metadataBoolean(agent.metadata, "retiredFromFleet");
    const stale = metadataBoolean(agent.metadata, "staleLocalRegistration");
    const current = !retired && !stale;
    const local = agent.homeNodeId === localNodeId || agent.authorityNodeId === localNodeId;
    const lifecycleKind = agentCardLifecycleKind(agent);
    const oneTimeCard = lifecycleKind === "one_time";
    const persistentCard = lifecycleKind === "persistent";
    const source = metadataString(agent.metadata, "source");
    const externalSource = metadataString(agent.metadata, "externalSource");
    const registryBacked = source === undefined || source === "relay-agent-registry";
    const durableScoutManaged = source === "scout-managed" && externalSource !== "pairing-session";

    if (retired) {
      counts.retiredAgentRegistrations += 1;
    }
    if (stale) {
      counts.staleAgentRegistrations += 1;
    }
    if (!current) {
      continue;
    }

    counts.currentAgentRegistrations += 1;
    if (local) {
      counts.localAgentRegistrations += 1;
    } else {
      counts.remoteAgentRegistrations += 1;
    }
    if (oneTimeCard) {
      counts.oneTimeAgentCards += 1;
    }
    if (persistentCard) {
      counts.persistentAgentCards += 1;
    }
    if (!local || oneTimeCard) {
      continue;
    }

    if (registryBacked) {
      counts.configuredAgents += 1;
      continue;
    }
    if (durableScoutManaged) {
      counts.scoutManagedAgents += 1;
    }
  }

  counts.agents = counts.configuredAgents + counts.scoutManagedAgents;
  return counts;
}

function messageMentionsAgent(message: MessageRecord, agentId: string): boolean {
  return (
    message.actorId === agentId
    || Boolean(message.mentions?.some((mention) => mention.actorId === agentId))
    || Boolean(message.audience?.notify?.includes(agentId))
    || Boolean(message.audience?.invoke?.includes(agentId))
    || Boolean(message.audience?.visibleTo?.includes(agentId))
  );
}

function flightAt(
  flight: FlightRecord,
  invocation?: InvocationRequest,
): number {
  return flight.completedAt ?? flight.startedAt ?? invocation?.createdAt ?? 0;
}

function flightSeverity(state: string): AgentBrokerFeedSeverity {
  if (state === "failed" || state === "cancelled") {
    return "error";
  }
  if (state === "waiting") {
    return "warning";
  }
  if (state === "queued" || state === "waking" || state === "running") {
    return "status";
  }
  return "info";
}

function deliverySeverity(status: string): AgentBrokerFeedSeverity {
  if (status === "failed" || status === "cancelled") {
    return "error";
  }
  if (status === "deferred" || status === "leased") {
    return "warning";
  }
  if (status === "pending" || status === "accepted" || status === "running" || status === "sent") {
    return "status";
  }
  return "info";
}

function activitySeverity(item: ActivityItem): AgentBrokerFeedSeverity {
  if (item.kind === "ask_failed") {
    return "error";
  }
  const state = typeof item.payload?.["state"] === "string"
    ? item.payload["state"]
    : undefined;
  if (state === "failed" || state === "cancelled") {
    return "error";
  }
  if (state === "waiting" || state === "deferred") {
    return "warning";
  }
  if (
    item.kind === "ask_opened"
    || item.kind === "ask_working"
    || item.kind === "invocation_recorded"
    || item.kind === "flight_updated"
  ) {
    return "status";
  }
  return "info";
}

function activityKind(item: ActivityItem): AgentBrokerFeedItem["kind"] {
  if (item.kind === "invocation_recorded") {
    return "invocation";
  }
  if (item.kind === "flight_updated") {
    return "flight";
  }
  if (
    item.kind === "ask_opened"
    || item.kind === "ask_working"
    || item.kind === "ask_replied"
    || item.kind === "ask_failed"
    || item.kind === "status_message"
    || item.kind === "collaboration_event"
  ) {
    return "status";
  }
  return "message";
}

function activityToFeedItem(item: ActivityItem): AgentBrokerFeedItem {
  const kind = activityKind(item);
  const title = compactText(item.title, kind === "status" ? "Broker status" : "Broker activity");
  return {
    id: item.id,
    kind,
    severity: activitySeverity(item),
    at: item.ts,
    title,
    summary: compactText(item.summary ?? item.title, title),
    agentId: item.agentId,
    actorId: item.actorId,
    targetAgentId: item.counterpartId,
    conversationId: item.conversationId,
    messageId: item.messageId,
    invocationId: item.invocationId,
    flightId: item.flightId,
    status: typeof item.payload?.["state"] === "string"
      ? item.payload["state"]
      : item.kind,
    source: "activity",
    metadata: item.payload,
  };
}

function messageToFeedItem(message: MessageRecord, agentId: string): AgentBrokerFeedItem {
  const failedStatus = message.class === "status" && /failed|timed out|error/i.test(message.body);
  const workingStatus = message.class === "status" && /working|running|waking|queued/i.test(message.body);
  const kind: AgentBrokerFeedItem["kind"] = message.class === "status" ? "status" : "message";
  const title = message.class === "status" ? "Status message" : "Message";
  return {
    id: `message:${message.id}`,
    kind,
    severity: failedStatus ? "error" : workingStatus ? "status" : "info",
    at: message.createdAt,
    title,
    summary: compactText(message.body, title),
    agentId,
    actorId: message.actorId,
    targetAgentId: message.actorId === agentId ? undefined : agentId,
    conversationId: message.conversationId,
    messageId: message.id,
    status: message.class,
    source: "snapshot",
    message,
    metadata: message.metadata,
  };
}

function invocationToFeedItem(invocation: InvocationRequest): AgentBrokerFeedItem {
  return {
    id: `invocation:${invocation.id}`,
    kind: "invocation",
    severity: invocation.ensureAwake ? "status" : "info",
    at: invocation.createdAt,
    title: `Invocation ${invocation.action}`,
    summary: compactText(invocation.task, invocation.action),
    agentId: invocation.targetAgentId,
    actorId: invocation.requesterId,
    targetAgentId: invocation.targetAgentId,
    conversationId: invocation.conversationId,
    messageId: invocation.messageId,
    invocationId: invocation.id,
    status: invocation.action,
    source: "snapshot",
    invocation,
    metadata: invocation.metadata,
  };
}

function flightToFeedItem(
  flight: FlightRecord,
  invocation?: InvocationRequest,
): AgentBrokerFeedItem {
  return {
    id: `flight:${flight.id}`,
    kind: "flight",
    severity: flightSeverity(flight.state),
    at: flightAt(flight, invocation),
    title: `Flight ${flight.state}`,
    summary: compactText(flight.error ?? flight.output ?? flight.summary, flight.state),
    agentId: flight.targetAgentId,
    actorId: flight.requesterId,
    targetAgentId: flight.targetAgentId,
    conversationId: invocation?.conversationId,
    messageId: invocation?.messageId,
    invocationId: flight.invocationId,
    flightId: flight.id,
    status: flight.state,
    source: "snapshot",
    flight,
    metadata: flight.metadata,
  };
}

function deliveryMatchesAgent(
  delivery: DeliveryIntent,
  snapshot: RuntimeRegistrySnapshot,
  agentId: string,
): boolean {
  if (delivery.targetId === agentId) {
    return true;
  }
  const message = delivery.messageId ? snapshot.messages[delivery.messageId] : undefined;
  if (message && messageMentionsAgent(message, agentId)) {
    return true;
  }
  const invocation = delivery.invocationId
    ? snapshot.invocations[delivery.invocationId]
    : undefined;
  return Boolean(invocation && (invocation.requesterId === agentId || invocation.targetAgentId === agentId));
}

function deliveryAt(
  delivery: DeliveryIntent,
  snapshot: RuntimeRegistrySnapshot,
  attempts: DeliveryAttempt[],
): number {
  const latestAttempt = attempts.at(-1)?.createdAt;
  const messageAt = delivery.messageId ? snapshot.messages[delivery.messageId]?.createdAt : undefined;
  const invocationAt = delivery.invocationId ? snapshot.invocations[delivery.invocationId]?.createdAt : undefined;
  return latestAttempt ?? messageAt ?? invocationAt ?? metadataNumber(delivery.metadata, "createdAt") ?? 0;
}

function deliveryToFeedItem(
  delivery: DeliveryIntent,
  snapshot: RuntimeRegistrySnapshot,
  attempts: DeliveryAttempt[],
): AgentBrokerFeedItem {
  const invocation = delivery.invocationId
    ? snapshot.invocations[delivery.invocationId]
    : undefined;
  return {
    id: `delivery:${delivery.id}`,
    kind: "delivery",
    severity: deliverySeverity(delivery.status),
    at: deliveryAt(delivery, snapshot, attempts),
    title: `Delivery ${delivery.status}`,
    summary: compactText(
      metadataString(delivery.metadata, "failureReason")
        ?? metadataString(delivery.metadata, "lastError")
        ?? `${delivery.reason} via ${delivery.transport}`,
      delivery.status,
    ),
    agentId: delivery.targetId,
    targetAgentId: delivery.targetId,
    conversationId: invocation?.conversationId,
    messageId: delivery.messageId,
    invocationId: delivery.invocationId,
    deliveryId: delivery.id,
    status: delivery.status,
    reason: delivery.reason,
    source: "delivery",
    delivery,
    metadata: delivery.metadata,
  };
}

function deliveryAttemptToFeedItem(
  delivery: DeliveryIntent,
  attempt: DeliveryAttempt,
): AgentBrokerFeedItem {
  return {
    id: `delivery_attempt:${attempt.id}`,
    kind: "delivery_attempt",
    severity: attempt.status === "failed" ? "error" : attempt.status === "sent" ? "status" : "info",
    at: attempt.createdAt,
    title: `Delivery attempt ${attempt.status}`,
    summary: compactText(attempt.error ?? attempt.externalRef, attempt.status),
    agentId: delivery.targetId,
    targetAgentId: delivery.targetId,
    messageId: delivery.messageId,
    invocationId: delivery.invocationId,
    deliveryId: delivery.id,
    status: attempt.status,
    reason: delivery.reason,
    source: "delivery",
    deliveryAttempt: attempt,
    metadata: attempt.metadata,
  };
}

function dispatchMatchesAgent(dispatch: ScoutDispatchRecord, agentId: string): boolean {
  return (
    dispatch.requesterId === agentId
    || dispatch.target?.agentId === agentId
    || dispatch.candidates.some((candidate) => candidate.agentId === agentId)
  );
}

function dispatchToFeedItem(dispatch: ScoutDispatchRecord): AgentBrokerFeedItem {
  const targetAgentId = dispatch.target?.agentId ?? dispatch.candidates[0]?.agentId;
  return {
    id: `dispatch:${dispatch.id}`,
    kind: "dispatch",
    severity: dispatch.kind === "unparseable" || dispatch.kind === "unavailable" ? "error" : "warning",
    at: dispatch.dispatchedAt,
    title: `Dispatch ${dispatch.kind}`,
    summary: compactText(dispatch.detail, dispatch.askedLabel),
    agentId: targetAgentId,
    actorId: dispatch.requesterId,
    targetAgentId,
    conversationId: dispatch.conversationId,
    invocationId: dispatch.invocationId,
    dispatchId: dispatch.id,
    status: dispatch.kind,
    reason: dispatch.askedLabel,
    source: "dispatch",
    dispatch,
  };
}

function terminalFlightState(state: string): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}

function visibleDeliveryStatus(status: DeliveryIntent["status"], includeAcknowledged: boolean): boolean {
  if (includeAcknowledged) {
    return true;
  }
  return status !== "acknowledged" && status !== "completed" && status !== "peer_acked";
}

function pendingDeliveryStatus(status: DeliveryIntent["status"]): boolean {
  return status === "pending"
    || status === "accepted"
    || status === "leased"
    || status === "running"
    || status === "deferred"
    || status === "sent";
}

function itemDedupeKey(item: AgentBrokerFeedItem): string {
  if (item.deliveryId && item.kind === "delivery") return `delivery:${item.deliveryId}`;
  if (item.deliveryAttempt?.id) return `delivery_attempt:${item.deliveryAttempt.id}`;
  if (item.dispatchId) return `dispatch:${item.dispatchId}`;
  if (item.flightId) return `flight:${item.flightId}`;
  if (item.invocationId && item.kind === "invocation") return `invocation:${item.invocationId}`;
  if (item.messageId) return `message:${item.messageId}`;
  return item.id;
}

function countFeedItems(items: AgentBrokerFeedItem[]): AgentBrokerFeedCounts {
  return {
    items: items.length,
    messages: items.filter((item) => item.kind === "message").length,
    statuses: items.filter((item) => item.kind === "status").length,
    invocations: items.filter((item) => item.kind === "invocation").length,
    flights: items.filter((item) => item.kind === "flight").length,
    deliveries: items.filter((item) => item.kind === "delivery").length,
    deliveryAttempts: items.filter((item) => item.kind === "delivery_attempt").length,
    dispatches: items.filter((item) => item.kind === "dispatch").length,
    errors: items.filter((item) => item.severity === "error").length,
    warnings: items.filter((item) => item.severity === "warning").length,
  };
}

function endpointStatus(endpoint: RuntimeRegistrySnapshot["endpoints"][string]): AgentBrokerFeedEndpointStatus {
  return {
    id: endpoint.id,
    nodeId: endpoint.nodeId,
    harness: endpoint.harness,
    transport: endpoint.transport,
    state: endpoint.state,
    sessionId: endpoint.sessionId,
    projectRoot: endpoint.projectRoot,
    cwd: endpoint.cwd,
    lastError: metadataString(endpoint.metadata, "lastError"),
    lastFailureStage: metadataString(endpoint.metadata, "lastFailureStage"),
    updatedAt: metadataNumber(endpoint.metadata, "lastFailedAt")
      ?? metadataNumber(endpoint.metadata, "lastSeenAt"),
  };
}

async function readAgentBrokerFeed(
  deps: BrokerCoreServiceDeps,
  input: ScoutBrokerAgentFeedQuery,
): Promise<AgentBrokerFeed> {
  const agentId = input.agentId.trim();
  const limit = normalizeLimit(input.limit);
  const since = normalizeSince(input.since);
  const includeAcknowledged = input.includeAcknowledged === true;
  const sourceLimit = Math.min(Math.max(limit * 4, 100), 500);
  const snapshot = deps.runtime.snapshot();
  const agent = snapshot.agents[agentId];
  const endpoints = Object.values(snapshot.endpoints)
    .filter((endpoint) => endpoint.agentId === agentId)
    .map(endpointStatus);
  const deliveries = deps.journal.listDeliveries({ limit: sourceLimit })
    .filter((delivery) => deliveryMatchesAgent(delivery, snapshot, agentId));
  const visibleDeliveries = deliveries
    .filter((delivery) => visibleDeliveryStatus(delivery.status, includeAcknowledged));
  const items: AgentBrokerFeedItem[] = [];

  for (const flight of Object.values(snapshot.flights)) {
    if (flight.targetAgentId !== agentId && flight.requesterId !== agentId) continue;
    const invocation = snapshot.invocations[flight.invocationId];
    items.push(flightToFeedItem(flight, invocation));
  }

  for (const invocation of Object.values(snapshot.invocations)) {
    if (invocation.targetAgentId !== agentId && invocation.requesterId !== agentId) continue;
    items.push(invocationToFeedItem(invocation));
  }

  for (const message of listBrokerMessages(deps.runtime, {
    participantId: agentId,
    inboxOnly: false,
    since,
    limit: sourceLimit,
  })) {
    items.push(messageToFeedItem(message, agentId));
  }

  for (const activity of await deps.projection.listActivityItems({ agentId, limit: sourceLimit })) {
    items.push(activityToFeedItem(activity));
  }

  for (const delivery of visibleDeliveries) {
    const attempts = deps.journal.listDeliveryAttempts(delivery.id);
    items.push(deliveryToFeedItem(delivery, snapshot, attempts));
    for (const attempt of attempts) {
      if (attempt.status === "failed" || includeAcknowledged) {
        items.push(deliveryAttemptToFeedItem(delivery, attempt));
      }
    }
  }

  for (const dispatch of deps.journal.listScoutDispatches({ limit: sourceLimit })) {
    if (dispatchMatchesAgent(dispatch, agentId)) {
      items.push(dispatchToFeedItem(dispatch));
    }
  }

  const deduped = new Map<string, AgentBrokerFeedItem>();
  for (const item of items) {
    if (since !== null && item.at < since) {
      continue;
    }
    const key = itemDedupeKey(item);
    if (!deduped.has(key)) {
      deduped.set(key, item);
    }
  }
  const sortedItems = [...deduped.values()]
    .sort((left, right) => right.at - left.at || left.id.localeCompare(right.id))
    .slice(0, limit);
  const counts = countFeedItems(sortedItems);
  const activeFlightIds = Object.values(snapshot.flights)
    .filter((flight) =>
      (flight.targetAgentId === agentId || flight.requesterId === agentId)
      && !terminalFlightState(flight.state)
    )
    .map((flight) => flight.id);
  const pendingDeliveryIds = deliveries
    .filter((delivery) => delivery.targetId === agentId && pendingDeliveryStatus(delivery.status))
    .map((delivery) => delivery.id);
  const lastError = sortedItems.find((item) => item.severity === "error")?.summary
    ?? endpoints.find((endpoint) => endpoint.lastError)?.lastError;
  const lastActivityAt = sortedItems[0]?.at;

  return {
    agentId,
    generatedAt: Date.now(),
    since,
    limit,
    cursor: lastActivityAt ?? null,
    status: {
      agentId,
      displayName: agent?.displayName,
      found: Boolean(agent || endpoints.length > 0 || sortedItems.length > 0),
      agentState: endpoints[0]?.state,
      endpoints,
      activeFlightIds,
      pendingDeliveryIds,
      errorCount: counts.errors,
      warningCount: counts.warnings,
      lastError,
      lastActivityAt,
    },
    counts,
    items: sortedItems,
  };
}

export function createBrokerCoreService(
  deps: BrokerCoreServiceDeps,
): ActiveScoutBrokerService {
  const postConversationMessage = deps.postConversationMessage;
  const readCapabilities = deps.readCapabilities;
  const readRuntimeCatalog = deps.readRuntimeCatalog;
  return {
    baseUrl: deps.baseUrl,
    readHealth: async () => {
      const snapshot = deps.runtime.snapshot();
      const agentCounts = summarizeBrokerAgentCounts(snapshot, deps.nodeId);
      return {
        ok: true,
        nodeId: deps.nodeId,
        meshId: deps.meshId,
        build: deps.build ?? loadOpenScoutRuntimeBuildIdentity(),
        services: deps.readChildServices?.(),
        ...(deps.readProjectionStatus
          ? { projection: deps.readProjectionStatus() }
          : {}),
        counts: {
          nodes: Object.keys(snapshot.nodes).length,
          actors: Object.keys(snapshot.actors).length,
          agents: agentCounts.agents,
          agentRecords: agentCounts.agentRecords,
          rawAgentRecords: agentCounts.rawAgentRecords,
          configuredAgents: agentCounts.configuredAgents,
          scoutManagedAgents: agentCounts.scoutManagedAgents,
          currentAgentRegistrations: agentCounts.currentAgentRegistrations,
          localAgentRegistrations: agentCounts.localAgentRegistrations,
          remoteAgentRegistrations: agentCounts.remoteAgentRegistrations,
          staleAgentRegistrations: agentCounts.staleAgentRegistrations,
          retiredAgentRegistrations: agentCounts.retiredAgentRegistrations,
          oneTimeAgentCards: agentCounts.oneTimeAgentCards,
          persistentAgentCards: agentCounts.persistentAgentCards,
          conversations: Object.keys(snapshot.conversations).length,
          messages: Object.keys(snapshot.messages).length,
          flights: Object.keys(snapshot.flights).length,
          collaborationRecords: Object.keys(snapshot.collaborationRecords)
            .length,
        },
      };
    },
    readHome: deps.readHome,
    readNode: async () => deps.localNode,
    readSnapshot: async (query) => queryRuntimeRegistrySnapshot(deps.runtime.snapshot(), query),
    ...(readRuntimeCatalog
      ? { readRuntimeCatalog: async (query) => await readRuntimeCatalog(query) }
      : {}),
    ...(readCapabilities
      ? {
          readCapabilities: async (query) => await readCapabilities(query),
          readCapabilityAvailability: async (query) =>
            deps.readCapabilityAvailability
              ? await deps.readCapabilityAvailability(query)
              : evaluateScoutCapabilityAvailability(
                  await readCapabilities({ force: query.force }),
                  {
                    capabilityId: query.capabilityId,
                    methodName: query.methodName,
                    requireReady: query.requireReady,
                  },
                ),
        }
      : {}),
    readMessages: async (query) => listBrokerMessages(deps.runtime, query),
    readActivity: async (query) =>
      await listBrokerActivity(
        deps.projection,
        deps.isReconciledStaleFlightActivityItem,
        query,
      ),
    readCollaborationRecords: async (query) =>
      listBrokerCollaborationRecords(deps.journal, query),
    readCollaborationEvents: async (query) =>
      listBrokerCollaborationEvents(deps.journal, query),
    readAgentBrokerFeed: async (query) =>
      await readAgentBrokerFeed(deps, query),
    readInvocationLifecycle: async (query) =>
      readInvocationLifecycleModel({
        snapshot: deps.runtime.snapshot(),
        invocationId: query.invocationId,
      }),
    readThreadEvents: async (query) =>
      await deps.threadEvents.replay({
        conversationId: query.conversationId,
        afterSeq: query.afterSeq ?? 0,
        limit: normalizeLimit(query.limit),
      }),
    readThreadSnapshot: async (conversationId) =>
      await deps.threadEvents.snapshot(conversationId),
    openThreadWatch: async (request) => await deps.threadEvents.openWatch(request),
    renewThreadWatch: async (request) =>
      await deps.threadEvents.renewWatch(request),
    closeThreadWatch: async (request) => {
      await deps.threadEvents.closeWatch(request);
      return { ok: true, watchId: request.watchId };
    },
    executeCommand: deps.executeCommand,
    postConversationMessage: postConversationMessage
      ? async (message) => await postConversationMessage(message)
      : async (message) =>
        await deps.executeCommand({ kind: "conversation.post", message }),
    deliver: deps.deliver,
    invokeAgent: deps.invokeAgent,
  };
}
