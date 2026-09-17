import { describe, expect, test } from "bun:test";

import {
  CHANNEL_EVENT_NAMES,
  LIVE_COLD_FAILURE_LIMIT,
  LIVE_MIN_REFRESH_MS,
  LIVE_RECONNECT_BASE_MS,
  LIVE_RECONNECT_CAP_MS,
  channelEventsPath,
  createSelectionGuard,
  subscribeChannelChanges,
  type ChannelLiveStatus,
  type LiveClock,
  type LiveEventSourceLike,
} from "./chat-live.ts";

/* ── a hand-cranked clock ─────────────────────────────────────────────────── */

interface ScheduledTimer {
  id: number;
  at: number;
  run: () => void;
}

class TestClock implements LiveClock {
  current = 0;
  private nextId = 1;
  private timers: ScheduledTimer[] = [];

  now(): number {
    return this.current;
  }

  setTimer(run: () => void, ms: number): unknown {
    const timer: ScheduledTimer = { id: this.nextId++, at: this.current + ms, run };
    this.timers.push(timer);
    return timer.id;
  }

  clearTimer(handle: unknown): void {
    this.timers = this.timers.filter((timer) => timer.id !== handle);
  }

  /** Advance time, firing every timer whose deadline passes. */
  advance(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      const due = this.timers
        .filter((timer) => timer.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((timer) => timer.id !== due.id);
      this.current = Math.max(this.current, due.at);
      due.run();
    }
    this.current = target;
  }

  get pending(): number {
    return this.timers.length;
  }
}

/* ── a hand-cranked EventSource ───────────────────────────────────────────── */

class FakeEventSource implements LiveEventSourceLike {
  readonly url: string;
  readonly withCredentials: boolean;
  closed = false;
  private listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();

  constructor(url: string, withCredentials: boolean) {
    this.url = url;
    this.withCredentials = withCredentials;
  }

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push(listener);
    this.listeners.set(type, bucket);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data?: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener({ data });
  }
}

interface Harness {
  sources: FakeEventSource[];
  statuses: ChannelLiveStatus[];
  refreshes: number;
  clock: TestClock;
  latest: () => FakeEventSource;
  dispose: () => void;
}

function harness(
  overrides: {
    channelId?: string;
    space?: string;
    createEventSource?: (url: string) => LiveEventSourceLike | null;
    onInvalidate?: () => void | Promise<void>;
  } = {},
): Harness {
  const clock = new TestClock();
  const sources: FakeEventSource[] = [];
  const statuses: ChannelLiveStatus[] = [];
  const state = { refreshes: 0 };

  const dispose = subscribeChannelChanges({
    channelId: overrides.channelId ?? "chan-1",
    space: overrides.space,
    onInvalidate: overrides.onInvalidate
      ?? (() => {
        state.refreshes += 1;
      }),
    createEventSource: overrides.createEventSource
      ?? ((url) => {
        const source = new FakeEventSource(url, true);
        sources.push(source);
        return source;
      }),
    onStatus: (status) => statuses.push(status),
    clock,
  });

  return {
    sources,
    statuses,
    get refreshes() {
      return state.refreshes;
    },
    clock,
    latest: () => {
      const source = sources[sources.length - 1];
      if (!source) throw new Error("no EventSource was opened");
      return source;
    },
    dispose,
  };
}

/** Let the invalidation promise chain settle. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A refetch the test holds open, so the in-flight window can be inspected. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settleIt) => {
    resolve = settleIt;
  });
  return { promise, resolve };
}

/* ── connection ───────────────────────────────────────────────────────────── */

describe("connection", () => {
  test("opens the selected channel's same-origin stream with credentials", () => {
    const live = harness({ channelId: "chan/one" });

    expect(live.sources).toHaveLength(1);
    expect(live.latest().url).toBe("/api/channels/chan%2Fone/events");
    expect(live.latest().withCredentials).toBe(true);
    live.dispose();
  });

  test("opens and reconnects in the selected space", () => {
    const live = harness({ channelId: "chan-1", space: "work" });
    expect(live.latest().url).toBe("/api/channels/chan-1/events?space=work");
    live.latest().emit("error");
    live.clock.advance(LIVE_RECONNECT_BASE_MS);
    expect(live.sources).toHaveLength(2);
    expect(live.latest().url).toBe("/api/channels/chan-1/events?space=work");
    live.dispose();
  });

  test("the path encodes the channel id exactly once", () => {
    expect(channelEventsPath("chan 1")).toBe("/api/channels/chan%201/events");
  });

  test("dispose closes the stream", () => {
    const live = harness();
    const source = live.latest();

    live.dispose();

    expect(source.closed).toBe(true);
  });
});

/* ── invalidation ─────────────────────────────────────────────────────────── */

describe("invalidation", () => {
  test.each([...CHANNEL_EVENT_NAMES])("refetches the feed on %s", async (name) => {
    const live = harness();
    live.latest().emit("open");

    live.latest().emit(name);
    await settle();

    expect(live.refreshes).toBe(1);
    live.dispose();
  });

  test("a burst of notifications collapses into one read plus one trailing read", async () => {
    const first = deferred();
    const live = harness({ onInvalidate: () => first.promise });
    live.latest().emit("open");

    // Ten notifications land while the first refetch is still in flight.
    for (let index = 0; index < 10; index += 1) live.latest().emit("channel.changed");
    await settle();
    expect(live.clock.pending).toBe(0);

    first.resolve();
    await settle();

    // One trailing read is scheduled, and it waits out the coalescing floor
    // rather than firing immediately.
    expect(live.clock.pending).toBe(1);
    live.clock.advance(LIVE_MIN_REFRESH_MS);
    await settle();
    expect(live.clock.pending).toBe(0);
    live.dispose();
  });

  test("two notifications inside the coalescing window produce one read", async () => {
    const live = harness();
    live.latest().emit("open");

    live.latest().emit("channel.changed");
    await settle();
    expect(live.refreshes).toBe(1);

    live.clock.advance(LIVE_MIN_REFRESH_MS / 2);
    live.latest().emit("channel.changed");
    live.latest().emit("channel.changed");
    await settle();
    expect(live.refreshes).toBe(1);

    live.clock.advance(LIVE_MIN_REFRESH_MS);
    await settle();
    expect(live.refreshes).toBe(2);
    live.dispose();
  });

  test("a failed refetch does not wedge later notifications", async () => {
    let attempts = 0;
    const live = harness({
      onInvalidate: () => {
        attempts += 1;
        return Promise.reject(new Error("offline"));
      },
    });
    live.latest().emit("open");

    live.latest().emit("channel.changed");
    await settle();
    expect(attempts).toBe(1);

    live.clock.advance(LIVE_MIN_REFRESH_MS);
    live.latest().emit("channel.changed");
    await settle();
    expect(attempts).toBe(2);
    live.dispose();
  });
});

/* ── nothing lands late ───────────────────────────────────────────────────── */

describe("stale channels", () => {
  test("a notification delivered after dispose never refetches", async () => {
    const live = harness();
    const source = live.latest();
    source.emit("open");

    live.dispose();
    source.emit("channel.changed");
    source.emit("ready");
    live.clock.advance(LIVE_MIN_REFRESH_MS * 4);
    await settle();

    expect(live.refreshes).toBe(0);
  });

  test("a read already scheduled when dispose runs is cancelled", async () => {
    const live = harness();
    live.latest().emit("open");

    live.latest().emit("channel.changed");
    await settle();
    expect(live.refreshes).toBe(1);

    live.latest().emit("channel.changed");
    expect(live.clock.pending).toBe(1);
    live.dispose();
    live.clock.advance(LIVE_MIN_REFRESH_MS * 4);
    await settle();

    expect(live.refreshes).toBe(1);
  });

  test("a trailing read queued behind an in-flight refetch is dropped on dispose", async () => {
    const first = deferred();
    let calls = 0;
    const live = harness({
      onInvalidate: () => {
        calls += 1;
        return first.promise;
      },
    });
    live.latest().emit("open");
    live.latest().emit("channel.changed");
    live.latest().emit("channel.changed");
    await settle();
    expect(calls).toBe(1);

    live.dispose();
    first.resolve();
    live.clock.advance(LIVE_MIN_REFRESH_MS * 4);
    await settle();

    expect(calls).toBe(1);
  });

  test("dispose before the refetch microtask runs cancels it", async () => {
    const live = harness();
    live.latest().emit("open");

    // The notification schedules the read; dispose lands in the same
    // synchronous block, before the microtask that would call onInvalidate.
    live.latest().emit("channel.changed");
    live.dispose();
    await settle();

    expect(live.refreshes).toBe(0);
  });

  test("dispose stops a pending reconnect", () => {
    const live = harness();
    live.latest().emit("open");
    live.latest().emit("error");
    expect(live.clock.pending).toBe(1);

    live.dispose();
    live.clock.advance(LIVE_RECONNECT_CAP_MS * 4);

    expect(live.sources).toHaveLength(1);
  });
});

/* ── degrading quietly ────────────────────────────────────────────────────── */

describe("unavailable transports", () => {
  test("a runtime without EventSource is reported once and never retried", () => {
    const live = harness({ createEventSource: () => null });

    live.clock.advance(LIVE_RECONNECT_CAP_MS * 4);

    expect(live.statuses).toEqual(["connecting", "unsupported"]);
    expect(live.clock.pending).toBe(0);
    live.dispose();
  });

  test("a constructor that throws degrades to unsupported rather than propagating", () => {
    expect(() =>
      harness({
        createEventSource: () => {
          throw new Error("blocked by policy");
        },
      }).dispose()).not.toThrow();
  });

  test("a stream that never opens is dialled a bounded number of times", () => {
    const live = harness();

    for (let attempt = 0; attempt < LIVE_COLD_FAILURE_LIMIT + 4; attempt += 1) {
      live.sources[live.sources.length - 1]?.emit("error");
      live.clock.advance(LIVE_RECONNECT_CAP_MS);
    }

    expect(live.sources).toHaveLength(LIVE_COLD_FAILURE_LIMIT);
    expect(live.statuses.filter((status) => status === "unavailable")).toHaveLength(1);
    expect(live.clock.pending).toBe(0);
    live.dispose();
  });

  test("an errored stream is closed before the next one opens", () => {
    const live = harness();
    const first = live.latest();

    first.emit("error");
    live.clock.advance(LIVE_RECONNECT_BASE_MS);

    expect(first.closed).toBe(true);
    expect(live.sources).toHaveLength(2);
    live.dispose();
  });

  test("a stream that opened once reconnects with capped backoff", () => {
    const live = harness();

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const source = live.latest();
      source.emit("open");
      source.emit("error");
      live.clock.advance(LIVE_RECONNECT_CAP_MS);
    }

    // Every failure is followed by another attempt: an endpoint that has
    // worked is never abandoned the way a never-opened one is.
    expect(live.sources).toHaveLength(9);
    expect(live.statuses).not.toContain("unavailable");
    live.dispose();
  });

  test("backoff after a reopened stream restarts from the base delay", () => {
    const live = harness();
    live.latest().emit("open");
    live.latest().emit("error");

    // Not yet due at one tick under the base delay.
    live.clock.advance(LIVE_RECONNECT_BASE_MS - 1);
    expect(live.sources).toHaveLength(1);

    live.clock.advance(1);
    expect(live.sources).toHaveLength(2);
    live.dispose();
  });

  test("reconnecting re-reads the feed through ready", async () => {
    const live = harness();
    live.latest().emit("open");
    live.latest().emit("error");
    live.clock.advance(LIVE_RECONNECT_BASE_MS);

    live.latest().emit("open");
    live.latest().emit("ready");
    await settle();

    expect(live.refreshes).toBe(1);
    live.dispose();
  });
});

/* ── selection guard ──────────────────────────────────────────────────────── */

describe("selection guard", () => {
  test("a read started and finished within one selection applies", () => {
    const guard = createSelectionGuard();
    const isCurrent = guard.begin();

    expect(isCurrent()).toBe(true);
  });

  test("a read that outlives its selection is abandoned", () => {
    const guard = createSelectionGuard();
    const isCurrent = guard.begin();

    guard.reset();

    expect(isCurrent()).toBe(false);
  });

  test("returning to the same selection does not revive an older read", () => {
    const guard = createSelectionGuard();
    // A read starts on channel A...
    const firstVisit = guard.begin();
    // ...the reader goes to B and comes straight back to A.
    guard.reset();
    guard.reset();
    const secondVisit = guard.begin();

    // Channel id equality would call the first read current again. It is not.
    expect(firstVisit()).toBe(false);
    expect(secondVisit()).toBe(true);
  });

  test("reads started in the same selection share its fate", () => {
    const guard = createSelectionGuard();
    const feedRead = guard.begin();
    const rosterRead = guard.begin();

    guard.reset();

    expect(feedRead()).toBe(false);
    expect(rosterRead()).toBe(false);
  });
});
