import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api.ts";
import {
  buildFleetActiveAskIndex,
  type FleetActiveAskIndex,
} from "./fleet-active-asks.ts";
import { useBrokerEvents } from "./sse.ts";
import type { FleetState } from "./types.ts";

/** A working turn emits several broker events per second; every one used to
 *  refetch /api/fleet — one of the heaviest reads the client makes. Events
 *  inside this window ride along on one trailing refetch instead. */
const FLEET_REFRESH_TRAILING_MS = 1_500;

/**
 * Loads /api/fleet and exposes a conversation-first active ask index.
 * Refreshes on message.posted / flight.updated / collaboration.event.appended,
 * coalesced to at most one fetch per trailing window.
 */
export function useFleetActiveAsks(): FleetActiveAskIndex {
  const [fleet, setFleet] = useState<FleetState | null>(null);
  const refreshTimerRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    const data = await api<FleetState>("/api/fleet").catch(() => null);
    setFleet(data);
  }, []);

  useEffect(() => {
    void load();
    return () => {
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [load]);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimerRef.current !== null) return;
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null;
      void load();
    }, FLEET_REFRESH_TRAILING_MS);
  }, [load]);

  useBrokerEvents((event) => {
    if (
      event.kind === "message.posted" ||
      event.kind === "flight.updated" ||
      event.kind === "collaboration.event.appended"
    ) {
      scheduleRefresh();
    }
  });

  return useMemo(
    () => buildFleetActiveAskIndex(fleet?.activeAsks ?? []),
    [fleet?.activeAsks],
  );
}
