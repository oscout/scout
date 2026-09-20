/**
 * The Scout mark as a field of dots with a wave travelling through it.
 *
 * This is the web port of the native wavefront mark: a pointy-top hexagon
 * *outline* (radius 0.76, gaussian falloff 0.070) around a solid inner hexagon
 * (0.34), sampled onto a 32x28 grid. The shape is a hex, not a ring — a circle
 * of dots is a different logo.
 *
 * The mark is always legible; the wave only brightens it as it passes. The
 * native band reveals the whole mark out of nothing every thirteen seconds,
 * which reads as room tone on a resting stage and as a broken logo on an
 * entrance. Here the field holds a readable floor and one crest crosses it
 * left to right, which is the same travelling wave with the identity cue kept.
 *
 * Every dot's alpha is baked in, and the only thing animated is opacity, so
 * this stays on the compositor. Under `prefers-reduced-motion` the wave stops
 * and the field holds at its crest — the still frame that says the most.
 */

import { useMemo, type CSSProperties } from "react";

import "./scout-shimmer.css";

const COLS = 32;
const ROWS = 28;
/** The mark's own proportions (172x148 at 0.68), so the hex is not stretched. */
const BASE_WIDTH = 117;
const BASE_HEIGHT = 101;
/** Seconds for one crest to cross the mark's width. */
const SWEEP_SECONDS = 1.3;

type HexPoint = readonly [number, number];

const HEX_VERTICES: ReadonlyArray<HexPoint> = Array.from({ length: 6 }, (_, index) => {
  const angle = -Math.PI / 2 + (index * Math.PI) / 3;
  return [0.76 * Math.cos(angle), 0.76 * Math.sin(angle)] as const;
});

function distanceToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 0) return Math.hypot(px - ax, py - ay);
  const t = Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function distanceToHexOutline(x: number, y: number): number {
  let minimum = Infinity;
  for (let index = 0; index < HEX_VERTICES.length; index += 1) {
    const [ax, ay] = HEX_VERTICES[index];
    const [bx, by] = HEX_VERTICES[(index + 1) % HEX_VERTICES.length];
    minimum = Math.min(minimum, distanceToSegment(x, y, ax, ay, bx, by));
  }
  return minimum;
}

function insideHex(x: number, y: number, radius: number): boolean {
  return Math.abs(x) <= radius * 0.866_025_4
    && Math.abs(y) <= radius - Math.abs(x) / 1.732_050_8;
}

interface ShimmerDot {
  key: string;
  /** Percentages, so the field scales without recomputing the geometry. */
  left: string;
  top: string;
  /** Dot diameter in the base box; the renderer scales it. */
  size: number;
  /** Peak opacity at the crest. */
  alpha: number;
  /** Negative seconds: how far this column already is into the cycle. */
  delay: number;
}

function buildDots(): ShimmerDot[] {
  const dots: ShimmerDot[] = [];
  for (let row = 0; row < ROWS; row += 1) {
    for (let col = 0; col < COLS; col += 1) {
      // Sample at cell centres across a square pitch, so the falloff is the
      // mark's and not the grid's.
      const x = ((col + 0.5) / COLS) * 2 - 1;
      const y = ((row + 0.5) / ROWS) * 2 - 1;
      const outline = distanceToHexOutline(x, y);
      const ring = Math.exp(-Math.pow(outline / 0.07, 2));
      const inner = insideHex(x, y, 0.34) ? 1 : 0;
      const density = ring * 0.92 + inner * 0.34;
      if (density < 0.12) continue;
      dots.push({
        key: `${row}-${col}`,
        left: `${(col / COLS) * 100}%`,
        top: `${(row / ROWS) * 100}%`,
        size: density > 0.55 ? 2 : 1.5,
        alpha: Math.min(0.92, 0.24 + density * 0.68),
        delay: -((col / COLS) * SWEEP_SECONDS),
      });
    }
  }
  return dots;
}

export function ScoutShimmerMark({
  className = "",
  width = BASE_WIDTH,
}: {
  className?: string;
  width?: number;
}) {
  const dots = useMemo(buildDots, []);
  const scale = width / BASE_WIDTH;
  return (
    <span
      className={`scout-shimmer${className ? ` ${className}` : ""}`}
      style={{ width, height: BASE_HEIGHT * scale }}
      aria-hidden="true"
    >
      {dots.map((dot) => (
        <i
          key={dot.key}
          className="scout-shimmer-dot"
          style={{
            left: dot.left,
            top: dot.top,
            width: dot.size * scale,
            height: dot.size * scale,
            animationDelay: `${dot.delay}s`,
            "--shimmer-peak": dot.alpha,
          } as CSSProperties}
        />
      ))}
    </span>
  );
}
