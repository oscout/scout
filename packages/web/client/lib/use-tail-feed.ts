import { startTransition, useCallback, useEffect, useRef, useState } from "react";

import { api } from "./api.ts";
import { useTailEvents } from "./tail-events.ts";
import { appendLiveTailEvent, mergeHydratedTailEvents } from "./tail-event-merge.ts";
import { isScoutSurfaceActive, onScoutSurfaceActivated } from "./surface-activity.ts";
import type { TailDiscoverySnapshot, TailEvent } from "./types.ts";
import {
  loadTailHistoryProgressively,
  shouldRetryTailHistoryAfterDiscovery,
  tailHistoryHydrationKey,
  tailReadyEventLimit,
  type TailFeedLoadPhase,
  type TailFeedLoadState,
  type TailHistoryHydrationPhase,
} from "./tail-feed-state.ts";

export { tailFeedFailure } from "./tail-feed-state.ts";
export type { TailFeedLoadPhase, TailFeedLoadState } from "./tail-feed-state.ts";

const DEFAULT_RECENT_LIMIT = 500;
const DEFAULT_DISCOVERY_INTERVAL_MS = 60_000;

type TailDiscoveryScope = "hot" | "shallow" | "deep";

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
  recentWindowMs?: number,
): Promise<TailEvent[]> {
  const params = new URLSearchParams({ limit: String(recentLimit) });
  if (includeTranscriptReplay) {
    params.set("transcripts", "true");
  }
  if (typeof recentWindowMs === "number" && Number.isFinite(recentWindowMs) && recentWindowMs > 0) {
    params.set("windowMs", String(Math.floor(recentWindowMs)));
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
  discoveryScope?: TailDiscoveryScope;
  discoveryLimit?: number;
  recentWindowMs?: number;
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
  const discoveryScope = options?.discoveryScope;
  const discoveryLimit = options?.discoveryLimit;
  const recentWindowMs = options?.recentWindowMs;
  const pauseWhenHidden = options?.pauseWhenHidden ?? false;
  const historyHydrationKey = tailHistoryHydrationKey({
    recentLimit,
    includeTranscriptReplay,
    recentWindowMs,
    discoveryScope,
    discoveryLimit,
  });

  const [discovery, setDiscovery] = useState<TailDiscoverySnapshot | null>(null);
  const [events, setEvents] = useState<TailEvent[]>([]);
  const [loadState, setLoadState] = useState<TailFeedLoadState>({
    discovery: "loading",
    recent: "loading",
    discoveryLoaded: false,
    recentLoaded: false,
  });
  const recentPhaseRef = useRef<TailFeedLoadPhase>("loading");
  const historyPhaseRef = useRef<TailHistoryHydrationPhase>("idle");
  const hydratedHistoryKeyRef = useRef<string | null>(null);
  const recentRequestRef = useRef<{ key: string; promise: Promise<void> } | null>(null);
  const recentRequestSequenceRef = useRef(0);

  useTailEvents((event) => {
    setEvents((previous) => appendLiveTailEvent(previous, event, recentLimit));
  }, enabled);

  const refreshRecent = useCallback((showLoading = false): Promise<void> => {
    if (!enabled) return Promise.resolve();
    // Initial/retry hydration is correctness work, not background polling.
    // A visible WKWebView can report `document.hasFocus() === false` while the
    // native sidebar is first responder; refusing the first request in that
    // state leaves Tail and Lanes on their loading sheet indefinitely.
    if (pauseWhenHidden && !showLoading && !isScoutSurfaceActive()) return Promise.resolve();
    if (showLoading) {
      recentPhaseRef.current = "loading";
      setLoadState((previous) => ({ ...previous, recent: "loading" }));
    }
    const requestKey = historyHydrationKey;
    const inFlight = recentRequestRef.current;
    if (inFlight?.key === requestKey) return inFlight.promise;

    const sequence = ++recentRequestSequenceRef.current;
    historyPhaseRef.current = includeTranscriptReplay ? "loading" : "ready";
    let request: Promise<void>;
    request = loadTailHistoryProgressively({
      includeTranscriptReplay,
      load: (replay) => fetchRecentTailEvents(
        replay ? recentLimit : tailReadyEventLimit(recentLimit, includeTranscriptReplay),
        replay,
        recentWindowMs,
      ),
      publish: (hydrated, phase) => {
        if (sequence !== recentRequestSequenceRef.current) return;
        const merge = () => {
          setEvents((previous) => mergeHydratedTailEvents(previous, hydrated, recentLimit));
        };
        if (phase === "replay") {
          // A multi-megabyte archival response should not pre-empt navigation,
          // filtering, or live tail events once the useful surface has painted.
          startTransition(merge);
        } else {
          merge();
        }
      },
      markReady: () => {
        if (sequence === recentRequestSequenceRef.current) {
          recentPhaseRef.current = "ready";
          setLoadState((previous) => ({ ...previous, recent: "ready", recentLoaded: true }));
        }
      },
    })
      .then((result) => {
        if (sequence === recentRequestSequenceRef.current) {
          if (includeTranscriptReplay) {
            historyPhaseRef.current = result.replay === "failed" ? "error" : "ready";
          }
          if (result.replay !== "failed") {
            hydratedHistoryKeyRef.current = historyHydrationKey;
          }
        }
      })
      .catch(() => {
        if (sequence === recentRequestSequenceRef.current) {
          recentPhaseRef.current = "error";
          if (includeTranscriptReplay) historyPhaseRef.current = "error";
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
  }, [enabled, historyHydrationKey, includeTranscriptReplay, pauseWhenHidden, recentLimit, recentWindowMs]);

  const refreshDiscovery = useCallback(async (showLoading = false) => {
    if (!enabled) return;
    if (pauseWhenHidden && !showLoading && !isScoutSurfaceActive()) return;
    if (showLoading) {
      setLoadState((previous) => ({ ...previous, discovery: "loading" }));
    }
    try {
      const snap = await api<TailDiscoverySnapshot>(tailDiscoveryPath(discoveryScope, discoveryLimit));
      setDiscovery(snap);
      setLoadState((previous) => ({ ...previous, discovery: "ready", discoveryLoaded: true }));
      // Successful discovery ticks only refresh source descriptors. Historical
      // replay is initial/keyed enrichment; a tick retries it only after a live
      // or archival failure, including on a quiet fleet with no fallback lanes.
      if (shouldRetryTailHistoryAfterDiscovery(recentPhaseRef.current, historyPhaseRef.current)) {
        void refreshRecent();
      }
    } catch {
      setDiscovery((previous) => previous ?? emptyTailDiscoverySnapshot());
      setLoadState((previous) => ({ ...previous, discovery: "error" }));
    }
  }, [discoveryLimit, discoveryScope, enabled, pauseWhenHidden, refreshRecent]);

  const retryInitialLoad = useCallback(async () => {
    await Promise.all([
      refreshDiscovery(true),
      refreshRecent(true),
    ]);
  }, [refreshDiscovery, refreshRecent]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let initial = true;
    const tick = () => {
      if (!cancelled) void refreshDiscovery(initial);
      initial = false;
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
    if (enabled) return;
    // Re-enabling the feed is a new initial load. Invalidate any completion
    // racing from the disabled epoch so it cannot suppress that hydration.
    recentRequestSequenceRef.current += 1;
    recentRequestRef.current = null;
    hydratedHistoryKeyRef.current = null;
    historyPhaseRef.current = "idle";
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    if (hydratedHistoryKeyRef.current === historyHydrationKey) return;
    // Initial and history-key hydration must run even when the native shell,
    // rather than the WKWebView document, owns focus. `refreshRecent(true)`
    // deliberately bypasses background-poll gating for this correctness pass.
    void refreshRecent(true);
  }, [enabled, historyHydrationKey, refreshRecent]);

  return { discovery, events, loadState, refreshDiscovery, retryInitialLoad };
}
