// Pure merge/dedupe logic for the tail feed, kept free of React/tRPC imports so
// it can be unit-tested in isolation.
//
// A TailEvent's `id` is derived from its line offset within the transcript, and
// the live firehose and the disk-replay endpoint compute that offset
// differently — so the *same* physical transcript line arrives with two
// different ids depending on which path read it. We therefore dedupe by content
// identity, not id, when stitching the one-shot disk hydration together with the
// live tail.

import type { TailEvent } from "./types.ts";

/**
 * Content-stable identity for a TailEvent. `ts` comes from the transcript record
 * itself (stable across re-reads), and the tuple mirrors the content key the
 * broker already uses for its own replay dedupe (see runtime tail service).
 */
export function tailEventKey(event: TailEvent): string {
  return [event.source, event.sessionId, event.ts, event.kind, event.summary].join("\u0000");
}

/** First-occurrence-wins dedupe by content key, preserving order. */
export function dedupeTailEvents(events: TailEvent[]): TailEvent[] {
  const seen = new Set<string>();
  const out: TailEvent[] = [];
  for (const event of events) {
    const key = tailEventKey(event);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(event);
  }
  return out;
}

/** Keep only the newest `limit` events by wall-clock ts (no-op when under cap). */
function capByRecency(events: TailEvent[], limit: number): TailEvent[] {
  if (events.length <= limit) return events;
  return [...events].sort((left, right) => left.ts - right.ts).slice(events.length - limit);
}

/**
 * Append a single live tail event. The broker re-delivers its in-memory replay
 * buffer on (re)connect, which overlaps the disk hydration snapshot — so drop
 * any event we already hold (matched by content, since ids differ across read
 * paths) instead of duplicating it. The live tail is authoritative for genuinely
 * new events.
 */
export function appendLiveTailEvent(
  previous: TailEvent[],
  event: TailEvent,
  limit: number,
): TailEvent[] {
  const key = tailEventKey(event);
  for (const existing of previous) {
    if (tailEventKey(existing) === key) return previous;
  }
  const appended = [...previous, event];
  return appended.length > limit
    ? appended.slice(appended.length - limit)
    : appended;
}

/**
 * Merge the disk hydration snapshot with whatever the live tail already
 * appended during the fetch, deduped by content so the overlap collapses and no
 * in-flight live event is clobbered.
 */
export function mergeHydratedTailEvents(
  previous: TailEvent[],
  hydrated: TailEvent[],
  limit: number,
): TailEvent[] {
  return capByRecency(dedupeTailEvents([...hydrated, ...previous]), limit);
}
