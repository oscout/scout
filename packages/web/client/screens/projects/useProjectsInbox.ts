/* Projects · Inbox — the ONE data loop, shared across three sibling panes.

   The app shell mounts the rail (left), the inbox (center) and the thread aside
   (right) as siblings — there is no shared React parent to own the fetch. So the
   loop lives here, module-level, reference-counted exactly like lib/sse.ts: the
   FIRST pane to mount starts it, the LAST to unmount stops it. Every pane reads
   the same snapshot, so there is exactly one poll interval, one debounced SSE
   refresh, and one shared 30s clock — no matter how many panes mount.

   This is the whole reason the old surface died: it mounted useProjectsData
   three times, each polling every 10s + refetching three endpoints on EVERY
   broker event with no debounce, busting memos with fresh Date.now() literals.
   One core pegged at 100%. Here: one loop, 250ms-debounced SSE, 15s visible
   interval, a 30s clock (relative times don't need 1s precision), and a
   module-level model cache so the heavy projection runs once per data epoch and
   the other two panes read the cache. */

import { useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api.ts";
import { routeMachineId } from "../../lib/router.ts";
import { useBrokerEvents } from "../../lib/sse.ts";
import { isScoutSurfaceActive, onScoutSurfaceActivated } from "../../lib/surface-activity.ts";
import { useScout } from "../../scout/Provider.tsx";
import { keepPreviousIfJsonEqual } from "../chat/conversation-model.ts";
import type { FleetState, Route, SessionEntry, TailDiscoverySnapshot } from "../../lib/types.ts";
import {
  buildProjectsInboxModel,
  type BuildInboxInput,
  type ProjectsInboxModel,
} from "./projects-inbox-model.ts";

const REFRESH_INTERVAL_MS = 15_000;
const NOW_TICK_MS = 30_000;
const SSE_DEBOUNCE_MS = 250;

type FetchSnapshot = {
  sessions: SessionEntry[];
  fleet: FleetState | null;
  discovery: TailDiscoverySnapshot | null;
  loadedAt: number | null;
  loading: boolean;
  error: string | null;
  nowMs: number;
};

let snapshot: FetchSnapshot = {
  sessions: [],
  fleet: null,
  discovery: null,
  loadedAt: null,
  loading: true,
  error: null,
  nowMs: Date.now(),
};

const subscribers = new Set<() => void>();
let refCount = 0;
let requestId = 0;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let nowTimer: ReturnType<typeof setInterval> | null = null;
let surfaceActivationCleanup: (() => void) | null = null;

/** Bumped on every real fetch — read via window.__projectsInboxLoads to prove one loop. */
let loadRuns = 0;

function emit(): void {
  for (const notify of [...subscribers]) notify();
}

/** Reuse the prior fleet ref unless the model-relevant slice (activeAsks) changed. */
function keepFleet(prev: FleetState | null, next: FleetState): FleetState {
  if (prev && JSON.stringify(prev.activeAsks) === JSON.stringify(next.activeAsks)) return prev;
  return next;
}

/** Reuse the prior discovery ref unless transcripts/processes changed. */
function keepDiscovery(prev: TailDiscoverySnapshot | null, next: TailDiscoverySnapshot): TailDiscoverySnapshot {
  const slice = (d: TailDiscoverySnapshot | null) =>
    JSON.stringify([d?.transcripts ?? [], d?.processes ?? []]);
  if (prev && slice(prev) === slice(next)) return prev;
  return next;
}

function set(patch: Partial<FetchSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  emit();
}

async function load(mode: "initial" | "background"): Promise<void> {
  const id = ++requestId;
  loadRuns += 1;
  if (typeof window !== "undefined") {
    (window as unknown as { __projectsInboxLoads?: number }).__projectsInboxLoads = loadRuns;
  }
  if (snapshot.loadedAt === null && mode !== "background") {
    set({ loading: true, error: null });
  }

  const [sessionsResult, fleetResult, discoveryResult] = await Promise.allSettled([
    api<SessionEntry[]>("/api/conversations"),
    api<FleetState>("/api/fleet"),
    api<TailDiscoverySnapshot>("/api/tail/discover"),
  ]);

  // Requests race; only the newest one is allowed to commit.
  if (id !== requestId) return;

  // Keep the PREVIOUS reference when the MODEL-RELEVANT slice is unchanged. On an
  // active machine the broker floods events, so most background refreshes return
  // the same meaningful data — reusing refs means the model cache hits, the
  // inbox's ~150 sprite rows don't reconcile, and an idle surface stays idle.
  // Churning fresh refs every 250ms (even for identical data) is what pegged a
  // core. NB: /api/fleet and /api/tail/discover stamp a fresh `generatedAt`
  // every call, so we compare only the fields the model reads (activeAsks;
  // transcripts + processes) — never the whole envelope.
  const nextSessions = sessionsResult.status === "fulfilled"
    ? keepPreviousIfJsonEqual(snapshot.sessions, sessionsResult.value)
    : snapshot.sessions;
  const nextFleet = fleetResult.status === "fulfilled"
    ? keepFleet(snapshot.fleet, fleetResult.value)
    : snapshot.fleet;
  const nextDiscovery = discoveryResult.status === "fulfilled"
    ? keepDiscovery(snapshot.discovery, discoveryResult.value)
    : snapshot.discovery;

  const failed = [sessionsResult, fleetResult, discoveryResult].find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  const nextError = failed
    ? failed.reason instanceof Error
      ? failed.reason.message
      : String(failed.reason)
    : null;

  const changed =
    nextSessions !== snapshot.sessions ||
    nextFleet !== snapshot.fleet ||
    nextDiscovery !== snapshot.discovery ||
    nextError !== snapshot.error ||
    snapshot.loading;

  // Always advance loadedAt (sync freshness), but only notify subscribers — and
  // therefore re-render — when something a pane would show actually changed.
  snapshot = {
    ...snapshot,
    sessions: nextSessions,
    fleet: nextFleet,
    discovery: nextDiscovery,
    error: nextError,
    loading: false,
    loadedAt: Date.now(),
  };
  if (changed) emit();
}

function scheduleRefresh(): void {
  if (!isScoutSurfaceActive()) return;
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void load("background");
  }, SSE_DEBOUNCE_MS);
}

function startLoop(): void {
  void load("initial");
  pollTimer = setInterval(() => {
    if (isScoutSurfaceActive()) void load("background");
  }, REFRESH_INTERVAL_MS);
  // A calm shared clock — the inbox shows relative times, so 30s is plenty and
  // 1s ticks (the old bug) never enter a memo dependency.
  nowTimer = setInterval(() => {
    if (isScoutSurfaceActive()) set({ nowMs: Date.now() });
  }, NOW_TICK_MS);
  surfaceActivationCleanup = onScoutSurfaceActivated(() => void load("background"));
}

function stopLoop(): void {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (nowTimer) {
    clearInterval(nowTimer);
    nowTimer = null;
  }
  surfaceActivationCleanup?.();
  surfaceActivationCleanup = null;
}

/** Force a refresh — e.g. after creating an agent from the inbox header. */
export function refreshProjectsInbox(): void {
  void load("background");
}

function useFetchSnapshot(): FetchSnapshot {
  const [snap, setSnap] = useState(snapshot);
  useEffect(() => {
    const sync = () => setSnap(snapshot);
    subscribers.add(sync);
    refCount += 1;
    if (refCount === 1) startLoop();
    sync();
    return () => {
      subscribers.delete(sync);
      refCount -= 1;
      if (refCount === 0) stopLoop();
    };
  }, []);
  // Debounced, module-level, coalesced — three panes firing this collapse to one
  // background load per burst of broker events.
  useBrokerEvents(scheduleRefresh);
  return snap;
}

/* ── Model cache — one projection per data epoch, shared by all three panes ──
   Every pane feeds computeModel the SAME references (agents from the shared
   Scout context, sessions/fleet/discovery from this loop's snapshot), so a
   single-entry identity cache means the ~149-agent projection runs once and the
   other two panes read the result.

   The 30s clock tick is intentional (relative timestamps). On rebuild we
   structurally share unchanged thread/session/project objects so React.memo
   row components can skip re-render when only the clock advanced and their
   inputs are identical. */

let modelKey: unknown[] | null = null;
let modelValue: ProjectsInboxModel | null = null;

function sameKey(a: unknown[] | null, b: unknown[]): boolean {
  return Boolean(a) && a!.length === b.length && a!.every((value, index) => value === b[index]);
}

function shareByKey<T>(
  previous: T[] | undefined,
  next: T[],
  keyOf: (item: T) => string,
): T[] {
  if (!previous?.length) return next;
  const priorByKey = new Map(previous.map((item) => [keyOf(item), item]));
  let allShared = previous.length === next.length;
  const shared = next.map((item, index) => {
    const prior = priorByKey.get(keyOf(item));
    const kept = prior ? keepPreviousIfJsonEqual(prior, item) : item;
    if (kept !== previous[index]) allShared = false;
    return kept;
  });
  return allShared ? previous : shared;
}

/** Reuse previous item identities when projection inputs did not change. */
function shareModelItems(previous: ProjectsInboxModel | null, next: ProjectsInboxModel): ProjectsInboxModel {
  if (!previous) return next;
  const projects = shareByKey(previous.projects, next.projects, (project) => project.slug);
  const threads = shareByKey(previous.threads, next.threads, (thread) => thread.id);
  const sessions = shareByKey(previous.sessions, next.sessions, (session) => session.id);
  if (projects === previous.projects && threads === previous.threads && sessions === previous.sessions) {
    return previous;
  }
  return { projects, threads, sessions };
}

function computeModel(input: BuildInboxInput): ProjectsInboxModel {
  const key = [
    input.agents,
    input.sessions,
    input.fleet,
    input.discovery,
    input.machineId,
    Math.floor(input.nowMs / NOW_TICK_MS),
    input.showEphemeral,
  ];
  if (sameKey(modelKey, key) && modelValue) return modelValue;
  const built = buildProjectsInboxModel(input);
  const value = shareModelItems(modelValue, built);
  modelKey = key;
  modelValue = value;
  return value;
}

export type ProjectsInbox = {
  model: ProjectsInboxModel;
  nowMs: number;
  loading: boolean;
  loadedAt: number | null;
  error: string | null;
};

export function useProjectsInbox(route: Extract<Route, { view: "agents-v2" }>): ProjectsInbox {
  const snap = useFetchSnapshot();
  const { agents } = useScout();
  const machineId = routeMachineId(route);
  const showEphemeral = Boolean(route.showEphemeral);

  const model = useMemo(
    () =>
      computeModel({
        agents,
        machineId,
        sessions: snap.sessions,
        fleet: snap.fleet,
        discovery: snap.discovery,
        nowMs: snap.nowMs,
        showEphemeral,
      }),
    [agents, machineId, snap.sessions, snap.fleet, snap.discovery, snap.nowMs, showEphemeral],
  );

  return {
    model,
    nowMs: snap.nowMs,
    loading: snap.loading,
    loadedAt: snap.loadedAt,
    error: snap.error,
  };
}
