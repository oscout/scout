import { epochMs } from "../../protocol/time.js";

export type ClaudeCodeQuotaWindowObservation = {
  label: string;
  windowKind?: string;
  usedPercent?: number;
  percentRemaining?: number;
  used?: number;
  limit?: number;
  resetAt?: number;
  windowMs?: number;
};

export type ClaudeCodeQuotaObservation = {
  provider: "anthropic";
  capturedAt: number;
  planType?: string;
  userId?: string;
  accountId?: string;
  windows: ClaudeCodeQuotaWindowObservation[];
};

const QUOTA_EVENT_PATTERN = /(?:rate[_-]?limit|quota|usage[_-]?limit)/iu;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.trim().replace(/%$/u, ""));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function readNumber(source: Record<string, unknown> | undefined, keys: string[]): number | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const value = numberValue(source[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function readString(source: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const value = stringValue(source[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function timestampValue(value: unknown): number | undefined {
  const parsedEpoch = epochMs(value);
  if (parsedEpoch !== undefined) {
    return parsedEpoch;
  }

  const text = stringValue(value);
  if (!text) return undefined;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readTimestamp(source: Record<string, unknown> | undefined, keys: string[]): number | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const value = timestampValue(source[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function readWindowMs(source: Record<string, unknown> | undefined): number | undefined {
  const ms = readNumber(source, ["window_ms", "windowMs", "duration_ms", "durationMs", "interval_ms", "intervalMs"]);
  if (ms !== undefined) return ms;

  const seconds = readNumber(source, [
    "window_seconds",
    "windowSeconds",
    "duration_seconds",
    "durationSeconds",
    "interval_seconds",
    "intervalSeconds",
  ]);
  if (seconds !== undefined) return seconds * 1000;

  const minutes = readNumber(source, [
    "window_minutes",
    "windowMinutes",
    "duration_minutes",
    "durationMinutes",
    "interval_minutes",
    "intervalMinutes",
  ]);
  if (minutes !== undefined) return minutes * 60 * 1000;

  const hours = readNumber(source, ["window_hours", "windowHours", "duration_hours", "durationHours"]);
  return hours === undefined ? undefined : hours * 60 * 60 * 1000;
}

function readResetAt(source: Record<string, unknown> | undefined, capturedAt: number): number | undefined {
  const resetAt = readTimestamp(source, ["reset_at", "resetAt", "resets_at", "resetsAt"]);
  if (resetAt !== undefined) return resetAt;

  const resetAfterSeconds = readNumber(source, [
    "reset_after_seconds",
    "resetAfterSeconds",
    "seconds_until_reset",
    "secondsUntilReset",
  ]);
  return resetAfterSeconds === undefined ? undefined : capturedAt + (resetAfterSeconds * 1000);
}

function defaultWindowLabel(windowKind: string | undefined, index: number): string {
  if (windowKind === "secondary" || windowKind === "weekly") return "weekly";
  if (windowKind === "monthly") return "monthly";
  return index === 0 ? "5h" : "weekly";
}

function normalizedWindowKind(source: Record<string, unknown>, fallback: string | undefined): string | undefined {
  const kind = readString(source, ["window_kind", "windowKind", "kind", "type", "scope"]);
  if (kind && kind !== "rate_limit_event" && kind !== "rate_limits.updated") {
    return kind;
  }
  return fallback;
}

function quotaWindowFromRecord(
  value: unknown,
  index: number,
  capturedAt: number,
  fallbackKind?: string,
  fallbackLabel?: string,
): ClaudeCodeQuotaWindowObservation | null {
  const source = record(value);
  if (!source) return null;

  const windowKind = normalizedWindowKind(source, fallbackKind);
  const used = readNumber(source, [
    "used",
    "current",
    "current_usage",
    "currentUsage",
    "consumed",
    "tokens_used",
    "tokensUsed",
    "requests_used",
    "requestsUsed",
  ]);
  const limit = readNumber(source, ["limit", "quota", "max", "cap", "total", "tokens_limit", "tokensLimit"]);
  const remaining = readNumber(source, [
    "remaining",
    "tokens_remaining",
    "tokensRemaining",
    "requests_remaining",
    "requestsRemaining",
  ]);
  const usedPercent = readNumber(source, [
    "used_percent",
    "usedPercent",
    "usage_percent",
    "usagePercent",
    "percent_used",
    "percentUsed",
  ]) ?? (
    used !== undefined && limit !== undefined && limit > 0
      ? (used / limit) * 100
      : remaining !== undefined && limit !== undefined && limit > 0
        ? ((limit - remaining) / limit) * 100
        : undefined
  );
  const percentRemaining = readNumber(source, [
    "percent_remaining",
    "percentRemaining",
    "remaining_percent",
    "remainingPercent",
  ]) ?? (
    usedPercent !== undefined
      ? Math.max(0, 100 - usedPercent)
      : remaining !== undefined && limit !== undefined && limit > 0
        ? (remaining / limit) * 100
        : undefined
  );
  const resetAt = readResetAt(source, capturedAt);
  const windowMs = readWindowMs(source);

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
    label: readString(source, ["label", "name", "window", "windowLabel"]) ?? fallbackLabel ?? defaultWindowLabel(windowKind, index),
    windowKind,
    usedPercent,
    percentRemaining,
    used,
    limit,
    resetAt,
    windowMs,
  };
}

function quotaContainerFromEvent(event: Record<string, unknown>): Record<string, unknown> {
  for (const key of [
    "rate_limits",
    "rateLimits",
    "quota",
    "quotas",
    "usage_limits",
    "usageLimits",
    "limits",
    "payload",
    "data",
  ]) {
    const candidate = record(event[key]);
    if (candidate) return candidate;
  }
  return event;
}

function quotaWindowsFromContainer(
  container: Record<string, unknown>,
  capturedAt: number,
): ClaudeCodeQuotaWindowObservation[] {
  for (const key of ["rate_limits", "rateLimits", "quota", "quotas", "usage_limits", "usageLimits", "limits"]) {
    const nestedArray = arrayValue(container[key]);
    if (nestedArray.length > 0) {
      const windows = nestedArray.flatMap((value, index) => {
        const window = quotaWindowFromRecord(value, index, capturedAt);
        return window ? [window] : [];
      });
      if (windows.length > 0) return windows;
    }

    const nestedRecord = record(container[key]);
    if (nestedRecord) {
      const windows = quotaWindowsFromContainer(nestedRecord, capturedAt);
      if (windows.length > 0) return windows;
    }
  }

  const explicitWindows = arrayValue(container.windows)
    .flatMap((value, index) => {
      const window = quotaWindowFromRecord(value, index, capturedAt);
      return window ? [window] : [];
    });
  if (explicitWindows.length > 0) return explicitWindows;

  const namedWindows: Array<[string, string, string]> = [
    ["primary", "primary", "5h"],
    ["primary_window", "primary", "5h"],
    ["primaryWindow", "primary", "5h"],
    ["five_hour", "primary", "5h"],
    ["fiveHour", "primary", "5h"],
    ["secondary", "secondary", "weekly"],
    ["secondary_window", "secondary", "weekly"],
    ["secondaryWindow", "secondary", "weekly"],
    ["weekly", "secondary", "weekly"],
    ["weekly_window", "secondary", "weekly"],
    ["weeklyWindow", "secondary", "weekly"],
    ["monthly", "monthly", "monthly"],
    ["monthly_window", "monthly", "monthly"],
    ["monthlyWindow", "monthly", "monthly"],
  ];
  const fromNamed = namedWindows.flatMap(([key, kind, label], index) => {
    const window = quotaWindowFromRecord(container[key], index, capturedAt, kind, label);
    return window ? [window] : [];
  });
  if (fromNamed.length > 0) return fromNamed;

  const single = quotaWindowFromRecord(container, 0, capturedAt);
  return single ? [single] : [];
}

export function isClaudeCodeQuotaEvent(event: unknown): boolean {
  const root = record(event);
  if (!root) return false;
  const type = readString(root, ["type", "name", "event"]);
  if (type && QUOTA_EVENT_PATTERN.test(type)) return true;

  const nested = record(root.event);
  const nestedType = readString(nested, ["type", "name", "event"]);
  return Boolean(nestedType && QUOTA_EVENT_PATTERN.test(nestedType));
}

export function readClaudeCodeQuotaObservation(
  event: unknown,
  now = Date.now(),
): ClaudeCodeQuotaObservation | null {
  const root = record(event);
  if (!root || !isClaudeCodeQuotaEvent(root)) return null;

  const nestedEvent = record(root.event);
  const source = nestedEvent && isClaudeCodeQuotaEvent(nestedEvent) ? nestedEvent : root;
  const capturedAt = readTimestamp(source, ["captured_at", "capturedAt", "timestamp", "created_at", "createdAt"])
    ?? now;
  const container = quotaContainerFromEvent(source);
  const windows = quotaWindowsFromContainer(container, capturedAt);
  if (windows.length === 0) return null;

  return {
    provider: "anthropic",
    capturedAt,
    planType: readString(container, ["plan_type", "planType", "tier", "subscription", "account_plan", "accountPlan"]),
    userId: readString(container, ["user_id", "userId"]),
    accountId: readString(container, ["account_id", "accountId", "organization_id", "organizationId"]),
    windows,
  };
}
