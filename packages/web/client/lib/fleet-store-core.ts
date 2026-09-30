/**
 * One `/api/fleet` read per change, however many screens ask.
 *
 * Every mounted screen that shows fleet state refetches it on broker events,
 * each on its own debounce (250ms, 1s, 1.5s trailing). `api()` merges only
 * requests that overlap in flight, so one event still cost several full reads
 * of one of the heaviest endpoints. Here a read is reused until a fleet event
 * invalidates it, or until it is `maxAgeMs` old — the net for fields no event
 * describes (`generatedAt`, time-windowed activity).
 *
 * React-free so the policy is testable; `fleet-store.ts` wires it to the
 * broker stream.
 */

export type FleetStoreClock = { now: () => number };

type Entry<T> = {
  generation: number;
  requestedAt: number;
  result: Promise<T>;
};

export function createFleetStore<T>(options: {
  fetch: (path: string) => Promise<T>;
  maxAgeMs: number;
  clock?: FleetStoreClock;
}) {
  const clock = options.clock ?? { now: () => Date.now() };
  const entries = new Map<string, Entry<T>>();
  let generation = 0;

  return {
    /** A fleet event arrived: nothing read before it may be served again. */
    invalidate(): void {
      generation += 1;
    },

    load(path: string): Promise<T> {
      const now = clock.now();
      const existing = entries.get(path);
      if (
        existing
        && existing.generation === generation
        && now - existing.requestedAt < options.maxAgeMs
      ) {
        return existing.result;
      }
      const entry: Entry<T> = {
        generation,
        requestedAt: now,
        result: options.fetch(path),
      };
      entries.set(path, entry);
      // A failure is never reused; the next caller retries.
      entry.result.catch(() => {
        if (entries.get(path) === entry) entries.delete(path);
      });
      return entry.result;
    },
  };
}
