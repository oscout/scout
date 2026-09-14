import { expect, test } from 'bun:test';
import { minimapGeometry, minimapZoom, scaleFloorZoom } from './floor-minimap.ts';
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
    expect(next.zoom).toBeGreaterThanOrEqual(.6);
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
});
