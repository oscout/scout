import { describe, expect, test } from "bun:test";
import type { BrokerRouteAttempt, Flight, FollowTarget, Message } from "../../lib/types.ts";
import {
  dispatchFlightOutcome,
  dispatchFollowQuery,
  dispatchOutcomeLinks,
  formatDispatchDuration,
  formatDispatchGap,
  resolveDispatchAftermath,
} from "./dispatch-aftermath.ts";

function attempt(overrides: Partial<BrokerRouteAttempt> = {}): BrokerRouteAttempt {
  return {
    id: "message:msg-1",
    kind: "success",
    status: "sent",
    ts: 1_000,
    actorName: "Arach",
    target: "worker",
    route: "dm",
    detail: "do the thing",
    conversationId: "chn-1",
    messageId: "msg-1",
    deliveryId: null,
    invocationId: null,
    ...overrides,
  };
}

function message(overrides: Partial<Message> & { id: string; createdAt: number }): Message {
  return {
    conversationId: "chn-1",
    actorName: "worker",
    body: "on it",
    class: "agent",
    ...overrides,
  };
}

function followTarget(overrides: Partial<FollowTarget> = {}): FollowTarget {
  return {
    flightId: null,
    invocationId: null,
    conversationId: null,
    workId: null,
    sessionId: null,
    targetAgentId: null,
    ...overrides,
  };
}

describe("resolveDispatchAftermath", () => {
  test("reports the replies that followed the dispatched message", () => {
    const result = resolveDispatchAftermath(attempt(), [
      message({ id: "msg-0", createdAt: 500, actorName: "Arach", body: "earlier" }),
      message({ id: "msg-1", createdAt: 1_000, actorName: "Arach", body: "do the thing" }),
      message({ id: "msg-2", createdAt: 61_000, replyToMessageId: "msg-1" }),
      message({ id: "msg-3", createdAt: 62_000, body: "done" }),
    ]);

    expect(result.status).toBe("replies");
    if (result.status !== "replies") return;
    expect(result.replies.map((reply) => reply.id)).toEqual(["msg-2", "msg-3"]);
    expect(result.replies[0]!.answersDispatch).toBe(true);
    expect(result.replies[1]!.answersDispatch).toBe(false);
    expect(result.replies[0]!.afterMs).toBe(60_000);
    expect(result.more).toBe(0);
  });

  test("counts replies beyond the shown ones instead of dropping them", () => {
    const result = resolveDispatchAftermath(attempt(), [
      message({ id: "msg-1", createdAt: 1_000 }),
      message({ id: "a", createdAt: 2_000 }),
      message({ id: "b", createdAt: 3_000 }),
      message({ id: "c", createdAt: 4_000 }),
      message({ id: "d", createdAt: 5_000 }),
      message({ id: "e", createdAt: 6_000 }),
    ]);

    expect(result.status).toBe("replies");
    if (result.status !== "replies") return;
    expect(result.replies).toHaveLength(3);
    expect(result.more).toBe(2);
  });

  test("orders an unsorted page before reading what came next", () => {
    const result = resolveDispatchAftermath(attempt(), [
      message({ id: "msg-2", createdAt: 5_000, body: "later" }),
      message({ id: "msg-1", createdAt: 1_000, body: "do the thing" }),
      message({ id: "msg-0", createdAt: 100, body: "earlier" }),
    ]);

    expect(result.status).toBe("replies");
    if (result.status !== "replies") return;
    expect(result.replies.map((reply) => reply.id)).toEqual(["msg-2"]);
  });

  test("says nothing followed when the dispatch is the last message", () => {
    const result = resolveDispatchAftermath(attempt(), [
      message({ id: "msg-0", createdAt: 500 }),
      message({ id: "msg-1", createdAt: 1_000 }),
    ]);
    expect(result.status).toBe("no-reply");
  });

  test("flags a dispatch older than the loaded transcript page", () => {
    const result = resolveDispatchAftermath(attempt({ ts: 1_000 }), [
      message({ id: "msg-90", createdAt: 90_000 }),
      message({ id: "msg-91", createdAt: 91_000 }),
    ]);
    expect(result.status).toBe("beyond-page");
  });

  test("falls back to the timestamp when the row id is not a transcript id", () => {
    // Feed rows can merge a send with its delivery failure and keep the send's
    // id, so the anchor lookup must not be the only way to find the aftermath.
    const result = resolveDispatchAftermath(
      attempt({ messageId: "msg-synthesized", ts: 1_000 }),
      [
        message({ id: "msg-0", createdAt: 500 }),
        message({ id: "msg-2", createdAt: 2_000, body: "reply" }),
      ],
    );

    expect(result.status).toBe("replies");
    if (result.status !== "replies") return;
    expect(result.replies.map((reply) => reply.id)).toEqual(["msg-2"]);
  });

  test("never lists the anchor itself, whatever its stamp", () => {
    // The route attempt and the message row are stamped by different clocks,
    // so the dispatch's own row can sit at or after `attempt.ts`.
    const result = resolveDispatchAftermath(
      attempt({ messageId: "msg-1", ts: 1_000 }),
      [
        message({ id: "msg-0", createdAt: 900 }),
        message({ id: "msg-1", createdAt: 1_002, actorName: "Arach", body: "do the thing" }),
        message({ id: "msg-2", createdAt: 2_000, body: "on it" }),
      ],
    );

    expect(result.status).toBe("replies");
    if (result.status !== "replies") return;
    expect(result.replies.map((reply) => reply.id)).toEqual(["msg-2"]);
  });

  // `/api/messages` answers from two sources with opposite orders: the broker
  // projection ascending, the SQLite fallback `created_at DESC, id DESC`. A
  // same-millisecond reply must survive both, so each ordering is asserted.
  for (const [label, page] of [
    ["ascending source", [
      message({ id: "msg-1", createdAt: 1_000, actorName: "Arach", body: "do the thing" }),
      message({ id: "msg-2", createdAt: 1_000, body: "instant" }),
    ]],
    ["descending source", [
      message({ id: "msg-2", createdAt: 1_000, body: "instant" }),
      message({ id: "msg-1", createdAt: 1_000, actorName: "Arach", body: "do the thing" }),
    ]],
    // `id ASC` puts the reply first when its id sorts below the anchor's, so
    // the ascending source can bury a same-ms reply too — not just the
    // descending one. This is the case a positional cut misses even on the
    // source whose order looks safe.
    ["ascending source, reply id sorts below the anchor", [
      message({ id: "msg-a", createdAt: 1_000, body: "instant" }),
      message({ id: "msg-z", createdAt: 1_000, actorName: "Arach", body: "do the thing" }),
    ]],
  ] as const) {
    test(`keeps a same-millisecond reply from the ${label}`, () => {
      const anchorId = label.includes("sorts below") ? "msg-z" : "msg-1";
      const replyId = label.includes("sorts below") ? "msg-a" : "msg-2";
      const result = resolveDispatchAftermath(
        attempt({ messageId: anchorId, ts: 1_000 }),
        [...page],
      );

      expect(result.status).toBe("replies");
      if (result.status !== "replies") return;
      expect(result.replies.map((reply) => reply.id)).toEqual([replyId]);
    });
  }

  test("measures the gap from the anchor message, not the route attempt", () => {
    const result = resolveDispatchAftermath(
      attempt({ messageId: "msg-1", ts: 1_000 }),
      [
        message({ id: "msg-1", createdAt: 3_000, actorName: "Arach", body: "do the thing" }),
        message({ id: "msg-2", createdAt: 63_000, body: "on it" }),
      ],
    );

    expect(result.status).toBe("replies");
    if (result.status !== "replies") return;
    expect(result.replies[0]!.afterMs).toBe(60_000);
  });

  test("has nothing to follow without a conversation", () => {
    expect(resolveDispatchAftermath(attempt({ conversationId: null }), []).status)
      .toBe("no-conversation");
  });

  test("an empty transcript is silence, not an unread thread", () => {
    // The unreadable case is the caller's to report — reaching here means the
    // page was read. Returning "no-reply" for an empty read must stay distinct
    // from the "unavailable" the fetch layer sets when it never got a page.
    expect(resolveDispatchAftermath(attempt(), []).status).toBe("no-reply");
  });
});

describe("dispatchFollowQuery", () => {
  test("sends every id the row carries", () => {
    const query = dispatchFollowQuery(
      attempt({ invocationId: "inv-1", conversationId: "chn-1" }),
      "agent-9",
    );
    expect(query?.get("invocationId")).toBe("inv-1");
    expect(query?.get("conversationId")).toBe("chn-1");
    expect(query?.get("targetAgentId")).toBe("agent-9");
  });

  test("reads ids nested under raw metadata", () => {
    const query = dispatchFollowQuery(
      attempt({
        conversationId: null,
        metadata: { raw: { flightId: "flt-7", collaborationRecordId: "wk-3" } },
      }),
      null,
    );
    expect(query?.get("flightId")).toBe("flt-7");
    expect(query?.get("workId")).toBe("wk-3");
  });

  test("is null when the row carries nothing to resolve", () => {
    expect(dispatchFollowQuery(attempt({ conversationId: null }), null)).toBeNull();
  });
});

describe("dispatchOutcomeLinks", () => {
  test("omits destinations whose id did not resolve", () => {
    const links = dispatchOutcomeLinks(followTarget({ conversationId: "chn-1" }));
    expect(links.map((link) => link.key)).toEqual(["conversation", "tail"]);
  });

  test("offers the full set once a flight resolves", () => {
    const links = dispatchOutcomeLinks(followTarget({
      conversationId: "chn-1",
      flightId: "flt-1",
      sessionId: "ses-1",
      workId: "wk-1",
      targetAgentId: "agent-1",
    }));
    expect(links.map((link) => link.key))
      .toEqual(["conversation", "trace", "work", "agent", "tail"]);
    expect(links[1]!.route).toMatchObject({
      view: "sessions",
      flightId: "flt-1",
      sessionId: "ses-1",
      agentId: "agent-1",
    });
  });

  test("offers nothing rather than a dead link when nothing resolved", () => {
    expect(dispatchOutcomeLinks(followTarget())).toEqual([]);
  });

  test("drops the work link on a native host that cannot open one", () => {
    const target = followTarget({ conversationId: "chn-1", workId: "wk-1" });
    expect(dispatchOutcomeLinks(target, { nativeHost: true }).map((link) => link.key))
      .toEqual(["conversation", "tail"]);
    expect(dispatchOutcomeLinks(target, { nativeHost: false }).map((link) => link.key))
      .toEqual(["conversation", "work", "tail"]);
  });
});

describe("dispatchFlightOutcome", () => {
  function flight(overrides: Partial<Flight> = {}): Flight {
    return {
      id: "flt-1",
      invocationId: "inv-1",
      agentId: "agent-1",
      agentName: "worker",
      conversationId: "chn-1",
      collaborationRecordId: null,
      state: "succeeded",
      summary: null,
      startedAt: 1_000,
      completedAt: 4_000,
      sessions: [],
      ...overrides,
    };
  }

  test("reads a settled success", () => {
    const outcome = dispatchFlightOutcome(flight());
    expect(outcome).toMatchObject({ label: "Completed", tone: "success", settled: true });
    expect(outcome?.durationMs).toBe(3_000);
  });

  test("keeps a running flight unsettled", () => {
    const outcome = dispatchFlightOutcome(flight({ state: "running", completedAt: null }));
    expect(outcome).toMatchObject({ label: "Running", tone: "working", settled: false });
    expect(outcome?.durationMs).toBeNull();
  });

  test("tones a failure as danger", () => {
    expect(dispatchFlightOutcome(flight({ state: "failed" }))?.tone).toBe("danger");
  });

  test("passes an unknown state through instead of guessing", () => {
    const outcome = dispatchFlightOutcome(flight({ state: "reconciling_upstream" }));
    expect(outcome).toMatchObject({ label: "reconciling upstream", tone: "neutral" });
  });

  test("is absent without a flight", () => {
    expect(dispatchFlightOutcome(null)).toBeNull();
  });
});

describe("formatting", () => {
  test("describes the gap before a reply", () => {
    expect(formatDispatchGap(400)).toBe("instant");
    expect(formatDispatchGap(45_000)).toBe("45s later");
    expect(formatDispatchGap(600_000)).toBe("10m later");
    expect(formatDispatchGap(7_200_000)).toBe("2h later");
    expect(formatDispatchGap(4 * 86_400_000)).toBe("4d later");
  });

  test("describes how long a flight ran", () => {
    expect(formatDispatchDuration(420)).toBe("420ms");
    expect(formatDispatchDuration(4_200)).toBe("4.2s");
    expect(formatDispatchDuration(42_000)).toBe("42s");
    expect(formatDispatchDuration(150_000)).toBe("2m 30s");
    expect(formatDispatchDuration(7_260_000)).toBe("2h 1m");
  });
});
