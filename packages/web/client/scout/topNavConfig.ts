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

// Single-personality nav (Model B · Work nouns): Home · Crew · Sessions ·
// Chat. The ops/retrieval cluster (Search, Terminals, Tail, Dispatch, and the
// ops surfaces) lives one level down in the System dropdown
// (nav-system-menu.tsx). There is no lean/full switch — `nav.clean` is gone.
//
// Tab rows are projected from the destination catalog (nav-destinations.ts).
// Breadcrumb labels live in route-breadcrumb.ts (SCO-083) so they survive
// top-tab deletion.
export const TOP_NAV_ITEMS: TopNavItem[] = projectTopNavItems();

/** @deprecated Prefer ROUTE_VIEW_LABELS from route-breadcrumb.ts */
export const TOP_NAV_VIEW_LABELS: Record<string, string> = {
  ...ROUTE_VIEW_LABELS,
  // Historical chrome label for ops under the System dropdown.
  ops: "System",
};

const SYSTEM_VIEWS = new Set<Route["view"]>([
  "ops",
  "broker",
  "harnesses",
  "mesh",
  "mesh-ops",
  "terminal",
  "search",
  "work",
  "follow",
  "settings",
  "voice",
]);

/** True for the chrome/ops surfaces that live under the System dropdown. */
export function isSystemRoute(route: Route): boolean {
  // Agent config lives under the Crew tab, not System.
  if (route.view === "settings" && route.section === "agents") return false;
  return SYSTEM_VIEWS.has(route.view);
}

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
    case "sessions":
      return "sessions";
    case "conversation":
    case "messages":
      return "chat";
    case "ops":
    case "broker":
    case "harnesses":
    case "mesh":
    case "mesh-ops":
    case "terminal":
    case "search":
    case "work":
    case "follow":
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
    case "broker":
    case "work":
      return TOP_NAV_VIEW_LABELS[route.view] ?? route.view;
    default:
      return null;
  }
}
