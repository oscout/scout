import { buildLaneSessionStats } from "./agent-lane-detail.ts";
import type { AgentLane } from "./agent-lanes-model.ts";

export type SharedFloorLayoutMemory = { groups: { key: string; laneIds: string[]; height: number }[] };
export type SharedFloorLayoutGroup = {
  key: string; cwd: string; lanes: AgentLane[];
  x: number; y: number; width: number; height: number;
  actors: { lane: AgentLane; x: number; y: number; centerX: number; centerY: number }[];
};

// Footprint includes the visible one-line caption, not only the 84px sprite.
const COLUMNS = 3;
const CAPTION_WIDTH = 145;
const HORIZONTAL_GAP = 45;
const ROW_PITCH = 175;
const GROUP_PADDING = 55;
const GROUP_WIDTH = GROUP_PADDING * 2 + CAPTION_WIDTH + (COLUMNS - 1) * (CAPTION_WIDTH + HORIZONTAL_GAP);
const MIN_GROUP_HEIGHT = 240;

// Each group paints one 647×809 outpost panel, stretched to the group width plus a
// bleed on either side and centred on the group (shared-work-floor.css,
// `.shared-floor__outpost`). Its overhang above a short group and the caption hung
// below the group's centre (`.shared-floor__gathering-label`) are real pixels: the
// world must reserve them or Fit and the minimap clip the first row's art and
// leave dead space under the last.
const PAINT_BLEED = 40;
const PAINT_WIDTH = GROUP_WIDTH + PAINT_BLEED * 2;
const PAINT_HEIGHT = Math.round(PAINT_WIDTH * 809 / 647);
const CAPTION_OFFSET = 430;
const CAPTION_HEIGHT = 64;
const GROUP_GAP = PAINT_BLEED * 2 + 125; // open space between neighbouring paintings
const ROW_GAP = 60;
const WORLD_MARGIN = 30;

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

/** Vertical pixels a row of the given group height occupies beyond the group box. */
function rowExtent(height: number): { above: number; below: number } {
  const half = height / 2;
  return {
    above: Math.max(0, PAINT_HEIGHT / 2 - half),
    below: Math.max(height, half + CAPTION_OFFSET + CAPTION_HEIGHT),
  };
}

/** Keep returned memory between calls. Vacancies and high-water row heights are intentional.
 * Actor coordinates are group-local; center coordinates are world-space for relationship lines.
 * A growing row may push later rows downward, but disappearance/reordering never compacts them.
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
      remembered = { key, laneIds: [], height: MIN_GROUP_HEIGHT };
      memory.groups.push(remembered);
    }
    for (const id of group.lanes.keys()) if (!remembered.laneIds.includes(id)) remembered.laneIds.push(id);
    // The last actor occupies y + 140 including its label, with a small lower margin.
    const rows = Math.ceil(remembered.laneIds.length / COLUMNS);
    remembered.height = Math.max(remembered.height, MIN_GROUP_HEIGHT, 55 + (rows - 1) * ROW_PITCH + 25 + 140 + 35);
  }
  const groups: SharedFloorLayoutGroup[] = [];
  let cursor = WORLD_MARGIN;
  for (let index = 0; index < memory.groups.length; index += 2) {
    const row = memory.groups.slice(index, index + 2);
    const height = Math.max(...row.map((group) => group.height), MIN_GROUP_HEIGHT);
    const extent = rowExtent(height);
    const rowY = cursor + extent.above;
    row.forEach((remembered, column) => {
      const group = current.get(remembered.key);
      if (!group) return;
      const x = WORLD_MARGIN + PAINT_BLEED + column * (GROUP_WIDTH + GROUP_GAP);
      const actors = remembered.laneIds.flatMap((id, slot) => {
        const lane = group.lanes.get(id);
        if (!lane) return [];
        const actorX = GROUP_PADDING + (CAPTION_WIDTH - 84) / 2 + (slot % COLUMNS) * (CAPTION_WIDTH + HORIZONTAL_GAP);
        const actorY = 55 + Math.floor(slot / COLUMNS) * ROW_PITCH + [10, 25, 0][slot % COLUMNS];
        return [{ lane, x: actorX, y: actorY, centerX: x + actorX + 42, centerY: rowY + actorY + 70 }];
      });
      groups.push({ key: remembered.key, cwd: group.cwd, lanes: actors.map((actor) => actor.lane), x, y: rowY, width: GROUP_WIDTH, height, actors });
    });
    cursor = rowY + extent.below + ROW_GAP;
  }
  const columns = Math.min(2, Math.max(1, memory.groups.length));
  return {
    memory,
    groups,
    worldWidth: (WORLD_MARGIN + PAINT_BLEED) * 2 + GROUP_WIDTH * columns + (columns - 1) * GROUP_GAP,
    worldHeight: Math.max(320, memory.groups.length ? cursor - ROW_GAP + WORLD_MARGIN : cursor),
  };
}
