import type { Route, SessionEntry } from "../lib/types.ts";
import { isOperatorDm } from "../lib/conversations.ts";
import type { LastViewedMap } from "../lib/sessionRead.ts";
import { isSyntheticAgentId, sessionRefFromSyntheticAgentId } from "../lib/synthetic-agent-routing.ts";
import { normalizeTimestampMs } from "../lib/time.ts";

/** Compile-time npm surface selection; the ordinary web build remains full. */
export const BASIC_WEB = import.meta.env.VITE_SCOUT_WEB_PROFILE === "basic";

/** The three destinations the basic web client carries. */
export type BasicArea = "home" | "dms" | "tail";

/**
 * Folds any full-app route onto the basic surface. Home, DMs and Tail keep
 * their own state; agent routes become that agent's DM, session and follow
 * links become a filtered Tail, and everything else lands on Home.
 */
export function basicRoute(route: Route): Route {
  switch (route.view) {
    case "inbox":
      return { view: "inbox" };
    case "broker":
      return {
        view: "broker",
        ...(route.filter && route.filter !== "all" ? { filter: route.filter } : {}),
        ...(route.attemptId ? { attemptId: route.attemptId } : {}),
      };
    case "messages":
      // One URL per thread: a known conversation always opens at /c/:id.
      if (route.conversationId) return { view: "conversation", conversationId: route.conversationId };
      return basicAgentRoute(route.agentId);
    case "conversation":
      return {
        view: "conversation",
        conversationId: route.conversationId,
        ...(route.composeDraft ? { composeDraft: route.composeDraft } : {}),
      };
    case "agent-info":
      return { view: "conversation", conversationId: route.conversationId };
    case "agents-v2":
    case "terminal":
      return basicAgentRoute(route.agentId);
    case "sessions":
      return {
        view: "ops",
        mode: "tail",
        ...(route.sessionId ? { tailQuery: route.sessionId } : {}),
        ...(route.flightId ? { flightId: route.flightId } : {}),
      };
    case "follow":
      return {
        view: "ops",
        mode: "tail",
        ...(route.flightId ? { flightId: route.flightId } : {}),
        ...(route.invocationId ? { invocationId: route.invocationId } : {}),
        ...(route.conversationId ? { conversationId: route.conversationId } : {}),
        ...(route.workId ? { workId: route.workId } : {}),
        ...(route.sessionId ? { sessionId: route.sessionId } : {}),
        ...(route.targetAgentId ? { targetAgentId: route.targetAgentId } : {}),
      };
    case "ops":
      // Tail is the only operator surface basic carries; the rest go Home.
      return route.mode === "tail" ? { view: "ops", mode: "tail", ...pickFollow(route) } : { view: "inbox" };
    default:
      return { view: "inbox" };
  }
}

/** An agent opens as its DM; a synthetic (observed-session) agent has no DM, so it opens in Tail. */
function basicAgentRoute(agentId: string | undefined): Route {
  if (!agentId) return { view: "messages" };
  if (isSyntheticAgentId(agentId)) {
    const sessionRef = sessionRefFromSyntheticAgentId(agentId);
    return sessionRef ? { view: "ops", mode: "tail", tailQuery: sessionRef } : { view: "ops", mode: "tail" };
  }
  return { view: "messages", agentId };
}

function pickFollow(route: Extract<Route, { view: "ops" }>): Partial<Extract<Route, { view: "ops" }>> {
  return {
    ...(route.tailQuery ? { tailQuery: route.tailQuery } : {}),
    ...(route.flightId ? { flightId: route.flightId } : {}),
    ...(route.invocationId ? { invocationId: route.invocationId } : {}),
    ...(route.conversationId ? { conversationId: route.conversationId } : {}),
    ...(route.workId ? { workId: route.workId } : {}),
    ...(route.sessionId ? { sessionId: route.sessionId } : {}),
    ...(route.targetAgentId ? { targetAgentId: route.targetAgentId } : {}),
  };
}

/** Which basic destination a (basic-normalized) route belongs to. */
export function basicArea(route: Route): BasicArea {
  switch (route.view) {
    case "messages":
    case "conversation":
      return "dms";
    case "ops":
      return "tail";
    default:
      return "home";
  }
}

/** Operator ↔ one-agent conversations only: no channels, no group DMs, no observed traffic. */
export function isBasicDm(session: SessionEntry): boolean {
  return session.kind === "direct" && isOperatorDm(session);
}

export function basicDmConversations(sessions: readonly SessionEntry[]): SessionEntry[] {
  return sessions.filter(isBasicDm);
}

/** The listed DM a conversation id resolves to, including coalesced ids. */
export function findBasicDm(
  sessions: readonly SessionEntry[],
  conversationId: string,
): SessionEntry | null {
  return sessions.find((session) =>
    isBasicDm(session)
    && (session.id === conversationId || Boolean(session.equivalentConversationIds?.includes(conversationId))),
  ) ?? null;
}

/** The newest listed DM with one agent, if the operator already has one. */
export function findBasicDmForAgent(
  sessions: readonly SessionEntry[],
  agentId: string,
): SessionEntry | null {
  let best: SessionEntry | null = null;
  for (const session of sessions) {
    if (!isBasicDm(session) || session.agentId !== agentId) continue;
    if (!best || (session.lastMessageAt ?? 0) > (best.lastMessageAt ?? 0)) best = session;
  }
  return best;
}

/** Unread: a message newer than the last open, or than `baseline` for a DM never opened here. */
export function isBasicDmUnread(
  session: Pick<SessionEntry, "id" | "lastMessageAt">,
  lastViewed: LastViewedMap,
  baseline: number,
): boolean {
  const lastMessageAt = normalizeTimestampMs(session.lastMessageAt);
  if (!lastMessageAt) return false;
  return lastMessageAt > (lastViewed[session.id] ?? baseline);
}
