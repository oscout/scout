import { describe, expect, test } from "bun:test";

import type { ServiceGauge } from "../../service-budgets.ts";
import { mobileServiceBudgetFromGauge } from "./service.ts";

describe("mobile service budget projection", () => {
  test("drops expired quota windows and preserves the absolute reset", () => {
    const now = Date.now();
    const currentReset = now + 6 * 24 * 60 * 60 * 1000;
    const gauge: ServiceGauge = {
      id: "codex",
      label: "codex",
      kind: "quota",
      fill: 0.24,
      usedLabel: "24%",
      capLabel: "100%",
      unitLabel: "quota",
      resetAt: currentReset,
      windows: [
        {
          label: "5h",
          fill: 0.93,
          usedLabel: "93%",
          capLabel: "100%",
          unitLabel: "quota",
          resetAt: now - 1,
        },
        {
          label: "7d",
          fill: 0.24,
          usedLabel: "24%",
          capLabel: "100%",
          unitLabel: "quota",
          resetAt: currentReset,
        },
      ],
    };

    expect(mobileServiceBudgetFromGauge(gauge)?.windows).toEqual([
      {
        label: "7d",
        usedPercent: 24,
        resetAt: currentReset,
        reset: "6d",
      },
    ]);
  });
});
