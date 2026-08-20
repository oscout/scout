/**
 * Repo Diff Viewer (SCO-065) — lazy wrapper.
 *
 * `React.lazy` + `Suspense` so the heavy Pierre/Shiki import (and the whole
 * viewer module) only loads when the viewer opens — the default app shell and
 * the Repos screen never pay for it. Both entry points (the in-app SlidePanel
 * and the standalone `/embed/repo-diff` route) render through this wrapper.
 */

import { lazy, Suspense } from "react";

import "./repo-diff.css";
import type { RepoDiffViewerProps } from "./RepoDiffViewer.tsx";

const RepoDiffViewer = lazy(() =>
  import("./RepoDiffViewer.tsx").then((m) => ({ default: m.RepoDiffViewer })),
);

function ViewerFallback() {
  return (
    <div className="rd-viewer" data-scout-theme>
      <div className="rd-center">
        <div className="rd-center-card">
          <div className="rd-spinner" aria-hidden />
          <div className="rd-center-title">Opening diff viewer…</div>
        </div>
      </div>
    </div>
  );
}

export function RepoDiffViewerLazy(props: RepoDiffViewerProps) {
  return (
    <Suspense fallback={<ViewerFallback />}>
      <RepoDiffViewer {...props} />
    </Suspense>
  );
}

export default RepoDiffViewerLazy;
