import type { FlightSessionTrace } from "../../lib/types.ts";

export function uniqueFlightSessions(trace: FlightSessionTrace[]): FlightSessionTrace[] {
  const bySession = new Map<string, FlightSessionTrace>();
  for (const entry of trace) {
    // Reinsert an existing session so iteration order reflects its most recent
    // span. A flight can return to a previously-used session after switching
    // elsewhere, and the active/default selection must follow the trace tail.
    bySession.delete(entry.sessionId);
    bySession.set(entry.sessionId, entry);
  }
  return [...bySession.values()];
}

/**
 * Preserve a concrete session deep link when its broker flight record has
 * already aged out; otherwise keep the trace-tail selection semantics.
 */
export function resolveFlightSessionId(
  trace: FlightSessionTrace[],
  requestedSessionId?: string | null,
): string | null {
  const sessions = uniqueFlightSessions(trace);
  const requested = requestedSessionId?.trim() || null;
  return sessions.find((session) => session.sessionId === requested)?.sessionId
    ?? sessions.at(-1)?.sessionId
    ?? requested;
}
