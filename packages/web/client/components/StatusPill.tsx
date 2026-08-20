import type { ReactNode } from "react";
import { toneToChipClass, toneToPillClass, type Tone } from "../lib/status-tone.ts";

/**
 * StatusPill renders a small inline status badge using one of two CSS families:
 *
 *   - `variant="pill"` -> `.s-pill .s-pill-<variant>` (work-themed; used in
 *     WorkList / WorkDetailScreen).
 *   - `variant="chip"` -> `.sys-chip .sys-chip-<tone>` (system-themed; used
 *     across BrokerScreen, MeshScreen, SettingsScreen, MeshInspector).
 *
 * Visuals are unchanged: this component only centralizes the JSX so callers no
 * longer hand-stitch class strings.
 */
export type StatusPillProps = {
  tone: Tone;
  children: ReactNode;
  /** Which CSS family to render with. Defaults to `chip`. */
  variant?: "pill" | "chip";
  className?: string;
  title?: string;
};

export function StatusPill({
  tone,
  children,
  variant = "chip",
  className,
  title,
}: StatusPillProps) {
  const base = variant === "pill" ? "s-pill" : "sys-chip";
  const modifier =
    variant === "pill"
      ? `s-pill-${toneToPillClass(tone)}`
      : `sys-chip-${toneToChipClass(tone)}`;
  const composed = className ? `${base} ${modifier} ${className}` : `${base} ${modifier}`;
  return (
    <span className={composed} title={title}>
      {children}
    </span>
  );
}
