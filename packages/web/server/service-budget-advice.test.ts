import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  attachBudgetAdvice,
  BUDGET_ADVICE_TTL_MS,
  compactBudgetAdviceSnapshot,
  resetBudgetAdviceCache,
} from "./service-budget-advice.ts";
import type { ServiceBudgetsResponse, ServiceQuotaWindowGauge } from "./service-budgets.ts";

const tempDirs: string[] = [];

afterEach(() => {
  resetBudgetAdviceCache();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function budgets(now = Date.now()): ServiceBudgetsResponse {
  return {
    generatedAt: now,
    gauges: [
      {
        id: "claude",
        label: "claude",
        kind: "quota",
        fill: 0.34,
        usedLabel: "34%",
        capLabel: "100%",
        unitLabel: "7d",
        resetAt: now + 4 * 24 * 3600 * 1000,
        windows: [
          {
            label: "5h",
            fill: 0,
            usedLabel: "—",
            capLabel: "100%",
            unitLabel: "quota",
            resetAt: now + 3 * 3600 * 1000,
            awaitingReset: true,
          },
          {
            label: "7d",
            fill: 0.34,
            usedLabel: "34%",
            capLabel: "100%",
            unitLabel: "quota",
            resetAt: now + 4 * 24 * 3600 * 1000,
            history: [{ capturedAt: now - 3600 * 1000, fill: 0.32, usedLabel: "32%" }],
          },
        ],
      },
      {
        id: "codex",
        label: "codex",
        kind: "quota",
        fill: 0.87,
        usedLabel: "87%",
        capLabel: "100%",
        unitLabel: "7d",
        resetAt: now + 2 * 24 * 3600 * 1000,
      },
    ],
    cloudAccounts: [],
  };
}

describe("service budget advice", () => {
  test("caches a cheap Scoutbot assessment for two hours and coalesces in-flight work", async () => {
    const persistDir = mkdtempSync(join(tmpdir(), "openscout-budget-advice-"));
    tempDirs.push(persistDir);
    let calls = 0;
    const completeCheap = async () => {
      calls += 1;
      await Bun.sleep(20);
      return {
        text: '{"providerId":"claude","recommendation":"Use Claude","reason":"Weekly is 34% with an open 5-hour window; Codex weekly is 87%."}',
        model: "gpt-4o-mini",
      };
    };

    const first = attachBudgetAdvice(budgets(), { completeCheap, persistDir, wait: true });
    const second = attachBudgetAdvice(budgets(), { completeCheap, persistDir, wait: true });
    const [a, b] = await Promise.all([first, second]);
    expect(calls).toBe(1);
    expect(a).toMatchObject({
      providerId: "claude",
      recommendation: "Use Claude",
      model: "gpt-4o-mini",
    });
    expect(b.recommendation).toBe(a.recommendation);
    expect(JSON.parse(readFileSync(join(persistDir, "service-budget-advice.json"), "utf8")).model).toBe("gpt-4o-mini");

    const cached = await attachBudgetAdvice(budgets(), { completeCheap, persistDir, wait: true });
    expect(calls).toBe(1);
    expect(cached.stale).toBeUndefined();
  });

  test("returns stale cache immediately after TTL and refreshes once", async () => {
    const persistDir = mkdtempSync(join(tmpdir(), "openscout-budget-advice-ttl-"));
    tempDirs.push(persistDir);
    let now = 1_000_000;
    let calls = 0;
    const completeCheap = async () => {
      calls += 1;
      return {
        text: `{"providerId":"grok","recommendation":"Use Grok","reason":"call ${calls}"}`,
        model: "gpt-4o-mini",
      };
    };

    const fresh = await attachBudgetAdvice(budgets(now), {
      completeCheap,
      persistDir,
      now: () => now,
      wait: true,
    });
    expect(fresh.reason).toBe("call 1");

    now += BUDGET_ADVICE_TTL_MS + 1;
    const stale = await attachBudgetAdvice(budgets(now), {
      completeCheap,
      persistDir,
      now: () => now,
    });
    expect(stale.stale).toBe(true);
    expect(stale.reason).toBe("call 1");

    const refreshed = await attachBudgetAdvice(budgets(now), {
      completeCheap,
      persistDir,
      now: () => now,
      wait: true,
    });
    expect(calls).toBe(2);
    expect(refreshed.reason).toBe("call 2");
    expect(refreshed.stale).toBeUndefined();
  });

  test("does not invent a recommendation when Scoutbot is unavailable", async () => {
    const persistDir = mkdtempSync(join(tmpdir(), "openscout-budget-advice-fail-"));
    tempDirs.push(persistDir);
    const completeCheap = async () => {
      throw new Error("no key");
    };
    const advice = await attachBudgetAdvice(budgets(), { completeCheap, persistDir, wait: true });
    expect(advice.unavailable).toBe(true);
    expect(advice.recommendation).toBe("");
    expect(advice.reason).toBe("Quota advice is unavailable.");
    expect(advice.detail).toContain("no key");
  });

  test("says so when there is no usage to assess", async () => {
    const persistDir = mkdtempSync(join(tmpdir(), "openscout-budget-advice-empty-"));
    tempDirs.push(persistDir);
    let calls = 0;
    const advice = await attachBudgetAdvice(
      { generatedAt: Date.now(), gauges: [], cloudAccounts: [] },
      {
        completeCheap: async () => {
          calls += 1;
          return { text: "{}", model: "gpt-4o-mini" };
        },
        persistDir,
        wait: true,
      },
    );
    expect(calls).toBe(0);
    expect(advice.unavailable).toBe(true);
    expect(advice.reason).toBe("No provider usage to assess.");
  });

  test("does not retry a failed paid refresh on repeated polls or after restart until two hours pass", async () => {
    const persistDir = mkdtempSync(join(tmpdir(), "openscout-budget-advice-retry-"));
    tempDirs.push(persistDir);
    let now = 2_000_000;
    let calls = 0;
    const completeCheap = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          text: '{"providerId":"claude","recommendation":"Use Claude","reason":"Weekly is open."}',
          model: "gpt-4o-mini",
        };
      }
      return { text: "thanks, but this is not JSON", model: "gpt-4o-mini" };
    };

    const fresh = await attachBudgetAdvice(budgets(now), {
      completeCheap,
      persistDir,
      now: () => now,
      wait: true,
    });
    expect(fresh.recommendation).toBe("Use Claude");
    expect(calls).toBe(1);

    now += BUDGET_ADVICE_TTL_MS + 1;
    const failed = await attachBudgetAdvice(budgets(now), {
      completeCheap,
      persistDir,
      now: () => now,
      wait: true,
    });
    expect(calls).toBe(2);
    expect(failed.stale).toBe(true);
    expect(failed.unavailable).toBeUndefined();
    expect(failed.recommendation).toBe("Use Claude");
    expect(failed.reason).toBe("Weekly is open.");
    const persisted = JSON.parse(readFileSync(join(persistDir, "service-budget-advice.json"), "utf8")) as {
      generatedAt: number;
      lastAttemptAt: number;
      recommendation: string;
    };
    expect(persisted.recommendation).toBe("Use Claude");
    expect(persisted.generatedAt).toBe(2_000_000);
    expect(persisted.lastAttemptAt).toBe(now);

    for (let poll = 0; poll < 4; poll += 1) {
      now += 15_000;
      const polled = await attachBudgetAdvice(budgets(now), {
        completeCheap,
        persistDir,
        now: () => now,
      });
      expect(calls).toBe(2);
      expect(polled.stale).toBe(true);
      expect(polled.recommendation).toBe("Use Claude");
    }

    resetBudgetAdviceCache();
    const afterRestart = await attachBudgetAdvice(budgets(now), {
      completeCheap,
      persistDir,
      now: () => now,
      wait: true,
    });
    expect(calls).toBe(2);
    expect(afterRestart.stale).toBe(true);
    expect(afterRestart.recommendation).toBe("Use Claude");

    now += BUDGET_ADVICE_TTL_MS + 1;
    const retried = await attachBudgetAdvice(budgets(now), {
      completeCheap,
      persistDir,
      now: () => now,
      wait: true,
    });
    expect(calls).toBe(3);
    expect(retried.stale).toBe(true);
    expect(retried.recommendation).toBe("Use Claude");
  });

  test("compact snapshot keeps only verified same-reset-cycle history for pace", () => {
    const now = 5_000_000;
    const currentReset = now + 4 * 3600 * 1000;
    const previousReset = now - 1 * 3600 * 1000;
    const window: ServiceQuotaWindowGauge = {
      label: "5h",
      fill: 0.05,
      usedLabel: "5%",
      capLabel: "100%",
      unitLabel: "quota",
      resetAt: currentReset,
      history: [
        { capturedAt: now - 6 * 3600 * 1000, fill: 0.9, usedLabel: "90%", resetAt: previousReset },
        { capturedAt: now - 5 * 3600 * 1000, fill: 0.92, usedLabel: "92%", resetAt: previousReset },
        { capturedAt: now - 20 * 60 * 1000, fill: 0.04, usedLabel: "4%", resetAt: currentReset },
        { capturedAt: now - 10 * 60 * 1000, fill: 0.05, usedLabel: "5%", resetAt: currentReset },
        { capturedAt: now - 3 * 3600 * 1000, fill: 0.4, usedLabel: "40%" },
      ],
    };
    const snapshot = compactBudgetAdviceSnapshot({
      generatedAt: now,
      gauges: [{
        id: "claude",
        label: "claude",
        kind: "quota",
        fill: 0.05,
        usedLabel: "5%",
        capLabel: "100%",
        unitLabel: "5h",
        resetAt: currentReset,
        windows: [window],
      }],
      cloudAccounts: [],
    });
    const compact = (snapshot.gauges[0] as { windows: Array<Record<string, unknown>> }).windows[0];
    expect(compact.paceUnknown).toBe(false);
    expect(compact.awaitingReset).toBe(false);
    expect(compact.resetAt).toBe(currentReset);
    expect(compact.history).toEqual([
      { capturedAt: now - 20 * 60 * 1000, fill: 0.04, resetAt: currentReset },
      { capturedAt: now - 10 * 60 * 1000, fill: 0.05, resetAt: currentReset },
    ]);
  });

  test("compact snapshot treats awaiting-reset windows as unknown pace", () => {
    const now = 6_000_000;
    const resetAt = now + 2 * 3600 * 1000;
    const window: ServiceQuotaWindowGauge = {
      label: "5h",
      fill: 0,
      usedLabel: "—",
      capLabel: "100%",
      unitLabel: "quota",
      resetAt,
      awaitingReset: true,
      history: [
        { capturedAt: now - 2 * 3600 * 1000, fill: 0.4, usedLabel: "40%", resetAt },
        { capturedAt: now - 3600 * 1000, fill: 0.5, usedLabel: "50%", resetAt },
      ],
    };
    const snapshot = compactBudgetAdviceSnapshot({
      generatedAt: now,
      gauges: [{
        id: "claude",
        label: "claude",
        kind: "quota",
        fill: 0.34,
        usedLabel: "34%",
        capLabel: "100%",
        unitLabel: "7d",
        resetAt,
        windows: [window],
      }],
      cloudAccounts: [],
    });
    const compact = (snapshot.gauges[0] as { windows: Array<Record<string, unknown>> }).windows[0];
    expect(compact.paceUnknown).toBe(true);
    expect(compact.awaitingReset).toBe(true);
    expect(compact.fill).toBeNull();
    expect(compact.history).toEqual([]);
  });
});
