import { describe, expect, test } from "bun:test";
import { floorActorState } from "./agent-floor-actor.ts";
import type { AgentLane } from "./agent-lanes-model.ts";
import type { ObserveEvent } from "../../lib/types.ts";

const now = 1_800_000_000_000;
function lane(events: ObserveEvent[], state = "working"): AgentLane {
  return { id: "actor-1", agent: { name: "Scout", state }, observe: { events } } as AgentLane;
}
function event(id: string, at: number, tool = "Read"): ObserveEvent {
  return { id, at, t: 0, kind: "tool", text: tool, tool };
}

describe("floor actor projection", () => {
  test("latest wall-clock event wins even with out-of-order replay and duplicates", () => {
    const edit = event("edit", now - 1_000, "apply_patch");
    const input = lane([edit, event("read", now - 5_000), edit]);
    expect(floorActorState(input, now).station).toBe("edit");
    expect(floorActorState(input, now)).toEqual(floorActorState(lane([edit]), now));
  });
  test("historical, undated and future events do not animate current work", () => {
    expect(floorActorState(lane([event("old", now - 100_000), { ...event("undated", now), at: undefined }, event("future", now + 1000)]), now).posture).toBe("quiet");
  });
  test("attention and blocked states override recent activity", () => {
    expect(floorActorState(lane([event("read", now)], "needs_attention"), now)).toMatchObject({ posture: "attention", station: "home" });
    expect(floorActorState(lane([event("read", now)], "blocked"), now).posture).toBe("blocked");
  });
  test("actors settle after freshness expires or a turn completes", () => {
    const input = lane([event("read", now)]);
    expect(floorActorState(input, now).station).toBe("tools");
    expect(floorActorState(input, now + 90_001).station).toBe("home");
    input.facts = { turn: { phase: "complete" }, touchedFiles: [] };
    expect(floorActorState(input, now).posture).toBe("quiet");
  });
  test("messages use comms, and relative time resolves against session start", () => {
    expect(floorActorState(lane([{ ...event("msg", now), kind: "message" }]), now).station).toBe("message");
    const input = lane([{ ...event("read", now), at: undefined, t: 5 }]);
    input.observe!.metadata = { session: { sessionStart: now - 5_000 } } as NonNullable<AgentLane["observe"]>["metadata"];
    expect(floorActorState(input, now).station).toBe("tools");
  });
});
