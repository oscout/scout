import { useEffect, useRef } from "react";
import { createTRPCClient, createWSClient, wsLink } from "@trpc/client";
import type { ControlEvent } from "@openscout/protocol";
import type { BrokerRouter } from "@openscout/runtime/broker-trpc-router";
import { resolveScoutEventsStreamUrl } from "./runtime-config.ts";

export type BrokerEvent = ControlEvent | {
  kind: "unknown";
  payload?: unknown;
  [key: string]: unknown;
};

type BrokerEventSubscription = (event: BrokerEvent) => void;

const subscribers = new Set<BrokerEventSubscription>();

let wsClient: ReturnType<typeof createWSClient> | null = null;
let trpc: ReturnType<typeof createTRPCClient<BrokerRouter>> | null = null;
let activeSub: { unsubscribe: () => void } | null = null;
let retryTimeout: ReturnType<typeof setTimeout> | null = null;

function dispatchBrokerEvent(event: BrokerEvent): void {
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
    wsClient = createWSClient({ url: resolveScoutEventsStreamUrl() });
    trpc = createTRPCClient<BrokerRouter>({ links: [wsLink({ client: wsClient })] });
  }

  activeSub = trpc!.control.events.subscribe(undefined, {
    onData: (data) => {
      const event = (data as { data: BrokerEvent }).data;
      if (event) dispatchBrokerEvent(event);
    },
    onError: () => {
      activeSub = null;
      scheduleReconnect();
    },
  });

  // The control stream is an invalidation hint, not a source of truth. A
  // subscription can be recreated after a broker/web restart with a gap that
  // is no longer present in the in-memory backlog, so consumers must reconcile
  // their canonical snapshots whenever a subscription starts.
  dispatchBrokerEvent({
    kind: "unknown",
    payload: { reason: "control_subscription_started" },
  });
}

function teardown(): void {
  if (retryTimeout) {
    clearTimeout(retryTimeout);
    retryTimeout = null;
  }
  activeSub?.unsubscribe();
  activeSub = null;
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
