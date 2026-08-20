import type { Route } from "../../lib/types.ts";

export type InspectorSelectionState = {
  hasBrokerAttempt: boolean;
  hasKnowledgeHit: boolean;
};

/**
 * Whether the current route has context that earns the inspector column.
 *
 * Keep this aligned with `resolveRightPane` plus the shell-owned Ops/Broker
 * inspectors. Routes whose resolver returns `null` must not reserve an empty
 * panel. Directory routes only gain the panel after a concrete selection.
 */
export function routeHasMeaningfulInspector(
  route: Route,
  selection: InspectorSelectionState,
): boolean {
  switch (route.view) {
    case "agents-v2":
      return Boolean(route.agentId || route.selectedAgentId || route.sessionId);
    case "agent-info":
    case "conversation":
    case "mesh":
    case "mesh-ops":
    case "repos":
    case "terminal":
    case "work":
      return true;
    case "ops":
      return route.mode !== "lanes";
    case "sessions":
      return !route.flightId;
    case "messages":
      return Boolean(route.conversationId);
    case "search":
      return Boolean(route.hitId && selection.hasKnowledgeHit);
    case "broker":
      return Boolean(route.attemptId && selection.hasBrokerAttempt);
    case "activity":
    case "briefings":
    case "code":
    case "follow":
    case "harnesses":
    case "inbox":
    case "repo-diff":
    case "settings":
    case "voice":
      return false;
  }
}
