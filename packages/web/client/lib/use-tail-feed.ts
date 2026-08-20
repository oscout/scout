import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "./api.ts";
import { useTailEvents } from "./tail-events.ts";
import { appendLiveTailEvent, mergeHydratedTailEvents } from "./tail-event-merge.ts";
import { isScoutSurfaceActive, onScoutSurfaceActivated } from "./surface-activity.ts";
import type { TailDiscoverySnapshot, TailEvent } from "./types.ts";

const DEFAULT_RECENT_LIMIT = 500;
const DEFAULT_DISCOVERY_INTERVAL_MS = 30_000;

type TailDiscoveryScope = "hot" | "shallow" | "deep";

export type TailFeedLoadPhase = "loading" | "ready" | "error";

export type TailFeedLoadState = {
  discovery: TailFeedLoadPhase;
  recent: TailFeedLoadPhase;
};

function emptyTailDiscoverySnapshot(): TailDiscoverySnapshot {
  return {
    generatedAt: Date.now(),
    processes: [],
    transcripts: [],
    totals: {
      total: 0,
      scoutManaged: 0,
      hudsonManaged: 0,
      unattributed: 0,
      transcripts: 0,
    },
  };
}

async function fetchRecentTailEvents(
  recentLimit: number,
  includeTranscriptReplay: boolean,
): Promise<TailEvent[]> {
  const params = new URLSearchParams({ limit: String(recentLimit) });
  if (includeTranscriptReplay) {
    params.set("transcripts", "true");
  }
  const result = await api<{ events: TailEvent[] }>(
    `/api/tail/recent?${params.toString()}`,
  );
  return result.events ?? [];
}

function tailDiscoveryPath(scope?: TailDiscoveryScope, limit?: number): string {
  const params = new URLSearchParams();
  if (scope) params.set("scope", scope);
  if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) {
    params.set("limit", String(Math.floor(limit)));
  }
  const query = params.toString();
  return query ? `/api/tail/discover?${query}` : "/api/tail/discover";
}

export function useTailFeed(options?: {
  enabled?: boolean;
  recentLimit?: number;
  discoveryIntervalMs?: number;
  includeTranscriptReplay?: boolean;
  hydrateOnDiscovery?: boolean;
  discoveryScope?: TailDiscoveryScope;
  discoveryLimit?: number;
  pauseWhenHidden?: boolean;
}): {
  discovery: TailDiscoverySnapshot | null;
  events: TailEvent[];
  loadState: TailFeedLoadState;
  refreshDiscovery: (showLoading?: boolean) => Promise<void>;
  retryInitialLoad: () => Promise<void>;
} {
  const recentLimit = options?.recentLimit ?? DEFAULT_RECENT_LIMIT;
  const enabled = options?.enabled ?? true;
  const discoveryIntervalMs = options?.discoveryIntervalMs ?? DEFAULT_DISCOVERY_INTERVAL_MS;
  const includeTranscriptReplay = options?.includeTranscriptReplay ?? false;
  const hydrateOnDiscovery = options?.hydrateOnDiscovery ?? includeTranscriptReplay;
  const discoveryScope = options?.discoveryScope;
  const discoveryLimit = options?.discoveryLimit;
  const pauseWhenHidden = options?.pauseWhenHidden ?? false;

  const [discovery, setDiscovery] = useState<TailDiscoverySnapshot | null>(null);
  const [events, setEvents] = useState<TailEvent[]>([]);
  const [loadState, setLoadState] = useState<TailFeedLoadState>({
    discovery: "loading",
    recent: "loading",
  });
  const recentRequestRef = useRef<{ key: string; promise: Promise<void> } | null>(null);
  const recentRequestSequenceRef = useRef(0);

  useTailEvents((event) => {
    setEvents((previous) => appendLiveTailEvent(previous, event, recentLimit));
  }, enabled);

  const refreshRecent = useCallback((showLoading = false): Promise<void> => {
    if (!enabled) return Promise.resolve();
    if (pauseWhenHidden && !isScoutSurfaceActive()) return Promise.resolve();
    if (showLoading) {
      setLoadState((previous) => ({ ...previous, recent: "loading" }));
    }
    const requestKey = `${recentLimit}:${includeTranscriptReplay ? "replay" : "live"}`;
    const inFlight = recentRequestRef.current;
    if (inFlight?.key === requestKey) return inFlight.promise;

    const sequence = ++recentRequestSequenceRef.current;
    let request: Promise<void>;
    request = fetchRecentTailEvents(recentLimit, includeTranscriptReplay)
      .then((hydrated) => {
        setEvents((previous) => mergeHydratedTailEvents(previous, hydrated, recentLimit));
        if (sequence === recentRequestSequenceRef.current) {
          setLoadState((previous) => ({ ...previous, recent: "ready" }));
        }
      })
      .catch(() => {
        if (sequence === recentRequestSequenceRef.current) {
          setLoadState((previous) => ({ ...previous, recent: "error" }));
        }
      })
      .finally(() => {
        if (recentRequestRef.current?.promise === request) {
          recentRequestRef.current = null;
        }
      });
    recentRequestRef.current = { key: requestKey, promise: request };
    return request;
  }, [enabled, includeTranscriptReplay, pauseWhenHidden, recentLimit]);

  const refreshDiscovery = useCallback(async (showLoading = false) => {
    if (!enabled) return;
    if (pauseWhenHidden && !isScoutSurfaceActive()) return;
    if (showLoading) {
      setLoadState((previous) => ({ ...previous, discovery: "loading" }));
    }
    try {
      const snap = await api<TailDiscoverySnapshot>(tailDiscoveryPath(discoveryScope, discoveryLimit));
      setDiscovery(snap);
      setLoadState((previous) => ({ ...previous, discovery: "ready" }));
      if (hydrateOnDiscovery && ((snap.transcripts?.length ?? 0) > 0 || snap.processes.length > 0)) {
        void refreshRecent();
      }
    } catch {
      setDiscovery((previous) => previous ?? emptyTailDiscoverySnapshot());
      setLoadState((previous) => ({ ...previous, discovery: "error" }));
    }
  }, [discoveryLimit, discoveryScope, enabled, hydrateOnDiscovery, pauseWhenHidden, refreshRecent]);

  const retryInitialLoad = useCallback(async () => {
    await Promise.all([
      refreshDiscovery(true),
      refreshRecent(true),
    ]);
  }, [refreshDiscovery, refreshRecent]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const tick = () => {
      if (!cancelled) void refreshDiscovery();
    };
    tick();
    const timer = setInterval(tick, discoveryIntervalMs);
    const stopActivationListener = pauseWhenHidden ? onScoutSurfaceActivated(tick) : null;
    return () => {
      cancelled = true;
      clearInterval(timer);
      stopActivationListener?.();
    };
  }, [discoveryIntervalMs, enabled, pauseWhenHidden, refreshDiscovery]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let started = false;
    const hydrate = () => {
      if (cancelled || started || (pauseWhenHidden && !isScoutSurfaceActive())) return;
      started = true;
      void refreshRecent(true);
    };
    hydrate();
    const stopActivationListener = pauseWhenHidden ? onScoutSurfaceActivated(hydrate) : null;
    return () => {
      cancelled = true;
      stopActivationListener?.();
    };
  }, [enabled, pauseWhenHidden, refreshRecent]);

  return { discovery, events, loadState, refreshDiscovery, retryInitialLoad };
}
