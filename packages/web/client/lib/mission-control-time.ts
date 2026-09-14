/**
 * Mission Control's time axis, free of React so it can be unit-tested without
 * loading the store (which pulls in `useSyncExternalStore`).
 *
 * Activity filter and window are two fields in the store, but the operator
 * sees one question — "how recently must a log have spoken to earn a pane?" —
 * so both surfaces that ask it (the wall's status line, the left panel) render
 * this single axis: `live` is the 60s window the pulsing dot already means,
 * the middle steps are the activity windows, `all` lifts the window entirely.
 */

export type MissionActivityFilter = "active" | "live" | "all";

export const MISSION_ACTIVITY_WINDOWS = [
  { label: "5m", value: 5 * 60_000 },
  { label: "30m", value: 30 * 60_000 },
  { label: "4h", value: 4 * 60 * 60_000 },
  { label: "24h", value: 24 * 60 * 60_000 },
] as const;

export type MissionActivityWindow = (typeof MISSION_ACTIVITY_WINDOWS)[number]["value"];

export type MissionTimeFilterId =
  | "live"
  | (typeof MISSION_ACTIVITY_WINDOWS)[number]["label"]
  | "all";

export type MissionTimeFilter = {
  id: MissionTimeFilterId;
  label: string;
  activityFilter: MissionActivityFilter;
  /** Null when the step does not touch the stored window. */
  windowMs: MissionActivityWindow | null;
};

export type MissionTimeState = {
  activityFilter: MissionActivityFilter;
  activityWindowMs: MissionActivityWindow;
};

export const MISSION_TIME_FILTERS: readonly MissionTimeFilter[] = [
  { id: "live", label: "live", activityFilter: "live", windowMs: null },
  ...MISSION_ACTIVITY_WINDOWS.map((window) => ({
    id: window.label,
    label: window.label,
    activityFilter: "active" as const,
    windowMs: window.value,
  })),
  { id: "all", label: "all", activityFilter: "all", windowMs: null },
];

/** The axis step the stored filter + window currently amount to. */
export function missionTimeFilterId(state: MissionTimeState): MissionTimeFilterId {
  if (state.activityFilter === "live") return "live";
  if (state.activityFilter === "all") return "all";
  return MISSION_ACTIVITY_WINDOWS.find((window) => window.value === state.activityWindowMs)?.label
    ?? MISSION_ACTIVITY_WINDOWS[MISSION_ACTIVITY_WINDOWS.length - 1].label;
}

/**
 * The stored fields a step resolves to. `live` and `all` keep the current
 * window so stepping back onto a window step lands where the operator left it.
 * Returns `state` itself (same reference) when nothing would change, so a
 * caller can skip notifying.
 */
export function resolveMissionTimeFilter(
  state: MissionTimeState,
  id: MissionTimeFilterId,
): MissionTimeState {
  const filter = MISSION_TIME_FILTERS.find((candidate) => candidate.id === id);
  if (!filter) return state;
  const activityWindowMs = filter.windowMs ?? state.activityWindowMs;
  if (state.activityFilter === filter.activityFilter && state.activityWindowMs === activityWindowMs) {
    return state;
  }
  return { activityFilter: filter.activityFilter, activityWindowMs };
}
