import type { FollowPreferredView, FollowTarget, Route } from "./types.ts";

function cleanFollowId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function firstPresent(...values: Array<string | null | undefined>): string | null {
  return values.find((value) => value && value.trim().length > 0)?.trim() ?? null;
}

export function mergeFollowTargets(
  resolved: FollowTarget,
  fallback: FollowTarget,
): FollowTarget {
  return {
    flightId: firstPresent(resolved.flightId, fallback.flightId),
    invocationId: firstPresent(resolved.invocationId, fallback.invocationId),
    conversationId: firstPresent(resolved.conversationId, fallback.conversationId),
    workId: firstPresent(resolved.workId, fallback.workId),
    sessionId: firstPresent(resolved.sessionId, fallback.sessionId),
    targetAgentId: firstPresent(resolved.targetAgentId, fallback.targetAgentId),
  };
}

export function tailQueryForFollowTarget(target: FollowTarget): string | null {
  const terms = [
    target.sessionId,
    target.flightId,
    target.invocationId,
    target.targetAgentId,
    target.conversationId,
    target.workId,
  ]
    .map(cleanFollowId)
    .filter((value): value is string => Boolean(value));
  const uniqueTerms = [...new Set(terms)];
  return uniqueTerms.length ? uniqueTerms.join("|") : null;
}

function tailRouteForFollowTarget(target: FollowTarget): Route {
  const tailQuery = tailQueryForFollowTarget(target);
  return {
    view: "ops",
    mode: "tail",
    ...(tailQuery ? { tailQuery } : {}),
    ...(target.flightId ? { flightId: target.flightId } : {}),
    ...(target.invocationId ? { invocationId: target.invocationId } : {}),
    ...(target.conversationId ? { conversationId: target.conversationId } : {}),
    ...(target.workId ? { workId: target.workId } : {}),
    ...(target.sessionId ? { sessionId: target.sessionId } : {}),
    ...(target.targetAgentId ? { targetAgentId: target.targetAgentId } : {}),
  };
}

function observeRouteForFollowTarget(target: FollowTarget): Route | null {
  if (target.flightId) {
    return {
      view: "sessions",
      flightId: target.flightId,
      ...(target.sessionId ? { sessionId: target.sessionId } : {}),
      ...(target.targetAgentId ? { agentId: target.targetAgentId } : {}),
    };
  }
  if (target.sessionId) {
    return {
      view: "sessions",
      sessionId: target.sessionId,
      ...(target.targetAgentId ? { agentId: target.targetAgentId } : {}),
    };
  }
  return target.targetAgentId
    ? { view: "agents-v2", agentId: target.targetAgentId, tab: "observe" }
    : null;
}

export function routeForFollowTarget(
  target: FollowTarget,
  preferredView: FollowPreferredView | undefined,
): Route {
  if (preferredView === "work" && target.workId) {
    return { view: "work", workId: target.workId };
  }
  if (preferredView === "session" && (target.flightId || target.sessionId)) {
    return {
      view: "sessions",
      ...(target.flightId ? { flightId: target.flightId } : {}),
      ...(target.sessionId ? { sessionId: target.sessionId } : {}),
    };
  }
  if (preferredView === "chat" && target.conversationId) {
    return { view: "conversation", conversationId: target.conversationId };
  }
  if (preferredView === "chat" && target.targetAgentId) {
    return { view: "agents-v2", agentId: target.targetAgentId, tab: "message" };
  }
  if (preferredView === "tail") {
    return tailRouteForFollowTarget(target);
  }

  const observeRoute = observeRouteForFollowTarget(target);
  if (observeRoute) {
    return observeRoute;
  }
  if (target.workId) {
    return { view: "work", workId: target.workId };
  }
  if (target.sessionId) {
    return {
      view: "sessions",
      sessionId: target.sessionId,
      ...(target.targetAgentId ? { agentId: target.targetAgentId } : {}),
    };
  }
  if (target.conversationId) {
    return { view: "conversation", conversationId: target.conversationId };
  }
  if (target.flightId || target.invocationId || target.targetAgentId) {
    return tailRouteForFollowTarget(target);
  }
  return { view: "inbox" };
}

export function targetFromFollowRoute(route: Extract<Route, { view: "follow" }>): FollowTarget {
  return {
    flightId: route.flightId ?? null,
    invocationId: route.invocationId ?? null,
    conversationId: route.conversationId ?? null,
    workId: route.workId ?? null,
    sessionId: route.sessionId ?? null,
    targetAgentId: route.targetAgentId ?? null,
  };
}
