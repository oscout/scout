/**
 * The one retention clock. Policy: the current calendar week and the previous
 * complete week are always live; at the Monday boundary only week n−2 rotates
 * out. Weeks start Monday 00:00 machine-local, so effective retention is
 * 7–14 days depending on where `now` lands in the week — there is no
 * `now − X` rolling cutoff anywhere.
 */

export type RetentionClock = {
  /** Calendar weeks start Monday (ISO 8601). */
  weekStartsOn: 1;
  /** Live calendar weeks including the current one. Minimum 1. */
  weeksLive: number;
};

const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;

export const DEFAULT_RETENTION_WEEKS = 2;
export const DEFAULT_ARCHIVE_WEEKS = 4;

/** Local-week arithmetic: Date handles DST transitions that fixed-ms jumps cannot. */
function addLocalWeeks(timestampMs: number, weeks: number): number {
  const date = new Date(timestampMs);
  date.setDate(date.getDate() + weeks * 7);
  return date.getTime();
}

/** Monday 00:00 machine-local of the week containing `now`, epoch ms. */
export function startOfLocalWeek(now: number): number {
  const date = new Date(now);
  // getDay: 0=Sunday..6=Saturday → days elapsed since Monday.
  const daysSinceMonday = (date.getDay() + 6) % 7;
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() - daysSinceMonday,
  ).getTime();
}

/**
 * Oldest timestamp still live: Monday 00:00 of the earliest live week. With
 * weeksLive=2 this is last week's Monday — so today (this week) and all of
 * last week are always retained, whatever day `now` falls on.
 */
export function retentionCutoff(now: number, weeksLive = DEFAULT_RETENTION_WEEKS): number {
  const weeks = Number.isFinite(weeksLive) ? Math.max(1, Math.floor(weeksLive)) : 1;
  return addLocalWeeks(startOfLocalWeek(now), -(weeks - 1));
}

/**
 * ISO 8601 week key (`YYYY-Www`) for archive file names — Monday-start weeks,
 * week 1 contains the year's first Thursday.
 */
export function isoWeekKey(timestampMs: number): string {
  const date = new Date(timestampMs);
  date.setHours(0, 0, 0, 0);
  // Shift to Thursday of this week: the ISO week-numbering year.
  date.setDate(date.getDate() + 3 - ((date.getDay() + 6) % 7));
  const isoYear = date.getFullYear();
  const firstThursday = new Date(isoYear, 0, 4);
  firstThursday.setHours(0, 0, 0, 0);
  firstThursday.setDate(firstThursday.getDate() + 3 - ((firstThursday.getDay() + 6) % 7));
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / WEEK_MS);
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

function resolveWeekCount(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (parsed === 0) return 0;
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.max(1, parsed);
}

/**
 * OPENSCOUT_RETENTION_WEEKS: live calendar weeks for the in-memory/journal hot
 * set and the registry sweep. Default 2, minimum 1; "0" disables week-clock
 * retention entirely (returns 0).
 */
export function resolveRetentionWeeks(
  env: Record<string, string | undefined> = process.env,
): number {
  return resolveWeekCount(env.OPENSCOUT_RETENTION_WEEKS, DEFAULT_RETENTION_WEEKS);
}

/**
 * OPENSCOUT_ARCHIVE_WEEKS: how long SQLite keeps rows before archive-then-
 * prune. Default 4, minimum 1; "0" disables archiving (returns 0).
 */
export function resolveArchiveWeeks(
  env: Record<string, string | undefined> = process.env,
): number {
  return resolveWeekCount(env.OPENSCOUT_ARCHIVE_WEEKS, DEFAULT_ARCHIVE_WEEKS);
}
