export type MapProjection = "flat" | "iso";
export function projectFloorPoint(x: number, y: number, projection: MapProjection) {
  return projection === "iso" ? { x: Math.sqrt(3) / 2 * (x - y), y: (x + y) / 2 } : { x, y };
}
export function unprojectFloorPoint(x: number, y: number, projection: MapProjection) {
  return projection === "iso" ? { x: y + x / Math.sqrt(3), y: y - x / Math.sqrt(3) } : { x, y };
}
