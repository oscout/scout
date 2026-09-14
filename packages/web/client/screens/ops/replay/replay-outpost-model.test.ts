import { describe, expect, test } from "bun:test";
import {
  ACTIVITY,
  BUBBLE_MAX_LINES,
  bubbleFor,
  bubbleHeadroom,
  bubbleLines,
  cameraFor,
  DISTRICT_OF,
  facesLeft,
  layoutGround,
  ridgeWeight,
  screenX,
  showsCaption,
  spriteAction,
  SPRITE_SIZE,
  travelMs,
  type ReplayKind,
  type ReplayViewport,
} from "./replay-outpost-model.ts";

const VIEW: ReplayViewport = { stageWidth: 1080, panoramaWidth: 1410 };

/** A run that shuttles between all three districts, as a real turn does. */
const RUN: ReplayKind[] = [
  "start", "think", "read", "read", "read", "tool", "think", "read", "edit", "edit", "tool",
  "think", "edit", "tool", "edit", "edit", "tool", "message", "wait", "read", "tool", "tool", "end",
];

function positions(kinds: readonly ReplayKind[], view = VIEW): number[] {
  return layoutGround(kinds, view).map((worldX, i) => screenX(worldX, DISTRICT_OF[kinds[i]], view));
}

describe("ground layout", () => {
  test("no two consecutive stops share a footprint", () => {
    const xs = positions(RUN);
    const stuck = xs.map((x, i) => (i > 0 && x === xs[i - 1] ? i : -1)).filter((i) => i >= 0);
    expect(stuck).toEqual([]);
  });

  test("the sprite never leaves the stage, half-width included", () => {
    for (const view of [VIEW, { stageWidth: 720, panoramaWidth: 1410 }, { stageWidth: 1400, panoramaWidth: 1410 }]) {
      for (const x of positions(RUN, view)) {
        expect(x - SPRITE_SIZE / 2).toBeGreaterThanOrEqual(-0.5);
        expect(x + SPRITE_SIZE / 2).toBeLessThanOrEqual(view.stageWidth + 0.5);
      }
    }
  });

  test("stops in one district spread out instead of stacking", () => {
    const reads = positions(["read", "read", "read", "read"]);
    expect(new Set(reads).size).toBe(4);
  });
});

describe("camera", () => {
  test("anchors to the district, so the agent is not pinned mid-stage", () => {
    // The bug this replaces: a camera tracking the agent puts screenX at exactly
    // stageWidth / 2 for every stop, and he runs on the spot forever.
    const xs = positions(["read", "read", "read", "read"]);
    expect(xs.every((x) => x === VIEW.stageWidth / 2)).toBe(false);
  });

  test("moves when the work moves districts", () => {
    expect(cameraFor("domes", VIEW)).not.toBe(cameraFor("hangar", VIEW));
  });

  test("never reveals past the edges of the painting", () => {
    for (const district of ["domes", "biodome", "hangar"] as const) {
      const camera = cameraFor(district, VIEW);
      expect(camera).toBeLessThanOrEqual(0);
      expect(camera).toBeGreaterThanOrEqual(VIEW.stageWidth - VIEW.panoramaWidth);
    }
  });
});

describe("travel", () => {
  test("holds ground speed rather than travel time", () => {
    const speeds = [70, 180, 360, 760].map((d) => d / travelMs(0, d, 1));
    for (const speed of speeds) expect(speed).toBeGreaterThan(0.35);
    for (const speed of speeds) expect(speed).toBeLessThanOrEqual(0.9 + 1e-9);
  });

  test("playback speed divides the clock", () => {
    expect(travelMs(0, 400, 2)).toBeCloseTo(travelMs(0, 400, 1) / 2, 6);
  });
});

describe("facing", () => {
  test("follows the move actually being made", () => {
    expect(facesLeft(800, 200)).toBe(true);
    expect(facesLeft(200, 800)).toBe(false);
  });

  test("a scrub across many stops still faces the way it travels", () => {
    // The bug this replaces: facing derived from `cursor - 1` describes a move
    // that never happened when the ridge is scrubbed, so he sprints left while
    // facing right. Jumping from stop 16 to stop 3 travels left.
    const xs = positions(RUN);
    expect(facesLeft(xs[16], xs[3])).toBe(true);
    expect(facesLeft(xs[3], xs[16])).toBe(false);
  });
});

describe("sprite grammar", () => {
  test("a checkpoint is arrived at, a routine stop is run to", () => {
    expect(spriteAction("travel", true)).toBe("jump");
    expect(spriteAction("travel", false)).toBe("run");
    expect(spriteAction("land", true)).toBe("land");
    expect(spriteAction("work", true)).toBe("idle");
  });
});

describe("ridge", () => {
  test("weight reports how much of the run a stop was", () => {
    expect(ridgeWeight({ checkpoint: true, routine: false })).toBe(1);
    expect(ridgeWeight({ checkpoint: false, routine: false })).toBeGreaterThan(
      ridgeWeight({ checkpoint: false, routine: true }),
    );
  });
});

describe("labels", () => {
  test("describe the work, not an invented place", () => {
    expect(ACTIVITY.tool).toBe("Running");
    expect(ACTIVITY.read).toBe("Reading");
    expect(Object.values(ACTIVITY)).not.toContain("Tool shed");
  });

  test("every kind is covered", () => {
    const kinds: ReplayKind[] = [
      "start", "think", "read", "edit", "tool", "message", "wait", "end", "stopped",
    ];
    for (const kind of kinds) {
      expect(ACTIVITY[kind]).toBeTruthy();
      expect(DISTRICT_OF[kind]).toBeTruthy();
    }
  });
});

describe("bubbles", () => {
  test("only the agent's own words get a bubble", () => {
    expect(bubbleFor("think")).toBe("thought");
    expect(bubbleFor("message")).toBe("speech");
    for (const kind of ["start", "read", "edit", "tool", "wait", "end", "stopped"] as ReplayKind[]) {
      expect(bubbleFor(kind)).toBeNull();
    }
  });

  test("a beat speaks or it reports, never both", () => {
    const kinds: ReplayKind[] = [
      "start", "think", "read", "edit", "tool", "message", "wait", "end", "stopped",
    ];
    for (const kind of kinds) {
      expect(showsCaption(kind)).toBe(bubbleFor(kind) === null);
    }
  });

  test("the design stage holds a full bubble over his head", () => {
    // 420px stage, standing 159px up, 150px sprite.
    expect(bubbleLines(bubbleHeadroom(420, 159))).toBe(BUBBLE_MAX_LINES);
  });

  test("a short stage clamps the prose instead of pushing it off the world", () => {
    const tight = bubbleHeadroom(300, 159);
    expect(tight).toBeLessThan(bubbleHeadroom(420, 159));
    expect(bubbleLines(tight)).toBeGreaterThanOrEqual(1);
    expect(bubbleLines(tight)).toBeLessThan(BUBBLE_MAX_LINES);
  });

  test("headroom never goes negative when he stands taller than the stage", () => {
    expect(bubbleHeadroom(200, 300)).toBe(0);
    expect(bubbleLines(0)).toBe(1);
  });
});
