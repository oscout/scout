import type { ControlEvent } from "@openscout/protocol";
import { isEphemeralControlEvent } from "@openscout/protocol";

type Subscriber = (event: ControlEvent) => void;

const subscribers = new Set<Subscriber>();
let recentEvents: ControlEvent[] = [];
let maxBacklog = 500;
let presenceSnapshotSource: (() => ControlEvent[]) | null = null;

export function replaceControlEventBacklog(events: ControlEvent[], limit = maxBacklog): void {
  maxBacklog = limit;
  recentEvents = events.filter((event) => !isEphemeralControlEvent(event)).slice(-maxBacklog);
}

export function snapshotRecentControlEvents(limit = maxBacklog): ControlEvent[] {
  return recentEvents.slice(-limit);
}

export function publishControlEvent(event: ControlEvent): void {
  if (isEphemeralControlEvent(event)) {
    // Ephemeral events never enter the shared backlog: presence churn would
    // evict real control events from a fixed-size window, and a latest-per-key
    // map is the right backlog for presence anyway. Fan out and forget.
    publishEphemeralControlEvent(event);
    return;
  }

  recentEvents.push(event);
  if (recentEvents.length > maxBacklog) {
    recentEvents = recentEvents.slice(-maxBacklog);
  }
  fanOut(event);
}

/**
 * Publish an event to live subscribers only — no backlog entry, no durable
 * record, nothing to replay. Dropping one is free; the next observation
 * corrects it.
 */
export function publishEphemeralControlEvent(event: ControlEvent): void {
  fanOut(event);
}

/**
 * Snapshot the broker's presence map as control events, for a subscriber that
 * just connected.
 *
 * Registered by the daemon so the subscription path can reach the presence map
 * without importing the daemon. Absent (tests, embedded runtimes) it simply
 * yields nothing — presence is lossy by design, and the next sample repopulates.
 */
export function setPresenceSnapshotSource(source: (() => ControlEvent[]) | null): void {
  presenceSnapshotSource = source;
}

export function snapshotPresenceControlEvents(): ControlEvent[] {
  return presenceSnapshotSource?.() ?? [];
}

export function subscribeControlEvents(handler: Subscriber): () => void {
  subscribers.add(handler);
  return () => {
    subscribers.delete(handler);
  };
}

function fanOut(event: ControlEvent): void {
  for (const subscriber of [...subscribers]) {
    try {
      subscriber(event);
    } catch {
      /* isolate subscriber failures */
    }
  }
}
