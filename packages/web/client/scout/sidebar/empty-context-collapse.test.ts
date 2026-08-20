import { describe, expect, test } from "bun:test";
import {
  isLanesContextEmpty,
  isLanesContextRoute,
  nextLanesContextToggle,
  resolveLanesContextCollapsed,
} from "./empty-context-collapse.ts";

describe("empty CONTEXT collapse (SCO-085)", () => {
  test("only /ops/lanes is the empty-context route", () => {
    expect(isLanesContextRoute({ view: "ops", mode: "lanes" })).toBe(true);
    expect(isLanesContextRoute({ view: "ops", mode: "mission" })).toBe(false);
    expect(isLanesContextRoute({ view: "ops" })).toBe(false);
    expect(isLanesContextRoute({ view: "agents-v2" })).toBe(false);
  });

  test("loading is not empty (avoids unmount deadlock)", () => {
    expect(
      isLanesContextEmpty(
        { view: "ops", mode: "lanes" },
        { messageCount: 0, loading: true },
      ),
    ).toBe(false);
  });

  test("loaded zero-message conversation is empty", () => {
    expect(
      isLanesContextEmpty(
        { view: "ops", mode: "lanes" },
        { messageCount: 0, loading: false },
      ),
    ).toBe(true);
    expect(
      isLanesContextEmpty(
        { view: "ops", mode: "lanes" },
        { messageCount: 2, loading: false },
      ),
    ).toBe(false);
  });

  test("missing conversation is not empty", () => {
    expect(isLanesContextEmpty({ view: "ops", mode: "lanes" }, null)).toBe(false);
    expect(isLanesContextEmpty({ view: "ops", mode: "lanes" }, undefined)).toBe(false);
  });

  test("forceOpen temporarily overrides emptiness-derived collapse", () => {
    expect(
      resolveLanesContextCollapsed({ empty: true, forceOpen: false, baseCollapsed: false }),
    ).toBe(true);
    expect(
      resolveLanesContextCollapsed({ empty: true, forceOpen: true, baseCollapsed: true }),
    ).toBe(false);
    expect(
      resolveLanesContextCollapsed({ empty: false, forceOpen: false, baseCollapsed: true }),
    ).toBe(true);
    expect(
      resolveLanesContextCollapsed({ empty: false, forceOpen: true, baseCollapsed: false }),
    ).toBe(false);
  });

  test("toggle expand while empty sets forceOpen without permanently flipping prefs", () => {
    const next = nextLanesContextToggle({
      empty: true,
      forceOpen: false,
      rightCollapsed: false,
    });
    expect(next.forceOpen).toBe(true);
    expect(next.rightCollapsed).toBe(false);
  });

  test("toggle collapse while empty clears forceOpen and leaves stored prefs alone", () => {
    const next = nextLanesContextToggle({
      empty: true,
      forceOpen: true,
      rightCollapsed: false,
    });
    expect(next.forceOpen).toBe(false);
    expect(next.rightCollapsed).toBe(false);
  });

  test("toggle expand while empty + stored collapsed opens without rewriting stored pref", () => {
    // SCO-086: temporary open override must preserve rightCollapsed=true.
    const next = nextLanesContextToggle({
      empty: true,
      forceOpen: false,
      rightCollapsed: true,
    });
    expect(next.forceOpen).toBe(true);
    expect(next.rightCollapsed).toBe(true);
  });

  test("toggle while non-empty uses stored rightCollapsed", () => {
    expect(
      nextLanesContextToggle({ empty: false, forceOpen: false, rightCollapsed: true }),
    ).toEqual({ forceOpen: true, rightCollapsed: false });
    expect(
      nextLanesContextToggle({ empty: false, forceOpen: true, rightCollapsed: false }),
    ).toEqual({ forceOpen: false, rightCollapsed: true });
  });
});
