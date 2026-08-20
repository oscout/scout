import { inferModelContextWindowTokens } from "@openscout/agent-sessions/client";
import type { ObserveUsageMeta } from "./types.ts";

const TOKEN_COMPACT = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export type ContextBudgetGauge = {
  used: number;
  budget: number;
  /** Rounded display percent; may exceed 100 when the session is over limit. */
  pct: number;
  overLimit: boolean;
  usedLabel: string;
  budgetLabel: string;
};

export function formatContextTokenCount(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value >= 1000
    ? TOKEN_COMPACT.format(value).toLowerCase()
    : `${value}`;
}

export function deriveContextBudgetGauge(
  usage: ObserveUsageMeta | null | undefined,
  options?: {
    model?: string | null;
    adapterType?: string | null;
  },
): ContextBudgetGauge | null {
  const used = usage?.contextInputTokens;
  if (typeof used !== "number" || !Number.isFinite(used) || used <= 0) {
    return null;
  }

  const budget =
    usage?.contextWindowTokens
    ?? inferModelContextWindowTokens({
      model: options?.model,
      adapterType: options?.adapterType,
    });
  if (typeof budget !== "number" || !Number.isFinite(budget) || budget <= 0) {
    return null;
  }

  const pct = Math.max(0, Math.round((used / budget) * 100));
  return {
    used,
    budget,
    pct,
    overLimit: used > budget,
    usedLabel: formatContextTokenCount(used)!,
    budgetLabel: formatContextTokenCount(budget)!,
  };
}

/** Bar fill width for the gauge — caps at 100 even when over limit. */
export function contextBudgetBarWidth(gauge: ContextBudgetGauge): number {
  return Math.min(100, gauge.pct);
}