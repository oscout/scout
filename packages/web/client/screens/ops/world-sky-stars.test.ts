import { describe, expect, test } from "bun:test";

import { cellRandom, SKY_CELL, starsForRegion, type SkyRegion } from "./world-sky-stars.ts";

const region: SkyRegion = { minX: 0, minY: 0, maxX: SKY_CELL * 10, maxY: SKY_CELL * 10 };

describe("cellRandom", () => {
  test("is deterministic", () => {
    expect(cellRandom(12, -7, 3)).toBe(cellRandom(12, -7, 3));
  });

  test("separates cells, salts, and sign", () => {
    expect(cellRandom(12, -7, 3)).not.toBe(cellRandom(13, -7, 3));
    expect(cellRandom(12, -7, 3)).not.toBe(cellRandom(12, -8, 3));
    expect(cellRandom(12, -7, 3)).not.toBe(cellRandom(12, -7, 4));
    expect(cellRandom(12, 7, 3)).not.toBe(cellRandom(12, -7, 3));
  });

  test("stays in [0, 1)", () => {
    for (let x = -50; x < 50; x += 1) {
      for (let y = -3; y < 3; y += 1) {
        const value = cellRandom(x, y, 1);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(1);
      }
    }
  });
});

describe("starsForRegion", () => {
  test("the same region always yields the same stars", () => {
    const first = starsForRegion(region, { salt: 2, density: 0.8 });
    const second = starsForRegion(region, { salt: 2, density: 0.8 });
    expect(second).toEqual(first);
  });

  test("a panned region keeps the stars it still overlaps", () => {
    const stars = starsForRegion(region, { salt: 2, density: 0.8 });
    const panned = starsForRegion(
      { ...region, minX: region.minX + SKY_CELL * 3, maxX: region.maxX + SKY_CELL * 3 },
      { salt: 2, density: 0.8 },
    );
    const overlap = stars.filter((star) => star.x >= region.minX + SKY_CELL * 3);
    expect(overlap.length).toBeGreaterThan(0);
    for (const star of overlap) {
      expect(panned).toContainEqual(star);
    }
  });

  test("stars land inside the cells the region covers", () => {
    for (const star of starsForRegion(region, { salt: 5, density: 1 })) {
      expect(star.x).toBeGreaterThanOrEqual(region.minX);
      expect(star.x).toBeLessThan(region.maxX + SKY_CELL);
      expect(star.y).toBeGreaterThanOrEqual(region.minY);
      expect(star.y).toBeLessThan(region.maxY + SKY_CELL);
    }
  });

  test("layers with different salts do not draw the same sky", () => {
    const a = starsForRegion(region, { salt: 1, density: 0.6 });
    const b = starsForRegion(region, { salt: 2, density: 0.6 });
    expect(a).not.toEqual(b);
  });

  test("density scales the count and fractional density is honoured", () => {
    const sparse = starsForRegion(region, { salt: 1, density: 0.25 }).length;
    const dense = starsForRegion(region, { salt: 1, density: 2 }).length;
    expect(sparse).toBeGreaterThan(0);
    expect(dense).toBeGreaterThan(sparse * 4);
  });

  test("a huge region degrades to a cap rather than hanging", () => {
    const stars = starsForRegion(
      { minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 },
      { salt: 1, density: 1, maxStars: 500 },
    );
    expect(stars).toHaveLength(500);
  });

  test("zero density draws nothing", () => {
    expect(starsForRegion(region, { salt: 1, density: 0 })).toEqual([]);
  });

  test("radius and alpha stay in a drawable range", () => {
    for (const star of starsForRegion(region, { salt: 9, density: 1.5, size: 1.4 })) {
      expect(star.radius).toBeGreaterThan(0);
      expect(star.radius).toBeLessThanOrEqual(1.4 * 1.9 + 1e-9);
      expect(star.alpha).toBeGreaterThan(0);
      expect(star.alpha).toBeLessThanOrEqual(1);
    }
  });
});

describe("octave cells", () => {
  const screenSpan = { minX: 0, minY: 0, maxX: 1600, maxY: 900 };

  test("a bigger cell covers the same sky with proportionally fewer stars", () => {
    const fine = starsForRegion(region, { salt: 4, density: 1, cell: SKY_CELL });
    const coarse = starsForRegion(region, { salt: 4, density: 1, cell: SKY_CELL * 4 });
    // Sixteen times the area per cell, so about a sixteenth of the stars.
    expect(coarse.length).toBeGreaterThan(0);
    expect(coarse.length).toBeLessThan(fine.length / 8);
  });

  test("star count per screen stays bounded as the camera pulls back", () => {
    // The point of the doubling cell: scan the sky an unbounded zoom-out
    // reveals, without the count growing with the square of the distance.
    const counts: number[] = [];
    for (let octave = 0; octave < 20; octave += 1) {
      const span = Math.pow(2, -octave);
      counts.push(starsForRegion(
        {
          minX: screenSpan.minX / span,
          minY: screenSpan.minY / span,
          maxX: screenSpan.maxX / span,
          maxY: screenSpan.maxY / span,
        },
        { salt: 3, density: 1, cell: SKY_CELL * Math.pow(2, octave) },
      ).length);
    }
    for (const count of counts) {
      expect(count).toBe(counts[0]!);
      // Comfortably under the default cap, so nothing is ever truncated.
      expect(count).toBeLessThan(1_000);
    }
  });

  test("an octave is not a scaled copy of its neighbour", () => {
    // Same cell coordinates, different salt: without this the cross-fade would
    // look like one field breathing rather than two fields handing over.
    const a = starsForRegion(region, { salt: 7, density: 1, cell: SKY_CELL });
    const b = starsForRegion(region, { salt: 7 + 101, density: 1, cell: SKY_CELL });
    expect(a.map((star) => star.x)).not.toEqual(b.map((star) => star.x));
  });

  test("a nonsense cell draws nothing rather than looping forever", () => {
    expect(starsForRegion(region, { salt: 1, density: 1, cell: 0 })).toEqual([]);
    expect(starsForRegion(region, { salt: 1, density: 1, cell: -8 })).toEqual([]);
    expect(starsForRegion(region, { salt: 1, density: 1, cell: Number.NaN })).toEqual([]);
  });
});
