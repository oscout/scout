import { describe, expect, test } from "bun:test";

import { moveWallCursor, wallCursorMoveForKey } from "./mission-cursor.ts";

describe("moveWallCursor", () => {
  test("an empty wall has no cursor", () => {
    expect(moveWallCursor(-1, 0, 4, "right")).toBe(-1);
    expect(moveWallCursor(3, 0, 4, "down")).toBe(-1);
  });

  test("the first keypress plants the cursor at the edge the motion comes from", () => {
    expect(moveWallCursor(-1, 10, 4, "right")).toBe(0);
    expect(moveWallCursor(-1, 10, 4, "down")).toBe(0);
    expect(moveWallCursor(-1, 10, 4, "first")).toBe(0);
    expect(moveWallCursor(-1, 10, 4, "left")).toBe(9);
    expect(moveWallCursor(-1, 10, 4, "up")).toBe(9);
    expect(moveWallCursor(-1, 10, 4, "last")).toBe(9);
  });

  test("h/l step in reading order, across row boundaries", () => {
    expect(moveWallCursor(3, 10, 4, "right")).toBe(4);
    expect(moveWallCursor(4, 10, 4, "left")).toBe(3);
  });

  test("h/l clamp at the ends instead of wrapping the wall", () => {
    expect(moveWallCursor(0, 10, 4, "left")).toBe(0);
    expect(moveWallCursor(9, 10, 4, "right")).toBe(9);
  });

  test("j/k step a whole row", () => {
    expect(moveWallCursor(1, 10, 4, "down")).toBe(5);
    expect(moveWallCursor(5, 10, 4, "up")).toBe(1);
  });

  test("k holds on the top row rather than drifting sideways", () => {
    expect(moveWallCursor(2, 10, 4, "up")).toBe(2);
  });

  test("j falls to the last pane over a ragged bottom row", () => {
    // 10 panes at 4 cols: the bottom row holds 8 and 9 only.
    expect(moveWallCursor(6, 10, 4, "down")).toBe(9);
    expect(moveWallCursor(9, 10, 4, "down")).toBe(9);
  });

  test("g/G reach the ends", () => {
    expect(moveWallCursor(5, 10, 4, "first")).toBe(0);
    expect(moveWallCursor(5, 10, 4, "last")).toBe(9);
  });

  test("a cursor stranded past a re-tile is pulled back onto the wall", () => {
    expect(moveWallCursor(30, 10, 4, "down")).toBe(0);
    expect(moveWallCursor(30, 10, 4, "up")).toBe(9);
  });

  test("a single-column wall still moves on j/k", () => {
    expect(moveWallCursor(0, 3, 0, "down")).toBe(1);
    expect(moveWallCursor(2, 3, 0, "up")).toBe(1);
  });
});

describe("wallCursorMoveForKey", () => {
  test("vim motions and their arrow synonyms agree", () => {
    expect(wallCursorMoveForKey("h")).toBe("left");
    expect(wallCursorMoveForKey("ArrowLeft")).toBe("left");
    expect(wallCursorMoveForKey("l")).toBe("right");
    expect(wallCursorMoveForKey("ArrowRight")).toBe("right");
    expect(wallCursorMoveForKey("k")).toBe("up");
    expect(wallCursorMoveForKey("ArrowUp")).toBe("up");
    expect(wallCursorMoveForKey("j")).toBe("down");
    expect(wallCursorMoveForKey("ArrowDown")).toBe("down");
  });

  test("g/G and Home/End reach the ends", () => {
    expect(wallCursorMoveForKey("g")).toBe("first");
    expect(wallCursorMoveForKey("Home")).toBe("first");
    expect(wallCursorMoveForKey("G")).toBe("last");
    expect(wallCursorMoveForKey("End")).toBe("last");
  });

  test("unbound keys are left for the rest of the surface", () => {
    expect(wallCursorMoveForKey("Enter")).toBeNull();
    expect(wallCursorMoveForKey("a")).toBeNull();
    expect(wallCursorMoveForKey("/")).toBeNull();
  });
});
