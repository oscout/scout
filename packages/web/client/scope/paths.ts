import {
  SCOPE_DEFAULT_SEGMENT,
  SCOPE_LEGACY_PATH_SEGMENT,
  SCOPE_PATH_PREFIX,
  SCOPE_PATH_SEGMENT,
  SCOPE_ROUTE_SEGMENTS,
  canonicalizeScopePathname,
  isScopePathname,
  scopeSegmentPath,
} from "../../shared/scope-integration.js";
import type { Route } from "../lib/types.ts";

export {
  SCOPE_BRAND_LABEL,
  SCOPE_DEFAULT_SEGMENT,
  SCOPE_FLAG_BUNDLE,
  SCOPE_FLAG_KEY,
  SCOPE_LEGACY_FLAG_BUNDLE,
  SCOPE_LEGACY_FLAG_KEY,
  SCOPE_LEGACY_PATH_PREFIX,
  SCOPE_LEGACY_PATH_SEGMENT,
  SCOPE_PATH_PREFIX,
  SCOPE_PATH_SEGMENT,
  SCOPE_ROUTE_SEGMENTS,
  canonicalizeScopePathname,
} from "../../shared/scope-integration.js";

export { SCOPE_LANE_DECK_PROFILE } from "./lane-deck.ts";

export type ScopeRouteSegment = keyof typeof SCOPE_ROUTE_SEGMENTS;

type ScopedRoute<T extends Route> = (route: T) => T;

type ScopeRouteBuildContext = {
  sessionId?: string;
  tailQuery?: string;
};

const SCOPE_SEGMENT_ORDER = [
  SCOPE_ROUTE_SEGMENTS.lanes,
  SCOPE_ROUTE_SEGMENTS.tail,
  SCOPE_ROUTE_SEGMENTS.sessions,
  SCOPE_ROUTE_SEGMENTS.agents,
] as const;

function isScopeRouteSegment(value: string | undefined): value is ScopeRouteSegment {
  return SCOPE_SEGMENT_ORDER.includes(value as ScopeRouteSegment);
}

function isScopeRootSegment(value: string | undefined): boolean {
  return value === SCOPE_PATH_SEGMENT || value === SCOPE_LEGACY_PATH_SEGMENT;
}

export function isScopePath(pathname: string): boolean {
  return isScopePathname(pathname);
}

export function buildScopePath(
  segment: ScopeRouteSegment,
  context: ScopeRouteBuildContext = {},
): string {
  switch (segment) {
    case SCOPE_ROUTE_SEGMENTS.tail: {
      const params = new URLSearchParams();
      if (context.tailQuery) params.set("q", context.tailQuery);
      const suffix = params.toString();
      return scopeSegmentPath(segment, suffix ? `?${suffix}` : "");
    }
    case SCOPE_ROUTE_SEGMENTS.sessions:
      return context.sessionId
        ? scopeSegmentPath(segment, `/${encodeURIComponent(context.sessionId)}`)
        : scopeSegmentPath(segment);
    case SCOPE_ROUTE_SEGMENTS.lanes:
      return scopeSegmentPath(SCOPE_DEFAULT_SEGMENT);
    case SCOPE_ROUTE_SEGMENTS.agents:
      return scopeSegmentPath(segment);
    default:
      return scopeSegmentPath(SCOPE_DEFAULT_SEGMENT);
  }
}

export function routeToScopeSegment(route: Route): ScopeRouteSegment | null {
  switch (route.view) {
    case "ops":
      if (!route.mode || route.mode === "lanes") return SCOPE_ROUTE_SEGMENTS.lanes;
      if (route.mode === "tail") return SCOPE_ROUTE_SEGMENTS.tail;
      return null;
    case "sessions":
      if (route.agentId) return null;
      return SCOPE_ROUTE_SEGMENTS.sessions;
    case "agents-v2":
      if (route.agentId || route.projectSlug || route.sessionId || route.conversationId) {
        return null;
      }
      return SCOPE_ROUTE_SEGMENTS.agents;
    default:
      return null;
  }
}

export function buildScopeRoutePath(route: Route): string | null {
  const segment = routeToScopeSegment(route);
  if (!segment) return null;

  if (segment === SCOPE_ROUTE_SEGMENTS.tail && route.view === "ops") {
    return buildScopePath(segment, { tailQuery: route.tailQuery });
  }
  if (segment === SCOPE_ROUTE_SEGMENTS.sessions && route.view === "sessions") {
    return buildScopePath(segment, { sessionId: route.sessionId });
  }
  return buildScopePath(segment);
}

/** Parse scope URLs into canonical Scout routes. Returns null when not a scope path. */
export function parseScopeRouteFromUrl(
  parts: string[],
  url: URL,
  scoped: ScopedRoute<Route>,
): Route | null {
  if (!isScopeRootSegment(parts[0])) return null;

  const segment = parts[1] ?? SCOPE_DEFAULT_SEGMENT;
  if (!isScopeRouteSegment(segment)) {
    return { view: "ops", mode: "lanes" };
  }

  switch (segment) {
    case SCOPE_ROUTE_SEGMENTS.tail: {
      const tailQuery = url.searchParams.get("q")?.trim();
      return {
        view: "ops",
        mode: "tail",
        ...(tailQuery ? { tailQuery } : {}),
      };
    }
    case SCOPE_ROUTE_SEGMENTS.sessions:
      if (parts[2]) {
        return scoped({ view: "sessions", sessionId: decodeURIComponent(parts[2]) });
      }
      return scoped({ view: "sessions" });
    case SCOPE_ROUTE_SEGMENTS.agents:
      return scoped({ view: "agents-v2" });
    case SCOPE_ROUTE_SEGMENTS.lanes:
    default:
      return { view: "ops", mode: "lanes" };
  }
}

/**
 * Global search keys allowed to follow the user across navigations — named
 * feature-flag and dev-only params only. Everything else is route-local:
 * route serialization (routePath) owns route params, and machineId propagates
 * exclusively through the MACHINE_SCOPED_VIEWS rules in lib/router.ts, never
 * through generic search preservation.
 */
const GLOBAL_STICKY_SEARCH_KEYS = new Set([
  // Ops gate shortcut (maps to the ops.control flag; lib/scout-flags.ts).
  "no-ops",
  // Feature-flag bundles, persistence, and audience (lib/scout-flags.ts).
  "ffBundle",
  "ffVariant",
  "scoutBundle",
  "scoutExperience",
  "ab",
  "ffGlobal",
  "scoutGlobalBundle",
  "ffPersist",
  "persistBundle",
  "ffAudience",
  // Studio dev injection (studio/studio-injection-state.ts).
  "studio",
  "studioInjection",
  "studioMode",
]);

/** Key prefixes that are always global: per-flag overrides and per-study studio params. */
const GLOBAL_STICKY_SEARCH_PREFIXES = ["ff.", "studio.", "studioMode."];

export function isGlobalStickySearchKey(key: string): boolean {
  return GLOBAL_STICKY_SEARCH_KEYS.has(key)
    || GLOBAL_STICKY_SEARCH_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** Carry whitelisted global params (feature flags) when rewriting to a new path. */
export function preserveLocationSearch(path: string, search = ""): string {
  const target = new URL(path, "http://scout.local");
  const current = new URLSearchParams(search);
  current.forEach((value, key) => {
    if (!isGlobalStickySearchKey(key)) return;
    if (!target.searchParams.has(key)) {
      target.searchParams.set(key, value);
    }
  });
  const query = target.searchParams.toString();
  return `${target.pathname}${query ? `?${query}` : ""}`;
}

export function segmentToRoute(segment: ScopeRouteSegment): Route {
  switch (segment) {
    case SCOPE_ROUTE_SEGMENTS.tail:
      return { view: "ops", mode: "tail" };
    case SCOPE_ROUTE_SEGMENTS.sessions:
      return { view: "sessions" };
    case SCOPE_ROUTE_SEGMENTS.agents:
      return { view: "agents-v2" };
    case SCOPE_ROUTE_SEGMENTS.lanes:
    default:
      return { view: "ops", mode: "lanes" };
  }
}
