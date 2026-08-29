import { describe, expect, test } from "bun:test";

import {
  ASCII_GAUGE_CELLS,
  ASCII_GAUGE_EMPTY,
  ASCII_GAUGE_FILL,
  asciiGaugeBar,
  asciiGaugeCells,
  readBudgetSection,
  type BudgetGauge,
} from "./host-advisor-gauges.ts";

function barLength(bar: ReturnType<typeof asciiGaugeBar>): number {
  return [...bar.filled].length + [...bar.rest].length;
}

function gauge(overrides: Partial<BudgetGauge> & Pick<BudgetGauge, "id" | "label">): BudgetGauge {
  return { kind: "quota", fill: 0, ...overrides };
}

describe("asciiGaugeBar", () => {
  test("empty fill is a full mid-dot track", () => {
    const bar = asciiGaugeBar(0);
    expect(bar.filled).toBe("");
    expect(bar.rest).toBe(ASCII_GAUGE_EMPTY.repeat(ASCII_GAUGE_CELLS));
    expect(bar.percent).toBe(0);
    expect(barLength(bar)).toBe(ASCII_GAUGE_CELLS);
  });

  test("full fill is a textured track, not a solid block bar", () => {
    const bar = asciiGaugeBar(1);
    expect(bar.filled).toBe(ASCII_GAUGE_FILL.repeat(ASCII_GAUGE_CELLS));
    expect(bar.filled.includes("█")).toBe(false);
    expect(bar.rest).toBe("");
    expect(bar.percent).toBe(100);
    expect(barLength(bar)).toBe(ASCII_GAUGE_CELLS);
  });

  test("keeps a tick for tiny non-zero fill", () => {
    const bar = asciiGaugeBar(0.01);
    expect(bar.filled).toBe("▎");
    expect(barLength(bar)).toBe(ASCII_GAUGE_CELLS);
    expect(bar.percent).toBe(1);
    expect(asciiGaugeBar(0.001).filled).toBe("▏");
  });

  test("maps 14% onto two cells and an eighth remainder", () => {
    const bar = asciiGaugeBar(0.14);
    expect(bar.percent).toBe(14);
    expect(barLength(bar)).toBe(ASCII_GAUGE_CELLS);
    expect(bar.filled.startsWith(ASCII_GAUGE_FILL)).toBe(true);
    expect(bar.rest.includes(ASCII_GAUGE_FILL)).toBe(false);
    expect(bar.rest.includes(ASCII_GAUGE_EMPTY)).toBe(true);
    expect(asciiGaugeCells(bar)).toHaveLength(ASCII_GAUGE_CELLS);
  });

  test("80% lands on an even cell boundary", () => {
    const bar = asciiGaugeBar(0.8);
    expect(bar.filled).toBe(ASCII_GAUGE_FILL.repeat(16));
    expect(bar.rest).toBe(ASCII_GAUGE_EMPTY.repeat(4));
  });

  test("clamps out-of-range and non-finite fill", () => {
    expect(asciiGaugeBar(1.4).percent).toBe(100);
    expect(asciiGaugeBar(-0.2).percent).toBe(0);
    expect(asciiGaugeBar(Number.NaN).percent).toBe(0);
  });
});

describe("readBudgetSection", () => {
  test("does not claim All clear while budgets are still arriving", () => {
    const reading = readBudgetSection(null);
    expect(reading.verdict).toBe("Reading");
    expect(reading.showGauges).toBe(false);
    expect(reading.verdict.toLowerCase()).not.toContain("all clear");
  });

  test("All clear only when there is nothing to report", () => {
    const reading = readBudgetSection([]);
    expect(reading.verdict).toBe("All clear");
    expect(reading.showGauges).toBe(false);
    expect(reading.figures).toBe("no provider budgets reported");
  });

  test("does not say All clear when gauges are present and healthy", () => {
    const reading = readBudgetSection([
      gauge({ id: "codex", label: "codex", fill: 0.14 }),
      gauge({ id: "claude", label: "claude", fill: 0.08 }),
      gauge({ id: "kimi", label: "kimi", fill: 0.02 }),
      gauge({ id: "grok", label: "grok", fill: 0 }),
      gauge({ id: "cursor", label: "cursor", fill: 0 }),
      gauge({ id: "minimax", label: "minimax", fill: 0 }),
      gauge({ id: "github", label: "github", fill: 0.05 }),
    ]);
    expect(reading.verdict).toBe("Peak 14%");
    expect(reading.showGauges).toBe(true);
    expect(reading.configured).toBe(7);
    expect(reading.unused).toBe(3);
    expect(reading.figures).toContain("7 configured");
    expect(reading.figures).toContain("3 unused");
    expect(reading.verdict.toLowerCase()).not.toContain("all clear");
  });

  test("names providers that are near ceiling", () => {
    const reading = readBudgetSection([
      gauge({ id: "codex", label: "codex", fill: 0.92 }),
      gauge({ id: "claude", label: "claude", fill: 0.14 }),
    ]);
    expect(reading.verdict).toBe("1 near ceiling");
    expect(reading.showGauges).toBe(true);
    expect(reading.figures).toContain("codex 92%");
  });

  test("unused gauges still render instead of All clear", () => {
    const reading = readBudgetSection([
      gauge({ id: "codex", label: "codex", fill: 0 }),
      gauge({ id: "claude", label: "claude", fill: 0 }),
    ]);
    expect(reading.verdict).toBe("Unused");
    expect(reading.showGauges).toBe(true);
    expect(reading.verdict.toLowerCase()).not.toContain("all clear");
  });
});
