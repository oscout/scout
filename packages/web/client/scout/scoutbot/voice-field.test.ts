import { describe, expect, test } from "bun:test";

import { voiceCoverage } from "./voice-field.ts";

const CENTER = { x: 13, y: 13 };
const RIM = { x: 13, y: 4 };

describe("voiceCoverage", () => {
  test("listening occupies the rim more than the core", () => {
    const t = 2.6;
    expect(voiceCoverage(RIM.x, RIM.y, t, "listening"))
      .toBeGreaterThan(voiceCoverage(CENTER.x, CENTER.y, t, "listening"));
  });

  test("speaking occupies the core more than the rim", () => {
    const t = 2.6;
    expect(voiceCoverage(CENTER.x, CENTER.y, t, "speaking"))
      .toBeGreaterThan(voiceCoverage(RIM.x, RIM.y, t, "speaking"));
  });

  test("processing stays on the disk without emptying the core", () => {
    const t = 1.1;
    expect(voiceCoverage(CENTER.x, CENTER.y, t, "processing")).toBeGreaterThan(0.1);
    expect(voiceCoverage(RIM.x, RIM.y, t, "processing")).toBeGreaterThan(0);
  });

  test("ready is the sparsest of the four", () => {
    const t = 2.6;
    const ready = voiceCoverage(RIM.x, RIM.y, t, "ready");
    expect(ready).toBeLessThan(voiceCoverage(RIM.x, RIM.y, t, "listening"));
    expect(ready).toBeLessThan(voiceCoverage(CENTER.x, CENTER.y, t, "speaking"));
  });
});
