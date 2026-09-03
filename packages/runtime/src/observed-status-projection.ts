import { flightSessionTrace } from "@openscout/protocol";
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
import type { ActivityTransitionLog } from "./activity-transitions.js";

export interface ObservedStatusProjectionOptions {
  now?: number;
  staleAfterMs?: number;
  /**
   * Transition log used to stamp `transitionAt` (when the current activity
   * began). Optional: without it the projection stays a pure function of the
   * snapshot and leaves `transitionAt` undefined rather than guessing, since
   * time-in-state cannot be recovered from a single snapshot.
   *
   * Passing a log makes the call stateful — it records the observation.
   */
  transitions?: ActivityTransitionLog;
}

/**
 * A candidate carries two timestamps that must never collapse into one.
 *
 * `updatedAt` is *last-verified-at*: when this source last attested that the
 * agent's runtime is alive. `stateEnteredAt` is *began-at*: when the activity
 * this candidate describes started. A flight running for nine minutes has a
 * nine-minute-old `stateEnteredAt` and an `updatedAt` that moves with every
 * acknowledgement. Reading the first as the second is what decayed live agents
 * out of the presence map 105s after they started work.
 */
type StatusCandidate = ObservedStatusProjection & {
  rank: number;
  stateEnteredAt?: number;
};

type ProjectionSnapshot = Pick<
  RuntimeRegistrySnapshot,
  "agents" | "endpoints" | "invocations" | "flights" | "collaborationRecords"
>;

const DEFAULT_STALE_AFTER_MS = 90_000;

export function projectObservedStatusForAgent(
  snapshot: ProjectionSnapshot,
  agentId: ScoutId,
  options: ObservedStatusProjectionOptions = {},
): ObservedStatusProjection {
  const endpoints = Object.values(snapshot.endpoints)
    .filter((endpoint) => endpoint.agentId === agentId);
  return projectObservedStatusForAgentFromRecords(
    snapshot,
    agentId,
    endpoints,
    latestFlightForAgent(snapshot, agentId),
    latestCollaborationForAgent(snapshot, agentId),
    options,
  );
}

function projectObservedStatusForAgentFromRecords(
  snapshot: ProjectionSnapshot,
  agentId: ScoutId,
  endpoints: readonly AgentEndpoint[],
  latestFlight: FlightRecord | null,
  latestCollaboration: CollaborationRecord | null,
  options: ObservedStatusProjectionOptions,
): ObservedStatusProjection {
  const now = options.now ?? Date.now();
  const candidates: StatusCandidate[] = [];

  for (const endpoint of endpoints) {
    candidates.push(projectEndpointStatus(endpoint, now, options));
  }

  if (latestFlight) {
    const invocation = snapshot.invocations[latestFlight.invocationId];
    candidates.push(projectFlightStatus(latestFlight, invocation, now));
  }

  if (latestCollaboration) {
    candidates.push(projectCollaborationStatus(latestCollaboration, agentId));
  }

  if (candidates.length === 0) {
    return withTransitionAt(stripRank({
      subjectKind: "agent",
      subjectId: agentId,
      agentId,
      phase: snapshot.agents[agentId] ? "registered" : "unknown",
      activity: "unknown",
      provenance: [],
      confidence: snapshot.agents[agentId] ? 0.7 : 0.3,
      updatedAt: now,
      rank: snapshot.agents[agentId] ? 15 : 0,
    }), agentId, now, options, now);
  }

  candidates.sort(compareCandidates);
  const winner = candidates[0]!;
  return withTransitionAt(
    stripRank({ ...winner, ...freshestEvidence(candidates) }),
    agentId,
    now,
    options,
    winner.stateEnteredAt,
  );
}

/**
 * Freshness for the selected projection, taken across *every* candidate.
 *
 * Selection is winner-take-all by rank, and that is right for "what is this
 * agent doing" — a running flight outranks an idle endpoint. It is wrong for
 * "is this agent still there". The flight knows the task; the endpoint's
 * heartbeat is what proves the runtime is alive. Keeping only the winner's
 * timestamps discarded that heartbeat and then read "this state began a while
 * ago" as "the observer went quiet".
 *
 * So the *what* comes from the highest-ranked candidate and the *how fresh*
 * comes from the freshest one, decided independently.
 */
function freshestEvidence(
  candidates: StatusCandidate[],
): Pick<ObservedStatusProjection, "updatedAt" | "staleAt"> {
  let updatedAt = Number.NEGATIVE_INFINITY;
  let staleAt: number | undefined;
  for (const candidate of candidates) {
    if (candidate.updatedAt > updatedAt) updatedAt = candidate.updatedAt;
    if (candidate.staleAt !== undefined && (staleAt === undefined || candidate.staleAt > staleAt)) {
      staleAt = candidate.staleAt;
    }
  }
  return staleAt === undefined ? { updatedAt } : { updatedAt, staleAt };
}

/**
 * Stamp state-entry time onto a projection, when the caller supplied a
 * transition log to remember it with. Without one the field stays undefined —
 * an absent timestamp is honest, a fabricated one is not.
 *
 * Seeded from the winning candidate's `stateEnteredAt`, never from `updatedAt`:
 * the log is asked "when did this begin", and `updatedAt` answers "when was
 * this last confirmed". Feeding it the second question's answer is what reset
 * time-in-state to zero for every endpoint-sourced agent on broker restart.
 */
function withTransitionAt(
  status: ObservedStatusProjection,
  agentId: ScoutId,
  now: number,
  options: ObservedStatusProjectionOptions,
  stateEnteredAt?: number,
): ObservedStatusProjection {
  if (!options.transitions) return status;
  return {
    ...status,
    transitionAt: options.transitions.record(
      agentId,
      status.activity,
      stateEnteredAt ?? status.updatedAt,
      now,
    ),
  };
}

export function projectObservedStatusesFromRuntimeSnapshot(
  snapshot: ProjectionSnapshot,
  options: ObservedStatusProjectionOptions = {},
): ObservedStatusProjection[] {
  const agentIds = new Set<ScoutId>(Object.keys(snapshot.agents));
  const endpointsByAgent = new Map<ScoutId, AgentEndpoint[]>();
  for (const endpoint of Object.values(snapshot.endpoints)) {
    agentIds.add(endpoint.agentId);
    const endpoints = endpointsByAgent.get(endpoint.agentId);
    if (endpoints) {
      endpoints.push(endpoint);
    } else {
      endpointsByAgent.set(endpoint.agentId, [endpoint]);
    }
  }
  for (const invocation of Object.values(snapshot.invocations)) {
    agentIds.add(invocation.targetAgentId);
  }

  const latestFlightByAgent = new Map<ScoutId, FlightRecord>();
  for (const flight of Object.values(snapshot.flights)) {
    const current = latestFlightByAgent.get(flight.targetAgentId);
    if (!current || flightUpdatedAt(flight, snapshot.invocations[flight.invocationId]) >
      flightUpdatedAt(current, snapshot.invocations[current.invocationId])) {
      latestFlightByAgent.set(flight.targetAgentId, flight);
    }
  }

  const latestCollaborationByAgent = new Map<ScoutId, CollaborationRecord>();
  for (const record of Object.values(snapshot.collaborationRecords)) {
    if (record.ownerId) {
      agentIds.add(record.ownerId);
      keepLatestCollaboration(latestCollaborationByAgent, record.ownerId, record);
    }
    if (record.nextMoveOwnerId) {
      agentIds.add(record.nextMoveOwnerId);
      keepLatestCollaboration(latestCollaborationByAgent, record.nextMoveOwnerId, record);
    }
  }

  return [...agentIds]
    .sort()
    .map((agentId) => projectObservedStatusForAgentFromRecords(
      snapshot,
      agentId,
      endpointsByAgent.get(agentId) ?? [],
      latestFlightByAgent.get(agentId) ?? null,
      latestCollaborationByAgent.get(agentId) ?? null,
      options,
    ));
}

function keepLatestCollaboration(
  records: Map<ScoutId, CollaborationRecord>,
  agentId: ScoutId,
  candidate: CollaborationRecord,
): void {
  const current = records.get(agentId);
  if (!current || candidate.updatedAt > current.updatedAt) {
    records.set(agentId, candidate);
  }
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
    stateEnteredAt: endpointStateEnteredAt(endpoint, activity, updatedAt),
    rank,
  };
}

/**
 * When the endpoint's current state began, as opposed to when it last checked
 * in.
 *
 * Read from the endpoint's own record so time-in-state survives a broker
 * restart. Seeding from `lastSeenAt` — the heartbeat — reset the clock to zero
 * for every endpoint-sourced agent the moment the broker came back, which left
 * `transitionAt` restart-safe for flights and not for endpoints.
 *
 * Only states with real evidence get a stamp: `working` began when the current
 * turn started, `idle` began when the last one finished. For anything else the
 * record says nothing, and an absent stamp lets the caller fall back rather
 * than invent history.
 */
function endpointStateEnteredAt(
  endpoint: AgentEndpoint,
  activity: ObservedActivity,
  updatedAt: number,
): number | undefined {
  const evidence = activity === "working"
    ? parseTimestamp(endpoint.metadata?.lastStartedAt)
    : activity === "idle"
      ? parseTimestamp(endpoint.metadata?.lastCompletedAt)
      : null;
  if (evidence === null) return undefined;
  return Math.min(evidence, updatedAt);
}

function projectFlightStatus(
  flight: FlightRecord,
  invocation: InvocationRequest | undefined,
  now: number,
): StatusCandidate {
  const stateEnteredAt = flight.completedAt ?? flight.startedAt ?? invocation?.createdAt ?? now;
  // A flight record is edge-triggered: the broker writes `running` once and a
  // terminal state once, so the record never gets fresher while work is in
  // flight. Its own liveness evidence is the session trace's acknowledgements,
  // and where there are none the agent's endpoint heartbeat supplies it via
  // `freshestEvidence`. Dating the claim from `startedAt` is what aged a
  // running flight out of presence while it was still running.
  const updatedAt = Math.max(stateEnteredAt, latestSessionAck(flight) ?? stateEnteredAt);
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
    stateEnteredAt,
    rank: rankByState[flight.state],
  };
}

/**
 * The most recent acknowledgement across a flight's session trace — the only
 * "still alive" signal a flight record carries on its own.
 */
function latestSessionAck(flight: FlightRecord): number | null {
  let latest: number | null = null;
  for (const entry of flightSessionTrace(flight)) {
    const ack = Math.max(entry.lastAcknowledgedAt, entry.endedAt ?? 0);
    if (latest === null || ack > latest) latest = ack;
  }
  return latest;
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
    stateEnteredAt: record.updatedAt,
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
    stateEnteredAt: record.updatedAt,
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
  return parseTimestamp(
    endpoint.metadata?.lastSeenAt ?? endpoint.metadata?.lastCompletedAt ?? endpoint.metadata?.lastStartedAt,
  );
}

function parseTimestamp(value: unknown): number | null {
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
  const { rank: _rank, stateEnteredAt: _stateEnteredAt, ...status } = candidate;
  return status;
}
