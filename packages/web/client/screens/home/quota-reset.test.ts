import { describe, expect, test } from "bun:test";

import {
  formatResetRelative,
  formatWeeklyResetCountdown,
  quotaWindowRolledOver,
} from "./quota-reset.ts";

const HOUR = 60 * 60 * 1000;
const now = new Date("2026-10-01T22:00:00");

describe("quota reset labels", () => {
  test("a short window whose reset passed a day ago reads as rolled over, not stale", () => {
    // The cockpit bug: claude 5h "↻ stale 1d 1h".
    const window = { resetAt: now.getTime() - 25 * HOUR };
    expect(quotaWindowRolledOver(window, now)).toBe(true);
    expect(formatResetRelative(window, now)).toBe("rolled over");
  });

  test("a weekly reset 23h past is rolled over, never a countdown into negative time", () => {
    // The cockpit bug: red "stale" over "+23h 0m".
    const countdown = formatWeeklyResetCountdown({ resetAt: now.getTime() - 23 * HOUR }, now);
    expect(countdown).toEqual(expect.objectContaining({
      primary: "rolled over",
      secondary: "awaiting reading",
      tone: "due",
    }));
    expect(countdown.secondary).not.toContain("+");
  });

  test("a window the server marks awaitingReset is rolled over even with a forwarded future reset", () => {
    const window = { resetAt: now.getTime() + 6 * 24 * HOUR, awaitingReset: true };
    expect(formatResetRelative(window, now)).toBe("rolled over");
    expect(formatWeeklyResetCountdown(window, now).primary).toBe("rolled over");
  });

  test("just past a reset still reads as due while the next refresh lands", () => {
    const countdown = formatWeeklyResetCountdown({ resetAt: now.getTime() - 30_000 }, now);
    expect(countdown).toEqual(expect.objectContaining({ primary: "reset due", secondary: "refreshing…" }));
  });

  test("a future reset counts down as before", () => {
    const resetAt = now.getTime() + (6 * 24 + 14) * HOUR + 18 * 60_000 + 25_000;
    expect(formatWeeklyResetCountdown({ resetAt }, now).primary).toBe("6d 14:18:25");
    expect(formatResetRelative({ resetAt: now.getTime() + 2 * HOUR + 5 * 60_000 }, now)).toBe("2h 5m");
  });

  test("an unknown reset is dim, not alarming", () => {
    expect(formatWeeklyResetCountdown({ resetAt: Number.NaN }, now).tone).toBe("unknown");
  });
});
