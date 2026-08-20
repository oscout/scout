import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api.ts";
import { filterAgentsByMachineScope } from "../../lib/machine-scope.ts";
import { routeMachineId } from "../../lib/router.ts";
import { useBrokerEvents } from "../../lib/sse.ts";
import { isScoutSurfaceActive, onScoutSurfaceActivated } from "../../lib/surface-activity.ts";
import { useScout } from "../../scout/Provider.tsx";
import type {
  FleetAsk,
  FleetState,
  SessionEntry,
  TailDiscoverySnapshot,
} from "../../lib/types.ts";
import {
  buildDirProjects,
  buildNativeSessionRows,
  directSessionMaps,
  rowForAgentInventory,
  type DirProject,
} from "./model.ts";

/**
 * The project directory, built from the same inputs the content pane uses so the
 * left-lane navigator and the detail stay in lockstep. Polls on an interval and
 * on broker events. Shared so the rail doesn't reinvent project grouping.
 */
export function useAgentDirectory(): { projects: DirProject[] } {
  const { agents, route } = useScout();
  const machineId = routeMachineId(route);
  const scoped = useMemo(() => filterAgentsByMachineScope(agents, machineId), [agents, machineId]);

  const [sessions, setSessions] = useState<SessionEntry[]>([]);
  const [fleet, setFleet] = useState<FleetState | null>(null);
  const [discovery, setDiscovery] = useState<TailDiscoverySnapshot | null>(null);

  const load = useCallback(async () => {
    const [s, f, d] = await Promise.allSettled([
      api<SessionEntry[]>("/api/conversations"),
      api<FleetState>("/api/fleet"),
      api<TailDiscoverySnapshot>("/api/tail/discover"),
    ]);
    if (s.status === "fulfilled") setSessions(s.value);
    if (f.status === "fulfilled") setFleet(f.value);
    if (d.status === "fulfilled") setDiscovery(d.value);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const refreshIfActive = () => {
      if (isScoutSurfaceActive()) void load();
    };
    const id = window.setInterval(refreshIfActive, 10_000);
    const stopActivationListener = onScoutSurfaceActivated(refreshIfActive);
    return () => {
      window.clearInterval(id);
      stopActivationListener();
    };
  }, [load]);
  useBrokerEvents(() => {
    if (isScoutSurfaceActive()) void load();
  });

  const asksByAgent = useMemo(() => {
    const m = new Map<string, FleetAsk[]>();
    for (const ask of fleet?.activeAsks ?? []) {
      const list = m.get(ask.agentId) ?? [];
      list.push(ask);
      m.set(ask.agentId, list);
    }
    return m;
  }, [fleet?.activeAsks]);

  const projects = useMemo(() => {
    const { sessionByAgentId } = directSessionMaps(sessions);
    const rows = scoped.map((agent) =>
      rowForAgentInventory(
        agent,
        sessionByAgentId.get(agent.id) ?? null,
        asksByAgent.get(agent.id) ?? [],
      ),
    );
    const native = buildNativeSessionRows(discovery, Date.now());
    return buildDirProjects(rows, sessions, native);
  }, [scoped, sessions, asksByAgent, discovery]);

  return { projects };
}
