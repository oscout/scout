import type { HarnessEventNormalizerContext } from "./normalizer.js";

/** Live adapter shell context: wall clock and random ids stay outside pure replay. */
export function createLiveNormalizerContext(sessionId: string): HarnessEventNormalizerContext {
  return {
    sessionId,
    now: () => new Date().toISOString(),
    nextId: () => crypto.randomUUID(),
  };
}
