import { describe, expect, test } from "bun:test";

import {
  readCodexQuotaWindowsFromRateLimits,
  readCodexRolloutUsageObservation,
} from "./usage.ts";

describe("Codex usage observation", () => {
  test("keeps cumulative totals separate from latest-turn context input", () => {
    const observation = readCodexRolloutUsageObservation({
      type: "token_count",
      info: {
        model_context_window: 258400,
        total_token_usage: {
          input_tokens: 900000,
          output_tokens: 50,
          total_tokens: 900050,
          cached_input_tokens: 800000,
        },
        last_token_usage: {
          input_tokens: 12345,
          cached_input_tokens: 100,
          output_tokens: 50,
          total_tokens: 12395,
        },
      },
    }, Date.parse("2026-06-20T20:00:00.000Z"));

    expect(observation).toEqual(expect.objectContaining({
      inputTokens: 900000,
      // cached_input_tokens is a subset of input_tokens — do not add it again
      contextInputTokens: 12345,
      outputTokens: 50,
      totalTokens: 900050,
      cacheReadInputTokens: 800000,
      contextWindowTokens: 258400,
    }));
  });

  test("does not double-count cached tokens that are already inside last input", () => {
    // Real Codex shape: total_tokens = input_tokens + output_tokens;
    // cached_input_tokens ≤ input_tokens.
    const observation = readCodexRolloutUsageObservation({
      type: "token_count",
      info: {
        model_context_window: 258400,
        total_token_usage: {
          input_tokens: 52705153,
          cached_input_tokens: 50145792,
          output_tokens: 160156,
          total_tokens: 52865309,
        },
        last_token_usage: {
          input_tokens: 53287,
          cached_input_tokens: 51968,
          output_tokens: 308,
          total_tokens: 53595,
        },
      },
      rate_limits: {
        plan_type: "pro",
        primary: {
          used_percent: 9.0,
          window_minutes: 10080,
          resets_at: 1785813200,
        },
        secondary: null,
      },
    }, Date.parse("2026-07-28T15:31:26.991Z"));

    expect(observation?.contextInputTokens).toBe(53287);
    expect(observation?.quotaWindows).toEqual([
      expect.objectContaining({
        label: "7d",
        windowKind: "primary",
        usedPercent: 9,
        windowMs: 10080 * 60 * 1000,
        resetAt: 1785813200 * 1000,
      }),
    ]);
  });

  test("labels primary/secondary windows from window_minutes, not slot name", () => {
    const windows = readCodexQuotaWindowsFromRateLimits({
      plan_type: "pro",
      primary: {
        used_percent: 18.0,
        window_minutes: 300,
        resets_at: 1778545253,
      },
      secondary: {
        used_percent: 96.0,
        window_minutes: 10080,
        resets_at: 1778539582,
      },
    }, Date.parse("2026-05-11T21:47:22.694Z"));

    expect(windows).toEqual([
      expect.objectContaining({
        label: "5h",
        windowKind: "primary",
        usedPercent: 18,
        windowMs: 300 * 60 * 1000,
        resetAt: 1778545253 * 1000,
      }),
      expect.objectContaining({
        label: "7d",
        windowKind: "secondary",
        usedPercent: 96,
        windowMs: 10080 * 60 * 1000,
        resetAt: 1778539582 * 1000,
      }),
    ]);
  });
});
