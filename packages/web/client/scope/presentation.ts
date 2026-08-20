import type { Route } from "../lib/types.ts";
import { SCOPE_LANE_DECK_PROFILE } from "./lane-deck.ts";
import {
  buildScopeRoutePath,
  isScopePath,
  routeToScopeSegment,
  type ScopeRouteSegment,
} from "./paths.ts";

export { isScopePath, buildScopeRoutePath } from "./paths.ts";

/** True only on /scope/* (or legacy /scout/* before canonicalization). */
export function isScopePresentation(
  pathname = typeof window !== "undefined" ? window.location.pathname : "",
): boolean {
  return isScopePath(pathname);
}

export function scopeLaneDeckProfileId(): typeof SCOPE_LANE_DECK_PROFILE {
  return SCOPE_LANE_DECK_PROFILE;
}

export function scopePresentationAttrs(active = isScopePresentation()): Record<string, boolean> | undefined {
  return active ? { "data-scope-presentation": true } : undefined;
}

/** Scope URL shape when the browser is on /scope/*; null → Scout paths unchanged. */
export function scopeRoutePath(
  route: Route,
  pathname = typeof window !== "undefined" ? window.location.pathname : "",
): string | null {
  if (!isScopePath(pathname)) return null;
  return buildScopeRoutePath(route);
}

/** True when this route maps to a scope segment and should stay under /scope/*. */
export function routeBelongsInScopeNamespace(
  route: Route,
  pathname = typeof window !== "undefined" ? window.location.pathname : "",
): boolean {
  return scopeRoutePath(route, pathname) !== null;
}

/** Scope segment id for the active route, when it lives in the scope namespace. */
export function scopeViewSegment(
  route: Route,
  pathname = typeof window !== "undefined" ? window.location.pathname : "",
): ScopeRouteSegment | null {
  return routeBelongsInScopeNamespace(route, pathname) ? routeToScopeSegment(route) : null;
}
