/**
 * The operator's name, remembered locally so it is there on the first frame.
 *
 * Who you are is the most stable fact in the app — it changes about once, when
 * you set it — and yet it was the slowest thing on screen: every surface that
 * shows you had to wait for /api/onboarding/state, which is queued alongside
 * the whole agent inventory. So the frame drew, the header settled, and then
 * you arrived a beat later at your own workspace. A face that pops in after
 * the room has finished loading reads as the app noticing you, late.
 *
 * The FACE never had this problem: `operatorCharacter` lives in the appearance
 * record in localStorage and paints immediately. Only the name was remote, and
 * the name is what every surface gates on. So this caches that one string.
 *
 * This is deliberately a cache, not a store. The server stays the source of
 * truth: the fetch still runs on every mount and overwrites this the moment it
 * answers. What's kept here is only the answer from last time, which for this
 * particular fact is almost always still right.
 */

const KEY = "openscout.operator.name";

/** A name we'd rather not paint: placeholders that would show as a real handle. */
const PLACEHOLDERS = new Set(["operator", "you", "user", "unknown", "null", "undefined"]);

function usable(name: string | null | undefined): string | null {
  const clean = name?.trim();
  if (!clean || clean.length > 64) return null;
  return PLACEHOLDERS.has(clean.toLowerCase()) ? null : clean;
}

/**
 * The name from last visit, or null on a genuinely first load.
 *
 * Null is not a failure state — it is the one case where there is nothing
 * honest to draw yet, and the surfaces that use this treat it as "arriving"
 * rather than "absent".
 */
export function readCachedOperatorName(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return usable(window.localStorage.getItem(KEY));
  } catch {
    // Private mode, disabled storage, quota. The app works without the cache;
    // it just goes back to arriving late.
    return null;
  }
}

/** Records the server's answer. Clears the cache when the name is gone, so a
 *  reset operator does not keep being greeted by a stale handle. */
export function writeCachedOperatorName(name: string | null | undefined): void {
  if (typeof window === "undefined") return;
  try {
    const clean = usable(name);
    if (clean) window.localStorage.setItem(KEY, clean);
    else window.localStorage.removeItem(KEY);
  } catch {
    /* see above */
  }
}
