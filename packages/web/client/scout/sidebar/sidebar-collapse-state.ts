/**
 * Pure sidebar collapse + resize transitions (SCO-084 / SCO-086).
 * Kept free of React so unit tests do not load the hook module.
 */

/** Shared collapsed width for all rails (sidebar, side rail, inspector). */
export const RAIL_COLLAPSED_WIDTH = 48;

/** Slack presentation gives the primary destination rail a calmer 56px measure. */
export const SLACK_SIDEBAR_COLLAPSED_WIDTH = 56;

/**
 * Chevron band geometry, shared so every rail's toggle lands on ONE baseline.
 * The shell positions the sidebar-edge chevron from these; CollapsedRail offsets
 * its own chevron from its top edge by the same amount. Previously the collapsed
 * rail hardcoded 8px against a 44px band, so it sat 2px below its neighbour.
 */
export const RAIL_HEADER_HEIGHT = 44;
export const RAIL_TOGGLE_HEIGHT = 32;
export const RAIL_TOGGLE_HEADER_TOP = Math.round(
  (RAIL_HEADER_HEIGHT - RAIL_TOGGLE_HEIGHT) / 2,
);

/** @deprecated Prefer RAIL_COLLAPSED_WIDTH — same value, shared across rails. */
export const SIDEBAR_COLLAPSED_WIDTH = RAIL_COLLAPSED_WIDTH;

/** Default expanded sidebar width (also the double-click reset target). */
export const SIDEBAR_EXPANDED_WIDTH = 260;
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 360;
// Auto-collapse only when the window is genuinely cramped: expanded sidebar
// (260) + ~600px of usable content. 1023 collapsed on ordinary half-screen
// windows, which read as the shell fighting the operator.
export const SIDEBAR_AUTO_COLLAPSE_MAX_WIDTH = 880;

/**
 * Side rail (context panel) drag-resize band (SCO-088 §3).
 * The side rail gets the same ghost-edge resize as the sidebar, but with its
 * own band: default 260, min 240 (study: side rail min-width 240), max 400.
 * Persisted under the shell's `appshell.<id>.leftW` key; double-click resets to
 * SIDE_RAIL_DEFAULT_WIDTH.
 */
export const SIDE_RAIL_DEFAULT_WIDTH = 260;
export const SIDE_RAIL_MIN_WIDTH = 240;
export const SIDE_RAIL_MAX_WIDTH = 400;

/** Clamp a side-rail width to the SCO-088 min/max band (rounds; NaN → default). */
export function clampSideRailWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDE_RAIL_DEFAULT_WIDTH;
  return Math.max(
    SIDE_RAIL_MIN_WIDTH,
    Math.min(SIDE_RAIL_MAX_WIDTH, Math.round(width)),
  );
}

/**
 * Drag-through-collapse thresholds (SCO-088b §2).
 * - Collapse commits when a live inward drag drops this far below the min width
 *   (sidebar: 200−40=160, side rail: 240−40=200). Hysteresis avoids an instant
 *   flip right at min.
 * - Expand-from-collapsed commits when the collapsed edge is dragged out at least
 *   this many px (a tiny accidental drag snaps back with no state change).
 */
export const RAIL_DRAG_COLLAPSE_MARGIN = 40;
export const RAIL_DRAG_EXPAND_TRAVEL = 24;

/**
 * Live ghost width the dragged edge previews (SCO-088b §2 + addendum). Continuous
 * from the collapsed target (48) up to max — never dead-clamped at min, so an
 * inward drag flows toward collapse and an outward drag from a collapsed rail
 * grows from 48. Once an expanded-rail drag passes the collapse threshold the
 * ghost snaps to the 48px collapsed target as a "release = collapse" affordance.
 */
export function resolveRailDragGhostWidth(
  rawWidth: number,
  {
    min,
    max,
    startedCollapsed,
    collapsedWidth = RAIL_COLLAPSED_WIDTH,
  }: {
    min: number;
    max: number;
    startedCollapsed: boolean;
    collapsedWidth?: number;
  },
): number {
  if (!Number.isFinite(rawWidth)) {
    return startedCollapsed ? collapsedWidth : min;
  }
  const clamped = Math.max(
    collapsedWidth,
    Math.min(max, Math.round(rawWidth)),
  );
  if (startedCollapsed) return clamped;
  const collapseThreshold = min - RAIL_DRAG_COLLAPSE_MARGIN;
  return clamped < collapseThreshold ? RAIL_COLLAPSED_WIDTH : clamped;
}

/** What a rail edge-drag commits on pointer-up (SCO-088b §2). */
export type RailDragCommit =
  | { kind: "collapse" }
  | { kind: "expand" }
  | { kind: "resize"; width: number }
  | { kind: "none" };

/**
 * Decide what a rail drag commits on pointer-up (SCO-088b §2). Uses the RAW live
 * width (not the snapped ghost) so the collapse/resize boundary is exact.
 * - started collapsed → `expand` past the outward-travel threshold, else `none`.
 * - started expanded → `collapse` below `min − margin`, else `resize` clamped to
 *   [min, max] (so between the collapse threshold and min it settles at min).
 */
export function resolveRailDragCommit(
  { startedCollapsed, rawWidth }: { startedCollapsed: boolean; rawWidth: number },
  {
    min,
    max,
    collapsedWidth = RAIL_COLLAPSED_WIDTH,
  }: { min: number; max: number; collapsedWidth?: number },
): RailDragCommit {
  const w = Number.isFinite(rawWidth) ? Math.round(rawWidth) : min;
  if (startedCollapsed) {
    return w >= collapsedWidth + RAIL_DRAG_EXPAND_TRAVEL
      ? { kind: "expand" }
      : { kind: "none" };
  }
  const collapseThreshold = min - RAIL_DRAG_COLLAPSE_MARGIN;
  if (w < collapseThreshold) return { kind: "collapse" };
  return { kind: "resize", width: Math.max(min, Math.min(max, w)) };
}

export type SidebarCollapseSnapshot = {
  manualCollapsed: boolean;
  autoCollapsed: boolean;
  forceExpanded: boolean;
};

/** Pure: effective collapsed state from preferences + viewport-derived flags. */
export function resolveEffectiveCollapsed(
  snapshot: SidebarCollapseSnapshot,
): boolean {
  return snapshot.autoCollapsed
    ? !snapshot.forceExpanded
    : snapshot.manualCollapsed;
}

/** Clamp expanded sidebar width to the SCO-086 min/max band. */
export function clampSidebarExpandedWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_EXPANDED_WIDTH;
  return Math.max(
    SIDEBAR_MIN_WIDTH,
    Math.min(SIDEBAR_MAX_WIDTH, Math.round(width)),
  );
}

/**
 * Resolve layout width from collapse + live/persisted expanded width.
 * Collapsed always uses RAIL_COLLAPSED_WIDTH; expanded uses the clamped value.
 */
export function resolveSidebarWidth(
  effectiveCollapsed: boolean,
  expandedWidth: number = SIDEBAR_EXPANDED_WIDTH,
  collapsedWidth: number = RAIL_COLLAPSED_WIDTH,
): number {
  return effectiveCollapsed
    ? collapsedWidth
    : clampSidebarExpandedWidth(expandedWidth);
}

/**
 * Pure, idempotent setCollapsed transition.
 * Wide viewport → manualCollapsed; auto-collapse viewport → forceExpanded only.
 */
export function applySetCollapsed(
  snapshot: SidebarCollapseSnapshot,
  nextCollapsed: boolean,
): Pick<SidebarCollapseSnapshot, "manualCollapsed" | "forceExpanded"> {
  if (snapshot.autoCollapsed) {
    return {
      manualCollapsed: snapshot.manualCollapsed,
      forceExpanded: !nextCollapsed,
    };
  }
  return {
    manualCollapsed: nextCollapsed,
    forceExpanded: snapshot.forceExpanded,
  };
}

/** Pure toggle of the active preference layer. */
export function applyToggleCollapsed(
  snapshot: SidebarCollapseSnapshot,
): Pick<SidebarCollapseSnapshot, "manualCollapsed" | "forceExpanded"> {
  const effective = resolveEffectiveCollapsed(snapshot);
  return applySetCollapsed(snapshot, !effective);
}
