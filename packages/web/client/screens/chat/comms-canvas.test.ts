import { describe, expect, test } from "bun:test";
import { buildCommsFlow, type FlowSourceMessage } from "../../lib/comms-flow.ts";
import {
  CANVAS_METRICS,
  canvasStep,
  commsCanvasInputs,
  commsCanvasLayout,
  commsCanvasScope,
  type CanvasActor,
  type CanvasPair,
  type CanvasTask,
} from "./comms-canvas.ts";

const HUB = "openscout-agent-2";
const A = "session-alpha-1";
const B = "session-beta-1";
const T0 = 1_788_987_304_494;

function msg(over: Partial<FlowSourceMessage> & { id: string }): FlowSourceMessage {
  return {
    conversationId: "chn-1",
    actorId: HUB,
    actorName: "Openscout Agent 2",
    body: "hello",
    createdAt: T0,
    class: "agent",
    metadata: null,
    replyToMessageId: null,
    ...over,
  };
}

const FAN_OUT = [
  msg({ id: "m1", metadata: { relayTargetIds: [A] } }),
  msg({ id: "m2", actorId: A, actorName: "openscout-seneca-4", body: "[ask:f-a] done", createdAt: T0 + 1000, replyToMessageId: "m1", metadata: { relayTargetIds: [HUB] } }),
  msg({ id: "m3", createdAt: T0 + 2000, metadata: { relayTargetIds: [B] } }),
  msg({ id: "m4", createdAt: T0 + 3000, metadata: { relayTargetIds: [B] } }),
  msg({ id: "m5", actorId: B, actorName: "blink-handel-3", body: "[ask:f-b] done", createdAt: T0 + 4000, replyToMessageId: "m3", metadata: { relayTargetIds: [HUB] } }),
];

const actor = (id: string, over: Partial<CanvasActor> = {}): CanvasActor => ({
  id,
  short: id,
  kind: "agent",
  ...over,
});

const task = (id: string, waiterId: string, workerId: string, over: Partial<CanvasTask> = {}): CanvasTask => ({
  id,
  title: id,
  ms: 1000,
  abandoned: false,
  waiterId,
  workerId,
  ...over,
});

const pair = (from: string, to: string, count = 1): CanvasPair => ({ from, to, count });

describe("commsCanvasLayout — lanes are the ask chain, not the traffic", () => {
  test("depth is the longest path, so a node sits right of everyone who asked it", () => {
    // top asks mid, mid asks leaf, and top ALSO asks leaf directly. The leaf
    // belongs in lane 2 regardless, or the short edge would drag it left.
    const layout = commsCanvasLayout(
      [actor("top"), actor("mid"), actor("leaf")],
      [task("t1", "top", "mid"), task("t2", "mid", "leaf"), task("t3", "top", "leaf")],
      [pair("top", "mid"), pair("mid", "leaf"), pair("top", "leaf")],
      { mode: "ladder", order: "name" },
    );
    const lane = (id: string) => layout.nodes.find((node) => node.id === id)!.lane;
    expect(lane("top")).toBe(0);
    expect(lane("mid")).toBe(1);
    expect(lane("leaf")).toBe(2);
    expect(layout.lanes.map((l) => l.label)).toEqual(["Opened the work", "Passed it on", "Did the work"]);
  });

  test("a cycle still draws: nobody is ordered, so nobody is stranded", () => {
    const layout = commsCanvasLayout(
      [actor("a"), actor("b")],
      [task("t1", "a", "b"), task("t2", "b", "a")],
      [pair("a", "b")],
      { mode: "ladder", order: "name" },
    );
    expect(layout.nodes).toHaveLength(2);
    expect(layout.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);
  });

  test("an actor with no ask either way is seated by who it talks to, and says so", () => {
    const layout = commsCanvasLayout(
      [actor("top"), actor("worker"), actor("bystander")],
      [task("t1", "top", "worker")],
      [pair("top", "worker", 5), pair("top", "bystander", 2)],
      { mode: "ladder", order: "name" },
    );
    const bystander = layout.nodes.find((node) => node.id === "bystander")!;
    expect(bystander.lane).toBe(1);
    expect(bystander.inferred).toBe(true);
    expect(layout.nodes.find((node) => node.id === "worker")!.inferred).toBe(false);
  });

  test("vertical order is the axis the ring does not have", () => {
    const actors = [actor("top"), actor("slow"), actor("quick"), actor("lost")];
    const tasks = [
      task("t1", "top", "slow", { ms: 9000 }),
      task("t2", "top", "quick", { ms: 10 }),
      task("t3", "top", "lost", { ms: 50, abandoned: true }),
    ];
    const pairs = [pair("top", "slow"), pair("top", "quick", 40), pair("top", "lost")];
    const down = (order: "duration" | "outcome" | "volume") =>
      commsCanvasLayout(actors, tasks, pairs, { mode: "ladder", order })
        .nodes.filter((node) => node.lane === 1)
        .sort((a, b) => a.y - b.y)
        .map((node) => node.id);

    expect(down("duration")[0]).toBe("slow");
    // An ask that never came back outranks any duration, however long.
    expect(down("outcome")[0]).toBe("lost");
    expect(down("volume")[0]).toBe("quick");
  });
});

describe("commsCanvasLayout — the shelf bundles what would otherwise repeat", () => {
  const wide = () => {
    const workers = Array.from({ length: 12 }, (_, i) => `w${i}`);
    return {
      actors: [actor("top"), ...workers.map((id) => actor(id))],
      tasks: workers.map((id, i) => task(`t${i}`, "top", id, { abandoned: i < 3 })),
      pairs: workers.map((id) => pair("top", id, 2)),
    };
  };

  test("thirty identical edges carry one bit between them, so one is drawn and labelled", () => {
    const { actors, tasks, pairs } = wide();
    const layout = commsCanvasLayout(actors, tasks, pairs, { mode: "shelf", order: "name", shelfRows: 4 });
    expect(layout.edges).toHaveLength(0);
    expect(layout.trunks).toHaveLength(1);
    const trunk = layout.trunks[0]!;
    expect(trunk.tasks).toBe(12);
    expect(trunk.count).toBe(24);
    expect(trunk.abandoned).toBe(3);
  });

  test("asks are counted from the asks, never inferred from message pairs", () => {
    // Two asks ride one pair, and a third rode a route that produced no pair at
    // all. Counting work by traffic would report one ask, or two.
    const layout = commsCanvasLayout(
      [actor("top"), actor("w1"), actor("w2")],
      [task("t1", "top", "w1"), task("t2", "top", "w1"), task("t3", "top", "w2")],
      [pair("top", "w1", 7)],
      { mode: "shelf", order: "name", shelfRows: 9 },
    );
    const trunk = layout.trunks.find((t) => t.lane === 1)!;
    expect(trunk.tasks).toBe(3);
    expect(trunk.count).toBe(7);
  });

  test("a wrapped lane gets columns, and the bracket sits left of all of them", () => {
    const { actors, tasks, pairs } = wide();
    const layout = commsCanvasLayout(actors, tasks, pairs, { mode: "shelf", order: "name", shelfRows: 4 });
    const block = layout.nodes.filter((node) => node.lane === 1);
    expect(new Set(block.map((node) => node.col)).size).toBe(3);
    const leftmost = Math.min(...block.map((node) => node.x));
    expect(layout.trunks[0]!.bar.x).toBeLessThan(leftmost);
    // Rows never exceed what the caller allowed, so the drawing stays as tall
    // as it was measured for.
    expect(layout.height).toBe(CANVAS_METRICS.padY * 2 + 4 * CANVAS_METRICS.nodeH + 3 * CANVAS_METRICS.rowGap);
  });

  test("ladder mode draws every edge and never a trunk", () => {
    const { actors, tasks, pairs } = wide();
    const layout = commsCanvasLayout(actors, tasks, pairs, { mode: "ladder", order: "name" });
    expect(layout.trunks).toHaveLength(0);
    expect(layout.edges).toHaveLength(12);
    // Left to right, always: a tree drawn this way has no crossings to have.
    for (const edge of layout.edges) {
      const from = layout.nodes.find((node) => node.id === edge.from)!;
      const to = layout.nodes.find((node) => node.id === edge.to)!;
      expect(from.lane).toBeLessThan(to.lane);
    }
  });
});

describe("commsCanvasInputs — nobody is folded away, and a contradiction is not a fact", () => {
  test("pairs are counted uncapped, off the passes rather than the ring", () => {
    const { passes, flights } = buildCommsFlow(FAN_OUT);
    const input = commsCanvasInputs(passes, flights);
    expect(input.actors.map((a) => a.id).sort()).toEqual([A, B, HUB].sort());
    expect(input.pairs.find((p) => p.from === HUB && p.to === B)?.count).toBe(2);
    expect(input.tasks).toHaveLength(2);
  });

  test("a message to the whole conversation is counted, never drawn as pairs", () => {
    const { passes, flights } = buildCommsFlow([...FAN_OUT, msg({ id: "m6", body: "for the room", createdAt: T0 + 5000 })]);
    const input = commsCanvasInputs(passes, flights);
    expect(input.broadcasts).toBe(1);
    expect(input.pairs.every((p) => p.count > 0)).toBe(true);
  });

  test("an identity the record never once agrees with itself about is marked", () => {
    // Every message under the operator's name is classed as an agent's: an
    // agent handed out the work and the ask carried the operator's display
    // name through. Drawn as the record has it — and marked.
    const { passes, flights } = buildCommsFlow([
      msg({ id: "m0", actorId: "operator", actorName: "Arach", class: "agent", metadata: { relayTargetIds: [HUB] } }),
      ...FAN_OUT,
    ]);
    const input = commsCanvasInputs(passes, flights);
    expect(input.actors.find((a) => a.id === "operator")?.disputed).toBe(true);
    expect(input.misattributed).toBe(1);
    expect(input.actors.filter((a) => a.disputed)).toHaveLength(1);
  });

  test("an operator who did speak is never relabelled, however much else is agent-classed", () => {
    const { passes, flights } = buildCommsFlow([
      msg({ id: "m0", actorId: "operator", actorName: "Arach", class: "agent", metadata: { relayTargetIds: [HUB] } }),
      msg({ id: "m0b", actorId: "operator", actorName: "Arach", class: "user", createdAt: T0 + 10, metadata: { relayTargetIds: [HUB] } }),
      ...FAN_OUT,
    ]);
    const input = commsCanvasInputs(passes, flights);
    expect(input.actors.find((a) => a.id === "operator")?.disputed).toBe(false);
    expect(input.misattributed).toBe(0);
  });

  test("the roster states what ran a participant; nothing is inferred from a name", () => {
    const { passes, flights } = buildCommsFlow(FAN_OUT);
    const input = commsCanvasInputs(passes, flights, new Map([[A, { model: null, harness: "claude" }]]));
    expect(input.actors.find((a) => a.id === A)?.harness).toBe("claude");
    expect(input.actors.find((a) => a.id === B)?.harness).toBeNull();
  });
});

describe("commsCanvasScope — the branch through one participant", () => {
  const CROWD = {
    actors: ["me", "boss", "mine1", "mine2", "deep", "stranger", "theirs"].map((id) => actor(id)),
    tasks: [
      task("t1", "boss", "me"),
      task("t2", "me", "mine1"),
      task("t3", "me", "mine2"),
      task("t4", "mine2", "deep"),
      task("t5", "stranger", "theirs"),
    ],
    pairs: [pair("boss", "me"), pair("me", "mine1"), pair("me", "mine2"), pair("mine2", "deep"), pair("stranger", "theirs")],
  };

  test("keeps who asked me and everyone I asked, all the way down", () => {
    const scoped = commsCanvasScope(CROWD.actors, CROWD.tasks, CROWD.pairs, "me");
    expect(scoped.actors.map((a) => a.id).sort()).toEqual(["boss", "deep", "me", "mine1", "mine2"]);
    expect(scoped.setAside).toBe(2);
  });

  test("work this participant is not part of is left out entirely", () => {
    const scoped = commsCanvasScope(CROWD.actors, CROWD.tasks, CROWD.pairs, "me");
    expect(scoped.tasks.map((t) => t.id)).not.toContain("t5");
    expect(scoped.pairs.some((p) => p.from === "stranger")).toBe(false);
  });

  test("an actor with no ask on record is in nobody's tree", () => {
    const scoped = commsCanvasScope(
      [...CROWD.actors, actor("chatty")],
      CROWD.tasks,
      [...CROWD.pairs, pair("me", "chatty", 9)],
      "me",
    );
    expect(scoped.actors.map((a) => a.id)).not.toContain("chatty");
  });

  test("a root with no branch gets the window back, because one card is not a drawing", () => {
    const scoped = commsCanvasScope(CROWD.actors, CROWD.tasks, CROWD.pairs, "nobody");
    expect(scoped.actors).toHaveLength(CROWD.actors.length);
    expect(scoped.setAside).toBe(0);
  });
});

describe("canvasStep — the arrows have to mean something on a canvas", () => {
  // One opener handing work to four workers, with the workers' lane wrapped
  // into two columns of two. That is the shape the arrows have to cross.
  const actors = ["root", "w1", "w2", "w3", "w4"].map((id) => actor(id));
  const tasks = ["w1", "w2", "w3", "w4"].map((id, at) => task(`t${at}`, "root", id));
  const pairs = ["w1", "w2", "w3", "w4"].map((id) => pair("root", id));
  const layout = commsCanvasLayout(actors, tasks, pairs, { mode: "shelf", shelfRows: 2, order: "name" });
  const nodes = layout.nodes;
  const at = (id: string) => nodes.find((node) => node.id === id)!;

  test("the wrapped lane really is two columns, or this tests nothing", () => {
    expect(new Set(nodes.filter((node) => node.lane === 1).map((node) => node.col)).size).toBe(2);
  });

  test("up and down walk the column you are standing in", () => {
    const column = nodes
      .filter((node) => node.lane === 1 && node.col === 0)
      .sort((a, b) => a.y - b.y);
    expect(canvasStep(nodes, column[0]!.id, "down")).toBe(column[1]!.id);
    expect(canvasStep(nodes, column[1]!.id, "up")).toBe(column[0]!.id);
  });

  test("nothing wraps: an edge is an edge", () => {
    const column = nodes
      .filter((node) => node.lane === 1 && node.col === 0)
      .sort((a, b) => a.y - b.y);
    expect(canvasStep(nodes, column[0]!.id, "up")).toBeNull();
    expect(canvasStep(nodes, column[column.length - 1]!.id, "down")).toBeNull();
    expect(canvasStep(nodes, "root", "left")).toBeNull();
  });

  test("right crosses to the next column, not the next lane", () => {
    const first = nodes.find((node) => node.lane === 1 && node.col === 0)!;
    const next = canvasStep(nodes, first.id, "right");
    expect(at(next!).lane).toBe(1);
    expect(at(next!).col).toBe(1);
  });

  test("crossing lands on the card nearest the height you left", () => {
    const column = nodes
      .filter((node) => node.lane === 1 && node.col === 0)
      .sort((a, b) => a.y - b.y);
    const low = column[column.length - 1]!;
    const landed = at(canvasStep(nodes, low.id, "right")!);
    const target = nodes
      .filter((node) => node.lane === 1 && node.col === 1)
      .reduce((best, node) => (Math.abs(node.y - low.y) < Math.abs(best.y - low.y) ? node : best));
    expect(landed.id).toBe(target.id);
  });

  test("home and end go to the ends of the column, not of the drawing", () => {
    const column = nodes
      .filter((node) => node.lane === 1 && node.col === 1)
      .sort((a, b) => a.y - b.y);
    expect(canvasStep(nodes, column[column.length - 1]!.id, "first")).toBe(column[0]!.id);
    expect(canvasStep(nodes, column[0]!.id, "last")).toBe(column[column.length - 1]!.id);
  });

  test("with no cursor yet, the first press starts at the top left", () => {
    expect(canvasStep(nodes, null, "down")).toBe("root");
    expect(canvasStep(nodes, "someone-who-left", "right")).toBe("root");
  });

  test("an empty drawing has nowhere to go rather than throwing", () => {
    expect(canvasStep([], null, "down")).toBeNull();
  });
});
