import type { BrokerEvent } from "./sse.ts";

// Kept free of React and the socket client so it can be tested directly.

export const BROKER_RECONCILE_REASON = "control_subscription_started";

/**
 * The synthetic event sent whenever the subscription (re)starts. Events in the
 * gap before it are gone, so consumers re-read their canonical snapshots.
 */
export function isBrokerReconcileEvent(event: BrokerEvent): boolean {
  return event.kind === "unknown"
    && (event.payload as { reason?: unknown } | undefined)?.reason === BROKER_RECONCILE_REASON;
}

/**
 * How a screen keeps broker-backed data fresh.
 *
 * Broker events are the primary signal: a matching event schedules one
 * debounced refresh. The timer is only a net under them — it runs at
 * `fallbackPollMs` while the event stream is down, and relaxes to
 * `livePollMs` while it is up, for the parts of a payload no event describes
 * (local process discovery, heartrate) and for drift.
 */
export type BrokerRefreshPolicy = {
  matches: (event: BrokerEvent) => boolean;
  fallbackPollMs: number;
  livePollMs: number;
  debounceMs?: number;
  /**
   * When the surface counts as active. Defaults to "focused" (visible and
   * focused). Watch surfaces use "visible" so they keep refreshing while on
   * screen but unfocused.
   */
  activeWhen?: "focused" | "visible";
};

export type BrokerRefreshScheduler = {
  now: () => number;
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

type ControllerInput = {
  refresh: () => void;
  policy: () => BrokerRefreshPolicy;
  isActive: () => boolean;
  isLive: () => boolean;
  scheduler: BrokerRefreshScheduler;
};

export const DEFAULT_BROKER_REFRESH_DEBOUNCE_MS = 250;
// Interval timers fire a little early or late; without slack a tick at 29.99s
// of a 30s schedule would push the refresh a whole tick later.
const TICK_SLACK_MS = 1_000;

export function createBrokerRefreshController(input: ControllerInput) {
  const { refresh, policy, isActive, isLive, scheduler } = input;
  let lastRefreshAt = scheduler.now();
  let pending: unknown = null;
  // An event that lands while the surface is inactive is remembered, not
  // dropped: the refresh runs when the surface comes back.
  let dirty = false;

  const run = () => {
    lastRefreshAt = scheduler.now();
    dirty = false;
    refresh();
  };

  const schedule = () => {
    if (pending !== null) return;
    pending = scheduler.setTimeout(() => {
      pending = null;
      if (!isActive()) {
        dirty = true;
        return;
      }
      run();
    }, policy().debounceMs ?? DEFAULT_BROKER_REFRESH_DEBOUNCE_MS);
  };

  const onTick = () => {
    if (!isActive()) return;
    const { fallbackPollMs, livePollMs } = policy();
    const dueMs = isLive() ? livePollMs : fallbackPollMs;
    if (scheduler.now() - lastRefreshAt >= dueMs - TICK_SLACK_MS) run();
  };

  return {
    onEvent(event: BrokerEvent) {
      // A (re)started subscription may have missed events in the gap, so it
      // always reconciles, whatever the screen's matcher says.
      if (isBrokerReconcileEvent(event) || policy().matches(event)) schedule();
    },
    onTick,
    onActivated() {
      if (pending !== null) return;
      if (dirty || !isLive()) {
        run();
        return;
      }
      // Live and nothing missed: the timer's normal schedule is enough.
      onTick();
    },
    dispose() {
      if (pending !== null) scheduler.clearTimeout(pending);
      pending = null;
    },
  };
}
