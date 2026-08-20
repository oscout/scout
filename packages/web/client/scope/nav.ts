import type { Route } from "../lib/types.ts";
import { SCOPE_BRAND_LABEL, SCOPE_ROUTE_SEGMENTS } from "../../shared/scope-integration.js";
import type { NavCenterItem } from "../scout/nav-center.tsx";
import { routeToScopeSegment, segmentToRoute, type ScopeRouteSegment } from "./paths.ts";

// Scope keeps its own tab keys — the scout TopNavKey slimmed to the
// single-personality nav and no longer covers the scope sections.
export type ScopeTopNavKey = "lanes" | "sessions" | "tail" | "agents";

const SCOPE_NAV_REGISTRY: ReadonlyArray<{
  key: ScopeTopNavKey;
  label: string;
  segment: ScopeRouteSegment;
}> = [
  { key: "lanes", label: "Agent Lanes", segment: SCOPE_ROUTE_SEGMENTS.lanes },
  { key: "sessions", label: "Sessions", segment: SCOPE_ROUTE_SEGMENTS.sessions },
  { key: "tail", label: "Live Activity", segment: SCOPE_ROUTE_SEGMENTS.tail },
  { key: "agents", label: "Agents", segment: SCOPE_ROUTE_SEGMENTS.agents },
];

export const SCOPE_TOP_NAV_ITEMS: NavCenterItem<ScopeTopNavKey>[] = SCOPE_NAV_REGISTRY.map((entry) => ({
  key: entry.key,
  label: entry.label,
  route: segmentToRoute(entry.segment),
}));

export function scopeTopNavKeyForRoute(route: Route): ScopeTopNavKey {
  const segment = routeToScopeSegment(route);
  return SCOPE_NAV_REGISTRY.find((entry) => entry.segment === segment)?.key ?? "lanes";
}

/** Active Scope section label derived from the route→segment mapping. */
export function scopePresentationTitle(route: Route): string {
  const segment = routeToScopeSegment(route);
  return SCOPE_NAV_REGISTRY.find((entry) => entry.segment === segment)?.label ?? SCOPE_BRAND_LABEL;
}
