import { useEffect } from "react";
import { api } from "../../lib/api.ts";
import { useBrokerEvents } from "../../lib/sse.ts";
import {
  meshOpsViewSnapshot,
  requestMeshOpsRefresh,
  setMeshOpsData,
  setMeshOpsError,
  setMeshOpsLoading,
  useMeshOpsViewStore,
} from "../../lib/mesh-ops-view-store.ts";
import type { MeshOpsResponse, WebMeshOpsItem } from "../../lib/types.ts";

/**
 * Mesh Ops data hook — fetches `/api/mesh-ops` for the current machine scope
 * into the shared mesh-ops view store and refetches on broker SSE hints.
 * All three panes call it; module-level dedup collapses concurrent triggers.
 */

const REFETCH_EVENT_KINDS = new Set([
  "collaboration.event.appended",
  "flight.updated",
  "message.posted",
]);

const SSE_REFETCH_MIN_INTERVAL_MS = 750;

let _requestSequence = 0;
const _inFlightRequests = new Map<string, Promise<void>>();
const _inFlightRequestSequences = new Map<string, number>();
const _latestRequestByScope = new Map<string, number>();
let _lastSseFetchAt = 0;

function loadMeshOps(
  machineId: string | null,
  opts: { background: boolean; refreshToken?: number },
): Promise<void> {
  const scopeKey = machineId ?? "";
  const requestKey = opts.background
    ? `background:${scopeKey}`
    : `foreground:${scopeKey}:${opts.refreshToken ?? 0}`;
  const existing = _inFlightRequests.get(requestKey);
  if (existing) {
    // A route can leave and return to this scope while its first foreground
    // request is still running. Reassert the current scope before sharing the
    // promise so the response's machine guard can apply it instead of leaving
    // the intervening scope's data mounted indefinitely.
    if (!opts.background) setMeshOpsLoading(machineId);
    return existing;
  }

  const sequence = ++_requestSequence;
  _latestRequestByScope.set(scopeKey, sequence);
  if (!opts.background) setMeshOpsLoading(machineId);

  const request = (async () => {
    try {
      const params = new URLSearchParams();
      if (machineId) params.set("machineId", machineId);
      params.set("limit", "200");
      // Foreground requests include a monotonic nonce so the API helper cannot
      // coalesce an explicit post-actuation refresh with an older GET.
      if (!opts.background) params.set("refresh", String(sequence));
      const data = await api<MeshOpsResponse>(`/api/mesh-ops?${params.toString()}`);
      if (
        _latestRequestByScope.get(scopeKey) !== sequence
        || meshOpsViewSnapshot().machineId !== machineId
      ) {
        return;
      }
      setMeshOpsData(
        machineId,
        Array.isArray(data.items) ? data.items : [],
        data.generatedAt ?? null,
        Array.isArray(data.hosts) ? data.hosts : [],
      );
    } catch (error) {
      // Background refetches keep last-known data; only the current foreground
      // load surfaces an error state (mirrors the mesh screen).
      if (
        !opts.background
        && _latestRequestByScope.get(scopeKey) === sequence
        && meshOpsViewSnapshot().machineId === machineId
      ) {
        setMeshOpsError(machineId, error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (_inFlightRequestSequences.get(requestKey) === sequence) {
        _inFlightRequests.delete(requestKey);
        _inFlightRequestSequences.delete(requestKey);
      }
    }
  })();
  _inFlightRequests.set(requestKey, request);
  _inFlightRequestSequences.set(requestKey, sequence);
  return request;
}

export function useMeshOpsItems(machineId: string | null): {
  items: WebMeshOpsItem[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const { items, status, error, refreshToken } = useMeshOpsViewStore();

  useEffect(() => {
    void loadMeshOps(machineId, { background: false, refreshToken });
  }, [machineId, refreshToken]);

  useBrokerEvents((event) => {
    if (!REFETCH_EVENT_KINDS.has(event.kind)) return;
    const now = Date.now();
    if (now - _lastSseFetchAt < SSE_REFETCH_MIN_INTERVAL_MS) return;
    _lastSseFetchAt = now;
    void loadMeshOps(meshOpsViewSnapshot().machineId, { background: true });
  });

  return {
    items,
    loading: status === "idle" || status === "loading",
    error,
    refresh: requestMeshOpsRefresh,
  };
}
