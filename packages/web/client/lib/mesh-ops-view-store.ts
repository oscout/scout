import { useSyncExternalStore } from "react";
import type { MeshOpsAttention, WebMeshOpsHost, WebMeshOpsItem } from "./types.ts";

/**
 * Mesh Ops view store — module-level external store shared by the three
 * mesh-ops panes (host rail / item list / inspector), analogous to
 * mesh-view-store.ts. The data hook (screens/mesh-ops/use-mesh-ops-items.ts)
 * fetches `/api/mesh-ops` and writes results here; panes read via
 * useMeshOpsViewStore().
 */

/** Triage bucket: pure last-activity windows — no invented priority tiers. */
export type MeshOpsTriage = "active" | "moving" | "done" | "archive";

export type MeshOpsGroupBy = "attention" | "family" | "host";

export const MESH_OPS_TRIAGE_LABEL: Record<MeshOpsTriage, string> = {
  active: "active",
  moving: "moving",
  done: "done",
  archive: "archive",
};

export const MESH_OPS_TRIAGE_ORDER: readonly MeshOpsTriage[] = [
  "active",
  "moving",
  "done",
  "archive",
];

/** Activity windows: ≤5m is active, ≤30m moving, ≤24h done, older is archive. */
export const MESH_OPS_ACTIVE_WINDOW_MS = 5 * 60 * 1000;
export const MESH_OPS_MOVING_WINDOW_MS = 30 * 60 * 1000;
export const MESH_OPS_DONE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The triage read on an item is purely recency: ≤5m active, ≤30m moving,
 * ≤24h done, older is archive. Terminal and collaboration states stay
 * visible on the row's state column; the buckets say nothing about them.
 */
export function triageOf(item: WebMeshOpsItem, now: number = Date.now()): MeshOpsTriage {
  const age = now - itemActivityAt(item);
  if (age <= MESH_OPS_ACTIVE_WINDOW_MS) return "active";
  if (age <= MESH_OPS_MOVING_WINDOW_MS) return "moving";
  if (age <= MESH_OPS_DONE_WINDOW_MS) return "done";
  return "archive";
}

/**
 * Last-look — per-browser "when did I last scan this list", stamped when the
 * view unmounts. The one heuristic the operator can reason about: anything
 * with activity newer than the stamp is "new since last look". Client-local
 * v1; a real per-item seen-state is follow-up work.
 */
const LAST_LOOK_KEY = "openscout.meshOps.lastLookAt";

export function readMeshOpsLastLookAt(): number {
  if (typeof window === "undefined") return 0;
  try {
    const raw = window.localStorage.getItem(LAST_LOOK_KEY);
    // First visit: everything counts as seen, so no new-since noise.
    return raw ? Number(raw) || 0 : Date.now();
  } catch {
    return Date.now();
  }
}

export function stampMeshOpsLastLookAt(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAST_LOOK_KEY, String(Date.now()));
  } catch {
    /* quota or privacy mode; ignore */
  }
}

/** New since the operator's last look — the "haven't seen it yet" read. */
export function itemIsNewSince(item: WebMeshOpsItem, lastLookAt: number): boolean {
  return itemActivityAt(item) > lastLookAt;
}

/** Family axis — labels first, then the project root basename. */
export function familyOf(item: WebMeshOpsItem): string {
  if (item.labels.length > 0) return item.labels[0];
  if (item.projectRoot) {
    const parts = item.projectRoot.split("/").filter(Boolean);
    return parts[parts.length - 1] ?? item.projectRoot;
  }
  return "unlabeled";
}

/** Recency key used for sorting and the last-look divider. */
export function itemActivityAt(item: WebMeshOpsItem): number {
  return item.lastMeaningfulAt ?? item.updatedAt;
}

export type MeshOpsLabFlags = {
  lastLook: boolean;
  routeStrip: boolean;
  compact: boolean;
  /** Show broker relay sessions (ephemeral `session-*` delivery machinery). */
  relays: boolean;
  /** Dev-only: spread items across synthetic hosts to preview multi-host. */
  simulateHosts: boolean;
};

const LAB_STORAGE_PREFIX = "openscout.mesh-ops.lab.";
const LAB_DEFAULTS: MeshOpsLabFlags = {
  lastLook: true,
  routeStrip: true,
  compact: false,
  relays: false,
  simulateHosts: false,
};

function loadLabFlags(): MeshOpsLabFlags {
  if (typeof window === "undefined") return LAB_DEFAULTS;
  const read = (key: keyof MeshOpsLabFlags): boolean => {
    try {
      const raw = window.localStorage.getItem(`${LAB_STORAGE_PREFIX}${key}`);
      return raw === null ? LAB_DEFAULTS[key] : raw === "1";
    } catch {
      return LAB_DEFAULTS[key];
    }
  };
  return {
    lastLook: read("lastLook"),
    routeStrip: read("routeStrip"),
    compact: read("compact"),
    relays: read("relays"),
    simulateHosts: read("simulateHosts"),
  };
}

function persistLabFlag(key: keyof MeshOpsLabFlags, value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(`${LAB_STORAGE_PREFIX}${key}`, value ? "1" : "0");
  } catch {
    /* quota or privacy mode; ignore */
  }
}

export type MeshOpsLoadStatus = "idle" | "loading" | "ready" | "error";

type MeshOpsViewState = {
  status: MeshOpsLoadStatus;
  error: string | null;
  generatedAt: string | null;
  items: WebMeshOpsItem[];
  /** Every known mesh host, with server-side session rollups. */
  hosts: WebMeshOpsHost[];
  /** Machine scope the current items were fetched for (null = everywhere). */
  machineId: string | null;
  selectedItemId: string | null;
  groupBy: MeshOpsGroupBy;
  attnFilter: MeshOpsTriage | null;
  /** Rail "unattributed" row: client-side filter for hostNodeId === null. */
  unattributedOnly: boolean;
  lab: MeshOpsLabFlags;
  /** Bumped by requestMeshOpsRefresh; the data hook refetches on change. */
  refreshToken: number;
};

let _state: MeshOpsViewState = {
  status: "idle",
  error: null,
  generatedAt: null,
  items: [],
  hosts: [],
  machineId: null,
  selectedItemId: null,
  groupBy: "family",
  attnFilter: null,
  unattributedOnly: false,
  lab: loadLabFlags(),
  refreshToken: 0,
};

const _listeners = new Set<() => void>();

function _notify() {
  for (const fn of _listeners) fn();
}

export function setMeshOpsLoading(machineId: string | null): void {
  _state = { ..._state, status: "loading", error: null, machineId };
  _notify();
}

export function setMeshOpsData(
  machineId: string | null,
  items: WebMeshOpsItem[],
  generatedAt: string | null,
  hosts: WebMeshOpsHost[] = [],
): void {
  const selectedGone =
    _state.selectedItemId !== null && !items.some((it) => it.id === _state.selectedItemId);
  _state = {
    ..._state,
    status: "ready",
    error: null,
    items,
    hosts,
    generatedAt,
    machineId,
    selectedItemId: selectedGone ? null : _state.selectedItemId,
  };
  _notify();
}

export function setMeshOpsError(machineId: string | null, error: string): void {
  _state = { ..._state, status: "error", error, machineId };
  _notify();
}

export function setMeshOpsSelection(itemId: string | null): void {
  if (_state.selectedItemId === itemId) return;
  _state = { ..._state, selectedItemId: itemId };
  _notify();
}

export function setMeshOpsGroupBy(groupBy: MeshOpsGroupBy): void {
  if (_state.groupBy === groupBy) return;
  _state = { ..._state, groupBy };
  _notify();
}

export function setMeshOpsAttnFilter(attn: MeshOpsTriage | null): void {
  if (_state.attnFilter === attn) return;
  _state = { ..._state, attnFilter: attn };
  _notify();
}

export function setMeshOpsUnattributedOnly(value: boolean): void {
  if (_state.unattributedOnly === value) return;
  _state = { ..._state, unattributedOnly: value };
  _notify();
}

export function toggleMeshOpsLabFlag(key: keyof MeshOpsLabFlags): void {
  const next = { ..._state.lab, [key]: !_state.lab[key] };
  persistLabFlag(key, next[key]);
  _state = { ..._state, lab: next };
  _notify();
}

export function requestMeshOpsRefresh(): void {
  _state = { ..._state, refreshToken: _state.refreshToken + 1 };
  _notify();
}

function _subscribe(fn: () => void): () => void {
  _listeners.add(fn);
  return () => { _listeners.delete(fn); };
}

function _getSnapshot(): MeshOpsViewState {
  return _state;
}

export function useMeshOpsViewStore(): MeshOpsViewState {
  return useSyncExternalStore(_subscribe, _getSnapshot);
}

/** Non-React read for the data hook's fetch bookkeeping. */
export function meshOpsViewSnapshot(): MeshOpsViewState {
  return _state;
}

export type { MeshOpsAttention, WebMeshOpsItem };
