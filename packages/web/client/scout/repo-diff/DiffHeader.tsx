import { MessageSquare, RefreshCw } from "lucide-react";
import { repoDiffCacheAgeLabel } from "./cache.ts";
import {
  LAYER_LABELS,
  layerChurn,
  splitPath,
  type DiffLayout,
  type SnapshotFreshness,
} from "./model.ts";
import type {
  RepoDiffLayer,
  RepoDiffLayerKind,
  ScoutRepoDiffSnapshot,
} from "./types.ts";

export function DiffHeader({
  heading,
  worktreePath,
  snapshot,
  freshness,
  activeLayer,
  onLayer,
  layout,
  onLayout,
  refreshing,
  onRefresh,
  onFocusComment,
  onClose,
  onOpenAsPage,
}: {
  heading: string;
  worktreePath: string;
  snapshot: ScoutRepoDiffSnapshot;
  freshness: SnapshotFreshness | null;
  activeLayer: RepoDiffLayerKind | null;
  onLayer: (layer: RepoDiffLayerKind) => void;
  layout: DiffLayout;
  onLayout: (layout: DiffLayout) => void;
  refreshing: boolean;
  onRefresh: () => void;
  onFocusComment: () => void;
  onClose?: () => void;
  onOpenAsPage?: () => void;
}) {
  const { dir } = splitPath(worktreePath);
  return (
    <div className="rd-header">
      <div className="rd-header-id">
        <div className="rd-header-title">
          <span className="rd-header-name" title={worktreePath}>
            {heading}
          </span>
          {snapshot.scope ? <DiffScopePill snapshot={snapshot} /> : null}
          {dir ? <span className="rd-header-dir">{dir}</span> : null}
        </div>
        <div className="rd-header-sub">
          <LayerTabs
            layers={snapshot.layers}
            activeLayer={activeLayer}
            onLayer={onLayer}
          />
        </div>
        <DiffFreshness freshness={freshness} generatedAt={snapshot.generatedAt} />
      </div>
      <div className="rd-header-actions">
        <button
          type="button"
          className="rd-close"
          aria-label="Comment on diff"
          title="Comment on diff"
          onClick={onFocusComment}
        >
          <MessageSquare size={14} strokeWidth={2} aria-hidden />
        </button>
        <div className="rd-segmented" role="group" aria-label="Diff layout">
          <button
            type="button"
            className={layout === "unified" ? "on" : ""}
            aria-pressed={layout === "unified"}
            onClick={() => onLayout("unified")}
          >
            Unified
          </button>
          <button
            type="button"
            className={layout === "split" ? "on" : ""}
            aria-pressed={layout === "split"}
            onClick={() => onLayout("split")}
          >
            Split
          </button>
        </div>
        <button
          type="button"
          className={`rd-close${refreshing ? " spinning" : ""}`}
          aria-label="Refresh diff"
          title="Fetch fresh diff"
          onClick={onRefresh}
          disabled={refreshing}
        >
          <RefreshCw size={14} strokeWidth={2} aria-hidden />
        </button>
        {onOpenAsPage ? (
          <button
            type="button"
            className="rd-close"
            aria-label="Open diff as page"
            title="Open as full page"
            onClick={onOpenAsPage}
          >
            ↗
          </button>
        ) : null}
        {onClose ? (
          <button type="button" className="rd-close" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function SnapshotDiagnostics({ snapshot }: { snapshot: ScoutRepoDiffSnapshot }) {
  const banners: { level: "info" | "warning"; text: string }[] = [];

  if (snapshot.coverage.truncatedLayers > 0) {
    banners.push({
      level: "warning",
      text: `${snapshot.coverage.truncatedLayers} layer${
        snapshot.coverage.truncatedLayers === 1 ? "" : "s"
      } truncated — the native diff hit a size budget; some files or hunks are omitted.`,
    });
  }
  if (snapshot.coverage.scanBudgetReached) {
    banners.push({
      level: "warning",
      text: "Scan budget reached — this diff is partial.",
    });
  }
  for (const d of snapshot.diagnostics) {
    banners.push({
      level: d.level,
      text: d.path ? `${d.message} (${d.path})` : d.message,
    });
  }

  if (banners.length === 0) return null;

  return (
    <>
      {banners.map((b, i) => (
        <div key={i} className={`rd-banner ${b.level}`}>
          <span className="rd-banner-dot" aria-hidden />
          <span>{b.text}</span>
        </div>
      ))}
    </>
  );
}

function DiffScopePill({ snapshot }: { snapshot: ScoutRepoDiffSnapshot }) {
  const scope = snapshot.scope;
  if (!scope) return null;
  const label = scope.kind === "session"
    ? `Session · ${scope.filteredPaths.length} files`
    : scope.filteredPaths.length > 0
      ? `Filtered · ${scope.filteredPaths.length} files`
      : "Worktree";
  const title = scope.kind === "session"
    ? `${scope.label}: path-filtered diff from ${scope.changedFiles} changed / ${scope.touchedFiles} touched session files`
    : scope.label;
  return (
    <span className={`rd-scope-pill ${scope.kind}`} title={title}>
      {label}
    </span>
  );
}

function DiffFreshness({
  freshness,
  generatedAt,
}: {
  freshness: SnapshotFreshness | null;
  generatedAt: number;
}) {
  const fetchedAt = freshness?.fetchedAt ?? generatedAt;
  const ageMs = Math.max(0, Date.now() - fetchedAt);
  const label = freshness?.cacheHit
    ? `Prefetched ${repoDiffCacheAgeLabel(ageMs)}`
    : `Updated ${repoDiffCacheAgeLabel(ageMs)}`;
  return (
    <div className="rd-freshness" title={new Date(fetchedAt).toLocaleString()}>
      <span>{label}</span>
      {freshness?.refreshing ? <span>Refreshing…</span> : null}
      {freshness?.refreshError ? <span>Refresh failed</span> : null}
    </div>
  );
}

function LayerTabs({
  layers,
  activeLayer,
  onLayer,
}: {
  layers: RepoDiffLayer[];
  activeLayer: RepoDiffLayerKind | null;
  onLayer: (layer: RepoDiffLayerKind) => void;
}) {
  return (
    <div className="rd-layers" role="tablist" aria-label="Diff layers">
      {layers.map((l) => {
        const churn = layerChurn(l);
        return (
          <button
            key={l.kind}
            type="button"
            role="tab"
            aria-selected={l.kind === activeLayer}
            className={"rd-layer-tab" + (l.kind === activeLayer ? " on" : "")}
            onClick={() => onLayer(l.kind)}
            title={l.shortstat ?? undefined}
          >
            <span>{LAYER_LABELS[l.kind] ?? l.kind}</span>
            <span className="rd-layer-stat">
              {l.files.length === 0 ? (
                "clean"
              ) : (
                <>
                  {l.files.length}f{" "}
                  <span style={{ color: "var(--rd-add)" }}>+{churn.add}</span>{" "}
                  <span style={{ color: "var(--rd-del)" }}>−{churn.del}</span>
                  {l.truncated ? " ⚠" : ""}
                </>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
