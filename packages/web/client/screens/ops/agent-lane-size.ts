import {
  AGENT_LANE_WIDTH_TIERS,
  readDefaultLaneWidthTier,
  type AgentLaneWidthTier,
} from "./lane-deck.ts";

export type { AgentLaneWidthTier, AgentLaneWidthTier as AgentLaneSize };

export { AGENT_LANE_WIDTH_TIERS, readDefaultLaneWidthTier as readAgentLaneSize };

export function agentLaneSizeClass(_size: AgentLaneWidthTier): string {
  return "";
}