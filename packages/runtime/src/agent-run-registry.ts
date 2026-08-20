import {
  projectAgentRunFromInvocationFlight,
  type AgentRun,
  type AgentRunReviewState,
  type AgentRunSource,
  type FlightRecord,
  type ScoutId,
} from "@openscout/protocol";

import type { RuntimeRegistrySnapshot } from "./registry.js";

export interface RuntimeAgentRunProjectionOptions {
  now?: number;
  sourceByInvocationId?: Record<ScoutId, AgentRunSource>;
  reviewStateByInvocationId?: Record<ScoutId, AgentRunReviewState>;
  reviewTaskIdsByInvocationId?: Record<ScoutId, ScoutId[]>;
  artifactIdsByInvocationId?: Record<ScoutId, ScoutId[]>;
  traceSessionIdsByInvocationId?: Record<ScoutId, ScoutId[]>;
}

export function projectAgentRunsFromRuntimeSnapshot(
  snapshot: Pick<RuntimeRegistrySnapshot, "invocations" | "flights">,
  options: RuntimeAgentRunProjectionOptions = {},
): AgentRun[] {
  const flightsByInvocationId = new Map<ScoutId, FlightRecord>();
  for (const flight of Object.values(snapshot.flights)) {
    const current = flightsByInvocationId.get(flight.invocationId);
    if (!current || flightTimestamp(flight) >= flightTimestamp(current)) {
      flightsByInvocationId.set(flight.invocationId, flight);
    }
  }

  return Object.values(snapshot.invocations)
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
    .map((invocation) => projectAgentRunFromInvocationFlight({
      invocation,
      flight: flightsByInvocationId.get(invocation.id),
      now: options.now,
      source: options.sourceByInvocationId?.[invocation.id],
      reviewState: options.reviewStateByInvocationId?.[invocation.id],
      reviewTaskIds: options.reviewTaskIdsByInvocationId?.[invocation.id],
      artifactIds: options.artifactIdsByInvocationId?.[invocation.id],
      traceSessionIds: options.traceSessionIdsByInvocationId?.[invocation.id],
    }));
}

function flightTimestamp(flight: FlightRecord): number {
  return flight.completedAt ?? flight.startedAt ?? 0;
}
