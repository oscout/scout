/**
 * Repo Diff Page (SCO-065) — the diff as its own in-shell, linkable route.
 *
 * Three surfaces share the one `RepoDiffViewer`:
 *   - the Repos slide-out panel (ephemeral, Repos-scoped),
 *   - the chrome-free `/embed/repo-diff` route (hosted by the macOS WKWebView),
 *   - and THIS page (`/repo-diff?path=…`) — full-bleed inside the app shell,
 *     reached via "Open as page" from the panel and deep-linkable /
 *     back-button-correct.
 *
 * Note: unlike the embed, we do NOT pass `className="rd-embed"` (that strips
 * chrome for the WKWebView); the page wants the normal full-bleed viewer. The
 * `[data-scout-theme]` token scope is supplied by the app shell upstream.
 */

import { RepoDiffViewerLazy } from "../../scout/repo-diff/RepoDiffViewerLazy.tsx";
import type { RepoDiffLayerKind } from "../../scout/repo-diff/types.ts";
import { isBrowserReloadNavigation } from "../../lib/navigation.ts";
import type { Route } from "../../lib/types.ts";

export function RepoDiffPageScreen({
  path,
  layers,
  files,
  sessionId,
  agentId,
  include,
  navigate,
}: {
  path: string;
  layers?: RepoDiffLayerKind[];
  files?: string[];
  sessionId?: string;
  agentId?: string;
  include?: "changed" | "all";
  navigate: (route: Route) => void;
}) {
  const trimmed = path.trim();
  if (!trimmed) {
    return (
      <div className="rd-viewer">
        <div className="rd-center">
          <div className="rd-center-card">
            <div className="rd-center-title">No worktree path</div>
            <div className="rd-center-body">
              This page needs a <code>?path=&lt;absolute-path&gt;</code> query
              parameter.
            </div>
          </div>
        </div>
      </div>
    );
  }

  const viewerKey = [
    trimmed,
    layers?.join(",") ?? "",
    files?.join("\0") ?? "",
    sessionId ?? "",
    agentId ?? "",
    include ?? "",
  ].join("\u0001");
  const forceInitialLoad = isBrowserReloadNavigation();

  return (
    <RepoDiffViewerLazy
      key={viewerKey}
      path={trimmed}
      layers={layers}
      files={files}
      session={sessionId || agentId ? { sessionId, agentId, include } : null}
      forceInitialLoad={forceInitialLoad}
      onClose={() => navigate({ view: "repos" })}
    />
  );
}

export default RepoDiffPageScreen;
