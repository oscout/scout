// Reuse the web area rather than maintaining a second native implementation.
import { KnowledgeSearchInspector } from "./right.tsx";
import { SearchContent } from "./content.tsx";
import { useScout } from "../../scout/Provider.tsx";
import { defineSurface, type EmbedScreenProps } from "../../surfaces/types.ts";


export function NativeAreaScreen({ navigate }: EmbedScreenProps) {
  const { route, selectedKnowledgeHit } = useScout();
  return <div style={{ display: "flex", flex: 1, minHeight: 0, minWidth: 0 }}>
    <div style={{ flex: 1, minWidth: 0, overflow: "auto" }}>
    <SearchContent navigate={navigate} route={route.view === "search" ? route : { view: "search" }} />
    </div>
    {selectedKnowledgeHit ? <aside aria-label="Search result" style={{ width: "38%", minWidth: 260, overflow: "auto" }}>
      <KnowledgeSearchInspector navigate={navigate} />
    </aside> : null}
  </div>;
}

export const scoutSurface = defineSurface({
  id: "search",
  label: "Search",
  route: { view: "search" },
  webPath: "/search",
  screen: "NativeAreaScreen",
  embed: {
    path: "/embed/search",
    profile: "macos.search",
    ownsInternalRoutes: true,
    hosts: { macos: true },
  },
});
