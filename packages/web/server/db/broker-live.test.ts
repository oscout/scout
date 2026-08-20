import { describe, expect, test } from "bun:test";
import type { MessageRecord } from "@openscout/protocol";

import {
  brokerDiagnosticsNeedsFullSnapshot,
  markBrokerDiagnosticsLiveUnavailable,
  mergeBrokerDiagnosticsWithLiveSnapshot,
} from "./broker-live.ts";
import type { WebBrokerDiagnostics, WebBrokerRouteAttempt } from "./types/web.ts";

function message(
  id: string,
  createdAt: number,
  metadata: Record<string, unknown> = {},
): MessageRecord {
  return {
    id,
    conversationId: "conversation-1",
    actorId: "agent-1",
    originNodeId: "node-1",
    class: "agent",
    body: `Body for ${id}`,
    visibility: "private",
    policy: "durable",
    createdAt,
    metadata,
  };
}

function failedAttempt(ts: number): WebBrokerRouteAttempt {
  return {
    id: "delivery:failed-1",
    kind: "failed_delivery",
    status: "failed",
    ts,
    actorName: "Agent One",
    target: "agent-1",
    route: "local_socket",
    detail: "mention",
    conversationId: "conversation-1",
    messageId: "message-failed",
    deliveryId: "failed-1",
    invocationId: null,
    metadata: null,
  };
}

function diagnostics(overrides: Partial<WebBrokerDiagnostics> = {}): WebBrokerDiagnostics {
  return {
    generatedAt: 1,
    windowMs: 86_400_000,
    source: {
      mode: "sqlite_projection",
      status: "unknown",
      latestMessageAt: 100,
      projectionLatestMessageAt: 100,
      liveMessageCount: null,
      projectionMessageCount: 1,
      detail: null,
    },
    ledger: {
      mode: "latest",
      limit: 10,
      cursor: null,
      cursors: {
        attempts: null,
        failedQueries: null,
        failedDeliveries: null,
        dialogue: null,
      },
      hasMore: {
        attempts: false,
        failedQueries: false,
        failedDeliveries: false,
        dialogue: false,
      },
    },
    totals: {
      successfulDispatches: 0,
      failedQueries: 0,
      failedDeliveries: 1,
      deliveryAttempts: 0,
      failedDeliveryAttempts: 0,
      dialogueMessages: 0,
    },
    rates: {
      messagesPerHour: 0,
      failedQueriesPerHour: 0,
      failedDeliveriesPerHour: 0,
      failureRate: 1,
    },
    attempts: [],
    failedQueries: [],
    failedDeliveries: [],
    dialogue: [],
    ...overrides,
  };
}

describe("live broker dispatch diagnostics", () => {
  test("marks the SQLite fallback stale when the live broker feed is unavailable", () => {
    const result = markBrokerDiagnosticsLiveUnavailable(diagnostics());

    expect(result.source).toMatchObject({
      mode: "sqlite_projection",
      status: "degraded",
      liveMessageCount: null,
    });
  });

  test("requests a complete snapshot when a capped live feed leaves a projection gap", () => {
    const projection = diagnostics({ windowMs: 100 });
    const recent = message("recent", 750);

    expect(brokerDiagnosticsNeedsFullSnapshot(projection, {
      actors: {},
      messages: { recent },
      totalMessageCount: 501,
    }, 800)).toBe(true);

    const overlapping = message("overlapping", 50);
    expect(brokerDiagnosticsNeedsFullSnapshot(projection, {
      actors: {},
      messages: { recent, overlapping },
      totalMessageCount: 501,
    }, 800)).toBe(false);

    const unknownTotalCappedFeed = Object.fromEntries(
      Array.from({ length: 500 }, (_, index) => {
        const item = message(`capped-${index}`, 750 + index);
        return [item.id, item];
      }),
    );
    expect(brokerDiagnosticsNeedsFullSnapshot(projection, {
      actors: {},
      messages: unknownTotalCappedFeed,
      totalMessageCount: null,
    }, 800)).toBe(true);
  });

  test("replaces stale message rows with the canonical broker snapshot", () => {
    const oldMessage = message("message-old", 100, {
      source: "scout-cli",
      relayTarget: "operator",
      relayChannel: "dm",
    });
    const newMessage = message("message-new", 300, {
      source: "scout-cli",
      relayTarget: "operator",
      relayChannel: "dm",
    });
    const failure = failedAttempt(200);
    const projection = diagnostics({
      attempts: [{
        ...failedAttempt(100),
        id: "message:message-old",
        kind: "success",
        status: "sent",
        messageId: "message-old",
        deliveryId: null,
      }, failure],
      failedDeliveries: [failure],
      dialogue: [{
        id: oldMessage.id,
        ts: oldMessage.createdAt,
        actorName: "Agent One",
        conversationId: oldMessage.conversationId,
        body: oldMessage.body,
        class: oldMessage.class,
      }],
    });

    const result = mergeBrokerDiagnosticsWithLiveSnapshot(projection, {
      actors: { "agent-1": { displayName: "Agent One" } },
      messages: {
        [oldMessage.id]: oldMessage,
        [newMessage.id]: newMessage,
      },
    });

    expect(result.attempts.map((attempt) => attempt.id)).toEqual([
      "message:message-new",
      "delivery:failed-1",
      "message:message-old",
    ]);
    expect(result.dialogue.map((item) => item.id)).toEqual(["message-new", "message-old"]);
    expect(result.attempts.filter((attempt) => attempt.id === "message:message-old")).toHaveLength(1);
    expect(result.source).toMatchObject({
      mode: "live_broker",
      status: "degraded",
      latestMessageAt: 300,
      projectionLatestMessageAt: 100,
      liveMessageCount: 2,
      projectionMessageCount: 1,
    });
  });

  test("paginates live message attempts with the existing stable cursor shape", () => {
    const newer = message("newer", 300, { source: "scout-cli", relayTarget: "operator" });
    const older = message("older", 200, { source: "scout-cli", relayTarget: "operator" });
    const projection = diagnostics({
      ledger: {
        ...diagnostics().ledger,
        limit: 1,
      },
    });
    const snapshot = {
      actors: { "agent-1": { displayName: "Agent One" } },
      messages: { newer, older },
    };

    const first = mergeBrokerDiagnosticsWithLiveSnapshot(projection, snapshot);
    const second = mergeBrokerDiagnosticsWithLiveSnapshot(
      projection,
      snapshot,
      first.ledger.cursors.attempts,
    );

    expect(first.attempts.map((attempt) => attempt.id)).toEqual(["message:newer"]);
    expect(first.ledger.hasMore.attempts).toBe(true);
    expect(second.attempts.map((attempt) => attempt.id)).toEqual(["message:older"]);
  });

  test("keeps failure diagnostics marked degraded when broker health reports the projection unavailable", () => {
    const current = message("current", 100, { source: "scout-cli", relayTarget: "operator" });
    const projection = diagnostics({
      source: {
        mode: "sqlite_projection",
        status: "unknown",
        latestMessageAt: current.createdAt,
        projectionLatestMessageAt: current.createdAt,
        liveMessageCount: null,
        projectionMessageCount: 1,
        detail: null,
      },
    });

    const result = mergeBrokerDiagnosticsWithLiveSnapshot(projection, {
      actors: {},
      messages: { [current.id]: current },
      totalMessageCount: 1,
      projectionStatus: "degraded",
    });

    expect(result.source?.status).toBe("degraded");
  });
});
