/**
 * Pending includes the debounce window, but excludes failed and blank queries.
 * Search answers with or without an index (basic scan), so any typed query is
 * awaiting an answer until its own result or failure lands.
 */
export function isSearchUnanswered(input: {
  query: string;
  filterKey: string;
  settledFilterKey: string | null;
  failedFilterKey: string | null;
}): boolean {
  return Boolean(input.query.trim())
    && input.filterKey !== input.settledFilterKey
    && input.filterKey !== input.failedFilterKey;
}

/** A completed failure can arrive before the first in-progress status poll. */
export function latestIndexFailure(status: {
  indexing?: { startedAt: number } | null;
  lastIndex?: { finishedAt: number; ok: boolean; error?: string } | null;
} | null, requestedAt: number | null): string | null {
  const last = status?.lastIndex;
  if (requestedAt === null || status?.indexing || !last || last.ok || last.finishedAt < requestedAt) return null;
  return `Indexing failed: ${last.error ?? "unknown error"}`;
}
