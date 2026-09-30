import type { NormalizedApprovalRequest } from "@openscout/agent-sessions/client";
import type { WebFlight } from "../shared/api/web.ts";

const active = (flight: WebFlight) => ["running", "waiting", "blocked", "needs_input"].includes(flight.state);

/** Session-level prompts are related evidence, not proof that a flight caused them. */
export function chatExecutionSession(flightId: string, flights: WebFlight[], localNodeId: string) {
  const flight = flights.find(item => item.id === flightId);
  if (!flight || !active(flight)) return null;
  const live = (flight.sessions ?? []).filter(session => session.endedAt == null);
  if (live.length !== 1) return null;
  const session = live[0]!;
  if (session.nodeId !== localNodeId || !session.sessionId || !Number.isFinite(session.startedAt)) return null;
  // A shared active session does not establish whose operation is being approved.
  if (flights.some(other => other.id !== flight.id && active(other)
    && (other.sessions ?? []).some(trace => trace.endedAt == null && trace.sessionId === session.sessionId && trace.nodeId === localNodeId))) return null;
  return session;
}

export function chatSessionApprovals(flightId: string, flights: WebFlight[], approvals: NormalizedApprovalRequest[], localNodeId: string) {
  const session = chatExecutionSession(flightId, flights, localNodeId);
  if (!session) return null;
  return {
    sessionId: session.sessionId,
    approvals: approvals.filter(approval => approval.sessionId === session.sessionId
      && approval.actionStatus === "awaiting_approval"
      && approval.turnStartedAt != null && Number.isFinite(approval.turnStartedAt)
      && approval.turnStartedAt >= session.startedAt),
  };
}
