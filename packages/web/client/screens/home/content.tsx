import "./fleet-home.css";
import "./activity-stream.css";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";
import { ConnectionState, ConnectionTraceLog, useConnectionTraceLog } from "../../components/ConnectionState.tsx";
import { homeLoadNotice, loadHomeSource } from "./home-loading.ts";
import HomeHero, {
  type ServiceGauge,
} from "./HomeHero.tsx";
import { TailView } from "../shared/TailView.tsx";
import { api, peekApiGet } from "../../lib/api.ts";
import { loadFleet } from "../../lib/fleet-store.ts";
import { readHomeLayoutHint, writeHomeLayoutHint } from "./home-layout-hint.ts";
import { useObservePolling } from "../../lib/observe.ts";
import { useBrokerRefresh, type BrokerRefreshPolicy } from "../../lib/broker-refresh.ts";
import { AGENT_ROSTER_EVENT_KINDS, FLEET_EVENT_KINDS, matchesKinds } from "../../lib/broker-event-kinds.ts";
import {
  isScoutSurfaceActive,
  isScoutSurfaceVisible,
  onScoutSurfaceActivated,
} from "../../lib/surface-activity.ts";
import {
  compareTimestampsDesc,
  normalizeTimestampMs,
  timeAgo,
} from "../../lib/time.ts";
import { actorColor } from "../../lib/colors.ts";
import { useOptionalFlag } from "hudsonkit/flags";
import { isAgentBusy, normalizeAgentState } from "../../lib/agent-state.ts";
import { ensureAgentChat } from "../../lib/agent-chat.ts";
import { usePersistentNumber, usePersistentString } from "../../lib/persistent-state.ts";
import {
  createRuntimeCatalogLoader,
  RUNTIME_CAPABILITY_SEED,
  runtimeCatalogFromCapabilities,
  runtimeModelCatalogStatus,
  type RuntimeCapabilityCatalog,
} from "../../lib/runtime-capabilities.ts";
import {
  effortsFor,
  type RuntimeValue,
} from "../../lib/runtime-catalog.ts";
import {
  MessageComposer,
  MessageComposerToolSelect,
  RuntimePicker,
  useMessageComposerEmbedded,
} from "../../components/MessageComposer/index.ts";
import { useScout } from "../../scout/Provider.tsx";
import { routeMachineId } from "../../lib/router.ts";
import { routeForFleetAsk } from "../../lib/operator-attention.ts";
import {
  filterAgentsByMachineScope,
  filterFleetByMachineScope,
  machineScopedAgentIds,
} from "../../lib/machine-scope.ts";
import type {
  Agent,
  FleetActivity,
  FleetAsk,
  FleetState,
  Route,
  TailDiscoverySnapshot,
  TailEvent,
} from "../../lib/types.ts";
import {
  buildHomeNativeMovingLanes,
  compareHomeMovingItems,
  dedupeWorkingAgentsByObservedSession,
  HOME_MOVING_CARD_LIMIT,
  HOME_MOVING_DEFAULT_SORT,
  HOME_MOVING_HORIZON,
  HOME_MOVING_WINDOW_OPTIONS,
  homeMovingRecencyMs,
  homeMovingWindowOption,
  isFreshHomeMovingTimestamp,
  isHomeAgentMoving,
  isHomeObserveCandidate,
  laneObservedSessionKey,
  normalizeHomeMovingSort,
  normalizeHomeMovingWindowKey,
  observedSessionKey,
  workingContextFromObserve,
  type HomeMovingSortMode,
  type WorkingAgentContext,
} from "./home-moving.ts";
import { HomeMovingSignalList } from "./home-moving-signal.tsx";
import { agentLaneTailRecentLimit, isAgentLaneLive, type AgentLane } from "../ops/agent-lanes-model.ts";

type LookbackOption = { label: string; value: number; activityLimit: number };
type HomeMovingCardItem =
  | {
      bucket: "working";
      id: string;
      agent: Agent;
      lastActivityAt: number;
    }
  | {
      bucket: "native";
      id: string;
      lane: AgentLane;
      lastActivityAt: number;
    }
  | {
      bucket: "observed";
      id: string;
      actor: FleetActivity;
      lastActivityAt: number;
    };

const LOOKBACK_WINDOWS: LookbackOption[] = [
  { label: "30m", value: 30 * 60_000, activityLimit: 80 },
  { label: "6h", value: 6 * 60 * 60_000, activityLimit: 250 },
  { label: "24h", value: 24 * 60 * 60_000, activityLimit: 800 },
];
const DEFAULT_LOOKBACK_MS = LOOKBACK_WINDOWS[2].value;
const LOOKBACK_STORAGE_KEY = "openscout.home.lookbackMs.v1";
const MOVING_WINDOW_STORAGE_KEY = "openscout.home.movingWindow.v1";
const MOVING_SORT_STORAGE_KEY = "openscout.home.movingSort.v1";
// The server owns provider-specific freshness and request coalescing, so the
// homepage can poll cheaply without holding an hour-old client snapshot.
const SERVICE_BUDGETS_REFRESH_MS = 60_000;
const LOCAL_TAIL_REFRESH_MS = 30_000;
// Fleet + roster + heartrate. Heartrate has no event of its own, so the live
// net stays at 30s rather than relaxing further.
const HOME_FLEET_REFRESH_POLICY: BrokerRefreshPolicy = {
  matches: matchesKinds(FLEET_EVENT_KINDS, AGENT_ROSTER_EVENT_KINDS),
  fallbackPollMs: 15_000,
  livePollMs: 30_000,
  // The cockpit is a watch surface: left open on a second screen it must not
  // freeze ("Last updated 1h") just because focus is in another app.
  activeWhen: "visible",
};
const HEARTRATE_COMBINED_EVENT_THRESHOLD = 3;
const ROUTE_CACHE_MAX_AGE_MS = 30_000;

function formatAge(timestamp: number | null | undefined, nowMs: number): string {
  const timestampMs = normalizeTimestampMs(timestamp);
  if (timestampMs === null) return "—";
  const seconds = Math.max(0, Math.floor((nowMs - timestampMs) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function summarize(text: string | null | undefined, max = 140): string {
  const compact = (text ?? "").replace(/\s+/g, " ").trim();
  if (!compact) return "";
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function activityVerb(kind: string): string {
  const map: Record<string, string> = {
    handoff_sent: "handed off",
    handoff_received: "received handoff",
    ask_sent: "sent a request",
    message_sent: "said",
    message_received: "received",
  };
  return map[kind] ?? kind.replace(/[._]/g, " ");
}

function fleetActivityRoute(item: FleetActivity): Route | null {
  if (item.conversationId) return { view: "conversation", conversationId: item.conversationId };
  if (item.recordId) return { view: "work", workId: item.recordId };
  if (item.agentId) return { view: "agents-v2", agentId: item.agentId };
  return null;
}

function formatLookback(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = minutes / 60;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

type ActivityShape = {
  count: number;
  lastAgoMs: number;
  longestGapMs: number;
};

function computeActivityShape(
  items: FleetActivity[],
  lookbackMs: number,
  nowMs: number,
): ActivityShape | null {
  if (items.length === 0) return null;
  const stamps = items
    .map((it) => normalizeTimestampMs(it.ts))
    .filter((v): v is number => v !== null)
    .sort((a, b) => b - a);
  if (stamps.length === 0) return null;
  const newest = stamps[0]!;
  const oldest = stamps[stamps.length - 1]!;
  let longestGap = 0;
  for (let i = 1; i < stamps.length; i++) {
    longestGap = Math.max(longestGap, stamps[i - 1]! - stamps[i]!);
  }
  // Trailing silence: from window start to oldest visible event.
  const windowStart = nowMs - lookbackMs;
  longestGap = Math.max(longestGap, oldest - windowStart);
  return {
    count: items.length,
    lastAgoMs: Math.max(0, nowMs - newest),
    longestGapMs: Math.max(0, longestGap),
  };
}

function smoothHeartrateCounts(counts: number[]): number[] {
  const energy = counts.map((count) => Math.sqrt(count));
  const weights = [0.56, 0.28, 0.11, 0.05];

  return energy.map((_, index) => {
    let total = 0;
    let weightTotal = 0;
    for (let offset = -3; offset <= 3; offset++) {
      const nextIndex = index + offset;
      if (nextIndex < 0 || nextIndex >= energy.length) continue;
      const weight = weights[Math.abs(offset)] ?? 0;
      total += energy[nextIndex]! * weight;
      weightTotal += weight;
    }
    return weightTotal > 0 ? total / weightTotal : 0;
  });
}

function combineHeartrateWithTailEvents(
  heartrate: HeartrateBucketView[],
  tailEvents: TailEvent[],
  nowMs: number,
): HeartrateBucketView[] {
  if (heartrate.length < 2 || tailEvents.length === 0) return heartrate;

  const bucketMs = Math.max(1, heartrate[1]!.ts - heartrate[0]!.ts);
  const startMs = heartrate[0]!.ts;
  const endMs = heartrate[heartrate.length - 1]!.ts + bucketMs;
  const counts = heartrate.map((bucket) => bucket.count);

  for (const event of tailEvents) {
    const eventTs = normalizeTimestampMs(event.ts);
    if (eventTs === null || eventTs < startMs || eventTs > nowMs || eventTs >= endMs) {
      continue;
    }
    const index = Math.floor((eventTs - startMs) / bucketMs);
    if (index >= 0 && index < counts.length) {
      counts[index] = (counts[index] ?? 0) + 1;
    }
  }

  const smoothed = smoothHeartrateCounts(counts);
  const peak = Math.max(1, ...smoothed);
  return heartrate.map((bucket, index) => ({
    ...bucket,
    count: counts[index] ?? bucket.count,
    value: (smoothed[index] ?? 0) / peak,
  }));
}

type HeartrateBucketView = {
  ts: number;
  count: number;
  value: number;
};

type LoadMode = "initial" | "background" | "manual";

function settledError(result: PromiseSettledResult<unknown>): string | null {
  if (result.status === "fulfilled") return null;
  return friendlySyncError(result.reason instanceof Error ? result.reason.message : String(result.reason));
}

function friendlySyncError(message: string): string {
  return /failed to fetch|networkerror|load failed|couldn't connect|connection refused/i.test(message)
    ? "Scout server is unreachable"
    : message;
}

function isOfflineSyncError(message: string | null): boolean {
  return message === "Scout server is unreachable";
}

export function HomeContent({
  navigate,
  basic = false,
  lead,
  children,
}: {
  navigate: (r: Route) => void;
  /** Basic web: no hero, coordination stream or quiet-start panels. */
  basic?: boolean;
  /** Basic web: a next-step strip above What's moving. */
  lead?: React.ReactNode;
  /** Extra Home sections, laid out after What's moving. */
  children?: React.ReactNode;
}) {
  const { agents: allAgents, onboarding, reload, route, apiConnection } = useScout();
  const machineId = routeMachineId(route);
  const scopedAgentIds = useMemo(
    () => machineScopedAgentIds(allAgents, machineId),
    [allAgents, machineId],
  );
  const agents = useMemo(
    () => filterAgentsByMachineScope(allAgents, machineId),
    [allAgents, machineId],
  );
  const [lookbackMs, setLookbackMs] = usePersistentNumber(
    LOOKBACK_STORAGE_KEY,
    DEFAULT_LOOKBACK_MS,
  );
  const lookbackOption = useMemo<LookbackOption>(
    () =>
      LOOKBACK_WINDOWS.find((opt) => opt.value === lookbackMs)
        ?? LOOKBACK_WINDOWS[LOOKBACK_WINDOWS.length - 1]!,
    [lookbackMs],
  );
  const [movingWindowKeyRaw, setMovingWindowKeyRaw] = usePersistentString(
    MOVING_WINDOW_STORAGE_KEY,
    HOME_MOVING_HORIZON,
  );
  const movingWindowKey = normalizeHomeMovingWindowKey(movingWindowKeyRaw);
  const movingWindow = homeMovingWindowOption(movingWindowKey);
  const [movingSortRaw, setMovingSortRaw] = usePersistentString(
    MOVING_SORT_STORAGE_KEY,
    HOME_MOVING_DEFAULT_SORT,
  );
  const movingSort = normalizeHomeMovingSort(movingSortRaw);
  const localTailRecentLimit = useMemo(
    () => agentLaneTailRecentLimit(movingWindowKey),
    [movingWindowKey],
  );

  // Warm start: paint last-known responses immediately on remount while the
  // fetch effects below refresh in the background. Peeked paths must stay
  // byte-identical to the paths those fetches use so the cache keys match.
  const [warmStart] = useState(() => {
    const fleetQuery = new URLSearchParams({
      activityLookbackMs: String(lookbackOption.value),
      activityLimit: String(lookbackOption.activityLimit),
    }).toString();
    const tailQuery = new URLSearchParams({
      limit: String(localTailRecentLimit),
      transcripts: "true",
    }).toString();
    return {
      fleet: peekApiGet<FleetState>(`/api/fleet?${fleetQuery}`, ROUTE_CACHE_MAX_AGE_MS),
      heartrate: peekApiGet<{
        windowLabel: string;
        bucketLabel?: string;
        buckets: HeartrateBucketView[];
      }>("/api/heartrate", ROUTE_CACHE_MAX_AGE_MS),
      gauges: peekApiGet<{ gauges: ServiceGauge[] }>("/api/service-budgets", ROUTE_CACHE_MAX_AGE_MS),
      tailRecent: peekApiGet<{ events: TailEvent[] }>(`/api/tail/recent?${tailQuery}`, ROUTE_CACHE_MAX_AGE_MS),
      tailDiscovery: peekApiGet<TailDiscoverySnapshot>("/api/tail/discover", ROUTE_CACHE_MAX_AGE_MS),
    };
  });
  const [fleet, setFleet] = useState<FleetState | null>(warmStart.fleet);
  const [heartrate, setHeartrate] = useState<HeartrateBucketView[]>(warmStart.heartrate?.buckets ?? []);
  const [heartrateWindow, setHeartrateWindow] = useState(warmStart.heartrate?.windowLabel ?? "trailing 7d");
  const [heartrateBucketLabel, setHeartrateBucketLabel] = useState(
    warmStart.heartrate ? warmStart.heartrate.bucketLabel ?? "" : "3h buckets",
  );
  const [tailEvents, setTailEvents] = useState<TailEvent[]>(warmStart.tailRecent?.events ?? []);
  const [tailDiscovery, setTailDiscovery] = useState<TailDiscoverySnapshot | null>(warmStart.tailDiscovery);
  const [serviceGauges, setServiceGauges] = useState<ServiceGauge[]>(warmStart.gauges?.gauges ?? []);
  const [loading, setLoading] = useState(warmStart.fleet === null);
  // Gauges and the local tail load on their own clocks. Until each first
  // answer lands, its sections hold their last-known shape instead of
  // collapsing and re-growing.
  const [gaugesSettled, setGaugesSettled] = useState(warmStart.gauges !== null);
  const [tailSettled, setTailSettled] = useState(warmStart.tailRecent !== null);
  const [layoutHint] = useState(readHomeLayoutHint);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { trace: loadTrace, append: traceLoad } = useConnectionTraceLog();
  useEffect(() => { traceLoad(`Scout connection: ${apiConnection.status}`); }, [apiConnection.status, traceLoad]);
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null);
  const requestIdRef = useRef(0);
  const lastForegroundRefreshAtRef = useRef(0);
  const fleetRef = useRef<FleetState | null>(warmStart.fleet);

  useEffect(() => {
    fleetRef.current = fleet;
  }, [fleet]);

  const fetchServiceGauges = useCallback(async (forceRefresh = false): Promise<ServiceGauge[]> => {
    const suffix = forceRefresh ? "?refresh=1" : "";
    const result = await api<{ gauges: ServiceGauge[] }>(`/api/service-budgets${suffix}`, {
      cache: "no-store",
    });
    return result.gauges ?? [];
  }, []);

  const scopedFleet = useMemo(
    () => filterFleetByMachineScope(fleet, scopedAgentIds),
    [fleet, scopedAgentIds],
  );

  const load = useCallback(async (mode: LoadMode = "initial") => {
    const requestId = ++requestIdRef.current;
    const hasSnapshot = fleetRef.current !== null;

    if (!hasSnapshot) {
      setLoading(true);
      setError(null);
    } else {
      setRefreshing(true);
    }

    const fleetQuery = new URLSearchParams({
      activityLookbackMs: String(lookbackOption.value),
      activityLimit: String(lookbackOption.activityLimit),
    }).toString();

    // Heartrate only feeds the hero's velocity chart, which basic omits.
    const [fleetResult, heartrateResult] = await Promise.allSettled([
      loadHomeSource("Home activity", () => loadFleet(fleetQuery), traceLoad, {
        retries: hasSnapshot && mode === "background" ? 0 : 2,
        active: () => requestId === requestIdRef.current,
      }),
      basic
        ? Promise.resolve(null)
        : loadHomeSource("Activity chart", () => api<{
          windowLabel: string;
          bucketLabel?: string;
          buckets: HeartrateBucketView[];
        }>("/api/heartrate"), traceLoad),
      reload(),
    ]);

    if (requestId !== requestIdRef.current) return;

    if (fleetResult.status === "fulfilled") {
      fleetRef.current = fleetResult.value;
      setFleet(fleetResult.value);
    }
    if (heartrateResult.status === "fulfilled" && heartrateResult.value) {
      setHeartrate(heartrateResult.value.buckets);
      setHeartrateWindow(heartrateResult.value.windowLabel);
      setHeartrateBucketLabel(heartrateResult.value.bucketLabel ?? "");
    }

    // Optional chart/roster reads cannot turn a successful Home load into an
    // outage. Their own surfaces and the trace carry those diagnostics.
    setError(settledError(fleetResult));
    if (fleetResult.status === "fulfilled") {
      setLastLoadedAt(Date.now());
    }
    setLoading(false);
    setRefreshing(false);
  }, [basic, reload, lookbackOption, traceLoad]);

  useEffect(() => {
    void load();
    return () => { requestIdRef.current++; };
  }, [load]);
  useBrokerRefresh(() => void load("background"), HOME_FLEET_REFRESH_POLICY);

  useEffect(() => {
    if (basic) return;
    let cancelled = false;
    const fetchBudgets = async () => {
      try {
        traceLoad("Service budgets: requesting");
        const gauges = await fetchServiceGauges();
        if (!cancelled) { setServiceGauges(gauges); traceLoad("Service budgets: received"); }
      } catch {
        if (!cancelled) traceLoad("Service budgets: unavailable; continuing without quotas");
        // Silent: gauges are best-effort. If the endpoint fails, we just hide them.
      } finally {
        if (!cancelled) setGaugesSettled(true);
      }
    };
    void fetchBudgets();
    const id = setInterval(() => {
      if (isScoutSurfaceVisible()) void fetchBudgets();
    }, SERVICE_BUDGETS_REFRESH_MS);
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible" && isScoutSurfaceActive()) {
        void fetchBudgets();
      }
    };
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      cancelled = true;
      clearInterval(id);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [basic, fetchServiceGauges, traceLoad]);

  const loadLocalTailSnapshot = useCallback(async () => {
    try {
      traceLoad("Local activity: requesting");
      const params = new URLSearchParams({
        limit: String(localTailRecentLimit),
        transcripts: "true",
      });
      const [recent, discovery] = await Promise.all([
        api<{ events: TailEvent[] }>(`/api/tail/recent?${params.toString()}`),
        api<TailDiscoverySnapshot>("/api/tail/discover").catch(() => null),
      ]);
      setTailEvents(recent.events ?? []);
      traceLoad("Local activity: received");
      if (discovery) setTailDiscovery(discovery);
    } catch {
      traceLoad("Local activity: unavailable; Home activity can still load");
      // Silent: the embedded Tail view owns the visible error/empty state.
    } finally {
      setTailSettled(true);
    }
  }, [localTailRecentLimit, traceLoad]);

  useEffect(() => {
    void loadLocalTailSnapshot();
    const id = setInterval(() => {
      if (isScoutSurfaceActive()) void loadLocalTailSnapshot();
    }, LOCAL_TAIL_REFRESH_MS);
    return () => clearInterval(id);
  }, [loadLocalTailSnapshot]);

  useEffect(() => {
    const refreshIfActive = () => {
      const now = Date.now();
      if (now - lastForegroundRefreshAtRef.current < 1000) {
        return;
      }
      lastForegroundRefreshAtRef.current = now;
      // The fleet itself refreshes through useBrokerRefresh above.
      if (!basic) void fetchServiceGauges().then(setServiceGauges).catch(() => null);
      void loadLocalTailSnapshot();
    };

    return onScoutSurfaceActivated(refreshIfActive);
  }, [basic, fetchServiceGauges, loadLocalTailSnapshot]);

  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => {
      if (isScoutSurfaceVisible()) setNowMs(Date.now());
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const movingAsks = useMemo(
    () =>
      (scopedFleet?.activeAsks ?? []).filter(
        (a) => a.status === "queued" || a.status === "working",
      ),
    [scopedFleet],
  );
  const freshMovingAsks = useMemo(
    () => movingAsks.filter((ask) => isFreshHomeMovingTimestamp(ask.updatedAt, nowMs, movingWindow.windowMs)),
    [movingAsks, movingWindow.windowMs, nowMs],
  );
  const movingAskByAgent = useMemo(() => {
    const byAgent = new Map<string, FleetAsk>();
    for (const ask of freshMovingAsks) {
      const current = byAgent.get(ask.agentId);
      const askUpdatedAt = normalizeTimestampMs(ask.updatedAt) ?? 0;
      const currentUpdatedAt = normalizeTimestampMs(current?.updatedAt) ?? 0;
      if (!current || askUpdatedAt > currentUpdatedAt) {
        byAgent.set(ask.agentId, ask);
      }
    }
    return byAgent;
  }, [freshMovingAsks]);
  const observeCandidates = useMemo(
    () =>
      agents.filter((agent) =>
        isHomeObserveCandidate(
          agent,
          nowMs,
          movingAskByAgent.has(agent.id),
          tailEvents,
          movingWindow.windowMs,
          movingWindowKey,
        ),
      ),
    [agents, movingAskByAgent, movingWindow.windowMs, movingWindowKey, nowMs, tailEvents],
  );
  const observeCache = useObservePolling(observeCandidates);
  const workingAgents = useMemo(() => {
    const moving = agents.filter((agent) =>
      isHomeAgentMoving({
        agent,
        observeEntry: observeCache[agent.id],
        tailEvents,
        nowMs,
        movingAsk: movingAskByAgent.get(agent.id),
        windowMs: movingWindow.windowMs,
      }),
    );
    const sorted = moving
      .sort((left, right) =>
        homeMovingRecencyMs(right, {
          observeEntry: observeCache[right.id],
          tailEvents,
          nowMs,
          movingAsk: movingAskByAgent.get(right.id),
        })
        - homeMovingRecencyMs(left, {
          observeEntry: observeCache[left.id],
          tailEvents,
          nowMs,
          movingAsk: movingAskByAgent.get(left.id),
        }),
      );
    return dedupeWorkingAgentsByObservedSession(sorted, observeCache);
  }, [agents, movingAskByAgent, movingWindow.windowMs, observeCache, tailEvents, nowMs]);
  const workingContext = useMemo(() => {
    const next: Record<string, WorkingAgentContext> = {};
    for (const agent of workingAgents) {
      next[agent.id] = workingContextFromObserve(observeCache[agent.id]?.data);
    }
    return next;
  }, [observeCache, workingAgents]);
  const workingAgentIds = useMemo(
    () => new Set(workingAgents.map((agent) => agent.id)),
    [workingAgents],
  );
  const workingSessionKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const agent of workingAgents) {
      const key = observedSessionKey(observeCache[agent.id]);
      if (key) keys.add(key);
    }
    return keys;
  }, [observeCache, workingAgents]);
  const nativeMovingLanes = useMemo<AgentLane[]>(() => {
    const lanes = buildHomeNativeMovingLanes({
      agents,
      tailEvents,
      transcripts: tailDiscovery?.transcripts ?? [],
      processes: tailDiscovery?.processes ?? [],
      observeCache,
      nowMs,
      horizon: movingWindowKey,
    });
    return lanes
      .filter((lane) => {
        if (workingAgentIds.has(lane.agent.id)) return false;
        const laneKey = laneObservedSessionKey(lane);
        return !(laneKey && workingSessionKeys.has(laneKey));
      })
      .sort((left, right) => right.lastActiveAt - left.lastActiveAt);
  }, [agents, movingWindowKey, observeCache, nowMs, tailDiscovery, tailEvents, workingAgentIds, workingSessionKeys]);
  const movingAsksWithoutWorkingAgent = useMemo(
    () =>
      freshMovingAsks.filter(
        (ask) => !workingAgents.some((agent) => agent.id === ask.agentId),
      ).sort((left, right) => compareTimestampsDesc(left.updatedAt, right.updatedAt)),
    [workingAgents, freshMovingAsks],
  );

  const sinceMs = nowMs - lookbackMs;
  const liveActivity = useMemo<FleetActivity[]>(() => {
    const hiddenTurnVerdicts = new Set([
      "ask_failed",
      "ask_replied",
      "flight.completed",
      "flight.updated",
      "flight_updated",
    ]);
    const items = (scopedFleet?.activity ?? []).filter((item) =>
      !hiddenTurnVerdicts.has(item.kind)
      && (normalizeTimestampMs(item.ts) ?? 0) >= sinceMs
    );
    // Collapse machine echoes: the firehose logs some events twice with
    // identical copy but different kinds (e.g. `ask opened` immediately
    // followed by `invocation recorded`). The feed is newest-first, so drop a
    // row when the one just above it says the same thing at the same time —
    // keeps the first (more human-readable) line, hides the duplicate.
    return items.filter((item, i) => {
      const prev = items[i - 1];
      if (!prev) return true;
      const sameContent =
        prev.title === item.title
        && prev.summary === item.summary
        && prev.conversationId === item.conversationId
        && Math.abs((normalizeTimestampMs(prev.ts) ?? 0) - (normalizeTimestampMs(item.ts) ?? 0)) <= 5_000;
      return !sameContent;
    });
  }, [scopedFleet?.activity, sinceMs]);
  const activityShape = useMemo(
    () => computeActivityShape(liveActivity, lookbackMs, nowMs),
    [liveActivity, lookbackMs, nowMs],
  );
  const activityCapReached = liveActivity.length >= lookbackOption.activityLimit;
  const nextLookbackOption = useMemo<LookbackOption | null>(() => {
    const idx = LOOKBACK_WINDOWS.findIndex((opt) => opt.value === lookbackMs);
    return idx >= 0 && idx < LOOKBACK_WINDOWS.length - 1
      ? LOOKBACK_WINDOWS[idx + 1]!
      : null;
  }, [lookbackMs]);

  const now = new Date();
  const opsEnabled = useOptionalFlag("ops.control", true);
  const operatorName =
    onboarding?.operatorName?.trim()
    || onboarding?.operatorNameSuggestion?.trim()
    || "operator";
  const combinedHeartrate = useMemo(
    () => combineHeartrateWithTailEvents(heartrate, tailEvents, nowMs),
    [heartrate, tailEvents, nowMs],
  );

  // Native/unmanaged actors observed via the activity firehose in the selected moving window.
  // Anything Scout already tracks as a managed agent is excluded — those render as NowCard.
  const observedMovingActors = useMemo<FleetActivity[]>(() => {
    const cutoff = nowMs - movingWindow.windowMs;
    const items = scopedFleet?.activity ?? [];
    const managedNames = new Set(agents.map((a) => a.name.toLowerCase()));
    const managedIds = new Set(agents.map((a) => a.id));
    const interestingKinds = new Set([
      "agent_message",
      "status_message",
      "ask_opened",
      "ask_working",
      "handoff_sent",
      "collaboration_event",
    ]);
    const byActor = new Map<string, FleetActivity>();
    for (const item of items) {
      const itemTs = normalizeTimestampMs(item.ts);
      if (itemTs === null || itemTs < cutoff) continue;
      if (!interestingKinds.has(item.kind)) continue;
      const name = item.actorName?.trim();
      if (!name) continue;
      if (name.toLowerCase() === operatorName.toLowerCase()) continue;
      if (managedNames.has(name.toLowerCase())) continue;
      if (item.agentId && managedIds.has(item.agentId)) continue;
      const key = name.toLowerCase();
      const current = byActor.get(key);
      const currentTs = normalizeTimestampMs(current?.ts) ?? 0;
      if (!current || itemTs > currentTs) byActor.set(key, item);
    }
    return [...byActor.values()].sort((a, b) =>
      compareTimestampsDesc(a.ts, b.ts),
    );
  }, [scopedFleet?.activity, movingWindow.windowMs, nowMs, agents, operatorName]);

  const syncLabel = loading
    ? "Loading Scout…"
    : refreshing ? "Refreshing…"
    : error
      ? `${isOfflineSyncError(error) ? "offline" : "sync issue"} · ${lastLoadedAt ? timeAgo(lastLoadedAt) : "waiting"}`
      : lastLoadedAt
        ? `Last updated ${timeAgo(lastLoadedAt)}`
        : "waiting";
  const handleRefresh = useCallback(() => {
    void load("manual");
    void fetchServiceGauges(true)
      .then((gauges) => setServiceGauges(gauges))
      .catch(() => {});
  }, [fetchServiceGauges, load]);

  const heroProps = {
    now,
    operatorName,
    syncLabel,
    error,
    loading,
    refreshing,
    onRefresh: handleRefresh,
    navigate,
    opsEnabled,
    heartrate: combinedHeartrate,
    heartrateWindow,
    heartrateBucketLabel,
    heartrateVisibleEventThreshold: HEARTRATE_COMBINED_EVENT_THRESHOLD,
    serviceGauges,
    gaugesPending: !gaugesSettled,
    heartratePending: loading || !tailSettled,
    layoutHint,
  };
  const hideEmptyActivityModule =
    !loading &&
    !error &&
    liveActivity.length === 0 &&
    lookbackMs >= DEFAULT_LOOKBACK_MS;
  const composerEmbedded = useMessageComposerEmbedded();
  const showQuietStart =
    !loading &&
    !error &&
    liveActivity.length === 0;
  const showActivitySection =
    loading ||
    liveActivity.length > 0 ||
    Boolean(error) ||
    !hideEmptyActivityModule;
  const movingCards = useMemo<HomeMovingCardItem[]>(() => {
    const cards: HomeMovingCardItem[] = [
      ...workingAgents.map((agent) => ({
        bucket: "working" as const,
        id: agent.id,
        agent,
        lastActivityAt: homeMovingRecencyMs(agent, {
          observeEntry: observeCache[agent.id],
          tailEvents,
          nowMs,
          movingAsk: movingAskByAgent.get(agent.id),
        }),
      })),
      ...nativeMovingLanes.map((lane) => ({
        bucket: "native" as const,
        id: lane.id,
        lane,
        lastActivityAt: lane.lastActiveAt,
      })),
      ...observedMovingActors.map((actor) => ({
        bucket: "observed" as const,
        id: actor.id,
        actor,
        lastActivityAt: normalizeTimestampMs(actor.ts) ?? 0,
      })),
    ];
    return cards.sort((left, right) => compareHomeMovingItems(left, right, movingSort));
  }, [movingAskByAgent, movingSort, nativeMovingLanes, nowMs, observeCache, observedMovingActors, tailEvents, workingAgents]);
  const visibleMovingCards = movingCards.slice(0, HOME_MOVING_CARD_LIMIT);
  const movingCardCount = visibleMovingCards.length;
  const totalMovingCount = movingCards.length + movingAsksWithoutWorkingAgent.length;
  // Moving rows are joined from fleet, tail, and discovery; until the first
  // fleet and tail answers land, an empty list means "not known yet".
  const movingPending = (loading || !tailSettled) && totalMovingCount === 0;
  const activityPending = loading && liveActivity.length === 0;

  const settled = !loading && gaugesSettled && tailSettled;
  const settledQuotaCount = serviceGauges.filter((gauge) => gauge.kind === "quota").length;
  const settledHeartrate =
    combinedHeartrate.reduce((total, bucket) => total + bucket.count, 0) >= HEARTRATE_COMBINED_EVENT_THRESHOLD;
  const settledMovingRows = movingCardCount + movingAsksWithoutWorkingAgent.length;
  const settledActivityRows = Math.min(liveActivity.length, 30);
  useEffect(() => {
    if (!settled) return;
    writeHomeLayoutHint({
      gauges: Math.min(settledQuotaCount, 2),
      heartrate: settledHeartrate,
      moving: settledMovingRows,
      activity: settledActivityRows,
    });
  }, [settled, settledQuotaCount, settledHeartrate, settledMovingRows, settledActivityRows]);

  const movingSectionLabel =
    totalMovingCount > movingCardCount && movingCardCount > 0
      ? `What's moving · ${movingCardCount} of ${totalMovingCount}`
      : `What's moving · ${totalMovingCount}`;

  if (!fleet && error && !loading) {
    return <div className="s-home-load-state"><ConnectionState notice={homeLoadNotice(error)} trace={loadTrace} onRetry={() => void load("manual")} /></div>;
  }

  return (
    <div className="s-home-surface">
    <div className="s-fleet-home" aria-busy={loading || undefined}>
      <div className="s-fleet-home-inner">
        {/* ── Home header ─────────────────────────────────────────── */}
        {!basic && <HomeHero {...heroProps} />}
        {basic && error && !refreshing && (
          <div className="sys-banner sys-banner-warning" role="alert">
            <strong>Refresh failed.</strong>
            <span>{error}</span>
            <button type="button" className="s-link-btn" onClick={() => void load("manual")}>Retry</button>
          </div>
        )}
        {basic && lead}

        {/* ── What's moving ──────────────────────────────────────── */}
        {/* Always mounted: a quiet line when nothing moves, so the sections
            below never jump when work starts or stops. */}
        <div className="s-fleet-section">
            <SectionRule
              label={movingPending ? "What's moving" : movingSectionLabel}
              right={
                <div className="s-moving-controls">
                  <MovingControls
                    sort={movingSort}
                    onSortChange={setMovingSortRaw}
                    windowKey={movingWindow.key}
                    onWindowChange={setMovingWindowKeyRaw}
                  />
                  <button
                    className="s-link-btn"
                    onClick={() => navigate(basic ? { view: "ops", mode: "tail" } : { view: "mesh" })}
                  >
                    {basic ? "View Tail" : "open mesh ↗"}
                  </button>
                </div>
              }
            />
            {movingPending ? (
              <MovingSkeleton rows={layoutHint.moving} />
            ) : totalMovingCount === 0 ? (
              <div className="s-fleet-live-empty home-arrive" role="status">
                <span>Nothing moving in the last {movingWindow.key}.</span>
              </div>
            ) : (
              <div className="home-arrive">
                {movingCardCount > 0 && (
                  <HomeMovingSignalList
                    cards={visibleMovingCards}
                    sort={movingSort}
                    nowMs={nowMs}
                    movingAskByAgent={movingAskByAgent}
                    observeCache={observeCache}
                    navigate={navigate}
                  />
                )}
                {movingAsksWithoutWorkingAgent.length > 0 && (
                  <div className="s-moving-ask-list">
                    {movingAsksWithoutWorkingAgent.map((ask) => (
                      <MovingAskRow
                        key={ask.invocationId}
                        ask={ask}
                        navigate={navigate}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
        </div>

        {/* ── Scout coordination stream ─────────────────────────── */}
        {!basic && showActivitySection && (
          <div className="s-fleet-section">
            <SectionRule
              label={activityPending
                ? "Scout coordination"
                : `Scout coordination · ${liveActivity.length}${activityCapReached ? "+" : ""}`}
              right={
                <LookbackPicker
                  value={lookbackMs}
                  onChange={setLookbackMs}
                  refreshing={refreshing && !loading}
                />
              }
            />
            {activityPending && (
              <div className="s-fleet-live-shape" aria-hidden="true">
                <span><span className="home-skel" style={{ width: 170 }} />{"\u00a0"}</span>
              </div>
            )}
            {activityShape && (
              <div className="s-fleet-live-shape">
                <span>last {formatDuration(activityShape.lastAgoMs)} ago</span>
                <span>·</span>
                <span>longest gap {formatDuration(activityShape.longestGapMs)}</span>
                {activityCapReached && (
                  <>
                    <span>·</span>
                    <span style={{ color: "var(--amber)" }}>
                      showing {Math.min(liveActivity.length, 30)} of {lookbackOption.activityLimit}+ (capped)
                    </span>
                  </>
                )}
                {!activityCapReached && liveActivity.length > 30 && (
                  <>
                    <span>·</span>
                    <span>showing 30 of {liveActivity.length}</span>
                  </>
                )}
              </div>
            )}
            {activityPending ? (
              <ActivityStreamSkeleton rows={layoutHint.activity} />
            ) : liveActivity.length === 0 ? (
              <LiveActivityEmpty
                lookbackMs={lookbackMs}
                nextOption={nextLookbackOption}
                onWiden={(opt) => setLookbackMs(opt.value)}
                error={error}
                onRetry={() => void load("manual")}
              />
            ) : (
              <div className="s-mc-stream s-fleet-live-stream home-arrive">
                {liveActivity.slice(0, 30).map((item) => (
                  <ActivityRow
                    key={item.id}
                    item={item}
                    nowMs={nowMs}
                    onOpen={() => {
                      const route = fleetActivityRoute(item);
                      if (route) navigate(route);
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Local tail is always on Home; the quiet-start composer joins it
            only when coordination is empty. Inside an embed the host owns the
            composer (MessageComposer renders nothing), so the Message panel is
            skipped rather than drawn as an empty frame. */}
        {!basic && <div className="s-fleet-section s-fleet-section--quiet-start">
          <div className="s-quiet-start">
            {showQuietStart && !composerEmbedded && (
              <QuietStartPanel
                agents={agents}
                navigate={navigate}
              />
            )}
            <LocalTailPanel navigate={navigate} />
          </div>
        </div>}

        {children}
      </div>
    </div>
    {(loading || (!basic && !gaugesSettled) || !tailSettled) && (
      <ConnectionTraceLog trace={loadTrace} label="Loading Scout" />
    )}
    </div>
  );
}

/* ── Sub-components ────────────────────────────────────────────────── */

export function SectionRule({
  label,
  right,
}: {
  label: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="s-section-rule">
      <span className="s-eyebrow">{label}</span>
      <span className="s-section-rule-line" />
      {right && <span className="s-section-rule-right">{right}</span>}
    </div>
  );
}

function MovingControls({
  sort,
  onSortChange,
  windowKey,
  onWindowChange,
}: {
  sort: HomeMovingSortMode;
  onSortChange: (next: string) => void;
  windowKey: string;
  onWindowChange: (next: string) => void;
}) {
  return (
    <div className="s-moving-controlset" aria-label="Moving cards controls">
      <div className="s-mc-window s-moving-window" role="group" aria-label="Moving sort">
        <span className="s-mc-window-label">Sort</span>
        <div className="s-mc-window-tabs">
          {([
            ["recent", "Recent"],
            ["grouped", "Grouped"],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={`s-mc-window-tab${sort === key ? " is-active" : ""}`}
              onClick={() => onSortChange(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="s-mc-window s-moving-window" role="group" aria-label="Moving activity window">
        <span className="s-mc-window-label">Window</span>
        <div className="s-mc-window-tabs">
          {HOME_MOVING_WINDOW_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              type="button"
              className={`s-mc-window-tab${windowKey === opt.key ? " is-active" : ""}`}
              onClick={() => onWindowChange(opt.key)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function MovingAskRow({
  ask,
  navigate,
}: {
  ask: FleetAsk;
  navigate: (r: Route) => void;
}) {
  const route = routeForFleetAsk(ask);

  return (
    <button
      className="s-moving-ask-row"
      onClick={() => navigate(route)}
    >
      <span className="s-moving-ask-agent">
        {ask.agentName ?? ask.agentId}
      </span>
      <span className="s-moving-ask-title">
        {ask.summary ?? ask.task}
      </span>
      <span className="s-moving-ask-state">
        {ask.statusLabel}
      </span>
      <span className="s-moving-ask-time">
        {timeAgo(ask.updatedAt)}
      </span>
    </button>
  );
}

function LookbackPicker({
  value,
  onChange,
  refreshing,
}: {
  value: number;
  onChange: (next: number) => void;
  refreshing?: boolean;
}) {
  return (
    <div className="s-mc-window" role="group" aria-label="Lookback window">
      <span className="s-mc-window-label">
        Lookback
        {refreshing && <span className="s-mc-window-refreshing" aria-label="refreshing" />}
      </span>
      <div className="s-mc-window-tabs">
        {LOOKBACK_WINDOWS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            className={`s-mc-window-tab${opt.value === value ? " is-active" : ""}`}
            onClick={() => onChange(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/* Skeleton rows wear the real row classes and hold an invisible line of text,
   so each placeholder is exactly as tall as the row that replaces it. */
function MovingSkeleton({ rows }: { rows: number }) {
  if (rows === 0) {
    return (
      <div className="s-fleet-live-empty" aria-hidden="true">
        <span className="home-skel" style={{ width: 180 }} />
        {"\u00a0"}
      </div>
    );
  }
  return (
    <div className="s-moving-signal-stage s-moving-signal-skeleton" aria-hidden="true">
      <div className="s-moving-signal-list">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="s-moving-signal-item">
            <div className="s-moving-signal-row s-moving-signal-row--skeleton">
              <span className="s-moving-signal-age"><span className="home-skel" style={{ width: 28 }} />{"\u00a0"}</span>
              <span className="home-skel home-skel--dot" />
              <span className="s-moving-signal-where"><span className="s-moving-signal-project"><span className="home-skel" style={{ width: 84 }} />{"\u00a0"}</span></span>
              <span className="s-moving-signal-action" style={{ width: `${40 + ((i * 17) % 30)}%` }}><span className="home-skel" style={{ width: "70%" }} />{"\u00a0"}</span>
              <span><span className="home-skel" style={{ width: 32 }} /></span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ActivityStreamSkeleton({ rows }: { rows: number }) {
  return (
    <div className="s-mc-stream s-fleet-live-stream s-fleet-live-stream--skeleton" aria-hidden="true">
      {Array.from({ length: Math.max(rows, 3) }, (_, i) => (
        <div key={i} className="s-mc-stream-row">
          <span className="s-mc-stream-time"><span className="home-skel" style={{ width: 20 }} />{"\u00a0"}</span>
          <span className="s-mc-stream-actor"><span className="home-skel" style={{ width: 96 }} /></span>
          <span className="s-mc-stream-verb"><span className="home-skel" style={{ width: 72 }} /></span>
          <span className="s-mc-stream-text"><span className="home-skel" style={{ width: `${52 + ((i * 23) % 40)}%` }} /></span>
        </div>
      ))}
    </div>
  );
}

function LiveActivityEmpty({
  lookbackMs,
  nextOption,
  onWiden,
  error,
  onRetry,
}: {
  lookbackMs: number;
  nextOption: LookbackOption | null;
  onWiden: (opt: LookbackOption) => void;
  error: string | null;
  onRetry: () => void;
}) {
  // Empty and error both collapse to one quiet line under the section rule:
  // "nothing happened" should cost a line, not a box. Freshness already lives
  // in the cockpit's "Last updated" readout, so it is not repeated here.
  if (error) {
    return (
      <div className="s-fleet-live-empty s-fleet-live-empty--error" role="status">
        <span className="s-fleet-live-empty-title">Couldn’t load activity</span>
        <span className="s-fleet-live-empty-detail" title={error}>{error}</span>
        <button type="button" className="s-link-btn" onClick={onRetry}>
          Try again
        </button>
      </div>
    );
  }
  return (
    <div className="s-fleet-live-empty" role="status">
      <span className="s-fleet-live-empty-title">
        No Scout messages or dispatches in the last {formatLookback(lookbackMs)}
      </span>
      {nextOption && (
        <button
          type="button"
          className="s-link-btn"
          onClick={() => onWiden(nextOption)}
        >
          Widen to {nextOption.label}
        </button>
      )}
    </div>
  );
}

type QuietSendResult = {
  conversationId?: string;
  flight?: {
    targetAgentId?: string | null;
  };
};

function sortedCatchupAgents(agents: Agent[]): Agent[] {
  return [...agents].sort((a, b) => {
    const aState = normalizeAgentState(a.state);
    const bState = normalizeAgentState(b.state);
    const aRank = aState === "callable" ? 0 : (aState === "in_turn" || aState === "in_flight") ? 1 : 2;
    const bRank = bState === "callable" ? 0 : (bState === "in_turn" || bState === "in_flight") ? 1 : 2;
    return aRank - bRank || a.name.localeCompare(b.name);
  });
}

function QuietStartPanel({
  agents,
  navigate,
}: {
  agents: Agent[];
  navigate: (r: Route) => void;
}) {
  const catchupAgents = useMemo(() => sortedCatchupAgents(agents), [agents]);
  const [agentId, setAgentId] = useState(() => catchupAgents[0]?.id ?? "");
  const selectedAgent = catchupAgents.find((agent) => agent.id === agentId) ?? null;
  const [runtimeCapabilities, setRuntimeCapabilities] = useState<RuntimeCapabilityCatalog | null>(null);
  const [refreshingModels, setRefreshingModels] = useState(false);
  const [modelRefreshError, setModelRefreshError] = useState<string | null>(null);
  const runtimeCatalogLoaderRef = useRef(createRuntimeCatalogLoader<RuntimeCapabilityCatalog>());
  const [prompt, setPrompt] = useState("");
  const [harness, setHarness] = useState(selectedAgent?.harness?.trim() ?? "");
  const [model, setModel] = useState(selectedAgent?.model?.trim() ?? "");
  const [reasoningEffort, setReasoningEffort] = useState("medium");
  const [submitting, setSubmitting] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const effectiveCapabilities = runtimeCapabilities ?? RUNTIME_CAPABILITY_SEED;

  useEffect(() => {
    if (catchupAgents.some((agent) => agent.id === agentId)) return;
    setAgentId(catchupAgents[0]?.id ?? "");
  }, [agentId, catchupAgents]);

  useEffect(() => {
    setHarness(selectedAgent?.harness?.trim() ?? "");
    setModel(selectedAgent?.model?.trim() ?? "");
  }, [selectedAgent?.id]);

  const refreshRuntimeModels = async () => {
    const query = new URLSearchParams({ scope: "global+project", force: "true" });
    const projectRoot = selectedAgent?.projectRoot?.trim() || selectedAgent?.cwd?.trim();
    if (projectRoot) query.set("projectRoot", projectRoot);
    setRefreshingModels(true);
    setModelRefreshError(null);
    await runtimeCatalogLoaderRef.current.load(
      () => api<RuntimeCapabilityCatalog>(`/api/runner/options?${query}`),
      {
        publish: setRuntimeCapabilities,
        failed: () => setModelRefreshError("Model refresh is unavailable. Your draft and saved choices are kept."),
        finished: () => setRefreshingModels(false),
      },
    );
  };

  useEffect(() => {
    const projectRoot = selectedAgent?.projectRoot?.trim() || selectedAgent?.cwd?.trim();
    const query = new URLSearchParams({ scope: "global+project" });
    if (projectRoot) query.set("projectRoot", projectRoot);
    const loader = runtimeCatalogLoaderRef.current;
    setRefreshingModels(false);
    setModelRefreshError(null);
    void loader.load(() => api<RuntimeCapabilityCatalog>(`/api/runner/options?${query}`), {
      publish: (options) => {
        if (options.schemaVersion === "openscout.runtime-capabilities.v1") setRuntimeCapabilities(options);
      },
    });
    return () => { loader.invalidate(); };
  }, [selectedAgent?.cwd, selectedAgent?.projectRoot]);

  const effectiveHarness = harness || selectedAgent?.harness?.trim() || "";
  // The picker runs on a nested catalog. The selected agent's observed runtime
  // may predate the capability snapshot, so an unlisted harness is appended —
  // the offline fallback the old flat option lists provided.
  const runtimeCatalog = useMemo(() => {
    const catalog = runtimeCatalogFromCapabilities(effectiveCapabilities);
    if (effectiveHarness && !catalog.harnesses.some((entry) => entry.value === effectiveHarness)) {
      return {
        ...catalog,
        harnesses: [
          ...catalog.harnesses,
          {
            value: effectiveHarness,
            label: effectiveHarness,
            models: [{ value: "", label: "Default", note: "harness picks" }],
          },
        ],
      };
    }
    return catalog;
  }, [effectiveCapabilities, effectiveHarness]);

  // Outside user interaction (capabilities arriving, agent switching) the
  // picker never sees a change event, so the effort clamp lives here.
  useEffect(() => {
    const efforts = effortsFor(runtimeCatalog, effectiveHarness, model);
    if (!efforts || efforts.some((candidate) => candidate.value === reasoningEffort)) return;
    setReasoningEffort(efforts.find((candidate) => candidate.value === "medium")?.value
      ?? efforts[0]?.value
      ?? "");
  }, [runtimeCatalog, effectiveHarness, model, reasoningEffort]);

  const submitMessage = async (event?: React.FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    const trimmed = prompt.trim();
    if (!selectedAgent || !trimmed || submitting) return;
    setSubmitting(true);
    setSendError(null);
    try {
      const conversationId = await ensureAgentChat(selectedAgent);
      const result = await api<QuietSendResult>("/api/send", {
        method: "POST",
        body: JSON.stringify({
          body: trimmed,
          chatId: conversationId,
          execution: {
            harness: harness || undefined,
            model: model || undefined,
            reasoningEffort: reasoningEffort || undefined,
          },
        }),
      });
      // This screen stays alive while navigation moves into the conversation.
      // Clear only after Scout accepted the send, so returning here starts a
      // genuinely new message while a failed request remains available to retry.
      setPrompt("");
      const routedChatId = result.conversationId ?? conversationId;
      navigate({ view: "conversation", conversationId: routedChatId });
    } catch (submitError) {
      setSendError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="s-quiet-panel s-quiet-panel--ask">
      <div className="s-quiet-panel-head">
        <span className="s-eyebrow">Message</span>
      </div>
      <div className="s-quiet-compose">
        <MessageComposer
          density="panel"
          value={prompt}
          onChange={setPrompt}
          onSend={() => void submitMessage()}
          placeholder="Type a message…"
          disabled={submitting || !selectedAgent}
          sending={submitting}
          canSend={!submitting && Boolean(selectedAgent) && prompt.trim().length > 0}
          leadingTools={(
            /* Target rides in the toolbar like every other composer control
               (main-composer grammar) — not as a bar above the input. */
            <div className="s-quiet-target-chip">
              <span className="s-quiet-label">To</span>
              <MessageComposerToolSelect
                label="Send to agent"
                value={agentId}
                onChange={setAgentId}
                disabled={catchupAgents.length === 0 || submitting}
                options={catchupAgents.length === 0
                  ? [{ value: "", label: "No registered agents" }]
                  : catchupAgents.map((agent) => ({
                      value: agent.id,
                      label: agent.name,
                    }))}
              />
            </div>
          )}
          tools={(
            /* Right cluster: runtime · mic · Send. One chip replaces the
               harness and model selects — the harness reads as its mark. */
            <RuntimePicker
              catalog={runtimeCatalog}
              onRefreshModels={() => { void refreshRuntimeModels(); }}
              refreshingModels={refreshingModels}
              catalogStatus={runtimeModelCatalogStatus(runtimeCapabilities)}
              catalogWarning={modelRefreshError ?? runtimeCapabilities?.warnings?.[0]}
              value={{ harness: effectiveHarness, model, effort: reasoningEffort }}
              onChange={(next: RuntimeValue) => {
                // "" keeps its meaning: run on the agent's own runtime.
                setHarness(next.harness === (selectedAgent?.harness?.trim() ?? "")
                  ? ""
                  : next.harness);
                setModel(next.model);
                setReasoningEffort(next.effort);
              }}
              disabled={submitting || !selectedAgent}
            />
          )}
        />
      </div>
      {sendError && <div className="s-quiet-error">{sendError}</div>}
    </div>
  );
}

/** Local tail on Home. Always mounted — independent of coordination state. */
function LocalTailPanel({ navigate }: { navigate: (r: Route) => void }) {
  return (
    <div className="s-quiet-panel s-quiet-panel--tail">
      <div className="s-quiet-panel-head">
        <span className="s-eyebrow">Local tail</span>
        <button
          type="button"
          className="s-icon-btn"
          title="Open tail"
          onClick={() => navigate({ view: "ops", mode: "tail" })}
        >
          <ExternalLink size={14} aria-hidden="true" />
          <span>Open tail</span>
        </button>
      </div>
      <div className="s-quiet-tail-frame">
        <TailView navigate={navigate} chrome="embedded" />
      </div>
    </div>
  );
}

function ActivityRow({
  item,
  nowMs,
  onOpen,
}: {
  item: FleetActivity;
  nowMs: number;
  onOpen: () => void;
}) {
  const actor = item.actorName ?? "—";
  const verb = activityVerb(item.kind);
  const text = summarize(item.title ?? item.summary, 110);
  return (
    <button type="button" className="s-mc-stream-row" onClick={onOpen}>
      <span className="s-mc-stream-time">{formatAge(item.ts, nowMs)}</span>
      <span className="s-mc-stream-actor">{actor}</span>
      <span className="s-mc-stream-verb">{verb}</span>
      <span className="s-mc-stream-text">{text}</span>
    </button>
  );
}

/** @deprecated Use HomeContent */
export { HomeContent as HomeScreen };
