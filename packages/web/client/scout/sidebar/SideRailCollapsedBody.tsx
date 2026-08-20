/**
 * Per-area content for the minimized (collapsed) left context rail.
 * Chat keeps a dedicated strip; other areas get lightweight chips for jump-in.
 * The right inspector collapses to a chevron-only handle (no body).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  LayoutGrid,
  ListTodo,
  Users,
} from "lucide-react";
import { api } from "../../lib/api.ts";
import { actorColor } from "../../lib/colors.ts";
import {
  isAgentOnline,
  normalizeAgentState,
} from "../../lib/agent-state.ts";
import {
  filterAgentsByMachineScope,
  filterFleetByMachineScope,
  machineScopedAgentIds,
} from "../../lib/machine-scope.ts";
import { bucketAgentsByMachine } from "../../lib/mesh-buckets.ts";
import { useMeshViewStore } from "../../lib/mesh-view-store.ts";
import { routeMachineId } from "../../lib/router.ts";
import { useBrokerEvents } from "../../lib/sse.ts";
import {
  fetchTerminalSessions,
  terminalListItems,
  terminalSurfaceIdsEqual,
} from "../../lib/terminal-sessions.ts";
import type { Agent, FleetState, Route } from "../../lib/types.ts";
import { useScout } from "../Provider.tsx";
import { openAgent } from "../slots/openAgent.ts";
import { ChatCollapsedStrip } from "../../screens/chat/ChatCollapsedStrip.tsx";
import {
  chipInitial,
  CollapsedChip,
  CollapsedStrip,
  CollapsedStripRule,
} from "./CollapsedStrip.tsx";

const LIMIT = 10;

export function SideRailCollapsedBody({ route }: { route: Route }) {
  switch (route.view) {
    case "messages":
    case "conversation":
      return <ChatCollapsedStrip />;
    case "inbox":
    case "activity":
    case "briefings":
      return <HomeCollapsedStrip />;
    case "agents-v2":
    case "agent-info":
      return <ProjectsCollapsedStrip />;
    case "terminal":
      return <TerminalCollapsedStrip />;
    case "ops":
      return <OpsCollapsedStrip />;
    case "mesh":
      return <MeshCollapsedStrip />;
    default:
      return (
        <CollapsedStrip label="Context" emptyMark="·">
          {null}
        </CollapsedStrip>
      );
  }
}

function HomeCollapsedStrip() {
  const { agents, navigate, route } = useScout();
  const [fleet, setFleet] = useState<FleetState | null>(null);
  const machineId = routeMachineId(route);
  const scopedAgents = useMemo(
    () => filterAgentsByMachineScope(agents, machineId),
    [agents, machineId],
  );
  const scopedAgentIds = useMemo(
    () => machineScopedAgentIds(agents, machineId),
    [agents, machineId],
  );
  const scopedFleet = useMemo(
    () => filterFleetByMachineScope(fleet, scopedAgentIds),
    [fleet, scopedAgentIds],
  );

  const load = useCallback(async () => {
    setFleet(await api<FleetState>("/api/fleet").catch(() => null));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useBrokerEvents((event) => {
    if (
      event.kind === "message.posted"
      || event.kind === "flight.updated"
      || event.kind === "agent.updated"
    ) {
      void load();
    }
  });

  const attentionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const item of scopedFleet?.needsAttention ?? []) {
      if (item.agentId) ids.add(item.agentId);
    }
    return ids;
  }, [scopedFleet]);

  const attentionAgents = useMemo(
    () => scopedAgents.filter((a) => attentionIds.has(a.id)).slice(0, 4),
    [scopedAgents, attentionIds],
  );

  const recentAgents = useMemo(() => {
    const attention = new Set(attentionAgents.map((a) => a.id));
    return [...scopedAgents]
      .filter((a) => !attention.has(a.id))
      .sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0))
      .slice(0, LIMIT - attentionAgents.length);
  }, [scopedAgents, attentionAgents]);

  return (
    <CollapsedStrip
      label="Home"
      emptyMark="H"
      labelTone={attentionAgents.length > 0 ? "attention" : "default"}
      labelCount={attentionAgents.length > 0 ? attentionAgents.length : undefined}
    >
      {attentionAgents.map((agent) => (
        <AgentChip
          key={`att-${agent.id}`}
          agent={agent}
          attention
          onClick={() => openAgent(navigate, agent, { from: "base-rail", returnTo: route })}
        />
      ))}
      {attentionAgents.length > 0 && recentAgents.length > 0 ? <CollapsedStripRule /> : null}
      {recentAgents.map((agent) => (
        <AgentChip
          key={agent.id}
          agent={agent}
          onClick={() => openAgent(navigate, agent, { from: "base-rail", returnTo: route })}
        />
      ))}
    </CollapsedStrip>
  );
}

function ProjectsCollapsedStrip() {
  const { agents, navigate, route } = useScout();
  const machineId = routeMachineId(route);
  const scoped = useMemo(
    () => filterAgentsByMachineScope(agents, machineId),
    [agents, machineId],
  );

  const projects = useMemo(() => {
    const map = new Map<string, { name: string; needs: number; working: number; latest: number }>();
    for (const agent of scoped) {
      const name = (agent.project ?? pathLeaf(agent.workspaceRoot) ?? agent.name ?? "project").trim();
      const key = name.toLowerCase();
      const cur = map.get(key) ?? { name, needs: 0, working: 0, latest: 0 };
      const state = normalizeAgentState(agent.state);
      if (state === "needs_attention" || state === "blocked") cur.needs += 1;
      if (state === "in_turn" || state === "in_flight" || isAgentOnline(agent.state)) cur.working += 1;
      cur.latest = Math.max(cur.latest, agent.updatedAt ?? agent.createdAt ?? 0);
      map.set(key, cur);
    }
    return [...map.values()]
      .sort((a, b) => {
        if ((b.needs > 0) !== (a.needs > 0)) return b.needs > 0 ? 1 : -1;
        return b.latest - a.latest;
      })
      .slice(0, LIMIT);
  }, [scoped]);

  const needsTotal = projects.reduce((n, p) => n + p.needs, 0);

  return (
    <CollapsedStrip
      label="Projects"
      emptyMark="P"
      labelTone={needsTotal > 0 ? "attention" : "default"}
      labelCount={needsTotal > 0 ? needsTotal : projects.length || undefined}
    >
      {projects.map((p) => (
        <CollapsedChip
          key={p.name}
          title={`${p.name}${p.needs ? ` · ${p.needs} need you` : ""}`}
          tone={p.needs > 0 ? "attention" : "default"}
          ava={chipInitial(p.name)}
          avaColor={actorColor(p.name)}
          dot={p.needs > 0 ? "attention" : p.working > 0 ? "live" : null}
          onClick={() =>
            navigate({
              view: "agents-v2",
              ...(machineId ? { machineId } : {}),
            })
          }
        />
      ))}
    </CollapsedStrip>
  );
}

function TerminalCollapsedStrip() {
  const { route, navigate } = useScout();
  const [sessions, setSessions] = useState<Awaited<ReturnType<typeof fetchTerminalSessions>>>([]);

  useEffect(() => {
    void fetchTerminalSessions({ includeDiscovered: true })
      .then(setSessions)
      .catch(() => {});
  }, []);

  const items = useMemo(() => terminalListItems(sessions).slice(0, LIMIT), [sessions]);
  const activeKey = route.view === "terminal" ? route.terminalSurfaceKey ?? null : null;

  return (
    <CollapsedStrip
      label="Term"
      emptyMark="T"
      labelTone={items.length > 0 ? "live" : "default"}
      labelCount={items.length || undefined}
    >
      {items.map((item) => (
        <CollapsedChip
          key={item.key}
          title={item.title}
          active={terminalSurfaceIdsEqual(item.key, activeKey)}
          tone="neutral"
          ava={chipInitial(item.title)}
          avaColor={actorColor(item.title)}
          onClick={() =>
            navigate({
              view: "terminal",
              terminalSurfaceKey: item.key,
              terminalSessionId: item.session.id,
            })
          }
        />
      ))}
    </CollapsedStrip>
  );
}

function OpsCollapsedStrip() {
  const { route, navigate } = useScout();
  const mode = route.view === "ops" ? route.mode : undefined;
  const items = [
    { id: "mission" as const, title: "Mission", glyph: <ListTodo size={13} strokeWidth={1.7} aria-hidden /> },
    { id: "agents" as const, title: "Agents", glyph: <Users size={13} strokeWidth={1.7} aria-hidden /> },
    { id: "lanes" as const, title: "Agent Lanes", glyph: <LayoutGrid size={13} strokeWidth={1.7} aria-hidden /> },
    { id: "plan" as const, title: "Plan", glyph: <Activity size={13} strokeWidth={1.7} aria-hidden /> },
  ];

  return (
    <CollapsedStrip label="Operations" emptyMark="O" labelTone="default">
      {items.map((item) => (
        <CollapsedChip
          key={item.id}
          title={item.title}
          active={mode === item.id || (!mode && item.id === "mission")}
          tone="neutral"
          glyph={item.glyph}
          onClick={() => navigate({ view: "ops", mode: item.id })}
        />
      ))}
    </CollapsedStrip>
  );
}

function MeshCollapsedStrip() {
  const { agents, navigate } = useScout();
  const { meshSnapshot } = useMeshViewStore();
  const buckets = useMemo(
    () => (meshSnapshot ? bucketAgentsByMachine(agents, meshSnapshot) : []),
    [agents, meshSnapshot],
  );

  const top = useMemo(
    () =>
      [...buckets]
        .sort((a, b) => b.agents.length - a.agents.length)
        .slice(0, LIMIT),
    [buckets],
  );

  const onlineCount = top.filter((b) => b.online).length;

  return (
    <CollapsedStrip
      label="Network"
      emptyMark="M"
      labelTone={onlineCount > 0 ? "live" : "default"}
      labelCount={top.length || undefined}
    >
      {top.map((b) => (
        <CollapsedChip
          key={b.machineId}
          title={`${b.machineLabel} · ${b.agents.length}`}
          tone={b.online ? "default" : "neutral"}
          ava={chipInitial(b.machineLabel)}
          avaColor={actorColor(b.machineLabel)}
          dot={b.online ? "live" : null}
          onClick={() => navigate({ view: "mesh" })}
        />
      ))}
    </CollapsedStrip>
  );
}

function AgentChip({
  agent,
  attention,
  onClick,
}: {
  agent: Agent;
  attention?: boolean;
  onClick: () => void;
}) {
  const name = agent.name ?? agent.id;
  const online = isAgentOnline(agent.state);
  return (
    <CollapsedChip
      title={attention ? `${name} · needs you` : name}
      tone={attention ? "attention" : "default"}
      ava={chipInitial(name)}
      avaColor={actorColor(name)}
      dot={attention ? "attention" : online ? "live" : null}
      onClick={onClick}
    />
  );
}

function pathLeaf(path: string | null | undefined): string | null {
  if (!path) return null;
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || null;
}
