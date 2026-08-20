import type { ControlEvent } from "@openscout/protocol";

type Subscriber = (event: ControlEvent) => void;

const subscribers = new Set<Subscriber>();
let recentEvents: ControlEvent[] = [];
let maxBacklog = 500;

export function replaceControlEventBacklog(events: ControlEvent[], limit = maxBacklog): void {
  maxBacklog = limit;
  recentEvents = events.slice(-maxBacklog);
}

export function snapshotRecentControlEvents(limit = maxBacklog): ControlEvent[] {
  return recentEvents.slice(-limit);
}

export function publishControlEvent(event: ControlEvent): void {
  recentEvents.push(event);
  if (recentEvents.length > maxBacklog) {
    recentEvents = recentEvents.slice(-maxBacklog);
  }
  for (const subscriber of [...subscribers]) {
    try {
      subscriber(event);
    } catch {
      /* isolate subscriber failures */
    }
  }
}

export function subscribeControlEvents(handler: Subscriber): () => void {
  subscribers.add(handler);
  return () => {
    subscribers.delete(handler);
  };
}
