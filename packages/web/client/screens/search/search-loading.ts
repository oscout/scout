/** Pending includes the debounce window, but excludes failed and unsearchable queries. */
export function isSearchUnanswered(input: {
  query: string;
  hasIndex: boolean;
  filterKey: string;
  settledFilterKey: string | null;
  failedFilterKey: string | null;
}): boolean {
  return Boolean(input.query.trim()) && input.hasIndex
    && input.filterKey !== input.settledFilterKey
    && input.filterKey !== input.failedFilterKey;
}
