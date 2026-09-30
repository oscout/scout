import type { WebAgent } from "./db-queries.ts";

export function mostRecentAgents(agents: WebAgent[], limit: number | undefined): WebAgent[] {
  if (limit === undefined) return agents;
  return [...agents]
    .sort((left, right) =>
      (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
      || left.name.localeCompare(right.name),
    )
    .slice(0, limit);
}

/** Node a roster row belongs to, for coverage purposes. */
export function agentRosterNodeId(agent: WebAgent): string | null {
  return agent.authorityNodeId ?? agent.homeNodeId ?? null;
}

/**
 * Cap the roster without erasing a whole machine.
 *
 * The bounded `/api/agents?detail=summary` roster deliberately skips the full
 * broker snapshot, so it cannot pin peers the way the rich path does. It does
 * not need to: one representative per distinct node, reserved before the cap,
 * is enough for the Network page to know a machine exists, and every other
 * consumer still gets a recency-ordered list. Without this, a busy local
 * broker filled all 100 slots and every remote card vanished (#906).
 */
export function withNodeCoveredRoster(agents: WebAgent[], limit: number | undefined): WebAgent[] {
  const ranked = mostRecentAgents(agents, undefined);
  if (limit === undefined || ranked.length <= limit) return ranked;

  const representatives = new Map<string, WebAgent>();
  for (const agent of ranked) {
    const nodeId = agentRosterNodeId(agent);
    if (!nodeId || representatives.has(nodeId)) continue;
    representatives.set(nodeId, agent);
  }

  const kept = new Set<string>();
  const covered: WebAgent[] = [];
  for (const agent of representatives.values()) {
    if (covered.length >= limit) break;
    if (kept.has(agent.id)) continue;
    kept.add(agent.id);
    covered.push(agent);
  }
  for (const agent of ranked) {
    if (covered.length >= limit) break;
    if (kept.has(agent.id)) continue;
    kept.add(agent.id);
    covered.push(agent);
  }
  return mostRecentAgents(covered, undefined);
}
