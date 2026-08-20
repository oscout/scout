import { describe, expect, test } from "bun:test";

import { normalizeTimestamp } from "./shell-utils.ts";

describe("desktop shell timestamp helpers", () => {
  test("normalizes second and millisecond payloads to Unix seconds", () => {
    expect(normalizeTimestamp(1_700_000_000)).toBe(1_700_000_000);
    expect(normalizeTimestamp(1_700_000_000_000)).toBe(1_700_000_000);
  });

  test("keeps large legacy second payloads below the shared millisecond floor", () => {
    expect(normalizeTimestamp(99_999_999_999)).toBe(99_999_999_999);
  });
});
