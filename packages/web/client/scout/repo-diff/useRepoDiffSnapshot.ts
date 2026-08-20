import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchRepoDiffSnapshot,
  readRepoDiffCache,
  type RepoDiffRequestTier,
  type RepoDiffSessionRequest,
} from "./cache.ts";
import {
  freshnessFromCache,
  freshnessFromRecord,
  type FetchPhase,
  type SnapshotFreshness,
  type SnapshotLoadOptions,
} from "./model.ts";
import type {
  RepoDiffLayerKind,
  ScoutRepoDiffSnapshot,
} from "./types.ts";

export type RepoDiffSnapshotState = {
  snapshot: ScoutRepoDiffSnapshot | null;
  fetchPhase: FetchPhase;
  fetchError: string | null;
  freshness: SnapshotFreshness | null;
  filesKey: string;
  sessionKey: string;
  requestedLayers: RepoDiffLayerKind[];
  loadSnapshot: (options?: SnapshotLoadOptions) => Promise<void>;
  refreshSnapshot: () => void;
};

export function useRepoDiffSnapshot({
  path,
  layers,
  files,
  session,
  tier = "summary",
  forceInitialLoad,
}: {
  path: string;
  layers: RepoDiffLayerKind[];
  files?: string[];
  session?: RepoDiffSessionRequest | null;
  tier?: RepoDiffRequestTier;
  forceInitialLoad: boolean;
}): RepoDiffSnapshotState {
  const layersKey = layers.join(",");
  const requestedLayers = useMemo(
    () => layersKey.split(",") as RepoDiffLayerKind[],
    [layersKey],
  );
  const filesKey = (files ?? []).join("\0");
  const sessionKey = session
    ? `${session.sessionId ?? ""}\0${session.agentId ?? ""}\0${session.include ?? "changed"}`
    : "";
  const requestScope = useMemo(
    () => ({
      files: filesKey ? filesKey.split("\0").filter(Boolean) : undefined,
      tier,
      session: sessionKey
        ? {
            sessionId: session?.sessionId ?? null,
            agentId: session?.agentId ?? null,
            include: session?.include ?? "changed",
          }
        : null,
    }),
    [filesKey, session?.agentId, session?.include, session?.sessionId, sessionKey, tier],
  );

  const [snapshot, setSnapshot] = useState<ScoutRepoDiffSnapshot | null>(null);
  const [fetchPhase, setFetchPhase] = useState<FetchPhase>("loading");
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [freshness, setFreshness] = useState<SnapshotFreshness | null>(null);
  const snapshotRef = useRef<ScoutRepoDiffSnapshot | null>(null);
  const initialForceCompletedRef = useRef(false);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  const loadSnapshot = useCallback(async (options: SnapshotLoadOptions = {}) => {
    const cached = readRepoDiffCache(path, requestedLayers, requestScope);
    const forceLoad = options.force === true
      || (forceInitialLoad && !initialForceCompletedRef.current);
    const preserveCurrent = options.preserveCurrent === true && snapshotRef.current != null;
    setFetchError(null);
    if (cached && !forceLoad) {
      setSnapshot(cached.snapshot);
      setFreshness(freshnessFromCache(cached, true));
      setFetchPhase("ready");
    } else if (preserveCurrent) {
      setFreshness((prev) => ({
        fetchedAt: prev?.fetchedAt ?? Date.now(),
        cacheHit: prev?.cacheHit ?? false,
        refreshing: true,
        refreshError: null,
      }));
      setFetchPhase("ready");
    } else {
      setFetchPhase("loading");
      setFreshness(null);
    }
    try {
      const record = await fetchRepoDiffSnapshot(path, requestedLayers, {
        force: forceLoad || cached != null,
        ...requestScope,
      });
      if (forceLoad) {
        initialForceCompletedRef.current = true;
      }
      setSnapshot(record.snapshot);
      setFreshness(freshnessFromRecord(record, false));
      setFetchPhase("ready");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (cached) {
        setFreshness(freshnessFromCache(cached, false, message));
        setFetchPhase("ready");
      } else if (preserveCurrent) {
        setFreshness((prev) => prev
          ? { ...prev, refreshing: false, refreshError: message }
          : prev);
        setFetchPhase("ready");
      } else {
        setFetchError(message);
        setFetchPhase("error");
      }
    }
  }, [forceInitialLoad, path, requestedLayers, requestScope]);

  useEffect(() => {
    void loadSnapshot();
  }, [loadSnapshot]);

  const refreshSnapshot = useCallback(() => {
    void loadSnapshot({ force: true, preserveCurrent: true });
  }, [loadSnapshot]);

  return {
    snapshot,
    fetchPhase,
    fetchError,
    freshness,
    filesKey,
    sessionKey,
    requestedLayers,
    loadSnapshot,
    refreshSnapshot,
  };
}
