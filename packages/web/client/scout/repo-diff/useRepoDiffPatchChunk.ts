import { useEffect, useMemo, useRef, useState } from "react";
import {
  fetchRepoDiffSnapshot,
  readRepoDiffCache,
} from "./cache.ts";
import { fileDisplayPath } from "./model.ts";
import type {
  RepoDiffFile,
  RepoDiffLayer,
  RepoDiffLayerKind,
} from "./types.ts";

export type RepoDiffPatchChunkState = {
  layer: RepoDiffLayer | null;
  phase: "idle" | "loading" | "ready" | "error";
  error: string | null;
};

export function useRepoDiffPatchChunk({
  path,
  activeLayer,
  selectedFile,
  snapshotKey,
}: {
  path: string;
  activeLayer: RepoDiffLayerKind | null;
  selectedFile: RepoDiffFile | null;
  snapshotKey: string;
}): RepoDiffPatchChunkState {
  const filePath = selectedFile ? fileDisplayPath(selectedFile) : null;
  const requestKey = `${path}\0${activeLayer ?? ""}\0${filePath ?? ""}\0${snapshotKey}`;
  const [state, setState] = useState<RepoDiffPatchChunkState>({
    layer: null,
    phase: "idle",
    error: null,
  });
  const latestKey = useRef(requestKey);

  const cached = useMemo(() => {
    if (!activeLayer || !filePath) return null;
    return readRepoDiffCache(path, [activeLayer], {
      files: [filePath],
      tier: "patch",
      cacheScope: snapshotKey,
    });
  }, [activeLayer, filePath, path, snapshotKey]);

  useEffect(() => {
    latestKey.current = requestKey;
    if (!activeLayer || !filePath) {
      setState({ layer: null, phase: "idle", error: null });
      return;
    }
    if (cached?.fresh) {
      setState({
        layer: cached.snapshot.layers[0] ?? null,
        phase: "ready",
        error: null,
      });
      return;
    }

    setState({ layer: null, phase: "loading", error: null });

    void fetchRepoDiffSnapshot(path, [activeLayer], {
      files: [filePath],
      tier: "patch",
      cacheScope: snapshotKey,
    }).then(
      (record) => {
        if (latestKey.current !== requestKey) return;
        setState({
          layer: record.snapshot.layers[0] ?? null,
          phase: "ready",
          error: null,
        });
      },
      (error) => {
        if (latestKey.current !== requestKey) return;
        setState((prev) => ({
          layer: prev.layer,
          phase: "error",
          error: error instanceof Error ? error.message : String(error),
        }));
      },
    );
  }, [activeLayer, cached, filePath, path, requestKey]);

  return state;
}
