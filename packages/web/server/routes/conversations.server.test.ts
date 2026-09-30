import { describe, expect, test } from "bun:test";
import {
  stubs,
  createOpenScoutWebServer,
  loadScoutBrokerContextOptions,
  makeCompatibilitySession,
  makeConversationProjectionSnapshot,
  makeObservedProjectionItem,
  makeOfflineBrokerHealth,
  makeScoutProjectionItem,
  makeStaticRoot,
  openScoutDirectSessionCalls,
  upsertScoutConversationCalls,
  installWebServerTestHooks,
  loadWebServerUnderTest,
} from "../web-server-test-harness.ts";

// Loads the server modules behind the harness mocks (see the harness for why
// this is awaited here rather than at the harness top level).
await loadWebServerUnderTest();
installWebServerTestHooks();

describe("createOpenScoutWebServer: conversations routes", () => {
  test("serves unified comms from the broker-backed service", async () => {
    stubs.scoutBrokerContextResult = {
      snapshot: {
        conversations: {
          "c.agent-1": {
            id: "c.agent-1",
            kind: "direct",
            title: "ignored",
            participantIds: ["operator", "agent-1"],
          },
          "c.general": {
            id: "c.general",
            kind: "channel",
            title: "general",
            participantIds: ["operator", "agent-1"],
            metadata: { channel: "general" },
          },
        },
        messages: {
          "msg-1": {
            id: "msg-1",
            conversationId: "c.agent-1",
            actorId: "agent-1",
            body: "hello from dm",
            createdAt: 1_700_000_000,
          },
          "msg-2": {
            id: "msg-2",
            conversationId: "c.general",
            actorId: "agent-1",
            body: "hello from channel",
            createdAt: 1_700_000_100,
          },
        },
        agents: {
          "agent-1": {
            id: "agent-1",
            displayName: "Agent One",
            authorityNodeId: "node-1",
            metadata: {},
          },
        },
        actors: {
          "agent-1": {
            id: "agent-1",
            displayName: "Agent One",
          },
        },
        endpoints: {
          "endpoint-1": {
            id: "endpoint-1",
            agentId: "agent-1",
            state: "available",
            harness: "codex",
            cwd: "/tmp/project",
            projectRoot: "/tmp/project",
            metadata: {},
          },
        },
      },
    };
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });
    loadScoutBrokerContextOptions.length = 0;
    const response = await server.app.request("http://localhost/api/comms");

    expect(response.status).toBe(200);
    expect(loadScoutBrokerContextOptions).toContainEqual(expect.objectContaining({
      scope: "conversations",
      waitForInitial: false,
    }));
    await expect(response.json()).resolves.toEqual([
      expect.objectContaining({
        chatId: "c.general",
        cId: "c.general",
        id: "c.general",
        kind: "channel",
        preview: "hello from channel",
      }),
      expect.objectContaining({
        chatId: "c.agent-1",
        cId: "c.agent-1",
        id: "c.agent-1",
        kind: "direct",
        preview: "hello from dm",
        harness: "codex",
      }),
    ]);

    loadScoutBrokerContextOptions.length = 0;
    const machineResponse = await server.app.request(
      "http://localhost/api/comms?machineId=node-1",
    );
    expect(machineResponse.status).toBe(200);
    expect(loadScoutBrokerContextOptions).toContainEqual({});
  });

  test("keeps native comms list reads on the materialized projection after broker warmup", async () => {
    stubs.scoutConversationProjectionResult = makeConversationProjectionSnapshot([
      makeScoutProjectionItem("c.projected"),
    ]);
    stubs.scoutBrokerContextResult = {
      snapshot: {
        conversations: {
          "c.expensive-broker": {
            id: "c.expensive-broker",
            kind: "channel",
            title: "Broker-only conversation",
            participantIds: ["operator"],
          },
        },
        messages: {
          "msg-expensive": {
            id: "msg-expensive",
            conversationId: "c.expensive-broker",
            actorId: "operator",
            body: "This full snapshot must not be rebuilt for the list poll",
            createdAt: 1_800_000_100_000,
          },
        },
        agents: {},
        actors: { operator: { id: "operator", displayName: "Operator" } },
        endpoints: {},
      },
    };
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const response = await server.app.request("http://localhost/api/comms");

    expect(response.status).toBe(200);
    expect(stubs.loadScoutBrokerContextCalls).toBe(0);
    await expect(response.json()).resolves.toEqual([
      expect.objectContaining({
        id: "c.projected",
        preview: "Served from the durable projection",
        model: "gpt-5.6-sol",
        reasoningEffort: "xhigh",
      }),
    ]);
  });

  test("never presents an ambiguous empty broker response as a new workspace", async () => {
    stubs.scoutBrokerContextResult = null;
    stubs.scoutConversationProjectionResult = makeConversationProjectionSnapshot([]);
    stubs.scoutBrokerHealthResult = makeOfflineBrokerHealth({
      reachable: true,
      ok: true,
      startup: { state: "ready", mutationsAdmitted: true },
      projection: { state: "warming", detail: "rebuilding" },
      counts: { conversations: 12, messages: 48 },
      error: null,
    });
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const response = await server.app.request("http://localhost/api/comms");

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "conversation_list_restoring",
      retryable: true,
    });
  });

  test("paints a durable conversation projection while broker context warms", async () => {
    stubs.scoutBrokerContextResult = null;
    stubs.querySessionsResult = [{
      id: "c.local-ready",
      kind: "direct",
      title: "Local Ready",
      participantIds: ["operator", "agent-1"],
      agentId: "agent-1",
      agentName: "Agent One",
      harness: "codex",
      harnessSessionId: "session-1",
      harnessLogPath: null,
      currentBranch: "main",
      preview: "Already projected",
      messageCount: 3,
      lastMessageAt: 1_700_000_000,
      workspaceRoot: "/tmp/project",
    }];
    stubs.scoutBrokerHealthResult = makeOfflineBrokerHealth({
      reachable: true,
      ok: true,
      startup: { state: "ready", mutationsAdmitted: true },
      counts: { conversations: 1, messages: 3 },
      error: null,
    });
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const response = await server.app.request("http://localhost/api/conversations");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      expect.objectContaining({
        id: "c.local-ready",
        preview: "Already projected",
      }),
    ]);
  });

  test("falls back to Scout sessions when the launch projection is observed-only", async () => {
    stubs.scoutBrokerContextResult = null;
    stubs.scoutConversationProjectionResult = makeConversationProjectionSnapshot([
      makeObservedProjectionItem(1),
    ]);
    stubs.querySessionsResult = [makeCompatibilitySession("c.compat-observed-only")];
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const response = await server.app.request("http://localhost/api/comms");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      expect.objectContaining({
        id: "c.compat-observed-only",
        preview: "Recovered from the compatibility view",
      }),
    ]);
  });

  test("falls back when 160 newer observed rows hide older Scout rows", async () => {
    stubs.scoutBrokerContextResult = null;
    stubs.scoutConversationProjectionResult = makeConversationProjectionSnapshot(
      Array.from({ length: 160 }, (_, index) => makeObservedProjectionItem(index)),
      161,
    );
    stubs.querySessionsResult = [makeCompatibilitySession("c.compat-below-window")];
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const response = await server.app.request("http://localhost/api/comms");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      expect.objectContaining({ id: "c.compat-below-window" }),
    ]);
  });

  test("returns an empty filtered list when a broker snapshot is available", async () => {
    stubs.scoutBrokerContextResult = {
      baseUrl: "http://broker.test",
      node: { id: "node-1" },
      snapshot: {
        nodes: {},
        conversations: {
          "c.general": {
            id: "c.general",
            kind: "channel",
            title: "general",
            participantIds: ["operator"],
          },
        },
        messages: {
          "msg-1": {
            id: "msg-1",
            conversationId: "c.general",
            actorId: "operator",
            body: "visible history",
            createdAt: 1_700_000_000,
          },
        },
        agents: {},
        actors: { operator: { id: "operator", displayName: "Operator" } },
        endpoints: {},
      },
    };
    stubs.scoutBrokerHealthResult = makeOfflineBrokerHealth({
      reachable: true,
      ok: true,
      counts: { conversations: 1, messages: 1 },
      error: null,
    });
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const response = await server.app.request("http://localhost/api/comms?query=definitely-absent");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([]);
  });

  test("returns an empty visible list for a snapshot containing only hidden records", async () => {
    stubs.scoutBrokerContextResult = {
      baseUrl: "http://broker.test",
      node: { id: "node-1" },
      snapshot: {
        nodes: {},
        conversations: {
          "c.system": {
            id: "c.system",
            kind: "system",
            title: "System",
            participantIds: [],
          },
        },
        messages: {},
        agents: {},
        actors: {},
        endpoints: {},
      },
    };
    stubs.scoutBrokerHealthResult = makeOfflineBrokerHealth({
      reachable: true,
      ok: true,
      counts: { conversations: 1, messages: 0 },
      error: null,
    });
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const response = await server.app.request("http://localhost/api/comms");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([]);
  });

  test("confirms canonical emptiness when the SQLite projection is disabled", async () => {
    stubs.scoutBrokerContextResult = null;
    stubs.scoutBrokerHealthResult = makeOfflineBrokerHealth({
      reachable: true,
      ok: true,
      startup: { state: "ready", mutationsAdmitted: true },
      projection: { state: "disabled", detail: "disabled by configuration" },
      counts: { conversations: 0, messages: 0 },
      error: null,
    });
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const response = await server.app.request("http://localhost/api/comms");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([]);
  });

  test("opens a direct chat using the agent project path as resolution context", async () => {
    stubs.queryAgentsResult = [
      {
        id: "agent-1",
        definitionId: "agent-1",
        name: "Agent One",
        handle: "agent-one",
        projectRoot: "/tmp/project-alpha",
        cwd: "/tmp/project-alpha",
        conversationId: null,
      },
    ];

    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });
    const response = await server.app.request("http://localhost/api/conversations/direct", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: "agent-1",
        targetLabel: "@agent-one",
        projectPath: "/tmp/project-alpha",
      }),
    });

    expect(response.status).toBe(200);
    expect(openScoutDirectSessionCalls).toEqual([
      expect.objectContaining({
        agentId: "agent-1",
        currentDirectory: "/tmp/project-alpha",
        targetName: "@agent-one",
      }),
    ]);
    expect(await response.json()).toMatchObject({
      ok: true,
      chatId: "c.agent-1",
      conversationId: "c.agent-1",
      agentId: "agent-1",
    });
  });

  test("promotes direct conversations to group direct when adding a participant", async () => {
    stubs.querySessionByIdImpl = (conversationId) => ({
      id: conversationId,
      kind: upsertScoutConversationCalls.length > 0 ? "group_direct" : "direct",
      agentId: upsertScoutConversationCalls.length > 0 ? null : "agent-1",
      participantIds: upsertScoutConversationCalls.length > 0
        ? ["agent-1", "agent-2", "operator"]
        : ["agent-1", "operator"],
    });
    stubs.queryConversationDefinitionByIdImpl = (conversationId) => ({
      id: conversationId,
      kind: "direct",
      title: "Agent One",
      visibility: "private",
      shareMode: "local",
      authorityNodeId: "node-1",
      topic: null,
      parentConversationId: null,
      messageId: null,
      metadata: {},
      participantIds: ["operator", "agent-1"],
    });

    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });
    const response = await server.app.request("http://localhost/api/conversations/c.conv-1/members", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actorId: "agent-2" }),
    });

    expect(response.status).toBe(200);
    expect(upsertScoutConversationCalls).toEqual([
      expect.objectContaining({
        id: "c.conv-1",
        kind: "group_direct",
        participantIds: ["agent-1", "agent-2", "operator"],
      }),
    ]);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      kind: "group_direct",
      participantIds: ["agent-1", "agent-2", "operator"],
      session: {
        id: "c.conv-1",
        kind: "group_direct",
        agentId: null,
        participantIds: ["agent-1", "agent-2", "operator"],
      },
    });
  });

  test("creates anchored child thread conversations for an existing chat", async () => {
    stubs.queryConversationDefinitionByIdImpl = (conversationId) => {
      if (conversationId !== "c.parent") return null;
      return {
        id: "c.parent",
        kind: "direct",
        title: "Agent One",
        visibility: "private",
        shareMode: "local",
        authorityNodeId: "node-1",
        topic: null,
        parentConversationId: null,
        messageId: null,
        metadata: { naturalKey: "direct:agent-1,operator" },
        participantIds: ["operator", "agent-1"],
      };
    };
    stubs.scoutBrokerContextResult = {
      baseUrl: "http://broker.test",
      node: { id: "node-1" },
      snapshot: {
        conversations: {
          "c.parent": {
            id: "c.parent",
            kind: "direct",
            title: "Agent One",
            visibility: "private",
            shareMode: "local",
            authorityNodeId: "node-1",
            participantIds: ["operator", "agent-1"],
          },
        },
        messages: {
          "msg-anchor": {
            id: "msg-anchor",
            conversationId: "c.parent",
            actorId: "agent-1",
            body: "Anchor",
            createdAt: 1_700_000_000_000,
          },
        },
      },
    };
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const response = await server.app.request("http://localhost/api/conversations/c.parent/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: "msg-anchor" }),
    });

    expect(response.status).toBe(200);
    const json = await response.json() as { conversationId: string };
    expect(json.conversationId.startsWith("chn-")).toBe(true);
    expect(upsertScoutConversationCalls).toEqual([
      expect.objectContaining({
        id: json.conversationId,
        kind: "thread",
        parentConversationId: "c.parent",
        messageId: "msg-anchor",
        participantIds: ["operator", "agent-1"],
      }),
    ]);
  });

  test("rejects anchored threads when the anchor message is missing", async () => {
    stubs.queryConversationDefinitionByIdImpl = (conversationId) => {
      if (conversationId !== "c.parent") return null;
      return {
        id: "c.parent",
        kind: "direct",
        title: "Agent One",
        visibility: "private",
        shareMode: "local",
        authorityNodeId: "node-1",
        topic: null,
        parentConversationId: null,
        messageId: null,
        metadata: { naturalKey: "direct:agent-1,operator" },
        participantIds: ["operator", "agent-1"],
      };
    };
    stubs.scoutBrokerContextResult = {
      baseUrl: "http://broker.test",
      node: { id: "node-1" },
      snapshot: {
        conversations: {
          "c.parent": {
            id: "c.parent",
            kind: "direct",
            title: "Agent One",
            visibility: "private",
            shareMode: "local",
            authorityNodeId: "node-1",
            participantIds: ["operator", "agent-1"],
          },
        },
        messages: {},
      },
    };
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const response = await server.app.request("http://localhost/api/conversations/c.parent/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: "msg-missing" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Message msg-missing is not available.",
    });
    expect(upsertScoutConversationCalls).toEqual([]);
  });

  test("rejects anchored threads when the anchor message is in another chat", async () => {
    stubs.queryConversationDefinitionByIdImpl = (conversationId) => {
      if (conversationId !== "c.parent") return null;
      return {
        id: "c.parent",
        kind: "direct",
        title: "Agent One",
        visibility: "private",
        shareMode: "local",
        authorityNodeId: "node-1",
        topic: null,
        parentConversationId: null,
        messageId: null,
        metadata: { naturalKey: "direct:agent-1,operator" },
        participantIds: ["operator", "agent-1"],
      };
    };
    stubs.scoutBrokerContextResult = {
      baseUrl: "http://broker.test",
      node: { id: "node-1" },
      snapshot: {
        conversations: {
          "c.parent": {
            id: "c.parent",
            kind: "direct",
            title: "Agent One",
            visibility: "private",
            shareMode: "local",
            authorityNodeId: "node-1",
            participantIds: ["operator", "agent-1"],
          },
          "c.other": {
            id: "c.other",
            kind: "direct",
            title: "Other",
            visibility: "private",
            shareMode: "local",
            authorityNodeId: "node-1",
            participantIds: ["operator", "agent-2"],
          },
        },
        messages: {
          "msg-anchor": {
            id: "msg-anchor",
            conversationId: "c.other",
            actorId: "agent-2",
            body: "Wrong chat",
            createdAt: 1_700_000_000_000,
          },
        },
      },
    };
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const response = await server.app.request("http://localhost/api/conversations/c.parent/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: "msg-anchor" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Message msg-anchor is not in conversation c.parent.",
    });
    expect(upsertScoutConversationCalls).toEqual([]);
  });
});
