/**
 * Scout Chat — live invalidation for the selected channel.
 *
 * The server streams *that* a channel changed, never the change itself. This
 * module turns those notifications into one thing: a call to refetch the
 * canonical feed through `chat-api.ts`. Nothing here parses a payload into
 * state, so a stream that drifts from the REST reading cannot put a message on
 * screen that `/feed` would not also return.
 *
 * Three properties this module is responsible for:
 *
 *  - **Polling still owns correctness.** This is a latency improvement on top
 *    of the existing poll, not a replacement for it. Every failure path here
 *    ends in "stop quietly and let the poll read" — never in a broken surface.
 *  - **No storms.** A burst of notifications collapses into one refetch plus at
 *    most one trailing refetch. A stream that will not connect is attempted a
 *    bounded number of times and then abandoned for this mount.
 *  - **Nothing lands late.** After dispose — unmount, or a channel change — no
 *    callback fires, so a notification for the channel you just left can never
 *    trigger a read the surface would apply to the channel you are in.
 */

/**
 * Guards a read against the selection it was started for.
 *
 * Comparing channel ids is not enough. Leaving channel A for B and coming back
 * makes a first-visit read look current again, so a slow response from the
 * first visit can repaint the second with an older reading — or with a feed
 * the surface has already cleared. A generation that advances on every
 * selection change abandons every read in flight, including A→B→A.
 */
export interface SelectionGuard {
  /** Call as a read starts. The result reports whether it may still apply. */
  begin(): () => boolean;
  /** Call when the selection changes. Reads already in flight are abandoned. */
  reset(): void;
}

export function createSelectionGuard(): SelectionGuard {
  let generation = 0;
  return {
    begin() {
      const startedAt = generation;
      return () => startedAt === generation;
    },
    reset() {
      generation += 1;
    },
  };
}

/** The named events the channel stream emits. Both mean "re-read the feed". */
export const CHANNEL_EVENT_NAMES = ["ready", "channel.changed"] as const;

/** Floor between two refetches. A burst inside this window becomes one read. */
export const LIVE_MIN_REFRESH_MS = 350;

export const LIVE_RECONNECT_BASE_MS = 2_000;
export const LIVE_RECONNECT_CAP_MS = 30_000;

/**
 * How many times a stream that has never opened is retried before it is
 * treated as "this deployment does not serve it". Keeps a disabled backend
 * from being dialled forever.
 */
export const LIVE_COLD_FAILURE_LIMIT = 3;

/**
 * Where the subscription got to. Reported for tests and diagnostics only — the
 * surface deliberately renders none of these, because the honest signal a
 * reader needs ("this reading is stale") comes from the feed read failing, not
 * from an optional accelerator being down.
 */
export type ChannelLiveStatus =
  | "unsupported"
  | "connecting"
  | "live"
  | "retrying"
  | "unavailable";

/** The slice of `EventSource` this module uses. Tests supply their own. */
export interface LiveEventSourceLike {
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
  close(): void;
}

export interface LiveClock {
  now(): number;
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface ChannelLiveOptions {
  channelId: string;
  space?: string;
  /** Refetch the canonical feed. Rejections are the surface's to render. */
  onInvalidate: () => void | Promise<void>;
  /** Injection point for tests; defaults to the runtime's `EventSource`. */
  createEventSource?: (url: string) => LiveEventSourceLike | null;
  onStatus?: (status: ChannelLiveStatus) => void;
  minRefreshMs?: number;
  clock?: LiveClock;
}

export function channelEventsPath(channelId: string, space?: string): string {
  const path = `/api/channels/${encodeURIComponent(channelId)}/events`;
  return space && space !== "home" ? `${path}?space=${encodeURIComponent(space)}` : path;
}

const systemClock: LiveClock = {
  now: () => Date.now(),
  setTimer: (run, ms) => setTimeout(run, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

type EventSourceCtor = new (
  url: string,
  init?: { withCredentials?: boolean },
) => LiveEventSourceLike;

function defaultCreateEventSource(url: string): LiveEventSourceLike | null {
  const ctor = (globalThis as { EventSource?: EventSourceCtor }).EventSource;
  if (typeof ctor !== "function") return null;
  // Same-origin and credentialed, exactly as `chat-api.ts` sends its reads:
  // the member cookie is the whole identity on this stream too.
  return new ctor(url, { withCredentials: true });
}

/**
 * Subscribe to one channel's change notifications.
 *
 * Returns the dispose function. Calling it is the only way the subscription
 * ends, and after it returns nothing this subscription owns can fire again.
 */
export function subscribeChannelChanges(options: ChannelLiveOptions): () => void {
  const {
    channelId,
    space,
    onInvalidate,
    createEventSource = defaultCreateEventSource,
    onStatus,
    minRefreshMs = LIVE_MIN_REFRESH_MS,
    clock = systemClock,
  } = options;

  let disposed = false;
  let source: LiveEventSourceLike | null = null;
  let refreshTimer: unknown = null;
  let reconnectTimer: unknown = null;
  let refreshing = false;
  let trailing = false;
  let lastRefreshAt = Number.NEGATIVE_INFINITY;
  let everOpened = false;
  let coldFailures = 0;
  let warmFailures = 0;

  const report = (status: ChannelLiveStatus) => {
    if (!disposed) onStatus?.(status);
  };

  const clearRefreshTimer = () => {
    if (refreshTimer === null) return;
    clock.clearTimer(refreshTimer);
    refreshTimer = null;
  };

  const clearReconnectTimer = () => {
    if (reconnectTimer === null) return;
    clock.clearTimer(reconnectTimer);
    reconnectTimer = null;
  };

  const runRefresh = () => {
    refreshTimer = null;
    if (disposed) return;
    refreshing = true;
    trailing = false;
    lastRefreshAt = clock.now();
    void Promise.resolve()
      // Dispose can land between scheduling this microtask and running it.
      // The invariant is "no callback after dispose", so re-check here rather
      // than only at the points that schedule.
      .then(() => (disposed ? undefined : onInvalidate()))
      // A failed read is already the surface's stale-reading path. Swallowing
      // it here keeps one bad refetch from wedging every later notification.
      .catch(() => {})
      .then(() => {
        refreshing = false;
        if (trailing && !disposed) scheduleRefresh();
      });
  };

  /**
   * Coalescing: while a refetch is in flight, further notifications collect
   * into a single trailing read rather than stacking requests.
   */
  const scheduleRefresh = () => {
    if (disposed) return;
    if (refreshing) {
      trailing = true;
      return;
    }
    if (refreshTimer !== null) return;
    const wait = Math.max(0, minRefreshMs - (clock.now() - lastRefreshAt));
    if (wait === 0) {
      runRefresh();
      return;
    }
    refreshTimer = clock.setTimer(runRefresh, wait);
  };

  const scheduleReconnect = () => {
    const attempt = everOpened ? warmFailures : coldFailures;
    const delay = Math.min(
      LIVE_RECONNECT_BASE_MS * 2 ** Math.max(0, attempt - 1),
      LIVE_RECONNECT_CAP_MS,
    );
    report("retrying");
    clearReconnectTimer();
    reconnectTimer = clock.setTimer(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  function connect(): void {
    if (disposed || source !== null) return;
    report("connecting");

    let created: LiveEventSourceLike | null = null;
    try {
      created = createEventSource(channelEventsPath(channelId, space));
    } catch {
      created = null;
    }
    if (!created) {
      // No EventSource in this runtime. Not a failure to retry, and not
      // something to tell the reader about: the poll covers the channel.
      report("unsupported");
      return;
    }
    source = created;
    const active = created;
    const isCurrent = () => !disposed && source === active;

    active.addEventListener("open", () => {
      if (!isCurrent()) return;
      everOpened = true;
      coldFailures = 0;
      warmFailures = 0;
      report("live");
    });

    for (const name of CHANNEL_EVENT_NAMES) {
      active.addEventListener(name, () => {
        if (!isCurrent()) return;
        scheduleRefresh();
      });
    }

    active.addEventListener("error", () => {
      if (!isCurrent()) return;
      source = null;
      active.close();
      if (everOpened) {
        warmFailures += 1;
        scheduleReconnect();
        return;
      }
      coldFailures += 1;
      if (coldFailures >= LIVE_COLD_FAILURE_LIMIT) {
        // It never opened. Treat the stream as not served here, say so once,
        // and stop dialling. The feed poll is still reading the channel.
        report("unavailable");
        return;
      }
      scheduleReconnect();
    });
  }

  connect();

  return () => {
    if (disposed) return;
    disposed = true;
    clearRefreshTimer();
    clearReconnectTimer();
    trailing = false;
    const active = source;
    source = null;
    active?.close();
  };
}
