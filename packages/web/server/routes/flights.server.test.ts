import { describe, expect, test } from "bun:test";
import {
  stubs,
  createOpenScoutWebServer,
  makeStaticRoot,
  queryRunsCalls,
  installWebServerTestHooks,
  loadWebServerUnderTest,
} from "../web-server-test-harness.ts";

// Loads the server modules behind the harness mocks (see the harness for why
// this is awaited here rather than at the harness top level).
await loadWebServerUnderTest();
installWebServerTestHooks();

describe("createOpenScoutWebServer: flights routes", () => {
  test("passes run filters to the run registry API", async () => {
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });
    const response = await server.app.request(
      "http://localhost/api/runs?agentId=agent-1&conversationId=conv-1&workId=work-1&state=completed&source=external_issue&active=false&limit=25",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
    expect(queryRunsCalls).toEqual([
      {
        agentId: "agent-1",
        conversationId: "conv-1",
        collaborationRecordId: undefined,
        workId: "work-1",
        state: "completed",
        source: "external_issue",
        active: false,
        limit: 25,
      },
    ]);
  });

  test("falls back to broker snapshot flights when the durable flight query misses", async () => {
    stubs.scoutBrokerContextResult = {
      baseUrl: "http://broker.test",
      node: { id: "node-1" },
      snapshot: {
        actors: {
          "session-1": {
            id: "session-1",
            kind: "session",
            displayName: "openscout-haydn",
          },
        },
        agents: {},
        endpoints: {},
        conversations: {},
        messages: {},
        invocations: {
          "inv-session": {
            id: "inv-session",
            requesterId: "operator",
            targetAgentId: "session-1",
            conversationId: "chn-session",
            messageId: "msg-session-seed",
            body: "Reply with exactly: ok",
            ensureAwake: true,
            stream: false,
            createdAt: 1_779_461_790_000,
          },
        },
        flights: {
          "flt-session": {
            id: "flt-session",
            invocationId: "inv-session",
            requesterId: "operator",
            targetAgentId: "session-1",
            state: "completed",
            summary: "openscout-haydn replied.",
            startedAt: 1_779_461_800_000,
            completedAt: 1_779_461_900_000,
          },
        },
      },
    };
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });
    const response = await server.app.request(
      "http://localhost/api/flights?active=false&flightId=flt-session",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      {
        id: "flt-session",
        invocationId: "inv-session",
        agentId: "session-1",
        agentName: "openscout-haydn",
        conversationId: "chn-session",
        messageId: "msg-session-seed",
        collaborationRecordId: null,
        state: "completed",
        summary: "openscout-haydn replied.",
        startedAt: 1_779_461_800_000,
        completedAt: 1_779_461_900_000,
        sessions: [],
      },
    ]);
  });

  test("merges durable flights with the broker window — rotated rows survive and broker wins on duplicates", async () => {
    // A terminal flight that rotated out of the broker hot set is still in
    // SQLite; a flight present in both shows the broker's (live) state.
    stubs.queryFlightsResult = [
      {
        id: "flt-rotated",
        invocationId: "inv-rotated",
        agentId: "session-1",
        agentName: "openscout-haydn",
        conversationId: "chn-session",
        messageId: null,
        collaborationRecordId: null,
        state: "completed",
        summary: "Rotated out of the broker hot set.",
        startedAt: 1_779_461_700_000,
        completedAt: 1_779_461_750_000,
        sessions: [],
      },
      {
        id: "flt-shared",
        invocationId: "inv-shared",
        agentId: "session-1",
        agentName: "openscout-haydn",
        conversationId: "chn-session",
        messageId: null,
        collaborationRecordId: null,
        state: "running",
        summary: "SQLite has not seen the completion yet.",
        startedAt: 1_779_461_800_000,
        completedAt: null,
        sessions: [],
      },
    ];
    stubs.scoutBrokerContextResult = {
      baseUrl: "http://broker.test",
      node: { id: "node-1" },
      snapshot: {
        actors: {
          "session-1": {
            id: "session-1",
            kind: "session",
            displayName: "openscout-haydn",
          },
        },
        agents: {},
        endpoints: {},
        conversations: {},
        messages: {},
        invocations: {
          "inv-shared": {
            id: "inv-shared",
            requesterId: "operator",
            targetAgentId: "session-1",
            conversationId: "chn-session",
            ensureAwake: true,
            stream: false,
            createdAt: 1_779_461_790_000,
          },
        },
        flights: {
          "flt-shared": {
            id: "flt-shared",
            invocationId: "inv-shared",
            requesterId: "operator",
            targetAgentId: "session-1",
            state: "completed",
            summary: "Broker observed the completion.",
            startedAt: 1_779_461_800_000,
            completedAt: 1_779_461_900_000,
          },
        },
      },
    };
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });
    const response = await server.app.request(
      "http://localhost/api/flights?active=false",
    );

    expect(response.status).toBe(200);
    const body = await response.json() as Array<Record<string, unknown>>;
    const byId = new Map(body.map((flight) => [flight.id, flight]));
    expect(byId.get("flt-rotated")).toMatchObject({
      state: "completed",
      summary: "Rotated out of the broker hot set.",
    });
    expect(byId.get("flt-shared")).toMatchObject({
      state: "completed",
      summary: "Broker observed the completion.",
      completedAt: 1_779_461_900_000,
    });
  });

  test("applies filters after the broker overlay — a broker-terminal durable row stays hidden under activeOnly", async () => {
    // SQLite last saw the flight running; the broker hot set knows it
    // completed. With activeOnly the merged row must be excluded — the broker
    // overlay wins before filtering, so the stale durable state cannot leak
    // through.
    stubs.queryFlightsResult = [
      {
        id: "flt-flip",
        invocationId: "inv-flip",
        agentId: "session-1",
        agentName: "openscout-haydn",
        conversationId: "chn-session",
        messageId: null,
        collaborationRecordId: null,
        state: "running",
        summary: "SQLite has not seen the completion yet.",
        startedAt: 1_779_461_800_000,
        completedAt: null,
        sessions: [],
      },
      {
        id: "flt-still-live",
        invocationId: "inv-live",
        agentId: "session-1",
        agentName: "openscout-haydn",
        conversationId: "chn-session",
        messageId: null,
        collaborationRecordId: null,
        state: "running",
        summary: "Actually still running.",
        startedAt: 1_779_461_900_000,
        completedAt: null,
        sessions: [],
      },
    ];
    stubs.scoutBrokerContextResult = {
      baseUrl: "http://broker.test",
      node: { id: "node-1" },
      snapshot: {
        actors: {},
        agents: {},
        endpoints: {},
        conversations: {},
        messages: {},
        invocations: {},
        flights: {
          "flt-flip": {
            id: "flt-flip",
            invocationId: "inv-flip",
            requesterId: "operator",
            targetAgentId: "session-1",
            state: "completed",
            summary: "Broker observed the completion.",
            startedAt: 1_779_461_800_000,
            completedAt: 1_779_461_900_000,
          },
        },
      },
    };
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });
    const response = await server.app.request(
      "http://localhost/api/flights?active=true",
    );

    expect(response.status).toBe(200);
    const body = await response.json() as Array<Record<string, unknown>>;
    const ids = body.map((flight) => flight.id);
    expect(ids).toEqual(["flt-still-live"]);
  });

  test("matches a broker-overlaid flight through the conversation id alias set", async () => {
    stubs.queryFlightsResult = [
      {
        id: "flt-alias",
        invocationId: "inv-alias",
        agentId: "session-1",
        agentName: "openscout-haydn",
        conversationId: "chn-session",
        messageId: null,
        collaborationRecordId: null,
        state: "completed",
        summary: "Durable copy.",
        startedAt: 1_779_461_800_000,
        completedAt: 1_779_461_900_000,
        sessions: [],
      },
    ];
    stubs.scoutBrokerContextResult = {
      baseUrl: "http://broker.test",
      node: { id: "node-1" },
      snapshot: {
        actors: {},
        agents: {},
        endpoints: {},
        conversations: {},
        messages: {},
        invocations: {},
        flights: {
          "flt-alias-other-conversation": {
            id: "flt-alias-other-conversation",
            invocationId: "inv-other",
            requesterId: "operator",
            targetAgentId: "session-1",
            state: "completed",
            startedAt: 1_779_461_700_000,
            completedAt: 1_779_461_800_000,
          },
        },
      },
    };
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });
    const response = await server.app.request(
      "http://localhost/api/flights?conversationId=chn-session&active=false",
    );

    expect(response.status).toBe(200);
    const body = await response.json() as Array<Record<string, unknown>>;
    expect(body.map((flight) => flight.id)).toEqual(["flt-alias"]);
  });
});
