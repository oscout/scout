import { expect, test } from "bun:test";
import { FLOOR_ROOMS, floorWorldPosition, floorWorldRoute } from "./agent-floor-world-layout.ts";
import type { FloorActorStation } from "./agent-floor-actor.ts";

test("eight actors have distinct berths inside every room", () => {
  for (const station of Object.keys(FLOOR_ROOMS) as FloorActorStation[]) {
    const room = FLOOR_ROOMS[station];
    const seats = Array.from({ length: 8 }, (_, index) => floorWorldPosition(station, index));
    expect(new Set(seats.map((seat) => `${seat.x},${seat.y}`)).size).toBe(8);
    for (const seat of seats) {
      expect(seat.x).toBeGreaterThan(room.x + 40);
      expect(seat.x).toBeLessThan(room.x + 370);
      expect(seat.y).toBeGreaterThan(room.y + 80);
      expect(seat.y).toBeLessThan(room.y + 230);
    }
  }
});

test("cross-room journeys go through the doors and passage with no diagonal wall crossing", () => {
  for (const a of Object.keys(FLOOR_ROOMS) as FloorActorStation[]) {
    for (const b of Object.keys(FLOOR_ROOMS) as FloorActorStation[]) {
      if (a === b) continue;
      const from = floorWorldPosition(a, 0), to = floorWorldPosition(b, 7);
      const route = floorWorldRoute(from, to);
      expect(route[0]).toEqual(from);
      expect(route.at(-1)).toEqual(to);
      expect(route.some((point) => point.y === 325)).toBe(true);
      for (let i = 1; i < route.length; i++) {
        expect(route[i].x === route[i - 1].x || route[i].y === route[i - 1].y).toBe(true);
      }
    }
  }
});

test("a same-room berth adjustment takes a direct path", () => {
  const from = floorWorldPosition("home", 0), to = floorWorldPosition("home", 1);
  expect(floorWorldRoute(from, to)).toEqual([from, to]);
});
