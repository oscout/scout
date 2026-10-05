/**
 * The companion's edge mode: each pinned or surfaced work item is its agent's
 * crew character, 24px tall, standing on the bottom edge of the display.
 *
 * Pure functions only, so placement and readings are testable without a DOM.
 *
 * Five visible readings, carried by stance and a small plate, never by hue
 * alone. The exact card state stays in the detail popover:
 *   working       — stands; takes one step when Scout observes new activity
 *   resting       — quiet, waiting on someone else, session ended, cancelled,
 *                   not loaded: sinks until only the head peeks over the edge
 *   needs         — asks you, ready for your review, blocked: hops once
 *   done          — a reported completion
 *   disconnected  — the broker link is down: everyone freezes, greyed
 *
 * Placement is stable: a figure keeps its spot until it steps or something
 * that matters more needs the room. Spots avoid the obstacles the Mac app
 * reported (Scout's own windows on the edge) and every other figure. When the
 * edge is full, one reserved slot at the anchor end becomes "+N"; anything
 * that needs the operator and every fresh arrival keeps a spot of its own.
 */

import { groupLabel, type CompanionCardState } from "./companion-model.ts";

export type EdgeVisible = "working" | "resting" | "needs" | "done" | "disconnected";

export const EDGE_FIGURE = 24;
/** Figure plus breathing room; also the hit target width. */
export const EDGE_SLOT = 30;
/** Hit target height: the figure plus its plate. */
export const EDGE_SLOT_HEIGHT = 34;
export const EDGE_MARGIN = 14;
/** A figure never strays further than this from where it first landed. */
export const EDGE_REACH = 96;
/** The anchor-end control (Scout mark: settings, layout, hide). */
export const EDGE_HOME_SLOT = 30;
export const ARRIVAL_MS = { chute: 2600, visitor: 3400 } as const;
export const HOP_MS = 900;
export const STEP_MS = 1600;

export const EDGE_VISIBLE_LABEL: Record<EdgeVisible, string> = {
  working: "Working",
  resting: "Resting",
  needs: "Needs you",
  done: "Done",
  disconnected: "Disconnected",
};

/** The reading the figure shows; `offline` overrides everything. */
export function edgeVisible(state: CompanionCardState | undefined, offline: boolean): EdgeVisible {
  if (offline) return "disconnected";
  switch (state) {
    case "working":
      return "working";
    case "question":
    case "blocked":
      return "needs";
    case "done":
      return "done";
    default:
      // quiet, waiting (on someone else), ended, cancelled, not loaded:
      // nothing is moving and nothing is asked. Silence is not "paused".
      return "resting";
  }
}

/** The precise state, worded as the stack words it. */
export function exactLabel(state: CompanionCardState | undefined): string {
  return groupLabel(state ?? "unknown");
}

/** Exact detail is worth showing only when it says more than the reading. */
export function exactDiffers(state: CompanionCardState | undefined): boolean {
  return exactLabel(state) !== EDGE_VISIBLE_LABEL[edgeVisible(state, false)];
}

const PRIORITY: Record<EdgeVisible, number> = { needs: 0, working: 1, done: 2, resting: 3, disconnected: 3 };

export type Span = [number, number];

/** Width of the "+N" slot. */
export const EDGE_STACK = 44;

function cut(spans: readonly Span[], { start, end }: { start: number; end: number }): Span[] {
  return spans.flatMap(([s, e]) => (end <= s || start >= e
    ? [[s, e] as Span]
    : ([[s, start], [end, e]] as Span[]).filter(([a, b]) => b - a > 0)));
}

/** Spans of the edge a figure may stand in, after margins and obstacles. */
export function freeSpans(
  width: number,
  obstacles: readonly { start: number; end: number }[],
  reserve: { start: number; end: number } | null = null,
  margin = EDGE_MARGIN,
): Span[] {
  let spans: Span[] = width - margin * 2 > 0 ? [[margin, width - margin]] : [];
  for (const block of reserve ? [...obstacles, reserve] : obstacles) spans = cut(spans, block);
  return spans;
}

/** A neighbour's centre, or its centre and width when figures differ in size. */
export type Occupied = number | { x: number; w: number };

/**
 * Closest centre to `pref` that keeps a full slot clear of every neighbour
 * and obstacle. A bare-number neighbour keeps `slot` between centres; a sized
 * one keeps half of each width.
 */
export function nearestFree(pref: number, free: readonly Span[], occupied: readonly Occupied[], slot = EDGE_SLOT): number | null {
  let best: number | null = null;
  for (const [s, e] of free) {
    let segs: Span[] = s + slot / 2 <= e - slot / 2 ? [[s + slot / 2, e - slot / 2]] : [];
    for (const entry of occupied) {
      const o = typeof entry === "number" ? entry : entry.x;
      const gap = typeof entry === "number" ? slot : (slot + entry.w) / 2;
      segs = segs.flatMap(([a, b]) => {
        if (o + gap <= a || o - gap >= b) return [[a, b] as Span];
        const out: Span[] = [];
        if (o - gap >= a) out.push([a, o - gap]);
        if (o + gap <= b) out.push([o + gap, b]);
        return out;
      });
    }
    for (const [a, b] of segs) {
      const c = Math.max(a, Math.min(b, pref));
      if (best === null || Math.abs(c - pref) < Math.abs(best - pref)) best = c;
    }
  }
  return best;
}

export type EdgeFigureInput = {
  id: string;
  /** Underlying reading (not the offline override): drives priority. */
  visible: EdgeVisible;
  /** Fresh arrival still landing: outranks everything but needs-you. */
  arriving: boolean;
  /** Mid-step target, when the figure is walking. */
  stepTarget?: number | null;
  /** Earlier activity first when the edge is full. */
  lastActivityAt: number;
  /** Slot width for a figure the operator resized; EDGE_SLOT when unset. */
  width?: number;
};

export type EdgeSolution = {
  pos: Map<string, number>;
  /** Ids with no spot of their own, in "+N". */
  overflow: string[];
  /** Centre of the "+N" slot, or null when everyone fits. */
  stackAt: number | null;
};

/**
 * Where everyone stands. `prev` holds last render's spots so placement stays
 * still; new figures start from the anchor end. Settled figures claim their
 * spots first, so walkers and arrivals flow around them.
 */
export function solveEdge(
  figures: readonly EdgeFigureInput[],
  options: {
    prev: ReadonlyMap<string, number>;
    free: readonly Span[];
    anchor: "left" | "right";
    previousAnchor?: "left" | "right";
    width: number;
  },
): EdgeSolution {
  const { anchor, width } = options;
  const regather = options.previousAnchor !== undefined && options.previousAnchor !== anchor;
  const prev = regather ? new Map<string, number>() : options.prev;
  const pri = (f: EdgeFigureInput) => (f.arriving ? Math.min(PRIORITY[f.visible], 0.5) : PRIORITY[f.visible]);
  const capacityOf = (spans: readonly Span[]) => spans.reduce((sum, [a, b]) => sum + Math.max(0, Math.floor((b - a) / EDGE_SLOT)), 0);
  // A resized figure takes as many classic slots as its width needs.
  const widthOf = (f: EdgeFigureInput) => f.width ?? EDGE_SLOT;
  const slotsOf = (f: EdgeFigureInput) => Math.max(1, Math.ceil(widthOf(f) / EDGE_SLOT));
  const demand = (list: readonly EdgeFigureInput[]) => list.reduce((sum, f) => sum + slotsOf(f), 0);
  const anchorEnd = anchor === "left" ? (options.free[0]?.[0] ?? 0) : (options.free.at(-1)?.[1] ?? width);
  let free = options.free;
  let keep: readonly EdgeFigureInput[] = figures;
  const overflow: string[] = [];
  let stackAt: number | null = null;
  if (demand(figures) > capacityOf(free)) {
    // Full edge: "+N" takes its own span at the anchor end, then the least
    // consequential, settled, least recently active figures go into it.
    const span = anchor === "left" ? { start: anchorEnd, end: anchorEnd + EDGE_STACK } : { start: anchorEnd - EDGE_STACK, end: anchorEnd };
    stackAt = (span.start + span.end) / 2;
    free = cut(free, span);
    const ranked = [...figures].sort((x, y) => pri(x) - pri(y)
      || (prev.has(x.id) ? 0 : 1) - (prev.has(y.id) ? 0 : 1)
      || y.lastActivityAt - x.lastActivityAt);
    let room = capacityOf(free);
    let fit = 0;
    while (fit < ranked.length && slotsOf(ranked[fit]!) <= room) room -= slotsOf(ranked[fit++]!);
    keep = ranked.slice(0, fit);
    overflow.push(...ranked.slice(fit).map((f) => f.id));
  }
  const rank = (f: EdgeFigureInput) => (!prev.has(f.id) ? 3 : f.stepTarget != null ? 2 : f.visible === "needs" ? 0 : 1);
  const order = [...keep].sort((x, y) => rank(x) - rank(y) || pri(x) - pri(y));
  const occupied: { x: number; w: number }[] = [];
  const pos = new Map<string, number>();
  const byId = new Map(figures.map((f) => [f.id, f]));
  for (const figure of order) {
    const settled = prev.get(figure.id);
    const pref = (regather ? null : figure.stepTarget) ?? (Number.isFinite(settled) ? settled! : anchorEnd);
    const w = widthOf(figure);
    let x = nearestFree(pref, free, occupied, w);
    if (x === null && pri(figure) < 1) {
      // Gaps between settled figures can be too narrow for one more. Needs-you
      // and arrivals never go to "+N": the least consequential figure yields.
      const victim = [...pos.keys()]
        .map((id) => byId.get(id)!)
        .filter((f) => pri(f) >= 2)
        .sort((a, b) => pri(b) - pri(a) || a.lastActivityAt - b.lastActivityAt)[0];
      if (victim) {
        const at = pos.get(victim.id)!;
        const index = occupied.findIndex((o) => o.x === at);
        const [removed] = occupied.splice(index, 1);
        x = nearestFree(pref, free, occupied, w);
        if (x === null) occupied.push(removed!);
        else {
          pos.delete(victim.id);
          overflow.push(victim.id);
        }
      }
    }
    if (x === null) {
      overflow.push(figure.id);
      continue;
    }
    pos.set(figure.id, x);
    occupied.push({ x, w });
  }
  // Fragmentation alone overflowed: put "+N" in the gap nearest the anchor.
  if (overflow.length && stackAt === null) stackAt = nearestFree(anchorEnd, free, occupied.map((o) => o.x), EDGE_STACK) ?? anchorEnd;
  return { pos, overflow, stackAt };
}

function seedOf(id: string): number {
  let h = 7;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 997;
  return h;
}

/**
 * The `n`th step of a working figure: 16–41px, direction from a per-figure
 * seed, never further than `reach` from home. Deterministic, so the same
 * activity always produces the same walk.
 */
export function stepTarget(id: string, n: number, current: number, home: number, reach = EDGE_REACH): number {
  const seed = seedOf(id);
  const step = 16 + ((n * 37 + seed * 13) % 26);
  const dir = Math.sin(n * 2.3 + seed) >= 0 ? 1 : -1;
  const clamp = (x: number) => Math.max(home - reach, Math.min(home + reach, x));
  let target = clamp(current + dir * step);
  if (Math.abs(target - current) < 6) target = clamp(current - dir * step);
  return target;
}

/**
 * Arrivals: ids that appear after the companion first saw its work. The first
 * observation only records what is already there, so opening the companion
 * or reloading the page never parachutes the whole crew in.
 */
export function detectArrivals(known: ReadonlySet<string> | null, ids: readonly string[]): { known: Set<string>; arrived: string[] } {
  if (!known) return { known: new Set(ids), arrived: [] };
  const arrived = ids.filter((id) => !known.has(id));
  return { known: new Set([...known, ...ids]), arrived };
}

/**
 * Work that truly comes from another machine: its pin names another node, or
 * its owner agent's authority and home nodes are known and none is this one.
 * Unknown nodes are never treated as remote.
 */
export function isVisitor(input: {
  localNodeId: string | null;
  pinMachineId?: string | null;
  agentNodeIds?: readonly (string | null | undefined)[];
}): boolean {
  const local = input.localNodeId?.trim();
  if (!local) return false;
  const pinned = input.pinMachineId?.trim();
  if (pinned) return pinned !== local;
  const nodes = (input.agentNodeIds ?? []).map((id) => id?.trim()).filter((id): id is string => Boolean(id));
  return nodes.length > 0 && !nodes.includes(local);
}

export type OriginGroup = { conversationId: string; ids: string[]; center: number };

/**
 * Origin pins: figures launched from the same conversation share one pin.
 * Only conversations with two or more figures on the edge get a pin, plus the
 * one the operator is looking at, so a crew of one-offs stays uncluttered.
 */
export function originGroups(
  figures: readonly { id: string; conversationId: string | null }[],
  pos: ReadonlyMap<string, number>,
  focusId: string | null = null,
): OriginGroup[] {
  const byConversation = new Map<string, string[]>();
  for (const figure of figures) {
    if (!figure.conversationId || !pos.has(figure.id)) continue;
    const list = byConversation.get(figure.conversationId);
    if (list) list.push(figure.id);
    else byConversation.set(figure.conversationId, [figure.id]);
  }
  const groups: OriginGroup[] = [];
  for (const [conversationId, ids] of byConversation) {
    if (ids.length < 2 && !ids.includes(focusId ?? "")) continue;
    const xs = ids.map((id) => pos.get(id)!);
    groups.push({ conversationId, ids, center: (Math.min(...xs) + Math.max(...xs)) / 2 });
  }
  return groups.sort((a, b) => a.center - b.center);
}

/** Spread pin tabs so none overlaps another; each stays as close to its group as it can. */
export function spreadPins(centers: readonly number[], width: number, tab = 44, gap = 4, margin = EDGE_MARGIN): number[] {
  const out: number[] = [];
  const half = tab / 2;
  for (const center of centers) {
    const floor = out.length ? out.at(-1)! + tab + gap : margin + half;
    out.push(Math.max(floor, Math.min(width - margin - half, center)));
  }
  // Pushed past the right end: walk back leftward.
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const ceiling = i === out.length - 1 ? width - margin - half : out[i + 1]! - tab - gap;
    out[i] = Math.max(margin + half, Math.min(out[i]!, ceiling));
  }
  return out;
}

/** Left offset that keeps a popover of `popWidth` on screen above the spot at `x`. */
export function popoverLeft(x: number, popWidth: number, width: number, margin = 12): number {
  return Math.max(margin, Math.min(width - popWidth - margin, x - popWidth / 2));
}

/** The earliest `until` among in-flight motions, or null when nothing is in flight. */
export function nextExpiry(entries: ReadonlyMap<string, { until: number }>): number | null {
  let at: number | null = null;
  for (const entry of entries.values()) if (at === null || entry.until < at) at = entry.until;
  return at;
}

/** In-flight motions still running at `now`; the same map when none ended. */
export function pruneExpired<T extends { until: number }>(entries: Map<string, T>, now: number): Map<string, T> {
  let changed = false;
  const out = new Map<string, T>();
  for (const [id, entry] of entries) {
    if (entry.until > now) out.set(id, entry);
    else changed = true;
  }
  return changed ? out : entries;
}
