/**
 * Scope — shared constants for client + server.
 * Scope is a namespaced product surface on Scout infra (/scope/*).
 * Client and server code should import from here; do not duplicate these strings.
 */

export const SCOPE_PATH_PREFIX = "/scope";

/** Legacy URL prefix from an earlier rebrand; canonicalizes to /scope. */
export const SCOPE_LEGACY_PATH_PREFIX = "/scout";

/** First URL path segment (no leading slash). */
export const SCOPE_PATH_SEGMENT = "scope";

/** Legacy first path segment accepted for existing links. */
export const SCOPE_LEGACY_PATH_SEGMENT = "scout";

export const SCOPE_FLAG_KEY = "surface.scope";

/** Legacy flag key from an earlier rebrand. */
export const SCOPE_LEGACY_FLAG_KEY = "surface.scout";

export const SCOPE_FLAG_BUNDLE = "scope-instrument";

/** Legacy bundle id accepted as an alias. */
export const SCOPE_LEGACY_FLAG_BUNDLE = "scout-instrument";

export const SCOPE_LANE_DECK_PROFILE = "scope.lanes";

export const SCOPE_BRAND_LABEL = "Scope";

/** Scope URL segments under SCOPE_PATH_PREFIX. */
export const SCOPE_ROUTE_SEGMENTS = {
  lanes: "lanes",
  tail: "tail",
  sessions: "sessions",
  agents: "agents",
};

export const SCOPE_DEFAULT_SEGMENT = SCOPE_ROUTE_SEGMENTS.lanes;

/** sessionStorage / localStorage prefix for Scope state */
export const SCOPE_STORAGE_PREFIX = "scope:";

export function scopeStorageKey(suffix) {
  return `${SCOPE_STORAGE_PREFIX}${suffix}`;
}

export const SCOPE_FLAG_BUNDLE_ALIASES = {
  scope: SCOPE_FLAG_BUNDLE,
  scout: SCOPE_FLAG_BUNDLE,
  instrument: SCOPE_FLAG_BUNDLE,
  [SCOPE_FLAG_BUNDLE]: SCOPE_FLAG_BUNDLE,
  [SCOPE_LEGACY_FLAG_BUNDLE]: SCOPE_FLAG_BUNDLE,
};

export function scopeSegmentPath(segment, suffix = "") {
  const base = segment === SCOPE_DEFAULT_SEGMENT
    ? SCOPE_PATH_PREFIX
    : `${SCOPE_PATH_PREFIX}/${segment}`;
  return suffix ? `${base}${suffix}` : base;
}

export function isScopePathname(pathname) {
  const normalized = String(pathname).replace(/\/+$/u, "") || "/";
  return normalized === SCOPE_PATH_PREFIX
    || normalized.startsWith(`${SCOPE_PATH_PREFIX}/`)
    || normalized === SCOPE_LEGACY_PATH_PREFIX
    || normalized.startsWith(`${SCOPE_LEGACY_PATH_PREFIX}/`);
}

/** Rewrite legacy /scout/* URLs to canonical /scope/*. */
export function canonicalizeScopePathname(pathname) {
  const normalized = String(pathname).replace(/\/+$/u, "") || "/";
  if (normalized === SCOPE_LEGACY_PATH_PREFIX) {
    return SCOPE_PATH_PREFIX;
  }
  if (normalized.startsWith(`${SCOPE_LEGACY_PATH_PREFIX}/`)) {
    return `${SCOPE_PATH_PREFIX}${normalized.slice(SCOPE_LEGACY_PATH_PREFIX.length)}`;
  }
  return normalized;
}