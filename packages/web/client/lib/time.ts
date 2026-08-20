import { epochMs } from "@openscout/protocol";

export type TimestampInput = number | string | null | undefined;

/**
 * Convert any UI timestamp to epoch milliseconds.
 *
 * UI surfaces should call this helper rather than re-guessing seconds vs ms at
 * each call site. The seconds branch is a temporary defensive bridge for legacy
 * API payloads.
 */
export function normalizeTimestampMs(value: TimestampInput): number | null {
  return epochMs(value);
}

function relativeTimestampParts(ts: TimestampInput, nowMs: number): {
  label: string;
  future: boolean;
} | null {
  const tsMs = normalizeTimestampMs(ts);
  if (tsMs === null) return null;
  const diffSeconds = Math.floor((nowMs - tsMs) / 1000);
  const future = diffSeconds < -4;
  const seconds = Math.abs(diffSeconds);
  if (seconds < 5) return { label: "now", future: false };
  if (seconds < 60) return { label: `${seconds}s`, future };
  if (seconds < 3600) return { label: `${Math.floor(seconds / 60)}m`, future };
  if (seconds < 86400) return { label: `${Math.floor(seconds / 3600)}h`, future };
  return { label: `${Math.floor(seconds / 86400)}d`, future };
}

export function compareTimestampsAsc(
  left: TimestampInput,
  right: TimestampInput,
): number {
  return (normalizeTimestampMs(left) ?? 0) - (normalizeTimestampMs(right) ?? 0);
}

export function compareTimestampsDesc(
  left: TimestampInput,
  right: TimestampInput,
): number {
  return compareTimestampsAsc(right, left);
}

/** Relative time label: "now", "5s", "10m", "2h", "3d". */
export function timeAgo(ts: TimestampInput, nowMs = Date.now()): string {
  const parts = relativeTimestampParts(ts, nowMs);
  if (!parts) return "";
  return parts.future ? `in ${parts.label}` : parts.label;
}

/** Relative sentence label: "just now", "5m ago", "in 2h". */
export function timeAgoWithSuffix(ts: TimestampInput, nowMs = Date.now()): string {
  const parts = relativeTimestampParts(ts, nowMs);
  if (!parts) return "";
  if (parts.label === "now") return "just now";
  return parts.future ? `in ${parts.label}` : `${parts.label} ago`;
}

/** Full human-readable timestamp. */
export function fullTimestamp(ts: TimestampInput): string {
  const tsMs = normalizeTimestampMs(ts);
  if (tsMs === null) return "";
  const d = new Date(tsMs);
  return d.toLocaleString(undefined, {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", second: "2-digit",
  });
}

/** Compact absolute timestamp for titles and thread headers. */
export function formatAbsoluteTimestamp(ts: TimestampInput): string {
  const tsMs = normalizeTimestampMs(ts);
  if (tsMs === null) return "";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(tsMs);
}

/** Local wall-clock timestamp for tail/log tables. */
export function formatClockTimestamp(ts: TimestampInput, options: { milliseconds?: boolean } = {}): string {
  const tsMs = normalizeTimestampMs(ts);
  if (tsMs === null) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: options.milliseconds ? 3 : undefined,
    hour12: false,
  }).format(tsMs);
}

/** Duration label for elapsed times. Never use this for epoch timestamps. */
export function formatDurationClock(durationMs: number | null | undefined): string {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) {
    return "";
  }
  const totalSeconds = Math.floor(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${minutes}:${ss}`;
}
