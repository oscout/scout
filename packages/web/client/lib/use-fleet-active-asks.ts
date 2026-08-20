import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api.ts";
import { useBrokerEvents } from "./sse.ts";
import type { FleetAsk, FleetState } from "./types.ts";

const ACTIVE_ASK_STATUSES = new Set<FleetAsk["status"]>([
  "working",
  "queued",
  "needs_attention",
]);

/**
 * Loads /api/fleet and exposes the most recent active ask per agent.
 * Refreshes on message.posted / flight.updated / collaboration.event.appended.
 */
export function useFleetActiveAsks(): Map<string, FleetAsk> {
  const [fleet, setFleet] = useState<FleetState | null>(null);

  const load = useCallback(async () => {
    const data = await api<FleetState>("/api/fleet").catch(() => null);
    setFleet(data);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useBrokerEvents((event) => {
    if (
      event.kind === "message.posted" ||
      event.kind === "flight.updated" ||
      event.kind === "collaboration.event.appended"
    ) {
      void load();
    }
  });

  return useMemo(() => {
    const map = new Map<string, FleetAsk>();
    for (const ask of fleet?.activeAsks ?? []) {
      if (!ACTIVE_ASK_STATUSES.has(ask.status)) continue;
      const existing = map.get(ask.agentId);
      if (!existing || ask.updatedAt > existing.updatedAt) {
        map.set(ask.agentId, ask);
      }
    }
    return map;
  }, [fleet]);
}
