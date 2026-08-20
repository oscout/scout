import { describe, expect, it } from "bun:test";
import {
  GESTURE_SLOP_PX,
  LONG_PRESS_MS,
  SWIPE_COMMIT_PX,
  SWIPE_CUE_PX,
  SWIPE_MAX_PX,
  SWIPE_RESISTANCE,
  armsLongPress,
  exceedsSlop,
  releaseOutcome,
  showsSwipeCue,
  swipeOffset,
} from "./gesture-machine.ts";

/** §6.3 — swipe-reply thresholds and F17 overlay-open inertness.
 *
 * These were device-tested and nothing more, which meant the numbers could drift
 * and only a person tapping a phone would find out. Every assertion below runs
 * the same functions the surface runs.
 *
 * `swipeOffset` returns the DAMPED offset, so the raw travel that commits a
 * reply is `42 / 0.72 ≈ 58.4px`, not 42px. The tests are written in raw finger
 * terms where that is what the operator would feel, and the helper below does
 * the conversion once so no individual case hand-rolls it wrong. */

/** Raw horizontal travel that lands exactly on a given damped offset. */
const rawFor = (damped: number) => damped / SWIPE_RESISTANCE;

/** A committed release: drag horizontally by `dx`, lift, report the outcome. */
function release(dx: number, dy = 0, context = { focused: false, canReply: true }) {
  return releaseOutcome(swipeOffset(dx, dy, context) ?? 0);
}

describe("swipe-reply commit threshold", () => {
  it("commits at exactly the threshold, not one pixel past it", () => {
    // `>=`, not `>`. A gesture that lands precisely on the line is a commit.
    expect(releaseOutcome(SWIPE_COMMIT_PX)).toBe("commit");
    expect(release(rawFor(SWIPE_COMMIT_PX))).toBe("commit");
  });

  it("cancels below the threshold and settles rather than snapping", () => {
    expect(releaseOutcome(SWIPE_COMMIT_PX - 0.5)).toBe("settle");
    expect(release(rawFor(SWIPE_COMMIT_PX) - 1)).toBe("settle");
  });

  it("distinguishes an abandoned drag from a press that never moved", () => {
    // Both are "no reply", but only one has travel to animate back. Settling a
    // bubble that never left rest is a visible flicker on tap.
    expect(releaseOutcome(0)).toBe("rest");
    expect(release(0)).toBe("rest");
    expect(releaseOutcome(1)).toBe("settle");
  });

  it("keeps commit well above the cue, so the cue is a warning not a promise", () => {
    expect(SWIPE_CUE_PX).toBeLessThan(SWIPE_COMMIT_PX);
    expect(showsSwipeCue(SWIPE_CUE_PX + 1, { focused: false })).toBe(true);
    expect(showsSwipeCue(SWIPE_CUE_PX, { focused: false })).toBe(false);
  });

  it("costs more finger than it moves bubble, and stops following at the ceiling", () => {
    expect(rawFor(SWIPE_COMMIT_PX)).toBeGreaterThan(SWIPE_COMMIT_PX);
    expect(swipeOffset(10_000, 0, { focused: false, canReply: true })).toBe(SWIPE_MAX_PX);
  });
});

describe("vertical-dominant drags belong to the transcript", () => {
  it("rejects a drag with more vertical travel than horizontal", () => {
    expect(swipeOffset(30, 60, { focused: false, canReply: true })).toBeNull();
    expect(release(30, 60)).toBe("rest");
  });

  it("rejects the ambiguous 45° drag rather than stealing it from the scroll", () => {
    expect(swipeOffset(40, 40, { focused: false, canReply: true })).toBeNull();
  });

  it("accepts a shallow drag that is clearly horizontal", () => {
    expect(swipeOffset(60, 10, { focused: false, canReply: true })).toBeCloseTo(60 * SWIPE_RESISTANCE, 5);
  });

  it("never tracks a leftward drag — reply is a right-swipe only", () => {
    expect(swipeOffset(-80, 0, { focused: false, canReply: true })).toBeNull();
  });

  it("kills the long-press once a press has moved past the slop", () => {
    expect(exceedsSlop(0, 0)).toBe(false);
    expect(exceedsSlop(GESTURE_SLOP_PX, GESTURE_SLOP_PX)).toBe(false);
    expect(exceedsSlop(GESTURE_SLOP_PX + 1, 0)).toBe(true);
    // The vertical scroll case: P0.8(b), a scroll starting on a message body.
    expect(exceedsSlop(0, GESTURE_SLOP_PX + 1)).toBe(true);
  });

  it("holds the long-press at a duration a deliberate press can clear", () => {
    expect(LONG_PRESS_MS).toBe(420);
  });
});

describe("F17 — an open overlay makes the transcript gesture-inert", () => {
  const focused = { focused: true, canReply: true };

  it("refuses to track a swipe while a layer owns input", () => {
    // Same drag, only `focused` differs — this is the whole rule.
    expect(swipeOffset(80, 0, { focused: false, canReply: true })).not.toBeNull();
    expect(swipeOffset(80, 0, focused)).toBeNull();
  });

  it("refuses even a drag that would otherwise commit", () => {
    expect(release(rawFor(SWIPE_COMMIT_PX) + 20, 0, focused)).toBe("rest");
  });

  it("shows no reply cue while focused, whatever the offset", () => {
    expect(showsSwipeCue(SWIPE_MAX_PX, { focused: true })).toBe(false);
  });

  it("does not arm a new long-press on a message already lifted", () => {
    expect(armsLongPress({ focused: false })).toBe(true);
    expect(armsLongPress({ focused: true })).toBe(false);
  });
});

describe("swipe is inert when there is nothing to reply to", () => {
  it("does not track when the host cannot stage a reply", () => {
    expect(swipeOffset(80, 0, { focused: false, canReply: false })).toBeNull();
  });
});
