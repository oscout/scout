/**
 * Figures you place: what the page decides for a pinned figure the operator
 * can drag anywhere on its display. The host owns placement (it reads the
 * windows and the modifier keys); this module only turns the host's answers
 * into sizes, motion, layers and popover spots.
 *
 * Pure functions only, so it is testable without a DOM.
 */

import type {
  CompanionFigure,
  CompanionFigureAnchor,
  CompanionFigureDefaults,
  CompanionFigureMotion,
  CompanionSide,
} from "../../lib/companion-host.ts";
import { EDGE_SLOT } from "./edge-model.ts";

export const FIGURE_SIZE_PRESETS = [16, 24, 32, 48, 64] as const;
export const FIGURE_MOTIONS: readonly CompanionFigureMotion[] = ["full", "calm", "still"];
export const FIGURE_MOTION_LABEL: Record<CompanionFigureMotion, string> = { full: "Full", calm: "Calm", still: "Still" };
/** A press that moves this far or less is a click, as on the host. */
export const FIGURE_CLICK_SLOP = 4;
/** The ⇧ fall, and a window that went away. Ease-in; instant under Reduce Motion. */
export const FIGURE_FALL_MS = 520;

export function figureSize(figure: CompanionFigure | undefined, defaults: CompanionFigureDefaults): number {
  return figure?.size ?? defaults.size;
}

/** Reduce Motion forces Still, whatever the figure says. */
export function figureMotion(figure: CompanionFigure | undefined, defaults: CompanionFigureDefaults, reduced: boolean): CompanionFigureMotion {
  return reduced ? "still" : figure?.motion ?? defaults.motion;
}

/** Hit target for a figure: never narrower than the classic slot. */
export function figureSlot(size: number): { width: number; height: number } {
  return { width: Math.max(EDGE_SLOT, Math.round(size * 1.25)), height: size + 10 };
}

/**
 * Where a pinned or surfaced figure shows:
 *   row     — in the home row by the mark
 *   placed  — where the operator put it (the host gave its anchor)
 *   waiting — placed, but its spot is unknown or its window is on another Space
 *   hidden  — the operator hid it
 * Surfaced work has no figure settings and always stands in the row.
 */
export type FigureWhere = "row" | "placed" | "waiting" | "hidden";

export function figureWhere(figure: CompanionFigure | undefined): FigureWhere {
  if (!figure) return "row";
  if (figure.hidden) return "hidden";
  if (figure.placement.kind === "home") return "row";
  if (!figure.anchor || figure.anchor.away) return "waiting";
  return "placed";
}

/** Feet first: the rotation that points the figure's feet at `down`. */
export function figureRotation(down: CompanionSide | null): number {
  switch (down) {
    case "top": return 180;
    case "left": return 90;
    case "right": return -90;
    default: return 0;
  }
}

/** A drag the host tracked is not also a click on the figure. */
export function isFigureClick(down: { x: number; y: number } | null, up: { x: number; y: number }): boolean {
  if (!down) return true;
  return Math.hypot(up.x - down.x, up.y - down.y) <= FIGURE_CLICK_SLOP;
}

/** Arrow keys nudge a placed figure 1pt, 10pt with ⇧. Page +y is down. */
export function figureNudge(key: string, shift: boolean): { dx: number; dy: number } | null {
  const step = shift ? 10 : 1;
  switch (key) {
    case "ArrowLeft": return { dx: -step, dy: 0 };
    case "ArrowRight": return { dx: step, dy: 0 };
    case "ArrowUp": return { dx: 0, dy: -step };
    case "ArrowDown": return { dx: 0, dy: step };
    default: return null;
  }
}

/**
 * A popover beside a placed figure: above it when there is room, else below,
 * kept on screen horizontally. `size` is the figure's height.
 */
export function placedPopover(
  anchor: Pick<CompanionFigureAnchor, "x" | "y" | "down">,
  size: number,
  popWidth: number,
  screen: { width: number; height: number },
  margin = 12,
): { left: number; top?: number; bottom?: number; maxHeight: number } {
  const left = Math.max(margin, Math.min(screen.width - popWidth - margin, anchor.x - popWidth / 2));
  // The figure's body is above its feet when upright, below when hanging.
  const bodyTop = anchor.down === "top" ? anchor.y : anchor.y - size;
  const bodyBottom = anchor.down === "top" ? anchor.y + size : anchor.y;
  const above = bodyTop - margin * 2;
  const below = screen.height - bodyBottom - margin * 2;
  if (above >= Math.min(320, below) || above >= 240) {
    return { left, bottom: screen.height - bodyTop + margin, maxHeight: Math.max(120, above) };
  }
  return { left, top: bodyBottom + margin, maxHeight: Math.max(120, below) };
}

/**
 * Where a work popover opens. A placed figure opens beside its own anchor,
 * whatever the home row is doing; a row figure opens above its spot (or the
 * "+N" slot it overflowed into). null: nowhere to open it.
 */
export function workPopoverSpot<A extends { x: number }>(
  rowX: number | null | undefined,
  placed: A | null | undefined,
): { x: number; placed: A | null } | null {
  if (placed) return { x: placed.x, placed };
  if (rowX === null || rowX === undefined) return null;
  return { x: rowX, placed: null };
}

/** Pinned figures the operator hid, for the mark's "N hidden". */
export function hiddenFigures(figures: readonly CompanionFigure[]): string[] {
  return figures.filter((figure) => figure.hidden).map((figure) => figure.workId);
}
