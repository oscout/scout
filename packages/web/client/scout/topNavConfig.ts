import type { Route } from "../lib/types.ts";
import {
  projectTopNavItems,
  type TopNavItem,
  type TopNavKey,
} from "./nav-destinations.ts";
import {
  ROUTE_VIEW_LABELS,
  routeBreadcrumbForRoute,
} from "./route-breadcrumb.ts";

export type { TopNavItem, TopNavKey };
export { ROUTE_VIEW_LABELS, routeBreadcrumbForRoute };

// Flat single-row nav: Home · Chat · Agents · Terminals · Broker · Search ·
// Ops. Every primary surface is one click from chrome — the System dropdown
// is gone; the ops cluster's mode surfaces live on the Ops screens' own
// secondary strip. There is no lean/full switch — `nav.clean` is gone.
//
// Tab rows are projected from the destination catalog (nav-destinations.ts).
// Breadcrumb labels live in route-breadcrumb.ts (SCO-083) so they survive
// top-tab deletion.
export const TOP_NAV_ITEMS: TopNavItem[] = projectTopNavItems();

/** @deprecated Prefer ROUTE_VIEW_LABELS from route-breadcrumb.ts */
export const TOP_NAV_VIEW_LABELS: Record<string, string> = {
  ...ROUTE_VIEW_LABELS,
};

export function topNavItems(): TopNavItem[] {
  return TOP_NAV_ITEMS;
}

export function topNavKeyForRoute(route: Route): TopNavKey {
  if (route.view === "settings" && route.section === "agents") {
    return "agents";
  }
  switch (route.view) {
    case "agents-v2":
    case "agent-info":
    case "repos":
    case "repo-diff":
    case "code":
      return "agents";
    // Harness session transcripts live under the Terminals tab.
    case "sessions":
    case "terminal":
      return "terminals";
    case "conversation":
    case "messages":
      return "chat";
    case "broker":
    case "work":
    case "follow":
      return "broker";
    case "search":
      return "search";
    case "ops":
    case "harnesses":
    case "mesh":
    case "mesh-ops":
      return "ops";
    // Settings/voice sit outside the tab row; no tab highlights on them.
    case "settings":
    case "voice":
      return "system";
    case "inbox":
    case "activity":
    case "briefings":
    default:
      return "home";
  }
}

/**
 * Breadcrumb for the current route. Delegates to the neutral route-breadcrumb
 * module; preserves the historical agents-config "Configuration" crumb and
 * the prior sparse set used by top-tab chrome tests.
 *
 * For new callers prefer `routeBreadcrumbForRoute` (complete for all areas).
 */
export function topNavBreadcrumbForRoute(route: Route): string | null {
  // Keep the legacy sparse contract for top-tab chrome: only detail-ish routes
  // that the old strip showed. The fuller map lives in routeBreadcrumbForRoute.
  if (route.view === "settings" && route.section === "agents") {
    return "Configuration";
  }
  switch (route.view) {
    case "conversation":
    case "agent-info":
    case "repos":
    case "harnesses":
    case "mesh":
    case "mesh-ops":
    case "work":
      return TOP_NAV_VIEW_LABELS[route.view] ?? route.view;
    default:
      return null;
  }
}
