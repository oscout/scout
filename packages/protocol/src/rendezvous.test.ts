import { describe, expect, test } from "bun:test";

import {
  isScoutRendezvousFailureResponse,
  normalizeScoutRendezvousCodename,
  validateScoutRendezvousCodename,
} from "./rendezvous.js";

describe("Scout rendezvous codenames", () => {
  test("normalizes lookup keys while preserving display capitalization", () => {
    expect(normalizeScoutRendezvousCodename(" BlueBird ")).toBe("BLUEBIRD");
    expect(validateScoutRendezvousCodename(" BlueBird ")).toBe("BlueBird");
  });

  test("accepts readable alphanumeric codenames without entropy rules", () => {
    expect(validateScoutRendezvousCodename("O0I1")).toBe("O0I1");
    expect(validateScoutRendezvousCodename("B2")).toBe("B2");
  });

  test("rejects punctuation, whitespace, and overlong codenames", () => {
    expect(() => validateScoutRendezvousCodename("blue-bird")).toThrow("ASCII letters or digits");
    expect(() => validateScoutRendezvousCodename("blue bird")).toThrow("ASCII letters or digits");
    expect(() => validateScoutRendezvousCodename("A".repeat(33))).toThrow("1 to 32");
  });

  test("classifies every terminal failure state", () => {
    for (const status of [
      "codename_busy",
      "not_found",
      "expired",
      "consumed",
      "project_mismatch",
    ] as const) {
      expect(isScoutRendezvousFailureResponse({ status } as never)).toBe(true);
    }
    expect(isScoutRendezvousFailureResponse({ status: "waiting" } as never)).toBe(false);
    expect(isScoutRendezvousFailureResponse({ status: "matched" } as never)).toBe(false);
  });
});
