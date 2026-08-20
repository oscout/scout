import { describe, expect, test } from "bun:test";

import {
  isClaudeCodeQuotaEvent,
  readClaudeCodeQuotaObservation,
} from "./quota.js";

describe("Claude Code quota observations", () => {
  test("reads provider-reported quota windows from rate limit events", () => {
    const observation = readClaudeCodeQuotaObservation({
      type: "rate_limit_event",
      timestamp: "2026-06-08T12:00:00.000Z",
      rate_limits: {
        plan_type: "max",
        primary: {
          used_percent: "42%",
          reset_at: "2026-06-08T15:00:00.000Z",
          window_minutes: 300,
        },
        secondary: {
          remaining_percent: 72,
          reset_after_seconds: 3600,
          window_ms: 7 * 24 * 60 * 60 * 1000,
        },
      },
    }, 1000);

    expect(observation).toEqual({
      provider: "anthropic",
      capturedAt: Date.parse("2026-06-08T12:00:00.000Z"),
      planType: "max",
      userId: undefined,
      accountId: undefined,
      windows: [
        {
          label: "5h",
          windowKind: "primary",
          usedPercent: 42,
          percentRemaining: 58,
          used: undefined,
          limit: undefined,
          resetAt: Date.parse("2026-06-08T15:00:00.000Z"),
          windowMs: 300 * 60 * 1000,
        },
        {
          label: "weekly",
          windowKind: "secondary",
          usedPercent: undefined,
          percentRemaining: 72,
          used: undefined,
          limit: undefined,
          resetAt: Date.parse("2026-06-08T13:00:00.000Z"),
          windowMs: 7 * 24 * 60 * 60 * 1000,
        },
      ],
    });
  });

  test("reads nested payload rate limit arrays", () => {
    const observation = readClaudeCodeQuotaObservation({
      type: "stream_event",
      event: {
        type: "rate_limits.updated",
        payload: {
          rate_limits: [
            {
              name: "tokens",
              remaining: 80,
              limit: 100,
              reset_after_seconds: 60,
            },
          ],
        },
      },
    }, 2000);

    expect(isClaudeCodeQuotaEvent({ type: "rate_limits.updated" })).toBe(true);
    expect(observation?.windows).toEqual([
      expect.objectContaining({
        label: "tokens",
        usedPercent: 20,
        percentRemaining: 80,
        used: undefined,
        limit: 100,
        resetAt: 62_000,
      }),
    ]);
  });
});
