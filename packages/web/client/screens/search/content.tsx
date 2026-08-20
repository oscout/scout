import type { Route } from "../../lib/types.ts";
import type { useScout } from "../../scout/Provider.tsx";
import { KnowledgeSearchScreen } from "./KnowledgeSearchScreen.tsx";

type Navigate = ReturnType<typeof useScout>["navigate"];

export function SearchContent({ route, navigate }: { route: Route; navigate: Navigate }) {
  if (route.view !== "search") return null;
  // mode is accepted on the route for back-compat (/search/indexer → same surface).
  return (
    <KnowledgeSearchScreen
      navigate={navigate}
      mode={route.mode}
      hitId={route.hitId}
      routeFilters={route.filters}
    />
  );
}
