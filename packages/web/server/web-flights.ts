import { epochMs, flightSessionTrace } from "@openscout/protocol";
import { queryFlights, type WebFlight } from "./db-queries.ts";
import { conversationIdAliases } from "./db/internal/conversation-ids.ts";
import type { ScoutBrokerContext } from "./core/broker/service.ts";

export function recordInput(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function firstMetadataString(...values: Array<unknown>): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

export const ACTIVE_BROKER_FLIGHT_STATES = new Set(["queued", "waking", "running", "waiting"]);

export function metadataRecordValue(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): Record<string, unknown> | null {
  const value = metadata?.[key];
  return recordInput(value);
}

export function brokerFlightToWebFlight(
  broker: ScoutBrokerContext,
  flight: NonNullable<ScoutBrokerContext["snapshot"]["flights"]>[string],
): WebFlight {
  const invocation = broker.snapshot.invocations?.[flight.invocationId];
  const metadata = recordInput(flight.metadata);
  const returnAddress = metadataRecordValue(metadata, "returnAddress");
  const agent = broker.snapshot.agents?.[flight.targetAgentId];
  const actor = broker.snapshot.actors?.[flight.targetAgentId];
  return {
    id: flight.id,
    invocationId: flight.invocationId,
    ...(invocation?.messageId ? { messageId: invocation.messageId } : {}),
    agentId: flight.targetAgentId,
    agentName: agent?.displayName ?? actor?.displayName ?? null,
    conversationId:
      invocation?.conversationId
      ?? firstMetadataString(metadata?.conversationId, returnAddress?.conversationId),
    collaborationRecordId:
      invocation?.collaborationRecordId
      ?? firstMetadataString(metadata?.collaborationRecordId),
    state: flight.state,
    summary: flight.summary ?? null,
    startedAt: epochMs(flight.startedAt) ?? epochMs(invocation?.createdAt),
    completedAt: epochMs(flight.completedAt),
    sessions: flightSessionTrace(flight),
  };
}

export function queryBrokerFlightsForWeb(
  broker: ScoutBrokerContext | null,
  opts: {
    flightId?: string;
    agentId?: string;
    conversationId?: string;
    collaborationRecordId?: string;
    activeOnly?: boolean;
  },
): WebFlight[] {
  // Durable rows are the base (SQLite retains terminal flights the broker's
  // rolling hot set has rotated out); the broker window overlays by id and
  // wins on duplicates — same merge shape as mergeChatConversationMessages.
  // The overlay happens BEFORE filtering: a broker row that no longer
  // matches (e.g. durable says running, broker says completed under
  // activeOnly) must hide the durable row, not just fail to add itself.
  const merged = new Map<string, WebFlight>();
  for (const flight of queryFlights(opts)) {
    merged.set(flight.id, flight);
  }
  if (broker) {
    for (const record of Object.values(broker.snapshot.flights ?? {})) {
      const flight = brokerFlightToWebFlight(broker, record);
      merged.set(flight.id, flight);
    }
  }
  const conversationIds = opts.conversationId
    ? new Set(conversationIdAliases(opts.conversationId))
    : null;
  return [...merged.values()]
    .filter((flight) => opts.flightId ? flight.id === opts.flightId : true)
    .filter((flight) => opts.agentId ? flight.agentId === opts.agentId : true)
    .filter((flight) => conversationIds
      ? (flight.conversationId !== null && conversationIds.has(flight.conversationId))
      : true)
    .filter((flight) => opts.collaborationRecordId ? flight.collaborationRecordId === opts.collaborationRecordId : true)
    .filter((flight) => opts.activeOnly ? ACTIVE_BROKER_FLIGHT_STATES.has(flight.state) : true)
    .sort((left, right) => (
      (right.startedAt ?? right.completedAt ?? 0) - (left.startedAt ?? left.completedAt ?? 0)
      || left.id.localeCompare(right.id)
    ))
    .slice(0, 100);
}
