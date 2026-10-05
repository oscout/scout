import { describe, expect, test } from "bun:test";

import type { CompanionFigure } from "../../lib/companion-host.ts";
import {
  figureMotion,
  figureNudge,
  figureRotation,
  figureSize,
  figureSlot,
  figureWhere,
  hiddenFigures,
  isFigureClick,
  placedPopover,
  workPopoverSpot,
} from "./figure-model.ts";

const defaults = { size: 24, motion: "full" as const };

function figure(patch: Partial<CompanionFigure> = {}): CompanionFigure {
  return { workId: "work-1", size: null, motion: null, hidden: false, placement: { kind: "home" }, anchor: null, label: "Home row", ...patch };
}

describe("figure settings", () => {
  test("size and motion follow the defaults unless set; Reduce Motion forces still", () => {
    expect(figureSize(figure(), defaults)).toBe(24);
    expect(figureSize(figure({ size: 64 }), defaults)).toBe(64);
    expect(figureSize(undefined, { size: 32, motion: "calm" })).toBe(32);
    expect(figureMotion(figure(), defaults, false)).toBe("full");
    expect(figureMotion(figure({ motion: "calm" }), defaults, false)).toBe("calm");
    expect(figureMotion(figure({ motion: "full" }), defaults, true)).toBe("still");
  });

  test("hit slots grow with the figure but never shrink below the classic slot", () => {
    expect(figureSlot(16)).toEqual({ width: 30, height: 26 });
    expect(figureSlot(24)).toEqual({ width: 30, height: 34 });
    expect(figureSlot(64)).toEqual({ width: 80, height: 74 });
  });

  test("hidden figures are counted for the mark", () => {
    expect(hiddenFigures([figure(), figure({ workId: "work-2", hidden: true })])).toEqual(["work-2"]);
  });
});

describe("where a figure shows", () => {
  const anchor = { x: 10, y: 10, down: "bottom" as const, covered: false, away: false };
  test("row, placed, waiting or hidden", () => {
    expect(figureWhere(undefined)).toBe("row");
    expect(figureWhere(figure())).toBe("row");
    expect(figureWhere(figure({ hidden: true, placement: { kind: "free", x: 0.5, y: 0.5 }, anchor }))).toBe("hidden");
    expect(figureWhere(figure({ placement: { kind: "free", x: 0.5, y: 0.5 }, anchor }))).toBe("placed");
    expect(figureWhere(figure({ placement: { kind: "free", x: 0.5, y: 0.5 }, anchor: { ...anchor, covered: true } }))).toBe("placed");
    expect(figureWhere(figure({ placement: { kind: "window", side: "top", t: 0.5 }, anchor: { ...anchor, away: true } }))).toBe("waiting");
    expect(figureWhere(figure({ placement: { kind: "window", side: "top", t: 0.5 }, anchor: null }))).toBe("waiting");
  });

  test("feet first", () => {
    expect(figureRotation(null)).toBe(0);
    expect(figureRotation("bottom")).toBe(0);
    expect(figureRotation("top")).toBe(180);
    expect(figureRotation("left")).toBe(90);
    expect(figureRotation("right")).toBe(-90);
  });
});

describe("input", () => {
  test("a press that moved more than 4pt is a drag, not a click", () => {
    expect(isFigureClick({ x: 0, y: 0 }, { x: 3, y: 2 })).toBe(true);
    expect(isFigureClick({ x: 0, y: 0 }, { x: 4, y: 3 })).toBe(false);
    expect(isFigureClick(null, { x: 40, y: 40 })).toBe(true);
  });

  test("arrows nudge 1pt, 10pt with shift", () => {
    expect(figureNudge("ArrowLeft", false)).toEqual({ dx: -1, dy: 0 });
    expect(figureNudge("ArrowDown", true)).toEqual({ dx: 0, dy: 10 });
    expect(figureNudge("Enter", false)).toBeNull();
  });
});

describe("placed popover", () => {
  const screen = { width: 1512, height: 982 };
  test("above a figure with room, below one near the top, always on screen", () => {
    expect(placedPopover({ x: 700, y: 600, down: "bottom" }, 24, 348, screen)).toEqual({ left: 526, bottom: 418, maxHeight: 552 });
    expect(placedPopover({ x: 20, y: 60, down: "bottom" }, 24, 348, screen)).toEqual({ left: 12, top: 72, maxHeight: 898 });
    // Hanging from the top edge: the body is below the feet.
    expect(placedPopover({ x: 1500, y: 33, down: "top" }, 24, 348, screen)).toEqual({ left: 1152, top: 69, maxHeight: 901 });
  });
});

describe("work popover spot", () => {
  test("a placed figure opens beside its anchor even with no home-row spot or overflow stack", () => {
    const anchor = { x: 640, y: 300, down: "bottom" as const, covered: false, away: false };
    expect(workPopoverSpot(null, anchor)).toEqual({ x: 640, placed: anchor });
    expect(workPopoverSpot(undefined, anchor)).toEqual({ x: 640, placed: anchor });
    // The anchor wins over a stale row or "+N" position.
    expect(workPopoverSpot(90, anchor)).toEqual({ x: 640, placed: anchor });
    expect(workPopoverSpot(90, null)).toEqual({ x: 90, placed: null });
    expect(workPopoverSpot(null, null)).toBeNull();
  });
});
