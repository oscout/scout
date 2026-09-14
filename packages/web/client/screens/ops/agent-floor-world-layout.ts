import type { FloorActorStation } from "./agent-floor-actor.ts";

export type FloorPoint = { x: number; y: number };
export const FLOOR_WORLD_WIDTH = 960;
export const FLOOR_WORLD_HEIGHT = 650;
export const FLOOR_ROOMS = {
  home: { x: 20, y: 20 }, tools: { x: 530, y: 20 },
  message: { x: 20, y: 360 }, edit: { x: 530, y: 360 },
} satisfies Record<FloorActorStation, FloorPoint>;

export function floorWorldPosition(station: FloorActorStation, berth: number): FloorPoint {
  const room = FLOOR_ROOMS[station];
  return { x: room.x + 65 + (berth % 4) * 94, y: room.y + 115 + Math.floor(berth / 4) * 94 };
}

/** Walk through each room's central door and the shared horizontal passage. */
export function floorWorldRoute(from: FloorPoint, to: FloorPoint): FloorPoint[] {
  const sameRoom = (from.x < 480) === (to.x < 480) && (from.y < 325) === (to.y < 325);
  if (sameRoom) return [from, to];
  const exitX = from.x < 480 ? 225 : 735;
  const entryX = to.x < 480 ? 225 : 735;
  return [from, { x: exitX, y: from.y }, { x: exitX, y: 325 },
    { x: entryX, y: 325 }, { x: entryX, y: to.y }, to]
    .filter((point, index, all) => index === 0 || point.x !== all[index - 1].x || point.y !== all[index - 1].y);
}
