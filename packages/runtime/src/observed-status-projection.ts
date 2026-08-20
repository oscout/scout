import type {
  AgentEndpoint,
  CollaborationRecord,
  FlightRecord,
  InvocationRequest,
  ObservedActivity,
  ObservedStatusPhase,
  ObservedStatusProjection,
  QuestionRecord,
  ScoutId,
  StatusProjectionProvenance,
  WorkItemRecord,
} from "@openscout/protocol";

import type { RuntimeRegistrySnapshot } from "./registry.js";

export interface ObservedStatusProjectionOptions {
  now?: number;
  staleAfterMs?: number;
}

type StatusCandidate = ObservedStatusProjection & {
  rank: number;
};

const DEFAULT_STALE_AFTER_MS = 90_000;

export function projectObservedStatusForAgent(
  snapshot: Pick<RuntimeRegistrySnapshot, "agents" | "endpoints" | "invocations" | "flights" | "collaborationRecords">,
  agentId: ScoutId,
  options: ObservedStatusProjectionOptions = {},
): ObservedStatusProjection {
  const now = options.now ?? Date.now();
  const candidates: StatusCandidate[] = [];

  for (const endpoint of Object.values(snapshot.endpoints)) {
    if (endpoint.agentId === agentId) {
      candidates.push(projectEndpointStatus(endpoint, now, options));
    }
  }

  const latestFlight = latestFlightForAgent(snapshot, agentId);
  if (latestFlight) {
    const invocation = snapshot.invocations[latestFlight.invocationId];
    candidates.push(projectFlightStatus(latestFlight, invocation, now));
  }

  const latestCollaboration = latestCollaborationForAgent(snapshot, agentId);
  if (latestCollaboration) {
    candidates.push(projectCollaborationStatus(latestCollaboration, agentId));
  }

  if (candidates.length === 0) {
    return stripRank({
      subjectKind: "agent",
      subjectId: agentId,
      agentId,
      phase: snapshot.agents[agentId] ? "registered" : "unknown",
      activity: "unknown",
      provenance: [],
      confidence: snapshot.agents[agentId] ? 0.7 : 0.3,
      updatedAt: now,
      rank: snapshot.agents[agentId] ? 15 : 0,
    });
  }

  candidates.sort(compareCandidates);
  return stripRank(candidates[0]!);
}

export function projectObservedStatusesFromRuntimeSnapshot(
  snapshot: Pick<RuntimeRegistrySnapshot, "agents" | "endpoints" | "invocations" | "flights" | "collaborationRecords">,
  options: ObservedStatusProjectionOptions = {},
): ObservedStatusProjection[] {
  const agentIds = new Set<ScoutId>(Object.keys(snapshot.agents));
  for (const endpoint of Object.values(snapshot.endpoints)) {
    agentIds.add(endpoint.agentId);
  }
  for (const invocation of Object.values(snapshot.invocations)) {
    agentIds.add(invocation.targetAgentId);
  }
  for (const record of Object.values(snapshot.collaborationRecords)) {
    if (record.ownerId) agentIds.add(record.ownerId);
    if (record.nextMoveOwnerId) agentIds.add(record.nextMoveOwnerId);
  }

  return [...agentIds]
    .sort()
    .map((agentId) => projectObservedStatusForAgent(snapshot, agentId, options));
}

function projectEndpointStatus(
  endpoint: AgentEndpoint,
  now: number,
  options: ObservedStatusProjectionOptions,
): StatusCandidate {
  let phase: ObservedStatusPhase = "running";
  let activity: ObservedActivity = "idle";
  let rank = 20;
  let confidence = 0.82;
  const updatedAt = endpointTimestamp(endpoint) ?? now;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const staleAt = endpoint.state === "offline" ? undefined : updatedAt + staleAfterMs;
  const isStale = endpoint.state !== "offline" && updatedAt + staleAfterMs <= now;
  const provenance: StatusProjectionProvenance[] = [
    {
      source: "endpoint",
      refId: endpoint.id,
      observedAt: updatedAt,
      confidence,
    },
  ];

  if (isStale) {
    phase = "running";
    activity = "stalled";
    rank = 35;
    confidence = 0.58;
    provenance.push({
      source: "staleness_inference",
      refId: endpoint.id,
      observedAt: now,
      confidence,
    });
  } else {
    switch (endpoint.state) {
      case "offline":
        phase = "stopped";
        activity = "offline";
        rank = 10;
        break;
      case "active":
        activity = "working";
        rank = 35;
        break;
      case "waiting":
        activity = "waiting_for_input";
        rank = 45;
        break;
      case "idle":
      default:
        activity = "idle";
        rank = 20;
        break;
    }
  }

  return {
    subjectKind: "endpoint",
    subjectId: endpoint.id,
    agentId: endpoint.agentId,
    phase,
    activity,
    detail: endpoint.address ? { summary: endpoint.address } : undefined,
    provenance,
    confidence,
    updatedAt,
    staleAt,
    rank,
  };
}

function projectFlightStatus(
  flight: FlightRecord,
  invocation: InvocationRequest | undefined,
  now: number,
): StatusCandidate {
  const updatedAt = flight.completedAt ?? flight.startedAt ?? invocation?.createdAt ?? now;
  const phaseByState: Record<FlightRecord["state"], ObservedStatusPhase> = {
    queued: "registered",
    waking: "starting",
    running: "running",
    waiting: "running",
    completed: "running",
    failed: "error",
    cancelled: "stopped",
  };
  const activityByState: Record<FlightRecord["state"], ObservedActivity> = {
    queued: "queued",
    waking: "waking",
    running: "working",
    waiting: "waiting_for_input",
    completed: "completed",
    failed: "failed",
    cancelled: "cancelled",
  };
  const rankByState: Record<FlightRecord["state"], number> = {
    queued: 70,
    waking: 72,
    running: 80,
    waiting: 90,
    completed: 50,
    failed: 50,
    cancelled: 50,
  };

  return {
    subjectKind: "flight",
    subjectId: flight.id,
    agentId: flight.targetAgentId,
    phase: phaseByState[flight.state],
    activity: activityByState[flight.state],
    detail: {
      title: invocation?.task,
      summary: flight.summary ?? flight.output ?? flight.error,
    },
    provenance: [{
      source: "flight",
      refId: flight.id,
      observedAt: updatedAt,
      confidence: 0.96,
    }],
    confidence: 0.96,
    updatedAt,
    rank: rankByState[flight.state],
  };
}

function projectCollaborationStatus(record: CollaborationRecord, agentId: ScoutId): StatusCandidate {
  return record.kind === "question"
    ? projectQuestionStatus(record, agentId)
    : projectWorkItemStatus(record, agentId);
}

function projectQuestionStatus(record: QuestionRecord, agentId: ScoutId): StatusCandidate {
  // Questions ride slightly below the work-item equivalents: an unanswered question
  // still needs a reply, but a work item's waiting/review states rank higher.
  const stateMap: Record<QuestionRecord["state"], {
    phase: ObservedStatusPhase;
    activity: ObservedActivity;
    rank: number;
  }> = {
    open: { phase: "registered", activity: "waiting_for_input", rank: 60 },
    answered: { phase: "running", activity: "review", rank: 58 },
    closed: { phase: "running", activity: "completed", rank: 40 },
    declined: { phase: "stopped", activity: "cancelled", rank: 40 },
  };
  const mapped = stateMap[record.state];

  return {
    subjectKind: "question",
    subjectId: record.id,
    agentId,
    phase: mapped.phase,
    activity: mapped.activity,
    detail: {
      title: record.title,
      summary: record.answer ?? record.summary,
    },
    provenance: collaborationProvenance(record, 0.95),
    confidence: 0.95,
    updatedAt: record.updatedAt,
    rank: mapped.rank,
  };
}

function projectWorkItemStatus(record: WorkItemRecord, agentId: ScoutId): StatusCandidate {
  const waitingActivity = workItemWaitingActivity(record);
  const stateMap: Record<WorkItemRecord["state"], {
    phase: ObservedStatusPhase;
    activity: ObservedActivity;
    rank: number;
  }> = {
    open: { phase: "registered", activity: "queued", rank: 62 },
    working: { phase: "running", activity: "working", rank: 65 },
    waiting: { phase: "running", activity: waitingActivity, rank: 100 },
    review: { phase: "running", activity: "review", rank: 98 },
    done: { phase: "running", activity: "completed", rank: 42 },
    cancelled: { phase: "stopped", activity: "cancelled", rank: 42 },
  };
  const mapped = stateMap[record.state];

  return {
    subjectKind: "work_item",
    subjectId: record.id,
    agentId,
    phase: mapped.phase,
    activity: mapped.activity,
    detail: {
      title: record.title,
      summary: record.progress?.summary ?? record.summary,
      waitingOn: record.waitingOn,
    },
    provenance: collaborationProvenance(record, 0.95),
    confidence: 0.95,
    updatedAt: record.updatedAt,
    rank: mapped.rank,
  };
}

function latestFlightForAgent(
  snapshot: Pick<RuntimeRegistrySnapshot, "invocations" | "flights">,
  agentId: ScoutId,
): FlightRecord | null {
  const flights = Object.values(snapshot.flights)
    .filter((flight) => flight.targetAgentId === agentId)
    .sort((left, right) => flightUpdatedAt(right, snapshot.invocations[right.invocationId]) -
      flightUpdatedAt(left, snapshot.invocations[left.invocationId]));
  return flights[0] ?? null;
}

function latestCollaborationForAgent(
  snapshot: Pick<RuntimeRegistrySnapshot, "collaborationRecords">,
  agentId: ScoutId,
): CollaborationRecord | null {
  const records = Object.values(snapshot.collaborationRecords)
    .filter((record) => record.ownerId === agentId || record.nextMoveOwnerId === agentId)
    .sort((left, right) => right.updatedAt - left.updatedAt);
  return records[0] ?? null;
}

function flightUpdatedAt(flight: FlightRecord, invocation: InvocationRequest | undefined): number {
  return flight.completedAt ?? flight.startedAt ?? invocation?.createdAt ?? 0;
}

function endpointTimestamp(endpoint: AgentEndpoint): number | null {
  const value = endpoint.metadata?.lastSeenAt ?? endpoint.metadata?.lastCompletedAt ?? endpoint.metadata?.lastStartedAt;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function workItemWaitingActivity(record: WorkItemRecord): ObservedActivity {
  switch (record.waitingOn?.kind) {
    case "actor":
      return "waiting_on_actor";
    case "approval":
      return "waiting_for_input";
    case "artifact":
    case "condition":
    case "work_item":
    default:
      return "blocked";
  }
}

function collaborationProvenance(record: CollaborationRecord, confidence: number): StatusProjectionProvenance[] {
  return [{
    source: "collaboration_record",
    refId: record.id,
    observedAt: record.updatedAt,
    confidence,
  }];
}

function compareCandidates(left: StatusCandidate, right: StatusCandidate): number {
  return right.rank - left.rank ||
    right.updatedAt - left.updatedAt ||
    right.confidence - left.confidence ||
    left.subjectId.localeCompare(right.subjectId);
}

function stripRank(candidate: StatusCandidate): ObservedStatusProjection {
  const { rank: _rank, ...status } = candidate;
  return status;
}
