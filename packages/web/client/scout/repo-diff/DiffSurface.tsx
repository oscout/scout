import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ParsedPatch } from "@pierre/diffs";
import type { CodeViewItem } from "@pierre/diffs/react";
import { Center } from "./RepoDiffChrome.tsx";
import {
  parseRepoDiffLineContexts,
  selectionContextFromWindow,
  type RepoDiffLineContext,
  type RepoDiffSelectionContext,
} from "./line-context.ts";
import {
  mountPierreDiff,
  parseLayerPatch,
  type PierreDiffHandle,
  type PierreRuntime,
} from "./pierre.ts";
import {
  fileKey,
  LAYER_LABELS,
  type DiffLayout,
  type PierrePhase,
} from "./model.ts";
import type {
  RepoDiffLayer,
} from "./types.ts";

export function DiffSurface({
  layer,
  patchLayer,
  patchPhase,
  patchError,
  selectedFileKey,
  renderKey,
  theme,
  layout,
  pierre,
  pierrePhase,
  pierreError,
  onRetryPierre,
  onIncludeLineContext,
  onIncludeSelectionContext,
  contextActions = true,
}: {
  layer: RepoDiffLayer | null;
  patchLayer: RepoDiffLayer | null;
  patchPhase: "idle" | "loading" | "ready" | "error";
  patchError: string | null;
  selectedFileKey: string | null;
  renderKey: string;
  theme: string;
  layout: DiffLayout;
  pierre: PierreRuntime | null;
  pierrePhase: PierrePhase;
  pierreError: string | null;
  onRetryPierre: () => void;
  onIncludeLineContext: (line: RepoDiffLineContext) => void;
  onIncludeSelectionContext: (selection: RepoDiffSelectionContext) => void;
  /** Hide review-only line/selection actions when the renderer is reused as a
   *  compact read-only diff, such as the Code surface's file toggle. */
  contextActions?: boolean;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [selectionChip, setSelectionChip] = useState<{ left: number; top: number } | null>(null);
  const selectedFile = useMemo(() => {
    if (!layer) return null;
    return (
      layer.files.find((f, i) => fileKey(f, i) === selectedFileKey) ?? null
    );
  }, [layer, selectedFileKey]);
  const renderLayer = patchLayer ?? layer;

  const parsed = useMemo<
    | { ok: true; items: CodeViewItem[]; patches: ParsedPatch[] }
    | { ok: false; error: string }
    | null
  >(() => {
    if (!pierre || !renderLayer || !renderLayer.rawPatch) return null;
    try {
      const cachePrefix = `${renderKey}:${renderLayer.kind}:${renderLayer.patchOid}`;
      const patches = parseLayerPatch(pierre, renderLayer.rawPatch, cachePrefix);
      const items: CodeViewItem[] = [];
      patches.forEach((patch, pi) => {
        patch.files.forEach((fileDiff, fi) => {
          items.push({
            id: `${cachePrefix}:${pi}:${fi}:${fileDiff.name}`,
            type: "diff",
            fileDiff,
          });
        });
      });
      return { ok: true, items, patches };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }, [pierre, renderLayer, renderKey]);

  const selectedItemId = useMemo<string | null>(() => {
    if (!parsed || !parsed.ok || !selectedFile) return null;
    const candidates = [selectedFile.newPath, selectedFile.oldPath].filter(
      (p): p is string => Boolean(p),
    );
    for (const item of parsed.items) {
      const name = (item as { fileDiff?: { name?: string } }).fileDiff?.name;
      if (name && candidates.includes(name)) return item.id;
    }
    return null;
  }, [parsed, selectedFile]);
  const lineContexts = useMemo(
    () => contextActions ? parseRepoDiffLineContexts(renderLayer, selectedFile) : [],
    [contextActions, renderLayer, selectedFile],
  );
  const includeSelection = useCallback(() => {
    if (!contextActions) return;
    const selection = selectionContextFromWindow({
      activeLayer: layer?.kind ?? null,
      selectedFile,
      root: surfaceRef.current,
    });
    if (selection) {
      onIncludeSelectionContext(selection);
      window.getSelection()?.removeAllRanges();
      setSelectionChip(null);
    }
  }, [contextActions, layer?.kind, onIncludeSelectionContext, selectedFile]);
  const updateSelectionChip = useCallback(() => {
    if (!contextActions) {
      setSelectionChip(null);
      return;
    }
    const root = surfaceRef.current;
    const selection = selectionContextFromWindow({
      activeLayer: layer?.kind ?? null,
      selectedFile,
      root,
    });
    if (!root || !selection) {
      setSelectionChip(null);
      return;
    }
    const domSelection = window.getSelection();
    const range = domSelection?.rangeCount ? domSelection.getRangeAt(0) : null;
    const rect = range?.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      setSelectionChip(null);
      return;
    }
    const rootRect = root.getBoundingClientRect();
    const maxLeft = Math.max(8, root.clientWidth - 132);
    const maxTop = Math.max(8, root.clientHeight - 36);
    setSelectionChip({
      left: Math.min(Math.max(rect.right - rootRect.left + 8, 8), maxLeft),
      top: Math.min(Math.max(rect.top - rootRect.top - 2, 8), maxTop),
    });
  }, [contextActions, layer?.kind, selectedFile]);

  useEffect(() => {
    if (!contextActions) return;
    const onSelectionChange = () => {
      requestAnimationFrame(updateSelectionChip);
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, [contextActions, updateSelectionChip]);

  if (!layer) {
    return (
      <div className="rd-surface">
        <Center>
          <div className="rd-center-title">No layer selected</div>
        </Center>
      </div>
    );
  }

  if (layer.files.length === 0) {
    return (
      <div className="rd-surface">
        <Center>
          <div className="rd-center-title">Nothing to diff</div>
          <div className="rd-center-body">
            The {LAYER_LABELS[layer.kind] ?? layer.kind.toLowerCase()} layer is
            clean.
          </div>
        </Center>
      </div>
    );
  }

  if (patchPhase === "loading" || (patchPhase === "idle" && selectedFile)) {
    return (
      <div className="rd-surface">
        <Center>
          <div className="rd-spinner" aria-hidden />
          <div className="rd-center-title">Loading selected file…</div>
          <div className="rd-center-body">
            Fetching a path-filtered patch chunk for this file.
          </div>
        </Center>
      </div>
    );
  }

  if (patchPhase === "error" && !patchLayer) {
    return (
      <div className="rd-surface">
        <Center>
          <div className="rd-center-title">Couldn’t load this file</div>
          <div className="rd-center-body">
            {patchError ?? "The path-filtered patch request failed."}
          </div>
        </Center>
      </div>
    );
  }

  if (pierrePhase === "loading") {
    return (
      <div className="rd-surface">
        <Center>
          <div className="rd-spinner" aria-hidden />
          <div className="rd-center-title">Loading the diff renderer…</div>
          <div className="rd-center-body">
            Fetching Pierre Diffs + Shiki (first open only).
          </div>
        </Center>
      </div>
    );
  }

  if (pierrePhase === "error" || !pierre) {
    return (
      <div className="rd-surface">
        <div className="rd-banner warning">
          <span className="rd-banner-dot" aria-hidden />
          <span>
            The diff renderer failed to load
            {pierreError ? `: ${pierreError}` : "."} Showing raw patch text.
          </span>
        </div>
        <div className="rd-surface-scroll">
          <RawPatchFallback layer={renderLayer ?? layer} onRetry={onRetryPierre} />
        </div>
      </div>
    );
  }

  if (!renderLayer?.rawPatch || !parsed) {
    return (
      <div className="rd-surface">
        <Center>
          <div className="rd-center-title">No patch text available</div>
          <div className="rd-center-body">
            {layer.truncated
              ? "This layer was truncated by the native diff budget; file summaries are shown in the rail."
              : "The summary is loaded. Select a file to fetch its patch text."}
          </div>
        </Center>
      </div>
    );
  }

  if (!parsed.ok) {
    return (
      <div className="rd-surface">
        <div className="rd-banner warning">
          <span className="rd-banner-dot" aria-hidden />
          <span>Couldn’t parse the patch ({parsed.error}). Showing raw text.</span>
        </div>
        <div className="rd-surface-scroll">
          <RawPatchFallback layer={renderLayer} />
        </div>
      </div>
    );
  }

  const truncatedFiles = renderLayer.files.filter((f) => f.truncated).length;

  return (
    <div className="rd-surface" ref={surfaceRef}>
      {patchPhase === "error" && patchLayer ? (
        <div className="rd-banner warning">
          <span className="rd-banner-dot" aria-hidden />
          <span>{patchError ?? "Couldn’t refresh this file; showing the cached chunk."}</span>
        </div>
      ) : null}
      {renderLayer.truncated || truncatedFiles > 0 ? (
        <div className="rd-banner warning">
          <span className="rd-banner-dot" aria-hidden />
          <span>
            {renderLayer.truncated
              ? "This layer was truncated; some files or hunks are omitted."
              : `${truncatedFiles} file${truncatedFiles === 1 ? "" : "s"} truncated.`}
          </span>
        </div>
      ) : null}
      {contextActions && selectionChip ? (
        <button
          type="button"
          className="rd-selection-context-chip"
          style={{ left: selectionChip.left, top: selectionChip.top }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={includeSelection}
        >
          + selection
        </button>
      ) : null}
      <div className="rd-surface-scroll" onMouseUp={updateSelectionChip} onKeyUp={updateSelectionChip}>
        <PierreCodeView
          pierre={pierre}
          items={parsed.items}
          theme={theme}
          layout={layout}
          scrollToItemId={selectedItemId}
          lineContexts={lineContexts}
          onIncludeLineContext={onIncludeLineContext}
          onIncludeSelectionContext={onIncludeSelectionContext}
        />
      </div>
    </div>
  );
}

function PierreCodeView({
  pierre,
  items,
  theme,
  layout,
  scrollToItemId,
  lineContexts,
  onIncludeLineContext,
  onIncludeSelectionContext,
}: {
  pierre: PierreRuntime;
  items: CodeViewItem[];
  theme: string;
  layout: DiffLayout;
  scrollToItemId: string | null;
  lineContexts: RepoDiffLineContext[];
  onIncludeLineContext: (line: RepoDiffLineContext) => void;
  onIncludeSelectionContext: (selection: RepoDiffSelectionContext) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<PierreDiffHandle | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    const handle = mountPierreDiff(pierre, hostRef.current);
    handleRef.current = handle;
    return () => {
      handleRef.current = null;
      setTimeout(() => handle.unmount(), 0);
    };
  }, [pierre]);

  useEffect(() => {
    handleRef.current?.render({
      items,
      theme,
      layout,
      lineContexts,
      onIncludeLineContext,
      onIncludeSelectionContext,
    });
  }, [
    items,
    theme,
    layout,
    lineContexts,
    onIncludeLineContext,
    onIncludeSelectionContext,
  ]);

  useEffect(() => {
    if (!scrollToItemId) return;
    const raf = requestAnimationFrame(() => {
      handleRef.current?.scrollToItem(scrollToItemId);
    });
    return () => cancelAnimationFrame(raf);
  }, [scrollToItemId]);

  return <div ref={hostRef} className="rd-codeview-host" />;
}

function RawPatchFallback({
  layer,
  onRetry,
}: {
  layer: RepoDiffLayer;
  onRetry?: () => void;
}) {
  return (
    <div style={{ padding: "var(--space-lg)" }}>
      {onRetry ? (
        <div className="rd-center-action" style={{ marginTop: 0, marginBottom: "var(--space-md)" }}>
          <button type="button" className="rd-btn" onClick={onRetry}>
            Retry renderer
          </button>
        </div>
      ) : null}
      <pre
        style={{
          margin: 0,
          whiteSpace: "pre",
          fontFamily: "var(--rd-mono)",
          fontSize: "var(--text-xs)",
          lineHeight: 1.5,
          color: "var(--ink)",
        }}
      >
        {layer.rawPatch ?? "(no patch text)"}
      </pre>
    </div>
  );
}
