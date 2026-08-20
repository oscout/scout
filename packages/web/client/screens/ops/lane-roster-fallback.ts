import { normalizeAgentState } from "../../lib/agent-state.ts";
import type { Agent } from "../../lib/types.ts";
import {
  isIdleCodexRelay,
  isLaneRosterFleetAgent,
  lanePrimaryLabel,
  laneStatusLabel,
} from "./agent-lanes-model.ts";
import type { LaneRosterEntry } from "./lane-roster-store.ts";

/** Fleet-derived interim roster while the lane deck has not published its rendered columns yet. */
export function buildFallbackLaneRoster(agents: Agent[]): LaneRosterEntry[] {
  return agents
    .filter((agent) => !isIdleCodexRelay(agent) && isLaneRosterFleetAgent(agent))
    .sort((left, right) => {
      const recency = (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
      if (recency !== 0) return recency;
      return lanePrimaryLabel(left, "scout").localeCompare(lanePrimaryLabel(right, "scout"));
    })
    .map((agent) => ({
      id: agent.id,
      label: lanePrimaryLabel(agent, "scout"),
      statusLabel: laneStatusLabel(agent, "scout"),
      tone: normalizeAgentState(agent.state, agent),
      agentId: agent.id,
      updatedAt: agent.updatedAt ?? undefined,
    }));
}
