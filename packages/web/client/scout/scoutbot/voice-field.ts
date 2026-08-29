/** Physics for the Direct Voice ASCII orb. Keep in lockstep with
 *  `design/studio/views/direct-voice-field.tsx`. */

export type VoiceFieldPhase = "ready" | "listening" | "processing" | "speaking";

export const VOICE_FIELD_COLS = 28;
export const VOICE_FIELD_ROWS = 28;
export const VOICE_FIELD_STILL_T = 2.6;

const BAYER = [
  [0.00, 0.50, 0.125, 0.625],
  [0.75, 0.25, 0.875, 0.375],
  [0.1875, 0.6875, 0.0625, 0.5625],
  [0.9375, 0.4375, 0.8125, 0.3125],
] as const;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

export function voiceCoverage(
  x: number,
  y: number,
  t: number,
  phase: VoiceFieldPhase,
  cols = VOICE_FIELD_COLS,
  rows = VOICE_FIELD_ROWS,
): number {
  const nx = (x + 0.5) / cols - 0.5;
  const ny = (y + 0.5) / rows - 0.5;
  const r = Math.hypot(nx, ny) * 2;
  const th = Math.atan2(ny, nx);
  const disk = smoothstep(1.08, 0.78, r);
  if (disk <= 0) return 0;

  if (phase === "ready") {
    const rim = smoothstep(0.15, 0.72, r);
    return disk * (0.1 + rim * 0.22);
  }

  if (phase === "listening") {
    const wave = Math.pow(Math.max(0, Math.cos(r * 13.5 + t * 2.35)), 3.6);
    const rim = smoothstep(0.12, 0.68, r);
    return disk * (0.1 + rim * 0.32 + wave * 0.58 * rim);
  }

  if (phase === "speaking") {
    const wave = Math.pow(Math.max(0, Math.cos(r * 10.5 - t * 3.05)), 4.2);
    const core = smoothstep(0.92, 0.18, r);
    const lobe = 0.55 + 0.45 * Math.cos(th * 2 + t * 0.45);
    return disk * (0.16 + core * 0.38 + wave * 0.52 * lobe);
  }

  const grain = 0.5 + 0.5 * Math.cos(th * 5 + t * 0.62) * Math.cos(r * 8.5 + 0.4);
  const crawl = 0.5 + 0.5 * Math.cos(x * 0.73 + y * 1.17 + t * 0.95);
  return disk * (0.26 + grain * 0.28 + crawl * 0.22);
}

export function voiceOccupied(coverage: number, x: number, y: number): boolean {
  return coverage > BAYER[y & 3][x & 3] * 0.9;
}

export function voiceToneIndex(coverage: number): number {
  if (coverage > 0.78) return 4;
  if (coverage > 0.58) return 3;
  if (coverage > 0.4) return 2;
  if (coverage > 0.24) return 1;
  return 0;
}
