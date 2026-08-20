import { describe, expect, test } from "bun:test";

import {
  assignEntranceIndices,
  entranceStaggerIndex,
  HOME_ENTRANCE_STAGGER_CAP,
  newlySeenIds,
} from "./home-entrance.ts";

describe("newlySeenIds", () => {
  test("returns every id on a virgin set", () => {
    expect(newlySeenIds(new Set(), ["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });

  test("filters out ids already seen, preserving visible order", () => {
    const seen = new Set(["b"]);
    expect(newlySeenIds(seen, ["a", "b", "c"])).toEqual(["a", "c"]);
  });

  test("returns empty when nothing is new (steady-state refresh)", () => {
    const seen = new Set(["a", "b", "c"]);
    expect(newlySeenIds(seen, ["a", "b", "c"])).toEqual([]);
  });

  test("a unit appearing in a later refresh is reported as new on its own", () => {
    const seen = new Set(["a", "b"]);
    expect(newlySeenIds(seen, ["a", "b", "d"])).toEqual(["d"]);
  });

  test("does not mutate the input set", () => {
    const seen = new Set(["a"]);
    newlySeenIds(seen, ["a", "b"]);
    expect([...seen]).toEqual(["a"]);
  });

  test("ordering is by visible order, not seen order", () => {
    const seen = new Set(["c"]);
    expect(newlySeenIds(seen, ["c", "z", "a"])).toEqual(["z", "a"]);
  });
});

describe("assignEntranceIndices", () => {
  test("assigns a cascade from 0 on first sight, clamped to the cap", () => {
    const assigned = new Map<string, number>();
    const ids = Array.from({ length: 14 }, (_, i) => `id-${i}`);
    assignEntranceIndices(assigned, ids);
    expect(assigned.get("id-0")).toBe(0);
    expect(assigned.get("id-5")).toBe(5);
    expect(assigned.get("id-13")).toBe(HOME_ENTRANCE_STAGGER_CAP);
  });

  test("assignments are sticky — re-render keeps original indices", () => {
    const assigned = new Map<string, number>();
    assignEntranceIndices(assigned, ["a", "b"]);
    assignEntranceIndices(assigned, ["a", "b"]);
    expect(assigned.get("a")).toBe(0);
    expect(assigned.get("b")).toBe(1);
    expect(assigned.size).toBe(2);
  });

  test("a unit arriving in a later refresh cascades from 0 on its own", () => {
    const assigned = new Map<string, number>();
    assignEntranceIndices(assigned, ["a", "b"]);
    assignEntranceIndices(assigned, ["a", "b", "d"]);
    expect(assigned.get("d")).toBe(0);
    expect(assigned.get("b")).toBe(1);
  });
});

describe("entranceStaggerIndex", () => {
  test("passes through positions under the cap", () => {
    expect(entranceStaggerIndex(0)).toBe(0);
    expect(entranceStaggerIndex(5)).toBe(5);
    expect(entranceStaggerIndex(HOME_ENTRANCE_STAGGER_CAP)).toBe(HOME_ENTRANCE_STAGGER_CAP);
  });

  test("clamps positions beyond the cap so large fleets plateau", () => {
    expect(entranceStaggerIndex(11)).toBe(HOME_ENTRANCE_STAGGER_CAP);
    expect(entranceStaggerIndex(200)).toBe(HOME_ENTRANCE_STAGGER_CAP);
  });

  test("honors a custom cap", () => {
    expect(entranceStaggerIndex(9, 3)).toBe(3);
    expect(entranceStaggerIndex(2, 3)).toBe(2);
  });

  test("never returns negative for odd input", () => {
    expect(entranceStaggerIndex(-4)).toBe(0);
  });
});
