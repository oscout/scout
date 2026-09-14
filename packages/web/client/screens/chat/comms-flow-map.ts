/**
 * Layout for the Flow map: who talks to whom, and on which model.
 *
 * The graph answers "what happened, in order". This answers the question that
 * order hides — which participants actually exchange work, how much, and which
 * way. Traffic is aggregated per ordered pair, so the drawing is a shape rather
 * than a timeline, and the busiest participant sits at the hub because that is
 * what an orchestrator looks like from above.
 *
 * Pure geometry over the pass model: no React, no DOM.
 */

import type { FlowActor, FlowFlight, FlowPass } from "../../lib/comms-flow.ts";

export type MapMetrics = {
  width: number;
  height: number;
  /** Radii of the ring the spokes sit on. */
  rx: number;
  ry: number;
  /** Half-size of a node's box, used to inset an edge so arrowheads stay clear. */
  nodeRx: number;
  nodeRy: number;
  /** How far an edge bows off the straight line, so the two directions separate. */
  bend: number;
  /** Hub plus this many spokes. Past roughly a dozen a ring reads as a hairball. */
  maxNodes: number;
};

/** Everyone past the cap, gathered into one node so the count stays honest. */
export const OTHERS_ID = "__others";

export const MAP_METRICS: MapMetrics = {
  width: 760,
  height: 520,
  rx: 262,
  ry: 172,
  nodeRx: 62,
  nodeRy: 21,
  bend: 24,
  maxNodes: 12,
};

/** What the participant roster states about an actor. Never inferred. */
export type MapIdentity = { model?: string | null; harness?: string | null };

export type MapNode = {
  id: string;
  actor: FlowActor;
  x: number;
  y: number;
  hub: boolean;
  sent: number;
  received: number;
  model: string | null;
  harness: string | null;
};

export type MapEdge = {
  key: string;
  from: string;
  to: string;
  count: number;
  /** Stroke width, 1–4, by share of the busiest pair. */
  weight: number;
  d: string;
  /** Arrowhead: the landing point and the direction it points. */
  tip: { x: number; y: number; angle: number };
  /** Lands on the operator, which is the one thing that changes an edge's hue. */
  inbound: boolean;
};

export type MapLayout = {
  nodes: MapNode[];
  edges: MapEdge[];
  width: number;
  height: number;
  /** Messages to the whole conversation, which are not a pair and get no edge. */
  broadcasts: number;
  /** How many nodes the roster actually names a model for. */
  modelsKnown: number;
};

/** Where a ray from a node's centre leaves its box, so an arrow stops at the edge. */
function exit(dx: number, dy: number, rx: number, ry: number): { x: number; y: number } {
  const scale = Math.hypot(dx / rx, dy / ry);
  if (scale === 0) return { x: 0, y: 0 };
  return { x: dx / scale, y: dy / scale };
}

export function commsFlowMapLayout(
  passes: readonly FlowPass[],
  identities: ReadonlyMap<string, MapIdentity> = new Map(),
  metrics: MapMetrics = MAP_METRICS,
): MapLayout {
  const actors = new Map<string, FlowActor>();
  const sent = new Map<string, number>();
  const received = new Map<string, number>();
  const pairs = new Map<string, { from: string; to: string; count: number }>();
  let broadcasts = 0;

  const order: string[] = [];
  const see = (actor: FlowActor) => {
    if (actors.has(actor.id)) return;
    actors.set(actor.id, actor);
    order.push(actor.id);
  };

  for (const pass of passes) {
    see(pass.from);
    // A message to the room is not a pair. Drawing one edge per listener turns
    // a single broadcast into a hairball and invents exchanges that never were.
    if (pass.kind === "channel") {
      broadcasts += pass.count;
      for (const target of pass.audience) see(target);
      continue;
    }
    sent.set(pass.from.id, (sent.get(pass.from.id) ?? 0) + pass.count);
    for (const target of pass.audience) {
      see(target);
      if (target.id === pass.from.id) continue;
      received.set(target.id, (received.get(target.id) ?? 0) + pass.count);
      const key = `${pass.from.id}->${target.id}`;
      const pair = pairs.get(key);
      if (pair) pair.count += pass.count;
      else pairs.set(key, { from: pass.from.id, to: target.id, count: pass.count });
    }
  }

  const traffic = (id: string) => (sent.get(id) ?? 0) + (received.get(id) ?? 0);
  const ranked = [...actors.keys()].sort((a, b) => traffic(b) - traffic(a));
  const hub = ranked[0] ?? null;

  // An agent's whole neighbourhood can run to hundreds of participants, and a
  // ring of hundreds is a hairball that says less than a sentence would. Keep
  // the busiest, gather the tail into one node, and let its label say how many.
  const kept = new Set(ranked.slice(0, metrics.maxNodes));
  const folded = ranked.filter((id) => !kept.has(id));
  const fold = (id: string) => (kept.has(id) ? id : OTHERS_ID);
  if (folded.length > 0) {
    const rest: FlowActor = {
      id: OTHERS_ID,
      ids: [],
      name: `${folded.length} others`,
      short: `${folded.length} others`,
      kind: "agent",
    };
    actors.set(OTHERS_ID, rest);
    let restSent = 0;
    let restReceived = 0;
    for (const id of folded) {
      restSent += sent.get(id) ?? 0;
      restReceived += received.get(id) ?? 0;
      actors.delete(id);
      sent.delete(id);
      received.delete(id);
    }
    sent.set(OTHERS_ID, restSent);
    received.set(OTHERS_ID, restReceived);

    const merged = new Map<string, { from: string; to: string; count: number }>();
    for (const pair of pairs.values()) {
      const from = fold(pair.from);
      const to = fold(pair.to);
      // Traffic between two folded actors has no pair left to draw.
      if (from === to) continue;
      const key = `${from}->${to}`;
      const held = merged.get(key);
      if (held) held.count += pair.count;
      else merged.set(key, { from, to, count: pair.count });
    }
    pairs.clear();
    for (const [key, pair] of merged) pairs.set(key, pair);
  }

  const spokes = [...order.filter((id) => id !== hub && kept.has(id)), ...(folded.length > 0 ? [OTHERS_ID] : [])];

  const cx = metrics.width / 2;
  const cy = metrics.height / 2;
  const nodes: MapNode[] = [];
  const at = new Map<string, { x: number; y: number }>();
  for (const [index, id] of [hub, ...spokes].filter((v): v is string => v !== null).entries()) {
    const isHub = id === hub;
    // Clockwise from the top, in the order they first appear in the window.
    const angle = spokes.length === 0 ? 0 : (index - 1) / spokes.length * Math.PI * 2 - Math.PI / 2;
    const point = isHub
      ? { x: cx, y: cy }
      : { x: cx + Math.cos(angle) * metrics.rx, y: cy + Math.sin(angle) * metrics.ry };
    at.set(id, point);
    const identity = identities.get(id) ?? {};
    nodes.push({
      id,
      actor: actors.get(id)!,
      x: point.x,
      y: point.y,
      hub: isHub,
      sent: sent.get(id) ?? 0,
      received: received.get(id) ?? 0,
      model: identity.model?.trim() || null,
      harness: identity.harness?.trim() || null,
    });
  }

  const busiest = Math.max(1, ...[...pairs.values()].map((p) => p.count));
  const edges: MapEdge[] = [];
  for (const pair of pairs.values()) {
    const a = at.get(pair.from);
    const b = at.get(pair.to);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    if (length === 0) continue;
    // Bow every edge off its own left. Bending by id order instead puts both
    // directions on the same side, where they overlap into one fat arrow.
    const nx = -dy / length;
    const ny = dx / length;
    const start = exit(dx, dy, metrics.nodeRx, metrics.nodeRy);
    const end = exit(-dx, -dy, metrics.nodeRx, metrics.nodeRy);
    const x0 = a.x + start.x;
    const y0 = a.y + start.y;
    const x1 = b.x + end.x;
    const y1 = b.y + end.y;
    const mx = (x0 + x1) / 2 + nx * metrics.bend;
    const my = (y0 + y1) / 2 + ny * metrics.bend;
    edges.push({
      key: `${pair.from}->${pair.to}`,
      from: pair.from,
      to: pair.to,
      count: pair.count,
      weight: 1 + Math.round((pair.count / busiest) * 3),
      d: `M ${x0} ${y0} Q ${mx} ${my} ${x1} ${y1}`,
      tip: { x: x1, y: y1, angle: (Math.atan2(y1 - my, x1 - mx) * 180) / Math.PI },
      inbound: actors.get(pair.to)?.kind === "operator",
    });
  }

  return {
    nodes,
    edges,
    width: metrics.width,
    height: metrics.height,
    broadcasts,
    modelsKnown: nodes.filter((n) => n.model !== null && n.id !== OTHERS_ID).length,
  };
}

/** The pairs behind the drawing, busiest first — the numbers the shape implies. */
export function commsFlowMapPairs(layout: MapLayout): {
  key: string;
  from: MapNode;
  to: MapNode;
  count: number;
}[] {
  const byId = new Map(layout.nodes.map((n) => [n.id, n]));
  return layout.edges
    .map((edge) => ({ key: edge.key, from: byId.get(edge.from)!, to: byId.get(edge.to)!, count: edge.count }))
    .filter((row) => row.from && row.to)
    .sort((a, b) => b.count - a.count || a.from.actor.short.localeCompare(b.from.actor.short));
}

/**
 * A task: one ask that came back, and the exchange that carried it.
 *
 * A thread's aggregate map puts the orchestrator at the hub with a spoke per
 * partner, which says "Blink talked to nine people" and little else. The unit
 * that carries meaning is the piece of work — who was asked, what ran them, how
 * long it took — so the map can be scoped down to one.
 */
export type FlowTask = {
  id: string;
  title: string;
  waiter: FlowActor;
  worker: FlowActor;
  at: number;
  ms: number;
  /** The broker gave up before the answer arrived. */
  abandoned: boolean;
  passes: FlowPass[];
};

/** The first line that says what was asked, with the ask marker taken off. */
function taskTitle(body: string): string {
  const line = body
    .replace(/^\s*\[ask:[^\]]*\]\s*/i, "")
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (!line) return "Untitled ask";
  const clean = line.replace(/[*_`#]/g, "").trim();
  return clean.length > 72 ? `${clean.slice(0, 71).trimEnd()}…` : clean;
}

export function flowTasks(passes: readonly FlowPass[], flights: readonly FlowFlight[]): FlowTask[] {
  return flights
    .map((flight) => {
      const pair = new Set([flight.waiter.id, flight.worker.id]);
      // What the two of them exchanged while the ask was out, plus its two ends.
      // Anything else in that stretch belongs to somebody else's branch.
      const between = passes.filter(
        (pass) =>
          pass.at >= flight.opener.at
          && pass.at <= flight.answer.at
          && pair.has(pass.from.id)
          && (pass.kind === "channel" || pass.audience.some((actor) => pair.has(actor.id))),
      );
      const seen = new Set(between.map((pass) => pass.id));
      const ends = [flight.opener, flight.answer].filter((pass) => !seen.has(pass.id));
      return {
        id: flight.askId,
        title: taskTitle(flight.opener.message.body),
        waiter: flight.waiter,
        worker: flight.worker,
        at: flight.opener.at,
        ms: flight.answer.at - flight.opener.at,
        abandoned: flight.timedOutAt !== null,
        passes: [...between, ...ends].sort((a, b) => a.at - b.at),
      };
    })
    .sort((a, b) => a.at - b.at);
}
