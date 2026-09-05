import { describe, expect, test } from "bun:test";

import { buildLocalCodexLaunchArgs } from "./codex-launch-args";

describe("buildLocalCodexLaunchArgs", () => {
  test("normalizes GPT-6 Astra aliases", () => {
    for (const alias of ["6", "gpt-6", "astra"]) {
      expect(buildLocalCodexLaunchArgs({ model: alias })).toEqual([
        "-c",
        'model="gpt-6-astra"',
      ]);
    }
  });

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
