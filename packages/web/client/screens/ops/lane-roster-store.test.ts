import { describe, expect, mock, test } from "bun:test";
import type * as ReactModule from "react";

// @ts-expect-error -- the relative .js path keeps bun's runtime resolution to the real react
// module; a bare "react" specifier would be hijacked by tsconfig `paths` to the .d.ts (the store
// imports `useSyncExternalStore`). The cast restores the types the path import otherwise loses.
const React = (await import("../../../node_modules/react/index.js")) as typeof ReactModule;
mock.module("react", () => React);

const {
  getLaneRosterSnapshot,
  publishLaneRoster,
  subscribeLaneRoster,
} = await import("./lane-roster-store.ts");
type LaneRosterEntry = import("./lane-roster-store.ts").LaneRosterEntry;

function entry(overrides: Partial<LaneRosterEntry> & { id: string }): LaneRosterEntry {
  return {
    label: overrides.id,
    statusLabel: "codex",
    tone: "in_turn",
    ...overrides,
  };
}

describe("lane roster store", () => {
  test("publishes the deck roster in order and notifies subscribers", () => {
    let notified = 0;
    const unsubscribe = subscribeLaneRoster(() => {
      notified += 1;
    });
    const roster = [entry({ id: "a" }), entry({ id: "b" })];
    publishLaneRoster(roster);
    expect(getLaneRosterSnapshot()).toBe(roster);
    expect(notified).toBe(1);
    unsubscribe();
  });

  test("keeps a stable snapshot reference when the projection is unchanged", () => {
    publishLaneRoster([entry({ id: "a", updatedAt: 10 })]);
    const first = getLaneRosterSnapshot();
    let notified = 0;
    const unsubscribe = subscribeLaneRoster(() => {
      notified += 1;
    });
    // Same content, fresh array/object identities — must not churn the store.
    publishLaneRoster([entry({ id: "a", updatedAt: 10 })]);
    expect(getLaneRosterSnapshot()).toBe(first);
    expect(notified).toBe(0);
    unsubscribe();
  });

  test("re-emits when a lane's activity time advances", () => {
    publishLaneRoster([entry({ id: "a", updatedAt: 10 })]);
    let notified = 0;
    const unsubscribe = subscribeLaneRoster(() => {
      notified += 1;
    });
    publishLaneRoster([entry({ id: "a", updatedAt: 20 })]);
    expect(notified).toBe(1);
    unsubscribe();
  });

  test("re-emits when column order changes even if the set is identical", () => {
    publishLaneRoster([entry({ id: "a" }), entry({ id: "b" })]);
    let notified = 0;
    const unsubscribe = subscribeLaneRoster(() => {
      notified += 1;
    });
    publishLaneRoster([entry({ id: "b" }), entry({ id: "a" })]);
    expect(notified).toBe(1);
    expect(getLaneRosterSnapshot()?.map((item) => item.id)).toEqual(["b", "a"]);
    unsubscribe();
  });

  test("clears the roster to null on deck unmount", () => {
    publishLaneRoster([entry({ id: "a" })]);
    let notified = 0;
    const unsubscribe = subscribeLaneRoster(() => {
      notified += 1;
    });
    publishLaneRoster(null);
    expect(getLaneRosterSnapshot()).toBeNull();
    expect(notified).toBe(1);
    unsubscribe();
  });
});
