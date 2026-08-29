/** ASCII budget meters for Host Advisor. Glyphs are 1ch-wide in the product mono. */

export const NEAR_CEILING = 0.8;
export const ASCII_GAUGE_CELLS = 20;
export const ASCII_GAUGE_FILL = "░";
export const ASCII_GAUGE_EMPTY = "·";

const EIGHTHS = ["▏", "▎", "▍", "▌", "▋", "▊", "▉"] as const;

export type AsciiGaugeBar = {
  filled: string;
  rest: string;
  cells: number;
  percent: number;
};

export type AsciiGaugeCell = {
  glyph: string;
  filled: boolean;
};

export type BudgetGauge = {
  id: string;
  label: string;
  kind?: "quota" | "status";
  fill?: number;
  usedLabel?: string;
  resetAt?: number;
  statusLabel?: string;
};

export type BudgetSectionReading = {
  verdict: string;
  figures: string;
  showGauges: boolean;
  near: BudgetGauge[];
  unused: number;
  configured: number;
  peakPercent: number | null;
};

/**
 * 20-cell track: `░` fill, one eighth remainder as the needle, `·` empty.
 * `█` is avoided on purpose — it tiles into a solid CSS bar at this size.
 */
export function asciiGaugeBar(fill: number, cells = ASCII_GAUGE_CELLS): AsciiGaugeBar {
  const clamped = Number.isFinite(fill) ? Math.min(1, Math.max(0, fill)) : 0;
  const percent = Math.round(clamped * 100);
  if (clamped <= 0) {
    return { filled: "", rest: ASCII_GAUGE_EMPTY.repeat(cells), cells, percent: 0 };
  }

  const exact = clamped * cells;
  let full = Math.floor(exact);
  let eighth = Math.round((exact - full) * 8);
  if (eighth === 8) {
    full += 1;
    eighth = 0;
  }

  if (full >= cells) {
    return { filled: ASCII_GAUGE_FILL.repeat(cells), rest: "", cells, percent };
  }

  if (eighth === 0) {
    if (full === 0) {
      return { filled: "▏", rest: ASCII_GAUGE_EMPTY.repeat(cells - 1), cells, percent };
    }
    return {
      filled: ASCII_GAUGE_FILL.repeat(full),
      rest: ASCII_GAUGE_EMPTY.repeat(cells - full),
      cells,
      percent,
    };
  }

  return {
    filled: ASCII_GAUGE_FILL.repeat(full) + EIGHTHS[eighth - 1],
    rest: ASCII_GAUGE_EMPTY.repeat(cells - full - 1),
    cells,
    percent,
  };
}

export function asciiGaugeCells(bar: AsciiGaugeBar): AsciiGaugeCell[] {
  return [
    ...[...bar.filled].map((glyph) => ({ glyph, filled: true })),
    ...[...bar.rest].map((glyph) => ({ glyph, filled: false })),
  ];
}

export function gaugeFill(gauge: BudgetGauge): number | null {
  if (gauge.kind === "status") return null;
  if (typeof gauge.fill !== "number" || !Number.isFinite(gauge.fill)) return null;
  return Math.min(1, Math.max(0, gauge.fill));
}

export function isNearCeiling(gauge: BudgetGauge): boolean {
  const fill = gaugeFill(gauge);
  return fill !== null && fill >= NEAR_CEILING;
}

export function isUnusedGauge(gauge: BudgetGauge): boolean {
  const fill = gaugeFill(gauge);
  return fill === 0;
}

export function readBudgetSection(gauges: BudgetGauge[] | null): BudgetSectionReading {
  if (gauges === null) {
    return {
      verdict: "Reading",
      figures: "provider budgets still arriving",
      showGauges: false,
      near: [],
      unused: 0,
      configured: 0,
      peakPercent: null,
    };
  }

  if (gauges.length === 0) {
    return {
      verdict: "All clear",
      figures: "no provider budgets reported",
      showGauges: false,
      near: [],
      unused: 0,
      configured: 0,
      peakPercent: null,
    };
  }

  const near = [...gauges]
    .filter(isNearCeiling)
    .sort((left, right) => (gaugeFill(right) ?? 0) - (gaugeFill(left) ?? 0));
  const unused = gauges.filter(isUnusedGauge).length;
  const measured = gauges
    .map(gaugeFill)
    .filter((fill): fill is number => fill !== null);
  const peakPercent = measured.length > 0
    ? Math.round(Math.max(...measured) * 100)
    : null;
  const used = gauges.length - unused;

  let verdict: string;
  if (near.length > 0) {
    verdict = `${near.length} near ceiling`;
  } else if (used === 0) {
    verdict = "Unused";
  } else {
    verdict = `Peak ${peakPercent ?? 0}%`;
  }

  const figures = [
    near.length > 0
      ? near
        .map((gauge) => `${gauge.label} ${Math.round((gaugeFill(gauge) ?? 0) * 100)}%`)
        .join(" · ")
      : null,
    `${gauges.length} configured`,
    unused > 0 && used > 0 ? `${unused} unused` : null,
  ].filter(Boolean).join(" · ");

  return {
    verdict,
    figures,
    showGauges: true,
    near,
    unused,
    configured: gauges.length,
    peakPercent,
  };
}
