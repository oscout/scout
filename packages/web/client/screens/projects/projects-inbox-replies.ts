import type { TailEvent } from "../../lib/types.ts";
import { isObservedAssistantReply } from "./projects-inbox-model.ts";

const LIVE_REPLY_COALESCE_MS = 50;

function observedReplySessionKey(event: TailEvent): string {
  const source = event.source.trim().toLowerCase();
  const trimmedSessionId = event.sessionId.trim();
  const leaf = trimmedSessionId.split(/[\\/]/u).filter(Boolean).at(-1) ?? trimmedSessionId;
  const sessionId = leaf.endsWith(".jsonl") ? leaf.slice(0, -".jsonl".length) : leaf;
  return source && sessionId ? `${source}\u0000${sessionId}` : `event\u0000${event.id}`;
}

/** Latest user-facing reply per harness session, ordered newest first. */
export function latestObservedAssistantReplies(events: TailEvent[], limit: number): TailEvent[] {
  const latestBySession = new Map<string, TailEvent>();
  for (const event of events) {
    if (!isObservedAssistantReply(event)) continue;
    const key = observedReplySessionKey(event);
    const current = latestBySession.get(key);
    // Later input wins ties so a streamed update with the same id/timestamp can
    // replace its earlier partial summary.
    if (!current || event.ts >= current.ts) latestBySession.set(key, event);
  }
  return [...latestBySession.values()]
    .sort((left, right) => right.ts - left.ts || right.id.localeCompare(left.id))
    .slice(0, limit);
}

type ReplyBurstCoalescer = {
  push: (event: TailEvent) => void;
  cancel: () => void;
};

type BurstScheduler = (flush: () => void) => () => void;

export type HistoricalReplayHydrator = {
  /** True only for the first load or once a failed load's backoff expires. */
  shouldRun: () => boolean;
  /** Coalesces concurrent calls and becomes a no-op after the first success. */
  run: () => Promise<void>;
  /** Starts a new mounted epoch after live-event listeners were absent. */
  reset: () => void;
};

/**
 * Transcript history is cold-start enrichment. Once it has loaded, live tail
 * events keep the projection current, so polling it again only repeats disk
 * work. Failed hydration remains retryable after a small backoff.
 */
export function createHistoricalReplayHydrator(options: {
  load: () => Promise<void>;
  retryDelayMs: number;
  now?: () => number;
}): HistoricalReplayHydrator {
  const now = options.now ?? Date.now;
  let phase: "idle" | "loading" | "ready" | "error" = "idle";
  let retryAt = 0;
  let inFlight: Promise<void> | null = null;
  let generation = 0;

  const shouldRun = () =>
    phase === "idle" || (phase === "error" && now() >= retryAt);

  return {
    shouldRun,
    run() {
      if (inFlight) return inFlight;
      if (!shouldRun()) return Promise.resolve();

      phase = "loading";
      const requestGeneration = generation;
      let request: Promise<void>;
      request = Promise.resolve()
        .then(options.load)
        .then(() => {
          if (generation === requestGeneration) phase = "ready";
        })
        .catch(() => {
          if (generation !== requestGeneration) return;
          phase = "error";
          retryAt = now() + options.retryDelayMs;
        })
        .finally(() => {
          if (inFlight === request) inFlight = null;
        });
      inFlight = request;
      return request;
    },
    reset() {
      generation += 1;
      phase = "idle";
      retryAt = 0;
      inFlight = null;
    },
  };
}

/** Batch streamed reply fragments so one burst causes one model rebuild. */
export function createReplyBurstCoalescer(
  onFlush: (events: TailEvent[]) => void,
  schedule: BurstScheduler = (flush) => {
    const timer = setTimeout(flush, LIVE_REPLY_COALESCE_MS);
    return () => clearTimeout(timer);
  },
): ReplyBurstCoalescer {
  const pending = new Map<string, TailEvent>();
  let cancelScheduled: (() => void) | null = null;

  const flush = () => {
    cancelScheduled = null;
    if (pending.size === 0) return;
    const events = [...pending.values()];
    pending.clear();
    onFlush(events);
  };

  return {
    push(event) {
      pending.set(observedReplySessionKey(event), event);
      cancelScheduled ??= schedule(flush);
    },
    cancel() {
      cancelScheduled?.();
      cancelScheduled = null;
      pending.clear();
    },
  };
}

/** Yield transcript replay to paint; Safari falls back to the next task. */
export function deferProjectsInboxWork(work: () => void): () => void {
  if (typeof window !== "undefined") {
    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    if (idleWindow.requestIdleCallback) {
      const handle = idleWindow.requestIdleCallback(work, { timeout: 1_000 });
      return () => idleWindow.cancelIdleCallback?.(handle);
    }
  }
  const timer = setTimeout(work, 0);
  return () => clearTimeout(timer);
}
