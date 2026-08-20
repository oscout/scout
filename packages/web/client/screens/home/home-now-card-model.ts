import { agentLaneToCardModel } from "../ops/agent-lane-card-model.ts";
import type { AgentLane } from "../ops/agent-lanes-model.ts";
import type { Agent, ObserveData } from "../../lib/types.ts";
import type { AgentLaneCardModel } from "../ops/AgentLaneCard.tsx";

export function homeNowCardLaneModel(
  agent: Agent,
  observeData: ObserveData | null | undefined,
  observeLive: boolean,
  nowMs: number,
): AgentLaneCardModel {
  const lane: AgentLane = {
    id: agent.id,
    agent,
    source: agent.id.startsWith("native:") ? "native" : "scout",
    observe: observeData ?? null,
    lastActiveAt: nowMs,
    current: observeLive,
  };
  return agentLaneToCardModel(lane, { isLive: observeLive, nowMs });
}

export function homeNowCardHasDetail(model: AgentLaneCardModel): boolean {
  return model.stats.tools > 0
    || model.stats.files > 0
    || model.context !== null
    || model.pops.edits.rows.length > 0
    || model.pops.files.rows.length > 0;
}