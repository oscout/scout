import { describe, expect, test } from "bun:test";

import {
  EPOCH_MILLISECONDS_FLOOR,
  durationMs,
  epochMs,
  epochMsFromSeconds,
  toIso,
  type DurationMs,
  type EpochMs,
} from "./time.js";

describe("time primitives", () => {
  test("accepts epoch millisecond input", () => {
    const value: EpochMs | null = epochMs(1_712_345_678_901);

    expect(value).toBe(1_712_345_678_901);
  });

  test("converts legacy epoch second input", () => {
    expect(epochMs(1_712_345_678)).toBe(1_712_345_678_000);
    expect(epochMsFromSeconds(1_712_345_678)).toBe(1_712_345_678_000);
  });

  test("uses the shared millisecond floor instead of the old 10B cutoff", () => {
    const largeLegacySeconds = 99_999_999_999;

    expect(epochMs(largeLegacySeconds)).toBe(99_999_999_999_000);
    expect(epochMs(EPOCH_MILLISECONDS_FLOOR)).toBe(EPOCH_MILLISECONDS_FLOOR);
  });

  test("accepts numeric string input", () => {
    expect(epochMs("1712345678901")).toBe(1_712_345_678_901);
    expect(epochMs("1712345678")).toBe(1_712_345_678_000);
  });

  test("rejects invalid values", () => {
    expect(epochMs(null)).toBeNull();
    expect(epochMs(undefined)).toBeNull();
    expect(epochMs("not-a-time")).toBeNull();
    expect(epochMs(Number.NaN)).toBeNull();
    expect(epochMs(Number.POSITIVE_INFINITY)).toBeNull();
    expect(epochMs(0)).toBeNull();
    expect(epochMs(-1)).toBeNull();

    expect(() => epochMsFromSeconds(0)).toThrow(RangeError);
    expect(() => durationMs(Number.NaN)).toThrow(RangeError);
  });

  test("formats epoch milliseconds as ISO strings", () => {
    expect(toIso(epochMs(1_712_345_678_901)!)).toBe("2024-04-05T19:34:38.901Z");
  });

  test("brands duration milliseconds", () => {
    const value: DurationMs = durationMs(5_000);

    expect(value).toBe(5_000);
  });
});
