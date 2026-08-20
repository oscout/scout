import { mergeCachedConversationTail } from "./chat-cache.ts";
import type { Flight, Message } from "./types.ts";

const PENDING_FLIGHT_TTL_MS = 120_000;

type PendingFlight = {
  flight: Flight;
  expiresAt: number;
};

const pendingFlights = new Map<string, PendingFlight>();

export function createClientMessageId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid
    ? `web-${uuid}`
    : `web-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Carry the broker-accepted first turn across the New Chat route transition.
 * The Chat cache owns the bubble, while this short lease owns only the queued
 * flight until the active-flight projection or SSE stream catches up.
 */
export function stageAcceptedConversationTurn(input: {
  conversationId: string;
  messageId: string;
  clientMessageId: string;
  body: string;
  attachments?: Message["attachments"];
  agentId?: string | null;
  flightId?: string | null;
  invocationId?: string | null;
  createdAt: number;
}): void {
  const conversationId = input.conversationId.trim();
  const messageId = input.messageId.trim();
  if (!conversationId || !messageId) return;

  mergeCachedConversationTail(conversationId, [{
    id: messageId,
    conversationId,
    actorId: "operator",
    actorName: "operator",
    body: input.body,
    createdAt: input.createdAt,
    class: "operator",
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    metadata: { clientMessageId: input.clientMessageId },
  }]);

  const flightId = input.flightId?.trim();
  const agentId = input.agentId?.trim();
  if (!flightId || !agentId) return;
  pendingFlights.set(conversationId, {
    flight: {
      id: flightId,
      invocationId: input.invocationId?.trim() || `pending:${flightId}`,
      agentId,
      agentName: null,
      conversationId,
      collaborationRecordId: null,
      state: "queued",
      summary: "Request accepted; waiting for worker activity.",
      startedAt: input.createdAt,
      completedAt: null,
      sessions: [],
    },
    expiresAt: Date.now() + PENDING_FLIGHT_TTL_MS,
  });
}

export function pendingConversationFlight(
  conversationId: string,
  nowMs = Date.now(),
): Flight | null {
  const id = conversationId.trim();
  const pending = pendingFlights.get(id);
  if (!pending) return null;
  if (pending.expiresAt <= nowMs) {
    pendingFlights.delete(id);
    return null;
  }
  return pending.flight;
}

export function settlePendingConversationFlight(
  conversationId: string,
  flightId?: string | null,
): void {
  const id = conversationId.trim();
  const pending = pendingFlights.get(id);
  if (!pending) return;
  if (!flightId || pending.flight.id === flightId) pendingFlights.delete(id);
}

export function clearPendingConversationTurns(): void {
  pendingFlights.clear();
}
