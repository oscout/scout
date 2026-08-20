import { readObservedProviderBudgetObservations } from "../budget-common.js";
import type {
  AdapterBudgetObservationInput,
  AdapterBudgetObservations,
} from "../../protocol/budget-observations.js";
import { epochMs } from "../../protocol/time.js";

export type CodexQuotaWindowObservation = {
  label: string;
  windowKind?: string;
  usedPercent?: number;
  percentRemaining?: number;
  used?: number;
  limit?: number;
  resetAt?: number;
  windowMs?: number;
};

export type CodexUsageObservation = {
  /**
   * Which rate-limit pool this observation describes (`rate_limits.limit_id`).
   * Codex Desktop interleaves more than one pool in a single session — the
   * account's `codex` weekly window alongside separate promotional/experimental
   * pools — so a reading is only comparable against another from the same pool.
   */
  limitId?: string;
  inputTokens?: number;
  contextInputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
  contextWindowTokens?: number;
  planType?: string;
  quotaWindows: CodexQuotaWindowObservation[];
};

export function readCodexBudgetObservations(
  input: AdapterBudgetObservationInput,
  now = Date.now(),
): AdapterBudgetObservations {
  return readObservedProviderBudgetObservations(input, {
    provider: "openai",
    includeQuotaWindows: true,
    usageMetadataSource: "codex.providerMeta.observeUsage",
    quotaMetadataSource: "codex.providerMeta.observeQuota",
  }, now);
}

function observedRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function observedNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function observedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readObservedNumber(
  record: Record<string, unknown> | undefined,
  keys: string[],
): number | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = observedNumber(record[key]);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function readObservedString(
  record: Record<string, unknown> | undefined,
  keys: string[],
): string | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = observedString(record[key]);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function prefixedRateLimitKeys(prefixes: string[], keys: string[]): string[] {
  return prefixes.flatMap((prefix) => keys.flatMap((key) => [
    `${prefix}_${key}`,
    `${prefix}${key.slice(0, 1).toUpperCase()}${key.slice(1)}`,
  ]));
}

function readRateLimitNumber(
  rateLimits: Record<string, unknown>,
  source: Record<string, unknown> | undefined,
  prefixes: string[],
  keys: string[],
): number | undefined {
  return readObservedNumber(source, keys)
    ?? readObservedNumber(rateLimits, prefixedRateLimitKeys(prefixes, keys));
}

function readRateLimitString(
  rateLimits: Record<string, unknown>,
  source: Record<string, unknown> | undefined,
  prefixes: string[],
  keys: string[],
): string | undefined {
  return readObservedString(source, keys)
    ?? readObservedString(rateLimits, prefixedRateLimitKeys(prefixes, keys));
}

function parseCodexTimestamp(value: unknown): number | undefined {
  const parsedEpoch = epochMs(value);
  if (parsedEpoch !== undefined) {
    return parsedEpoch;
  }

  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function readRateLimitTimestamp(
  rateLimits: Record<string, unknown>,
  source: Record<string, unknown> | undefined,
  prefixes: string[],
  timestamp: number,
): number | undefined {
  const resetAt = parseCodexTimestamp(readRateLimitString(rateLimits, source, prefixes, [
    "reset_at",
    "resetAt",
    "resets_at",
    "resetsAt",
  ]));
  if (resetAt !== undefined) {
    return resetAt;
  }

  const resetAtNumber = readRateLimitNumber(rateLimits, source, prefixes, [
    "reset_at",
    "resetAt",
    "resets_at",
    "resetsAt",
  ]);
  if (resetAtNumber !== undefined) {
    return parseCodexTimestamp(resetAtNumber);
  }

  const resetAfterSeconds = readRateLimitNumber(rateLimits, source, prefixes, [
    "reset_after_seconds",
    "resetAfterSeconds",
    "seconds_until_reset",
    "secondsUntilReset",
  ]);
  return resetAfterSeconds === undefined ? undefined : timestamp + (resetAfterSeconds * 1000);
}

function readRateLimitWindowMs(
  rateLimits: Record<string, unknown>,
  source: Record<string, unknown> | undefined,
  prefixes: string[],
): number | undefined {
  const windowMs = readRateLimitNumber(rateLimits, source, prefixes, ["window_ms", "windowMs", "duration_ms", "durationMs"]);
  if (windowMs !== undefined) {
    return windowMs;
  }

  const windowSeconds = readRateLimitNumber(rateLimits, source, prefixes, [
    "window_seconds",
    "windowSeconds",
    "duration_seconds",
    "durationSeconds",
  ]);
  if (windowSeconds !== undefined) {
    return windowSeconds * 1000;
  }

  const windowMinutes = readRateLimitNumber(rateLimits, source, prefixes, [
    "window_minutes",
    "windowMinutes",
    "duration_minutes",
    "durationMinutes",
  ]);
  return windowMinutes === undefined ? undefined : windowMinutes * 60 * 1000;
}

/**
 * Codex rate-limit slots are named primary/secondary, but their *duration* is
 * authoritative (`window_minutes`). Recent Pro snapshots put the weekly window
 * in `primary` with `secondary: null` — never hardcode primary→5h.
 */
function formatCodexQuotaWindowLabel(
  windowMs: number | undefined,
  fallback: string,
): string {
  if (windowMs === undefined || !Number.isFinite(windowMs) || windowMs <= 0) {
    return fallback;
  }
  const minutes = Math.round(windowMs / 60_000);
  if (minutes <= 0) {
    return fallback;
  }
  if (minutes % (24 * 60) === 0) {
    return `${minutes / (24 * 60)}d`;
  }
  if (minutes % 60 === 0) {
    return `${minutes / 60}h`;
  }
  return `${minutes}m`;
}

function codexQuotaWindowFromRateLimit(
  rateLimits: Record<string, unknown>,
  sourceKeys: string[],
  label: string,
  windowKind: string,
  timestamp: number,
): CodexQuotaWindowObservation | null {
  const source = sourceKeys.map((key) => observedRecord(rateLimits[key])).find(Boolean);
  const usedPercent = readRateLimitNumber(rateLimits, source, sourceKeys, [
    "used_percent",
    "usedPercent",
    "usage_percent",
    "usagePercent",
    "percent_used",
    "percentUsed",
  ]);
  const percentRemaining = readRateLimitNumber(rateLimits, source, sourceKeys, [
    "percent_remaining",
    "percentRemaining",
    "remaining_percent",
    "remainingPercent",
  ]);
  const used = readRateLimitNumber(rateLimits, source, sourceKeys, [
    "used",
    "current",
    "current_usage",
    "currentUsage",
    "requests_used",
    "requestsUsed",
  ]);
  const limit = readRateLimitNumber(rateLimits, source, sourceKeys, [
    "limit",
    "quota",
    "max",
    "requests_limit",
    "requestsLimit",
  ]);
  const resetAt = readRateLimitTimestamp(rateLimits, source, sourceKeys, timestamp);
  const windowMs = readRateLimitWindowMs(rateLimits, source, sourceKeys);

  if (
    usedPercent === undefined
    && percentRemaining === undefined
    && used === undefined
    && limit === undefined
    && resetAt === undefined
    && windowMs === undefined
  ) {
    return null;
  }

  return {
    label: readRateLimitString(rateLimits, source, sourceKeys, ["label", "name"])
      ?? formatCodexQuotaWindowLabel(windowMs, label),
    windowKind: readRateLimitString(rateLimits, source, sourceKeys, ["window_kind", "windowKind", "kind"]) ?? windowKind,
    usedPercent,
    percentRemaining,
    used,
    limit,
    resetAt,
    windowMs,
  };
}

function codexQuotaWindowFromRecord(
  value: unknown,
  index: number,
  timestamp: number,
): CodexQuotaWindowObservation | null {
  const source = observedRecord(value);
  if (!source) {
    return null;
  }
  const usedPercent = readObservedNumber(source, [
    "used_percent",
    "usedPercent",
    "usage_percent",
    "usagePercent",
    "percent_used",
    "percentUsed",
  ]);
  const percentRemaining = readObservedNumber(source, ["percent_remaining", "percentRemaining", "remaining_percent", "remainingPercent"]);
  const resetAt = parseCodexTimestamp(readObservedString(source, ["reset_at", "resetAt", "resets_at", "resetsAt"]))
    ?? parseCodexTimestamp(readObservedNumber(source, ["reset_at", "resetAt", "resets_at", "resetsAt"]))
    ?? (() => {
      const resetAfterSeconds = readObservedNumber(source, ["reset_after_seconds", "resetAfterSeconds"]);
      return resetAfterSeconds === undefined ? undefined : timestamp + (resetAfterSeconds * 1000);
    })();
  const windowMs = readObservedNumber(source, ["window_ms", "windowMs", "duration_ms", "durationMs"])
    ?? (() => {
      const seconds = readObservedNumber(source, ["window_seconds", "windowSeconds", "duration_seconds", "durationSeconds"]);
      return seconds === undefined ? undefined : seconds * 1000;
    })()
    ?? (() => {
      const minutes = readObservedNumber(source, ["window_minutes", "windowMinutes", "duration_minutes", "durationMinutes"]);
      return minutes === undefined ? undefined : minutes * 60 * 1000;
    })();
  const windowKind = readObservedString(source, ["window_kind", "windowKind", "kind"])
    ?? (index === 0 ? "primary" : "secondary");
  const fallbackLabel = windowKind === "secondary" ? "weekly" : index === 0 ? "5h" : "weekly";
  const label = readObservedString(source, ["label", "name"])
    ?? formatCodexQuotaWindowLabel(windowMs, fallbackLabel);

  return {
    label,
    windowKind,
    usedPercent,
    percentRemaining,
    used: readObservedNumber(source, ["used", "current", "current_usage", "currentUsage"]),
    limit: readObservedNumber(source, ["limit", "quota", "max"]),
    resetAt,
    windowMs,
  };
}

export function readCodexQuotaWindowsFromRateLimits(
  rateLimits: unknown,
  timestamp: number,
): CodexQuotaWindowObservation[] {
  const rateLimitRecord = observedRecord(rateLimits);
  if (!rateLimitRecord) {
    return [];
  }

  const rawWindows = Array.isArray(rateLimitRecord.windows)
    ? rateLimitRecord.windows.flatMap((value, index) => {
      const window = codexQuotaWindowFromRecord(value, index, timestamp);
      return window ? [window] : [];
    })
    : [];
  if (rawWindows.length > 0) {
    return rawWindows;
  }

  return [
    codexQuotaWindowFromRateLimit(
      rateLimitRecord,
      ["primary", "primary_window", "primaryWindow", "five_hour", "fiveHour", "five_hour_window", "fiveHourWindow"],
      "5h",
      "primary",
      timestamp,
    ),
    codexQuotaWindowFromRateLimit(
      rateLimitRecord,
      ["secondary", "secondary_window", "secondaryWindow", "weekly", "weekly_window", "weeklyWindow"],
      "weekly",
      "secondary",
      timestamp,
    ),
  ].filter((window): window is CodexQuotaWindowObservation => Boolean(window));
}

export function readCodexRolloutUsageObservation(
  payload: unknown,
  timestamp: number,
): CodexUsageObservation | null {
  const record = observedRecord(payload);
  if (!record) {
    return null;
  }

  const info = observedRecord(record.info);
  const totalTokenUsage = observedRecord(info?.total_token_usage);
  const lastTokenUsage = observedRecord(info?.last_token_usage);
  const rateLimits = observedRecord(record.rate_limits);
  const inputTokens = observedNumber(totalTokenUsage?.input_tokens);
  // Codex `cached_input_tokens` is a *subset* of `input_tokens` (cache hits),
  // not an additive bucket like Claude's cache_read/cache_creation fields.
  // Context fill is the latest-turn input size, never input + cached.
  const lastInputTokens = observedNumber(lastTokenUsage?.input_tokens);
  const cacheReadInputTokens = readObservedNumber(totalTokenUsage, [
    "cached_input_tokens",
    "cache_read_input_tokens",
    "cacheReadInputTokens",
  ]);
  const cacheCreationInputTokens = readObservedNumber(totalTokenUsage, [
    "cache_creation_input_tokens",
    "cache_write_input_tokens",
    "cacheCreationInputTokens",
  ]);
  const outputTokens = observedNumber(totalTokenUsage?.output_tokens);
  const observation: CodexUsageObservation = {
    inputTokens,
    contextInputTokens: lastInputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    outputTokens,
    reasoningOutputTokens: observedNumber(totalTokenUsage?.reasoning_output_tokens),
    totalTokens: observedNumber(totalTokenUsage?.total_tokens)
      ?? (
        inputTokens !== undefined || outputTokens !== undefined
          ? (inputTokens ?? 0) + (outputTokens ?? 0)
          : undefined
      ),
    contextWindowTokens: observedNumber(info?.model_context_window)
      ?? observedNumber(record.model_context_window),
    planType: observedString(rateLimits?.plan_type),
    limitId: observedString(rateLimits?.limit_id),
    quotaWindows: readCodexQuotaWindowsFromRateLimits(rateLimits, timestamp),
  };

  const hasUsage = [
    observation.inputTokens,
    observation.contextInputTokens,
    observation.cacheReadInputTokens,
    observation.cacheCreationInputTokens,
    observation.outputTokens,
    observation.reasoningOutputTokens,
    observation.totalTokens,
    observation.contextWindowTokens,
  ].some((value) => typeof value === "number" && Number.isFinite(value));

  return hasUsage || observation.planType || observation.quotaWindows.length > 0
    ? observation
    : null;
}
