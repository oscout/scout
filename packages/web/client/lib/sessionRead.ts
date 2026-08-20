const STORAGE_KEY = "scout:sessions:lastViewed";

export type LastViewedMap = Record<string, number>;

export function loadLastViewedMap(): LastViewedMap {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as LastViewedMap) : {};
  } catch {
    return {};
  }
}

export function saveLastViewed(sessionId: string, ts = Date.now()): LastViewedMap {
  const map = loadLastViewedMap();
  map[sessionId] = ts;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Ignore quota/disabled localStorage
  }
  return map;
}

export function isUnread(
  lastMessageAt: number | null | undefined,
  sessionId: string,
  map: LastViewedMap,
): boolean {
  if (!lastMessageAt) return false;
  return lastMessageAt > (map[sessionId] ?? 0);
}
