import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import { timeAgo } from "../../lib/time.ts";
import { normalizeAgentState } from "../../lib/agent-state.ts";
import { filterAgentsByMachineScope } from "../../lib/machine-scope.ts";
import { routeMachineId } from "../../lib/router.ts";
import type { MeshStatus, Route } from "../../lib/types.ts";
import { MeshCanvas } from "./MeshCanvas.tsx";
import { AgentTree } from "../../components/AgentTree.tsx";
import { useLocalAgents } from "../../lib/local-agents.ts";
import { useScout } from "../../scout/Provider.tsx";
import {
  useMeshViewStore,
  setMeshViewMode,
  setMeshSnapshot,
  setMeshSelection,
  setMeshDensity,
  setMeshQuery,
  setMeshStateFilter,
  type MeshDensity,
  type MeshStateFilter,
} from "../../lib/mesh-view-store.ts";
import { useContentOwnsSecondaryNav } from "../../scout/sidebar/useContentSecondaryNav.ts";
import { OpsSubnav } from "../ops/OpsSubnav.tsx";
import "../system-surfaces-redesign.css";
import "./mesh-screen.css";


function MeshHud({
  mode,
  density,
  query,
  stateFilter,
  loading,
  refreshing,
  error,
  lastLoadedAt,
  hasMesh,
  onRefresh,
}: {
  mode: "map" | "tree";
  density: MeshDensity;
  query: string;
  stateFilter: MeshStateFilter;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  lastLoadedAt: number | null;
  hasMesh: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className={`mesh-hud mesh-hud--${mode}`}>
      <div className="mesh-hud-left">
        <div className="mesh-mode-toggle">
          <button
            type="button"
            className={`mesh-mode-btn${mode === "map" ? " mesh-mode-btn--active" : ""}`}
            onClick={() => setMeshViewMode("map")}
          >
            Map
          </button>
          <button
            type="button"
            className={`mesh-mode-btn${mode === "tree" ? " mesh-mode-btn--active" : ""}`}
            onClick={() => setMeshViewMode("tree")}
          >
            Tree
          </button>
        </div>
        <div
          className="mesh-mode-toggle mesh-density-toggle"
          role="group"
          aria-label="Density"
          // Density is map-only; in tree mode the toggle stays in the layout
          // but is visually muted+disabled so the header doesn't reshuffle.
          aria-hidden={mode !== "map"}
          data-mode-only="map"
        >
          <button
            type="button"
            className={`mesh-mode-btn${density === "compact" ? " mesh-mode-btn--active" : ""}`}
            onClick={() => setMeshDensity("compact")}
            disabled={mode !== "map"}
            title="Compact — dots"
          >
            Compact
          </button>
          <button
            type="button"
            className={`mesh-mode-btn${density === "comfortable" ? " mesh-mode-btn--active" : ""}`}
            onClick={() => setMeshDensity("comfortable")}
            disabled={mode !== "map"}
            title="Comfortable — chips"
          >
            Comfortable
          </button>
          <button
            type="button"
            className={`mesh-mode-btn${density === "spacious" ? " mesh-mode-btn--active" : ""}`}
            onClick={() => setMeshDensity("spacious")}
            disabled={mode !== "map"}
            title="Spacious — cards"
          >
            Spacious
          </button>
        </div>
      </div>
      {hasMesh && (
        <div className="mesh-hud-filters">
          <input
            type="search"
            className="mesh-hud-search"
            placeholder="Filter agents…"
            value={query}
            onChange={(e) => setMeshQuery(e.target.value)}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
          />
          <div className="mesh-mode-toggle" role="group" aria-label="State">
            <button
              type="button"
              className={`mesh-mode-btn${stateFilter === "all" ? " mesh-mode-btn--active" : ""}`}
              onClick={() => setMeshStateFilter("all")}
            >
              All
            </button>
            <button
              type="button"
              className={`mesh-mode-btn${stateFilter === "in_turn" ? " mesh-mode-btn--active" : ""}`}
              onClick={() => setMeshStateFilter("in_turn")}
            >
              In turn
            </button>
            <button
              type="button"
              className={`mesh-mode-btn${stateFilter === "callable" ? " mesh-mode-btn--active" : ""}`}
              onClick={() => setMeshStateFilter("callable")}
            >
              Callable
            </button>
          </div>
        </div>
      )}
      <div className="mesh-hud-right">
        <span className="mesh-hud-sync">
          {loading
            ? "Loading…"
            : error && hasMesh
              ? `Last sync old — ${lastLoadedAt ? timeAgo(lastLoadedAt) : "unknown"}`
              : lastLoadedAt
                ? timeAgo(lastLoadedAt)
                : "—"}
        </span>
        <button type="button" className="s-btn" disabled={loading || refreshing} onClick={onRefresh}>
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>
    </div>
  );
}

export function MeshScreen({ navigate }: { navigate: (r: Route) => void }) {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null);

  const { mode, density, query, stateFilter, meshSnapshot: mesh } = useMeshViewStore();
  const { agents } = useLocalAgents();
  const { route } = useScout();
  const machineId = routeMachineId(route);
  const scopedAgents = useMemo(
    () => filterAgentsByMachineScope(agents, machineId, mesh?.localNode?.id),
    [agents, machineId, mesh?.localNode?.id],
  );
  const meshRef = useRef<MeshStatus | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => { meshRef.current = mesh; }, [mesh]);
  useEffect(() => {
    if (machineId) {
      setMeshSelection(machineId, "node");
    }
  }, [machineId]);

  const load = useCallback(async (loadMode: "initial" | "background" | "manual" = "initial") => {
    const requestId = ++requestIdRef.current;
    const hasSnapshot = meshRef.current !== null;
    if (!hasSnapshot && loadMode !== "background") { setLoading(true); setError(null); }
    else setRefreshing(true);
    try {
      const data = await api<MeshStatus>("/api/mesh");
      if (requestId !== requestIdRef.current) return;
      setMeshSnapshot(data); setError(null); setLastLoadedAt(Date.now());
    } catch (e) {
      if (requestId !== requestIdRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (requestId === requestIdRef.current) { setLoading(false); setRefreshing(false); }
    }
  }, []);

  useEffect(() => { void load("initial"); }, [load]);
  useEffect(() => {
    const t = setInterval(() => void load("background"), 10_000);
    return () => clearInterval(t);
  }, [load]);

  const filteredAgents = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return scopedAgents.filter((a) => {
      if (stateFilter !== "all" && normalizeAgentState(a.state) !== stateFilter) return false;
      if (!needle) return true;
      const hay = `${a.name ?? ""} ${a.handle ?? ""} ${a.harness ?? ""} ${a.project ?? ""} ${a.branch ?? ""}`.toLowerCase();
      return hay.includes(needle);
    });
  }, [query, scopedAgents, stateFilter]);

  const hudProps = {
    mode,
    density,
    query,
    stateFilter,
    loading,
    refreshing,
    error,
    lastLoadedAt,
    hasMesh: Boolean(mesh),
    onRefresh: () => void load("manual"),
  };

  const content = mode === "map"
    ? (
      <div className="mesh-map-canvas">
        {mesh && <MeshCanvas mesh={mesh} agents={filteredAgents} />}

        {loading && !mesh && (
          <div className="mesh-canvas-center">
            <p className="mesh-canvas-center-label">Loading mesh…</p>
          </div>
        )}

        {!loading && !mesh && error && (
          <div className="mesh-canvas-center">
            <p className="mesh-canvas-center-label">{error}</p>
            <button type="button" className="s-btn" onClick={() => void load("manual")}>Try again</button>
          </div>
        )}

        <MeshHud {...hudProps} />
      </div>
    )
    : (
      <div className="mesh-tree-page">
        <MeshHud {...hudProps} />

        {loading && !mesh && (
          <div className="sys-panel sys-state-card mesh-tree-state">
            <h3 className="sys-state-title">Loading mesh status</h3>
            <p className="sys-state-body">Inspecting broker reachability and peer discovery inputs.</p>
          </div>
        )}

        {!loading && !mesh && error && (
          <div className="sys-panel sys-state-card sys-state-card-error mesh-tree-state">
            <h3 className="sys-state-title">Mesh status is unavailable</h3>
            <p className="sys-state-body">{error}</p>
            <div className="sys-inline-actions">
              <button type="button" className="s-btn" onClick={() => void load("manual")}>Try again</button>
            </div>
          </div>
        )}

        {mesh && (
          <section className="mesh-tree-panel">
            <div className="mesh-tree-hint" aria-hidden>
              <kbd>↑</kbd><kbd>↓</kbd>
              <span>navigate</span>
              <span className="mesh-tree-hint-sep">·</span>
              <kbd>enter</kbd>
              <span>pin</span>
              <span className="mesh-tree-hint-sep">·</span>
              <kbd>o</kbd>
              <span>open</span>
              <span className="mesh-tree-hint-sep">·</span>
              <kbd>esc</kbd>
              <span>clear</span>
            </div>
            <AgentTree
              agents={filteredAgents}
              emptyTitle={scopedAgents.length === 0 ? (machineId ? "No agents on this machine" : "No agents registered") : "No agents match your filter"}
              emptyBody={scopedAgents.length === 0
                ? "Agents connected to this broker will appear here."
                : "Try clearing the search or switching the state pill back to All."}
            />
          </section>
        )}
      </div>
    );

  const contentOwnsSecondaryNav = useContentOwnsSecondaryNav();

  return (
    <div className="s-ops">
      {contentOwnsSecondaryNav ? (
        <div className="s-ops-header">
          <OpsSubnav activeRoute={route} navigate={navigate} />
        </div>
      ) : null}
      <div className="s-ops-body">
        {content}
      </div>
    </div>
  );
}
