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
