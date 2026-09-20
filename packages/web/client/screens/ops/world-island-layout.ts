import type { SharedFloorIslandPositions } from "./shared-floor-layout.ts";

/** Operator-placed island positions, durable per device. Keys are group keys
   (workspace paths) and are kept for departed workspaces, so a returning
   island lands where the operator left it. */
const WORLD_ISLAND_LAYOUT_KEY = "openscout:world-island-layout:v1";

export function readWorldIslandLayout(): SharedFloorIslandPositions {
  try {
    const raw = globalThis.localStorage?.getItem(WORLD_ISLAND_LAYOUT_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const positions: SharedFloorIslandPositions = {};
    for (const [key, point] of Object.entries(parsed as Record<string, unknown>)) {
      if (!point || typeof point !== "object") continue;
      const { x, y } = point as { x?: unknown; y?: unknown };
      if (typeof x === "number" && Number.isFinite(x) && typeof y === "number" && Number.isFinite(y)) {
        positions[key] = { x, y };
      }
    }
    return positions;
  } catch {
    return {};
  }
}

export function writeWorldIslandLayout(positions: SharedFloorIslandPositions) {
  try {
    globalThis.localStorage?.setItem(WORLD_ISLAND_LAYOUT_KEY, JSON.stringify(positions));
  } catch {
    // Storage full or unavailable: the in-memory layout still holds for the session.
  }
}
