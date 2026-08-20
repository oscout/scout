import { useEffect, useMemo, useState } from "react";
import { repoDiffFileForKey } from "./comment-context.ts";
import { fileKey, type DiffLayout } from "./model.ts";
import type {
  RepoDiffFile,
  RepoDiffLayer,
  RepoDiffLayerKind,
  ScoutRepoDiffSnapshot,
} from "./types.ts";

export type RepoDiffSelectionState = {
  activeLayer: RepoDiffLayerKind | null;
  setActiveLayer: (layer: RepoDiffLayerKind | null) => void;
  layer: RepoDiffLayer | null;
  selectedFileKey: string | null;
  setSelectedFileKey: (key: string | null) => void;
  selectedFile: RepoDiffFile | null;
  layout: DiffLayout;
  setLayout: (layout: DiffLayout) => void;
};

export function useRepoDiffSelection(
  snapshot: ScoutRepoDiffSnapshot | null,
): RepoDiffSelectionState {
  const [activeLayer, setActiveLayer] = useState<RepoDiffLayerKind | null>(null);
  const [selectedFileKey, setSelectedFileKey] = useState<string | null>(null);
  const [layout, setLayout] = useState<DiffLayout>("split");

  useEffect(() => {
    if (snapshot) {
      setLayout(snapshot.render.preferredLayout === "stacked" ? "unified" : "split");
    }
  }, [snapshot]);

  useEffect(() => {
    if (!snapshot) return;
    const layersWithFiles = snapshot.layers.filter((l) => l.files.length > 0);
    const target = layersWithFiles[0] ?? snapshot.layers[0] ?? null;
    setActiveLayer((prev) => {
      if (prev && snapshot.layers.some((l) => l.kind === prev)) return prev;
      return target ? target.kind : null;
    });
  }, [snapshot]);

  const layer = useMemo<RepoDiffLayer | null>(() => {
    if (!snapshot || !activeLayer) return null;
    return snapshot.layers.find((l) => l.kind === activeLayer) ?? null;
  }, [snapshot, activeLayer]);

  const selectedFile = useMemo(
    () => repoDiffFileForKey(layer, selectedFileKey, fileKey),
    [layer, selectedFileKey],
  );

  useEffect(() => {
    if (!layer) {
      setSelectedFileKey(null);
      return;
    }
    setSelectedFileKey((prev) => {
      const keys = layer.files.map((f, i) => fileKey(f, i));
      if (prev && keys.includes(prev)) return prev;
      return keys[0] ?? null;
    });
  }, [layer]);

  return {
    activeLayer,
    setActiveLayer,
    layer,
    selectedFileKey,
    setSelectedFileKey,
    selectedFile,
    layout,
    setLayout,
  };
}
