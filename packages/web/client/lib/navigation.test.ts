import { describe, expect, test } from "bun:test";
import {
  isBrowserReloadNavigation,
  type PerformanceNavigationLike,
} from "./navigation.ts";

function navigationTiming(type: string): PerformanceNavigationLike {
  return {
    getEntriesByType: (entryType) =>
      entryType === "navigation" ? [{ type }] : [],
  };
}

describe("isBrowserReloadNavigation", () => {
  test("detects modern reload navigation entries", () => {
    expect(isBrowserReloadNavigation(navigationTiming("reload"))).toBe(true);
  });

  test("ignores modern non-reload navigation entries", () => {
    expect(isBrowserReloadNavigation(navigationTiming("navigate"))).toBe(false);
    expect(isBrowserReloadNavigation(navigationTiming("back_forward"))).toBe(false);
  });

  test("falls back to legacy reload navigation type", () => {
    expect(isBrowserReloadNavigation({
      getEntriesByType: () => [],
      navigation: { type: 1 },
    })).toBe(true);
    expect(isBrowserReloadNavigation({
      getEntriesByType: () => [],
      navigation: { type: 0 },
    })).toBe(false);
  });
});
