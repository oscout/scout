import { useSyncExternalStore } from "react";

export type PlanAuthor = "operator" | "agent";
export type PlanOutcome = "running" | "review" | "completed" | "abandoned";
export type PlanTimeBucket = "24h" | "7d" | "30d" | "all";

export type PlanFacetCounts = {
  total: number;
  byAuthor: Record<PlanAuthor | "all", number>;
  byOutcome: Record<PlanOutcome | "all", number>;
  byProject: { id: string; count: number }[];
};

type State = {
  authorFilter: PlanAuthor | "all";
  outcomeFilter: PlanOutcome | "all";
  timeFilter: PlanTimeBucket;
  projectFilter: string | "all";
  query: string;
  counts: PlanFacetCounts;
  focusedPlanId: string | null;
};

const EMPTY_COUNTS: PlanFacetCounts = {
  total: 0,
  byAuthor: { all: 0, operator: 0, agent: 0 },
  byOutcome: { all: 0, running: 0, review: 0, completed: 0, abandoned: 0 },
  byProject: [],
};

let state: State = {
  authorFilter: "all",
  outcomeFilter: "all",
  timeFilter: "7d",
  projectFilter: "all",
  query: "",
  counts: EMPTY_COUNTS,
  focusedPlanId: null,
};

const listeners = new Set<() => void>();

function emit() { for (const l of listeners) l(); }

function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

function getSnapshot(): State { return state; }

export function usePlanArchiveStore(): State {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function setPlanAuthorFilter(v: PlanAuthor | "all") {
  if (state.authorFilter === v) return;
  state = { ...state, authorFilter: v };
  emit();
}

export function setPlanOutcomeFilter(v: PlanOutcome | "all") {
  if (state.outcomeFilter === v) return;
  state = { ...state, outcomeFilter: v };
  emit();
}

export function setPlanTimeFilter(v: PlanTimeBucket) {
  if (state.timeFilter === v) return;
  state = { ...state, timeFilter: v };
  emit();
}

export function setPlanProjectFilter(v: string | "all") {
  if (state.projectFilter === v) return;
  state = { ...state, projectFilter: v };
  emit();
}

export function setPlanQuery(v: string) {
  if (state.query === v) return;
  state = { ...state, query: v };
  emit();
}

export function setPlanFacetCounts(c: PlanFacetCounts) {
  state = { ...state, counts: c };
  emit();
}

export function setPlanFocusedId(id: string | null) {
  if (state.focusedPlanId === id) return;
  state = { ...state, focusedPlanId: id };
  emit();
}

export const PLAN_TIME_BUCKETS: { id: PlanTimeBucket; label: string; ms: number | null }[] = [
  { id: "24h", label: "24h", ms: 24 * 60 * 60 * 1000 },
  { id: "7d", label: "7d", ms: 7 * 24 * 60 * 60 * 1000 },
  { id: "30d", label: "30d", ms: 30 * 24 * 60 * 60 * 1000 },
  { id: "all", label: "All", ms: null },
];

export const PLAN_AUTHORS: { id: PlanAuthor | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "operator", label: "Operator" },
  { id: "agent", label: "Agent" },
];

export const PLAN_OUTCOMES: { id: PlanOutcome | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "running", label: "Running" },
  { id: "review", label: "Review" },
  { id: "completed", label: "Completed" },
  { id: "abandoned", label: "Abandoned" },
];
