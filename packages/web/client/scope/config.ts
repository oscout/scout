import {
  SCOPE_FLAG_BUNDLE,
  SCOPE_FLAG_KEY,
  SCOPE_ROUTE_SEGMENTS,
  scopeSegmentPath,
} from "../../shared/scope-integration.js";

export {
  SCOPE_BRAND_LABEL,
  SCOPE_FLAG_BUNDLE,
  SCOPE_FLAG_KEY,
  SCOPE_LEGACY_FLAG_BUNDLE,
  SCOPE_LEGACY_FLAG_KEY,
  SCOPE_LEGACY_PATH_PREFIX,
  SCOPE_LEGACY_PATH_SEGMENT,
  SCOPE_PATH_PREFIX,
  SCOPE_PATH_SEGMENT,
  SCOPE_ROUTE_SEGMENTS,
} from "../../shared/scope-integration.js";

export { SCOPE_LANE_DECK_PROFILE, SCOPE_LANE_DECK_DEFAULTS } from "./lane-deck.ts";

/** Scope opens at /scope/*; the bundle only layers lean nav/ops flags. */
export const SCOPE_ENABLE_HINTS = {
  path: scopeSegmentPath(SCOPE_ROUTE_SEGMENTS.lanes),
  bundle: `?ffBundle=${SCOPE_FLAG_BUNDLE}`,
  deploy: `OPENSCOUT_WEB_FLAG_BUNDLE=${SCOPE_FLAG_BUNDLE}`,
} as const;