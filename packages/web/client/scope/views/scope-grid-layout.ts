import {
  AGENT_LANE_WIDTH_TIERS,
  snapLaneWidthPx,
  type AgentLaneWidthTier,
} from "../../screens/ops/lane-deck.ts";

export const GRID_GAP_PX = 12;
export const GRID_CELL_MIN = 360;
export const GRID_TRACK_COUNT = 4;
const GRID_CELL_MAX = 720;
const GRID_TARGET_CELL = 480;

export function gridTargetCellForWidthTier(tier: AgentLaneWidthTier): number {
  return AGENT_LANE_WIDTH_TIERS[tier];
}

/** Quarter / half / full row spans on the fixed grid track count. */
export function gridSpanForWidthTier(tier: AgentLaneWidthTier): number {
  switch (tier) {
    case "sm":
      return 1;
    case "md":
      return 2;
    case "lg":
      return GRID_TRACK_COUNT;
  }
}

export function resolveWidthTier(
  width: AgentLaneWidthTier | number | undefined,
  fallback: AgentLaneWidthTier,
): AgentLaneWidthTier {
  if (width === "sm" || width === "md" || width === "lg") return width;
  if (typeof width === "number" && Number.isFinite(width)) {
    const { tier, px } = snapLaneWidthPx(width);
    if (tier) return tier;
    let closest: AgentLaneWidthTier = fallback;
    let minDistance = Number.POSITIVE_INFINITY;
    for (const [candidate, value] of Object.entries(AGENT_LANE_WIDTH_TIERS) as Array<[AgentLaneWidthTier, number]>) {
      const distance = Math.abs(value - px);
      if (distance < minDistance) {
        minDistance = distance;
        closest = candidate;
      }
    }
    return closest;
  }
  return fallback;
}

export function gridSpanForWidth(
  width: AgentLaneWidthTier | number | undefined,
  fallback: AgentLaneWidthTier,
): number {
  return gridSpanForWidthTier(resolveWidthTier(width, fallback));
}

export function maxGridSpanForWidths(
  widths: Array<AgentLaneWidthTier | number | undefined>,
  fallback: AgentLaneWidthTier,
): number {
  if (!widths.length) return gridSpanForWidthTier(fallback);
  return Math.max(...widths.map((width) => gridSpanForWidth(width, fallback)));
}

export type ScopeGridLayout = {
  columnCount: number;
  cellWidth: number;
};

/** Pick column count from target width, then divide remaining space evenly. */
export function fitGridLayout(containerWidth: number, laneCount: number, targetCell = GRID_TARGET_CELL): ScopeGridLayout {
  if (!containerWidth || laneCount <= 0) {
    return { columnCount: 1, cellWidth: GRID_CELL_MIN };
  }

  let columnCount = Math.max(
    1,
    Math.floor((containerWidth + GRID_GAP_PX) / (targetCell + GRID_GAP_PX)),
  );
  columnCount = Math.min(columnCount, laneCount);

  const cellWidth = Math.min(
    GRID_CELL_MAX,
    Math.max(
      GRID_CELL_MIN,
      Math.floor((containerWidth - GRID_GAP_PX * Math.max(0, columnCount - 1)) / columnCount),
    ),
  );

  return { columnCount, cellWidth };
}

export function applyGridLayoutToContainer(container: HTMLElement, layout: ScopeGridLayout) {
  container.style.setProperty("--scope-grid-cell", `${layout.cellWidth}px`);
  container.dataset.gridCols = String(layout.columnCount);
}