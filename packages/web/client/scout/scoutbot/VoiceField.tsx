import { useCallback, useEffect, useRef } from "react";

import {
  VOICE_FIELD_COLS,
  VOICE_FIELD_ROWS,
  VOICE_FIELD_STILL_T,
  voiceCoverage,
  voiceOccupied,
  voiceToneIndex,
  type VoiceFieldPhase,
} from "./voice-field.ts";

const FPS = 24;
const TONES = [
  "oklch(0.38 0.012 80)",
  "oklch(0.52 0.016 85)",
  "oklch(0.66 0.03 95)",
  "oklch(0.78 0.06 110)",
  "oklch(0.86 0.17 125)",
] as const;

export type { VoiceFieldPhase };

function paint(
  ctx: CanvasRenderingContext2D,
  t: number,
  phase: VoiceFieldPhase,
  dpr: number,
  cell: number,
) {
  const w = VOICE_FIELD_COLS * cell;
  const h = VOICE_FIELD_ROWS * cell;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.font = `${cell - 1}px ui-monospace, "JetBrains Mono", Menlo, monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let y = 0; y < VOICE_FIELD_ROWS; y++) {
    for (let x = 0; x < VOICE_FIELD_COLS; x++) {
      const coverage = voiceCoverage(x, y, t, phase);
      if (!voiceOccupied(coverage, x, y)) continue;
      ctx.fillStyle = TONES[voiceToneIndex(coverage)];
      ctx.fillText(coverage > 0.42 ? "░" : "·", (x + 0.5) * cell, (y + 0.5) * cell + 0.5);
    }
  }
}

export function VoiceField({
  phase,
  label,
  size = "dock",
}: {
  phase: VoiceFieldPhase;
  label: string;
  size?: "dock" | "stage";
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const cell = size === "stage" ? 11 : 8;

  const draw = useCallback((t: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    paint(ctx, t, phaseRef.current, window.devicePixelRatio || 1, cell);
  }, [cell]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = VOICE_FIELD_COLS * cell * dpr;
    canvas.height = VOICE_FIELD_ROWS * cell * dpr;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    let raf = 0;
    let last = 0;
    const loop = (ts: number) => {
      raf = requestAnimationFrame(loop);
      if (reduce.matches || phaseRef.current === "ready") {
        draw(VOICE_FIELD_STILL_T);
        return;
      }
      if (ts - last < 1000 / FPS) return;
      last = ts;
      draw(VOICE_FIELD_STILL_T + ts / 1000);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [draw, phase, cell]);

  const px = VOICE_FIELD_COLS * cell;
  return (
    <canvas
      ref={canvasRef}
      width={px}
      height={px}
      role="img"
      aria-label={label}
      className="pointer-events-none block rounded-full"
      style={{ width: px, height: px }}
    />
  );
}
