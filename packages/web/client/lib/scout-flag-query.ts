export const SCOUT_FLAG_BUNDLE_QUERY_KEYS = [
  "ffBundle",
  "ffVariant",
  "scoutBundle",
  "scoutExperience",
  "ab",
] as const;

export const SCOUT_FLAG_GLOBAL_BUNDLE_QUERY_KEYS = [
  "ffGlobal",
  "scoutGlobalBundle",
] as const;

export const SCOUT_FLAG_PERSIST_QUERY_KEYS = [
  "ffPersist",
  "persistBundle",
] as const;

const SCOUT_FLAG_QUERY_KEYS = new Set<string>([
  "no-ops",
  "ffAudience",
  ...SCOUT_FLAG_BUNDLE_QUERY_KEYS,
  ...SCOUT_FLAG_GLOBAL_BUNDLE_QUERY_KEYS,
  ...SCOUT_FLAG_PERSIST_QUERY_KEYS,
]);

export function stripScoutFlagQueryParams(url: URL): URL {
  for (const key of [...url.searchParams.keys()]) {
    if (SCOUT_FLAG_QUERY_KEYS.has(key) || key.startsWith("ff.")) {
      url.searchParams.delete(key);
    }
  }
  return url;
}
