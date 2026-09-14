import { expect, test } from "bun:test";
import { floorDeskOrder, floorRelations } from "./floor-memory.ts";
import type { AgentLane } from "./agent-lanes-model.ts";

test("desks preserve vacancies, returning actors and newcomers without duplicates", () => {
  expect(floorDeskOrder(["a", "b", "c"], ["c", "a", "d"])).toEqual(["a", "b", "c", "d"]);
  expect(floorDeskOrder(["a", "b", "c", "d"], ["b", "d"])).toEqual(["a", "b", "c", "d"]);
  expect(floorDeskOrder(["a", "a"], ["a", "b"])).toEqual(["a", "b"]);
});
const lane = (id: string, session: string, parent?: string) => ({ id, agent: { harnessSessionId: session }, facts: { parentSessionId: parent } }) as AgentLane;
test("lineage requires exact unique session identity and excludes self", () => {
  const parent = lane("p", "session-parent"); const child = lane("c", "session-child", "session-parent");
  expect(floorRelations([parent, child])).toEqual([{ parent, child }]);
  expect(floorRelations([child])).toEqual([]);
  expect(floorRelations([parent, lane("duplicate", "session-parent"), child])).toEqual([]);
  expect(floorRelations([lane("self", "self", "self")])).toEqual([]);
});
