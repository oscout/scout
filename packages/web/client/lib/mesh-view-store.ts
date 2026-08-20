import { useSyncExternalStore } from "react";
import type { MeshStatus } from "./types.ts";

export type ProbeAgent = {
  id: string;
  title: string;
  state: string;
  statusLabel: string;
  activeTask: string | null;
};

export type ProbeResult = {
  reachable: boolean;
  home: { agents: ProbeAgent[] } | null;
  node: {
    id?: string;
    name?: string;
    hostName?: string;
    meshId?: string;
    capabilities?: string[];
    brokerUrl?: string;
    version?: string;
  } | null;
  error?: string;
};

export type ProbeEntry = {
  status: "loading" | "done" | "error";
  result: ProbeResult | null;
  fetchedAt: number;
};

export type MeshViewMode = "map" | "tree";

export type MeshDensity = "compact" | "comfortable" | "spacious";

export type MeshStateFilter = "all" | "in_turn" | "callable";
export type AgentStateToken = "in_turn" | "in_flight" | "needs_attention" | "callable" | "blocked";

const ALL_AGENT_STATES: ReadonlySet<AgentStateToken> = new Set([
  "in_turn",
  "in_flight",
  "needs_attention",
  "callable",
  "blocked",
]);

type MeshViewState = {
  mode: MeshViewMode;
  density: MeshDensity;
  selectedId: string | null;
  selectedType: "node" | "agent" | null;
  meshSnapshot: MeshStatus | null;
  probeCache: Record<string, ProbeEntry>;
  query: string;
  stateFilter: MeshStateFilter;
  /** Multi-toggle filter set for the tree/canvas. Default = all three states. */
  agentStateFilters: ReadonlySet<AgentStateToken>;
  /** Set of machine ids hidden from view. Empty = all visible. */
  hiddenMachineIds: ReadonlySet<string>;
  /** Set of machine ids whose section body is collapsed. */
  collapsedMachineIds: ReadonlySet<string>;
  /** Machine ids whose tree is fully expanded (showing all agents, not just the recent top N). */
  treeFullMachineIds: ReadonlySet<string>;
  /** Machine id the rail asked the canvas to scroll to (nullable; one-shot signal). */
  scrollTargetMachineId: string | null;
  /**
   * Per-machine manual position override (canvas world coords). Absent = auto-pack.
   * Persisted to localStorage so drags survive reloads.
   */
  machinePositions: Readonly<Record<string, { x: number; y: number }>>;
};

const POSITIONS_STORAGE_KEY = "openscout.mesh.machinePositions.v1";

function loadPersistedPositions(): Record<string, { x: number; y: number }> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(POSITIONS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const out: Record<string, { x: number; y: number }> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (v && typeof v === "object" && typeof (v as { x?: unknown }).x === "number" && typeof (v as { y?: unknown }).y === "number") {
          out[k] = { x: (v as { x: number }).x, y: (v as { y: number }).y };
        }
      }
      return out;
    }
  } catch {
    /* ignore corrupted state */
  }
  return {};
}

function persistPositions(positions: Record<string, { x: number; y: number }>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(POSITIONS_STORAGE_KEY, JSON.stringify(positions));
  } catch {
    /* quota or privacy mode; ignore */
  }
}

let _state: MeshViewState = {
  mode: "map",
  density: "comfortable",
  selectedId: null,
  selectedType: null,
  meshSnapshot: null,
  probeCache: {},
  query: "",
  stateFilter: "all",
  agentStateFilters: ALL_AGENT_STATES,
  hiddenMachineIds: new Set<string>(),
  collapsedMachineIds: new Set<string>(),
  treeFullMachineIds: new Set<string>(),
  scrollTargetMachineId: null,
  machinePositions: loadPersistedPositions(),
};

const _listeners = new Set<() => void>();

function _notify() {
  for (const fn of _listeners) fn();
}

export function setMeshViewMode(mode: MeshViewMode): void {
  if (_state.mode === mode) return;
  _state = { ..._state, mode };
  _notify();
}

export function setMeshDensity(density: MeshDensity): void {
  if (_state.density === density) return;
  _state = { ..._state, density };
  _notify();
}

export function setMeshSelection(id: string | null, type: "node" | "agent" | null): void {
  if (_state.selectedId === id && _state.selectedType === type) return;
  _state = { ..._state, selectedId: id, selectedType: type };
  _notify();
}

export function setMeshSnapshot(snapshot: MeshStatus | null): void {
  _state = { ..._state, meshSnapshot: snapshot };
  _notify();
}

export function setProbeEntry(nodeId: string, entry: ProbeEntry): void {
  _state = { ..._state, probeCache: { ..._state.probeCache, [nodeId]: entry } };
  _notify();
}

export function setMeshQuery(query: string): void {
  if (_state.query === query) return;
  _state = { ..._state, query };
  _notify();
}

export function setMeshStateFilter(stateFilter: MeshStateFilter): void {
  if (_state.stateFilter === stateFilter) return;
  _state = { ..._state, stateFilter };
  _notify();
}

export function toggleAgentStateFilter(token: AgentStateToken): void {
  const next = new Set(_state.agentStateFilters);
  if (next.has(token)) next.delete(token);
  else next.add(token);
  _state = { ..._state, agentStateFilters: next };
  _notify();
}

export function setAgentStateFilters(tokens: ReadonlySet<AgentStateToken>): void {
  _state = { ..._state, agentStateFilters: tokens };
  _notify();
}

export function toggleTreeFullMachine(machineId: string): void {
  const next = new Set(_state.treeFullMachineIds);
  if (next.has(machineId)) next.delete(machineId);
  else next.add(machineId);
  _state = { ..._state, treeFullMachineIds: next };
  _notify();
}

export function toggleMachineVisibility(machineId: string): void {
  const next = new Set(_state.hiddenMachineIds);
  if (next.has(machineId)) next.delete(machineId);
  else next.add(machineId);
  _state = { ..._state, hiddenMachineIds: next };
  _notify();
}

export function soloMachine(machineId: string, allMachineIds: readonly string[]): void {
  const next = new Set<string>();
  for (const id of allMachineIds) {
    if (id !== machineId) next.add(id);
  }
  _state = { ..._state, hiddenMachineIds: next };
  _notify();
}

export function showAllMachines(): void {
  if (_state.hiddenMachineIds.size === 0) return;
  _state = { ..._state, hiddenMachineIds: new Set<string>() };
  _notify();
}

export function hideAllMachines(allMachineIds: readonly string[]): void {
  _state = { ..._state, hiddenMachineIds: new Set(allMachineIds) };
  _notify();
}

export function toggleMachineCollapse(machineId: string): void {
  const next = new Set(_state.collapsedMachineIds);
  if (next.has(machineId)) next.delete(machineId);
  else next.add(machineId);
  _state = { ..._state, collapsedMachineIds: next };
  _notify();
}

export function setMachineCollapsed(machineId: string, collapsed: boolean): void {
  const has = _state.collapsedMachineIds.has(machineId);
  if (has === collapsed) return;
  const next = new Set(_state.collapsedMachineIds);
  if (collapsed) next.add(machineId);
  else next.delete(machineId);
  _state = { ..._state, collapsedMachineIds: next };
  _notify();
}

export function setMachinePosition(machineId: string, position: { x: number; y: number }): void {
  const next = { ..._state.machinePositions, [machineId]: position };
  _state = { ..._state, machinePositions: next };
  persistPositions(next);
  _notify();
}

export function clearMachinePosition(machineId: string): void {
  if (!(machineId in _state.machinePositions)) return;
  const next = { ..._state.machinePositions };
  delete next[machineId];
  _state = { ..._state, machinePositions: next };
  persistPositions(next);
  _notify();
}

export function clearAllMachinePositions(): void {
  if (Object.keys(_state.machinePositions).length === 0) return;
  const next: Record<string, { x: number; y: number }> = {};
  _state = { ..._state, machinePositions: next };
  persistPositions(next);
  _notify();
}

export function requestScrollToMachine(machineId: string): void {
  // Set then clear on next tick so subscribers re-render to consume the signal.
  _state = { ..._state, scrollTargetMachineId: machineId };
  _notify();
  queueMicrotask(() => {
    if (_state.scrollTargetMachineId === machineId) {
      _state = { ..._state, scrollTargetMachineId: null };
      _notify();
    }
  });
}

function _subscribe(fn: () => void): () => void {
  _listeners.add(fn);
  return () => { _listeners.delete(fn); };
}

function _getSnapshot(): MeshViewState {
  return _state;
}

export function useMeshViewStore(): MeshViewState {
  return useSyncExternalStore(_subscribe, _getSnapshot);
}
