/**
 * Load-state vocabulary for the tail feed, kept free of React so pure tests can
 * import it (importing a hook module pulls in React and breaks `bun test`).
 */

export type TailFeedLoadPhase = "loading" | "ready" | "error";

export type TailFeedLoadState = {
  discovery: TailFeedLoadPhase;
  recent: TailFeedLoadPhase;
  /**
   * Set on the channel's first successful pass and never cleared. A refresh
   * that fails on top of good data is a blip; a channel that has never
   * answered is an outage. The phase alone cannot tell them apart, and they
   * read very differently on screen, so surfaces gate their failure states on
   * these rather than on `discovery !== null` — which lies, because a failed
   * first scan substitutes an empty snapshot.
   */
  discoveryLoaded: boolean;
  recentLoaded: boolean;
};

export const TAIL_READY_EVENT_LIMIT = 500;

export type TailHistoryHydrationResult = {
  replay: "not-requested" | "loaded" | "failed";
};

export type TailHistoryHydrationPhase = "idle" | TailFeedLoadPhase;

function normalizedPositiveInteger(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

/**
 * Identifies one archival view. Discovery polling must not change this key;
 * only a real history-depth or discovery-scope change should hydrate again.
 */
export function tailHistoryHydrationKey(options: {
  recentLimit: number;
  includeTranscriptReplay: boolean;
  recentWindowMs?: number;
  discoveryScope?: string;
  discoveryLimit?: number;
}): string {
  return JSON.stringify([
    normalizedPositiveInteger(options.recentLimit),
    options.includeTranscriptReplay,
    normalizedPositiveInteger(options.recentWindowMs),
    options.discoveryScope ?? null,
    normalizedPositiveInteger(options.discoveryLimit),
  ]);
}

/** Discovery refreshes retry history only after a failed live or replay pass. */
export function shouldRetryTailHistoryAfterDiscovery(
  recentPhase: TailFeedLoadPhase,
  historyPhase: TailHistoryHydrationPhase,
): boolean {
  return recentPhase === "error" || historyPhase === "error";
}

/** Keep the readiness payload compact; the full requested depth follows in replay. */
export function tailReadyEventLimit(
  recentLimit: number,
  includeTranscriptReplay: boolean,
): number {
  return includeTranscriptReplay
    ? Math.min(recentLimit, TAIL_READY_EVENT_LIMIT)
    : recentLimit;
}

/**
 * Paint the broker's inexpensive live tail before asking it to replay local
 * transcripts. Transcript replay can be several megabytes on an active
 * machine; making it the readiness gate leaves Lanes on its preflight deck
 * even when the broker already has useful live events in memory.
 *
 * Replay is enrichment. Once the live channel answers, a replay failure must
 * not turn a usable surface into an outage.
 */
export async function loadTailHistoryProgressively<T>(options: {
  includeTranscriptReplay: boolean;
  load: (includeTranscriptReplay: boolean) => Promise<T[]>;
  publish: (items: T[], phase: "live" | "replay") => void;
  markReady: () => void;
}): Promise<TailHistoryHydrationResult> {
  const live = await options.load(false);
  options.publish(live, "live");
  options.markReady();

  if (!options.includeTranscriptReplay) return { replay: "not-requested" };

  try {
    options.publish(await options.load(true), "replay");
    return { replay: "loaded" };
  } catch {
    // The live channel is already ready, so the surface stays usable. The hook
    // retains this outcome and retries archival enrichment on a later discovery
    // tick without returning to periodic successful replay.
    return { replay: "failed" };
  }
}

/**
 * How much of a failure a tail load state actually is.
 *
 * - `none` — nothing is in error.
 * - `blank` — a channel is in error and the surface has nothing to fall back
 *   on, because at least one channel has never answered.
 * - `degraded` — a channel is in error but both have answered before, so the
 *   last good reading still stands and is merely behind.
 *
 * Surfaces that collapse `degraded` into `blank` end up claiming an outage
 * over a single blipped poll, which is the wrong reading far more often than
 * it is the right one.
 */
export function tailFeedFailure(loadState: TailFeedLoadState): "none" | "degraded" | "blank" {
  const failing = loadState.discovery === "error" || loadState.recent === "error";
  if (!failing) return "none";
  return loadState.discoveryLoaded && loadState.recentLoaded ? "degraded" : "blank";
}
