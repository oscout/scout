import { test, expect } from "bun:test";
import { replayFloorLane } from "./floor-replay-model.ts";
import { floorActorState } from "./agent-floor-actor.ts";
import type { AgentLane } from "./agent-lanes-model.ts";
const lane = { id: "a", agent: { state: "blocked" }, facts: { turn: { phase: "complete" }, currentTask: "Current task" }, observe: { events: [{ id: "1", kind: "tool", tool: "Bash", at: (1700000000000 + 100000), t: 0, text: "cmd" }, { id: "2", kind: "tool", tool: "Edit", at: (1700000000000 + 120000), t: 20, text: "file" }], files: [] } } as unknown as AgentLane;
test("replay excludes future events and current state when reconstructing positions", () => {
  expect(replayFloorLane(lane, (1700000000000 + 99999))).toBeNull();
  const past = replayFloorLane(lane, (1700000000000 + 110000))!;
  expect(past.observe!.events).toHaveLength(1);
  expect(past.facts).toBeUndefined();
  expect(floorActorState(past, (1700000000000 + 110000)).station).toBe("tools");
  expect(floorActorState(replayFloorLane(lane, (1700000000000 + 120000))!, (1700000000000 + 120000)).station).toBe("edit");
  expect(floorActorState(replayFloorLane(lane, (1700000000000 + 220001))!, (1700000000000 + 220001)).station).toBe("home");
});
