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
