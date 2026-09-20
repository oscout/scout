/**
 * Crew gaze — the eyes follow the pointer.
 *
 * Gaze is attention, not status. The ring says what a member is doing; the eyes
 * only say where it is looking, so this module never reads state and never
 * writes it. It quantises a pointer vector into the eight directions the eye
 * sheets can draw, with a dead zone under the cursor so nothing twitches, and
 * it hands the direction back to the avatar as a sheet ROLE with fallbacks —
 * a member whose sheet has no `look-down` yet rests instead of guessing.
 *
 * One window listener serves every coin on the page. Subscribers are notified
 * at most once per animation frame, and each measures its own rect only every
 * `RECT_TTL_MS`, so a screen of forty coins costs forty rect reads a quarter
 * second, not forty per pointer event.
 */

export type GazeDir =
  | "rest"
  | "left"
  | "right"
  | "up"
  | "down"
  | "up-left"
  | "up-right"
  | "down-left"
  | "down-right";

/** Pixels around the coin centre where the eyes stay at rest. */
export const GAZE_DEAD_ZONE_PX = 40;
/** Pointer silence after which the eyes return to rest. */
export const GAZE_IDLE_MS = 1500;
/** How long a measured coin rect stays trusted. */
const RECT_TTL_MS = 250;

/**
 * Quantise a pointer offset (screen px, y down) into eight directions.
 *
 * Sectors are 45° wide and centred on each direction, so `up` covers
 * 67.5°–112.5° above the centre and the diagonals get the same share as the
 * cardinals. Ties inside the dead zone are rest.
 */
export function quantizeGaze(dx: number, dy: number, deadZone = GAZE_DEAD_ZONE_PX): GazeDir {
  if (Math.hypot(dx, dy) < deadZone) return "rest";
  // atan2 with y down: 0 = right, +90 = down. Fold to 0..360 with 0 = right,
  // going clockwise on screen.
  const deg = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
  const sector = Math.round(deg / 45) % 8;
  return (
    [
      "right",
      "down-right",
      "down",
      "down-left",
      "left",
      "up-left",
      "up",
      "up-right",
    ] as const
  )[sector];
}

/**
 * The sheet role that draws a direction, given the roles a sheet actually has.
 *
 * Fallback order: the exact `look-<dir>`; for a diagonal, the horizontal half
 * then the vertical half; otherwise rest (no patch). Missing frames read as a
 * member that has not turned yet, never as a wrong turn.
 */
export function gazeRole(dir: GazeDir, roles: readonly string[] | undefined): string | undefined {
  if (dir === "rest" || !roles || roles.length === 0) return undefined;
  const has = (role: string) => roles.includes(role);
  const exact = `look-${dir}`;
  if (has(exact)) return exact;
  const [vertical, horizontal] = dir.split("-");
  if (horizontal) {
    if (has(`look-${horizontal}`)) return `look-${horizontal}`;
    if (has(`look-${vertical}`)) return `look-${vertical}`;
  }
  return undefined;
}

export interface PointerSample {
  x: number;
  y: number;
  /** `performance.now()` of the event; 0 when the pointer left the page. */
  at: number;
  gone: boolean;
}

type Listener = (sample: PointerSample) => void;

const listeners = new Set<Listener>();
let last: PointerSample = { x: 0, y: 0, at: 0, gone: true };
let frame = 0;
let attached = false;

function flush() {
  frame = 0;
  for (const cb of listeners) cb(last);
}

function onMove(event: PointerEvent) {
  last = { x: event.clientX, y: event.clientY, at: performance.now(), gone: false };
  if (!frame) frame = window.requestAnimationFrame(flush);
}

function onLeave() {
  last = { ...last, gone: true };
  if (!frame) frame = window.requestAnimationFrame(flush);
}

function attach() {
  if (attached || typeof window === "undefined") return;
  attached = true;
  window.addEventListener("pointermove", onMove, { passive: true });
  // A tap is a look too: touch has no hover, and a click carries a position.
  window.addEventListener("pointerdown", onMove, { passive: true });
  document.addEventListener("pointerleave", onLeave);
  window.addEventListener("blur", onLeave);
}

function detach() {
  if (!attached) return;
  attached = false;
  window.removeEventListener("pointermove", onMove);
  window.removeEventListener("pointerdown", onMove);
  document.removeEventListener("pointerleave", onLeave);
  window.removeEventListener("blur", onLeave);
  if (frame) {
    window.cancelAnimationFrame(frame);
    frame = 0;
  }
}

/** Subscribe to pointer samples (one shared listener, one callback per frame). */
export function subscribePointer(cb: Listener): () => void {
  listeners.add(cb);
  attach();
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0) detach();
  };
}

export interface GazeTracker {
  /** Feed a pointer sample; returns the direction the eyes should take now. */
  sample(p: PointerSample, rect: () => DOMRect | null): GazeDir;
}

/** Radius around the coin centre inside which the eyes follow the pointer. */
export function gazeRadius(size: number): number {
  return Math.max(160, size * 4);
}

/**
 * Per-coin tracker: the pointer must be within `gazeRadius(size)` of the coin
 * centre for the eyes to follow; further away the member looks at its own
 * work. The rect is measured lazily and trusted for a quarter second so a
 * scroll still lands within a frame or two. Idle return-to-rest is the
 * caller's timer: it needs the clock, this needs none.
 */
export function createGazeTracker(size: number): GazeTracker {
  const radius = gazeRadius(size);
  let rect: DOMRect | null = null;
  let measuredAt = 0;

  return {
    sample(p, measure) {
      if (p.gone) return "rest";
      if (!rect || p.at - measuredAt > RECT_TTL_MS) {
        rect = measure();
        measuredAt = p.at;
      }
      if (!rect || rect.width === 0) return "rest";
      const dx = p.x - (rect.left + rect.width / 2);
      const dy = p.y - (rect.top + rect.height / 2);
      if (Math.hypot(dx, dy) > radius) return "rest";
      return quantizeGaze(dx, dy);
    },
  };
}

/* ── Attention — the crew glances at what you are doing ─────────────────── */

/** How long a glance at the attention target holds before the blink and rest. */
export const GAZE_GLANCE_MS = 1400;

export interface AttentionTarget {
  /** Viewport centre of the thing that has the operator's attention. */
  x: number;
  y: number;
  at: number;
}

type AttentionListener = (target: AttentionTarget | null) => void;
const attentionListeners = new Set<AttentionListener>();
let attention: AttentionTarget | null = null;

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/**
 * Declare what has the operator's attention — the composer that just took
 * focus, typically — or clear it with `null`. Every subscribed coin hears the
 * same notification at the same moment, which is what makes the glance read
 * as one crew turning together rather than a set of independent twitches.
 */
export function setAttentionTarget(el: Element | null): void {
  const rect = el?.getBoundingClientRect();
  attention = rect && rect.width > 0
    ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, at: now() }
    : null;
  for (const cb of attentionListeners) cb(attention);
}

export function currentAttentionTarget(): AttentionTarget | null {
  return attention;
}

/** Subscribe to attention changes. Fires on change only, never on subscribe. */
export function subscribeAttention(cb: AttentionListener): () => void {
  attentionListeners.add(cb);
  return () => {
    attentionListeners.delete(cb);
  };
}

/**
 * Direction from a coin toward a point, with the usual dead zone and no
 * radius: attention carries across the whole page, the pointer does not.
 */
export function glanceToward(target: { x: number; y: number }, rect: DOMRect | null): GazeDir {
  if (!rect || rect.width === 0) return "rest";
  return quantizeGaze(target.x - (rect.left + rect.width / 2), target.y - (rect.top + rect.height / 2));
}
