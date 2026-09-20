import { describe, expect, test } from "bun:test";
import { buildSharedFloorLayout, floorDragMoved, islandDragPosition } from "./shared-floor-layout.ts";
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
  test("a large crew grows its island and every actor still stands on the painted deck", () => {
    const lanes = Array.from({ length: 20 }, (_, index) => lane(`a${index}`, "/a"));
    const layout = buildSharedFloorLayout([...lanes, lane("b", "/b"), lane("c", "/c")]);
    const [large, beside, below] = layout.groups;
    expect(large.actors).toHaveLength(20);
    expect(large.height).toBeGreaterThan(beside.height);
    for (const actor of large.actors) {
      // Feet inside the deck rectangle the art paints: 22%-78% across, 36%-58% down.
      expect(actor.x).toBeGreaterThanOrEqual(large.width * .22);
      expect(actor.x + 84).toBeLessThanOrEqual(large.width * .78);
      expect(actor.y + 84).toBeGreaterThanOrEqual(large.height * .36);
      expect(actor.y + 84).toBeLessThanOrEqual(large.height * .58);
    }
    // Balanced shelves: the two small islands share a shelf below the large one
    // rather than one beside it and one stranded below.
    expect(beside.y).toBeGreaterThan(large.y + large.height);
    expect(below.y).toBe(beside.y);
    expect(below.x).toBeGreaterThan(beside.x + beside.width);
    // The lone wide shelf centres itself over the wider shelf below.
    expect(large.x).toBeGreaterThan(beside.x);
    expect(layout.worldHeight).toBeGreaterThan(below.y + below.height);
  });
  test("unknown and relative workspaces remain separate by actor identity", () => {
    const layout = buildSharedFloorLayout([lane("a"), lane("b", "repo"), lane("c", "/repo/../repo")]);
    expect(layout.groups).toHaveLength(3);
    expect(new Set(layout.groups.map((group) => group.key)).size).toBe(3);
    expect(layout.groups[2].cwd).toBe("/repo");
  });
});

test("crew stay clear of each other and of the caption hung below the island", () => {
  const { groups } = buildSharedFloorLayout(Array.from({ length: 12 }, (_, i) => lane(`actor-${i}`, "/repo")));
  const island = groups[0];
  const actors = island.actors;
  for (let i = 0; i < actors.length; i++) for (let j = i + 1; j < actors.length; j++) {
    const horizontal = Math.abs(actors[i].x - actors[j].x);
    const vertical = Math.abs(actors[i].y - actors[j].y);
    expect(horizontal >= 84 + 20 || vertical >= 84).toBe(true);
  }
  // The caption hangs at 98.1% of the island; no actor label may reach it.
  for (const actor of actors) expect(actor.y + 140).toBeLessThan(island.height * .981);
});

describe("island placement", () => {
  const bottomOf = (group: { y: number; height: number }) => group.y + Math.round(group.height * .981) + 64;
  const overlaps = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < bottomOf(b) && b.y < bottomOf(a);

  test("manual positions are honored exactly and the world grows to contain them", () => {
    const lanes = [lane("a", "/a"), lane("b", "/b")];
    const auto = buildSharedFloorLayout(lanes);
    const moved = buildSharedFloorLayout(lanes, auto.memory, { positions: { [auto.groups[0].key]: { x: 4000, y: 3000 } } });
    expect(moved.groups[0].x).toBe(4000);
    expect(moved.groups[0].y).toBe(3000);
    expect(moved.worldWidth).toBeGreaterThanOrEqual(4000 + moved.groups[0].width);
    expect(moved.worldHeight).toBeGreaterThanOrEqual(3000 + moved.groups[0].height);
    // The packed sibling drops out of the manual island's shadow and starts at the margin.
    expect(moved.groups[1].x).toBe(30);
    expect(moved.groups[1].y).toBe(30);
  });
  test("a manual island at the first shelf slot is never stacked on", () => {
    const lanes = ["a", "b", "c", "d"].map((id) => lane(id, `/${id}`));
    const auto = buildSharedFloorLayout(lanes);
    const first = auto.groups[0];
    const placed = buildSharedFloorLayout(lanes, auto.memory, { positions: { [first.key]: { x: first.x, y: first.y } } });
    // The pinned island keeps slot zero exactly.
    expect([placed.groups[0].x, placed.groups[0].y]).toEqual([first.x, first.y]);
    // Every packed island clears its occupied bounds, caption included.
    for (const group of placed.groups.slice(1)) expect(overlaps(first, group)).toBe(false);
  });
  test("multiple manual islands stay exact and packed islands round or drop below them", () => {
    // A wide blocker parked at slot zero (too wide to round inside the row)
    // plus a second blocker floating mid-world.
    const lanes = [...Array.from({ length: 20 }, (_, i) => lane(`big-${i}`, "/big")), lane("a", "/a"), lane("b", "/b"), lane("c", "/c")];
    const auto = buildSharedFloorLayout(lanes);
    const big = auto.groups.find((group) => group.cwd === "/big")!;
    const b = auto.groups.find((group) => group.cwd === "/b")!;
    const positions = { [big.key]: { x: 30, y: 30 }, [b.key]: { x: 2000, y: 400 } };
    const placed = buildSharedFloorLayout(lanes, auto.memory, { positions });
    const placedBig = placed.groups.find((group) => group.cwd === "/big")!;
    const placedB = placed.groups.find((group) => group.cwd === "/b")!;
    expect([placedBig.x, placedBig.y]).toEqual([30, 30]);
    expect([placedB.x, placedB.y]).toEqual([2000, 400]);
    for (const group of placed.groups) {
      if (group.key === big.key || group.key === b.key) continue;
      expect(overlaps(group, placedBig)).toBe(false);
      expect(overlaps(group, placedB)).toBe(false);
    }
    // The first packed island drops below the wide blocker it cannot round.
    const a = placed.groups.find((group) => group.cwd === "/a")!;
    expect(a.y).toBeGreaterThanOrEqual(bottomOf(placedBig) + 60);
  });
  test("shelves balance widths and a lone wide shelf centres over the rest", () => {
    const lanes = [...Array.from({ length: 20 }, (_, i) => lane(`w-${i}`, "/wide")), lane("a", "/a"), lane("b", "/b")];
    const { groups } = buildSharedFloorLayout(lanes);
    const [wide, a, b] = groups;
    // The small pair shares the lower shelf instead of one riding beside the wide island.
    expect(a.y).toBe(b.y);
    expect(a.y).toBeGreaterThan(wide.y + wide.height);
    const lower = { x: a.x, width: b.x + b.width - a.x };
    expect(Math.abs((wide.x + wide.width / 2) - (lower.x + lower.width / 2))).toBeLessThanOrEqual(2);
  });
  test("crew spread follows the deck aspect and short rows stagger within their slack", () => {
    // Four actors form a 2×2 spread (the deck is twice as wide as deep), not a rank of three plus one.
    const { groups: quad } = buildSharedFloorLayout(Array.from({ length: 4 }, (_, i) => lane(`q-${i}`, "/quad")));
    const four = quad[0].actors;
    expect(Math.abs(four[0].y - four[1].y)).toBeLessThan(20);
    expect(Math.abs(four[2].y - four[3].y)).toBeLessThan(20);
    expect(four[2].y - four[0].y).toBeGreaterThan(100);
    // The deck narrows toward its back edge: the front row spans wider.
    expect(four[3].x - four[2].x).toBeGreaterThan(four[1].x - four[0].x);
    // Five actors spread 3+2; the short front row staggers off the back row's axis.
    const { groups: quint } = buildSharedFloorLayout(Array.from({ length: 5 }, (_, i) => lane(`s-${i}`, "/spread")));
    const five = quint[0].actors;
    const mid = (list: { x: number }[]) => (list[0].x + list[list.length - 1].x) / 2;
    expect(mid(five.slice(3))).toBeGreaterThan(mid(five.slice(0, 3)));
  });
  test("the collision pass leaves an all-auto layout byte-identical", () => {
    const lanes = ["a", "b", "c", "d"].map((id) => lane(id, `/${id}`));
    expect(buildSharedFloorLayout(lanes, undefined, { positions: {} })).toEqual(buildSharedFloorLayout(lanes));
  });
  test("manual-on-manual overlap stays the operator's choice", () => {
    const lanes = [lane("a", "/a"), lane("b", "/b")];
    const auto = buildSharedFloorLayout(lanes);
    const positions = { [auto.groups[0].key]: { x: 300, y: 300 }, [auto.groups[1].key]: { x: 300, y: 300 } };
    const placed = buildSharedFloorLayout(lanes, auto.memory, { positions });
    expect([placed.groups[0].x, placed.groups[0].y]).toEqual([300, 300]);
    expect([placed.groups[1].x, placed.groups[1].y]).toEqual([300, 300]);
  });
  test("a wide target aspect fills one shelf and a narrow one stacks, with no packed overlaps", () => {
    const lanes = ["a", "b", "c", "d"].map((id) => lane(id, `/${id}`));
    const wide = buildSharedFloorLayout(lanes, undefined, { targetAspect: 8 });
    expect(new Set(wide.groups.map((group) => group.y)).size).toBe(1);
    const tall = buildSharedFloorLayout(lanes, undefined, { targetAspect: 0.25 });
    expect(new Set(tall.groups.map((group) => group.y)).size).toBe(4);
    for (const layout of [wide, tall]) {
      for (let i = 0; i < layout.groups.length; i++) for (let j = i + 1; j < layout.groups.length; j++) {
        expect(overlaps(layout.groups[i], layout.groups[j])).toBe(false);
      }
    }
  });
  test("departed groups hold their packed slot and manual spots survive a departure round trip", () => {
    const all = [lane("a", "/a"), lane("b", "/b"), lane("c", "/c")];
    const first = buildSharedFloorLayout(all);
    const positions = { [first.groups[2].key]: { x: 2000, y: 1500 } };
    const absent = buildSharedFloorLayout([all[0]], first.memory, { positions });
    expect(absent.groups).toHaveLength(1);
    expect(absent.groups[0].x).toBe(first.groups[0].x);
    expect(absent.groups[0].y).toBe(first.groups[0].y);
    const returned = buildSharedFloorLayout(all, absent.memory, { positions });
    expect(returned.groups.find((group) => group.cwd === "/c")?.x).toBe(2000);
    expect(returned.groups.find((group) => group.cwd === "/c")?.y).toBe(1500);
  });
  test("the default pack is deterministic and keeps the empty world at its floor size", () => {
    const lanes = ["a", "b", "c", "d"].map((id) => lane(id, `/${id}`));
    const one = buildSharedFloorLayout(lanes);
    const two = buildSharedFloorLayout(lanes);
    expect(two).toEqual(one);
    expect(one.groups[0]).toMatchObject({ x: 30, y: 30 });
    expect(one.groups[1].x).toBeGreaterThan(one.groups[0].x + one.groups[0].width);
    expect(one.groups[2].y).toBeGreaterThan(one.groups[0].y);
    const empty = buildSharedFloorLayout([]);
    expect(empty.groups).toHaveLength(0);
    expect(empty.worldWidth).toBe(30 * 2 + 715);
    expect(empty.worldHeight).toBe(320);
  });
});

describe("island drag helpers", () => {
  test("a press under the threshold stays a click; at it, becomes a drag", () => {
    expect(floorDragMoved(0, 0)).toBe(false);
    expect(floorDragMoved(3, 3)).toBe(false);
    expect(floorDragMoved(4, 3)).toBe(true);
    expect(floorDragMoved(30, 40)).toBe(true);
  });
  test("screen deltas scale into world space and clamp to the world margin", () => {
    const start = { x: 100, y: 100 };
    expect(islandDragPosition(start, 50, -20, 2, "flat")).toEqual({ x: 125, y: 90 });
    // Zoomed far out, the same gesture covers more world.
    expect(islandDragPosition(start, 50, 0, 0.5, "flat").x).toBe(200);
    // Never dragged off the world's edge.
    expect(islandDragPosition(start, -500, -500, 1, "flat")).toEqual({ x: 30, y: 30 });
  });
  test("iso drags unproject screen deltas the way the camera projects them", () => {
    expect(islandDragPosition({ x: 100, y: 100 }, 100, 0, 1, "flat")).toEqual({ x: 200, y: 100 });
    const iso = islandDragPosition({ x: 100, y: 100 }, 100, 0, 1, "iso");
    // unprojectFloorPoint(100, 0) = { x: 100/√3, y: -100/√3 }
    expect(iso.x).toBe(100 + Math.round(100 / Math.sqrt(3)));
    expect(iso.y).toBe(100 - Math.round(100 / Math.sqrt(3)));
  });
});
