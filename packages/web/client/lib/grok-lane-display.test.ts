import { describe, expect, test } from "bun:test";

import {
  grokLaneGutterLabel,
  grokLanePhaseIsNoise,
  humanizeGrokLanePhase,
  parseGrokLaneSystemText,
} from "./grok-lane-display.ts";
import type { ObserveEvent } from "./types.ts";

function observe(overrides: Partial<ObserveEvent> & Pick<ObserveEvent, "text">): ObserveEvent {
  return {
    id: "e1",
    kind: "system",
    t: 1,
    ...overrides,
  };
}

describe("parseGrokLaneSystemText", () => {
  test("parses permission lines", () => {
    expect(parseGrokLaneSystemText("permission allow · Shell")).toEqual({
      kind: "permission",
      decision: "allow",
      tool: "Shell",
    });
  });

  test("parses phase and turn lines", () => {
    expect(parseGrokLaneSystemText("phase · waiting_for_model")).toEqual({
      kind: "phase",
      phase: "waiting_for_model",
    });
    expect(parseGrokLaneSystemText("turn 24 · grok-composer-2.5-fast")).toEqual({
      kind: "turn",
      turn: 24,
      model: "grok-composer-2.5-fast",
    });
  });
});

describe("grokLaneGutterLabel", () => {
  test("uses the tool name for permissions", () => {
    expect(grokLaneGutterLabel(observe({ text: "permission allow · Read" }))).toBe("Read");
  });

  test("uses tool name for grok tool rows", () => {
    expect(grokLaneGutterLabel(observe({
      kind: "tool",
      text: "Shell · git status",
      tool: "Shell",
      arg: "git status",
    }))).toBe("Shell");
  });

  test("uses the edited file leaf for StrReplace rows", () => {
    expect(grokLaneGutterLabel(observe({
      kind: "tool",
      text: "StrReplace · packages/web/client/lib/tail-display.ts",
      tool: "StrReplace",
      arg: "packages/web/client/lib/tail-display.ts",
    }))).toBe("tail-display.ts");
  });
});

describe("grokLanePhaseIsNoise", () => {
  test("flags idle and streaming phases", () => {
    expect(grokLanePhaseIsNoise("waiting_for_model")).toBe(true);
    expect(grokLanePhaseIsNoise("streaming_text")).toBe(true);
    expect(grokLanePhaseIsNoise("planning")).toBe(false);
  });
});

describe("humanizeGrokLanePhase", () => {
  test("replaces underscores with spaces", () => {
    expect(humanizeGrokLanePhase("waiting_for_model")).toBe("waiting for model");
  });
});