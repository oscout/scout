import { useEffect, useRef } from "react";
import { createTRPCClient, createWSClient, wsLink } from "@trpc/client";
import type { ControlEvent } from "@openscout/protocol";
import type { BrokerRouter } from "@openscout/runtime/broker-trpc-router";
import { resolveScoutEventsStreamUrl } from "./runtime-config.ts";
import { BROKER_RECONCILE_REASON } from "./broker-refresh-controller.ts";

export { isBrokerReconcileEvent } from "./broker-refresh-controller.ts";

export type BrokerEvent = ControlEvent | {
  kind: "unknown";
  payload?: unknown;
  [key: string]: unknown;
};

type BrokerEventSubscription = (event: BrokerEvent) => void;

const subscribers = new Set<BrokerEventSubscription>();
const observers = new Set<BrokerEventSubscription>();
const liveListeners = new Set<(live: boolean) => void>();
let streamLive = false;

function setStreamLive(live: boolean): void {
  if (streamLive === live) return;
  streamLive = live;
  for (const listener of [...liveListeners]) listener(live);
}

/** True while the broker control subscription is connected and started. */
export function isBrokerEventStreamLive(): boolean {
  return streamLive;
}

export function onBrokerEventStreamLiveChange(listener: (live: boolean) => void): () => void {
  liveListeners.add(listener);
  return () => {
    liveListeners.delete(listener);
  };
}

/**
 * Every kind except presence heartbeats. A (re)connect delivers the whole
 * presence snapshot at once — thousands of events — so a consumer that
 * refetches on "anything" should match this instead of `() => true`.
 */
export function isBrokerDataEvent(event: BrokerEvent): boolean {
  return event.kind !== "presence.updated";
}

let wsClient: ReturnType<typeof createWSClient> | null = null;
let trpc: ReturnType<typeof createTRPCClient<BrokerRouter>> | null = null;
let activeSub: { unsubscribe: () => void } | null = null;
let retryTimeout: ReturnType<typeof setTimeout> | null = null;

/**
 * See every event without holding the socket open — for caches that only
 * matter while some screen subscribes. Observers run before subscribers, so a
 * subscriber that refetches at once already sees the cache invalidated.
 */
export function observeBrokerEvents(observer: BrokerEventSubscription): () => void {
  observers.add(observer);
  return () => {
    observers.delete(observer);
  };
}

function dispatchBrokerEvent(event: BrokerEvent): void {
  for (const observer of [...observers]) {
    observer(event);
  }
  for (const subscriber of [...subscribers]) {
    subscriber(event);
  }
}

function scheduleReconnect(): void {
  if (retryTimeout || subscribers.size === 0) {
    return;
  }
  retryTimeout = setTimeout(() => {
    retryTimeout = null;
    ensureSubscribed();
  }, 2000);
}

function ensureSubscribed(): void {
  if (activeSub || subscribers.size === 0) {
    return;
  }

  if (!wsClient) {
    wsClient = createWSClient({
      url: resolveScoutEventsStreamUrl(),
      // The socket reconnects on its own and re-sends the subscription; only
      // `onStarted` below marks the stream live again.
      onClose: () => setStreamLive(false),
    });
    trpc = createTRPCClient<BrokerRouter>({ links: [wsLink({ client: wsClient })] });
  }

  activeSub = trpc!.control.events.subscribe(undefined, {
    // The control stream is an invalidation hint, not a source of truth. A
    // subscription can be restarted after a broker/web restart with a gap that
    // is no longer present in the in-memory backlog, so consumers reconcile
    // their canonical snapshots every time it starts — including the restarts
    // the socket performs on its own, which never pass through here again.
    onStarted: () => {
      setStreamLive(true);
      dispatchBrokerEvent({ kind: "unknown", payload: { reason: BROKER_RECONCILE_REASON } });
    },
    onData: (data) => {
      const event = (data as { data: BrokerEvent }).data;
      if (event) dispatchBrokerEvent(event);
    },
    onError: () => {
      activeSub = null;
      setStreamLive(false);
      scheduleReconnect();
    },
  });
}

function teardown(): void {
  if (retryTimeout) {
    clearTimeout(retryTimeout);
    retryTimeout = null;
  }
  activeSub?.unsubscribe();
  activeSub = null;
  setStreamLive(false);
}

function subscribeBrokerEvents(handler: BrokerEventSubscription): () => void {
  subscribers.add(handler);
  ensureSubscribed();

  return () => {
    subscribers.delete(handler);
    if (subscribers.size > 0) {
      return;
    }
    teardown();
  };
}

/**
 * Subscribe to broker control events over the broker tRPC WebSocket.
 * Calls `onEvent` with the parsed event whenever the broker emits one.
 */
export function useBrokerEvents(onEvent: (event: BrokerEvent) => void) {
  const cbRef = useRef(onEvent);
  cbRef.current = onEvent;

  useEffect(() => {
    return subscribeBrokerEvents((event) => {
      cbRef.current(event);
    });
  }, []);
}

/**
 * Debounced refetch-on-broker-event: a burst of matching events collapses
 * into one `refresh()` per debounce window. Use this instead of calling a
 * fetch directly from `useBrokerEvents` — event storms otherwise fan out
 * into back-to-back full refetches.
 */
export function useBrokerEventsRefresh(
  matches: (event: BrokerEvent) => boolean,
  refresh: () => void,
  debounceMs = 250,
) {
  const matchesRef = useRef(matches);
  matchesRef.current = matches;
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useBrokerEvents((event) => {
    if (!matchesRef.current(event)) return;
    if (timerRef.current) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      refreshRef.current();
    }, debounceMs);
  });

  useEffect(() => () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);
}
