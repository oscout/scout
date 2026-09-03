import type { FleetAsk, SessionEntry } from "./types.ts";

const ACTIVE_ASK_STATUSES = new Set<FleetAsk["status"]>([
  "working",
  "queued",
  "needs_attention",
]);

type AskSession = Pick<
  SessionEntry,
  "id" | "equivalentConversationIds" | "agentId"
>;

export type FleetActiveAskIndex = {
  /** Every active ask, retained once so agent-level surfaces can aggregate it. */
  asks: readonly FleetAsk[];
  /** Conversation-scoped asks never fall through to another conversation. */
  byConversationId: ReadonlyMap<string, FleetAsk>;
  /** Agent fallback contains only asks that have no conversation identity. */
  fallbackByAgentId: ReadonlyMap<string, FleetAsk>;
  /** Complete agent-level inventory for map/fleet surfaces. */
  byAgentId: ReadonlyMap<string, readonly FleetAsk[]>;
};

function preferAsk(current: FleetAsk | undefined, candidate: FleetAsk): FleetAsk {
  if (!current) return candidate;
  const rank: Record<FleetAsk["status"], number> = {
    needs_attention: 5,
    working: 4,
    queued: 3,
    failed: 2,
    completed: 1,
  };
  const rankDelta = rank[candidate.status] - rank[current.status];
  if (rankDelta !== 0) return rankDelta > 0 ? candidate : current;
  if (candidate.updatedAt !== current.updatedAt) {
    return candidate.updatedAt > current.updatedAt ? candidate : current;
  }
  return candidate.invocationId.localeCompare(current.invocationId) < 0
    ? candidate
    : current;
}

function keepPreferred(
  map: Map<string, FleetAsk>,
  key: string,
  ask: FleetAsk,
): void {
  map.set(key, preferAsk(map.get(key), ask));
}

export function buildFleetActiveAskIndex(
  asks: readonly FleetAsk[],
): FleetActiveAskIndex {
  const active = asks.filter((ask) => ACTIVE_ASK_STATUSES.has(ask.status));
  const byConversationId = new Map<string, FleetAsk>();
  const fallbackByAgentId = new Map<string, FleetAsk>();
  const byAgentId = new Map<string, FleetAsk[]>();

  for (const ask of active) {
    const agentAsks = byAgentId.get(ask.agentId);
    if (agentAsks) agentAsks.push(ask);
    else byAgentId.set(ask.agentId, [ask]);

    const conversationId = ask.conversationId?.trim();
    if (conversationId) {
      keepPreferred(byConversationId, conversationId, ask);
    } else {
      keepPreferred(fallbackByAgentId, ask.agentId, ask);
    }
  }

  return {
    asks: active,
    byConversationId,
    fallbackByAgentId,
    byAgentId,
  };
}

/** Resolve session state by its canonical/equivalent conversations first. */
export function fleetAskForSession(
  index: FleetActiveAskIndex,
  session: AskSession,
): FleetAsk | undefined {
  let best: FleetAsk | undefined;
  const conversationIds = new Set([
    session.id,
    ...(session.equivalentConversationIds ?? []),
  ]);
  for (const conversationId of conversationIds) {
    const ask = index.byConversationId.get(conversationId);
    if (ask) best = preferAsk(best, ask);
  }
  if (best) return best;
  return session.agentId
    ? index.fallbackByAgentId.get(session.agentId)
    : undefined;
}

/** Agent-level surfaces may aggregate every ask, including conversation asks. */
export function bestFleetAskForAgentIds(
  index: FleetActiveAskIndex,
  agentIds: Iterable<string>,
): FleetAsk | undefined {
  let best: FleetAsk | undefined;
  for (const agentId of agentIds) {
    for (const ask of index.byAgentId.get(agentId) ?? []) {
      best = preferAsk(best, ask);
    }
  }
  return best;
}

export function hasFleetActiveAskForAgent(
  index: FleetActiveAskIndex,
  agentId: string,
): boolean {
  return (index.byAgentId.get(agentId)?.length ?? 0) > 0;
}
