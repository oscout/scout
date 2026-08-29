/**
 * Agent identity — deterministic generative sprite from an agent's name.
 *
 * One name in → one stable little creature out. The name is hashed to a
 * seed, the seed drives a PRNG, and every visual parameter (silhouette,
 * eyes, antennae, speckle, hue) is pulled from that single stream. Same
 * name → same creature, every run, every surface. Nothing is stored.
 *
 * Ported verbatim from design/studio/lib/agent-identity.ts (sprite engine
 * only) and kept bit-compatible with the SwiftUI port (ScoutAppCore /
 * AgentSprite.swift) so the same name yields the same creature on web and
 * native. Mapping conventions (hue ← harness, tone ← state) live in
 * components/SpriteAvatar.tsx.
 */

// ── hash + prng ────────────────────────────────────────────────────────
export function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Rng {
  seed: number;
  next: () => number;
  float: (min: number, max: number) => number;
  int: (min: number, max: number) => number;
  bool: (p?: number) => boolean;
}

export function makeRng(key: string): Rng {
  const seed = xmur3(key.trim().toLowerCase())();
  const next = mulberry32(seed);
  return {
    seed,
    next,
    float: (min, max) => min + (max - min) * next(),
    int: (min, max) => Math.floor(min + (max - min + 1) * next()),
    bool: (p = 0.5) => next() < p,
  };
}

// ── palette ────────────────────────────────────────────────────────────
export interface Palette {
  hue: number;
  body: string;
  bodyDim: string;
  accent: string;
  ink: string;
  sclera: string;
  glow: string;
  soft: string;
  /**
   * The numeric lightness/chroma behind `body` and `accent`.
   *
   * Presentation only — nothing here feeds the hash, the seed, or a trait, and
   * the cell grid is identical with or without it. It exists so a renderer can
   * shade the creature as ONE lit form (a light that crosses the whole
   * silhouette) instead of a mosaic of individually flat tiles. Rebuilding
   * those numbers by parsing the oklch strings back out would be the same
   * values, arrived at worse.
   */
  bodyL: number;
  bodyC: number;
  accentL: number;
  accentC: number;
  accentHue: number;
}

/** Tone — the "color range" knob (lightness + chroma), driven by state. */
export interface Tone {
  l?: number;
  c?: number;
}

export function paletteFromHue(hue: number, tone: Tone = {}): Palette {
  const h = ((hue % 360) + 360) % 360;
  const l = tone.l ?? 0.72;
  const c = tone.c ?? 0.15;
  const accentHue = (h + 38) % 360;
  const dim = Math.max(0.18, l - 0.12);
  const lift = Math.min(0.92, l + 0.1);
  return {
    hue: h,
    body: `oklch(${l} ${c} ${h})`,
    bodyDim: `oklch(${dim} ${Math.max(0, c - 0.02)} ${h})`,
    accent: `oklch(${lift} ${c + 0.01} ${accentHue})`,
    ink: `oklch(0.34 0.07 ${h})`,
    sclera: `oklch(0.96 0.02 ${h})`,
    glow: `oklch(${l} ${c} ${h} / 0.45)`,
    soft: `oklch(${l} ${c} ${h} / 0.12)`,
    bodyL: l,
    bodyC: c,
    accentL: lift,
    accentC: c + 0.01,
    accentHue,
  };
}

/** Curated hue wheel — nine well-separated stops across the cool arc
 *  (green → teal → cyan → blue → indigo). Warm hues are reserved app-wide:
 *  red for failure and destructive states, amber for warning and attention.
 *  An identity is neither, so no agent is ever tinted orange, yellow, pink,
 *  or magenta. Kept in lockstep with the two Swift mirrors. */
export const CURATED_HUES = [120, 138, 154, 170, 186, 200, 216, 236, 262];

/** Hue per harness family (hue ← harness convention, see SpriteAvatar).
 *  SpriteAvatar falls back to the name's curated hash; Mesh Ops renders an
 *  unknown harness with its dim token instead. */
export const HARNESS_HUE: Record<string, number> = {
  claude: 262,
  codex: 135,
  cursor: 235,
  native: 250,
  worker: 195,
  pi: 176,
  // Curated wheel slots used by Mesh Ops / conductor studies for the
  // first-class harness identities that were missing from the map.
  kimi: 238,
  grok: 266,
  "grok-acp": 266,
  opencode: 160,
  oc: 160,
};

function pickHue(rng: Rng, spectrum = false): number {
  const t = rng.next();
  return spectrum ? Math.floor(t * 360) : CURATED_HUES[Math.floor(t * CURATED_HUES.length)];
}

export function initials(name: string): string {
  const parts = name.trim().split(/[\s\-_./]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  const w = parts[0] ?? "?";
  return w.slice(0, 2).toUpperCase();
}

// ── sprite (pixel creature) ──────────────────────────────────────────────
export type SpriteCell = "off" | "body" | "accent" | "eye" | "mouth";

export interface Sprite {
  size: number;
  cells: SpriteCell[][];
  palette: Palette;
  traits: { antennae: boolean; legs: boolean; wideEyes: boolean; eyeRow: number; mouth: boolean };
}

const SPRITE_SIZE = 7;

export interface SpriteOpts {
  /** Reroll entropy — same name, a different creature; the value a claimed
   *  identity keeps. */
  salt?: string;
  /** Force the hue (harness-tint / curation). Shape still derives from the name. */
  hue?: number;
  /** Body lightness/chroma — the state-driven range. */
  tone?: Tone;
  /** Full 0–359 spectrum instead of the curated wheel. */
  spectrum?: boolean;
}

export function spriteFor(name: string, opts: SpriteOpts = {}): Sprite {
  const rng = makeRng(name + (opts.salt ? "#" + opts.salt : ""));
  const seededHue = pickHue(rng, opts.spectrum);
  const palette = paletteFromHue(opts.hue ?? seededHue, opts.tone);

  const density = rng.float(0.42, 0.62);
  const speckle = rng.float(0.14, 0.34);
  const antennae = rng.bool(0.5);
  const legs = rng.bool(0.62);
  const wideEyes = rng.bool(0.5);
  const eyeRow = rng.bool(0.5) ? 2 : 3;
  const mouth = rng.bool(0.6);

  const S = SPRITE_SIZE;
  const center = (S - 1) / 2;
  const cells: SpriteCell[][] = Array.from({ length: S }, () =>
    Array.from({ length: S }, () => "off" as SpriteCell),
  );
  const set = (r: number, c: number, v: SpriteCell) => {
    cells[r][c] = v;
    cells[r][S - 1 - c] = v;
  };

  for (let r = 1; r <= 5; r++) {
    for (let c = 0; c <= center; c++) {
      const isSpine = c === center;
      const lit = isSpine ? rng.next() < 0.85 : rng.next() < density;
      if (lit) set(r, c, rng.next() < speckle ? "accent" : "body");
    }
  }

  for (let c = 1; c <= center; c++) set(eyeRow, c, "body");
  const eyeCol = wideEyes ? 1 : 2;
  set(eyeRow, eyeCol, "eye");

  if (mouth && eyeRow + 2 < S) {
    set(eyeRow + 2, center, "mouth");
    if (rng.bool(0.4)) set(eyeRow + 2, center - 1, "mouth");
  }
  if (antennae) {
    const ac = rng.bool() ? 1 : 2;
    set(0, ac, "body");
  }
  if (legs) {
    set(S - 1, 1, "body");
    if (rng.bool(0.5)) set(S - 1, center, "body");
  }

  return { size: S, cells, palette, traits: { antennae, legs, wideEyes, eyeRow, mouth } };
}
