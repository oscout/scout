/**
 * Layout for the Flow graph: the git-log drawing of a chain.
 *
 * Every other view of a conversation gives each participant a fixed lane, so
 * everyone is on screen for the whole window whether or not they are doing
 * anything. This lays out a rail per *branch of work* instead. A rail opens
 * where its actor is first addressed, carries their messages as commits, and
 * closes when they are done — handing its column back, so the gutter stays as
 * narrow as the busiest moment rather than as wide as the cast.
 *
 * Pure geometry over the pass model: no React, no DOM, so the rules that are
 * easy to get wrong (when a rail may close, where an answer lands) are testable.
 */

import type { FlowActor, FlowFlight, FlowPass } from "../../lib/comms-flow.ts";

export type GraphMetrics = {
  /** Left offset of the first rail. */
  gutter: number;
  /** Distance between rails. Below ~24 a fork reads as noise rather than a branch. */
  column: number;
  /** Vertical offset of the first row. */
  head: number;
  /** Height of one message row. */
  row: number;
  /** Height of a "quiet" row standing in for folded silence. */
  gap: number;
  /** How far below the answer its merge lands on the waiting rail. */
  merge: number;
};

export const GRAPH_METRICS: GraphMetrics = { gutter: 20, column: 26, head: 22, row: 30, gap: 22, merge: 24 };

/** Silence longer than this folds into a "quiet" row instead of empty space. */
export const QUIET_THRESHOLD_MS = 90_000;

export type GraphRow =
  | { kind: "quiet"; ms: number; y: number }
  | { kind: "pass"; pass: FlowPass; y: number; column: number };

export type GraphRail = { key: string; actor: FlowActor; column: number; y0: number; y1: number };
export type GraphEdge = { key: string; d: string; pass: FlowPass; merge: boolean };
/** One delegated branch: fork row to merge row, drawn on the worker's rail. */
export type GraphSpan = {
  key: string;
  column: number;
  y0: number;
  y1: number;
  flight: FlowFlight;
  /** Row of the broker's give-up, when it said so before the answer arrived. */
  timeoutY: number | null;
};

export type GraphLayout = {
  rows: GraphRow[];
  rails: GraphRail[];
  edges: GraphEdge[];
  spans: GraphSpan[];
  columns: number;
  height: number;
};

export const railX = (column: number, m: GraphMetrics = GRAPH_METRICS) => m.gutter + column * m.column;

/** Off one rail and onto another. The same curve serves a fork and a merge. */
export function railCurve(x0: number, y0: number, x1: number, y1: number): string {
  const mid = (y0 + y1) / 2;
  return `M ${x0} ${y0} C ${x0} ${mid} ${x1} ${mid} ${x1} ${y1}`;
}

export function commsFlowGraphLayout(
  passes: readonly FlowPass[],
  flights: readonly FlowFlight[],
  metrics: GraphMetrics = GRAPH_METRICS,
): GraphLayout {
  const x = (column: number) => railX(column, metrics);

  const rows: GraphRow[] = [];
  let y = metrics.head;
  for (const pass of passes) {
    if (pass.gap > QUIET_THRESHOLD_MS && rows.length) {
      rows.push({ kind: "quiet", ms: pass.gap, y });
      y += metrics.gap;
    }
    rows.push({ kind: "pass", pass, y, column: 0 });
    y += metrics.row;
  }

  const passRows = rows.filter((r): r is Extract<GraphRow, { kind: "pass" }> => r.kind === "pass");
  const byPassId = new Map(passRows.map((r) => [r.pass.id, r]));
  const byMessageId = new Map(passRows.map((r) => [r.pass.message.id, r]));

  // Where each rail is finished with: its actor's last message, or — if they are
  // still owed an answer — the point where that answer merges back into them.
  // Closing a waiter at their last *sent* message drops the answer onto a column
  // somebody else has since taken.
  const closeAt = new Map<string, number>();
  for (const row of passRows) closeAt.set(row.pass.from.id, row.y);
  for (const flight of flights) {
    const answer = byPassId.get(flight.answer.id);
    const held = closeAt.get(flight.waiter.id);
    if (answer && held !== undefined) closeAt.set(flight.waiter.id, Math.max(held, answer.y + metrics.merge));
  }

  const open = new Map<string, number>();
  const taken = new Set<number>();
  const rails: GraphRail[] = [];
  const railsOf = new Map<string, GraphRail[]>();
  const edges: GraphEdge[] = [];

  type Origin = { column: number; y: number; pass: FlowPass } | null;
  const openRail = (actor: FlowActor, at: number, origin: Origin, key: string) => {
    let column = 0;
    while (taken.has(column)) column += 1;
    taken.add(column);
    open.set(actor.id, column);
    const rail: GraphRail = {
      key: `rail-${actor.id}-${at}`,
      actor,
      column,
      y0: origin ? origin.y : at,
      y1: at,
    };
    rails.push(rail);
    railsOf.set(actor.id, [...(railsOf.get(actor.id) ?? []), rail]);
    if (origin && origin.column !== column) {
      edges.push({
        key: `fork-${key}`,
        d: railCurve(x(origin.column), origin.y, x(column), at),
        pass: origin.pass,
        merge: false,
      });
    }
    return column;
  };

  for (const row of passRows) {
    const pass = row.pass;
    for (const [id, held] of [...open]) {
      if ((closeAt.get(id) ?? 0) < row.y) {
        taken.delete(held);
        open.delete(id);
      }
    }

    let column = open.get(pass.from.id);
    if (column === undefined) {
      // Nobody handed them the work on screen, so fork off whoever they are
      // answering — which is how a broker's status rail finds a parent.
      const answering = pass.replyTo ? byMessageId.get(pass.replyTo) : undefined;
      const origin = answering ? { column: answering.column, y: answering.y, pass: answering.pass } : null;
      column = openRail(pass.from, row.y, origin, pass.id);
    }

    row.column = column;
    const here = railsOf.get(pass.from.id)?.at(-1);
    if (here) here.y1 = Math.max(here.y1, row.y);

    // Hand the work over. The recipient's rail opens *here*, where the work was
    // given to them, not at their first reply — a branch claimed only when the
    // worker answers leaves its column free in between, so two delegations that
    // genuinely overlap collapse onto one rail and the fan-out disappears.
    // A broadcast to the room is not a delegation and forks nothing.
    if (pass.kind === "channel") continue;
    for (const target of pass.audience) {
      if (target.id === pass.from.id || open.has(target.id)) continue;
      // Nothing further from them in this window: an ask still out has no rail.
      if ((closeAt.get(target.id) ?? -1) < row.y) continue;
      openRail(target, row.y, { column, y: row.y, pass }, `${pass.id}-${target.id}`);
    }
  }

  /** The rail an actor is riding at this height — the one an answer merges into. */
  const railOf = (actor: string, at: number): GraphRail | null =>
    [...(railsOf.get(actor) ?? [])].reverse().find((rail) => rail.y0 <= at) ?? null;

  const spans: GraphSpan[] = [];
  for (const flight of flights) {
    const asked = byPassId.get(flight.opener.id);
    const answered = byPassId.get(flight.answer.id);
    if (!asked || !answered) continue;
    const mergeY = answered.y + metrics.merge;
    const parent = railOf(flight.waiter.id, mergeY);
    // An answer on the asker's own rail is not a merge, it is the next commit.
    if (!parent || parent.column === answered.column) continue;
    edges.push({
      key: `merge-${flight.askId}`,
      d: railCurve(x(answered.column), answered.y, x(parent.column), mergeY),
      pass: flight.answer,
      merge: true,
    });
    parent.y1 = Math.max(parent.y1, mergeY);
    const timeout = flight.timedOutAt === null
      ? null
      : passRows.find((r) => r.pass.kind === "status" && r.pass.replyTo === flight.opener.message.id)?.y ?? null;
    spans.push({
      key: `span-${flight.askId}`,
      column: answered.column,
      y0: asked.y,
      y1: answered.y,
      flight,
      timeoutY: timeout,
    });
  }

  const columns = passRows.reduce((most, row) => Math.max(most, row.column), 0) + 1;
  return { rows, rails, edges, spans, columns, height: y + 12 };
}
