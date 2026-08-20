import type { ConversationEntry, Flight, SessionEntry } from "./types.ts";
import { normalizeTimestampMs } from "./time.ts";

type ConversationLike = ConversationEntry | SessionEntry;

export const CONVERSATION_WORKING_TURN_ACTIVE_WINDOW_MS = 30 * 60_000;

export function isDirectConversation(conversation: ConversationLike): boolean {
  return conversation.kind === "direct";
}

/** Named multi-party rooms (#channels). Not operator group DMs. */
export function isChannelConversation(conversation: ConversationLike): boolean {
  return conversation.kind === "channel";
}

/**
 * Multi-party rooms that open with channel chrome historically included
 * `group_direct`. Prefer `isChannelConversation` / `isOperatorDm` for rail IA.
 */
export function isGroupConversation(conversation: ConversationLike): boolean {
  return (
    conversation.kind === "channel"
    || conversation.kind === "group_direct"
  );
}

/**
 * True when the human operator is a first-class participant in this conversation
 * (a real DM or channel membership), as opposed to only observing agent-to-agent
 * or agent-to-session traffic from the fleet.
 */
export function isOperatorParticipant(conversation: ConversationLike): boolean {
  if (conversation.participantIds.includes("operator")) return true;
  const participants = conversation.participants;
  if (!participants?.length) return false;
  return participants.some(
    (p) =>
      p.actorId === "operator"
      || p.kind === "operator"
      || (p.kind === "person" && p.actorId === "operator"),
  );
}

/**
 * Your DMs — direct or group_direct where the operator is a participant.
 * Group DMs are not channels.
 */
export function isOperatorDm(conversation: ConversationLike): boolean {
  return (
    (conversation.kind === "direct" || conversation.kind === "group_direct")
    && isOperatorParticipant(conversation)
  );
}

/**
 * Observed traffic — direct or group_direct without the operator
 * (agent↔agent / agent↔session rooms you can watch).
 */
export function isObservedDirect(conversation: ConversationLike): boolean {
  return (
    (conversation.kind === "direct" || conversation.kind === "group_direct")
    && !isOperatorParticipant(conversation)
  );
}

export function conversationDisplayTitle(conversation: ConversationLike): string {
  if (conversation.title && conversation.title !== conversation.id) {
    return conversation.title;
  }
  return conversation.agentName ?? conversation.id;
}

export function conversationShortLabel(conversation: ConversationLike): string {
  return conversationDisplayTitle(conversation);
}

export const TERMINAL_CONVERSATION_FLIGHT_STATES = new Set([
  "completed",
  "failed",
  "cancelled",
]);

export function isActiveConversationFlight(
  flight: Pick<Flight, "state"> | null | undefined,
): boolean {
  return Boolean(
    flight && !TERMINAL_CONVERSATION_FLIGHT_STATES.has(flight.state),
  );
}

export function shouldShowConversationWorkingTurn(
  flight: (Pick<Flight, "state"> & Partial<Pick<Flight, "summary" | "dispatchOutcome">>) | null | undefined,
): boolean {
  return isActiveConversationFlight(flight)
    && !isRequesterWaitTimeoutConversationFlight(flight);
}

export function isQueuedUntilOnlineConversationFlight(
  flight: Partial<Pick<Flight, "dispatchOutcome">> | null | undefined,
): boolean {
  return flight?.dispatchOutcome?.status === "queued_until_online";
}

export function isRequesterWaitTimeoutConversationFlight(
  flight: Partial<Pick<Flight, "summary">> | null | undefined,
): boolean {
  return Boolean(
    flight?.summary?.includes("Scout stopped waiting for a synchronous result")
      || flight?.summary?.includes("the requester stopped waiting after"),
  );
}

export function isConversationWorkingTurnWithoutRecentUpdate(
  flight: (Pick<Flight, "state" | "startedAt"> & Partial<Pick<Flight, "dispatchOutcome">>) | null | undefined,
  nowMs = Date.now(),
  activeWindowMs = CONVERSATION_WORKING_TURN_ACTIVE_WINDOW_MS,
): boolean {
  if (!isActiveConversationFlight(flight)) {
    return false;
  }
  if (isQueuedUntilOnlineConversationFlight(flight)) {
    return false;
  }
  const startedAt = normalizeTimestampMs(flight?.startedAt);
  return startedAt !== null && nowMs - startedAt > activeWindowMs;
}

export function isConversationWorkingTurnWithoutRecentUpdateAnswered(
  flight: Pick<Flight, "state" | "startedAt"> | null | undefined,
  lastAgentReplyAt: number | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (!isConversationWorkingTurnWithoutRecentUpdate(flight, nowMs)) {
    return false;
  }
  const startedAt = normalizeTimestampMs(flight?.startedAt);
  const replyAt = normalizeTimestampMs(lastAgentReplyAt);
  return startedAt !== null && replyAt !== null && replyAt > startedAt;
}

export function shouldClearConversationWorkingStateForAgentMessage(
  flight: Pick<Flight, "state"> | null | undefined,
): boolean {
  return !isActiveConversationFlight(flight);
}
