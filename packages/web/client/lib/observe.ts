import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "./api.ts";
import { isAgentBusy } from "./agent-state.ts";
import { isScoutSurfaceActive, onScoutSurfaceActivated } from "./surface-activity.ts";
import type { Agent, AgentObservePayload, ObserveEvent } from "./types.ts";

const ACTIVE_POLL_INTERVAL_MS = 10_000;
const IDLE_POLL_INTERVAL_MS = 60_000;

export type ObserveCacheEntry = Omit<AgentObservePayload, "agentId">;
export type ObserveCache = Record<string, ObserveCacheEntry>;

export function useObservePolling(agents: Agent[], options?: {
  enabled?: boolean;
  activeIntervalMs?: number;
  idleIntervalMs?: number;
  pauseWhenHidden?: boolean;
}): ObserveCache {
  const [cache, setCache] = useState<ObserveCache>({});
  const enabled = options?.enabled ?? true;
  const mountedRef = useRef(true);
  const inFlightRef = useRef(false);
  const queuedRef = useRef(false);
  const pauseWhenHidden = options?.pauseWhenHidden ?? false;
  const agentIds = agents
    .map((agent) => agent.id.trim())
    .filter((agentId) => agentId.length > 0)
    .join(",");
  const pollIntervalMs = agents.some((agent) => isAgentBusy(agent.state))
    ? (options?.activeIntervalMs ?? ACTIVE_POLL_INTERVAL_MS)
    : (options?.idleIntervalMs ?? IDLE_POLL_INTERVAL_MS);

  const fetchAll = useCallback(async () => {
    if (!enabled) return;
    if (agents.length === 0) {
      setCache({});
      return;
    }
    if (pauseWhenHidden && !isScoutSurfaceActive()) return;
    if (inFlightRef.current) {
      queuedRef.current = true;
      return;
    }
    inFlightRef.current = true;

    try {
      const query = agentIds ? `?ids=${encodeURIComponent(agentIds)}` : "";
      const results = await api<AgentObservePayload[]>(`/api/observe/agents${query}`);

      if (!mountedRef.current) {
        return;
      }

      setCache((previous) => {
        const next: ObserveCache = {};
        for (const agent of agents) {
          next[agent.id] = previous[agent.id];
        }
        for (const result of results) {
          const { agentId, ...entry } = result;
          next[agentId] = entry;
        }
        return next;
      });
    } finally {
      inFlightRef.current = false;
      if (queuedRef.current) {
        queuedRef.current = false;
        void fetchAll();
      }
    }
  }, [agentIds, agents, enabled, pauseWhenHidden]);

  useEffect(() => {
    mountedRef.current = true;
    if (!enabled || agents.length === 0) {
      setCache({});
      return () => {
        mountedRef.current = false;
      };
    }
    void fetchAll();
    const timer = setInterval(() => void fetchAll(), pollIntervalMs);
    const stopActivationListener = pauseWhenHidden
      ? onScoutSurfaceActivated(() => void fetchAll())
      : null;
    return () => {
      mountedRef.current = false;
      clearInterval(timer);
      stopActivationListener?.();
    };
  }, [agents.length, enabled, fetchAll, pauseWhenHidden, pollIntervalMs]);
  return cache;
}

export function summarizeObserveEvent(event: ObserveEvent): string {
  switch (event.kind) {
    case "tool":
      return `${event.tool ?? "tool"} ${event.arg ?? ""}`.trim();
    case "think":
      return event.text.slice(0, 120);
    case "ask":
      return `ask: ${event.text}`.slice(0, 120);
    case "message":
      return event.text.slice(0, 100);
    case "note":
      return event.text.slice(0, 100);
    case "system":
    case "boot":
      return event.text.slice(0, 100);
  }
}
