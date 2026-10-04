import type { Route } from "../../lib/types.ts";
import { defineSurface } from "../../surfaces/types.ts";
import { WorkDetailScreen } from "./WorkDetailScreen.tsx";

export function WorkEmbedScreen({ workId, navigate }: { workId?: string; navigate: (route: Route) => void }) {
  if (!workId) return <div className="s-empty"><h1>Choose a work item</h1><p>This progress link needs a work item. Copy a progress link from its Scout work page.</p></div>;
  return <WorkDetailScreen workId={workId} navigate={navigate} embedded />;
}

export const scoutSurface = defineSurface({
  id: "work",
  label: "Work progress",
  route: { view: "work", workId: "" },
  webPath: "/work",
  screen: "WorkEmbedScreen",
  embed: {
    path: "/embed/work",
    rootClassName: "s-work-embed",
    chrome: { showSecondaryNav: false, showPageStatusBar: false },
    resolveEmbedProps: (params) => ({ workId: params.get("workId")?.trim() || undefined }),
  },
});
