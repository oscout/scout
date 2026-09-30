import { describe, expect, test } from "bun:test";
import {
  stubs,
  createOpenScoutWebServer,
  makeA2aBrokerContext,
  makeStaticRoot,
  useIsolatedOpenScoutHome,
  installWebServerTestHooks,
  loadWebServerUnderTest,
} from "../web-server-test-harness.ts";

// Loads the server modules behind the harness mocks (see the harness for why
// this is awaited here rather than at the harness top level).
await loadWebServerUnderTest();
installWebServerTestHooks();

describe("createOpenScoutWebServer: sessions routes", () => {
  test("canonicalizes legacy scoutbot default conversation ids on session lookup", async () => {
    const home = useIsolatedOpenScoutHome();
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.endsWith("/v1/events/stream")) {
        return new Response(new ReadableStream({
          start(controller) {
            const signal = init?.signal;
            if (signal instanceof AbortSignal) {
              signal.addEventListener("abort", () => controller.close(), { once: true });
            }
          },
        }), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    stubs.scoutBrokerContextResult = makeA2aBrokerContext({
      snapshot: {
        conversations: {
          "dm.operator.scoutbot.default": {
            id: "dm.operator.scoutbot.default",
            kind: "direct",
            title: "Scout · default",
            visibility: "private",
            shareMode: "local",
            authorityNodeId: "node-1",
            participantIds: ["operator", "scoutbot"],
            metadata: { scoutbotThreadId: "thr-default" },
          },
        },
        messages: {},
      },
    });
    stubs.querySessionByIdImpl = (conversationId) =>
      conversationId.startsWith("chn-")
        ? {
          id: conversationId,
          kind: "direct",
          agentId: "scoutbot",
          participantIds: ["operator", "scoutbot"],
        }
        : null;

    const server = await createOpenScoutWebServer({
      currentDirectory: home,
      assetMode: "static",
      staticRoot: makeStaticRoot(),
      scoutbot: { enabled: true, brokerBaseUrl: "http://broker.test" },
    });
    try {
      const response = await server.app.request(
        "http://localhost/api/session/dm.operator.scoutbot.default",
      );

      expect(response.status).toBe(200);
      const session = await response.json() as { id: string };
      expect(session.id).not.toBe("dm.operator.scoutbot.default");
      expect(session.id.startsWith("chn-")).toBe(true);
    } finally {
      await server.stop();
    }
  });

  test("does not build the writable session projection for a raw observed transcript", async () => {
    const refId = "642ca306-2d7b-4bd8-a2a7-75e0b27a8006";
    stubs.querySessionsResult = [{
      id: "c.unrelated",
      kind: "direct",
      agentId: "unrelated-agent",
      participantIds: ["operator", "unrelated-agent"],
      harness: "claude",
      harnessSessionId: refId,
    }];
    stubs.sessionRefObservePayloadResult = {
      kind: "history",
      refId,
      agentId: null,
      source: "history",
      fidelity: "timestamped",
      historyPath: `/tmp/${refId}.jsonl`,
      sessionId: refId,
      updatedAt: Date.now(),
      data: {},
    };
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const response = await server.app.request(
      `http://localhost/api/session-ref/${refId}`,
    );

    expect(response.status).toBe(200);
    expect(stubs.querySessionsCalls).toBe(0);
    await expect(response.json()).resolves.toMatchObject({
      kind: "observe",
      session: null,
      observe: { kind: "history", agentId: null },
    });
  });

  test("does not attach a colliding database conversation to a broker presentation ref", async () => {
    const presentationRef = "broker-presentation-owner";
    const databaseSession = {
      id: "c.database-owner",
      kind: "direct",
      agentId: "database-owner",
      participantIds: ["database-owner", "operator"],
      harness: "codex",
      harnessSessionId: presentationRef,
    };
    stubs.querySessionsResult = [databaseSession];
    stubs.sessionRefObservePayloadResult = {
      kind: "broker",
      refId: presentationRef,
      agentId: presentationRef,
      source: "broker",
      fidelity: "synthetic",
      historyPath: null,
      sessionId: "native-broker-session",
      updatedAt: Date.now(),
      data: {},
    };
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const collisionResponse = await server.app.request(
      `http://localhost/api/session-ref/session:codex:${presentationRef}`,
    );

    expect(collisionResponse.status).toBe(200);
    await expect(collisionResponse.json()).resolves.toMatchObject({
      kind: "observe",
      session: null,
      observe: { agentId: presentationRef },
    });

    stubs.sessionRefObservePayloadResult = {
      ...stubs.sessionRefObservePayloadResult as Record<string, unknown>,
      agentId: "database-owner",
    };
    const matchingOwnerResponse = await server.app.request(
      `http://localhost/api/session-ref/session:codex:${presentationRef}`,
    );

    await expect(matchingOwnerResponse.json()).resolves.toMatchObject({
      kind: "observe",
      session: { id: databaseSession.id, agentId: "database-owner" },
      observe: { agentId: "database-owner" },
    });
    expect(stubs.querySessionsCalls).toBe(2);
  });
});
