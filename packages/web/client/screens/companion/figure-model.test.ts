import { describe, expect, test } from "bun:test";

import type { CompanionFigure } from "../../lib/companion-host.ts";
import {
  figureMotion,
  figureNudge,
  figureBox,
  figureHasPlate,
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
    const screen = { width: 1512, height: 982 };
    // 24px figure: slot 30×34.
    // Standing: feet at the anchor.
    expect(figureBox({ x: 500, y: 600, down: "bottom" }, 24, screen)).toEqual({ left: 485, top: 566, bodyTop: 576, bodyBottom: 600 });
    expect(figureBox({ x: 500, y: 600, down: null }, 24, screen)).toEqual({ left: 485, top: 566, bodyTop: 576, bodyBottom: 600 });
    // Under an edge: hangs 6 below it, body at the top of the slot.
    expect(figureBox({ x: 500, y: 300, down: "top" }, 24, screen)).toEqual({ left: 485, top: 306, bodyTop: 306, bodyBottom: 330 });
    // On a side: 6 off it, body centred on the anchor.
    expect(figureBox({ x: 0, y: 400, down: "left" }, 24, screen)).toEqual({ left: 6, top: 383, bodyTop: 388, bodyBottom: 412 });
    expect(figureBox({ x: 1512, y: 400, down: "right" }, 24, screen)).toEqual({ left: 1476, top: 383, bodyTop: 388, bodyBottom: 412 });
    expect([null, "bottom", "top", "left", "right"].filter((down) => figureHasPlate(down as never))).toEqual(["top", "left", "right"]);
  });

  test("a held figure slides along its edge to stay on screen, never off its plate", () => {
    const screen = { width: 1512, height: 982 };
    // Under the top of the screen near a corner: slides along the edge, still hangs 6 below it.
    expect(figureBox({ x: 4, y: 33, down: "top" }, 24, screen)).toMatchObject({ left: 0, top: 39 });
    // Near the right corner it leaves room for the state plate that overhangs the body.
    const corner = figureBox({ x: 1481.76, y: 33, down: "top" }, 64, screen);
    // Scaled 1.06 in the needs pose, about the body's centre.
    expect(corner.left + 80 / 2 + (64 / 2 + 64 * 0.24) * 1.06).toBeLessThanOrEqual(1512);
    // Beside a side near the bottom: slides up, still 6 off the edge.
    expect(figureBox({ x: 0, y: 975, down: "left" }, 24, screen)).toMatchObject({ left: 6, top: 948 });
    // Never pulled away from its edge, even if that runs off screen.
    expect(figureBox({ x: 1490, y: 400, down: "left" }, 64, screen).left).toBe(1496);
    // The host's 8pt cover probe lands on the body, not in the gap.
    expect(figureBox({ x: 500, y: 300, down: "top" }, 24, screen).bodyTop).toBeLessThanOrEqual(308);
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
    // Under the top edge: the body hangs below the plate.
    expect(placedPopover({ x: 1500, y: 33, down: "top" }, 24, 348, screen)).toEqual({ left: 1152, top: 75, maxHeight: 895 });
    // On a side: the body is centred on the anchor.
    expect(placedPopover({ x: 1500, y: 600, down: "right" }, 24, 348, screen)).toEqual({ left: 1152, bottom: 406, maxHeight: 564 });
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
