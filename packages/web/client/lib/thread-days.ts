import { normalizeTimestampMs, type TimestampInput } from "./time.ts";

/**
 * Helpers for grouping thread messages by calendar day.
 *
 * Both helpers accept either seconds-since-epoch or milliseconds-since-epoch
 * via the shared time helper so callers don't need to normalize inputs from
 * different sources.
 */

/** True when both timestamps fall on the same calendar day in local time. */
export function isSameCalendarDay(
  left: TimestampInput,
  right: TimestampInput,
): boolean {
  const leftValue = normalizeTimestampMs(left);
  const rightValue = normalizeTimestampMs(right);
  if (leftValue === null || rightValue === null) return false;

  const leftDate = new Date(leftValue);
  const rightDate = new Date(rightValue);
  return (
    leftDate.getFullYear() === rightDate.getFullYear() &&
    leftDate.getMonth() === rightDate.getMonth() &&
    leftDate.getDate() === rightDate.getDate()
  );
}

/**
 * Render a thread day divider label.
 *
 * "Today" / "Yesterday" for the current and previous calendar day in local
 * time; otherwise a short weekday/month/day in the user's locale.
 * Returns an empty string for unusable input.
 */
export function formatThreadDayLabel(value: TimestampInput): string {
  const normalized = normalizeTimestampMs(value);
  if (normalized === null) return "";

  const date = new Date(normalized);
  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const startOfTarget = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
  const oneDay = 24 * 60 * 60 * 1000;

  if (startOfTarget === startOfToday) return "Today";
  if (startOfTarget === startOfToday - oneDay) return "Yesterday";

  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(normalized);
}
