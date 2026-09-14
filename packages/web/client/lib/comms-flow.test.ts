import { describe, expect, test } from "bun:test";
import {
  buildCommsFlow,
  flowActors,
  flowPasses,
  flowRecipients,
  flowShortLabel,
  type FlowSourceMessage,
} from "./comms-flow.ts";

const AGENT = "openscout-agent-2.codex-current-product-work.arts-mini";
/** The same agent as AGENT, seen without its project/host scope. */
const AGENT_ID = "openscout-agent-2";
const WORKER = "session-mtukun5n-90ua43";
const T0 = 1_788_987_304_494;

function msg(over: Partial<FlowSourceMessage> & { id: string }): FlowSourceMessage {
  return {
    conversationId: "chn-1",
    actorId: AGENT,
    actorName: "Openscout Agent 2",
    body: "hello",
    createdAt: T0,
    class: "agent",
    metadata: null,
    replyToMessageId: null,
    ...over,
  };
}

describe("flowRecipients", () => {
  const senders = new Map([["m-ask", AGENT]]);

  test("a relay names the exact recipients the sender typed, and outranks everything else", () => {
    const { ids, route } = flowRecipients(
      msg({ id: "m", metadata: { relayTargetIds: [WORKER], targetAgentId: "someone-else", targetSessionId: "s-1" } }),
      senders,
    );
    expect(ids).toEqual([WORKER]);
    expect(route).toBe("relayTargetIds");
  });

  test("session initiation routes to the session it started", () => {
    const { ids, route } = flowRecipients(msg({ id: "m", metadata: { targetSessionId: WORKER } }), senders);
    expect(ids).toEqual([WORKER]);
    expect(route).toBe("targetSessionId");
  });

  test("a broker status goes to the author of the message it answers, not the agent it names", () => {
    const { ids, route } = flowRecipients(
      msg({
        id: "m",
        actorId: "system",
        class: "status",
        replyToMessageId: "m-ask",
        metadata: { targetAgentId: WORKER },
      }),
      senders,
    );
    expect(ids).toEqual([AGENT]);
    expect(route).toBe("statusReplyAuthor");
  });

  test("a status with no answerable parent falls through to the agent it names", () => {
    const { ids, route } = flowRecipients(
      msg({ id: "m", actorId: "system", class: "status", metadata: { targetAgentId: WORKER } }),
      senders,
    );
    expect(ids).toEqual([WORKER]);
    expect(route).toBe("targetAgentId");
  });

  test("scoped @-targets are a route; a name in the body is not", () => {
    const scoped = flowRecipients(
      msg({ id: "m", body: `hey ${WORKER}`, metadata: { scopedTargets: [{ actorId: WORKER }] } }),
      senders,
    );
    expect(scoped.ids).toEqual([WORKER]);
    expect(scoped.route).toBe("scopedTargets");

    const prose = flowRecipients(msg({ id: "m", body: `hey ${WORKER}, take a look` }), senders);
    expect(prose.ids).toEqual([]);
    expect(prose.route).toBe("conversation");
  });
});

describe("flowActors", () => {
  test("the operator's two ids become one actor, so a chain through them stays one chain", () => {
    const actors = flowActors([
      msg({ id: "m1", actorId: "operator", actorName: "Arach" }),
      msg({ id: "m2", actorId: "Arach", actorName: "Arach" }),
      msg({ id: "m3" }),
    ]);
    const operator = actors.filter((a) => a.kind === "operator");
    expect(operator).toHaveLength(1);
    expect(operator[0]?.ids.sort()).toEqual(["Arach", "operator"]);
    expect(actors.map((a) => a.kind).filter((k) => k === "agent")).toHaveLength(1);
  });

  test("one agent seen with and without its project/host scope is one actor", () => {
    const scoped = `${WORKER}.codex-current-product-work.arts-mini`;
    const messages = [
      msg({ id: "m1", metadata: { relayTargetIds: [WORKER] } }),
      msg({ id: "m2", actorId: scoped, actorName: "Session Mtukun5n 90ua43", createdAt: T0 + 1000, metadata: { relayTargetIds: [AGENT] } }),
    ];
    const actors = flowActors(messages);
    const worker = actors.filter((a) => a.id === WORKER);
    expect(worker).toHaveLength(1);
    expect(worker[0]?.ids.sort()).toEqual([WORKER, scoped].sort());
    // And the pass from the scoped id still lands on that one actor.
    const passes = flowPasses(messages, actors);
    expect(passes.map((p) => p.from.id)).toEqual(["openscout-agent-2", WORKER]);
  });

  test("the broker is the broker, addressed ids that never spoke still get an actor", () => {
    const actors = flowActors([msg({ id: "m1", metadata: { relayTargetIds: [WORKER] } }), msg({ id: "m2", actorId: "system", actorName: "Broker", class: "status" })]);
    expect(actors.find((a) => a.id === "system")?.kind).toBe("broker");
    expect(actors.find((a) => a.id === "system")?.short).toBe("Broker");
    expect(actors.map((a) => a.id)).toContain(WORKER);
  });
});

describe("flowShortLabel", () => {
  test("reads as a name beside a rail, with the id chunks dropped", () => {
    expect(flowShortLabel(AGENT)).toBe("Agent 2");
    expect(flowShortLabel(WORKER)).toBe("Mtukun5n");
    expect(flowShortLabel(`${WORKER}.codex-current-product-work.arts-mini`)).toBe("Mtukun5n");
    // A real name in front of a uuid keeps the name and drops the uuid.
    expect(flowShortLabel("flat-claude-4fad8bb9-b4d3-4432-be75-8cfd636e78c0")).toBe("Flat Claude");
    // A bare uuid has no name to keep, so it keeps its first chunk over nothing.
    expect(flowShortLabel("90f0f340-34e7-42c1-b1b1-fff5b25d3d56")).toBe("90f0f340");
  });
});

describe("flowPasses", () => {
  test("a message with no target goes to the speakers of its conversation, not to everyone", () => {
    const messages = [
      msg({ id: "m1", conversationId: "chn-1", metadata: { relayTargetIds: [WORKER] } }),
      msg({ id: "m2", conversationId: "chn-1", actorId: WORKER, actorName: "Session Mtukun5n", createdAt: T0 + 1000 }),
      msg({ id: "m3", conversationId: "chn-2", actorId: "operator", actorName: "Arach", createdAt: T0 + 2000 }),
    ];
    const passes = flowPasses(messages, flowActors(messages));
    const channel = passes.find((p) => p.id === "m2");
    expect(channel?.kind).toBe("channel");
    // Arach only ever spoke in chn-2, so a chn-1 broadcast never reached them.
    expect(channel?.audience.map((a) => a.id)).toEqual([AGENT_ID]);
  });

  test("identical resends down the same route collapse; a changed body does not", () => {
    const messages = [
      msg({ id: "m1", metadata: { relayTargetIds: [WORKER] } }),
      msg({ id: "m2", createdAt: T0 + 30_000, metadata: { relayTargetIds: [WORKER] } }),
      msg({ id: "m3", createdAt: T0 + 60_000, body: "hello again", metadata: { relayTargetIds: [WORKER] } }),
      msg({ id: "m4", createdAt: T0 + 10 * 60_000, metadata: { relayTargetIds: [WORKER] } }),
    ];
    const passes = flowPasses(messages, flowActors(messages));
    expect(passes.map((p) => [p.id, p.count])).toEqual([["m1", 2], ["m3", 1], ["m4", 1]]);
  });

  test("passes carry the silence before them, in send order regardless of input order", () => {
    const messages = [
      msg({ id: "m2", createdAt: T0 + 120_000, metadata: { relayTargetIds: [WORKER] } }),
      msg({ id: "m1", body: "first", metadata: { relayTargetIds: [WORKER] } }),
    ];
    const passes = flowPasses(messages, flowActors(messages));
    expect(passes.map((p) => p.id)).toEqual(["m1", "m2"]);
    expect(passes[1]?.gap).toBe(120_000);
  });
});

describe("buildCommsFlow", () => {
  const messages = [
    msg({ id: "m-ask", metadata: { relayTargetIds: [WORKER] } }),
    msg({
      id: "m-timeout",
      actorId: "system",
      actorName: "Broker",
      class: "status",
      body: "openscout-faraday-4 failed to respond. The operation timed out.",
      createdAt: T0 + 85_000,
      replyToMessageId: "m-ask",
      metadata: { targetAgentId: AGENT },
    }),
    msg({
      id: "m-answer",
      actorId: WORKER,
      actorName: "Session Mtukun5n",
      body: "[ask:f-1] All three symptoms share one cause.",
      createdAt: T0 + 711_000,
      replyToMessageId: "m-ask",
      metadata: { relayTargetIds: [AGENT] },
    }),
  ];

  test("an ask and its answer become one flight, with the broker's give-up kept on it", () => {
    const { flights } = buildCommsFlow(messages);
    expect(flights).toHaveLength(1);
    const [flight] = flights;
    expect(flight?.askId).toBe("f-1");
    expect(flight?.waiter.id).toBe(AGENT_ID);
    expect(flight?.worker.id).toBe(WORKER);
    expect(flight?.answer.at - flight!.opener.at).toBe(711_000);
    // The broker gave up long before the session actually answered.
    expect(flight?.timedOutAt).toBe(T0 + 85_000);
  });

  test("an ask still out has no flight — the wait is the point, not a missing answer", () => {
    const { flights, passes } = buildCommsFlow(messages.slice(0, 2));
    expect(flights).toEqual([]);
    expect(passes.map((p) => p.kind)).toEqual(["message", "status"]);
  });

  test("only the operator's side reads as inbound", () => {
    const { passes } = buildCommsFlow([
      ...messages,
      msg({ id: "m-op", actorId: "operator", actorName: "Arach", createdAt: T0 + 900_000, metadata: { relayTargetIds: [AGENT] } }),
      msg({ id: "m-back", body: "[ask:f-2] latest", createdAt: T0 + 1_000_000, replyToMessageId: "m-op", metadata: { relayTargetIds: ["operator"] } }),
    ]);
    expect(passes.find((p) => p.id === "m-back")?.inbound).toBe(true);
    expect(passes.find((p) => p.id === "m-ask")?.inbound).toBe(false);
  });
});

describe("agent and session as one participant", () => {
  // The real shape: the operator addresses the session that will run the work,
  // the agent answers under its own id, and the reply states both plus a flight.
  const ASK = msg({
    id: "m-ask",
    actorId: "operator",
    actorName: "Arach",
    body: "Who did we ask to implement search?",
    metadata: { source: "scout-web", targetSessionId: "session-mtwcc5kt-t744aq" },
  });
  const REPLY = msg({
    id: "m-reply",
    actorId: "scoutbot",
    actorName: "Scout",
    body: "I can't verify the broker history from this session.",
    createdAt: T0 + 13_000,
    metadata: {
      flightId: "flt-mtwcc5jz-m1w3qs",
      requestedBy: "operator",
      sourceMessageId: "m-ask",
      returnAddress: { actorId: "scoutbot", sessionId: "session-mtwcc5kt-t744aq" },
      requestedReturnAddress: { actorId: "operator" },
      responderSessionId: "session-mtwcc5kt-t744aq",
    },
  });

  test("a session addressed by the operator resolves to the agent running it", () => {
    const { actors, passes } = buildCommsFlow([ASK, REPLY]);
    expect(actors.map((a) => a.id).sort()).toEqual(["operator", "scoutbot"]);
    expect(passes.find((p) => p.id === "m-ask")?.audience.map((a) => a.id)).toEqual(["scoutbot"]);
    expect(passes.find((p) => p.id === "m-ask")?.route).toBe("targetSessionId");
  });

  test("an answer goes where its return address says, not to the session that ran it", () => {
    const { passes } = buildCommsFlow([ASK, REPLY]);
    const reply = passes.find((p) => p.id === "m-reply");
    expect(reply?.audience.map((a) => a.id)).toEqual(["operator"]);
    expect(reply?.route).toBe("returnAddress");
    // And it reads as inbound, because it landed on the operator.
    expect(reply?.inbound).toBe(true);
  });

  test("the broker's own flight id pairs the ask without parsing the body", () => {
    const { flights } = buildCommsFlow([ASK, REPLY]);
    expect(flights).toHaveLength(1);
    expect(flights[0]?.askId).toBe("flt-mtwcc5jz-m1w3qs");
    expect(flights[0]?.waiter.id).toBe("operator");
    expect(flights[0]?.worker.id).toBe("scoutbot");
    expect(flights[0]?.opener.id).toBe("m-ask");
  });
});

describe("a name the data states beats one derived from an id", () => {
  const room = (rows: [string, string, string][]) =>
    flowActors(
      rows.map(([id, actorId, actorName]) => ({
        id,
        conversationId: "chn-1",
        actorId,
        actorName,
        body: "hi",
        createdAt: 1,
        class: "agent",
        metadata: null,
        replyToMessageId: null,
      })),
    );

  test("a session is labelled by its display name, not by its id", () => {
    // `session-mszm5fro-elspoj` named `openscout-seneca-4` was drawing as
    // "Mszm5fro": the only handle a person could say out loud, thrown away.
    const [actor] = room([["m1", "session-mszm5fro-elspoj", "openscout-seneca-4"]]);
    expect(actor?.short).toBe("Seneca 4");
  });

  test("the project prefix goes only while every label stays distinct", () => {
    const actors = room([
      ["m1", "session-a", "openscout-pauli-3"],
      ["m2", "session-b", "blink-pauli-4"],
      ["m3", "session-c", "blink-hypatia-6"],
    ]);
    const shorts = actors.map((a) => a.short);
    expect(shorts).toEqual(["Pauli 3", "Pauli 4", "Hypatia 6"]);
  });

  test("same person, same number, different project keeps the project", () => {
    const actors = room([
      ["m1", "session-a", "openscout-pauli-3"],
      ["m2", "session-b", "blink-pauli-3"],
    ]);
    expect(actors.map((a) => a.short)).toEqual(["Openscout Pauli 3", "Blink Pauli 3"]);
  });

  test("no stated name still falls back to a handle from the id", () => {
    const [actor] = room([["m1", "session-mszm5fro-elspoj", "session-mszm5fro-elspoj"]]);
    expect(actor?.short).toBe("Mszm5fro");
  });
});

describe("who did the work, when the broker is the one who answers", () => {
  // The real shape: Agent 2 asks a worker, the worker never replies, and the
  // broker closes the ask with a timeout. Reading the worker off the answer
  // credits the broker with a job it only reported on.
  const flow = buildCommsFlow([
    msg({
      id: "m-ask",
      body: "Diagnose the recording bug",
      metadata: { relayTargetIds: [WORKER] },
    }),
    msg({
      id: "m-timeout",
      actorId: "system",
      actorName: "Broker",
      class: "status",
      body: "action-orwell-5 failed to respond. The operation timed out.",
      createdAt: T0 + 47_000,
      replyToMessageId: "m-ask",
      metadata: { flightId: "f-1" },
    }),
  ]);

  test("the worker is who was asked, not who answered", () => {
    expect(flow.flights).toHaveLength(1);
    expect(flow.flights[0]!.worker.id).toBe(WORKER);
    expect(flow.flights[0]!.waiter.id).toBe(AGENT_ID);
  });

  test("the answerer still wins whenever they were the one asked", () => {
    const answered = buildCommsFlow([
      msg({ id: "m-ask", body: "Do the thing", metadata: { relayTargetIds: [WORKER] } }),
      msg({
        id: "m-answer",
        actorId: WORKER,
        actorName: "Session Mtukun5n",
        body: "Done.",
        createdAt: T0 + 9_000,
        replyToMessageId: "m-ask",
        metadata: { flightId: "f-2", relayTargetIds: [AGENT] },
      }),
    ]);
    expect(answered.flights[0]!.worker.id).toBe(WORKER);
  });
});
