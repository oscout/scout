/**
 * React binding for the Network page's per-node state store.
 *
 * Kept apart from the store itself so the merge and ordering rules — the part
 * that decides whether a machine's detail survives the next poll — can be
 * tested without pulling React in.
 */

import { useSyncExternalStore } from "react";

import {
  meshNodeStateStore,
  type MeshNodeStateEntry,
  type MeshNodeStateStoreState,
} from "./mesh-node-state.ts";

export function useMeshNodeStates(): MeshNodeStateStoreState {
  return useSyncExternalStore(
    meshNodeStateStore.subscribe,
    meshNodeStateStore.snapshot,
    meshNodeStateStore.snapshot,
  );
}

export function useMeshNodeState(machineId: string | null): MeshNodeStateEntry | null {
  const states = useMeshNodeStates();
  return machineId ? states.entries[machineId] ?? null : null;
}
