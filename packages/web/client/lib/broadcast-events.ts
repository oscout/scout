import { useEffect, useRef } from "react";
import type { Broadcast } from "./types.ts";

type BroadcastSubscription = (broadcast: Broadcast) => void;

const subscribers = new Set<BroadcastSubscription>();
let eventSource: EventSource | null = null;
let retryTimeout: ReturnType<typeof setTimeout> | null = null;
let failures = 0;

function parseBroadcast(data: string): Broadcast | null {
  try {
    return JSON.parse(data) as Broadcast;
  } catch {
    return null;
  }
}

function dispatch(broadcast: Broadcast): void {
  for (const subscriber of [...subscribers]) {
    subscriber(broadcast);
  }
}

function closeEventSource(): void {
  eventSource?.close();
  eventSource = null;
}

function scheduleReconnect(): void {
  if (retryTimeout || subscribers.size === 0) return;
  failures++;
  const delay = Math.min(2_000 * 2 ** (failures - 1), 30_000);
  retryTimeout = setTimeout(() => {
    retryTimeout = null;
    if (subscribers.size > 0) connect();
  }, delay);
}

function connect(): void {
  if (eventSource || subscribers.size === 0) return;
  const es = new EventSource("/api/broadcast/stream");
  eventSource = es;

  const forward = (msg: MessageEvent<string>) => {
    const parsed = parseBroadcast(msg.data);
    if (parsed) dispatch(parsed);
  };

  es.onopen = () => {
    failures = 0;
  };
  es.onmessage = forward;
  es.addEventListener("ready", () => {
    failures = 0;
  });

  es.onerror = () => {
    if (eventSource === es) {
      closeEventSource();
    } else {
      es.close();
    }
    scheduleReconnect();
  };
}

export function useBroadcastEvents(onBroadcast: (broadcast: Broadcast) => void): void {
  const cbRef = useRef(onBroadcast);
  cbRef.current = onBroadcast;

  useEffect(() => {
    const subscriber: BroadcastSubscription = (broadcast) => cbRef.current(broadcast);
    subscribers.add(subscriber);
    if (retryTimeout) {
      clearTimeout(retryTimeout);
      retryTimeout = null;
    }
    connect();
    return () => {
      subscribers.delete(subscriber);
      if (subscribers.size === 0) {
        if (retryTimeout) {
          clearTimeout(retryTimeout);
          retryTimeout = null;
        }
        failures = 0;
        closeEventSource();
      }
    };
  }, []);
}
