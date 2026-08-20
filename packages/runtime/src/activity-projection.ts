import type {
  CollaborationRecord,
  FlightRecord,
  InvocationRequest,
  MessageRecord,
  ObservedStatusProjection,
  ScoutActivityEvent,
  ScoutActivityEventKind,
  ScoutActivityMotionLevel,
  ScoutActivitySourceKind,
  ScoutActivitySourceRef,
  ScoutActivityWorkSummary,
  ScoutAgentActivitySummary,
  ScoutFleetActivitySummary,
  ScoutId,
} from "@openscout/protocol";
import { collaborationRequesterId } from "@openscout/protocol";

import type { RuntimeRegistrySnapshot } from "./registry.js";
import { projectObservedStatusForAgent } from "./observed-status-projection.js";

export interface ActivityProjectionOptions {
  now?: number;
  staleAfterMs?: number;
  operatorId?: ScoutId;
  latestEventsLimit?: number;
}

export type ActivityProjectionSnapshot = Pick<
  RuntimeRegistrySnapshot,
  "agents" | "endpoints" | "invocations" | "flights" | "collaborationRecords" | "messages"
>;

const DEFAULT_LATEST_EVENTS_LIMIT = 8;

export function projectAgentActivityFromRuntimeSnapshot(
  snapshot: ActivityProjectionSnapshot,
  agentId: ScoutId,
  options: ActivityProjectionOptions = {},
): ScoutAgentActivitySummary {
  const status = projectObservedStatusForAgent(snapshot, agentId, options);
  const latestEvents = collectActivityEventsForAgent(snapshot, agentId, options.latestEventsLimit);
  const latestEvent = latestEvents[0];
  const updatedAt = Math.max(
    status.updatedAt,
    latestEvent?.at ?? 0,
  );

  return {
    agentId,
    displayName: snapshot.agents[agentId]?.displayName,
    phase: status.phase,
    activity: status.activity,
    motion: motionForObservedStatus(status),
    needsYou: false,
    currentWork: currentWorkForAgent(snapshot, agentId, status),
    latestEvent,
    updatedAt,
    staleAt: status.staleAt,
    status,
  };
}

export function projectFleetActivityFromRuntimeSnapshot(
  snapshot: ActivityProjectionSnapshot,
  options: ActivityProjectionOptions = {},
): ScoutFleetActivitySummary {
  const latestEventsLimit = options.latestEventsLimit ?? DEFAULT_LATEST_EVENTS_LIMIT;
  const agentIds = collectActivityAgentIds(snapshot);
  const agents = agentIds
    .map((agentId) => projectAgentActivityFromRuntimeSnapshot(snapshot, agentId, options))
    .sort(compareAgentSummaries);
  const latestEvents = collectFleetActivityEvents(snapshot, agentIds, latestEventsLimit);
  const currentlyWorking = agents.filter((agent) => agent.motion === "high" || agent.motion === "medium");
  const needsYou = agents.filter((agent) => agent.needsYou);
  const activeCount = agents.filter((agent) => agent.motion !== "none").length;
  const updatedAt = Math.max(
    options.now ?? Date.now(),
    latestEvents[0]?.at ?? 0,
    ...agents.map((agent) => agent.updatedAt),
  );
  const workingCount = currentlyWorking.length;
  const needsYouCount = needsYou.length;

  return {
    totalAgents: agents.length,
    workingCount,
    needsYouCount,
    activeCount,
    quietCount: agents.length - activeCount,
    updatedAt,
    agents,
    currentlyWorking,
    needsYou,
    latestEvents,
    digest: buildFleetDigest({
      activeCount,
      latestEvent: latestEvents[0],
      needsYou,
      needsYouCount,
      updatedAt,
      workingCount,
    }),
  };
}

export function collectActivityEventsForAgent(
  snapshot: ActivityProjectionSnapshot,
  agentId: ScoutId,
  limit = DEFAULT_LATEST_EVENTS_LIMIT,
): ScoutActivityEvent[] {
  const events: ScoutActivityEvent[] = [];
  const flightsByInvocationId = groupFlightsByInvocationId(snapshot.flights);

  for (const flight of Object.values(snapshot.flights)) {
    if (flight.targetAgentId !== agentId) continue;
    events.push(flightActivityEvent(flight, snapshot.invocations[flight.invocationId]));
  }

  for (const invocation of Object.values(snapshot.invocations)) {
    if (invocation.targetAgentId !== agentId) continue;
    if (flightsByInvocationId.has(invocation.id)) continue;
    events.push(invocationActivityEvent(invocation));
  }

  for (const record of Object.values(snapshot.collaborationRecords)) {
    if (!collaborationTouchesAgent(record, agentId)) continue;
    events.push(collaborationActivityEvent(record, agentId));
  }

  for (const message of Object.values(snapshot.messages)) {
    if (!messageTouchesAgent(message, agentId)) continue;
    events.push(messageActivityEvent(message, agentId));
  }

  return events
    .sort(compareEvents)
    .slice(0, limit);
}

function collectActivityAgentIds(snapshot: ActivityProjectionSnapshot): ScoutId[] {
  const agentIds = new Set<ScoutId>(Object.keys(snapshot.agents));

  for (const endpoint of Object.values(snapshot.endpoints)) {
    agentIds.add(endpoint.agentId);
  }
  for (const invocation of Object.values(snapshot.invocations)) {
    agentIds.add(invocation.targetAgentId);
  }
  for (const flight of Object.values(snapshot.flights)) {
    agentIds.add(flight.targetAgentId);
  }
  for (const record of Object.values(snapshot.collaborationRecords)) {
    if (record.ownerId) agentIds.add(record.ownerId);
    if (record.nextMoveOwnerId) agentIds.add(record.nextMoveOwnerId);
    // requestedById (work item) / askedById (question) — questions must appear too.
    const requesterId = collaborationRequesterId(record);
    if (requesterId) {
      agentIds.add(requesterId);
    }
  }
  for (const message of Object.values(snapshot.messages)) {
    if (snapshot.agents[message.actorId]) agentIds.add(message.actorId);
    for (const mention of message.mentions ?? []) {
      if (snapshot.agents[mention.actorId]) agentIds.add(mention.actorId);
    }
    for (const invoked of message.audience?.invoke ?? []) {
      if (snapshot.agents[invoked]) agentIds.add(invoked);
    }
  }

  return [...agentIds].sort();
}

function collectFleetActivityEvents(
  snapshot: ActivityProjectionSnapshot,
  agentIds: ScoutId[],
  limit: number,
): ScoutActivityEvent[] {
  const eventsById = new Map<string, ScoutActivityEvent>();
  for (const agentId of agentIds) {
    for (const event of collectActivityEventsForAgent(snapshot, agentId, limit)) {
      if (!eventsById.has(event.id)) {
        eventsById.set(event.id, event);
      }
    }
  }
  return [...eventsById.values()].sort(compareEvents).slice(0, limit);
}

function currentWorkForAgent(
  snapshot: ActivityProjectionSnapshot,
  agentId: ScoutId,
  status: ObservedStatusProjection,
): ScoutActivityWorkSummary | undefined {
  if (status.detail?.title || status.detail?.summary) {
    return {
      title: status.detail.title,
      summary: status.detail.summary,
      source: sourceForObservedStatus(status),
    };
  }

  const latestFlight = latestFlightForAgent(snapshot, agentId);
  if (latestFlight) {
    const invocation = snapshot.invocations[latestFlight.invocationId];
    return {
      title: invocation?.task,
      summary: latestFlight.summary ?? latestFlight.output ?? latestFlight.error,
      source: { kind: "flight", refId: latestFlight.id },
    };
  }

  return undefined;
}

function motionForObservedStatus(status: ObservedStatusProjection): ScoutActivityMotionLevel {
  switch (status.activity) {
    case "thinking":
    case "executing":
    case "working":
    case "waking":
      return "high";
    case "queued":
    case "review":
      return "medium";
    case "waiting_for_input":
    case "waiting_on_actor":
    case "blocked":
    case "stalled":
      return "blocked";
    case "completed":
    case "failed":
    case "cancelled":
      return "low";
    case "idle":
    case "offline":
    case "unknown":
    default:
      return "none";
  }
}

function buildFleetDigest(input: {
  activeCount: number;
  latestEvent?: ScoutActivityEvent;
  needsYou: ScoutAgentActivitySummary[];
  needsYouCount: number;
  updatedAt: number;
  workingCount: number;
}) {
  if (input.needsYouCount > 0) {
    const first = input.needsYou[0];
    return {
      label: "Needs you",
      summary: input.needsYouCount === 1
        ? `${agentLabel(first)} is waiting`
        : `${input.needsYouCount} agents are waiting`,
      motion: "blocked" as const,
      updatedAt: input.updatedAt,
      needsYouCount: input.needsYouCount,
      workingCount: input.workingCount,
      latestEvent: input.latestEvent,
    };
  }

  if (input.workingCount > 0) {
    return {
      label: "In motion",
      summary: input.workingCount === 1
        ? "1 agent is working"
        : `${input.workingCount} agents are working`,
      motion: "high" as const,
      updatedAt: input.updatedAt,
      needsYouCount: 0,
      workingCount: input.workingCount,
      latestEvent: input.latestEvent,
    };
  }

  if (input.activeCount > 0) {
    return {
      label: "Settling",
      summary: input.activeCount === 1
        ? "1 recent agent update"
        : `${input.activeCount} recent agent updates`,
      motion: "low" as const,
      updatedAt: input.updatedAt,
      needsYouCount: 0,
      workingCount: 0,
      latestEvent: input.latestEvent,
    };
  }

  return {
    label: "Quiet",
    summary: "No active agent work",
    motion: "none" as const,
    updatedAt: input.updatedAt,
    needsYouCount: 0,
    workingCount: 0,
    latestEvent: input.latestEvent,
  };
}

function flightActivityEvent(
  flight: FlightRecord,
  invocation: InvocationRequest | undefined,
): ScoutActivityEvent {
  const at = flight.completedAt ?? flight.startedAt ?? invocation?.createdAt ?? 0;
  return {
    id: `flight:${flight.id}`,
    kind: flightEventKind(flight),
    agentId: flight.targetAgentId,
    sessionId: sessionIdForFlight(flight, invocation),
    conversationId: invocation?.conversationId,
    title: invocation?.task,
    summary: flight.summary ?? flight.output ?? flight.error ?? `Flight ${flight.state}`,
    at,
    severity: flight.state === "failed" ? "critical" : undefined,
    source: { kind: "flight", refId: flight.id },
    metadata: {
      flightState: flight.state,
      invocationId: flight.invocationId,
    },
  };
}

function invocationActivityEvent(invocation: InvocationRequest): ScoutActivityEvent {
  return {
    id: `invocation:${invocation.id}`,
    kind: "invocation",
    agentId: invocation.targetAgentId,
    sessionId: invocation.execution?.targetSessionId ?? invocation.execution?.forkFromSessionId,
    conversationId: invocation.conversationId,
    title: invocation.task,
    summary: `Invocation ${invocation.action}`,
    at: invocation.createdAt,
    source: { kind: "invocation", refId: invocation.id },
    metadata: {
      action: invocation.action,
    },
  };
}

function collaborationActivityEvent(record: CollaborationRecord, agentId: ScoutId): ScoutActivityEvent {
  const summary = record.kind === "work_item"
    ? record.progress?.summary ?? record.summary ?? `Work item ${record.state}`
    : record.summary ?? `Question ${record.state}`;

  return {
    id: `collaboration:${record.id}`,
    kind: record.kind,
    agentId,
    conversationId: record.conversationId,
    title: record.title,
    summary,
    at: record.updatedAt,
    severity: record.priority === "urgent" ? "critical" : record.priority === "high" ? "warning" : undefined,
    source: { kind: record.kind, refId: record.id },
    metadata: {
      state: record.state,
      priority: record.priority,
    },
  };
}

function messageActivityEvent(message: MessageRecord, agentId: ScoutId): ScoutActivityEvent {
  return {
    id: `message:${message.id}`,
    kind: "message",
    agentId,
    conversationId: message.conversationId,
    title: message.actorId === agentId ? "Agent message" : "Message",
    summary: truncateSummary(message.body),
    at: message.createdAt,
    source: { kind: "message", refId: message.id },
    metadata: {
      actorId: message.actorId,
      class: message.class,
    },
  };
}

function flightEventKind(flight: FlightRecord): ScoutActivityEventKind {
  switch (flight.state) {
    case "completed":
      return "result";
    case "failed":
      return "error";
    default:
      return "flight";
  }
}

function collaborationTouchesAgent(record: CollaborationRecord, agentId: ScoutId): boolean {
  if (record.ownerId === agentId || record.nextMoveOwnerId === agentId || record.createdById === agentId) {
    return true;
  }
  // requestedById (work item) / askedById (question).
  return collaborationRequesterId(record) === agentId;
}

function messageTouchesAgent(message: MessageRecord, agentId: ScoutId): boolean {
  if (message.actorId === agentId) return true;
  if (message.mentions?.some((mention) => mention.actorId === agentId)) return true;
  if (message.audience?.invoke?.includes(agentId)) return true;
  if (message.audience?.notify?.includes(agentId)) return true;
  return false;
}

function latestFlightForAgent(
  snapshot: Pick<ActivityProjectionSnapshot, "invocations" | "flights">,
  agentId: ScoutId,
): FlightRecord | undefined {
  return Object.values(snapshot.flights)
    .filter((flight) => flight.targetAgentId === agentId)
    .sort((left, right) => flightUpdatedAt(right, snapshot.invocations[right.invocationId]) -
      flightUpdatedAt(left, snapshot.invocations[left.invocationId]))[0];
}

function flightUpdatedAt(flight: FlightRecord, invocation: InvocationRequest | undefined): number {
  return flight.completedAt ?? flight.startedAt ?? invocation?.createdAt ?? 0;
}

function sourceForObservedStatus(status: ObservedStatusProjection): ScoutActivitySourceRef | undefined {
  const provenance = status.provenance[0];
  if (!provenance) return undefined;
  return {
    kind: statusSourceKind(status),
    refId: provenance.refId,
  };
}

function statusSourceKind(status: ObservedStatusProjection): ScoutActivitySourceKind {
  switch (status.subjectKind) {
    case "endpoint":
      return "endpoint";
    case "flight":
      return "flight";
    case "question":
      return "question";
    case "work_item":
      return "work_item";
    case "tail_session":
      return "tail_event";
    default:
      return "observed_status";
  }
}

function sessionIdForFlight(
  flight: FlightRecord,
  invocation: InvocationRequest | undefined,
): ScoutId | undefined {
  const metadataSessionId = flight.metadata?.sessionId;
  if (typeof metadataSessionId === "string") return metadataSessionId;
  return invocation?.execution?.targetSessionId ?? invocation?.execution?.forkFromSessionId;
}

function groupFlightsByInvocationId(flights: Record<string, FlightRecord>): Set<ScoutId> {
  const ids = new Set<ScoutId>();
  for (const flight of Object.values(flights)) {
    ids.add(flight.invocationId);
  }
  return ids;
}

function compareEvents(left: ScoutActivityEvent, right: ScoutActivityEvent): number {
  return right.at - left.at || left.id.localeCompare(right.id);
}

function compareAgentSummaries(left: ScoutAgentActivitySummary, right: ScoutAgentActivitySummary): number {
  return Number(right.needsYou) - Number(left.needsYou)
    || motionRank(right.motion) - motionRank(left.motion)
    || right.updatedAt - left.updatedAt
    || agentLabel(left).localeCompare(agentLabel(right));
}

function motionRank(motion: ScoutActivityMotionLevel): number {
  switch (motion) {
    case "blocked":
      return 50;
    case "high":
      return 40;
    case "medium":
      return 30;
    case "low":
      return 20;
    case "none":
    default:
      return 0;
  }
}

function agentLabel(agent: Pick<ScoutAgentActivitySummary, "agentId" | "displayName"> | undefined): string {
  return agent?.displayName ?? agent?.agentId ?? "Agent";
}

function truncateSummary(value: string, maxLength = 140): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3)}...`;
}
