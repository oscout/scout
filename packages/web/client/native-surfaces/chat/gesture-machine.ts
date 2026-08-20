/** Swipe-reply and long-press arithmetic for the transcript — pure, and with no
 * React import so a test can exercise it without a renderer.
 *
 * These numbers used to live inline in `MessageBubble`'s JSX handlers. That made
 * them untestable in the only way that counts: a test could restate `>= 42` and
 * stay green while the handler drifted to `>= 52`. The rule here is the one the
 * surface actually runs, so a regression has somewhere to fail.
 *
 * The one thing worth reading twice: **the thresholds apply to the damped
 * offset, not to the finger.** `swipeOffset` multiplies raw travel by
 * `SWIPE_RESISTANCE`, so committing a reply costs ~58px of real thumb, not 42.
 * Comparing a raw delta against `SWIPE_COMMIT_PX` is the mistake this module
 * exists to make hard. */

/** Damped px past which a release commits the reply. */
export const SWIPE_COMMIT_PX = 42;
/** Damped px past which the reply arrow shows. Below it the gesture is silent. */
export const SWIPE_CUE_PX = 18;
/** Travel ceiling — the bubble stops following well before the screen edge. */
export const SWIPE_MAX_PX = 62;
/** Finger-to-bubble ratio. Drag feels attached but costs more than it moves. */
export const SWIPE_RESISTANCE = 0.72;
/** Hold that lifts a message into the focus layer. */
export const LONG_PRESS_MS = 420;
/** Movement past which a press is a drag, and the long-press timer is dead. */
export const GESTURE_SLOP_PX = 9;

export interface SwipeContext {
  /** True when this bubble is the one lifted into the focus layer. */
  focused: boolean;
  /** False when the host cannot stage a reply — then there is nothing to swipe to. */
  canReply: boolean;
}

/** How far the bubble should sit from rest, or `null` for "do not move it".
 *
 * Null covers every inert case in one place: an overlay is open (F17), replying
 * is unavailable, the drag went left, or it is vertically dominant and therefore
 * a scroll the transcript owns. */
export function swipeOffset(dx: number, dy: number, context: SwipeContext): number | null {
  if (context.focused || !context.canReply) return null;
  if (dx <= 0) return null;
  // Ties go to the scroll. A 45° drag is ambiguous, and stealing an ambiguous
  // drag from the transcript is the more annoying of the two failures.
  if (Math.abs(dx) <= Math.abs(dy)) return null;
  return Math.min(SWIPE_MAX_PX, dx * SWIPE_RESISTANCE);
}

/** Whether the reply cue is visible at this offset. */
export function showsSwipeCue(offset: number, context: Pick<SwipeContext, "focused">): boolean {
  return !context.focused && offset > SWIPE_CUE_PX;
}

/** A press that has moved this far is a drag; the long-press must not fire. */
export function exceedsSlop(dx: number, dy: number): boolean {
  return Math.abs(dx) > GESTURE_SLOP_PX || Math.abs(dy) > GESTURE_SLOP_PX;
}

/** Whether a press should arm the long-press timer at all.
 *
 * F17: while a layer owns input, the transcript beneath it does not start new
 * gestures. The lifted copy inside the focus layer is `focused`, so it does not
 * re-arm a hold against itself either. */
export function armsLongPress(context: Pick<SwipeContext, "focused">): boolean {
  return !context.focused;
}

export type ReleaseOutcome =
  /** Past the threshold: stage the reply. Snaps home, nothing to animate. */
  | "commit"
  /** Moved but abandoned: travel back under a transition, interruptibly. */
  | "settle"
  /** Never moved: there is no settle to run, and running one flickers. */
  | "rest";

export function releaseOutcome(offset: number): ReleaseOutcome {
  if (offset >= SWIPE_COMMIT_PX) return "commit";
  return offset > 0 ? "settle" : "rest";
}
