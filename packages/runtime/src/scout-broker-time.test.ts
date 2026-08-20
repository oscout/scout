import { describe, expect, test } from "bun:test";

import { normalizeUnixTimestamp } from "./scout-broker.ts";

describe("scout broker timestamp helpers", () => {
  test("normalizes second and millisecond payloads to Unix seconds", () => {
    expect(normalizeUnixTimestamp(1_700_000_000)).toBe(1_700_000_000);
    expect(normalizeUnixTimestamp(1_700_000_000_000)).toBe(1_700_000_000);
    expect(normalizeUnixTimestamp("1700000000000")).toBe(1_700_000_000);
  });

  test("keeps large legacy second payloads below the shared millisecond floor", () => {
    expect(normalizeUnixTimestamp(99_999_999_999)).toBe(99_999_999_999);
  });
});
