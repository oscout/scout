import { useCallback, useEffect, useState } from "react";
import "../../scout/slots/ctx-panel.css";
import { api } from "../../lib/api.ts";
import { normalizeAgentState } from "../../lib/agent-state.ts";
import { routeForFleetAsk, routeForOperatorAttention } from "../../lib/operator-attention.ts";
import { useBrokerEvents } from "../../lib/sse.ts";
import { timeAgo } from "../../lib/time.ts";
import { useScout } from "../../scout/Provider.tsx";
import { openContent } from "../../scout/slots/openContent.ts";
import { RailRow } from "../../scout/slots/RailRow.tsx";
import type { FleetAsk, FleetAttentionItem, FleetState, Route } from "../../lib/types.ts";

type OpsSurface = {
  name: string;
  route: Route;
  active: (route: Route) => boolean;
};

const OPS_SURFACES: OpsSurface[] = [
  {
    name: "Control",
    route: { view: "ops", mode: "mission" },
    active: (route) => route.view === "ops" && (route.mode === undefined || route.mode === "mission"),
  },
  {
    name: "Dispatch",
    route: { view: "broker" },
    active: (route) => route.view === "broker",
  },
  {
    name: "Mesh",
    route: { view: "mesh" },
    active: (route) => route.view === "mesh",
  },
  {
    name: "Tail",
    route: { view: "ops", mode: "tail" },
    active: (route) => route.view === "ops" && route.mode === "tail",
  },
  {
    name: "Runtime",
    route: { view: "ops", mode: "atop" },
    active: (route) => route.view === "ops" && route.mode === "atop",
  },
];

export function OpsDefaultLeft() {
  const { navigate, route } = useScout();
  const [state, setState] = useState<FleetState | null>(null);

  const load = useCallback(async () => {
    const data = await api<FleetState>("/api/fleet").catch(() => null);
    setState(data);
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

  const needs = state?.needsAttention ?? [];
  const active = (state?.activeAsks ?? []).filter((ask) => ask.status !== "needs_attention");

  const openAttention = (item: FleetAttentionItem) => {
    openContent(navigate, routeForOperatorAttention(item), { returnTo: route });
  };

  const openAsk = (ask: FleetAsk) => {
    openContent(navigate, routeForFleetAsk(ask), { returnTo: route });
  };

  return (
    <div className="ctx-panel ctx-panel--ops">
      <section className="ctx-panel-section">
        <div className="ctx-panel-section-label">Surfaces</div>
        {OPS_SURFACES.map((surface) => (
          <RailRow
            key={surface.name}
            name={surface.name}
            tone="neutral"
            active={surface.active(route)}
            onClick={() => navigate(surface.route)}
          />
        ))}
      </section>

      <section className="ctx-panel-section">
        <div className="ctx-panel-section-label">
          Needs you
          {needs.length > 0 && <span className="ctx-panel-count">{needs.length}</span>}
        </div>
        {needs.length === 0 ? (
          <div className="ctx-panel-empty">All clear</div>
        ) : (
          needs.slice(0, 4).map((item) => {
            const label = item.agentName ?? item.agentId ?? "operator";
            return (
              <RailRow
                key={item.recordId}
                name={item.title}
                meta={timeAgo(item.updatedAt)}
                tone="in_turn"
                unread
                title={`${label} · ${item.kind}`}
                onClick={() => openAttention(item)}
              />
            );
          })
        )}
      </section>

      <section className="ctx-panel-section">
        <div className="ctx-panel-section-label">
          Active
          {active.length > 0 && <span className="ctx-panel-count">{active.length}</span>}
        </div>
        {active.length === 0 ? (
          <div className="ctx-panel-empty">No active requests</div>
        ) : (
          active.slice(0, 10).map((ask) => (
            <RailRow
              key={ask.invocationId}
              name={ask.task}
              meta={timeAgo(ask.updatedAt)}
              tone={normalizeAgentState(ask.agentState)}
              title={`${ask.agentName ?? ask.agentId} · ${ask.statusLabel}`}
              onClick={() => openAsk(ask)}
            />
          ))
        )}
      </section>
    </div>
  );
}
