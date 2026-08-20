import { useCallback, useEffect, useMemo, useState } from "react";
import "../../scout/slots/ctx-panel.css";
import { api } from "../../lib/api.ts";
import { useBrokerEvents } from "../../lib/sse.ts";
import { useScout } from "../../scout/Provider.tsx";
import { useFleetActiveAsks } from "../../lib/use-fleet-active-asks.ts";
import { isAgentOnline } from "../../lib/agent-state.ts";
import { RailRow } from "../../scout/slots/RailRow.tsx";
import type { Agent, SessionEntry } from "../../lib/types.ts";

const RAIL_REFRESH_EVENTS = new Set([
  "message.posted",
  "conversation.upserted",
  "agent.updated",
]);

function machineLabel(agent: Agent): string {
  const fromCwd = basename(agent.cwd);
  const fromProjectRoot = basename(agent.projectRoot);
  return agent.authorityNodeName
    ?? agent.homeNodeName
    ?? agent.authorityNodeId
    ?? agent.homeNodeId
    ?? agent.transport
    ?? fromCwd
    ?? fromProjectRoot
    ?? "local";
}

function teamLabel(agent: Agent): string {
  return agent.project ?? agent.role ?? agent.agentClass ?? "Unassigned";
}

function basename(path: string | null): string | null {
  if (!path) return null;
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? null;
}

export function OpsAgentsLeft() {
  const { agents, navigate } = useScout();
  const [sessions, setSessions] = useState<SessionEntry[]>([]);
  const asksByAgent = useFleetActiveAsks();

  const loadSessions = useCallback(async () => {
    const data = await api<SessionEntry[]>("/api/conversations").catch(() => [] as SessionEntry[]);
    setSessions(data);
  }, []);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  useBrokerEvents((event) => {
    if (RAIL_REFRESH_EVENTS.has(event.kind)) {
      void loadSessions();
    }
  });

  const online = useMemo(() => agents.filter((a) => isAgentOnline(a.state)).length, [agents]);
  const errored = useMemo(() => {
    let count = 0;
    for (const ask of asksByAgent.values()) {
      if (ask.status === "failed" || ask.status === "needs_attention") count += 1;
    }
    return count;
  }, [asksByAgent]);

  const teams = useMemo(() => {
    const counts = new Map<string, number>();
    for (const agent of agents) {
      const team = teamLabel(agent);
      counts.set(team, (counts.get(team) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [agents]);

  const machines = useMemo(() => {
    const counts = new Map<string, number>();
    for (const agent of agents) {
      const machine = machineLabel(agent);
      counts.set(machine, (counts.get(machine) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [agents]);

  return (
    <div className="ctx-panel">
      <section className="ctx-panel-section">
        <div className="ctx-panel-section-label">Agents</div>
        <RailRow
          name="Overview"
          meta={`${agents.length}`}
          tone="neutral"
          onClick={() => navigate({ view: "inbox" })}
        />
        <RailRow
          name="Agents"
          meta={`${online}`}
          tone="callable"
          active
          onClick={() => navigate({ view: "ops", mode: "agents" })}
        />
        <RailRow
          name="Sessions"
          meta={`${sessions.length}`}
          tone="neutral"
          onClick={() => navigate({ view: "sessions" })}
        />
        <RailRow
          name="Alerts"
          meta={`${errored}`}
          tone={errored > 0 ? "in_turn" : "neutral"}
          unread={errored > 0}
          onClick={() => navigate({ view: "activity" })}
        />
      </section>

      <section className="ctx-panel-section">
        <div className="ctx-panel-section-label">Projects</div>
        {teams.length === 0 ? (
          <div className="ctx-panel-empty">No projects</div>
        ) : (
          teams.map(([team, count]) => (
            <RailRow
              key={team}
              name={team}
              meta={`${count}`}
              tone="neutral"
              title={`${count} agent${count === 1 ? "" : "s"} on ${team}`}
            />
          ))
        )}
      </section>

      <section className="ctx-panel-section">
        <div className="ctx-panel-section-label">Machines</div>
        {machines.length === 0 ? (
          <div className="ctx-panel-empty">No machines</div>
        ) : (
          machines.map(([machine, count]) => (
            <RailRow
              key={machine}
              name={machine}
              meta={`${count}`}
              tone="neutral"
              title={`${count} agent${count === 1 ? "" : "s"} on ${machine}`}
            />
          ))
        )}
      </section>
    </div>
  );
}
