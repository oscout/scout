import { describe, expect, test } from "bun:test";

import {
  fitGridLayout,
  gridSpanForWidth,
  gridSpanForWidthTier,
  maxGridSpanForWidths,
  resolveWidthTier,
} from "./scope-grid-layout.ts";

describe("fitGridLayout", () => {
  test("fits at least one column inside a narrow container", () => {
    const layout = fitGridLayout(400, 4);
    expect(layout.columnCount).toBe(1);
    expect(layout.cellWidth).toBeGreaterThanOrEqual(360);
    expect(layout.cellWidth).toBeLessThanOrEqual(400);
  });

  test("never assigns a cell wider than the container", () => {
    const layout = fitGridLayout(1280, 6);
    expect(layout.cellWidth * layout.columnCount).toBeLessThanOrEqual(1280);
  });

  test("caps columns at lane count", () => {
    const layout = fitGridLayout(2000, 2);
    expect(layout.columnCount).toBe(2);
  });

  test("uses a wider target cell when the width tier is large", () => {
    const compact = fitGridLayout(1280, 4, 408);
    const wide = fitGridLayout(1280, 4, 616);
    expect(wide.cellWidth).toBeGreaterThan(compact.cellWidth);
  });
});

describe("grid span widths", () => {
  test("maps tiers to quarter, half, and full row spans", () => {
    expect(gridSpanForWidthTier("sm")).toBe(1);
    expect(gridSpanForWidthTier("md")).toBe(2);
    expect(gridSpanForWidthTier("lg")).toBe(4);
  });

  test("resolves stored lane widths to tiers", () => {
    expect(resolveWidthTier("md", "sm")).toBe("md");
    expect(resolveWidthTier(512, "sm")).toBe("md");
  });

  test("uses the widest lane when a stacked space mixes tiers", () => {
    expect(maxGridSpanForWidths(["sm", "lg"], "md")).toBe(4);
    expect(maxGridSpanForWidths(["sm", "md"], "sm")).toBe(2);
  });

  test("falls back to the default tier when width is unset", () => {
    expect(gridSpanForWidth(undefined, "md")).toBe(2);
  });
});