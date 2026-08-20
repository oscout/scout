import { describe, expect, test } from "bun:test";

import {
  contextBudgetBarWidth,
  deriveContextBudgetGauge,
  formatContextTokenCount,
} from "./context-budget.ts";

describe("deriveContextBudgetGauge", () => {
  test("uses latest-turn context input, not cumulative session totals", () => {
    const gauge = deriveContextBudgetGauge({
      contextInputTokens: 249_229,
      inputTokens: 14_687_351,
      totalTokens: 14_744_037,
      contextWindowTokens: 1_000_000,
    });

    expect(gauge).toEqual({
      used: 249_229,
      budget: 1_000_000,
      pct: 25,
      overLimit: false,
      usedLabel: "249.2k",
      budgetLabel: "1m",
    });
  });

  test("marks sessions that exceed the reported window", () => {
    const gauge = deriveContextBudgetGauge({
      contextInputTokens: 315_000,
      contextWindowTokens: 258_400,
    }, { model: "gpt-5.5", adapterType: "codex" });

    expect(gauge?.pct).toBe(122);
    expect(gauge?.overLimit).toBe(true);
    expect(contextBudgetBarWidth(gauge!)).toBe(100);
  });

  test("infers codex window when the rollout omits model_context_window", () => {
    const gauge = deriveContextBudgetGauge({
      contextInputTokens: 200_000,
    }, { model: "gpt-5.5", adapterType: "codex" });

    expect(gauge?.budget).toBe(258_400);
    expect(gauge?.pct).toBe(77);
  });
});

describe("formatContextTokenCount", () => {
  test("formats sub-thousand counts literally", () => {
    expect(formatContextTokenCount(42)).toBe("42");
  });
});