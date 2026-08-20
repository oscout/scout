import { isSyntheticAgentId } from "../../lib/synthetic-agent-routing.ts";
import type { Agent, Route } from "../../lib/types.ts";
import { buildLaneSessionStats } from "./agent-lane-detail.ts";
import type { AgentLane } from "./agent-lanes-model.ts";

/** Lane cards sometimes synthesize agents from tail transcripts or terminal
 *  sessions. Those ids are not registered in the agents directory. */
export function isLaneSyntheticAgent(agent: Agent): boolean {
  return isSyntheticAgentId(agent.id);
}

export function laneSessionId(lane: AgentLane): string | null {
  const sessionId = buildLaneSessionStats(lane).sessionId?.trim();
  return sessionId || null;
}

export function laneSessionRoute(
  lane: AgentLane,
): Extract<Route, { view: "sessions" }> | null {
  const sessionId = laneSessionId(lane);
  if (!sessionId) return null;
  const agentId = isLaneSyntheticAgent(lane.agent) ? undefined : lane.agent.id;
  return { view: "sessions", sessionId, ...(agentId ? { agentId } : {}) };
}

/** Full trace from a lane always opens the session observe surface — never the
 *  agents directory, which cannot resolve synthetic/native lane ids. */
export function laneTraceRoute(lane: AgentLane): Extract<Route, { view: "sessions" }> | null {
  return laneSessionRoute(lane);
}

export function laneProfileRoute(
  lane: AgentLane,
): Extract<Route, { view: "agents-v2" }> | null {
  if (isLaneSyntheticAgent(lane.agent)) return null;
  return { view: "agents-v2", agentId: lane.agent.id, tab: "profile" };
}
