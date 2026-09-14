import { describe, expect, test } from "bun:test";
import { buildCommsFlow, type FlowSourceMessage } from "../../lib/comms-flow.ts";
import { MAP_METRICS, OTHERS_ID, commsFlowMapLayout, commsFlowMapPairs, flowTasks } from "./comms-flow-map.ts";

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

const flowsOf = (source: FlowSourceMessage[]) => buildCommsFlow(source);

const FAN_OUT = [
  msg({ id: "m1", metadata: { relayTargetIds: [A] } }),
  msg({ id: "m2", actorId: A, actorName: "openscout-seneca-4", body: "[ask:f-a] done", createdAt: T0 + 1000, replyToMessageId: "m1", metadata: { relayTargetIds: [HUB] } }),
  msg({ id: "m3", createdAt: T0 + 2000, metadata: { relayTargetIds: [B] } }),
  msg({ id: "m4", createdAt: T0 + 3000, metadata: { relayTargetIds: [B] } }),
  msg({ id: "m5", actorId: B, actorName: "blink-handel-3", body: "[ask:f-b] done", createdAt: T0 + 4000, replyToMessageId: "m3", metadata: { relayTargetIds: [HUB] } }),
];

describe("commsFlowMapLayout", () => {
  test("the busiest participant is the hub and the rest ring it", () => {
    const { passes } = buildCommsFlow(FAN_OUT);
    const layout = commsFlowMapLayout(passes);
    const hub = layout.nodes.find((n) => n.hub);
    expect(hub?.actor.id).toBe(HUB);
    expect(layout.nodes.filter((n) => !n.hub)).toHaveLength(2);
    expect(new Set(layout.nodes.map((n) => `${n.x},${n.y}`)).size).toBe(3);
  });

  test("traffic aggregates per ordered pair and weights the stroke", () => {
    const { passes } = buildCommsFlow(FAN_OUT);
    const layout = commsFlowMapLayout(passes);
    const out = layout.edges.find((e) => e.from === HUB && e.to === B);
    const back = layout.edges.find((e) => e.from === B && e.to === HUB);
    expect(out?.count).toBe(2);
    expect(back?.count).toBe(1);
    // Both directions exist as their own edge, bowed off opposite sides.
    expect(out?.d).not.toBe(back?.d);
    expect(out!.weight).toBeGreaterThan(back!.weight);
  });

  test("a message to the whole conversation is counted, not drawn as pairs", () => {
    // Ten listeners would otherwise become ten edges from one broadcast.
    const { passes } = buildCommsFlow([...FAN_OUT, msg({ id: "m6", body: "for the room", createdAt: T0 + 5000 })]);
    const layout = commsFlowMapLayout(passes);
    expect(layout.broadcasts).toBe(1);
    expect(layout.edges.some((e) => e.count > 2)).toBe(false);
  });

  test("a model is shown only where the roster states one", () => {
    const { passes } = buildCommsFlow(FAN_OUT);
    const layout = commsFlowMapLayout(
      passes,
      new Map([[A, { model: "claude-opus-5" }], [HUB, { model: "  " }]]),
    );
    expect(layout.nodes.find((n) => n.id === A)?.model).toBe("claude-opus-5");
    expect(layout.nodes.find((n) => n.id === HUB)?.model).toBeNull();
    expect(layout.modelsKnown).toBe(1);
  });

  test("the pair list is the edges, busiest first", () => {
    const { passes } = buildCommsFlow(FAN_OUT);
    const pairs = commsFlowMapPairs(commsFlowMapLayout(passes));
    expect(pairs[0]?.count).toBe(2);
    expect(pairs.map((p) => p.count)).toEqual([...pairs.map((p) => p.count)].sort((a, b) => b - a));
  });

  test("an empty window draws nothing", () => {
    const layout = commsFlowMapLayout([]);
    expect(layout.nodes).toHaveLength(0);
    expect(layout.edges).toHaveLength(0);
  });
});

describe("flowTasks", () => {
  test("a task is one ask that came back, titled by what was asked", () => {
    const { passes, flights } = buildCommsFlow([
      msg({ id: "m1", body: "**SLICE 2 AUTHORIZED** — the spatial surface itself\nmore detail", metadata: { relayTargetIds: [A] } }),
      msg({ id: "m2", actorId: A, body: "[ask:f-a] landed", createdAt: T0 + 630_000, replyToMessageId: "m1", metadata: { relayTargetIds: [HUB] } }),
    ]);
    const [task] = flowTasks(passes, flights);
    expect(task?.title).toBe("SLICE 2 AUTHORIZED — the spatial surface itself");
    expect(task?.worker.id).toBe(A);
    expect(task?.waiter.id).toBe(HUB);
    expect(task?.ms).toBe(630_000);
    expect(task?.passes.map((p) => p.message.id)).toEqual(["m1", "m2"]);
  });

  test("a task holds only its own branch, not whatever else was in flight", () => {
    // The reason scoping is worth having: two delegations overlap in time, and
    // one task must not sweep up the other's messages just for being concurrent.
    const { passes, flights } = flowsOf(FAN_OUT);
    const tasks = flowTasks(passes, flights);
    const forB = tasks.find((t) => t.worker.id === B);
    expect(forB?.passes.every((p) => p.from.id === HUB || p.from.id === B)).toBe(true);
    expect(forB?.passes.some((p) => p.from.id === A)).toBe(false);
  });

  test("tasks come in the order the work was handed out", () => {
    const { passes, flights } = flowsOf(FAN_OUT);
    const tasks = flowTasks(passes, flights);
    expect(tasks.map((t) => t.worker.id)).toEqual([A, B]);
    expect(tasks[0]!.at).toBeLessThan(tasks[1]!.at);
  });

  test("scoping the map to a task leaves the pair and nobody else", () => {
    const { passes, flights } = flowsOf(FAN_OUT);
    const task = flowTasks(passes, flights).find((t) => t.worker.id === B)!;
    const layout = commsFlowMapLayout(task.passes);
    expect(new Set(layout.nodes.map((n) => n.id))).toEqual(new Set([HUB, B]));
  });
});

describe("a neighbourhood bigger than the ring", () => {
  test("the busiest are kept and the tail folds into one counted node", () => {
    // An agent-scoped window runs to hundreds of participants; a ring of
    // hundreds says less than a sentence would.
    const many: FlowSourceMessage[] = [];
    for (let i = 0; i < 20; i += 1) {
      const worker = `session-w${i}-1`;
      many.push(msg({ id: `ask-${i}`, createdAt: T0 + i * 2000, metadata: { relayTargetIds: [worker] } }));
      many.push(msg({
        id: `ans-${i}`,
        actorId: worker,
        body: `[ask:f-${i}] done`,
        createdAt: T0 + i * 2000 + 500,
        replyToMessageId: `ask-${i}`,
        metadata: { relayTargetIds: [HUB] },
      }));
    }
    const { passes } = buildCommsFlow(many);
    const layout = commsFlowMapLayout(passes);
    expect(layout.nodes).toHaveLength(MAP_METRICS.maxNodes + 1);
    const others = layout.nodes.find((n) => n.id === OTHERS_ID);
    expect(others?.actor.short).toBe(`${21 - MAP_METRICS.maxNodes} others`);
    // Every message still lands somewhere: nothing is dropped by folding.
    const drawn = layout.edges.reduce((sum, edge) => sum + edge.count, 0);
    const directed = passes.filter((p) => p.kind !== "channel").length;
    expect(drawn).toBe(directed);
  });

  test("a small window folds nothing", () => {
    const { passes } = flowsOf(FAN_OUT);
    const layout = commsFlowMapLayout(passes);
    expect(layout.nodes.some((n) => n.id === OTHERS_ID)).toBe(false);
  });
});
