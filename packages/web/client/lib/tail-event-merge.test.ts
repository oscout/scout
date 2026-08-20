import { describe, expect, test } from "bun:test";

import {
  appendLiveTailEvent,
  dedupeTailEvents,
  mergeHydratedTailEvents,
  tailEventKey,
} from "./tail-event-merge.ts";
import type { TailEvent } from "./types.ts";

function event(overrides: Partial<TailEvent> & { id: string }): TailEvent {
  return {
    ts: 1_000,
    source: "codex",
    sessionId: "S",
    pid: 1,
    parentPid: null,
    project: "openscout",
    cwd: "/repo",
    harness: "scout-managed",
    kind: "tool",
    summary: "Read file.ts",
    ...overrides,
  };
}

describe("tailEventKey", () => {
  test("the same transcript line keys identically despite divergent ids", () => {
    // Live tail and disk replay mint different ids for the same line (line-offset
    // is computed differently per path) — content identity must still match.
    const live = event({ id: "codex:S:0" });
    const replay = event({ id: "codex:S:312" });
    expect(tailEventKey(live)).toBe(tailEventKey(replay));
  });

  test("distinct events with the same summary at different times stay distinct", () => {
    const first = event({ id: "a", ts: 1_000 });
    const second = event({ id: "b", ts: 2_000 });
    expect(tailEventKey(first)).not.toBe(tailEventKey(second));
  });
});

describe("appendLiveTailEvent", () => {
  test("drops a live event already held under a different id (the dup case)", () => {
    const hydrated = [event({ id: "codex:S:312" })];
    const next = appendLiveTailEvent(hydrated, event({ id: "codex:S:0" }), 500);
    expect(next).toBe(hydrated); // unchanged reference — nothing appended
    expect(next).toHaveLength(1);
  });

  test("appends a genuinely new live event", () => {
    const hydrated = [event({ id: "codex:S:312", ts: 1_000 })];
    const next = appendLiveTailEvent(hydrated, event({ id: "codex:S:313", ts: 2_000, summary: "Edit x" }), 500);
    expect(next).toHaveLength(2);
    expect(next[1].summary).toBe("Edit x");
  });

  test("caps to the recent limit, keeping the newest", () => {
    const previous = [event({ id: "1", ts: 1, summary: "one" }), event({ id: "2", ts: 2, summary: "two" })];
    const next = appendLiveTailEvent(previous, event({ id: "3", ts: 3, summary: "three" }), 2);
    expect(next.map((e) => e.summary)).toEqual(["two", "three"]);
  });
});

describe("mergeHydratedTailEvents", () => {
  test("merges disk history with in-flight live events, collapsing the overlap", () => {
    const liveDuringFetch = [event({ id: "codex:S:0", ts: 2_000, summary: "newest live" })];
    const hydrated = [
      event({ id: "codex:S:310", ts: 1_000, summary: "old" }),
      event({ id: "codex:S:312", ts: 2_000, summary: "newest live" }), // same line as the live one
    ];
    const merged = mergeHydratedTailEvents(liveDuringFetch, hydrated, 500);
    expect(merged.filter((e) => e.summary === "newest live")).toHaveLength(1);
    expect(merged).toHaveLength(2);
  });
});

describe("dedupeTailEvents", () => {
  test("first occurrence wins", () => {
    const deduped = dedupeTailEvents([
      event({ id: "codex:S:312", summary: "x" }),
      event({ id: "codex:S:0", summary: "x" }),
    ]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].id).toBe("codex:S:312");
  });
});
