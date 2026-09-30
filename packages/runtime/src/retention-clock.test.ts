import { describe, expect, test } from "bun:test";

import {
  isoWeekKey,
  resolveArchiveWeeks,
  resolveRetentionWeeks,
  retentionCutoff,
  startOfLocalWeek,
} from "./retention-clock.ts";

// Local-time helpers: these tests assert machine-local Monday boundaries, so
// expected values are built with the same Date constructor semantics instead
// of fixed epoch constants.
function localDate(year: number, month: number, day: number, hour = 0, minute = 0): number {
  return new Date(year, month, day, hour, minute).getTime();
}

describe("startOfLocalWeek", () => {
  test("returns Monday 00:00 of the containing week", () => {
    // 2026-09-21 is a Monday; the Sunday before it is 2026-09-20.
    const monday = localDate(2026, 8, 21, 12, 30);
    expect(startOfLocalWeek(monday)).toBe(localDate(2026, 8, 21));
    // Monday 00:00 itself is the boundary — it belongs to the new week.
    expect(startOfLocalWeek(localDate(2026, 8, 21))).toBe(localDate(2026, 8, 21));
    // Sunday night still belongs to the week that started the prior Monday.
    expect(startOfLocalWeek(localDate(2026, 8, 27, 23, 59))).toBe(localDate(2026, 8, 21));
    // Saturday mid-week.
    expect(startOfLocalWeek(localDate(2026, 8, 26, 8, 15))).toBe(localDate(2026, 8, 21));
  });
});

describe("retentionCutoff", () => {
  test("Monday 00:00: the cutoff is last week's Monday — week n−2 just rotated out", () => {
    const cutoff = retentionCutoff(localDate(2026, 8, 21), 2);
    expect(cutoff).toBe(localDate(2026, 8, 14));
  });

  test("Sunday 23:59: the cutoff is the same Monday — a full 14-day window", () => {
    const cutoff = retentionCutoff(localDate(2026, 8, 27, 23, 59), 2);
    expect(cutoff).toBe(localDate(2026, 8, 14));
  });

  test("mid-week: 7–14 days of retention depending on the day", () => {
    // Wednesday → this-week Monday minus one week = last Monday.
    expect(retentionCutoff(localDate(2026, 8, 23, 15), 2)).toBe(localDate(2026, 8, 14));
  });

  test("weeksLive=1 keeps only the current calendar week", () => {
    expect(retentionCutoff(localDate(2026, 8, 23, 15), 1)).toBe(localDate(2026, 8, 21));
    expect(retentionCutoff(localDate(2026, 8, 21), 1)).toBe(localDate(2026, 8, 21));
  });

  test("a week crossing a DST change still lands on Monday 00:00 local", () => {
    // America/Los_Angeles falls back on 2026-11-01; the week of 2026-11-02
    // contains the transition. Local-date arithmetic must land on midnight,
    // not a 23h/25h offset of it.
    const afterTransition = localDate(2026, 10, 4, 10); // Wed 2026-11-04
    const cutoff = retentionCutoff(afterTransition, 2);
    const cutoffDate = new Date(cutoff);
    expect(cutoffDate.getDay()).toBe(1);
    expect(cutoffDate.getHours()).toBe(0);
    expect(cutoffDate.getMinutes()).toBe(0);
    expect(cutoff).toBe(localDate(2026, 9, 26)); // Mon 2026-10-26
    // And stepping a local week back across the boundary lands on 00:00 too.
    expect(retentionCutoff(localDate(2026, 10, 2), 3)).toBe(localDate(2026, 9, 19));
  });
});

describe("isoWeekKey", () => {
  test("assigns the ISO week-year and week number", () => {
    // 2026-09-21 is Monday of ISO week 39.
    expect(isoWeekKey(localDate(2026, 8, 21))).toBe("2026-W39");
    // Same ISO week through Sunday.
    expect(isoWeekKey(localDate(2026, 8, 27, 23, 59))).toBe("2026-W39");
    // The following Monday starts W40.
    expect(isoWeekKey(localDate(2026, 8, 28))).toBe("2026-W40");
  });

  test("year-boundary dates belong to the adjacent ISO year", () => {
    // 2026-01-01 is a Thursday → ISO 2026-W01.
    expect(isoWeekKey(localDate(2026, 0, 1))).toBe("2026-W01");
    // 2025-12-29 is a Monday of ISO 2026-W01 (week containing Jan 1 2026).
    expect(isoWeekKey(localDate(2025, 11, 29))).toBe("2026-W01");
    // 2025-12-28 (Sunday) is still ISO 2025-W52.
    expect(isoWeekKey(localDate(2025, 11, 28))).toBe("2025-W52");
  });
});

describe("resolveRetentionWeeks / resolveArchiveWeeks", () => {
  test("defaults and minimums", () => {
    expect(resolveRetentionWeeks({})).toBe(2);
    expect(resolveArchiveWeeks({})).toBe(4);
    expect(resolveRetentionWeeks({ OPENSCOUT_RETENTION_WEEKS: "1" })).toBe(1);
    expect(resolveRetentionWeeks({ OPENSCOUT_RETENTION_WEEKS: "6" })).toBe(6);
  });

  test("0 disables, invalid input falls back to the default", () => {
    expect(resolveRetentionWeeks({ OPENSCOUT_RETENTION_WEEKS: "0" })).toBe(0);
    expect(resolveArchiveWeeks({ OPENSCOUT_ARCHIVE_WEEKS: "0" })).toBe(0);
    expect(resolveRetentionWeeks({ OPENSCOUT_RETENTION_WEEKS: "-3" })).toBe(2);
    expect(resolveRetentionWeeks({ OPENSCOUT_RETENTION_WEEKS: "bogus" })).toBe(2);
    expect(resolveRetentionWeeks({ OPENSCOUT_RETENTION_WEEKS: "  " })).toBe(2);
  });
});
