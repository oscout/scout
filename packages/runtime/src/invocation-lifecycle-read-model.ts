import type { FlightRecord } from "@openscout/protocol";

import type { RuntimeRegistrySnapshot } from "./registry.js";

/**
 * Minimal compatibility shape for `GET /v1/invocations/:id/lifecycle`.
 *
 * The former `ScoutInvocationLifecycle` projection (a ~500-line invocation+flight
 * re-merge that also remapped the flight state vocabulary and derived
 * deliveries/waitingOn/terminal) was removed in the ask-overbuild simplification
 * (Phase 2). Its only production consumers — the `invocations_get` /
 * `invocations_wait` MCP tools — read the flight record first and only ever used
 * this endpoint as a fallback. We keep the route for one release returning this
 * flat subset, built directly from the invocation + its latest flight, so any
 * out-of-tree HTTP client degrades instead of 404-ing mid-release.
 */
export type InvocationLifecycleSummary = {
  invocationId: string;
  flightId?: string;
  targetAgentId?: string;
  state?: string;
  startedAt?: number;
  completedAt?: number;
};

export type ReadInvocationLifecycleInput = {
  snapshot: RuntimeRegistrySnapshot;
  invocationId: string;
};

export function readInvocationLifecycle(
  input: ReadInvocationLifecycleInput,
): InvocationLifecycleSummary | null {
  const invocationId = input.invocationId.trim();
  if (!invocationId) {
    return null;
  }

  const invocation = input.snapshot.invocations[invocationId];
  if (!invocation) {
    return null;
  }

  const flight = latestFlightForInvocation(input.snapshot, invocationId);
  const targetAgentId = flight?.targetAgentId ?? invocation.targetAgentId;

  const summary: InvocationLifecycleSummary = { invocationId };
  if (flight?.id !== undefined) {
    summary.flightId = flight.id;
  }
  if (targetAgentId !== undefined) {
    summary.targetAgentId = targetAgentId;
  }
  if (flight?.state !== undefined) {
    summary.state = flight.state;
  }
  if (flight?.startedAt !== undefined) {
    summary.startedAt = flight.startedAt;
  }
  if (flight?.completedAt !== undefined) {
    summary.completedAt = flight.completedAt;
  }
  return summary;
}

function latestFlightForInvocation(
  snapshot: RuntimeRegistrySnapshot,
  invocationId: string,
): FlightRecord | undefined {
  let latest: FlightRecord | undefined;
  for (const flight of Object.values(snapshot.flights)) {
    if (flight.invocationId !== invocationId) {
      continue;
    }
    if (!latest || flightSortTimestamp(flight) > flightSortTimestamp(latest)) {
      latest = flight;
    }
  }
  return latest;
}

function flightSortTimestamp(flight: FlightRecord): number {
  return flight.completedAt ?? flight.startedAt ?? 0;
}
