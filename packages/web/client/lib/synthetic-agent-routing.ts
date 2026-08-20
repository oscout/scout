import type { Route } from "./types.ts";

/** Synthetic lane/native agents use ids like `native:claude:<session-uuid>`. */
export function isSyntheticAgentId(agentId: string | null | undefined): boolean {
  return Boolean(agentId?.startsWith("native:"));
}

/** Pull a session ref the session-ref API can resolve from a synthetic id. */
export function sessionRefFromSyntheticAgentId(agentId: string): string | null {
  if (!isSyntheticAgentId(agentId)) return null;
  const rest = agentId.slice("native:".length);
  const parts = rest.split(":");
  if (parts.length < 2) return null;

  const marker = parts[1];
  if (marker === "path") return null;
  if (marker === "terminal") {
    return parts.slice(2).join(":") || null;
  }
  return marker || null;
}

export function sessionRefFromSyntheticAgent(
  agent: { id: string; harnessSessionId?: string | null },
): string | null {
  return agent.harnessSessionId?.trim() || sessionRefFromSyntheticAgentId(agent.id);
}

/** Agents-directory routes cannot resolve synthetic ids — send them to session observe. */
export function redirectSyntheticAgentRoute(route: Route): Route {
  if (route.view !== "agents-v2" || !route.agentId) return route;
  if (!isSyntheticAgentId(route.agentId)) return route;
  const sessionId = sessionRefFromSyntheticAgentId(route.agentId);
  if (!sessionId) return route;
  return {
    view: "sessions",
    sessionId,
    ...(route.machineId ? { machineId: route.machineId } : {}),
  };
}

export function normalizeRoute(route: Route): Route {
  return redirectSyntheticAgentRoute(route);
}
