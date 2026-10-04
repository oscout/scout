import type { WorkDetail } from "../../lib/types.ts";

type TimelineItem = WorkDetail["timeline"][number];

export type TimelineRow = {
  item: TimelineItem;
  /** The summary without its leading `[ask:…]` handle. */
  body: string | null;
  /** The handle moved out of the body, e.g. `f-muryklpu-pwem`. */
  ref: string | null;
  /** Same-moment echoes folded into this row. */
  folded: Array<{ item: TimelineItem; sameText: boolean }>;
};

const ECHO_WINDOW_MS = 1000;
const ASK_REF = /^\s*\[ask:([^\]\s]+)\]\s*/;

function rank(item: TimelineItem): number {
  if (item.kind === "collaboration_event") return 0;
  if (item.kind === "message") return 1;
  return 2;
}

export function splitAskRef(summary: string | null): { body: string | null; ref: string | null } {
  if (!summary) return { body: null, ref: null };
  const m = summary.match(ASK_REF);
  return m ? { body: summary.slice(m[0].length), ref: m[1]! } : { body: summary, ref: null };
}

function norm(summary: string | null): string {
  return (splitAskRef(summary).body ?? "").replace(/\s+/g, " ").trim().replace(/(\.\.\.|…)$/, "");
}

/** Equal, or one is the other cut short (events store a clipped copy). */
function sameText(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  return short.length >= 40 && long.startsWith(short);
}

/**
 * Newest-first rows with same-moment echoes folded in: an event and the
 * thread message carrying the same text and compatible source identity.
 * Distinct flight summaries stay visible. Nothing is dropped; folded items
 * stay listed on the row that absorbed them.
 */
export function workTimelineRows(timeline: TimelineItem[]): TimelineRow[] {
  // Hosts first: events, then messages, then flight markers, so an echo
  // always folds into the most meaningful row of its moment.
  const byRank = [...timeline].sort((a, b) => rank(a) - rank(b) || b.at - a.at);
  const rows: TimelineRow[] = [];
  for (const item of byRank) {
    const text = norm(item.summary);
    const host = rows.find((row) =>
      Math.abs(row.item.at - item.at) < ECHO_WINDOW_MS
      && sameText(norm(row.item.summary), text)
      && (!row.item.flightId || !item.flightId || row.item.flightId === item.flightId)
      && (!row.item.actorId || !item.actorId || row.item.actorId === item.actorId)
      && (!row.ref || !splitAskRef(item.summary).ref || row.ref === splitAskRef(item.summary).ref)
    );
    if (host) {
      const same = sameText(norm(host.item.summary), text);
      host.folded.push({ item, sameText: same });
      const split = splitAskRef(item.summary);
      host.ref ??= split.ref;
      // Keep the full copy when the event only stored a clipped one.
      if (same && (split.body?.length ?? 0) > (host.body?.length ?? 0)) host.body = split.body;
      continue;
    }
    rows.push({ item, ...splitAskRef(item.summary), folded: [] });
  }
  for (const row of rows) row.folded.sort((a, b) => b.item.at - a.item.at || rank(a.item) - rank(b.item));
  return rows.sort((a, b) => b.item.at - a.item.at || rank(a.item) - rank(b.item));
}
