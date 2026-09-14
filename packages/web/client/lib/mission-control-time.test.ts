import { describe, expect, test } from "bun:test";

import {
  MISSION_ACTIVITY_WINDOWS,
  MISSION_TIME_FILTERS,
  missionTimeFilterId,
  resolveMissionTimeFilter,
  type MissionTimeState,
} from "./mission-control-time.ts";

describe("mission time axis", () => {
  test("runs live → activity windows → all, in that order", () => {
    expect(MISSION_TIME_FILTERS.map((filter) => filter.id)).toEqual([
      "live",
      ...MISSION_ACTIVITY_WINDOWS.map((window) => window.label),
      "all",
    ]);
  });

  test("projects the stored filter + window onto one step", () => {
    expect(missionTimeFilterId({ activityFilter: "live", activityWindowMs: 300_000 })).toBe("live");
    expect(missionTimeFilterId({ activityFilter: "all", activityWindowMs: 300_000 })).toBe("all");
    expect(missionTimeFilterId({ activityFilter: "active", activityWindowMs: 1_800_000 })).toBe("30m");
  });

  test("a window step sets both fields; live and all keep the window for later", () => {
    let state: MissionTimeState = { activityFilter: "active", activityWindowMs: 86_400_000 };

    state = resolveMissionTimeFilter(state, "30m");
    expect(state).toEqual({ activityFilter: "active", activityWindowMs: 1_800_000 });

    state = resolveMissionTimeFilter(state, "live");
    expect(state).toEqual({ activityFilter: "live", activityWindowMs: 1_800_000 });
    expect(missionTimeFilterId(state)).toBe("live");

    state = resolveMissionTimeFilter(state, "all");
    expect(missionTimeFilterId(state)).toBe("all");

    // Coming back to a window step restores the exact window it names.
    state = resolveMissionTimeFilter(state, "24h");
    expect(missionTimeFilterId(state)).toBe("24h");
    expect(state.activityWindowMs).toBe(MISSION_ACTIVITY_WINDOWS[3].value);
  });

  test("a no-op step returns the same state so the store can skip notifying", () => {
    const state: MissionTimeState = { activityFilter: "live", activityWindowMs: 300_000 };
    expect(resolveMissionTimeFilter(state, "live")).toBe(state);
    expect(resolveMissionTimeFilter({ ...state, activityFilter: "active" }, "5m")).not.toBe(state);
  });
});
