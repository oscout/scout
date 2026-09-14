import { expect, test } from "bun:test";
import { characterContext } from "./character-context.ts";
import type { AgentLane } from "./agent-lanes-model.ts";
const now = 1800000000000;
const lane = { id: "one", agent: { state: "working" }, facts: { currentTask: "Improve the world map" }, observe: { events: [{ id: "a", at: now, t: 0, kind: "tool", tool: "bash", text: "", arg: "private command payload" }] } } as AgentLane;
test("command summaries avoid raw payloads", () => {
  expect(characterContext(lane, now).summary).toBe("Running a command");
});
test("completed work is described as historical", () => {
  const completed = { ...lane, facts: { ...lane.facts, turn: { phase: "complete" } } } as AgentLane;
  expect(characterContext(completed, now).summary).toBe("Last task · Improve the world map");
});
test("future events cannot become visible activity", () => {
  expect(characterContext(lane, now - 1000).activity).toBe("");
});
