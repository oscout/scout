import { describe, expect, test } from "bun:test";

import { buildLocalCodexLaunchArgs } from "./codex-launch-args";

describe("buildLocalCodexLaunchArgs", () => {
  test("normalizes the model and reasoning effort for Codex app-server", () => {
    expect(buildLocalCodexLaunchArgs({
      model: "5.6",
      reasoningEffort: " xhigh ",
    })).toEqual([
      "-c",
      'model="gpt-5.6-sol"',
      "-c",
      'model_reasoning_effort="xhigh"',
    ]);
  });

  test("omits empty launch overrides", () => {
    expect(buildLocalCodexLaunchArgs({
      model: "   ",
      reasoningEffort: "\t",
    })).toEqual([]);
  });
});
