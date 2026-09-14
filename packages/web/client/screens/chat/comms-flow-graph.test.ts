import { describe, expect, test } from "bun:test";
import { buildCommsFlow, type FlowSourceMessage } from "../../lib/comms-flow.ts";
import { GRAPH_METRICS, commsFlowGraphLayout, type GraphRow } from "./comms-flow-graph.ts";

const ASKER = "openscout-agent-2";
const WORKER = "session-mtukun5n-90ua43";
const OTHER = "session-other-1";
const T0 = 1_788_987_304_494;

function msg(over: Partial<FlowSourceMessage> & { id: string }): FlowSourceMessage {
  return {
    conversationId: "chn-1",
    actorId: ASKER,
    actorName: "Openscout Agent 2",
    body: "hello",
    createdAt: T0,
    class: "agent",
    metadata: null,
    replyToMessageId: null,
    ...over,
  };
}

const passRows = (rows: GraphRow[]) => rows.filter((r): r is Extract<GraphRow, { kind: "pass" }> => r.kind === "pass");
const columnOf = (rows: GraphRow[], id: string) => passRows(rows).find((r) => r.pass.id === id)?.column;

/** Ask → answer, with the worker on a branch of its own. */
const DELEGATION = [
  msg({ id: "m-ask", metadata: { relayTargetIds: [WORKER] } }),
  msg({
    id: "m-answer",
    actorId: WORKER,
    actorName: "Session Mtukun5n",
    body: "[ask:f-1] done",
    createdAt: T0 + 700_000,
    replyToMessageId: "m-ask",
    metadata: { relayTargetIds: [ASKER] },
  }),
];

describe("commsFlowGraphLayout", () => {
  test("the asker is the trunk and the worker forks onto a rail of its own", () => {
    const { passes, flights } = buildCommsFlow(DELEGATION);
    const layout = commsFlowGraphLayout(passes, flights);
    expect(columnOf(layout.rows, "m-ask")).toBe(0);
    expect(columnOf(layout.rows, "m-answer")).toBe(1);
    expect(layout.edges.filter((e) => !e.merge)).toHaveLength(1);
    expect(layout.edges.filter((e) => e.merge)).toHaveLength(1);
  });

  test("two delegations that overlap in time get a rail each", () => {
    // The regression a two-party thread can never show: an orchestrator hands
    // work to one partner, and hands more to a second before the first answers.
    // Claiming a column only when a worker replies left it free in between, so
    // both branches landed on the same rail and the fan-out vanished.
    const { passes, flights } = buildCommsFlow([
      msg({ id: "m-ask-a", metadata: { relayTargetIds: [WORKER] } }),
      msg({ id: "m-ask-b", createdAt: T0 + 60_000, metadata: { relayTargetIds: [OTHER] } }),
      msg({
        id: "m-answer-b",
        actorId: OTHER,
        body: "[ask:f-b] b done",
        createdAt: T0 + 120_000,
        replyToMessageId: "m-ask-b",
        metadata: { relayTargetIds: [ASKER] },
      }),
      msg({
        id: "m-answer-a",
        actorId: WORKER,
        body: "[ask:f-a] a done",
        createdAt: T0 + 180_000,
        replyToMessageId: "m-ask-a",
        metadata: { relayTargetIds: [ASKER] },
      }),
    ]);
    const layout = commsFlowGraphLayout(passes, flights);
    expect(columnOf(layout.rows, "m-ask-a")).toBe(0);
    expect(layout.columns).toBe(3);
    const a = columnOf(layout.rows, "m-answer-a");
    const b = columnOf(layout.rows, "m-answer-b");
    expect(a).not.toBe(b);
    expect(new Set([a, b])).toEqual(new Set([1, 2]));
  });

  test("a message to the whole conversation forks no branches", () => {
    // Every listener would otherwise claim a column, and one broadcast to a
    // room of ten would open ten rails that were never given any work.
    const { passes, flights } = buildCommsFlow([
      msg({ id: "m-ask", metadata: { relayTargetIds: [WORKER] } }),
      msg({
        id: "m-answer",
        actorId: WORKER,
        body: "[ask:f-1] done",
        createdAt: T0 + 60_000,
        replyToMessageId: "m-ask",
        metadata: { relayTargetIds: [ASKER] },
      }),
      msg({ id: "m-all", body: "status for the room", createdAt: T0 + 120_000 }),
    ]);
    const layout = commsFlowGraphLayout(passes, flights);
    expect(passes.find((p) => p.message.id === "m-all")?.kind).toBe("channel");
    expect(layout.columns).toBe(2);
  });

  test("the worker's rail opens at the ask, not at its first reply — the wait is on it", () => {
    const { passes, flights } = buildCommsFlow(DELEGATION);
    const layout = commsFlowGraphLayout(passes, flights);
    const rail = layout.rails.find((r) => r.actor.id === WORKER);
    const askRow = passRows(layout.rows).find((r) => r.pass.id === "m-ask");
    expect(rail?.y0).toBe(askRow!.y);
    const [span] = layout.spans;
    expect(span?.y0).toBe(askRow!.y);
    expect(span?.column).toBe(1);
  });

  test("a waiter's rail stays open past its last message so the answer has something to land on", () => {
    // The operator asks and then says nothing more; the answer arrives later.
    const { passes, flights } = buildCommsFlow([
      msg({ id: "m-ask", actorId: "operator", actorName: "Arach", metadata: { relayTargetIds: [WORKER] } }),
      msg({
        id: "m-answer",
        actorId: WORKER,
        actorName: "Session Mtukun5n",
        body: "[ask:f-1] done",
        createdAt: T0 + 120_000,
        replyToMessageId: "m-ask",
        metadata: { relayTargetIds: ["operator"] },
      }),
    ]);
    const layout = commsFlowGraphLayout(passes, flights);
    const answerRow = passRows(layout.rows).find((r) => r.pass.id === "m-answer")!;
    const waiter = layout.rails.find((r) => r.actor.kind === "operator")!;
    expect(waiter.y1).toBe(answerRow.y + GRAPH_METRICS.merge);
    const merge = layout.edges.find((e) => e.merge)!;
    // The merge lands on the waiter's column, not on a column since recycled.
    expect(merge.d.endsWith(`${GRAPH_METRICS.gutter + waiter.column * GRAPH_METRICS.column} ${waiter.y1}`)).toBe(true);
  });

  test("a closed rail hands its column back rather than widening the gutter forever", () => {
    const { passes, flights } = buildCommsFlow([
      ...DELEGATION,
      // A second delegation, long after the first worker has finished.
      msg({ id: "m-ask2", createdAt: T0 + 800_000, metadata: { relayTargetIds: [OTHER] } }),
      msg({
        id: "m-answer2",
        actorId: OTHER,
        actorName: "Session Other",
        body: "[ask:f-2] done too",
        createdAt: T0 + 900_000,
        replyToMessageId: "m-ask2",
        metadata: { relayTargetIds: [ASKER] },
      }),
    ]);
    const layout = commsFlowGraphLayout(passes, flights);
    expect(layout.columns).toBe(2);
    expect(columnOf(layout.rows, "m-answer2")).toBe(1);
  });

  test("silence folds into a quiet row and the rails carry straight through it", () => {
    const { passes, flights } = buildCommsFlow(DELEGATION);
    const layout = commsFlowGraphLayout(passes, flights);
    const quiet = layout.rows.filter((r) => r.kind === "quiet");
    expect(quiet).toHaveLength(1);
    expect(quiet[0]).toMatchObject({ ms: 700_000 });
    const trunk = layout.rails.find((r) => r.actor.id === ASKER)!;
    const answerRow = passRows(layout.rows).find((r) => r.pass.id === "m-answer")!;
    expect(trunk.y1).toBeGreaterThan(answerRow.y);
  });

  test("a broker give-up is marked on the branch that was still out", () => {
    const { passes, flights } = buildCommsFlow([
      DELEGATION[0]!,
      msg({
        id: "m-timeout",
        actorId: "system",
        actorName: "Broker",
        class: "status",
        body: "failed to respond. The operation timed out.",
        createdAt: T0 + 85_000,
        replyToMessageId: "m-ask",
        metadata: { targetAgentId: WORKER },
      }),
      DELEGATION[1]!,
    ]);
    const layout = commsFlowGraphLayout(passes, flights);
    const [span] = layout.spans;
    expect(span?.timeoutY).toBe(passRows(layout.rows).find((r) => r.pass.id === "m-timeout")!.y);
    expect(span?.flight.timedOutAt).toBe(T0 + 85_000);
  });

  test("an answer on the asker's own rail is the next commit, not a merge", () => {
    // Both messages come from the same actor, so there is nothing to merge.
    const { passes, flights } = buildCommsFlow([
      msg({ id: "m-ask", metadata: { relayTargetIds: [WORKER] } }),
      msg({ id: "m-self", body: "[ask:f-1] answering myself", createdAt: T0 + 1000, replyToMessageId: "m-ask", metadata: { relayTargetIds: [WORKER] } }),
    ]);
    const layout = commsFlowGraphLayout(passes, flights);
    expect(layout.edges.filter((e) => e.merge)).toHaveLength(0);
  });

  test("an empty window lays out to nothing rather than throwing", () => {
    const layout = commsFlowGraphLayout([], []);
    expect(layout.rows).toEqual([]);
    expect(layout.columns).toBe(1);
  });
});
