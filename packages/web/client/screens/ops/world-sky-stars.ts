/**
 * An endless, deterministic starfield.
 *
 * Stars are a function of their cell coordinates rather than a stored list, so
 * the same patch of sky always looks the same, panning reveals new sky instead
 * of repeating a tile, and only the cells currently on screen are ever
 * generated. Nothing here is a raster: a photograph of the Milky Way has a
 * fixed resolution and turns to mush the moment you scale past it, which is
 * exactly the direction a space view spends all its time travelling.
 */

/** Sky units per cell. One star per cell at density 1. */
export const SKY_CELL = 96;

export type SkyStar = {
  /** Sky-space position. */
  x: number;
  y: number;
  radius: number;
  alpha: number;
  /**
   * A spare deterministic roll in [0, 1), independent of brightness.
   *
   * Lets a caller shape the field — thinning a layer everywhere except inside
   * the galactic band, say — without the module having to know what a band is,
   * and without reusing the brightness roll, which would silently correlate
   * "survives the thinning" with "is a bright star".
   */
  roll: number;
};

export type SkyRegion = { minX: number; minY: number; maxX: number; maxY: number };

export type SkyStarOptions = {
  /** Distinguishes layers so they do not draw the same stars on top of each other. */
  salt: number;
  /** Average stars per cell. Fractional values are honoured probabilistically. */
  density: number;
  /** Radius multiplier before the per-star variation. */
  size?: number;
  /** Upper bound on returned stars — a runaway region degrades, never hangs. */
  maxStars?: number;
  /**
   * Sky units per cell, overriding `SKY_CELL`.
   *
   * This is what makes the field survive an unbounded zoom-out. Scanning a
   * region that grows without limit at a fixed cell size means the star count
   * grows with the square of the distance, and the cap then truncates the scan
   * mid-sweep — a sky that is full in one corner and empty everywhere else.
   * Doubling the cell instead keeps the number of cells on screen roughly
   * constant however far back the camera goes.
   */
  cell?: number;
};

/**
 * Deterministic [0, 1) from a cell coordinate pair and a salt.
 *
 * Integer-mixing hash rather than a seeded sequence: a sequence would make a
 * star depend on how many cells were drawn before it, and the whole point is
 * that a cell's star is the same no matter how you arrived at it.
 */
export function cellRandom(cellX: number, cellY: number, salt: number): number {
  let h = Math.imul(cellX | 0, 0x27d4eb2d)
    ^ Math.imul(cellY | 0, 0x165667b1)
    ^ Math.imul(salt | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_296;
}

const DEFAULT_MAX_STARS = 4_000;

/** Every star whose cell falls inside `region`, in sky coordinates. */
export function starsForRegion(region: SkyRegion, options: SkyStarOptions): SkyStar[] {
  const { salt, density } = options;
  const size = options.size ?? 1;
  const maxStars = options.maxStars ?? DEFAULT_MAX_STARS;
  const cell = options.cell ?? SKY_CELL;
  if (density <= 0 || maxStars <= 0 || !(cell > 0)) return [];

  const minCellX = Math.floor(region.minX / cell);
  const maxCellX = Math.floor(region.maxX / cell);
  const minCellY = Math.floor(region.minY / cell);
  const maxCellY = Math.floor(region.maxY / cell);

  const whole = Math.floor(density);
  const fraction = density - whole;
  const stars: SkyStar[] = [];

  for (let cellY = minCellY; cellY <= maxCellY; cellY += 1) {
    for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
      const count = whole + (cellRandom(cellX, cellY, salt) < fraction ? 1 : 0);
      for (let index = 0; index < count; index += 1) {
        if (stars.length >= maxStars) return stars;
        const seed = salt + index * 7919;
        // Bright stars are rare: cubing the roll keeps most of them faint
        // pinpricks and lets a handful stand out, which is what reads as depth.
        const brightness = cellRandom(cellX, cellY, seed + 3) ** 3;
        stars.push({
          x: (cellX + cellRandom(cellX, cellY, seed + 1)) * cell,
          y: (cellY + cellRandom(cellX, cellY, seed + 2)) * cell,
          // The faint majority still has to survive the trip to a real pixel:
          // below about a half-pixel radius at a quarter alpha a star is a grey
          // smudge, and a sky full of those reads as empty rather than as deep.
          radius: size * (0.45 + brightness * 1.45),
          alpha: 0.34 + brightness * 0.66,
          roll: cellRandom(cellX, cellY, seed + 4),
        });
      }
    }
  }
  return stars;
}
