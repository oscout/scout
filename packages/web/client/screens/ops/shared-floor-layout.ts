import { buildLaneSessionStats } from "./agent-lane-detail.ts";
import type { AgentLane } from "./agent-lanes-model.ts";
import { unprojectFloorPoint, type MapProjection } from "./shared-floor-camera.ts";

/** Screen-space press distance before a press becomes a drag (matches actor drag). */
export const FLOOR_DRAG_THRESHOLD_PX = 5;

/** True once a pointer has moved far enough to count as a drag. */
export function floorDragMoved(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) >= FLOOR_DRAG_THRESHOLD_PX;
}

/** World-space island position for a drag gesture: the screen delta scales back
   into world units, unprojects for Iso, and clamps inside the world margin. */
export function islandDragPosition(start: { x: number; y: number }, screenDx: number, screenDy: number, scale: number, projection: MapProjection): { x: number; y: number } {
  const delta = unprojectFloorPoint(screenDx / scale, screenDy / scale, projection);
  return {
    x: Math.max(WORLD_MARGIN, Math.round(start.x + delta.x)),
    y: Math.max(WORLD_MARGIN, Math.round(start.y + delta.y)),
  };
}

export type SharedFloorLayoutMemory = { groups: { key: string; laneIds: string[]; height: number }[] };
export type SharedFloorLayoutGroup = {
  key: string; cwd: string; lanes: AgentLane[];
  x: number; y: number; width: number; height: number;
  actors: { lane: AgentLane; x: number; y: number; centerX: number; centerY: number }[];
};

// The group box *is* the painted island panel: one 647×809 outpost from
// world-outposts-v1.png, drawn edge to edge (shared-work-floor.css,
// `.shared-floor__outpost`). Everything else is expressed as a fraction of that
// panel so the crew keeps standing on the painted surface at any island size.
const ISLAND_WIDTH = 715;
const ISLAND_HEIGHT = Math.round(ISLAND_WIDTH * 809 / 647);
const ISLAND_ASPECT = 647 / 809;

// layout: the walkable deck, measured on all three painted panels — the flat lit
// surface they share, inset from the back wall of huts/domes and from the front
// rim of rocks. Crew feet must land inside this rectangle.
const DECK_LEFT = .22;
const DECK_RIGHT = .78;
const DECK_BACK = .36;
const DECK_FRONT = .58;
// The deck narrows toward its back edge in every panel; pull back rows in a little.
const DECK_BACK_INSET = .16;

// layout: caption tether and caption, as fractions of the panel height
// (`.shared-floor__label-anchor`, `.shared-floor__gathering-label`).
const CAPTION_TOP = .981;
const CAPTION_HEIGHT = 64;

// Sprite metrics (`.shared-floor__wanderer`): the actor box is 84×94 and the
// glass footing it stands on is centred 84px below the box top.
const ACTOR_WIDTH = 84;
const ACTOR_FEET = 84;
const COLUMN_PITCH = 132;
const ROW_PITCH = 95;
// Front rows read as nearer: spread the crew over most of the deck's depth.
const DEPTH_FROM = .12;
const DEPTH_TO = .85;
const SOLO_DEPTH = .5;
const ROW_JITTER = [6, -5, 3, -3, 5];

const GROUP_GAP = 205; // open space between neighbouring islands
const ROW_GAP = 60;
export const WORLD_MARGIN = 30;

/** The deck is wider than it is deep; crew grids follow that aspect. */
const DECK_ASPECT = ((DECK_RIGHT - DECK_LEFT) * ISLAND_WIDTH) / ((DECK_FRONT - DECK_BACK) * ISLAND_HEIGHT);

/** Columns and rows follow the deck's aspect instead of fixed breakpoints. */
function crewGrid(count: number): { columns: number; rows: number } {
  const columns = Math.max(1, Math.min(count, Math.floor(Math.sqrt(count * DECK_ASPECT))));
  return { columns, rows: Math.max(1, Math.ceil(Math.max(count, 1) / columns)) };
}

/** Shelves the naive width-fill walk would open; the balanced pass then repartitions into the same count. */
function greedyShelfCount(widths: readonly number[], rowLimit: number): number {
  let count = 0;
  let x = WORLD_MARGIN;
  for (const width of widths) {
    if (x > WORLD_MARGIN && x + width > rowLimit) { count++; x = WORLD_MARGIN; }
    x += width + GROUP_GAP;
  }
  return widths.length ? count + 1 : 0;
}

/** Contiguous partition into `rowCount` shelves minimizing the widest shelf,
   as the island indices where each new shelf starts. Ties fill later shelves
   (later break wins), which reads as "fill the top rows first". */
function balancedShelfBreaks(widths: readonly number[], rowCount: number): number[] {
  const n = widths.length;
  const k = Math.min(rowCount, n);
  if (k <= 1) return [];
  const rowWidth = (from: number, to: number) => {
    let width = 0;
    for (let i = from; i < to; i++) width += widths[i]! + (i > from ? GROUP_GAP : 0);
    return width;
  };
  // dp[i][r] = widest shelf in the best partition of the first i islands into r shelves.
  const dp = Array.from({ length: n + 1 }, () => Array<number>(k + 1).fill(Infinity));
  const cut = Array.from({ length: n + 1 }, () => Array<number>(k + 1).fill(0));
  dp[0]![0] = 0;
  for (let i = 1; i <= n; i++) {
    for (let r = 1; r <= Math.min(i, k); r++) {
      for (let j = i - 1; j >= r - 1; j--) {
        const width = Math.max(dp[j]![r - 1]!, rowWidth(j, i));
        if (width < dp[i]![r]!) { dp[i]![r] = width; cut[i]![r] = j; }
      }
    }
  }
  const breaks: number[] = [];
  let i = n;
  for (let r = k; r > 1; r--) { i = cut[i]![r]!; breaks.unshift(i); }
  return breaks;
}

/** The smallest island whose deck holds this crew at full pitch. */
function islandHeightFor(count: number): number {
  const { columns, rows } = crewGrid(count);
  const deckWidth = (DECK_RIGHT - DECK_LEFT) * ISLAND_WIDTH;
  const deckDepth = (DECK_FRONT - DECK_BACK) * ISLAND_HEIGHT;
  const scale = Math.max(1, columns * COLUMN_PITCH / deckWidth, rows * ROW_PITCH / deckDepth);
  return Math.round(ISLAND_HEIGHT * scale);
}

/** Actor box positions, group-local, with every pair of feet on the painted deck. */
function deckSlots(count: number, width: number, height: number): { x: number; y: number }[] {
  const { columns, rows } = crewGrid(count);
  const deckLeft = DECK_LEFT * width;
  const deckWidth = (DECK_RIGHT - DECK_LEFT) * width;
  const deckBack = DECK_BACK * height;
  const deckDepth = (DECK_FRONT - DECK_BACK) * height;
  return Array.from({ length: count }, (_, slot) => {
    const row = Math.floor(slot / columns);
    const column = slot % columns;
    const inRow = Math.min(columns, count - row * columns);
    const depth = rows === 1 ? SOLO_DEPTH : DEPTH_FROM + (DEPTH_TO - DEPTH_FROM) * (row / (rows - 1));
    const inset = (1 - depth) * DECK_BACK_INSET * deckWidth;
    const usable = deckWidth - inset * 2 - ACTOR_WIDTH;
    // A short last row stays centred under the rows above it, and short rows
    // alternate a sideways half-phase within their slack so the crew reads
    // spread across the deck, not pinned to a grid. The row-phase jitter does
    // the same for full rows, whose span leaves no slack to shift into.
    const span = columns > 1 ? usable * (inRow - 1) / (columns - 1) : 0;
    const step = inRow > 1 ? span / (inRow - 1) : 0;
    const slack = Math.max(0, usable - span);
    const stagger = inRow > 1 ? (row % 2 === 1 ? 1 : -1) * Math.min(slack / 2, step / 4) : 0;
    return {
      x: Math.round(deckLeft + inset + (usable - span) / 2 + stagger + column * step),
      y: Math.round(deckBack + depth * deckDepth - ACTOR_FEET + ROW_JITTER[(column + row) % ROW_JITTER.length]!),
    };
  });
}

function workspacePath(lane: AgentLane): string {
  const cwd = (lane.facts?.cwd || buildLaneSessionStats(lane).cwd || "").trim();
  if (!cwd.startsWith("/")) return "";
  const parts: string[] = [];
  for (const part of cwd.split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return `/${parts.join("/")}`;
}

export type SharedFloorIslandPositions = Record<string, { x: number; y: number }>;

export type SharedFloorLayoutOptions = {
  /**
   * Operator-placed islands, keyed by group key. A manual island sits exactly
   * where placed and drops out of the shelf pack; overlaps are allowed — the
   * auto-arrange action clears this map and repacks everything.
   */
  positions?: SharedFloorIslandPositions;
  /** Aspect (width / height) the shelf pack should fill, usually the viewport's. */
  targetAspect?: number;
};

/** Keep returned memory between calls. Vacancies and high-water island sizes are intentional.
 * Actor coordinates are group-local; center coordinates are world-space for relationship lines.
 * A growing island may push later rows downward, but disappearance/reordering never compacts them.
 * Placement: groups named in options.positions sit exactly there; the rest shelf-pack in
 * stable memory order, filling rows toward options.targetAspect instead of a fixed two per row.
 */
export function buildSharedFloorLayout(lanes: readonly AgentLane[], previous?: SharedFloorLayoutMemory, options?: SharedFloorLayoutOptions): {
  memory: SharedFloorLayoutMemory; groups: SharedFloorLayoutGroup[]; worldWidth: number; worldHeight: number;
} {
  const current = new Map<string, { cwd: string; lanes: Map<string, AgentLane> }>();
  for (const lane of lanes) {
    const cwd = workspacePath(lane);
    const key = JSON.stringify(cwd ? ["workspace", cwd] : ["lane", lane.id]);
    const group = current.get(key) ?? { cwd, lanes: new Map<string, AgentLane>() };
    group.lanes.set(lane.id, lane);
    current.set(key, group);
  }
  const memory: SharedFloorLayoutMemory = { groups: previous?.groups.map((group) => ({ ...group, laneIds: [...group.laneIds] })) ?? [] };
  for (const [key, group] of current) {
    let remembered = memory.groups.find((entry) => entry.key === key);
    if (!remembered) {
      remembered = { key, laneIds: [], height: ISLAND_HEIGHT };
      memory.groups.push(remembered);
    }
    for (const id of group.lanes.keys()) if (!remembered.laneIds.includes(id)) remembered.laneIds.push(id);
    remembered.height = Math.max(remembered.height, islandHeightFor(remembered.laneIds.length));
  }
  // Placement: manual islands sit where the operator dropped them; the rest
  // shelf-pack in stable memory order toward the viewport aspect. Departed
  // groups keep their slots in both paths, so a returning workspace lands on
  // its old spot and never compacts the rest of the world. Packed islands
  // never overlap a manual one: a blocked shelf cell is skipped rightward, and
  // an island that cannot round its blocker within the row breaks to a fresh
  // shelf below it. Manual-on-manual overlap stays the operator's choice and
  // is not resolved.
  const manual = options?.positions ?? {};
  const aspect = options?.targetAspect && Number.isFinite(options.targetAspect) && options.targetAspect > 0 ? options.targetAspect : 1.5;
  const widthOf = (entry: SharedFloorLayoutMemory["groups"][number]) => Math.round(entry.height * ISLAND_ASPECT);
  const occupiedHeight = (height: number) => Math.round(height * CAPTION_TOP) + CAPTION_HEIGHT;
  const placement = new Map<string, { x: number; y: number }>();
  const obstacles: { x: number; y: number; right: number; bottom: number }[] = [];
  const packed = memory.groups.filter((entry) => {
    const point = manual[entry.key];
    if (!point) return true;
    const x = Math.round(point.x);
    const y = Math.round(point.y);
    placement.set(entry.key, { x, y });
    obstacles.push({ x, y, right: x + widthOf(entry), bottom: y + occupiedHeight(entry.height) });
    return false;
  });
  obstacles.sort((a, b) => a.x - b.x || a.y - b.y);
  const hits = (x: number, y: number, width: number, height: number) => {
    const bottom = y + occupiedHeight(height);
    return obstacles.find((obstacle) => x < obstacle.right && obstacle.x < x + width && y < obstacle.bottom && obstacle.y < bottom);
  };
  const widest = Math.max(ISLAND_WIDTH, ...packed.map(widthOf));
  const area = packed.reduce((sum, entry) => sum + (widthOf(entry) + GROUP_GAP) * (occupiedHeight(entry.height) + ROW_GAP), 0);
  const shelfTarget = Math.max(widest + GROUP_GAP, Math.sqrt(area * aspect));
  const rowLimit = WORLD_MARGIN + shelfTarget;
  // Shelves are planned as a balanced partition (no ragged last row), then each
  // shelf centres itself under the widest one.
  const packedWidths = packed.map(widthOf);
  const breaks = new Set(balancedShelfBreaks(packedWidths, greedyShelfCount(packedWidths, rowLimit)));
  const shelves: number[][] = [];
  for (let i = 0; i < packed.length; i++) {
    if (breaks.has(i) || shelves.length === 0) shelves.push([]);
    shelves[shelves.length - 1]!.push(i);
  }
  const plannedWidths = shelves.map((shelf) => shelf.reduce((width, i) => width + widthOf(packed[i]!) + GROUP_GAP, -GROUP_GAP));
  const widestShelf = Math.max(0, ...plannedWidths);
  let shelf = 0;
  let shelfStartX = WORLD_MARGIN + Math.round(Math.max(0, widestShelf - (plannedWidths[0] ?? 0)) / 2);
  let shelfX = shelfStartX;
  let shelfHeight = 0;
  let cursor = WORLD_MARGIN;
  for (let i = 0; i < packed.length; i++) {
    const entry = packed[i]!;
    const width = widthOf(entry);
    if (breaks.has(i)) {
      shelf++;
      cursor += shelfHeight + ROW_GAP;
      shelfStartX = WORLD_MARGIN + Math.round(Math.max(0, widestShelf - plannedWidths[shelf]!) / 2);
      shelfX = shelfStartX;
      shelfHeight = 0;
    } else if (shelfX > shelfStartX && shelfX + width > rowLimit) {
      // Safety valve: obstacle skips overran the planned shelf — close it early.
      cursor += shelfHeight + ROW_GAP;
      shelfX = shelfStartX;
      shelfHeight = 0;
    }
    // Push right past any manual island blocking this cell; if the blocker is
    // too wide to round, drop to a fresh shelf below it. Each break strictly
    // lowers the cursor past one obstacle, so this always terminates.
    for (let hit = hits(shelfX, cursor, width, entry.height); hit; hit = hits(shelfX, cursor, width, entry.height)) {
      if (hit.right + GROUP_GAP + width <= rowLimit) {
        shelfX = hit.right + GROUP_GAP;
      } else {
        cursor = Math.max(cursor + shelfHeight + ROW_GAP, hit.bottom + ROW_GAP);
        shelfX = shelfStartX;
        shelfHeight = 0;
      }
    }
    placement.set(entry.key, { x: shelfX, y: cursor });
    shelfX += width + GROUP_GAP;
    shelfHeight = Math.max(shelfHeight, occupiedHeight(entry.height));
  }
  const groups: SharedFloorLayoutGroup[] = [];
  let worldWidth = WORLD_MARGIN * 2 + ISLAND_WIDTH;
  let worldHeight = 320;
  for (const remembered of memory.groups) {
    const point = placement.get(remembered.key)!;
    const width = widthOf(remembered);
    // Bounds count departed groups too: their vacancies still occupy world space.
    worldWidth = Math.max(worldWidth, point.x + width + WORLD_MARGIN);
    worldHeight = Math.max(worldHeight, point.y + Math.round(remembered.height * CAPTION_TOP) + CAPTION_HEIGHT + WORLD_MARGIN);
    const group = current.get(remembered.key);
    if (!group) continue;
    const slots = deckSlots(remembered.laneIds.length, width, remembered.height);
    const actors = remembered.laneIds.flatMap((id, slot) => {
      const lane = group.lanes.get(id);
      if (!lane) return [];
      const { x: actorX, y: actorY } = slots[slot]!;
      return [{ lane, x: actorX, y: actorY, centerX: point.x + actorX + ACTOR_WIDTH / 2, centerY: point.y + actorY + 70 }];
    });
    groups.push({ key: remembered.key, cwd: group.cwd, lanes: actors.map((actor) => actor.lane), x: point.x, y: point.y, width, height: remembered.height, actors });
  }
  return { memory, groups, worldWidth, worldHeight };
}
