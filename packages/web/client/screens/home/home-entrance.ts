/**
 * Entrance-animation bookkeeping for the home "What's moving" section.
 *
 * The home screen re-renders constantly (15s poll, SSE refresh, 10s observe
 * polls, a 1s clock tick, plus layout-mode switches as counts change). We only
 * want a card to animate the FIRST time its unit id shows up. Everything else —
 * later refreshes of an already-seen unit, or a layout mode change — must render
 * statically.
 *
 * The mechanism is a persistent `Map<string, number>` (id → stagger index) kept
 * in a `useRef` across renders. Assignments are STICKY: once a card gets its
 * entrance class it keeps it, because keyed elements retain their DOM node
 * across re-renders and a retained class never replays a CSS animation — while
 * removing the class on the next render (the 1s clock tick) would cut the
 * entrance mid-flight. Only ids not yet in the map get a new assignment.
 */

/** Cap the effective stagger index so a large fleet doesn't take forever. */
export const HOME_ENTRANCE_STAGGER_CAP = 10;

/**
 * Given the ids already assigned an entrance and the ids visible this render,
 * return which visible ids are newly seen (in visible order). Pure.
 */
export function newlySeenIds(
  seen: { has(id: string): boolean },
  visibleIds: readonly string[],
): string[] {
  const fresh: string[] = [];
  for (const id of visibleIds) {
    if (!seen.has(id)) fresh.push(id);
  }
  return fresh;
}

/**
 * Fold this render's newly-visible ids into the sticky assignment map
 * (mutates in place). Already-assigned ids keep their original index; fresh
 * ids cascade from 0 in visible order, clamped to the stagger cap.
 */
export function assignEntranceIndices(
  assigned: Map<string, number>,
  visibleIds: readonly string[],
  cap: number = HOME_ENTRANCE_STAGGER_CAP,
): void {
  const fresh = newlySeenIds(assigned, visibleIds);
  fresh.forEach((id, position) => {
    assigned.set(id, entranceStaggerIndex(position, cap));
  });
}

/**
 * Clamp a card's position to the stagger cap so entrance delays plateau for
 * large fleets. Position beyond the cap all share the cap's delay.
 */
export function entranceStaggerIndex(
  position: number,
  cap: number = HOME_ENTRANCE_STAGGER_CAP,
): number {
  if (position <= 0) return 0;
  return Math.min(position, cap);
}
