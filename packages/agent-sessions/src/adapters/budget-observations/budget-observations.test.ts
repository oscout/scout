import { describe, expect, test } from "bun:test";

import { readAdapterBudgetObservations } from "../budget-observations.js";

describe("adapter budget observations", () => {
  test("reads Codex usage and provider-reported quota windows", () => {
    const capturedAt = 1_700_000_002_000;
    const observations = readAdapterBudgetObservations({
      id: "endpoint-codex",
      harness: "codex",
      transport: "codex_app_server",
      model: "gpt-5.4",
      sessionId: "codex-session",
      cwd: "/repo",
      providerMeta: {
        provider: "openai",
        observeUsage: {
          inputTokens: 1000,
          cacheReadInputTokens: 250,
          outputTokens: 80,
          totalTokens: 1080,
          planType: "plus",
        },
        observeQuota: {
          capturedAt,
          planType: "plus",
          windows: [
            {
              label: "5h",
              windowKind: "primary",
              usedPercent: 60,
            },
          ],
        },
      },
    }, capturedAt + 500);

    expect(observations.usage).toHaveLength(1);
    expect(observations.usage[0]).toEqual(expect.objectContaining({
      provider: "openai",
      model: "gpt-5.4",
      sessionId: "codex-session",
      projectRoot: "/repo",
      metadata: expect.objectContaining({
        source: "codex.providerMeta.observeUsage",
        billingMode: "subscription",
      }),
    }));
    expect(observations.usage[0]?.estimate.billedTotalUsd).toBe(0);
    expect(observations.quotaWindows).toEqual([
      expect.objectContaining({
        source: "provider_reported",
        provider: "openai",
        label: "5h",
        windowKind: "primary",
        usedPercent: 60,
        percentRemaining: 40,
        capturedAt,
        metadata: expect.objectContaining({
          source: "codex.providerMeta.observeQuota",
        }),
      }),
    ]);
  });

  test("normalizes large legacy second quota timestamps", () => {
    const observations = readAdapterBudgetObservations({
      id: "endpoint-codex",
      harness: "codex",
      transport: "codex_app_server",
      model: "gpt-5.4",
      sessionId: "codex-session",
      providerMeta: {
        provider: "openai",
        observeQuota: {
          capturedAt: 99_999_999_999,
          planType: "plus",
          windows: [
            {
              label: "5h",
              resetAt: 99_999_999_998,
            },
          ],
        },
      },
    }, 2500);

    expect(observations.quotaWindows[0]).toEqual(expect.objectContaining({
      capturedAt: 99_999_999_999_000,
      resetAt: 99_999_999_998_000,
    }));
  });

  test("reads Claude Code usage without inventing quota windows", () => {
    const observations = readAdapterBudgetObservations({
      id: "endpoint-claude",
      harness: "claude",
      transport: "claude_stream_json",
      model: "claude-sonnet-4.5",
      sessionId: "claude-session",
      providerMeta: {
        observeUsage: {
          inputTokens: 12,
          outputTokens: 24,
          cacheReadInputTokens: 125,
          cacheCreationInputTokens: 60,
          webSearchRequests: 1,
        },
      },
    }, 3000);

    expect(observations.usage).toHaveLength(1);
    expect(observations.usage[0]).toEqual(expect.objectContaining({
      provider: "anthropic",
      model: "claude-sonnet-4.5",
      sessionId: "claude-session",
      metadata: expect.objectContaining({
        source: "claude-code.providerMeta.observeUsage",
        billingMode: "subscription",
      }),
    }));
    expect(observations.usage[0]?.estimate.billedTotalUsd).toBe(0);
    expect(observations.quotaWindows).toHaveLength(0);
  });

  test("reads Claude Code provider-reported quota windows", () => {
    const capturedAt = 1_700_000_005_000;
    const observations = readAdapterBudgetObservations({
      id: "endpoint-claude",
      harness: "claude",
      transport: "claude_stream_json",
      model: "claude-sonnet-4.5",
      sessionId: "claude-session",
      providerMeta: {
        provider: "anthropic",
        observeQuota: {
          capturedAt,
          planType: "max",
          windows: [
            {
              label: "5h",
              windowKind: "primary",
              usedPercent: 25,
              resetAt: capturedAt + 1_000,
            },
            {
              label: "weekly",
              windowKind: "secondary",
              percentRemaining: 70,
              resetAt: capturedAt + 2_000,
            },
          ],
        },
      },
    }, capturedAt + 500);

    expect(observations.usage).toHaveLength(0);
    expect(observations.quotaWindows).toEqual([
      expect.objectContaining({
        source: "provider_reported",
        provider: "anthropic",
        label: "5h",
        windowKind: "primary",
        usedPercent: 25,
        percentRemaining: 75,
        capturedAt,
        metadata: expect.objectContaining({
          source: "claude-code.providerMeta.observeQuota",
        }),
      }),
      expect.objectContaining({
        source: "provider_reported",
        provider: "anthropic",
        label: "weekly",
        windowKind: "secondary",
        usedPercent: undefined,
        percentRemaining: 70,
        capturedAt,
        metadata: expect.objectContaining({
          source: "claude-code.providerMeta.observeQuota",
        }),
      }),
    ]);
  });

  test("does not interpret unknown adapter metadata", () => {
    const observations = readAdapterBudgetObservations({
      id: "endpoint-unknown",
      harness: "worker",
      providerMeta: {
        observeUsage: {
          inputTokens: 1,
        },
      },
    }, 4000);

    expect(observations).toEqual({
      usage: [],
      quotaWindows: [],
    });
  });
});
