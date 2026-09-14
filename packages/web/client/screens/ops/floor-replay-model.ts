import { observeEventWallMs } from "../../lib/lane-observe.ts";
import type { AgentLane } from "./agent-lanes-model.ts";

/** Reconstruct activity, without applying today's attention, task or turn state to the past. */
export function replayFloorLane(lane: AgentLane, cursor: number): AgentLane | null {
  if (!lane.observe) return null;
  const events = lane.observe.events.filter((event) => {
    const at = observeEventWallMs(event, lane.observe?.metadata?.session?.sessionStart);
    return at !== null && at <= cursor;
  });
  if (!events.length) return null;
  return { ...lane, facts: undefined, agent: { ...lane.agent, state: "idle", staleLocalRegistration: false }, observe: { ...lane.observe, events } };
}
