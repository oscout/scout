import { useMemo, useState } from "react";
import {
  useMeshViewStore,
  setMeshSelection,
  requestScrollToMachine,
  toggleMachineVisibility,
  clearAllMachinePositions,
} from "../../lib/mesh-view-store.ts";
import { useScout } from "../Provider.tsx";
import { bucketAgentsByMachine, type MachineBucket } from "../../lib/mesh-buckets.ts";
import { normalizeAgentState, isAgentBusy, isAgentCallable } from "../../lib/agent-state.ts";
import { stateColor } from "../../lib/colors.ts";
import "./mesh-rail-rack.css";

type Mode = "rack" | "map";

export function MeshCanvasMinimap() {
  const [mode, setMode] = useState<Mode>("rack");
  const { agents } = useScout();
  const {
    meshSnapshot,
    selectedId,
    selectedType,
    hiddenMachineIds,
    machinePositions,
  } = useMeshViewStore();

  const buckets = useMemo<MachineBucket[]>(
    () => (meshSnapshot ? bucketAgentsByMachine(agents, meshSnapshot) : []),
    [agents, meshSnapshot],
  );

  if (!meshSnapshot || buckets.length === 0) return null;

  const visibleCount = buckets.filter((b) => !hiddenMachineIds.has(b.machineId)).length;
  const totalCount = buckets.length;
  const pinnedCount = Object.keys(machinePositions).length;

  const focusMachine = (id: string) => {
    setMeshSelection(id, "node");
    requestScrollToMachine(id);
  };

  return (
    <div className="mesh-rail">
      <div className="mesh-rail-head">
        <span className="mesh-rail-ear" aria-hidden />
        <div className="mesh-rail-mode" role="group" aria-label="Bottom view">
          <button
            type="button"
            className={`mesh-rail-mode-btn${mode === "map" ? " mesh-rail-mode-btn--active" : ""}`}
            onClick={() => setMode("map")}
            aria-pressed={mode === "map"}
          >
            map
          </button>
          <button
            type="button"
            className={`mesh-rail-mode-btn${mode === "rack" ? " mesh-rail-mode-btn--active" : ""}`}
            onClick={() => setMode("rack")}
            aria-pressed={mode === "rack"}
          >
            rack
          </button>
        </div>
        <span className="mesh-rail-title-count">{totalCount}</span>
        <span className="mesh-rail-ear" aria-hidden />
      </div>

      {mode === "rack" ? (
        <RackBody
          buckets={buckets}
          hiddenMachineIds={hiddenMachineIds}
          selectedId={selectedId}
          selectedType={selectedType}
          onFocus={focusMachine}
        />
      ) : (
        <MapBody
          buckets={buckets}
          selectedId={selectedId}
          selectedType={selectedType}
          onFocus={focusMachine}
        />
      )}

      <div className="mesh-rail-foot">
        <span className="mesh-rail-foot-mark" aria-hidden />
        <span className="mesh-rail-foot-meta">
          {mode === "map" ? `${totalCount} machines` : `${visibleCount}/${totalCount} shown`}
        </span>
        {pinnedCount > 0 && mode === "rack" ? (
          <button
            type="button"
            className="mesh-rail-foot-reset"
            onClick={() => clearAllMachinePositions()}
            title="Reset machine layout"
          >
            reset
          </button>
        ) : (
          <span className="mesh-rail-foot-mark" aria-hidden />
        )}
      </div>
    </div>
  );
}

function RackBody({
  buckets,
  hiddenMachineIds,
  selectedId,
  selectedType,
  onFocus,
}: {
  buckets: MachineBucket[];
  hiddenMachineIds: ReadonlySet<string>;
  selectedId: string | null;
  selectedType: "node" | "agent" | null;
  onFocus: (id: string) => void;
}) {
  return (
    <div className="mesh-rail-body">
      {buckets.map((bucket, idx) => {
        const hidden = hiddenMachineIds.has(bucket.machineId);
        const active = selectedId === bucket.machineId && selectedType === "node";
        const working = bucket.agents.filter(
          (a) => isAgentBusy(a.state),
        ).length;
        const ready = bucket.agents.filter(
          (a) => isAgentCallable(a.state),
        ).length;
        const dominant =
          !bucket.online
            ? "offline"
            : bucket.agents.length === 0
              ? "offline"
              : working > 0
                ? "working"
                : "available";
        const ledColor = hidden || !bucket.online ? undefined : stateColor(dominant);
        const reachChip =
          bucket.reachability === "this"
            ? "L"
            : bucket.reachability === "peer"
              ? "P"
              : bucket.reachability === "tailnet"
                ? "T"
                : "·";
        const slot = String(idx + 1).padStart(2, "0");
        const stamp = !bucket.online
          ? "unreachable"
          : bucket.agents.length === 0
            ? "idle"
            : `${working}w · ${ready}r`;
        return (
          <div
            key={bucket.machineId}
            className={[
              "mesh-rail-unit",
              hidden && "mesh-rail-unit--off",
              !bucket.online && "mesh-rail-unit--unreachable",
              active && "mesh-rail-unit--active",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            <button
              type="button"
              className="mesh-rail-unit-body"
              onClick={() => onFocus(bucket.machineId)}
              title={`Focus ${bucket.machineLabel} on the map`}
            >
              <span className="mesh-rail-slot">{slot}</span>
              <span
                className={`mesh-rail-led${hidden || !bucket.online ? "" : " mesh-rail-led--on"}`}
                style={ledColor ? { background: ledColor, color: ledColor } : undefined}
                aria-hidden
              />
              <span className="mesh-rail-unit-text">
                <span className="mesh-rail-unit-name" title={bucket.machineLabel}>
                  {bucket.machineLabel}
                </span>
                <span className="mesh-rail-unit-sub">
                  <span className={`mesh-rail-reach mesh-rail-reach--${bucket.reachability}`}>
                    {reachChip}
                  </span>
                  <span className="mesh-rail-unit-stamp">{stamp}</span>
                </span>
              </span>
              <span className="mesh-rail-unit-count">{bucket.agents.length}</span>
            </button>
            <div className="mesh-rail-unit-actions">
              <button
                type="button"
                className={`mesh-rail-unit-eye${hidden ? " mesh-rail-unit-eye--off" : ""}`}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleMachineVisibility(bucket.machineId);
                }}
                title={hidden ? "Show in workspace" : "Hide from workspace"}
                aria-pressed={!hidden}
              >
                {hidden ? "○" : "●"}
              </button>
            </div>
            <span className="mesh-rail-vent" aria-hidden />
          </div>
        );
      })}
    </div>
  );
}

function MapBody({
  buckets,
  selectedId,
  selectedType,
  onFocus,
}: {
  buckets: MachineBucket[];
  selectedId: string | null;
  selectedType: "node" | "agent" | null;
  onFocus: (id: string) => void;
}) {
  return (
    <div className="mesh-rail-body mesh-rail-body--map">
      <div className="mesh-mini-map">
        {buckets.map((b) => {
          const active = selectedId === b.machineId && selectedType === "node";
          const working = b.agents.filter(
            (a) => isAgentBusy(a.state),
          ).length;
          const dominant =
            !b.online
              ? "offline"
              : b.agents.length === 0
                ? "offline"
                : working > 0
                  ? "working"
                  : "available";
          const ledColor = !b.online ? undefined : stateColor(dominant);
          return (
            <button
              key={b.machineId}
              type="button"
              className={`mesh-mini-node mesh-mini-node--${dominant}${active ? " mesh-mini-node--active" : ""}${!b.online ? " mesh-mini-node--off" : ""}`}
              onClick={() => onFocus(b.machineId)}
              title={`${b.machineLabel} — ${b.agents.length} agents`}
            >
              <span
                className="mesh-mini-led"
                style={ledColor ? { background: ledColor } : undefined}
                aria-hidden
              />
              <span className="mesh-mini-label">{b.machineLabel}</span>
              {b.agents.length > 0 && (
                <span className="mesh-mini-count">{b.agents.length}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
