/** The chat surface's overlay phase machine — pure, and deliberately free of any
 * React import so a test can load it without pulling in a renderer.
 *
 * Why a machine at all: an overlay that unmounts the instant it is dismissed can
 * only ever animate in. Its exit is a pop, however carefully the entrance was
 * tuned, because the element is gone before a transition can run. So `closing`
 * is a real state the overlay occupies for the length of its exit, and only then
 * does it unmount.
 *
 * Durations live beside the machine rather than in CSS because the unmount timer
 * and the animation have to agree; splitting them across two files is how they
 * drift out of sync. */

export type OverlayPhase = "closed" | "open" | "closing";
export type OverlayEvent = "open" | "close" | "exit-finished";

/** Milliseconds. Kept short — this is furniture moving, not a performance. */
export const MOTION_ENTER_MS = 220;
export const MOTION_EXIT_MS = 160;
/** For things that expand inside an already-open layer (the tray, the emoji
 * grid) — a full entrance would read as a second, competing arrival. */
export const MOTION_QUICK_MS = 140;

export function nextOverlayPhase(current: OverlayPhase, event: OverlayEvent): OverlayPhase {
  switch (event) {
    case "open":
      // Re-opening mid-exit returns to open rather than finishing the close:
      // the operator's second tap wins over the first tap's tail.
      return "open";
    case "close":
      // Closing something already closed is a no-op, not a phantom exit.
      return current === "closed" ? "closed" : "closing";
    case "exit-finished":
      // Only a close in flight may complete. A re-open that raced the timer
      // must not be torn down by it.
      return current === "closing" ? "closed" : current;
  }
}
