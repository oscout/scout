import { describe, expect, test } from "bun:test";
import {
  stubs,
  askScoutQuestionCalls,
  createOpenScoutWebServer,
  makeBrokerDiagnostics,
  makeOfflineBrokerHealth,
  makeStaticRoot,
  installWebServerTestHooks,
  loadWebServerUnderTest,
} from "../web-server-test-harness.ts";

// Loads the server modules behind the harness mocks (see the harness for why
// this is awaited here rather than at the harness top level).
await loadWebServerUnderTest();
installWebServerTestHooks();

describe("createOpenScoutWebServer: broker routes", () => {
  test("reports broker liveness without a snapshot", async () => {
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });
    stubs.scoutBrokerHealthResult = makeOfflineBrokerHealth({ error: "connect ECONNREFUSED" });
    const offline = await server.app.request("http://localhost/api/broker/health");
    expect(offline.status).toBe(200);
    await expect(offline.json()).resolves.toEqual({
      reachable: false,
      ok: false,
      error: "connect ECONNREFUSED",
    });

    stubs.scoutBrokerHealthResult = makeOfflineBrokerHealth({ reachable: true, ok: true, error: null });
    const online = await server.app.request("http://localhost/api/broker/health");
    await expect(online.json()).resolves.toEqual({ reachable: true, ok: true, error: null });
  });

  test("serves broker diagnostics", async () => {
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });
    const response = await server.app.request("http://localhost/api/broker");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      source: {
        mode: "sqlite_projection",
        status: "degraded",
      },
      totals: {
        successfulDispatches: 0,
        failedQueries: 0,
        failedDeliveries: 0,
      },
      attempts: [],
      failedQueries: [],
      failedDeliveries: [],
      dialogue: [],
    });
  });

  test("reports an online broker while its live dispatch feed is warming", async () => {
    stubs.scoutBrokerHealthResult = makeOfflineBrokerHealth({
      reachable: true,
      ok: true,
      projection: {
        state: "degraded",
        detail: "SQLite projection is not ready.",
      },
      error: null,
    });
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const response = await server.app.request("http://localhost/api/broker");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      source: {
        mode: "sqlite_projection",
        status: "degraded",
        brokerReachable: true,
        detail: expect.stringContaining("broker is online"),
      },
    });
  });

  test("serves current broker messages when the SQLite dispatch projection is stale", async () => {
    const old = 1_700_000_000_000;
    const current = old + 10_000;
    const routedAttempt = (id: string, ts: number) => ({
      id: `message:${id}`,
      kind: "success",
      status: "sent",
      ts,
      actorName: "Agent One",
      target: "operator",
      route: "dm",
      detail: id,
      conversationId: "conversation-1",
      messageId: id,
      deliveryId: null,
      invocationId: null,
      metadata: null,
    });
    stubs.brokerDiagnosticsResult = makeBrokerDiagnostics({
      source: {
        mode: "sqlite_projection",
        status: "unknown",
        latestMessageAt: old,
        projectionLatestMessageAt: old,
        liveMessageCount: null,
        projectionMessageCount: 1,
        detail: null,
      },
      attempts: [routedAttempt("message-old", old)],
      dialogue: [{
        id: "message-old",
        ts: old,
        actorName: "Agent One",
        conversationId: "conversation-1",
        body: "Old dispatch",
        class: "agent",
      }],
    });
    stubs.scoutBrokerContextResult = {
      baseUrl: "http://127.0.0.1:43110",
      node: { id: "node-1" },
      snapshot: {
        actors: {
          "agent-1": { id: "agent-1", displayName: "Agent One" },
        },
        messages: {
          "message-old": {
            id: "message-old",
            conversationId: "conversation-1",
            actorId: "agent-1",
            originNodeId: "node-1",
            class: "agent",
            body: "Old dispatch",
            visibility: "private",
            policy: "durable",
            createdAt: old,
            metadata: { source: "scout-cli", relayTarget: "operator", relayChannel: "dm" },
          },
          "message-current": {
            id: "message-current",
            conversationId: "conversation-1",
            actorId: "agent-1",
            originNodeId: "node-1",
            class: "agent",
            body: "Current dispatch",
            visibility: "private",
            policy: "durable",
            createdAt: current,
            metadata: { source: "scout-cli", relayTarget: "operator", relayChannel: "dm" },
          },
        },
      },
    };
    stubs.scoutBrokerMessagesResult = Object.values((stubs.scoutBrokerContextResult as {
      snapshot: { messages: Record<string, Record<string, unknown>> };
    }).snapshot.messages);
    stubs.scoutBrokerHomeResult = {
      updatedAt: current,
      agents: [{ id: "agent-1", title: "Agent One" }],
      activity: [],
    };
    stubs.scoutBrokerHealthResult = makeOfflineBrokerHealth({
      reachable: true,
      ok: true,
      counts: { messages: 2 },
      error: null,
    });

    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });
    const response = await server.app.request("http://localhost/api/broker");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      source: {
        mode: "live_broker",
        status: "degraded",
        latestMessageAt: current,
        projectionLatestMessageAt: old,
      },
      attempts: [
        { id: "message:message-current", actorName: "Agent One" },
        { id: "message:message-old" },
      ],
      dialogue: [
        { id: "message-current", actorName: "Agent One" },
        { id: "message-old" },
      ],
    });
    stubs.scoutBrokerMessagesResult = [
      ...(stubs.scoutBrokerMessagesResult ?? []),
      {
        id: "message-after-refresh",
        conversationId: "conversation-1",
        actorId: "agent-1",
        originNodeId: "node-1",
        class: "agent",
        body: "Arrived after the first Dispatch load",
        visibility: "private",
        policy: "durable",
        createdAt: current + 1,
        metadata: { source: "scout-cli", relayTarget: "operator", relayChannel: "dm" },
      },
    ];
    stubs.scoutBrokerHealthResult = makeOfflineBrokerHealth({
      reachable: true,
      ok: true,
      counts: { messages: 3 },
      error: null,
    });

    const refreshedResponse = await server.app.request("http://localhost/api/broker");
    expect(refreshedResponse.status).toBe(200);
    const refreshedBody = await refreshedResponse.json() as {
      dialogue: Array<{ id: string; actorName: string }>;
    };
    expect(refreshedBody.dialogue[0]).toMatchObject({
      id: "message-after-refresh",
      actorName: "Agent One",
    });
  });

  test("fills a gap when the compact broker feed is capped before the SQLite watermark", async () => {
    const now = Date.now();
    const projectionAt = now - 3 * 86_400_000;
    const bridgeAt = projectionAt + 1;
    const latestMessage = {
      id: "message-latest",
      conversationId: "conversation-1",
      actorId: "agent-1",
      originNodeId: "node-1",
      class: "agent",
      body: "Latest",
      visibility: "private",
      policy: "durable",
      createdAt: now,
      metadata: { source: "scout-cli", relayTarget: "operator", relayChannel: "dm" },
    };
    const bridgeMessage = {
      ...latestMessage,
      id: "message-bridge",
      body: "Bridge",
      createdAt: bridgeAt,
    };
    stubs.brokerDiagnosticsResult = makeBrokerDiagnostics({
      source: {
        mode: "sqlite_projection",
        status: "unknown",
        latestMessageAt: projectionAt,
        projectionLatestMessageAt: projectionAt,
        liveMessageCount: null,
        projectionMessageCount: 1,
        detail: null,
      },
    });
    stubs.scoutBrokerMessagesResult = [latestMessage];
    stubs.scoutBrokerHealthResult = makeOfflineBrokerHealth({
      reachable: true,
      ok: true,
      counts: { messages: 501 },
      error: null,
    });
    stubs.scoutBrokerSnapshotResult = {
      actors: { "agent-1": { id: "agent-1", displayName: "Agent One" } },
      messages: {
        [latestMessage.id]: latestMessage,
        [bridgeMessage.id]: bridgeMessage,
      },
    };

    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });
    const response = await server.app.request("http://localhost/api/broker");

    expect(response.status).toBe(200);
    const body = await response.json() as { dialogue: Array<{ id: string }> };
    expect(body.dialogue.map((item) => item.id)).toEqual([
      "message-latest",
      "message-bridge",
    ]);
  });

  test("failure reports require valid web credentials before launching a Codex ask", async () => {
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
      authToken: "report-test-current-token",
      resolvePeerAddress: () => "127.0.0.1",
    });
    const body = JSON.stringify({ attempt: {
      id: "failed-query-auth-test",
      kind: "failed_query",
      status: "failed",
      ts: 1_700_000_000_000,
      detail: "Target is ambiguous",
    } });
    for (const cookie of [undefined, "openscout_web_session=expired-test-token"]) {
      const response = await server.app.request("http://localhost/api/broker/dispatch-review", {
        method: "POST",
        headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
        body,
      });
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe('Bearer realm="OpenScout Web"');
      expect(askScoutQuestionCalls).toHaveLength(0);
    }
    const response = await server.app.request("http://localhost/api/broker/dispatch-review", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "openscout_web_session=report-test-current-token",
      },
      body,
    });
    expect(response.status).toBe(200);
    expect(askScoutQuestionCalls).toHaveLength(1);
    expect(askScoutQuestionCalls[0]).toMatchObject({
      executionHarness: "codex",
      target: { kind: "project_path", projectPath: "/tmp/openscout" },
      projectAgent: { persistence: "one_time" },
    });
  });

  test("routes failed dispatch review to a project-scoped Codex ask", async () => {
    process.env.OPENSCOUT_OPERATOR_NAME = "operator";
    const failedDelivery = {
      id: "delivery:del-msg-1-talkie-mention-local_socket",
      kind: "failed_delivery",
      status: "failed",
      ts: 1_700_000_000_000,
      actorName: "Talkie",
      target: "talkie.codex-agent",
      route: "local_socket",
      detail: "mention",
      conversationId: "chat-1",
      messageId: "msg-1",
      deliveryId: "del-msg-1-talkie-mention-local_socket",
      invocationId: null,
      metadata: {
        source: "deliveries",
        targetId: "talkie.codex-agent",
        transport: "local_socket",
        reason: "mention",
        failureReason: "local_socket_unreachable",
        failureDetail: "connect ENOENT /tmp/talkie.sock",
      },
    };
    stubs.brokerDiagnosticsResult = makeBrokerDiagnostics({
      failedDeliveries: [failedDelivery],
      attempts: [failedDelivery],
    });

    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });
    const response = await server.app.request("http://localhost/api/broker/dispatch-review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attemptId: failedDelivery.id }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      conversationId: "c.agent-1",
      messageId: "msg-ask-1",
      flightId: "flt-ask-1",
      dedupeFingerprint: "failed_delivery|msg-1|talkie.codex-agent|local_socket",
      rootCauseFingerprint: "failed_delivery|talkie.codex-agent|local_socket|local_socket_unreachable|connect enoent /tmp/talkie.sock",
    });
    expect(askScoutQuestionCalls).toHaveLength(1);
    expect(askScoutQuestionCalls[0]).toMatchObject({
      senderId: expect.any(String),
      target: { kind: "project_path", projectPath: "/tmp/openscout" },
      executionHarness: "codex",
      projectAgent: { persistence: "one_time" },
      currentDirectory: "/tmp/openscout",
      source: "scout-dispatch-review",
      messageMetadata: {
        dispatchAttemptId: failedDelivery.id,
        deliveryId: failedDelivery.deliveryId,
        dedupeFingerprint: "failed_delivery|msg-1|talkie.codex-agent|local_socket",
        rootCauseFingerprint: "failed_delivery|talkie.codex-agent|local_socket|local_socket_unreachable|connect enoent /tmp/talkie.sock",
      },
    });
    expect(String(askScoutQuestionCalls[0]?.body)).toContain("OpenScout dispatch failure context");
    expect(String(askScoutQuestionCalls[0]?.body)).toContain("del-msg-1-talkie-mention-local_socket");
    expect(String(askScoutQuestionCalls[0]?.body)).toContain("Make the Evidence list most of the response");
    expect(String(askScoutQuestionCalls[0]?.body)).toContain("stack/log source plus");
    expect(String(askScoutQuestionCalls[0]?.body)).toContain("implementation `file:line`");
  });

  test("reviews the inspected snapshot when a synthesized Dispatch row has no raw attempt id", async () => {
    process.env.OPENSCOUT_OPERATOR_NAME = "operator";
    stubs.brokerDiagnosticsResult = makeBrokerDiagnostics();
    const synthesizedFailure = {
      id: "message:msg-synthetic",
      kind: "failed_delivery",
      status: "failed",
      ts: 1_700_000_000_000,
      actorName: "System",
      target: "session-agent-1",
      route: "local_socket",
      detail: "Dispatch stalled after submit and retry.",
      conversationId: "chat-1",
      messageId: "msg-synthetic",
      deliveryId: "delivery-1",
      invocationId: null,
      metadata: {
        failureReason: "agent_offline",
        failureDetail: "endpoint is offline",
      },
    };

    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });
    const response = await server.app.request("http://localhost/api/broker/dispatch-review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        attemptId: synthesizedFailure.id,
        attempt: synthesizedFailure,
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      conversationId: "c.agent-1",
      messageId: "msg-ask-1",
      flightId: "flt-ask-1",
    });
    expect(askScoutQuestionCalls).toHaveLength(1);
    expect(askScoutQuestionCalls[0]).toMatchObject({
      source: "scout-dispatch-review",
      messageMetadata: {
        dispatchAttemptId: synthesizedFailure.id,
        messageId: synthesizedFailure.messageId,
        deliveryId: synthesizedFailure.deliveryId,
      },
    });
    expect(String(askScoutQuestionCalls[0]?.body)).toContain(synthesizedFailure.detail);
    expect(String(askScoutQuestionCalls[0]?.body)).toContain("endpoint is offline");
  });
});
