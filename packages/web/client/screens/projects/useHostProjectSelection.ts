import { useCallback, useEffect, useRef } from "react";
import type { Route } from "../../lib/types.ts";
import { projectSelectionRoute, registerEmbedProjectSelectionHandler } from "./embed-project-selection.ts";
import { useProjectsInbox } from "./useProjectsInbox.ts";

type AgentsRoute = Extract<Route, { view: "agents-v2" }>;

export { projectSelectionRoute } from "./embed-project-selection.ts";

export function useHostProjectSelection(
  route: AgentsRoute,
  navigate: (route: Route) => void,
): void {
  const { model, loading } = useProjectsInbox(route);
  const pendingRootRef = useRef<string | null | undefined>(undefined);
  const routeRef = useRef(route);
  routeRef.current = route;

  const applySelection = useCallback((root: string | null) => {
    if (root && loading && model.projects.length === 0) {
      pendingRootRef.current = root;
      return;
    }

    pendingRootRef.current = undefined;
    navigate(projectSelectionRoute(model, root, routeRef.current));
  }, [loading, model, navigate]);

  useEffect(() => {
    registerEmbedProjectSelectionHandler((action) => {
      applySelection(action.root);
    });
    return () => registerEmbedProjectSelectionHandler(null);
  }, [applySelection]);

  useEffect(() => {
    const pending = pendingRootRef.current;
    if (pending === undefined) return;
    if (pending && loading && model.projects.length === 0) return;

    pendingRootRef.current = undefined;
    navigate(projectSelectionRoute(model, pending, routeRef.current));
  }, [loading, model, navigate]);
}
