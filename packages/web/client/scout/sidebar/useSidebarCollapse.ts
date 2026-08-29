/**
 * Sidebar collapse + continuous resize state (SCO-083 / SCO-084 / SCO-086).
 *
 * - Manual preference persists under its own key (separate from legacy left panel).
 * - Auto-collapse below 1024px is derived from viewport and NEVER overwrites the
 *   persisted manual preference.
 * - Manual expand remains available while auto-collapsed (session-only force expand).
 * - setCollapsed is the controlled-provider seam: wide viewport updates
 *   manualCollapsed; auto-collapse viewport updates session-only forceExpanded.
 *   Do NOT wire onOpenChange as setManualCollapsed(!open).
 * - Expanded width persists under `appshell.${appId}.sidebar.width` (SCO-086).
 *   SCO-087: live drag updates only the ghost target (dragGhostWidth); the
 *   committed layout width and all insets stay pinned until pointer-up, so the
 *   center pane reflows at most once per resize instead of every pointer-move.
 */
import { useCallback, useEffect, useState } from "react";
import { usePersistentState } from "@hudsonkit";
import {
  RAIL_COLLAPSED_WIDTH,
  SIDEBAR_AUTO_COLLAPSE_MAX_WIDTH,
  SIDEBAR_COLLAPSED_WIDTH,
  SIDEBAR_EXPANDED_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  applySetCollapsed,
  applyToggleCollapsed,
  clampSidebarExpandedWidth,
  resolveEffectiveCollapsed,
  resolveRailDragCommit,
  resolveRailDragGhostWidth,
  resolveSidebarWidth,
  type RailDragCommit,
  type SidebarCollapseSnapshot,
} from "./sidebar-collapse-state.ts";

export {
  RAIL_COLLAPSED_WIDTH,
  RAIL_DRAG_COLLAPSE_MARGIN,
  RAIL_DRAG_EXPAND_TRAVEL,
  RAIL_BAND_INSET,
  RAIL_HEADER_HEIGHT,
  RAIL_SLOT_CELL,
  RAIL_SLOT_GAP,
  RAIL_SLOT_ROW,
  RAIL_SLOT_TOP,
  RAIL_TOGGLE_HEADER_TOP,
  RAIL_TOGGLE_HEIGHT,
  RAIL_TOGGLE_WIDTH,
  SIDEBAR_AUTO_COLLAPSE_MAX_WIDTH,
  SIDEBAR_COLLAPSED_WIDTH,
  SIDEBAR_EXPANDED_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SLACK_SIDEBAR_COLLAPSED_WIDTH,
  SIDE_RAIL_DEFAULT_WIDTH,
  SIDE_RAIL_MAX_WIDTH,
  SIDE_RAIL_MIN_WIDTH,
  applySetCollapsed,
  applyToggleCollapsed,
  clampSideRailWidth,
  clampSidebarExpandedWidth,
  resolveEffectiveCollapsed,
  resolveRailDragCommit,
  resolveRailDragGhostWidth,
  resolveSidebarWidth,
  railToggleOffset,
  type RailDragCommit,
  type SidebarCollapseSnapshot,
} from "./sidebar-collapse-state.ts";

export function useSidebarCollapse(
  appId: string,
  viewportWidth: number,
  collapsedWidth: number = RAIL_COLLAPSED_WIDTH,
) {
  const storageKey = `appshell.${appId}.sidebar.manualCollapsed`;
  const widthKey = `appshell.${appId}.sidebar.width`;
  // Default presentation is the 48px icon rail (SCO-084 Req 7 revised).
  // Expanded width is available via trigger / ⌘B, not the default.
  const [manualCollapsed, setManualCollapsed] = usePersistentState(storageKey, true);
  const [persistedExpandedWidth, setPersistedExpandedWidth] = usePersistentState(
    widthKey,
    SIDEBAR_EXPANDED_WIDTH,
  );
  const autoCollapsed = viewportWidth <= SIDEBAR_AUTO_COLLAPSE_MAX_WIDTH;
  const [forceExpanded, setForceExpanded] = useState(false);
  /** RAW live width during drag (unclamped); null when not resizing. */
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  /** Whether the active drag started from the collapsed (icon-rail) state. */
  const [dragStartedCollapsed, setDragStartedCollapsed] = useState(false);
  const [isSidebarResizing, setIsSidebarResizing] = useState(false);

  useEffect(() => {
    if (!autoCollapsed) {
      setForceExpanded(false);
    }
  }, [autoCollapsed]);

  const snapshot: SidebarCollapseSnapshot = {
    manualCollapsed,
    autoCollapsed,
    forceExpanded,
  };
  const effectiveCollapsed = resolveEffectiveCollapsed(snapshot);
  // SCO-087: layout width IGNORES the live drag value. During a drag-resize the
  // sidebar and every inset derived from it stay pinned to the committed width,
  // so the heavy center pane never relayouts per pointer-move. `dragGhostWidth`
  // is the live target used only to paint a ghost edge; the real width commits
  // once on pointer-up (endResize).
  const expandedWidth = clampSidebarExpandedWidth(persistedExpandedWidth);
  // SCO-088b: the ghost previews continuously from the 48px collapsed target up to
  // max (drag-through-collapse), not just the [min,max] resize band.
  const dragGhostWidth =
    dragWidth != null
      ? resolveRailDragGhostWidth(dragWidth, {
          min: SIDEBAR_MIN_WIDTH,
          max: SIDEBAR_MAX_WIDTH,
          startedCollapsed: dragStartedCollapsed,
          collapsedWidth,
        })
      : null;
  const width = resolveSidebarWidth(
    effectiveCollapsed,
    expandedWidth,
    collapsedWidth,
  );

  const toggleCollapsed = useCallback(() => {
    const next = applyToggleCollapsed({
      manualCollapsed,
      autoCollapsed,
      forceExpanded,
    });
    if (autoCollapsed) {
      setForceExpanded(next.forceExpanded);
      return;
    }
    setManualCollapsed(next.manualCollapsed);
  }, [autoCollapsed, forceExpanded, manualCollapsed, setManualCollapsed]);

  /**
   * Controlled SidebarProvider seam.
   * Idempotent: setting the same collapsed state is a no-op on the active layer.
   */
  const setCollapsed = useCallback(
    (nextCollapsed: boolean) => {
      const next = applySetCollapsed(
        { manualCollapsed, autoCollapsed, forceExpanded },
        nextCollapsed,
      );
      if (autoCollapsed) {
        setForceExpanded((current) =>
          current === next.forceExpanded ? current : next.forceExpanded,
        );
        return;
      }
      setManualCollapsed((current) =>
        current === next.manualCollapsed ? current : next.manualCollapsed,
      );
    },
    [autoCollapsed, forceExpanded, manualCollapsed, setManualCollapsed],
  );

  const setExpandedWidth = useCallback(
    (next: number) => {
      setPersistedExpandedWidth(clampSidebarExpandedWidth(next));
    },
    [setPersistedExpandedWidth],
  );

  const resetExpandedWidth = useCallback(() => {
    setPersistedExpandedWidth(SIDEBAR_EXPANDED_WIDTH);
    setDragWidth(null);
  }, [setPersistedExpandedWidth]);

  /**
   * Start a live drag session (SCO-088b). `startWidth` is the RAW width at grab
   * (48 when collapsed, the expanded width otherwise); `startedCollapsed` selects
   * the expand-from-collapsed vs. resize/collapse gesture.
   */
  const beginResize = useCallback(
    (startWidth: number, startedCollapsed = false) => {
      setIsSidebarResizing(true);
      setDragStartedCollapsed(startedCollapsed);
      setDragWidth(startWidth);
    },
    [],
  );

  /** Update the RAW live width during drag (no storage write, no clamp). */
  const updateResize = useCallback((nextWidth: number) => {
    setDragWidth(nextWidth);
  }, []);

  /** Clear the drag session without committing (used by cancel paths). */
  const clearDrag = useCallback(() => {
    setDragWidth(null);
    setIsSidebarResizing(false);
  }, []);

  /**
   * Commit a drag on pointer-up (SCO-088b). Routes through the SAME state
   * machinery as the chevron (setCollapsed / applySetCollapsed, incl. the
   * auto-collapse layer) and never overwrites the persisted expanded width on
   * collapse/expand, so the remembered width is restored on re-expand. Returns
   * the resolved commit so callers can place a settle ghost at the target edge.
   */
  const commitDrag = useCallback(
    (rawWidth: number, startedCollapsed: boolean): RailDragCommit => {
      const commit = resolveRailDragCommit(
        { startedCollapsed, rawWidth },
        { min: SIDEBAR_MIN_WIDTH, max: SIDEBAR_MAX_WIDTH, collapsedWidth },
      );
      if (commit.kind === "collapse") setCollapsed(true);
      else if (commit.kind === "expand") setCollapsed(false);
      else if (commit.kind === "resize") setPersistedExpandedWidth(commit.width);
      setDragWidth(null);
      setIsSidebarResizing(false);
      return commit;
    },
    [collapsedWidth, setCollapsed, setPersistedExpandedWidth],
  );

  return {
    manualCollapsed,
    autoCollapsed,
    forceExpanded,
    effectiveCollapsed,
    /** Live layout width (collapsed rail or expanded). */
    width,
    /** Committed expanded width (never the collapsed rail width; stable during drag). */
    expandedWidth,
    /** Live drag target for the ghost edge; null when not resizing (SCO-087). */
    dragGhostWidth,
    /** Whether the active drag began collapsed (SCO-088b expand-from-collapsed). */
    dragStartedCollapsed,
    isSidebarResizing,
    toggleCollapsed,
    setCollapsed,
    setManualCollapsed,
    setExpandedWidth,
    resetExpandedWidth,
    beginResize,
    updateResize,
    clearDrag,
    commitDrag,
  };
}
