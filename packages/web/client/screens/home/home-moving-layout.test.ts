import { describe, expect, test } from "bun:test";

import { homeMovingGridClass, homeMovingLayout } from "./home-moving-layout.ts";

describe("homeMovingLayout", () => {
  test("spotlight for one or two live units", () => {
    expect(homeMovingLayout(1)).toBe("spotlight");
    expect(homeMovingLayout(2)).toBe("spotlight");
  });

  test("duo for three or four", () => {
    expect(homeMovingLayout(3)).toBe("duo");
    expect(homeMovingLayout(4)).toBe("duo");
  });

  test("strip for five through eight", () => {
    expect(homeMovingLayout(5)).toBe("strip");
    expect(homeMovingLayout(8)).toBe("strip");
  });

  test("dense for nine or more", () => {
    expect(homeMovingLayout(9)).toBe("dense");
    expect(homeMovingLayout(12)).toBe("dense");
  });
});

describe("homeMovingGridClass", () => {
  test("returns layout-specific grid class", () => {
    expect(homeMovingGridClass("strip")).toBe("s-now-grid s-now-grid--strip");
  });
});