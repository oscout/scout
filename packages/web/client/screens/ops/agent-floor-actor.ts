import { normalizeAgentState } from "../../lib/agent-state.ts";
import { observeEventWallMs } from "../../lib/lane-observe.ts";
import type { AgentLane } from "./agent-lanes-model.ts";

export type FloorActorStation = "home" | "tools" | "edit" | "message";
export type FloorActorState = {
  station: FloorActorStation;
  posture: "quiet" | "working" | "attention" | "blocked";
  label: string;
};

/** Project the latest timestamped observation, never replay history as a walk queue. */
export function floorActorState(lane: AgentLane, now: number): FloorActorState {
  const state = normalizeAgentState(lane.agent.state, lane.agent);
  if (state === "needs_attention") return { station: "home", posture: "attention", label: "Needs attention" };
  if (state === "blocked") return { station: "home", posture: "blocked", label: "Blocked" };
  let latest: { station: FloorActorStation; at: number; label: string } | null = null;
  for (const event of lane.observe?.events ?? []) {
    if (!["tool", "message", "ask"].includes(event.kind)) continue;
    const at = observeEventWallMs(event, lane.observe?.metadata?.session?.sessionStart);
    if (at === null || at > now || now - at > 90_000 || (latest && at <= latest.at)) continue;
    const edit = event.diff || /^(edit|multi_?edit|write|apply_?patch|patch_apply|str_?replace|notebook_?edit|create_file)/i.test(event.tool?.trim() ?? "");
    latest = { at, station: event.kind !== "tool" ? "message" : edit ? "edit" : "tools",
      label: event.kind !== "tool" ? "Message" : event.tool?.trim() || "Tool activity" };
  }
  // A completed turn settles immediately even if its last output is recent.
  if (!latest || lane.facts?.turn?.phase === "complete") return { station: "home", posture: "quiet", label: "Quiet" };
  return { station: latest.station, posture: "working", label: latest.label };
}
