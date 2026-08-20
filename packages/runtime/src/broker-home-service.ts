import type { RuntimeRegistrySnapshot } from "./registry.js";
import type { ActivityItem } from "./sqlite-store.js";
import {
  brokerConversationChannel,
  brokerTargetProjectRoot,
  summarizeHomeAgent,
} from "./broker-conversation-helpers.js";
import {
  homeEndpointForAgent,
  isInactiveLocalAgent,
} from "./broker-endpoint-selection.js";
import {
  isWorkingFlightState,
  isReconciledStaleFlightActivityItem,
} from "./broker-local-invocation-helpers.js";

export type BrokerHomeAgent = {
  id: string;
  title: string;
  role: string | null;
  summary: string | null;
  projectRoot: string | null;
  state: "offline" | "available" | "working";
  reachable: boolean;
  statusLabel: string;
  statusDetail: string | null;
  activeTask: null;
  lastSeenAt: number | null;
};

export type BrokerHomeActivity = {
  id: string;
  kind: "system" | "message";
  actorId: string;
  actorName: string;
  title: string;
  detail: string | null;
  conversationId: string | null;
  channel: string | null;
  timestamp: number;
};

export type BrokerHomePayload = {
  updatedAt: number;
  agents: BrokerHomeAgent[];
  activity: BrokerHomeActivity[];
};

// /api/agents caps its roster at 100. Keep the compact broker home projection
// at the same bound so every list row can receive authoritative flight state;
// truncating this feed used to leave lower-ranked rows stuck on SQLite's stale
// endpoint-derived `working` value.
const BROKER_HOME_AGENT_LIMIT = 100;

type BrokerHomeServiceDeps = {
  runtimeSnapshot: () => RuntimeRegistrySnapshot;
  listActivityItems: (options: { limit: number }) => Promise<ActivityItem[]>;
  actorDisplayName: (snapshot: RuntimeRegistrySnapshot, actorId: string) => string;
  operatorActorId: string;
  now?: () => number;
};

export class BrokerHomeService {
  readonly #deps: BrokerHomeServiceDeps;

  constructor(deps: BrokerHomeServiceDeps) {
    this.#deps = deps;
  }

  async read(): Promise<BrokerHomePayload> {
    const snapshot = this.#deps.runtimeSnapshot();
    return {
      updatedAt: this.#now(),
      agents: this.#agents(snapshot),
      activity: this.#activity(snapshot, await this.#deps.listActivityItems({ limit: 96 })),
    };
  }

  #agents(snapshot: RuntimeRegistrySnapshot): BrokerHomeAgent[] {
    const workingAgentIds = new Set(
      Object.values(snapshot.flights)
        .filter((flight) => isWorkingFlightState(flight.state))
        .map((flight) => flight.targetAgentId),
    );
    return Object.values(snapshot.agents)
      .filter((agent) => !isInactiveLocalAgent(agent))
      .map((agent) => {
        const endpoint = homeEndpointForAgent(snapshot, agent.id);
        const status = summarizeHomeAgent(endpoint, workingAgentIds.has(agent.id));
        return {
          id: agent.id,
          title: this.#deps.actorDisplayName(snapshot, agent.id),
          role: typeof agent.metadata?.role === "string" ? agent.metadata.role : null,
          summary: typeof agent.metadata?.summary === "string" ? agent.metadata.summary : null,
          projectRoot: brokerTargetProjectRoot(agent, endpoint),
          state: status.state,
          reachable: status.reachable,
          statusLabel: status.statusLabel,
          statusDetail: status.statusDetail,
          activeTask: null,
          lastSeenAt: status.lastSeenAt,
        };
      })
      .sort((left, right) => agentHomeRank(left.state) - agentHomeRank(right.state)
        || left.title.localeCompare(right.title))
      .slice(0, BROKER_HOME_AGENT_LIMIT);
  }

  #activity(
    snapshot: RuntimeRegistrySnapshot,
    items: ActivityItem[],
  ): BrokerHomeActivity[] {
    return items
      .filter((item) => !isReconciledStaleFlightActivityItem(item))
      .filter((item) => Boolean(item.messageId))
      .slice(0, 24)
      .map((item) => {
        const actorId = item.actorId ?? this.#deps.operatorActorId;
        const actorName = this.#deps.actorDisplayName(snapshot, actorId);
        return {
          id: item.messageId ?? item.id,
          kind: item.kind === "status_message" ? "system" : "message",
          actorId,
          actorName,
          title: item.title ?? actorName,
          detail: item.summary ?? item.title ?? null,
          conversationId: item.conversationId ?? null,
          channel: brokerConversationChannel(snapshot, item.conversationId),
          timestamp: item.ts,
        };
      });
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }
}

function agentHomeRank(state: BrokerHomeAgent["state"]): number {
  switch (state) {
    case "working":
      return 0;
    case "available":
      return 1;
    case "offline":
    default:
      return 2;
  }
}
