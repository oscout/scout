import { test, expect } from "bun:test";
import { floorContextEvents } from "./floor-context-model.ts";
import type { AgentLane } from "./agent-lanes-model.ts";
import type { ObserveEvent } from "../../lib/types.ts";
const now = 1_800_000_000_000;
const event = (id: string, age: number, kind: ObserveEvent["kind"] = "tool"): ObserveEvent => ({ id, at: now - age, kind, t: 0, text: id });
const lane = (id: string, events: ObserveEvent[]): AgentLane => ({ id, observe: { events, files: [] } } as unknown as AgentLane);

test("room feed is scoped, timestamped, deduplicated per actor and newest first", () => {
  const input = [lane("one", [event("old", 901_000), event("same", 1000), event("same", 1000), event("message", 100, "message"), event("future", -500)]), lane("two", [event("same", 500)])];
  const result = floorContextEvents(input, now, ["tool"]);
  expect(result.map((row) => [row.lane.id, row.event.id])).toEqual([["two", "same"], ["one", "same"]]);
  expect(floorContextEvents(input, now, ["message", "ask"]).map((row) => row.event.id)).toEqual(["message"]);
});

test("context feed stays bounded and excludes events without known wall time", () => {
  const events = Array.from({ length: 100 }, (_, i) => event(String(i), i * 100));
  events.push({ ...event("undated", 0), at: undefined });
  const result = floorContextEvents([lane("one", events)], now, ["tool"]);
  expect(result).toHaveLength(24);
  expect(result.some((row) => row.event.id === "undated")).toBe(false);
});
