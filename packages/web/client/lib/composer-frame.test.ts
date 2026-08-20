import { describe, expect, test } from "bun:test";

import {
  COMPOSER_INPUT_MIN_HEIGHT,
  COMPOSER_MIN_HEIGHT,
  COMPOSER_MIN_WIDTH,
  clampComposerFrame,
  composerFrameEnabled,
  composerInputMinHeight,
  moveComposerFrame,
  parseComposerFrame,
  resolveComposerFrameForViewport,
  resizeComposerFrame,
} from "./composer-frame.ts";

const VIEWPORT = { width: 1440, height: 900 };

describe("clampComposerFrame", () => {
  test("keeps a placed panel fully on screen", () => {
    const frame = clampComposerFrame(
      { x: 1400, y: 880, width: 560, height: 420 },
      VIEWPORT,
    );
    expect(frame.x + frame.width).toBeLessThanOrEqual(VIEWPORT.width);
    expect(frame.y + frame.height).toBeLessThanOrEqual(VIEWPORT.height);
  });

  test("pulls a negative origin back inside the viewport", () => {
    const frame = clampComposerFrame({ x: -400, y: -200, width: 560, height: 420 }, VIEWPORT);
    expect(frame.x).toBeGreaterThan(0);
    expect(frame.y).toBeGreaterThan(0);
  });

  test("floors the panel at its minimum size", () => {
    const frame = clampComposerFrame({ x: 40, y: 40, width: 120, height: 90 }, VIEWPORT);
    expect(frame.width).toBe(COMPOSER_MIN_WIDTH);
    expect(frame.height).toBe(COMPOSER_MIN_HEIGHT);
  });

  test("caps the panel at the viewport even when the stored frame is larger", () => {
    const frame = clampComposerFrame({ x: 0, y: 0, width: 4000, height: 4000 }, VIEWPORT);
    expect(frame.width).toBeLessThan(VIEWPORT.width);
    expect(frame.height).toBeLessThan(VIEWPORT.height);
  });

  test("survives a viewport smaller than the minimum panel", () => {
    const frame = clampComposerFrame({ x: 200, y: 200, width: 560, height: 420 }, {
      width: 320,
      height: 240,
    });
    expect(frame.width).toBe(COMPOSER_MIN_WIDTH);
    expect(frame.height).toBe(COMPOSER_MIN_HEIGHT);
    expect(Number.isFinite(frame.x)).toBe(true);
    expect(Number.isFinite(frame.y)).toBe(true);
  });
});

describe("moveComposerFrame", () => {
  test("translates by the pointer delta", () => {
    const moved = moveComposerFrame({ x: 200, y: 120, width: 560, height: 420 }, 60, -40, VIEWPORT);
    expect(moved).toMatchObject({ x: 260, y: 80, width: 560, height: 420 });
  });
});

describe("resizeComposerFrame", () => {
  const base = { x: 200, y: 120, width: 560, height: 420 };

  test("east grows width only", () => {
    expect(resizeComposerFrame(base, 120, 90, "e", VIEWPORT)).toMatchObject({
      width: 680,
      height: 420,
    });
  });

  test("south grows height only", () => {
    expect(resizeComposerFrame(base, 120, 90, "s", VIEWPORT)).toMatchObject({
      width: 560,
      height: 510,
    });
  });

  test("corner grows both and keeps the origin pinned", () => {
    const next = resizeComposerFrame(base, 120, 90, "se", VIEWPORT);
    expect(next).toMatchObject({ x: 200, y: 120, width: 680, height: 510 });
  });
});

describe("composerInputMinHeight", () => {
  test("is null while the panel is unplaced", () => {
    expect(composerInputMinHeight(null)).toBeNull();
  });

  test("never drops below the standing draft height", () => {
    const min = composerInputMinHeight({ x: 0, y: 0, width: 560, height: COMPOSER_MIN_HEIGHT });
    expect(min).toBe(COMPOSER_INPUT_MIN_HEIGHT);
  });

  test("hands extra panel height to the draft", () => {
    const shorter = composerInputMinHeight({ x: 0, y: 0, width: 560, height: 500 }) ?? 0;
    const taller = composerInputMinHeight({ x: 0, y: 0, width: 560, height: 800 }) ?? 0;
    expect(taller - shorter).toBe(300);
  });
});

describe("parseComposerFrame", () => {
  test("round-trips a stored frame", () => {
    expect(parseComposerFrame(JSON.stringify({ x: 1, y: 2, width: 3, height: 4 })))
      .toEqual({ x: 1, y: 2, width: 3, height: 4 });
  });

  test("rejects junk, partials, and non-finite numbers", () => {
    expect(parseComposerFrame(null)).toBeNull();
    expect(parseComposerFrame("not json")).toBeNull();
    expect(parseComposerFrame(JSON.stringify({ x: 1, y: 2 }))).toBeNull();
    expect(parseComposerFrame(JSON.stringify({ x: 1, y: 2, width: 3, height: null }))).toBeNull();
  });
});

describe("composerFrameEnabled", () => {
  test("is off through the full-bleed breakpoint and on above it", () => {
    expect(composerFrameEnabled(480)).toBe(false);
    expect(composerFrameEnabled(620)).toBe(false);
    expect(composerFrameEnabled(621)).toBe(true);
    expect(composerFrameEnabled(1440)).toBe(true);
  });
});

describe("resolveComposerFrameForViewport", () => {
  const stored = { x: 200, y: 120, width: 560, height: 420 };

  test("goes full-bleed below the placement breakpoint", () => {
    expect(resolveComposerFrameForViewport(stored, stored, { width: 480, height: 800 }))
      .toBeNull();
  });

  test("restores the stored frame after widening from full-bleed", () => {
    expect(resolveComposerFrameForViewport(null, stored, VIEWPORT)).toEqual(stored);
  });

  test("keeps the current frame ahead of an older stored frame", () => {
    const current = { ...stored, x: 320 };
    expect(resolveComposerFrameForViewport(current, stored, VIEWPORT)).toEqual(current);
  });
});
