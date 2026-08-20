/**
 * Operator-placed geometry for the New task composer.
 *
 * The panel opens centered near the top at a fixed 560px, which is right for a
 * first glance and wrong once you want to read the page behind it or type more
 * than a sentence. Position and size are personal window chrome — they live in
 * this browser profile (localStorage), not in broker state, the same way the
 * rail's pin/archive prefs do.
 *
 * Null means "wherever the backdrop puts it": the default is never written to
 * storage, so an operator who never drags keeps the centered panel forever.
 */

export type ComposerFrame = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ComposerViewport = { width: number; height: number };

/** Resizing only grows right/down, so the panel never walks away from the grip. */
export type ComposerResizeEdge = "e" | "s" | "se";

const STORAGE_KEY = "scout:newchat:frame:v1";

/**
 * At and below this the panel goes full-bleed (see the `620px` query in
 * agents-rail.css) and there is nothing left to place, so dragging is off.
 */
export const COMPOSER_FRAME_MIN_VIEWPORT = 620;
export const COMPOSER_MIN_WIDTH = 420;
export const COMPOSER_MIN_HEIGHT = 300;
/** Backdrop kept visible on every side so a panel can never be lost off-screen. */
const EDGE_MARGIN = 12;

/** Head + project bar + toolbar around the draft, at the default panel height. */
const COMPOSER_INPUT_CHROME = 210;
/** Matches the standing `min-height` for the draft field in agents-rail.css. */
export const COMPOSER_INPUT_MIN_HEIGHT = 154;

export function composerFrameEnabled(viewportWidth: number): boolean {
  return viewportWidth > COMPOSER_FRAME_MIN_VIEWPORT;
}

/**
 * Resolve the frame to show at the current viewport width. A narrow viewport
 * temporarily goes full-bleed, while widening restores the stored placement
 * even though the live frame was cleared at the mobile breakpoint.
 */
export function resolveComposerFrameForViewport(
  current: ComposerFrame | null,
  stored: ComposerFrame | null,
  viewport: ComposerViewport,
): ComposerFrame | null {
  if (!composerFrameEnabled(viewport.width)) return null;
  const candidate = current ?? stored;
  return candidate ? clampComposerFrame(candidate, viewport) : null;
}

/**
 * The draft field takes whatever height the chrome does not. Without this a
 * taller panel would just grow empty space under a 154px textarea.
 */
export function composerInputMinHeight(frame: ComposerFrame | null): number | null {
  if (!frame) return null;
  return Math.max(COMPOSER_INPUT_MIN_HEIGHT, Math.round(frame.height - COMPOSER_INPUT_CHROME));
}

function clampAxis(value: number, extent: number, viewportExtent: number): number {
  const max = viewportExtent - extent - EDGE_MARGIN;
  return Math.round(Math.max(EDGE_MARGIN, Math.min(value, max)));
}

export function clampComposerFrame(
  frame: ComposerFrame,
  viewport: ComposerViewport,
): ComposerFrame {
  const width = Math.round(Math.max(
    COMPOSER_MIN_WIDTH,
    Math.min(frame.width, Math.max(COMPOSER_MIN_WIDTH, viewport.width - EDGE_MARGIN * 2)),
  ));
  const height = Math.round(Math.max(
    COMPOSER_MIN_HEIGHT,
    Math.min(frame.height, Math.max(COMPOSER_MIN_HEIGHT, viewport.height - EDGE_MARGIN * 2)),
  ));
  return {
    x: clampAxis(frame.x, width, viewport.width),
    y: clampAxis(frame.y, height, viewport.height),
    width,
    height,
  };
}

export function moveComposerFrame(
  base: ComposerFrame,
  dx: number,
  dy: number,
  viewport: ComposerViewport,
): ComposerFrame {
  return clampComposerFrame({ ...base, x: base.x + dx, y: base.y + dy }, viewport);
}

export function resizeComposerFrame(
  base: ComposerFrame,
  dx: number,
  dy: number,
  edge: ComposerResizeEdge,
  viewport: ComposerViewport,
): ComposerFrame {
  const width = edge === "s" ? base.width : base.width + dx;
  const height = edge === "e" ? base.height : base.height + dy;
  return clampComposerFrame({ ...base, width, height }, viewport);
}

function isFiniteFrame(value: unknown): value is ComposerFrame {
  if (!value || typeof value !== "object") return false;
  const frame = value as Partial<ComposerFrame>;
  return (["x", "y", "width", "height"] as const).every(
    (key) => typeof frame[key] === "number" && Number.isFinite(frame[key]),
  );
}

export function parseComposerFrame(raw: string | null): ComposerFrame | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isFiniteFrame(parsed)) return null;
    return { x: parsed.x, y: parsed.y, width: parsed.width, height: parsed.height };
  } catch {
    return null;
  }
}

export function readStoredComposerFrame(): ComposerFrame | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return parseComposerFrame(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

/** Null clears the stored placement — the panel goes back to centered. */
export function writeStoredComposerFrame(frame: ComposerFrame | null): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (!frame) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(frame));
  } catch {
    // Storage is a convenience here; a private-mode failure must not break drag.
  }
}
