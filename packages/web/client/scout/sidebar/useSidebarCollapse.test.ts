import { describe, expect, test } from "bun:test";
import {
  RAIL_COLLAPSED_WIDTH,
  RAIL_DRAG_COLLAPSE_MARGIN,
  RAIL_DRAG_EXPAND_TRAVEL,
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
  type SidebarCollapseSnapshot,
} from "./sidebar-collapse-state.ts";

describe("sidebar collapse constants (SCO-083 / SCO-086)", () => {
  test("auto-collapse fires only when genuinely cramped", () => {
    expect(SIDEBAR_AUTO_COLLAPSE_MAX_WIDTH).toBe(880);
    // An ordinary half-screen window (~960-1280) must keep its labels.
    expect(960).toBeGreaterThan(SIDEBAR_AUTO_COLLAPSE_MAX_WIDTH);
    // The expanded sidebar plus ~600px of content still fits at the boundary.
    expect(SIDEBAR_AUTO_COLLAPSE_MAX_WIDTH).toBeGreaterThanOrEqual(SIDEBAR_EXPANDED_WIDTH + 600);
  });

  test("expanded and icon-rail widths match the anatomy", () => {
    expect(SIDEBAR_EXPANDED_WIDTH).toBe(260);
    expect(SIDEBAR_COLLAPSED_WIDTH).toBe(48);
    expect(RAIL_COLLAPSED_WIDTH).toBe(48);
    expect(SIDEBAR_COLLAPSED_WIDTH).toBe(RAIL_COLLAPSED_WIDTH);
  });

  test("resize band is min 200 / max 360 / default 260", () => {
    expect(SIDEBAR_MIN_WIDTH).toBe(200);
    expect(SIDEBAR_MAX_WIDTH).toBe(360);
    expect(SIDEBAR_EXPANDED_WIDTH).toBe(260);
  });
});

describe("sidebar resize pure logic (SCO-086)", () => {
  test("clampSidebarExpandedWidth clamps to min/max and rounds", () => {
    expect(clampSidebarExpandedWidth(100)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarExpandedWidth(500)).toBe(SIDEBAR_MAX_WIDTH);
    expect(clampSidebarExpandedWidth(250.6)).toBe(251);
    expect(clampSidebarExpandedWidth(Number.NaN)).toBe(SIDEBAR_EXPANDED_WIDTH);
  });

  test("resolveSidebarWidth uses expandedWidth when expanded", () => {
    expect(resolveSidebarWidth(true)).toBe(RAIL_COLLAPSED_WIDTH);
    expect(resolveSidebarWidth(false)).toBe(SIDEBAR_EXPANDED_WIDTH);
    expect(resolveSidebarWidth(false, 220)).toBe(220);
    expect(resolveSidebarWidth(false, 180)).toBe(SIDEBAR_MIN_WIDTH);
    expect(resolveSidebarWidth(true, 300)).toBe(RAIL_COLLAPSED_WIDTH);
    expect(
      resolveSidebarWidth(true, 300, SLACK_SIDEBAR_COLLAPSED_WIDTH),
    ).toBe(56);
  });

  test("custom collapsed geometry preserves drag travel", () => {
    const slackRail = {
      min: SIDEBAR_MIN_WIDTH,
      max: SIDEBAR_MAX_WIDTH,
      collapsedWidth: SLACK_SIDEBAR_COLLAPSED_WIDTH,
    };
    expect(
      resolveRailDragGhostWidth(40, {
        ...slackRail,
        startedCollapsed: true,
      }),
    ).toBe(56);
    expect(
      resolveRailDragCommit(
        { startedCollapsed: true, rawWidth: 79 },
        slackRail,
      ),
    ).toEqual({ kind: "none" });
    expect(
      resolveRailDragCommit(
        { startedCollapsed: true, rawWidth: 80 },
        slackRail,
      ),
    ).toEqual({ kind: "expand" });
  });

  test("double-click reset target is SIDEBAR_EXPANDED_WIDTH (260)", () => {
    expect(clampSidebarExpandedWidth(SIDEBAR_EXPANDED_WIDTH)).toBe(260);
  });
});

describe("side-rail resize band (SCO-088 §3)", () => {
  test("band is default 260 / min 240 / max 400", () => {
    expect(SIDE_RAIL_DEFAULT_WIDTH).toBe(260);
    expect(SIDE_RAIL_MIN_WIDTH).toBe(240);
    expect(SIDE_RAIL_MAX_WIDTH).toBe(400);
  });

  test("clampSideRailWidth clamps + rounds; NaN → default", () => {
    expect(clampSideRailWidth(100)).toBe(240);
    expect(clampSideRailWidth(999)).toBe(400);
    expect(clampSideRailWidth(300.6)).toBe(301);
    expect(clampSideRailWidth(Number.NaN)).toBe(260);
  });
});

describe("drag-through-collapse ghost width (SCO-088b §2 + addendum)", () => {
  const sidebar = { min: SIDEBAR_MIN_WIDTH, max: SIDEBAR_MAX_WIDTH };
  const collapseThreshold = SIDEBAR_MIN_WIDTH - RAIL_DRAG_COLLAPSE_MARGIN; // 160

  test("expanded drag: continuous, NOT dead-clamped at min", () => {
    // Above min: tracks the pointer.
    expect(
      resolveRailDragGhostWidth(300, { ...sidebar, startedCollapsed: false }),
    ).toBe(300);
    // Between the collapse threshold and min: flows BELOW min (shows direction),
    // never dead-clamps at min.
    expect(
      resolveRailDragGhostWidth(180, { ...sidebar, startedCollapsed: false }),
    ).toBe(180);
    expect(180).toBeLessThan(SIDEBAR_MIN_WIDTH);
    expect(180).toBeGreaterThanOrEqual(collapseThreshold);
  });

  test("expanded drag past the collapse threshold snaps the ghost to 48", () => {
    expect(
      resolveRailDragGhostWidth(collapseThreshold - 1, {
        ...sidebar,
        startedCollapsed: false,
      }),
    ).toBe(RAIL_COLLAPSED_WIDTH);
    expect(
      resolveRailDragGhostWidth(60, { ...sidebar, startedCollapsed: false }),
    ).toBe(RAIL_COLLAPSED_WIDTH);
  });

  test("collapsed drag: grows continuously from 48, never snaps", () => {
    expect(
      resolveRailDragGhostWidth(48, { ...sidebar, startedCollapsed: true }),
    ).toBe(48);
    expect(
      resolveRailDragGhostWidth(120, { ...sidebar, startedCollapsed: true }),
    ).toBe(120);
    // Clamped to max at the top.
    expect(
      resolveRailDragGhostWidth(999, { ...sidebar, startedCollapsed: true }),
    ).toBe(SIDEBAR_MAX_WIDTH);
  });
});

describe("drag commit decision (SCO-088b §2)", () => {
  const sidebar = { min: SIDEBAR_MIN_WIDTH, max: SIDEBAR_MAX_WIDTH };
  const sideRail = { min: SIDE_RAIL_MIN_WIDTH, max: SIDE_RAIL_MAX_WIDTH };

  test("expanded → collapse below (min − 40)", () => {
    expect(
      resolveRailDragCommit({ startedCollapsed: false, rawWidth: 159 }, sidebar),
    ).toEqual({ kind: "collapse" });
    // Side rail threshold is 240 − 40 = 200.
    expect(
      resolveRailDragCommit({ startedCollapsed: false, rawWidth: 199 }, sideRail),
    ).toEqual({ kind: "collapse" });
  });

  test("expanded → resize clamped to [min,max] between threshold and min, and above", () => {
    // Between threshold (160) and min (200): settles at min.
    expect(
      resolveRailDragCommit({ startedCollapsed: false, rawWidth: 180 }, sidebar),
    ).toEqual({ kind: "resize", width: SIDEBAR_MIN_WIDTH });
    // Normal resize.
    expect(
      resolveRailDragCommit({ startedCollapsed: false, rawWidth: 300 }, sidebar),
    ).toEqual({ kind: "resize", width: 300 });
    // Above max clamps.
    expect(
      resolveRailDragCommit({ startedCollapsed: false, rawWidth: 999 }, sidebar),
    ).toEqual({ kind: "resize", width: SIDEBAR_MAX_WIDTH });
  });

  test("collapsed → expand only past the outward-travel threshold", () => {
    const justUnder = RAIL_COLLAPSED_WIDTH + RAIL_DRAG_EXPAND_TRAVEL - 1;
    const atThreshold = RAIL_COLLAPSED_WIDTH + RAIL_DRAG_EXPAND_TRAVEL;
    expect(
      resolveRailDragCommit({ startedCollapsed: true, rawWidth: justUnder }, sidebar),
    ).toEqual({ kind: "none" });
    expect(
      resolveRailDragCommit({ startedCollapsed: true, rawWidth: atThreshold }, sidebar),
    ).toEqual({ kind: "expand" });
  });
});

describe("sidebar collapse pure transitions (SCO-084)", () => {
  const wide: SidebarCollapseSnapshot = {
    manualCollapsed: false,
    autoCollapsed: false,
    forceExpanded: false,
  };
  const narrow: SidebarCollapseSnapshot = {
    manualCollapsed: false,
    autoCollapsed: true,
    forceExpanded: false,
  };

  test("wide viewport uses manualCollapsed for effective state", () => {
    expect(resolveEffectiveCollapsed(wide)).toBe(false);
    expect(resolveEffectiveCollapsed({ ...wide, manualCollapsed: true })).toBe(true);
    expect(resolveSidebarWidth(true)).toBe(SIDEBAR_COLLAPSED_WIDTH);
    expect(resolveSidebarWidth(false)).toBe(SIDEBAR_EXPANDED_WIDTH);
  });

  test("narrow viewport derives collapse unless forceExpanded", () => {
    expect(resolveEffectiveCollapsed(narrow)).toBe(true);
    expect(resolveEffectiveCollapsed({ ...narrow, forceExpanded: true })).toBe(false);
    // Manual preference does not affect narrow derived collapse.
    expect(
      resolveEffectiveCollapsed({ ...narrow, manualCollapsed: false, forceExpanded: false }),
    ).toBe(true);
  });

  test("setCollapsed on wide viewport updates manual only", () => {
    const collapse = applySetCollapsed(wide, true);
    expect(collapse.manualCollapsed).toBe(true);
    expect(collapse.forceExpanded).toBe(false);

    const expand = applySetCollapsed({ ...wide, manualCollapsed: true }, false);
    expect(expand.manualCollapsed).toBe(false);
    expect(expand.forceExpanded).toBe(false);
  });

  test("setCollapsed on narrow viewport updates forceExpanded only (never manual)", () => {
    const expand = applySetCollapsed(
      { ...narrow, manualCollapsed: true },
      false,
    );
    expect(expand.manualCollapsed).toBe(true); // preserved
    expect(expand.forceExpanded).toBe(true);

    const collapse = applySetCollapsed(
      { ...narrow, manualCollapsed: true, forceExpanded: true },
      true,
    );
    expect(collapse.manualCollapsed).toBe(true); // preserved
    expect(collapse.forceExpanded).toBe(false);
  });

  test("setCollapsed is idempotent for already-desired state", () => {
    const again = applySetCollapsed({ ...wide, manualCollapsed: true }, true);
    expect(again.manualCollapsed).toBe(true);

    const againNarrow = applySetCollapsed(
      { ...narrow, forceExpanded: true },
      false,
    );
    expect(againNarrow.forceExpanded).toBe(true);
  });

  test("toggle uses the active preference layer", () => {
    const wideToggle = applyToggleCollapsed(wide);
    expect(wideToggle.manualCollapsed).toBe(true);
    expect(wideToggle.forceExpanded).toBe(false);

    const narrowToggle = applyToggleCollapsed(narrow);
    expect(narrowToggle.manualCollapsed).toBe(false);
    expect(narrowToggle.forceExpanded).toBe(true);
  });

  test("onOpenChange must not map to setManualCollapsed(!open) on narrow", () => {
    // Regression guard for the Codex correction: if open=true on a narrow
    // viewport, we set forceExpanded, never flip manualCollapsed.
    const open = true;
    const nextCollapsed = !open;
    const next = applySetCollapsed(
      { manualCollapsed: false, autoCollapsed: true, forceExpanded: false },
      nextCollapsed,
    );
    expect(next.manualCollapsed).toBe(false);
    expect(next.forceExpanded).toBe(true);
  });
});
