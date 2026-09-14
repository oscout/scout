import { observeEventWallMs } from "../../lib/lane-observe.ts";
import type { AgentLane } from "./agent-lanes-model.ts";
import type { ObserveEvent } from "../../lib/types.ts";

export function floorContextEvents(lanes: AgentLane[], now: number, kinds: ObserveEvent["kind"][], limit = 24) {
  const seen = new Set<string>();
  return lanes.flatMap((lane) => (lane.observe?.events ?? []).flatMap((event) => {
    const at = observeEventWallMs(event, lane.observe?.metadata?.session?.sessionStart);
    const key = `${lane.id}:${event.id}`;
    if (!kinds.includes(event.kind) || at === null || at > now || now - at > 15 * 60_000 || seen.has(key)) return [];
    seen.add(key);
    return [{ lane, event, at }];
  })).sort((a, b) => b.at - a.at).slice(0, limit);
}
