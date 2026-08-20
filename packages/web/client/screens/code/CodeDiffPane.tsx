import { useEffect, useMemo, useState } from "react";
import { fetchRepoDiffSnapshot } from "../../scout/repo-diff/cache.ts";
import { DiffSurface } from "../../scout/repo-diff/DiffSurface.tsx";
import { fileKey, LAYER_LABELS, layerChurn } from "../../scout/repo-diff/model.ts";
import type {
  RepoDiffLayerKind,
  ScoutRepoDiffSnapshot,
} from "../../scout/repo-diff/types.ts";
import { usePierreRuntime } from "../../scout/repo-diff/usePierreRuntime.ts";
import {
  diffFileIndex,
  FILE_DIFF_LAYERS,
  firstChangedLayer,
  relativeFilePath,
} from "./code-diff-model.ts";
import "../../scout/repo-diff/repo-diff.css";

const ignoreLineContext = () => {};
const ignoreSelectionContext = () => {};

/** A path-filtered working-tree diff for the Code reader.
 *
 * The full Repo Diff viewer owns review chrome, comments, and a files rail. The
 * Code surface needs only the selected file, so it uses the same native Git
 * snapshot and Pierre renderer without duplicating those surrounding tools.
 */
export function CodeDiffPane({ root, file }: { root: string; file: string }) {
  const relativePath = useMemo(() => relativeFilePath(root, file), [file, root]);
  const [snapshot, setSnapshot] = useState<ScoutRepoDiffSnapshot | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [activeLayer, setActiveLayer] = useState<RepoDiffLayerKind | null>(null);
  const { pierre, pierrePhase, pierreError, pierreTheme, retryPierre } = usePierreRuntime(snapshot);

  useEffect(() => {
    let cancelled = false;
    setSnapshot(null);
    setPhase("loading");
    setError(null);
    setActiveLayer(null);

    if (!relativePath) {
      setPhase("ready");
      return;
    }

    void fetchRepoDiffSnapshot(root, FILE_DIFF_LAYERS, {
      files: [relativePath],
      tier: "patch",
    }).then(
      (record) => {
        if (cancelled) return;
        setSnapshot(record.snapshot);
        setActiveLayer(firstChangedLayer(record.snapshot.layers, relativePath));
        setPhase("ready");
      },
      (reason) => {
        if (cancelled) return;
        setError(reason instanceof Error ? reason.message : String(reason));
        setPhase("error");
      },
    );

    return () => {
      cancelled = true;
    };
  }, [relativePath, root]);

  const changedLayers = useMemo(
    () => relativePath
      ? snapshot?.layers.filter((layer) => diffFileIndex(layer, relativePath) >= 0) ?? []
      : [],
    [relativePath, snapshot],
  );
  const layer = changedLayers.find((candidate) => candidate.kind === activeLayer)
    ?? changedLayers[0]
    ?? null;
  const selectedFileIndex = layer && relativePath ? diffFileIndex(layer, relativePath) : -1;
  const selectedFileKey = layer && selectedFileIndex >= 0
    ? fileKey(layer.files[selectedFileIndex]!, selectedFileIndex)
    : null;

  if (phase === "loading") {
    return <div className="s-code-empty">Loading file changes…</div>;
  }
  if (phase === "error") {
    return <div className="s-code-empty">{error ?? "Couldn’t load this file’s changes."}</div>;
  }
  if (!snapshot || !layer || !selectedFileKey) {
    return (
      <div className="s-code-empty">
        No tracked patch is available. The file is clean, or it is untracked and has no Git baseline yet.
      </div>
    );
  }

  return (
    <div className="s-code-diff">
      {changedLayers.length > 1 ? (
        <div className="s-code-diffLayers" role="tablist" aria-label="Change layer">
          {changedLayers.map((candidate) => {
            const churn = layerChurn(candidate);
            const selected = candidate.kind === layer.kind;
            return (
              <button
                key={candidate.kind}
                type="button"
                role="tab"
                aria-selected={selected}
                className="s-code-diffLayer"
                data-selected={selected || undefined}
                onClick={() => setActiveLayer(candidate.kind)}
              >
                {LAYER_LABELS[candidate.kind]}
                <span>+{churn.add} −{churn.del}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      <DiffSurface
        layer={layer}
        patchLayer={layer}
        patchPhase="ready"
        patchError={null}
        selectedFileKey={selectedFileKey}
        renderKey={snapshot.render.renderKey}
        theme={pierreTheme}
        layout="split"
        pierre={pierre}
        pierrePhase={pierrePhase}
        pierreError={pierreError}
        onRetryPierre={retryPierre}
        onIncludeLineContext={ignoreLineContext}
        onIncludeSelectionContext={ignoreSelectionContext}
        contextActions={false}
      />
    </div>
  );
}
