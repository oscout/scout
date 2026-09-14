import { buildLaneSessionStats } from "./agent-lane-detail.ts";
import type { AgentLane } from "./agent-lanes-model.ts";

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
const WORLD_MARGIN = 30;

/** Columns widen before rows do: a deck is wider than it is deep. */
function crewGrid(count: number): { columns: number; rows: number } {
  const columns = count <= 6 ? 3 : count <= 12 ? 4 : 5;
  return { columns, rows: Math.max(1, Math.ceil(Math.max(count, 1) / columns)) };
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
    // A short last row stays centred under the rows above it.
    const span = columns > 1 ? usable * (inRow - 1) / (columns - 1) : 0;
    const step = inRow > 1 ? span / (inRow - 1) : 0;
    return {
      x: Math.round(deckLeft + inset + (usable - span) / 2 + column * step),
      y: Math.round(deckBack + depth * deckDepth - ACTOR_FEET + ROW_JITTER[column % ROW_JITTER.length]!),
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

/** Keep returned memory between calls. Vacancies and high-water island sizes are intentional.
 * Actor coordinates are group-local; center coordinates are world-space for relationship lines.
 * A growing island may push later rows downward, but disappearance/reordering never compacts them.
 */
export function buildSharedFloorLayout(lanes: readonly AgentLane[], previous?: SharedFloorLayoutMemory): {
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
  const groups: SharedFloorLayoutGroup[] = [];
  let cursor = WORLD_MARGIN;
  let worldWidth = WORLD_MARGIN * 2 + ISLAND_WIDTH;
  for (let index = 0; index < memory.groups.length; index += 2) {
    const row = memory.groups.slice(index, index + 2);
    const height = Math.max(...row.map((group) => group.height), ISLAND_HEIGHT);
    const rowY = cursor;
    let x = WORLD_MARGIN;
    for (const remembered of row) {
      const group = current.get(remembered.key);
      const width = Math.round(remembered.height * ISLAND_ASPECT);
      if (group) {
        const slots = deckSlots(remembered.laneIds.length, width, remembered.height);
        const groupX = x;
        const actors = remembered.laneIds.flatMap((id, slot) => {
          const lane = group.lanes.get(id);
          if (!lane) return [];
          const { x: actorX, y: actorY } = slots[slot]!;
          return [{ lane, x: actorX, y: actorY, centerX: groupX + actorX + ACTOR_WIDTH / 2, centerY: rowY + actorY + 70 }];
        });
        groups.push({ key: remembered.key, cwd: group.cwd, lanes: actors.map((actor) => actor.lane), x: groupX, y: rowY, width, height: remembered.height, actors });
      }
      x += width + GROUP_GAP;
    }
    worldWidth = Math.max(worldWidth, x - GROUP_GAP + WORLD_MARGIN);
    cursor = rowY + Math.round(height * CAPTION_TOP) + CAPTION_HEIGHT + ROW_GAP;
  }
  return {
    memory,
    groups,
    worldWidth,
    worldHeight: Math.max(320, memory.groups.length ? cursor - ROW_GAP + WORLD_MARGIN : cursor),
  };
}
