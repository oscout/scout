/**
 * Repo Diff Embed (SCO-065) — the standalone, chrome-free route.
 *
 * Hosted by the macOS app in a WKWebView (a bottom sheet). Renders ONLY the
 * `RepoDiffViewer` full-bleed — no app shell, no nav, no toolbar. Reads the
 * absolute worktree `path` from the query string (`/embed/repo-diff?path=…`).
 *
 * Lazy-loaded (so Pierre is only fetched when the sheet opens). The page is
 * wrapped in `scoutApp.Provider` upstream in main.tsx, which supplies the
 * `[data-scout-theme]` token scope the viewer reads.
 */

import { RepoDiffViewerLazy } from "../scout/repo-diff/RepoDiffViewerLazy.tsx";
import type { RepoDiffLayerKind } from "../scout/repo-diff/types.ts";

const KNOWN_LAYERS: RepoDiffLayerKind[] = ["unstaged", "staged", "branch"];

function parseLayers(params: URLSearchParams): RepoDiffLayerKind[] | undefined {
  const values = params
    .getAll("layer")
    .filter((v): v is RepoDiffLayerKind =>
      (KNOWN_LAYERS as string[]).includes(v),
    );
  return values.length > 0 ? values : undefined;
}

export function RepoDiffEmbedScreen() {
  const params =
    typeof window === "undefined"
      ? new URLSearchParams()
      : new URLSearchParams(window.location.search);
  const path = params.get("path")?.trim() ?? "";
  const files = params.getAll("file").map((v) => v.trim()).filter(Boolean);
  const sessionId = params.get("sessionId")?.trim() || undefined;
  const agentId = params.get("agentId")?.trim() || undefined;
  const include = params.get("include") === "all" || params.get("include") === "touched"
    ? "all"
    : "changed";

  if (!path) {
    return (
      <div className="rd-viewer rd-embed" data-scout-theme>
        <div className="rd-center">
          <div className="rd-center-card">
            <div className="rd-center-title">No worktree path</div>
            <div className="rd-center-body">
              This embed needs a <code>?path=&lt;absolute-path&gt;</code> query
              parameter.
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <RepoDiffViewerLazy
      path={path}
      layers={parseLayers(params)}
      files={files}
      session={sessionId || agentId ? { sessionId, agentId, include } : null}
      className="rd-embed"
    />
  );
}

export default RepoDiffEmbedScreen;
