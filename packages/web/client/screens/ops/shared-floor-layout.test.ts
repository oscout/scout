import { describe, expect, test } from "bun:test";
import { buildSharedFloorLayout } from "./shared-floor-layout.ts";
import type { AgentLane } from "./agent-lanes-model.ts";
const lane = (id: string, cwd?: string): AgentLane => ({ id, agent: { name: id, cwd }, observe: null } as AgentLane);

describe("shared floor placement", () => {
  test("roster reordering preserves groups and individual actor slots without mutating memory", () => {
    const lanes = [lane("a", "/repo/./"), lane("b", "/repo"), lane("c", "/other")];
    const first = buildSharedFloorLayout(lanes);
    const snapshot = JSON.stringify(first.memory);
    const reordered = buildSharedFloorLayout([...lanes].reverse(), first.memory);
    expect(reordered).toEqual(first);
    expect(JSON.stringify(first.memory)).toBe(snapshot);
  });
  test("departed and returning groups retain their locations and vacant actors retain slots", () => {
    const lanes = [lane("a", "/a"), lane("b", "/b"), lane("c", "/c"), lane("d", "/a")];
    const first = buildSharedFloorLayout(lanes);
    const absent = buildSharedFloorLayout([lanes[2], lanes[3]], first.memory);
    expect(absent.groups.find((group) => group.cwd === "/c")?.y).toBe(first.groups[2].y);
    expect(absent.groups[0].actors[0].x).toBe(first.groups[0].actors[1].x);
    const returned = buildSharedFloorLayout(lanes, absent.memory);
    expect(returned).toEqual(first);
  });
  test("large groups have sufficient height and later rows do not overlap", () => {
    const lanes = Array.from({ length: 20 }, (_, index) => lane(`a${index}`, "/a"));
    const layout = buildSharedFloorLayout([...lanes, lane("b", "/b"), lane("c", "/c")]);
    const [large, beside, below] = layout.groups;
    expect(large.actors).toHaveLength(20);
    for (const actor of large.actors) {
      expect(actor.y + 140).toBeLessThanOrEqual(large.height);
      expect(actor.x + 84).toBeLessThanOrEqual(large.width);
    }
    expect(beside.x).toBeGreaterThan(large.x + large.width);
    expect(below.y).toBeGreaterThan(large.y + large.height);
    expect(layout.worldHeight).toBeGreaterThan(below.y + below.height);
  });
  test("unknown and relative workspaces remain separate by actor identity", () => {
    const layout = buildSharedFloorLayout([lane("a"), lane("b", "repo"), lane("c", "/repo/../repo")]);
    expect(layout.groups).toHaveLength(3);
    expect(new Set(layout.groups.map((group) => group.key)).size).toBe(3);
    expect(layout.groups[2].cwd).toBe("/repo");
  });
});

test("automatic positions leave room for captions and adjacent rows", () => {
  const { groups } = buildSharedFloorLayout(Array.from({ length: 12 }, (_, i) => lane(`actor-${i}`, "/repo")));
  const actors = groups[0].actors;
  for (let i = 0; i < actors.length; i++) for (let j = i + 1; j < actors.length; j++) {
    const horizontal = Math.abs(actors[i].x - actors[j].x);
    const vertical = Math.abs(actors[i].y - actors[j].y);
    expect(horizontal >= 145 + 40 || vertical >= 140 + 10).toBe(true);
  }
});
