import { describe, expect, test } from "bun:test";
import { encodeMessageHistoryCursor } from "../../shared/message-pagination.ts";
import {
  stubs,
  createOpenScoutWebServer,
  makeStaticRoot,
  queryRecentMessagesCalls,
  installWebServerTestHooks,
  loadWebServerUnderTest,
} from "../web-server-test-harness.ts";

// Loads the server modules behind the harness mocks (see the harness for why
// this is awaited here rather than at the harness top level).
await loadWebServerUnderTest();
installWebServerTestHooks();

describe("createOpenScoutWebServer: fleet routes", () => {
  test("operator signals paginate equal timestamps and report unavailable brokers", async () => {
    const server = await createOpenScoutWebServer({ currentDirectory: "/tmp/openscout", assetMode: "static", staticRoot: makeStaticRoot() });
    const url = "http://localhost/api/operator-signals?since=100&afterId=msg-a";
    expect((await server.app.request(url)).status).toBe(503);
    const message = (id: string, actorId = "agent") => ({ id, actorId, conversationId: "dm", body: "Review this", createdAt: 100, metadata: { operatorSignal: { kind: "notify" } } });
    stubs.scoutBrokerSnapshotResult = { messages: { a: message("msg-a"), b: message("msg-b"), c: message("msg-c", "operator") } };
    const response = await server.app.request(url);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ signals: [{ id: "msg-b", body: "Review this", conversationId: "dm" }] });
    expect((await server.app.request("http://localhost/api/operator-signals?since=bad")).status).toBe(400);
  });

  test("operator signals coalesce slow polls, bound their deadline, and retry without advancing the cursor", async () => {
    const server = await createOpenScoutWebServer({ currentDirectory: "/tmp/openscout", assetMode: "static", staticRoot: makeStaticRoot() });
    let reads = 0;
    stubs.scoutBrokerSnapshotReader = ({ signal }) => {
      reads += 1;
      return new Promise((resolve) => signal!.addEventListener("abort", () => resolve(null), { once: true }));
    };
    const url = "http://localhost/api/operator-signals?since=100&afterId=msg-a";
    const started = Date.now();
    const responses = await Promise.all(Array.from({ length: 8 }, () => server.app.request(url)));
    expect(reads).toBe(1);
    expect(Date.now() - started).toBeLessThan(3_500);
    for (const response of responses) {
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("2");
      const body = await response.json();
      expect(body).toMatchObject({ partial: true, retryable: true });
      expect(body.signals).toBeUndefined();
    }
    stubs.scoutBrokerSnapshotReader = null;
    stubs.scoutBrokerSnapshotResult = { messages: { b: { id: "msg-b", actorId: "agent", conversationId: "dm", body: "Review", createdAt: 100, metadata: { operatorSignal: { kind: "notify" } } } } };
    expect(await (await server.app.request(url)).json()).toMatchObject({ signals: [{ id: "msg-b" }] });
  });

  test("serves broker-backed messages for a broker-backed conversation", async () => {
    const chatId = "chn-0600eb9f39144007919e969bc3c13e11";
    stubs.scoutBrokerContextResult = {
      snapshot: {
        conversations: {
          [chatId]: {
            id: chatId,
            kind: "direct",
            title: "Vox",
            participantIds: ["operator", "session-vox-zeno"],
          },
        },
        messages: {
          "msg-vox-1": {
            id: "msg-vox-1",
            conversationId: chatId,
            actorId: "session-vox-zeno",
            body: "loaded from the broker snapshot",
            class: "agent",
            createdAt: 1_783_915_198_766,
            metadata: { flightId: "flt-vox" },
          },
        },
        agents: {},
        actors: {
          "session-vox-zeno": {
            id: "session-vox-zeno",
            displayName: "vox-zeno-2",
          },
        },
        endpoints: {},
      },
    };

    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });
    const response = await server.app.request(
      `http://localhost/api/messages?conversationId=${chatId}&limit=260`,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      expect.objectContaining({
        id: "msg-vox-1",
        conversationId: chatId,
        chatId,
        cId: chatId,
        actorName: "vox-zeno-2",
        body: "loaded from the broker snapshot",
        metadata: { flightId: "flt-vox" },
      }),
    ]);
  });

  test("extends a short broker page with durable history below the snapshot window", async () => {
    // An aged conversation re-minted live by new traffic: the broker snapshot
    // holds only the fresh tail while SQLite still holds the transcript. The
    // route must serve both as one ascending page, not just the tail.
    const chatId = "chn-0600eb9f39144007919e969bc3c13e15";
    stubs.scoutBrokerContextResult = {
      snapshot: {
        conversations: {
          [chatId]: {
            id: chatId,
            kind: "direct",
            title: "Vox",
            participantIds: ["operator", "session-vox-zeno"],
          },
        },
        messages: {
          "msg-vox-tail-1": {
            id: "msg-vox-tail-1",
            conversationId: chatId,
            actorId: "session-vox-zeno",
            body: "fresh traffic re-minted this conversation",
            class: "agent",
            createdAt: 1_783_915_198_766,
          },
          "msg-vox-tail-2": {
            id: "msg-vox-tail-2",
            conversationId: chatId,
            actorId: "session-vox-zeno",
            body: "and this is the newest message",
            class: "agent",
            createdAt: 1_783_915_198_800,
          },
        },
        agents: {},
        actors: {
          "session-vox-zeno": {
            id: "session-vox-zeno",
            displayName: "vox-zeno-2",
          },
        },
        endpoints: {},
      },
    };
    // Projection pages are newest-first; include one id the broker page
    // already carries to prove the merge dedupes on overlap.
    stubs.queryRecentMessagesResult = [
      {
        id: "msg-vox-tail-1",
        conversationId: chatId,
        actorId: "session-vox-zeno",
        actorName: "vox-zeno-2",
        body: "fresh traffic re-minted this conversation",
        class: "agent",
        createdAt: 1_783_915_198_766,
      },
      {
        id: "msg-vox-old-2",
        conversationId: chatId,
        actorId: "operator",
        actorName: "Operator",
        body: "older operator message from the durable projection",
        class: "chat",
        createdAt: 1_783_915_100_000,
      },
      {
        id: "msg-vox-old-1",
        conversationId: chatId,
        actorId: "session-vox-zeno",
        actorName: "vox-zeno-2",
        body: "oldest message in the durable projection",
        class: "agent",
        createdAt: 1_783_915_000_000,
      },
    ];

    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });
    const response = await server.app.request(
      `http://localhost/api/messages?conversationId=${chatId}&limit=260`,
    );

    expect(response.status).toBe(200);
    const page = await response.json() as Array<{ id: string }>;
    expect(page.map((message) => message.id)).toEqual([
      "msg-vox-old-1",
      "msg-vox-old-2",
      "msg-vox-tail-1",
      "msg-vox-tail-2",
    ]);
    // The projection was asked only for what the broker page could not fill,
    // anchored below the broker page's oldest message.
    expect(queryRecentMessagesCalls.at(-1)).toMatchObject({
      limit: 258,
      conversationId: chatId,
      beforeMessageId: encodeMessageHistoryCursor({
        createdAt: 1_783_915_198_766,
        id: "msg-vox-tail-1",
      }),
    });
  });

  test("clamps an oversized message page to the same size for either source", async () => {
    const chatId = "chn-0600eb9f39144007919e969bc3c13e12";
    const messages: Record<string, unknown> = {};
    for (let index = 1; index <= 600; index += 1) {
      messages[`msg-${index}`] = {
        id: `msg-${index}`,
        conversationId: chatId,
        actorId: "session-vox-zeno",
        body: `message ${index}`,
        class: "agent",
        createdAt: 1_783_915_198_000 + index,
      };
    }
    stubs.scoutBrokerContextResult = {
      snapshot: {
        conversations: {
          [chatId]: { id: chatId, kind: "direct", title: "Vox", participantIds: ["operator"] },
        },
        messages,
        agents: {},
        actors: { "session-vox-zeno": { id: "session-vox-zeno", displayName: "vox-zeno-2" } },
        endpoints: {},
      },
    };

    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const brokerResponse = await server.app.request(
      `http://localhost/api/messages?conversationId=${chatId}&limit=1000`,
    );
    expect(brokerResponse.status).toBe(200);
    await expect(brokerResponse.json()).resolves.toHaveLength(500);

    // Same request, SQLite fallback: the route must have clamped before it
    // picked a source, not after.
    stubs.scoutBrokerContextResult = null;
    const sqliteResponse = await server.app.request(
      `http://localhost/api/messages?conversationId=${chatId}&limit=1000`,
    );
    expect(sqliteResponse.status).toBe(200);
    expect(queryRecentMessagesCalls.at(-1)?.limit).toBe(500);
  });

  test("scopes an agent-scoped page to that agent, not the global tail", async () => {
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const response = await server.app.request(
      "http://localhost/api/messages?actor=session-grok-1&limit=500",
    );

    expect(response.status).toBe(200);
    // The agent map asks for one agent's neighbourhood. Dropping `actor` here
    // is what served it the fleet's latest 500 instead.
    expect(queryRecentMessagesCalls.at(-1)).toMatchObject({
      limit: 500,
      actorId: "session-grok-1",
      conversationId: undefined,
    });
  });

  test("lets an explicit chat id win over an agent scope", async () => {
    const chatId = "chn-0600eb9f39144007919e969bc3c13e19";
    stubs.scoutBrokerContextResult = null;
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const response = await server.app.request(
      `http://localhost/api/messages?conversationId=${chatId}&actor=session-grok-1`,
    );

    expect(response.status).toBe(200);
    // A chat id is already the tighter bound; narrowing it again by actor
    // would drop the other participants' half of that transcript.
    expect(queryRecentMessagesCalls.at(-1)).toMatchObject({
      conversationId: chatId,
      actorId: undefined,
    });
  });

  test("answers 400 for a history cursor it cannot read", async () => {
    const chatId = "chn-0600eb9f39144007919e969bc3c13e13";
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const response = await server.app.request(
      `http://localhost/api/messages?conversationId=${chatId}&beforeMessageId=${encodeURIComponent("not-a-timestamp|msg-1")}`,
    );

    // A cursor the server cannot honour must never read as "no older messages".
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ reason: "malformed" });
  });

  test("answers 400 when a legacy cursor no longer names a message", async () => {
    const chatId = "chn-0600eb9f39144007919e969bc3c13e14";
    stubs.scoutBrokerContextResult = {
      snapshot: {
        conversations: {
          [chatId]: { id: chatId, kind: "direct", title: "Vox", participantIds: ["operator"] },
        },
        messages: {
          "msg-vox-1": {
            id: "msg-vox-1",
            conversationId: chatId,
            actorId: "session-vox-zeno",
            body: "still here",
            class: "agent",
            createdAt: 1_783_915_198_766,
          },
        },
        agents: {},
        actors: { "session-vox-zeno": { id: "session-vox-zeno", displayName: "vox-zeno-2" } },
        endpoints: {},
      },
    };

    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });
    const response = await server.app.request(
      `http://localhost/api/messages?conversationId=${chatId}&beforeMessageId=msg-vox-deleted`,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ reason: "unknown" });
  });
});
