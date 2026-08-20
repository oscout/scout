export type NavigationEntryLike = {
  type?: string;
};

export type PerformanceNavigationLike = {
  getEntriesByType?: (type: "navigation") => readonly NavigationEntryLike[];
  navigation?: {
    type?: number;
  };
};

const LEGACY_RELOAD_NAVIGATION_TYPE = 1;

export function isBrowserReloadNavigation(
  performanceLike: PerformanceNavigationLike | undefined =
    typeof performance === "undefined"
      ? undefined
      : (performance as unknown as PerformanceNavigationLike),
): boolean {
  const navigationEntries = performanceLike?.getEntriesByType?.("navigation") ?? [];
  const navigationEntry = navigationEntries.find((entry) => typeof entry.type === "string");

  if (navigationEntry) {
    return navigationEntry.type === "reload";
  }

  return performanceLike?.navigation?.type === LEGACY_RELOAD_NAVIGATION_TYPE;
}
