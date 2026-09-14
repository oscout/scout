import { expect, test } from 'bun:test';
import { clampFloorPan, MAX_FLOOR_ZOOM, MIN_FLOOR_ZOOM, minimapGeometry, minimapZoom, scaleFloorZoom, wheelZoomFactor, worldDetailFade, zoomAboutPoint, ZOOM_STEP } from './floor-minimap.ts';
import { projectFloorPoint } from './shared-floor-camera.ts';

for (const mode of ['flat', 'iso'] as const) {
  test(`${mode}: wide and tall worlds fit without distorting projected coordinates`, () => {
    for (const [width, height] of [[2000, 300], [300, 4000]]) {
      const geo = minimapGeometry(width, height, mode);
      for (const corner of geo.corners) {
        const point = geo.point(corner.x, corner.y);
        expect(point.x).toBeGreaterThanOrEqual(10 - 1e-8);
        expect(point.x).toBeLessThanOrEqual(166 + 1e-8);
        expect(point.y).toBeGreaterThanOrEqual(12 - 1e-8);
        expect(point.y).toBeLessThanOrEqual(100 + 1e-8);
      }
      const projected = projectFloorPoint(37, -84, mode);
      const mini = geo.point(projected.x, projected.y);
      expect((mini.x - 88) / geo.ratio).toBeCloseTo(projected.x);
      expect((mini.y - 56) / geo.ratio).toBeCloseTo(projected.y);
    }
  });
}

test('wheel zoom preserves the panned camera center, including at limits', () => {
  const pan = { x: 240, y: -130 };
  for (const delta of [-100000, -80, 0, 80, 100000]) {
    const next = minimapZoom(1.2, pan, delta);
    expect(next.zoom).toBeGreaterThanOrEqual(MIN_FLOOR_ZOOM);
    expect(next.zoom).toBeLessThanOrEqual(MAX_FLOOR_ZOOM);
    expect(Number.isFinite(next.zoom)).toBe(true);
    expect(next.pan.x / next.zoom).toBeCloseTo(pan.x / 1.2);
    expect(next.pan.y / next.zoom).toBeCloseTo(pan.y / 1.2);
  }
  expect(minimapZoom(1.2, pan, 0)).toEqual({ zoom: 1.2, pan });
});

test("all zoom factors can exceed the old cap and reject overflow", () => {
 expect(scaleFloorZoom(3, 1.25)).toBe(3.75);
 expect(scaleFloorZoom(3, 1.1)).toBeCloseTo(3.3);
 expect(minimapZoom(3, {x:0,y:0}, -100).zoom).toBeGreaterThan(3);
 expect(scaleFloorZoom(3, Infinity)).toBe(3);
 expect(scaleFloorZoom(3, NaN)).toBe(3);
 expect(scaleFloorZoom(3, -1)).toBe(3);
});

test("space pulls back far past the old .6 floor, and still has an end", () => {
  expect(MIN_FLOOR_ZOOM).toBeLessThan(.6);
  // Repeated zoom-out lands on the floor rather than stopping short of it.
  let zoom = 1;
  for (let step = 0; step < 200; step += 1) zoom = scaleFloorZoom(zoom, 1 / 1.25);
  expect(zoom).toBe(MIN_FLOOR_ZOOM);

  let inward = 1;
  for (let step = 0; step < 200; step += 1) inward = scaleFloorZoom(inward, 1.25);
  expect(inward).toBe(MAX_FLOOR_ZOOM);
});

test("wheel factors are comparable across pixel, line and page deltas", () => {
  // A mouse notch (3 lines) and a trackpad glide must not differ by 16x.
  expect(wheelZoomFactor(48, 0)).toBeCloseTo(wheelZoomFactor(3, 1), 5);
  // Direction: scrolling up zooms in, down zooms out.
  expect(wheelZoomFactor(-100, 0)).toBeGreaterThan(1);
  expect(wheelZoomFactor(100, 0)).toBeLessThan(1);
  expect(wheelZoomFactor(0, 0)).toBe(1);
  // A single violent delta is clamped, so one flick cannot cross the range.
  const flick = wheelZoomFactor(100000, 0);
  expect(flick).toBe(wheelZoomFactor(600, 0));
  expect(scaleFloorZoom(1, flick)).toBeGreaterThan(MIN_FLOOR_ZOOM);
});

test("zoom holds the world point under the cursor still", () => {
  // The viewport maps world → screen as pan + world * fit * zoom, measured from
  // the centre of the viewport (see .shared-floor__benches).
  const fit = .4;
  const screen = (camera: { zoom: number; pan: { x: number; y: number } }, world: { x: number; y: number }) => ({
    x: camera.pan.x + world.x * fit * camera.zoom,
    y: camera.pan.y + world.y * fit * camera.zoom,
  });
  const start = { zoom: 1, pan: { x: 120, y: -60 } };
  const focus = { x: -210, y: 95 };
  const world = {
    x: (focus.x - start.pan.x) / (fit * start.zoom),
    y: (focus.y - start.pan.y) / (fit * start.zoom),
  };
  for (const factor of [1.6, 1 / 1.6, 4, 1 / 20]) {
    const after = screen(zoomAboutPoint(start.zoom, start.pan, factor, focus), world);
    expect(after.x).toBeCloseTo(focus.x);
    expect(after.y).toBeCloseTo(focus.y);
  }
});

test("the default focus is the middle of the screen, matching the minimap", () => {
  const pan = { x: 240, y: -130 };
  expect(zoomAboutPoint(1.2, pan, Math.exp(-80 * .002))).toEqual(minimapZoom(1.2, pan, 80));
  expect(zoomAboutPoint(2, { x: 100, y: 50 }, .5).pan).toEqual({ x: 50, y: 25 });
});

test("a step clamped at a limit leaves the camera where it was", () => {
  // Otherwise scrolling against the floor slides the world sideways forever.
  const floored = zoomAboutPoint(MIN_FLOOR_ZOOM, { x: 10, y: 10 }, 1 / 100, { x: 40, y: 40 });
  expect(floored.zoom).toBe(MIN_FLOOR_ZOOM);
  expect(floored.pan).toEqual({ x: 10, y: 10 });
  const ceiled = zoomAboutPoint(MAX_FLOOR_ZOOM, { x: 10, y: 10 }, 100, { x: 40, y: 40 });
  expect(ceiled.zoom).toBe(MAX_FLOOR_ZOOM);
  expect(ceiled.pan).toEqual({ x: 10, y: 10 });
});

test("the range is a voyage, not a nudge", () => {
  // Forty thousand to one. The old range was about two to one.
  expect(MAX_FLOOR_ZOOM / MIN_FLOOR_ZOOM).toBeGreaterThan(30_000);
  expect(MIN_FLOOR_ZOOM).toBeLessThan(.001);
});

test("the whole range is reachable by wheel and by button in a sane number of moves", () => {
  // A 600px flick is one unhurried trackpad gesture.
  let zoom = 1;
  let flicks = 0;
  while (zoom > MIN_FLOOR_ZOOM && flicks < 200) {
    zoom = scaleFloorZoom(zoom, wheelZoomFactor(600, 0));
    flicks += 1;
  }
  expect(zoom).toBe(MIN_FLOOR_ZOOM);
  expect(flicks).toBeLessThanOrEqual(8);

  let clicks = 0;
  let stepped = 1;
  while (stepped > MIN_FLOOR_ZOOM && clicks < 200) {
    stepped = scaleFloorZoom(stepped, 1 / ZOOM_STEP);
    clicks += 1;
  }
  expect(stepped).toBe(MIN_FLOOR_ZOOM);
  expect(clicks).toBeLessThanOrEqual(16);
});

test("the floor hands over to beacons without a gap or a hard swap", () => {
  // Near: the floor is the floor, no lights.
  expect(worldDetailFade(1)).toEqual({ world: 1, beacons: 0 });
  // Far: nothing but lights.
  expect(worldDetailFade(MIN_FLOOR_ZOOM)).toEqual({ world: 0, beacons: 1 });

  let previousWorld = 1;
  let previousBeacons = 0;
  let overlapped = false;
  for (let zoom = .6; zoom > MIN_FLOOR_ZOOM; zoom *= .97) {
    const fade = worldDetailFade(zoom);
    expect(fade.world).toBeGreaterThanOrEqual(0);
    expect(fade.world).toBeLessThanOrEqual(1);
    expect(fade.beacons).toBeGreaterThanOrEqual(0);
    expect(fade.beacons).toBeLessThanOrEqual(1);
    // Both move one way only, so nothing flickers on the way out.
    expect(fade.world).toBeLessThanOrEqual(previousWorld + 1e-9);
    expect(fade.beacons).toBeGreaterThanOrEqual(previousBeacons - 1e-9);
    // Something is always on screen: never a stretch of empty space.
    expect(Math.max(fade.world, fade.beacons)).toBeGreaterThan(.2);
    if (fade.world > .05 && fade.beacons > .05) overlapped = true;
    previousWorld = fade.world;
    previousBeacons = fade.beacons;
  }
  // The two overlap, so an island picks up its halo before it goes.
  expect(overlapped).toBe(true);
});

test("the camera cannot be flown somewhere with no world in sight", () => {
  const view = { width: 1200, height: 800 };
  const world = { width: 3000, height: 2000 };
  // Straight ahead is untouched.
  expect(clampFloorPan({ x: 0, y: 0 }, world, view)).toEqual({ x: 0, y: 0 });
  // A wild pan is pulled back to where a strip of world is still on screen.
  for (const wild of [{ x: 99_999, y: 0 }, { x: -99_999, y: 0 }, { x: 0, y: 99_999 }, { x: 4000, y: -7000 }]) {
    const held = clampFloorPan(wild, world, view);
    // World spans [pan - half, pan + half]; the viewport spans [-view/2, view/2].
    const overlapX = Math.min(held.x + world.width / 2, view.width / 2)
      - Math.max(held.x - world.width / 2, -view.width / 2);
    const overlapY = Math.min(held.y + world.height / 2, view.height / 2)
      - Math.max(held.y - world.height / 2, -view.height / 2);
    expect(overlapX).toBeGreaterThanOrEqual(95);
    expect(overlapY).toBeGreaterThanOrEqual(95);
  }
});

test("a world smaller than the margin is still reachable, not pinned", () => {
  // At the floor of the zoom range the whole world is a few pixels wide. The
  // bound must not invert and trap the camera at a point it cannot leave.
  const view = { width: 1200, height: 800 };
  const speck = { width: 4, height: 3 };
  const held = clampFloorPan({ x: 400, y: 260 }, speck, view);
  expect(held).toEqual({ x: 400, y: 260 });
  expect(Number.isFinite(held.x)).toBe(true);

  // And a degenerate viewport does not produce NaN.
  expect(clampFloorPan({ x: 10, y: 10 }, speck, { width: 0, height: 0 })).toEqual({ x: 2, y: 1.5 });
  expect(clampFloorPan({ x: Number.NaN, y: 5 }, speck, view).x).toBe(0);
});
