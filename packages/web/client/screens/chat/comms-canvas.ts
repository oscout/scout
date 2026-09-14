/**
 * Comms · Canvas — the work graph laid out as a flow diagram.
 *
 * The Map draws this window as a ring: the busiest participant at the centre,
 * up to a dozen neighbours on an ellipse, everyone past the cap folded into one
 * "N others". That is the wrong drawing for the shape this data actually has.
 *
 * Measured over a real 91-message window: 33 distinct participants, 57 ordered
 * pairs, and EVERY ONE of those pairs incident to a single node — 100% of the
 * traffic through one orchestrator — with an ask chain that is a shallow tree
 * and no cycles. The ring answers that shape by hiding 20 of the 33 and drawing
 * a dozen curved arrows that all say the same thing. Laid out in lanes it has
 * zero edge crossings and hides nobody.
 *
 * It also buys an axis. On a ring, angular position means nothing — it is
 * whatever order the nodes came out of the list. In a lane, VERTICAL ORDER IS
 * FREE, so it can be spent on something: how long the work was held, whether it
 * ever came back, how much was said. That is the argument for the canvas beyond
 * looking tidier.
 *
 * Pure geometry and pure counting. No React, no DOM — same shape as
 * `comms-flow-map.ts`, and tested the same way.
 */

import type { FlowActor, FlowFlight, FlowPass } from "../../lib/comms-flow.ts";
import { flowTasks, type MapIdentity } from "./comms-flow-map.ts";

export type CanvasActor = {
  id: string;
  short: string;
  kind: string;
  /** What the roster states ran this participant. Never inferred. */
  model?: string | null;
  harness?: string | null;
  /**
   * The record contradicts itself about who this is: every message filed under
   * the identity says an agent wrote it, while the identity resolves to a
   * person. Drawn, because it is what the record says — but marked, because a
   * lane of work hanging off a human who never typed is exactly the kind of
   * noise a clean drawing launders into a fact. See `commsCanvasInputs`.
   */
  disputed?: boolean;
};

export type CanvasTask = {
  id: string;
  title: string;
  ms: number;
  abandoned: boolean;
  waiterId: string;
  workerId: string;
};

/** Messages counted per ordered pair, exactly as the map counts them. */
export type CanvasPair = { from: string; to: string; count: number };

export type CanvasOrder = "duration" | "outcome" | "volume" | "name";

export type CanvasMode = "ladder" | "shelf";

export const CANVAS_METRICS = {
  nodeW: 178,
  nodeH: 42,
  rowGap: 9,
  laneGap: 124,
  padX: 26,
  padY: 46,
  /** Past this many in one lane the shelf wraps into another column. */
  shelfRows: 9,
  colGap: 20,
};

export type CanvasNode = {
  id: string;
  short: string;
  kind: string;
  lane: number;
  /** Which wrapped column inside the lane; always 0 in ladder mode. */
  col: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Tasks this node handed out, and tasks it was handed. */
  asked: number;
  did: number;
  /** Longest task it held, and how many of its tasks never came back. */
  ms: number;
  abandoned: number;
  sent: number;
  received: number;
  model: string | null;
  harness: string | null;
  /** The record disagrees with itself about who this is. See `CanvasActor`. */
  disputed: boolean;
  /** No ask record either way — placed by who it talks to, not by the chain. */
  inferred: boolean;
};

export type CanvasEdge = {
  key: string;
  from: string;
  to: string;
  count: number;
  /** How many asks rode this edge, and how many of them timed out. */
  tasks: number;
  abandoned: number;
  /** 1–4 by share of the busiest pair, as on the map. */
  weight: number;
  d: string;
  tip: { x: number; y: number; angle: number };
};

/**
 * One bundled edge standing in for every identical edge into a lane.
 *
 * When thirty edges all say "the hub asked this one too", thirty edges carry
 * one bit between them. Draw one and label it thirty.
 */
export type CanvasTrunk = {
  key: string;
  from: string;
  lane: number;
  count: number;
  tasks: number;
  abandoned: number;
  d: string;
  /**
   * Where the count sits: beside the SOURCE card, not the bracket.
   *
   * Several sources can hand work into the same lane, and every one of their
   * trunks lands on the same bracket — so a label parked there would be a pile
   * of numbers with nothing saying which belongs to which. At the source end
   * each label sits next to the card it is about, stepped down by how far the
   * lane is, because one source can also feed more than one lane.
   */
  label: { x: number; y: number };
  bar: { x: number; y1: number; y2: number };
};

export type CanvasLane = {
  index: number;
  label: string;
  x: number;
  count: number;
};

export type CanvasLayout = {
  nodes: CanvasNode[];
  /** How many participants the roster actually names a model for. */
  modelsKnown: number;
  /** How many the record contradicts itself about. */
  disputedCount: number;
  edges: CanvasEdge[];
  trunks: CanvasTrunk[];
  lanes: CanvasLane[];
  width: number;
  height: number;
};

/* ── Reading the window ────────────────────────────────────────────────── */

export type CanvasInputs = {
  actors: CanvasActor[];
  tasks: CanvasTask[];
  pairs: CanvasPair[];
  /** Messages to a whole conversation, which are not pairs. */
  broadcasts: number;
  /** Passes whose author the record contradicts itself about. */
  misattributed: number;
};

/**
 * Everything the canvas draws, read off the same passes the map reads.
 *
 * Deliberately NOT `commsFlowMapPairs`: that counts pairs off the map's layout,
 * which caps at twelve nodes and folds the rest into "N others". The whole
 * point of the canvas is that nothing is folded, so it counts from the passes.
 * The rule for what counts as a pair is the map's, exactly — a message to the
 * room is not a pair, because drawing one edge per listener turns a single
 * broadcast into a hairball and invents exchanges that never happened.
 */
export function commsCanvasInputs(
  passes: readonly FlowPass[],
  flights: readonly FlowFlight[],
  identities: ReadonlyMap<string, MapIdentity> = new Map(),
): CanvasInputs {
  const seen = new Map<string, FlowActor>();
  const pairs = new Map<string, CanvasPair>();
  let broadcasts = 0;

  // `from` is who the actor id resolves to; `message.class` is what the record
  // says wrote it. Where an identity resolves to the operator and EVERY message
  // under it is classed `agent`, the record has contradicted itself: an agent
  // handed out work and the ask was stamped with the operator's display name in
  // transit. The test is that disagreement and nothing else — an identity
  // qualifies only when the record never once agrees with itself about it, so
  // this can never quietly relabel someone who genuinely did speak.
  const spoke = new Map<string, { own: number; agent: number }>();

  const see = (actor: FlowActor) => {
    if (!seen.has(actor.id)) seen.set(actor.id, actor);
  };

  for (const pass of passes) {
    see(pass.from);
    if (pass.from.kind === "operator") {
      const tally = spoke.get(pass.from.id) ?? { own: 0, agent: 0 };
      if (pass.message.class === "agent") tally.agent += pass.count;
      else tally.own += pass.count;
      spoke.set(pass.from.id, tally);
    }
    if (pass.kind === "channel") {
      broadcasts += pass.count;
      for (const target of pass.audience) see(target);
      continue;
    }
    for (const target of pass.audience) {
      see(target);
      if (target.id === pass.from.id) continue;
      const key = `${pass.from.id}->${target.id}`;
      const held = pairs.get(key);
      if (held) held.count += pass.count;
      else pairs.set(key, { from: pass.from.id, to: target.id, count: pass.count });
    }
  }

  const disputed = new Set([...spoke].filter(([, t]) => t.own === 0 && t.agent > 0).map(([id]) => id));
  const misattributed = [...spoke]
    .filter(([id]) => disputed.has(id))
    .reduce((total, [, t]) => total + t.agent, 0);

  const actors: CanvasActor[] = [...seen.values()].map((actor) => ({
    id: actor.id,
    short: actor.short,
    kind: actor.kind,
    model: identities.get(actor.id)?.model ?? null,
    harness: identities.get(actor.id)?.harness ?? null,
    disputed: disputed.has(actor.id),
  }));

  const tasks: CanvasTask[] = flowTasks(passes, flights).map((task) => ({
    id: task.id,
    title: task.title,
    ms: task.ms,
    abandoned: task.abandoned,
    waiterId: task.waiter.id,
    workerId: task.worker.id,
  }));

  return { actors, tasks, pairs: [...pairs.values()], broadcasts, misattributed };
}

/* ── Scope ─────────────────────────────────────────────────────────────── */

/**
 * The branch through one participant: who asked it, and who it asked, all the
 * way down.
 *
 * An agent's window is its whole neighbourhood — every conversation it is mixed
 * up in, which on a busy machine runs to a hundred participants whose work has
 * nothing to do with this agent. Drawing all of them answers "what is going on
 * around here"; drawing the branch answers "what is going on with THIS", which
 * is the question the surface is on.
 *
 * Ancestors and descendants in the ask graph, so it is the tree the root sits
 * in rather than everyone it happened to exchange a message with. An actor with
 * no ask on record either way is not in anybody's tree and is left out — it
 * reappears the moment the scope is widened.
 *
 * Returns everything unchanged when the root has no branch to speak of: one
 * card is not a drawing, and a surface with nothing to focus should show what
 * it has rather than nothing.
 */
export function commsCanvasScope(
  actors: readonly CanvasActor[],
  tasks: readonly CanvasTask[],
  pairs: readonly CanvasPair[],
  rootId: string,
): { actors: CanvasActor[]; tasks: CanvasTask[]; pairs: CanvasPair[]; setAside: number } {
  const keep = new Set<string>([rootId]);
  const down = new Map<string, string[]>();
  const up = new Map<string, string[]>();
  for (const task of tasks) {
    (down.get(task.waiterId) ?? down.set(task.waiterId, []).get(task.waiterId)!).push(task.workerId);
    (up.get(task.workerId) ?? up.set(task.workerId, []).get(task.workerId)!).push(task.waiterId);
  }
  for (const edges of [down, up]) {
    const queue = [rootId];
    for (let head = 0; head < queue.length; head += 1) {
      for (const next of edges.get(queue[head]!) ?? []) {
        if (keep.has(next)) continue;
        keep.add(next);
        queue.push(next);
      }
    }
  }
  if (keep.size < 2) {
    return { actors: [...actors], tasks: [...tasks], pairs: [...pairs], setAside: 0 };
  }
  return {
    actors: actors.filter((actor) => keep.has(actor.id)),
    tasks: tasks.filter((task) => keep.has(task.waiterId) && keep.has(task.workerId)),
    pairs: pairs.filter((pair) => keep.has(pair.from) && keep.has(pair.to)),
    setAside: actors.length - keep.size,
  };
}

/* ── Layering ──────────────────────────────────────────────────────────── */

/**
 * Depth in the ask chain: who opened the work, who passed it on, who did it.
 *
 * Longest path over a topological order, so a node always sits to the right of
 * everyone who asked it. Cycles cannot be ordered — those nodes are resolved
 * afterwards against whichever of their askers did get a depth, which keeps a
 * malformed window drawable instead of empty.
 */
function askDepths(ids: readonly string[], asks: readonly { from: string; to: string }[]): Map<string, number> {
  const out = new Map<string, string[]>();
  const into = new Map<string, string[]>();
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const ask of asks) {
    if (ask.from === ask.to) continue;
    (out.get(ask.from) ?? out.set(ask.from, []).get(ask.from)!).push(ask.to);
    (into.get(ask.to) ?? into.set(ask.to, []).get(ask.to)!).push(ask.from);
    indeg.set(ask.to, (indeg.get(ask.to) ?? 0) + 1);
  }

  const depth = new Map<string, number>();
  const queue = ids.filter((id) => (indeg.get(id) ?? 0) === 0);
  for (const id of queue) depth.set(id, 0);
  const left = new Map(indeg);
  for (let head = 0; head < queue.length; head += 1) {
    const id = queue[head]!;
    for (const next of out.get(id) ?? []) {
      depth.set(next, Math.max(depth.get(next) ?? 0, (depth.get(id) ?? 0) + 1));
      const remaining = (left.get(next) ?? 0) - 1;
      left.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }
  // Anything still unplaced sits in a cycle; seat it past whoever asked it.
  for (const id of ids) {
    if (depth.has(id)) continue;
    const asked = (into.get(id) ?? []).map((from) => depth.get(from)).filter((d): d is number => d !== undefined);
    depth.set(id, asked.length > 0 ? Math.max(...asked) + 1 : 0);
  }
  return depth;
}

function laneLabel(index: number, last: number): string {
  if (last === 0) return "In this window";
  if (index === 0) return "Opened the work";
  if (index === last) return "Did the work";
  return "Passed it on";
}

/* ── Layout ────────────────────────────────────────────────────────────── */

export function commsCanvasLayout(
  actors: readonly CanvasActor[],
  tasks: readonly CanvasTask[],
  pairs: readonly CanvasPair[],
  options: { mode: CanvasMode; order: CanvasOrder; shelfRows?: number },
): CanvasLayout {
  const M = CANVAS_METRICS;
  const known = new Map(actors.map((actor) => [actor.id, actor]));

  // Per-node tallies. A task counts for both ends; a pair counts for both.
  const stat = new Map<string, { asked: number; did: number; ms: number; abandoned: number; sent: number; received: number }>();
  const reach = (id: string) => {
    let held = stat.get(id);
    if (!held) {
      held = { asked: 0, did: 0, ms: 0, abandoned: 0, sent: 0, received: 0 };
      stat.set(id, held);
    }
    return held;
  };
  for (const actor of actors) reach(actor.id);
  for (const task of tasks) {
    reach(task.waiterId).asked += 1;
    const worker = reach(task.workerId);
    worker.did += 1;
    worker.ms = Math.max(worker.ms, task.ms);
    if (task.abandoned) worker.abandoned += 1;
  }
  for (const pair of pairs) {
    reach(pair.from).sent += pair.count;
    reach(pair.to).received += pair.count;
  }

  const asks = tasks.map((task) => ({ from: task.waiterId, to: task.workerId }));
  const ids = actors.map((actor) => actor.id);
  const depth = askDepths(ids, asks);

  // An actor with no ask either way has no place in the chain. Rather than
  // stranding it at the source, seat it just past whoever it talks to most —
  // and say so on the card, because that placement is inferred, not recorded.
  const inChain = new Set<string>();
  for (const ask of asks) {
    inChain.add(ask.from);
    inChain.add(ask.to);
  }
  const busiestPartner = new Map<string, { id: string; count: number }>();
  for (const pair of pairs) {
    for (const [self, other] of [[pair.from, pair.to], [pair.to, pair.from]] as const) {
      const held = busiestPartner.get(self);
      if (!held || pair.count > held.count) busiestPartner.set(self, { id: other, count: pair.count });
    }
  }
  for (const id of ids) {
    if (inChain.has(id)) continue;
    const partner = busiestPartner.get(id);
    depth.set(id, partner && inChain.has(partner.id) ? (depth.get(partner.id) ?? 0) + 1 : depth.get(id) ?? 0);
  }

  const lastLane = Math.max(0, ...ids.map((id) => depth.get(id) ?? 0));

  // Vertical order is the axis a ring does not have, so it is sorted, not given.
  const rank = (id: string) => {
    const s = reach(id);
    switch (options.order) {
      case "duration":
        return -s.ms;
      case "outcome":
        return -(s.abandoned * 1e12 + s.ms);
      case "volume":
        return -(s.sent + s.received);
      case "name":
        return 0;
    }
  };
  const byLane = new Map<number, string[]>();
  for (const id of ids) {
    const lane = depth.get(id) ?? 0;
    (byLane.get(lane) ?? byLane.set(lane, []).get(lane)!).push(id);
  }
  for (const [, members] of byLane) {
    members.sort((a, b) => {
      const d = rank(a) - rank(b);
      if (d !== 0) return d;
      return (known.get(a)?.short ?? a).localeCompare(known.get(b)?.short ?? b);
    });
  }

  // Lane x is cumulative, because a wrapped lane is wider than one card.
  // How tall any lane may get before it wraps into another column. Only the
  // caller knows how much room the stage actually has, so it may say; the
  // constant is the fallback. It applies to EVERY lane, not just the fan-out:
  // a lane of nine openers overflows a short stage exactly as a lane of thirty
  // workers does.
  const rowsPerCol = options.mode === "shelf"
    ? Math.max(2, options.shelfRows ?? M.shelfRows)
    : Number.POSITIVE_INFINITY;
  const laneCols = new Map<number, number>();
  const laneX = new Map<number, number>();
  let x = M.padX;
  for (let lane = 0; lane <= lastLane; lane += 1) {
    const members = byLane.get(lane) ?? [];
    const cols = Math.max(1, Math.ceil(members.length / rowsPerCol));
    laneCols.set(lane, cols);
    laneX.set(lane, x);
    x += cols * M.nodeW + (cols - 1) * M.colGap + M.laneGap;
  }
  const width = Math.max(x - M.laneGap + M.padX, 640);

  const nodes: CanvasNode[] = [];
  for (let lane = 0; lane <= lastLane; lane += 1) {
    const members = byLane.get(lane) ?? [];
    const cols = laneCols.get(lane) ?? 1;
    const perCol = Math.ceil(members.length / cols);
    members.forEach((id, index) => {
      const col = cols === 1 ? 0 : Math.floor(index / perCol);
      const row = cols === 1 ? index : index % perCol;
      const s = reach(id);
      const actor = known.get(id);
      nodes.push({
        id,
        short: actor?.short ?? id,
        kind: actor?.kind ?? "agent",
        lane,
        col,
        x: (laneX.get(lane) ?? M.padX) + col * (M.nodeW + M.colGap),
        y: M.padY + row * (M.nodeH + M.rowGap),
        w: M.nodeW,
        h: M.nodeH,
        asked: s.asked,
        did: s.did,
        ms: s.ms,
        abandoned: s.abandoned,
        sent: s.sent,
        received: s.received,
        model: actor?.model ?? null,
        harness: actor?.harness ?? null,
        disputed: actor?.disputed ?? false,
        inferred: !inChain.has(id),
      });
    });
  }
  const at = new Map(nodes.map((node) => [node.id, node]));

  const tallest = Math.max(
    1,
    ...[...byLane.entries()].map(([lane, members]) => Math.ceil(members.length / (laneCols.get(lane) ?? 1))),
  );
  const height = M.padY * 2 + tallest * M.nodeH + (tallest - 1) * M.rowGap;

  // Ask counts per ordered pair, so a ladder edge can say how much work it
  // carried. The shelf counts its asks from the asks themselves instead.
  const taskEdge = new Map<string, { tasks: number; abandoned: number }>();
  for (const task of tasks) {
    const key = `${task.waiterId}>${task.workerId}`;
    const held = taskEdge.get(key) ?? { tasks: 0, abandoned: 0 };
    held.tasks += 1;
    if (task.abandoned) held.abandoned += 1;
    taskEdge.set(key, held);
  }

  const busiest = Math.max(1, ...pairs.map((pair) => pair.count));
  const edges: CanvasEdge[] = [];
  const trunks: CanvasTrunk[] = [];

  /** Left-to-right S-curve between two cards. A tree drawn this way never crosses. */
  const curve = (from: CanvasNode, to: CanvasNode) => {
    const x1 = from.x + from.w;
    const y1 = from.y + from.h / 2;
    const x2 = to.x;
    const y2 = to.y + to.h / 2;
    const bow = Math.max(28, (x2 - x1) / 2);
    return {
      d: `M ${x1} ${y1} C ${x1 + bow} ${y1}, ${x2 - bow} ${y2}, ${x2} ${y2}`,
      tip: { x: x2, y: y2, angle: 0 },
    };
  };

  if (options.mode === "ladder") {
    for (const pair of pairs) {
      const from = at.get(pair.from);
      const to = at.get(pair.to);
      if (!from || !to || from.lane >= to.lane) continue;
      const work = taskEdge.get(`${pair.from}>${pair.to}`);
      const { d, tip } = curve(from, to);
      edges.push({
        key: `${pair.from}>${pair.to}`,
        from: pair.from,
        to: pair.to,
        count: pair.count,
        tasks: work?.tasks ?? 0,
        abandoned: work?.abandoned ?? 0,
        weight: 1 + Math.round((pair.count / busiest) * 3),
        d,
        tip,
      });
    }
  } else {
    // Shelf: every edge from one source into one lane bundles into a trunk that
    // lands on a distribution bar, so a wrapped block is never drawn through.
    const bundle = new Map<string, { from: string; lane: number; count: number; tasks: number; abandoned: number }>();
    const into = (from: string, lane: number) => {
      const key = `${from}>L${lane}`;
      const held = bundle.get(key) ?? { from, lane, count: 0, tasks: 0, abandoned: 0 };
      bundle.set(key, held);
      return held;
    };
    // Asks are counted from the asks, not inferred from message pairs: an ask
    // can ride a route that never produced a counted pair, and several asks can
    // share one pair. Counting work by traffic gets both of those wrong.
    for (const task of tasks) {
      const from = at.get(task.waiterId);
      const to = at.get(task.workerId);
      if (!from || !to || from.lane >= to.lane) continue;
      const held = into(task.waiterId, to.lane);
      held.tasks += 1;
      if (task.abandoned) held.abandoned += 1;
    }
    for (const pair of pairs) {
      const from = at.get(pair.from);
      const to = at.get(pair.to);
      if (!from || !to || from.lane >= to.lane) continue;
      into(pair.from, to.lane).count += pair.count;
    }
    for (const [key, held] of bundle) {
      const from = at.get(held.from);
      if (!from) continue;
      const block = nodes.filter((node) => node.lane === held.lane);
      if (block.length === 0) continue;
      // The bracket sits at the left edge of the block and spans its height.
      // It is deliberately not fanned out into per-card stubs: a stub to the
      // second wrapped column would have to be drawn straight through the
      // first, and the thirty edges it would draw all say the same thing.
      const barX = Math.min(...block.map((node) => node.x)) - 14;
      const y1 = Math.min(...block.map((node) => node.y)) + M.nodeH / 2;
      const y2 = Math.max(...block.map((node) => node.y)) + M.nodeH / 2;
      const x1 = from.x + from.w;
      const yFrom = from.y + from.h / 2;
      const mid = (y1 + y2) / 2;
      const bow = Math.max(28, (barX - x1) / 2);
      trunks.push({
        key,
        from: held.from,
        lane: held.lane,
        count: held.count,
        tasks: held.tasks,
        abandoned: held.abandoned,
        d: `M ${x1} ${yFrom} C ${x1 + bow} ${yFrom}, ${barX - bow} ${mid}, ${barX} ${mid}`,
        label: { x: x1 + 9, y: yFrom - 7 + (held.lane - from.lane - 1) * 12 },
        bar: { x: barX, y1, y2 },
      });
    }
  }

  return {
    nodes,
    modelsKnown: nodes.filter((node) => node.model).length,
    disputedCount: nodes.filter((node) => node.disputed).length,
    edges,
    trunks,
    lanes: [...Array(lastLane + 1).keys()].map((index) => ({
      index,
      label: laneLabel(index, lastLane),
      x: laneX.get(index) ?? M.padX,
      count: (byLane.get(index) ?? []).length,
    })),
    width,
    height,
  };
}

/** Where an arrow key goes from a card. */
export type CanvasStep = "up" | "down" | "left" | "right" | "first" | "last";

/**
 * Keyboard navigation across the canvas.
 *
 * A canvas is not a list, so "next" has to be answered spatially. Up and down
 * walk the column you are standing in; left and right cross to the neighbouring
 * column and land on the card nearest your current height — which is where the
 * eye would have gone anyway. Columns are ordered by where they are drawn, so a
 * wrapped lane reads as the several columns it looks like rather than as one.
 *
 * Returns null at an edge. Nothing wraps: a drawing has a left and a right, and
 * a cursor that reappears on the far side of one loses the reader's place.
 */
export function canvasStep(
  nodes: readonly CanvasNode[],
  fromId: string | null,
  step: CanvasStep,
): string | null {
  if (nodes.length === 0) return null;
  const here = nodes.find((node) => node.id === fromId);
  // No cursor yet: the first arrow press puts one at the start of the drawing.
  if (!here) return nodes.reduce((first, node) => (node.x < first.x || (node.x === first.x && node.y < first.y) ? node : first)).id;

  const columnOf = (node: CanvasNode) => `${node.lane}:${node.col}`;
  const column = nodes
    .filter((node) => columnOf(node) === columnOf(here))
    .sort((a, b) => a.y - b.y);

  if (step === "first") return column[0]?.id ?? null;
  if (step === "last") return column[column.length - 1]?.id ?? null;
  if (step === "up" || step === "down") {
    const at = column.findIndex((node) => node.id === here.id);
    return column[at + (step === "down" ? 1 : -1)]?.id ?? null;
  }

  const columns = new Map<string, { x: number; nodes: CanvasNode[] }>();
  for (const node of nodes) {
    const key = columnOf(node);
    const held = columns.get(key);
    if (held) {
      held.nodes.push(node);
      held.x = Math.min(held.x, node.x);
    } else columns.set(key, { x: node.x, nodes: [node] });
  }
  const ordered = [...columns.values()].sort((a, b) => a.x - b.x);
  const at = ordered.findIndex((entry) => entry.nodes.some((node) => node.id === here.id));
  const next = ordered[at + (step === "right" ? 1 : -1)];
  if (!next) return null;
  return next.nodes.reduce((best, node) =>
    Math.abs(node.y - here.y) < Math.abs(best.y - here.y) ? node : best,
  ).id;
}
