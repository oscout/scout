import type { ReactNode } from "react";
import type { Agent, Route } from "../lib/types.ts";
import type { useScout } from "../scout/Provider.tsx";
import { isProjectAgentProfileRoute } from "../screens/projects/model.ts";
import { isScopePath, routeToScopeSegment } from "./paths.ts";
import { ScopeDirView } from "./views/ScopeDirView.tsx";
import { ScopeLanesView } from "./views/ScopeLanesView.tsx";
import { ScopeSessionsView } from "./views/ScopeSessionsView.tsx";
import { ScopeTailView } from "./views/ScopeTailView.tsx";

type Navigate = ReturnType<typeof useScout>["navigate"];

/** Scope-owned surfaces for /scope/* — null when the route is not a scope presentation. */
export function resolveScopeContentPane(
  route: Route,
  navigate: Navigate,
  agents: Agent[],
  pathname: string,
): ReactNode | null {
  if (!isScopePath(pathname)) return null;

  const segment = routeToScopeSegment(route);
  if (!segment) return null;

  switch (segment) {
    case "lanes":
      return <ScopeLanesView navigate={navigate} agents={agents} />;
    case "tail":
      if (route.view !== "ops" || route.mode !== "tail") return null;
      return (
        <ScopeTailView
          navigate={navigate}
          tailQuery={route.tailQuery}
        />
      );
    case "sessions":
      if (route.view !== "sessions") return null;
      return <ScopeSessionsView route={route} navigate={navigate} />;
    case "agents":
      if (route.view !== "agents-v2" || isProjectAgentProfileRoute(route)) return null;
      return <ScopeDirView navigate={navigate} agents={agents} />;
    default:
      return null;
  }
}