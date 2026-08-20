import { describe, expect, test } from "bun:test";

import { EPOCH_MILLISECONDS_FLOOR, epochMs } from "./time.js";

describe("agent session time helpers", () => {
  test("normalizes second and millisecond epoch payloads to milliseconds", () => {
    expect(epochMs(1_700_000_000)).toBe(1_700_000_000_000);
    expect(epochMs(1_700_000_000_000)).toBe(1_700_000_000_000);
  });

  test("uses the shared millisecond floor instead of the old 10B cutoff", () => {
    expect(epochMs(99_999_999_999)).toBe(99_999_999_999_000);
    expect(epochMs(EPOCH_MILLISECONDS_FLOOR)).toBe(EPOCH_MILLISECONDS_FLOOR);
  });
});
