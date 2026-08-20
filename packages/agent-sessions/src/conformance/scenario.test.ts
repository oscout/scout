import { describe, expect, test } from "bun:test";

import {
  validateAppliedRedactions,
  validateScenarioManifest,
  type ScenarioManifest,
} from "./scenario.js";

function manifest(): ScenarioManifest {
  return {
    schemaVersion: "1.0.0",
    id: "fixture-one",
    adapterId: "echo",
    fixtureSet: "echo",
    source: {
      kind: "recorded",
      harnessVersion: "fixture",
      transport: "jsonl",
      capturedAt: "2026-08-07T00:00:00.000Z",
    },
    redactions: [{ line: 0, pointer: "/payload/token", replacement: "<redacted>" }],
    expected: { endState: "open", openReason: "fixture", evidenceKeys: [] },
    determinism: { clockValues: [], idValues: [] },
  };
}

describe("SCO-042 scenario contract", () => {
  test("rejects malformed schema fields without throwing", () => {
    const value = {
      ...manifest(),
      id: "Not a slug",
      source: { ...manifest().source, capturedAt: "not-a-date" },
      redactions: [null],
    };

    expect(validateScenarioManifest(value)).toEqual(expect.arrayContaining([
      expect.stringContaining("id must match"),
      expect.stringContaining("source.capturedAt"),
      expect.stringContaining("redactions[0] must be an object"),
    ]));
  });

  test("requires declared exact replacements to exist in the capture", () => {
    const capture = `${JSON.stringify({
      source: "harness",
      sequence: 0,
      payload: { token: "still-private" },
    })}\n`;

    expect(validateAppliedRedactions(manifest(), capture)).toEqual([
      expect.stringContaining("does not contain its declared replacement"),
    ]);
  });
});
