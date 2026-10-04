/**
 * Reset labels for the cockpit's quota rows.
 *
 * A reset in the past means the window rolled over, not that the window is
 * overdue: the reading simply predates it (nothing has ticked the provider
 * since). So past resets read as "rolled over", never as a countdown into
 * negative time.
 */

const SHORT_WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** Just past a reset, the next refresh is expected to carry the new window. */
const RESET_DUE_GRACE_MS = 90_000;

export type QuotaResetWindow = {
  resetAt: number;
  /** Server-side: the last reading predates the reset; usage is unknown. */
  awaitingReset?: boolean;
};

export type WeeklyResetCountdown = {
  primary: string;
  secondary: string;
  ariaLabel: string;
  tone: "normal" | "imminent" | "due" | "unknown";
  dateTime?: string;
};

export function quotaWindowRolledOver(window: QuotaResetWindow, now: Date): boolean {
  if (window.awaitingReset === true) return true;
  return Number.isFinite(window.resetAt) && window.resetAt <= now.getTime();
}

export function formatResetChip(resetAt: number, now: Date): { label: string; imminent: boolean } {
  const diffMs = resetAt - now.getTime();
  const sameDay = new Date(resetAt).toDateString() === now.toDateString();
  const reset = new Date(resetAt);
  const hh = String(reset.getHours()).padStart(2, "0");
  const mm = String(reset.getMinutes()).padStart(2, "0");
  const imminent = diffMs > 0 && diffMs < 6 * 3600 * 1000;
  if (sameDay) {
    return { label: `${hh}:${mm}`, imminent };
  }
  return { label: `${SHORT_WEEKDAY[reset.getDay()]} ${hh}:${mm}`, imminent };
}

export function formatResetRelative(window: QuotaResetWindow, now: Date): string {
  if (quotaWindowRolledOver(window, now)) return "rolled over";
  const diffSec = Math.floor((window.resetAt - now.getTime()) / 1000);
  if (diffSec >= 86400) {
    const d = Math.floor(diffSec / 86400);
    const h = Math.floor((diffSec % 86400) / 3600);
    return h > 0 ? `${d}d ${h}h` : `${d}d`;
  }
  if (diffSec >= 3600) {
    const h = Math.floor(diffSec / 3600);
    const m = Math.floor((diffSec % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  return `${Math.max(1, Math.floor(diffSec / 60))}m`;
}

export function formatWeeklyResetCountdown(window: QuotaResetWindow, now: Date): WeeklyResetCountdown {
  const { resetAt } = window;
  const reset = new Date(resetAt);
  if (!Number.isFinite(resetAt) || !Number.isFinite(reset.getTime())) {
    return {
      primary: "—",
      secondary: "unknown",
      ariaLabel: "Weekly reset time unknown",
      tone: "unknown",
    };
  }

  const dateTime = reset.toISOString();
  const diffMs = resetAt - now.getTime();
  if (diffMs <= 0 && -diffMs <= RESET_DUE_GRACE_MS && window.awaitingReset !== true) {
    return {
      primary: "reset due",
      secondary: "refreshing…",
      ariaLabel: "Weekly reset due; refreshing usage",
      tone: "due",
      dateTime,
    };
  }
  if (quotaWindowRolledOver(window, now)) {
    return {
      primary: "rolled over",
      secondary: "awaiting reading",
      ariaLabel: "Weekly quota rolled over; waiting for a fresh usage reading",
      tone: "due",
    };
  }

  const totalSeconds = Math.floor(diffMs / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const clock = [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
  const primary = days > 0 ? `${days}d ${clock}` : clock;
  const today = reset.toDateString() === now.toDateString();
  const absolute = reset.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const secondary = today
    ? `today ${absolute}`
    : `${reset.toLocaleDateString([], { weekday: "short" })} ${absolute}`;
  const coarse = days > 0
    ? `${days} ${days === 1 ? "day" : "days"} ${hours} hours`
    : `${hours} hours ${minutes} minutes`;
  return {
    primary,
    secondary,
    ariaLabel: `Weekly quota resets in ${coarse}; ${secondary}`,
    tone: diffMs < 6 * 60 * 60_000 ? "imminent" : "normal",
    dateTime,
  };
}
