import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCOUT_RUNTIME_CATALOG } from "@openscout/protocol";
import { buildRelayAgentInstance, writeRelayAgentOverrides } from "@openscout/runtime/setup";
import {
  stubs,
  askScoutQuestionCalls,
  createOpenScoutWebServer,
  loadScoutBrokerContextOptions,
  makeA2aBrokerContext,
  makePortalPeerMachine,
  makeStaticRoot,
  queryAgentsLimits,
  testDirectories,
  upsertScoutConversationCalls,
  useIsolatedOpenScoutHome,
  installWebServerTestHooks,
  loadWebServerUnderTest,
} from "../web-server-test-harness.ts";

// Loads the server modules behind the harness mocks (see the harness for why
// this is awaited here rather than at the harness top level).
await loadWebServerUnderTest();
installWebServerTestHooks();

describe("createOpenScoutWebServer: agents routes", () => {
  test("includes broker-registered agent cards in the agents API", async () => {
    stubs.queryAgentsResult = [
      {
        id: "local-agent",
        definitionId: "local-agent",
        name: "Local Agent",
        handle: "local-agent",
        conversationId: "c.local-agent",
      },
    ];
    stubs.scoutBrokerContextResult = makeA2aBrokerContext({
      agent: { capabilities: [] },
    });
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const listResponse = await server.app.request("http://localhost/api/agents");

    expect(listResponse.status).toBe(200);
    const agents = await listResponse.json() as Array<Record<string, unknown>>;
    expect(agents.map((agent) => agent.id)).toEqual([
      "weather-a2a.local",
      "local-agent",
    ]);
    const a2aAgent = agents.find((agent) => agent.id === "weather-a2a.local");
    expect(a2aAgent).toMatchObject({
      id: "weather-a2a.local",
      definitionId: "weather-a2a.local",
      name: "Weather A2A Agent",
      handle: "weather-a2a",
      agentClass: "general",
      harness: "http",
      state: "available",
      projectRoot: "/tmp/openscout-a2a-sidecar",
      cwd: "/tmp/openscout-a2a-sidecar",
      transport: "http",
      selector: "weather-a2a",
      wakePolicy: "on_demand",
      capabilities: ["chat", "invoke"],
      project: "openscout-a2a-sidecar",
      branch: "main",
      role: "weather",
      harnessSessionId: null,
      conversationId: null,
      authorityNodeId: "node-1",
      authorityNodeName: "Test node",
      homeNodeId: "node-1",
      homeNodeName: "Test node",
      ownerId: "operator",
      ownerName: "Operator",
      ownerHandle: "art",
      updatedAt: 1_700_000_100_000,
      createdAt: 1_700_000_000_000,
      providerName: "OpenScout Protocol Lab",
      providerUrl: "https://openscout.local",
      protocol: "A2A",
      skills: ["weatherTool"],
    });

    const detailResponse = await server.app.request(
      "http://localhost/api/agents/weather-a2a",
    );
    expect(detailResponse.status).toBe(200);
    await expect(detailResponse.json()).resolves.toMatchObject({
      id: "weather-a2a.local",
      handle: "weather-a2a",
      conversationId: null,
    });
    expect(loadScoutBrokerContextOptions).toContainEqual({ since: null });
  });

  test("limits the agents API to the most recently active merged cards", async () => {
    stubs.queryAgentsResult = Array.from({ length: 6 }, (_, index) => ({
      id: `local-agent-${index + 1}`,
      definitionId: `local-agent-${index + 1}`,
      name: `Local Agent ${index + 1}`,
      updatedAt: 1_699_999_990_000 - (index * 1_000),
    }));
    stubs.scoutBrokerContextResult = makeA2aBrokerContext();
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const response = await server.app.request("http://localhost/api/agents?limit=5");

    expect(response.status).toBe(200);
    const agents = await response.json() as Array<Record<string, unknown>>;
    expect(agents.map((agent) => agent.id)).toEqual([
      "weather-a2a.local",
      "local-agent-1",
      "local-agent-2",
      "local-agent-3",
      "local-agent-4",
    ]);
    expect(queryAgentsLimits).toContain(5);
  });

  test("keeps the agent limit while reserving one card per current mesh peer", async () => {
    stubs.queryAgentsResult = Array.from({ length: 5 }, (_, index) => ({
      id: `local-agent-${index + 1}`,
      definitionId: `local-agent-${index + 1}`,
      name: `Local Agent ${index + 1}`,
      updatedAt: 1_800_000_100_000 - index,
    }));
    const now = Date.now();
    const peerAgent = (id: string, nodeId: string, updatedAt: number) => ({
      id,
      kind: "agent",
      definitionId: id,
      displayName: id,
      handle: id,
      labels: [id],
      selector: id,
      defaultSelector: id,
      agentClass: "general",
      capabilities: ["chat", "invoke"],
      wakePolicy: "on_demand",
      homeNodeId: nodeId,
      authorityNodeId: nodeId,
      advertiseScope: "mesh",
      metadata: { brokerRegistered: true, updatedAt },
    });
    const peerEndpoint = (agentId: string, nodeId: string, updatedAt: number) => ({
      id: `endpoint.${agentId}`,
      agentId,
      nodeId,
      harness: "codex",
      transport: "codex_app_server",
      state: "active",
      projectRoot: null,
      cwd: null,
      metadata: { lastSeenAt: updatedAt },
    });
    stubs.scoutBrokerContextResult = {
      baseUrl: "http://broker.test",
      node: {
        id: "node-local",
        meshId: "mesh-1",
        name: "Local node",
        advertiseScope: "mesh",
        registeredAt: now,
      },
      snapshot: {
        nodes: {
          "node-local": {
            id: "node-local",
            meshId: "mesh-1",
            name: "Local node",
            advertiseScope: "mesh",
            registeredAt: now,
          },
          "node-peer-a": {
            id: "node-peer-a",
            meshId: "mesh-1",
            name: "Peer A",
            brokerUrl: "http://peer-a.test",
            advertiseScope: "mesh",
            registeredAt: now,
            lastSeenAt: now,
          },
          "node-peer-b": {
            id: "node-peer-b",
            meshId: "mesh-1",
            name: "Peer B",
            brokerUrl: "http://peer-b.test",
            advertiseScope: "mesh",
            registeredAt: now,
            lastSeenAt: now,
          },
        },
        actors: {},
        agents: {
          "peer-a-old": peerAgent("peer-a-old", "node-peer-a", now - 2_000),
          "peer-a-new": peerAgent("peer-a-new", "node-peer-a", now - 1_000),
          "peer-b": peerAgent("peer-b", "node-peer-b", now - 1_500),
        },
        endpoints: {
          "endpoint.peer-a-old": peerEndpoint("peer-a-old", "node-peer-a", now - 2_000),
          "endpoint.peer-a-new": peerEndpoint("peer-a-new", "node-peer-a", now - 1_000),
          "endpoint.peer-b": peerEndpoint("peer-b", "node-peer-b", now - 1_500),
        },
        conversations: {},
        messages: {},
        invocations: {},
        flights: {},
      },
    };
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const response = await server.app.request("http://localhost/api/agents?limit=3");

    expect(response.status).toBe(200);
    const agents = await response.json() as Array<{ id: string }>;
    expect(agents).toHaveLength(3);
    expect(agents.map((agent) => agent.id)).toEqual(expect.arrayContaining([
      "peer-a-new",
      "peer-b",
    ]));
    expect(agents.map((agent) => agent.id)).not.toContain("peer-a-old");
  });

  test("bounds the default agents API roster", async () => {
    stubs.queryAgentsResult = Array.from({ length: 101 }, (_, index) => ({
      id: `local-agent-${index + 1}`,
      definitionId: `local-agent-${index + 1}`,
      name: `Local Agent ${index + 1}`,
      updatedAt: 1_700_000_000_000 - index,
    }));
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const response = await server.app.request("http://localhost/api/agents");

    expect(response.status).toBe(200);
    expect(await response.json()).toHaveLength(100);
    expect(queryAgentsLimits).toContain(100);
  });

  test("serves the local agent roster without waiting for a cold broker snapshot", async () => {
    stubs.queryAgentsResult = [{
      id: "local-agent",
      definitionId: "local-agent",
      name: "Local Agent",
      updatedAt: 1_700_000_000_000,
    }];
    stubs.loadScoutBrokerContextGate = new Promise<void>(() => {});
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const response = await Promise.race([
      server.app.request("http://localhost/api/agents"),
      Bun.sleep(500).then(() => {
        throw new Error("agent roster exceeded its cold broker budget");
      }),
    ]);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      expect.objectContaining({ id: "local-agent" }),
    ]);
    expect(stubs.loadScoutBrokerContextCalls).toBe(1);
  });

  test("holds rich agent broker enrichment for the 60-second fallback window", async () => {
    const originalDateNow = Date.now;
    let now = 1_700_000_000_000;
    Date.now = () => now;
    try {
      stubs.queryAgentsResult = [{
        id: "local-agent",
        definitionId: "local-agent",
        name: "Local Agent",
        updatedAt: now,
      }];
      stubs.scoutBrokerContextResult = makeA2aBrokerContext();
      const server = await createOpenScoutWebServer({
        currentDirectory: "/tmp/openscout",
        assetMode: "static",
        staticRoot: makeStaticRoot(),
      });

      expect((await server.app.request("http://localhost/api/agents?limit=5")).status).toBe(200);
      expect(stubs.loadScoutBrokerContextCalls).toBe(1);

      now += 59_000;
      expect((await server.app.request("http://localhost/api/agents?limit=6")).status).toBe(200);
      await Bun.sleep(600);
      expect(stubs.loadScoutBrokerContextCalls).toBe(1);

      now += 2_000;
      expect((await server.app.request("http://localhost/api/agents?limit=7")).status).toBe(200);
      await Bun.sleep(600);
      expect(stubs.loadScoutBrokerContextCalls).toBe(2);
    } finally {
      Date.now = originalDateNow;
    }
  });

  test("serves a lightweight agent summary without rich broker activity", async () => {
    stubs.scoutBrokerContextResult = makeA2aBrokerContext({
      snapshot: {
        messages: {
          "msg-weather": {
            id: "msg-weather",
            conversationId: "c.weather",
            actorId: "weather-a2a.local",
            originNodeId: "node-1",
            class: "agent",
            body: "A long broker activity payload that the first HUD page does not need.",
            visibility: "private",
            policy: "durable",
            createdAt: 1_700_000_200_000,
          },
        },
      },
    });
    stubs.scoutBrokerHomeResult = {
      updatedAt: 1_700_000_200_000,
      agents: [{
        id: "weather-a2a.local",
        title: "Weather A2A Agent",
        role: null,
        summary: null,
        projectRoot: null,
        state: "available",
        reachable: true,
        statusLabel: "Available",
        statusDetail: null,
        activeTask: null,
        lastSeenAt: 1_700_000_200_000,
      }],
      activity: [],
    };
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const response = await server.app.request(
      "http://localhost/api/agents?limit=5&detail=summary",
    );

    expect(response.status).toBe(200);
    expect(stubs.loadScoutBrokerContextCalls).toBe(0);
    expect(loadScoutBrokerContextOptions).toEqual([]);
    const agents = await response.json() as Array<Record<string, unknown>>;
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      id: "weather-a2a.local",
      name: "Weather A2A Agent",
      updatedAt: 1_700_000_200_000,
    });
    expect(agents[0]).not.toHaveProperty("brokerActivity");
    expect(agents[0]).not.toHaveProperty("authorityProfile");
    expect(agents[0]).not.toHaveProperty("runtimePolicy");
  });

  test("lets broker flight state clear a stale local working projection", async () => {
    stubs.queryAgentsResult = [{
      id: "agent-1",
      definitionId: "agent-1",
      name: "Agent One",
      state: "working",
      updatedAt: 1_700_000_100_000,
    }];
    stubs.scoutBrokerHomeResult = {
      updatedAt: 1_700_000_200_000,
      agents: [{
        id: "agent-1",
        title: "Agent One",
        role: null,
        summary: null,
        projectRoot: null,
        state: "available",
        reachable: true,
        statusLabel: "Available",
        statusDetail: null,
        activeTask: null,
        lastSeenAt: 1_700_000_200_000,
      }],
      activity: [],
    };
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const response = await server.app.request(
      "http://localhost/api/agents?detail=summary",
    );

    expect(response.status).toBe(200);
    const agents = await response.json() as Array<{ id: string; state: string }>;
    expect(agents.find((agent) => agent.id === "agent-1")).toMatchObject({
      state: "available",
    });
    expect(stubs.loadScoutBrokerContextCalls).toBe(0);
  });

  test("keeps database agent rows authoritative when broker cards share an id", async () => {
    stubs.queryAgentsResult = [
      {
        id: "weather-a2a.local",
        definitionId: "weather-a2a.local",
        name: "Projected A2A Agent",
        handle: "weather-a2a",
        conversationId: "c.weather-a2a",
      },
    ];
    stubs.scoutBrokerContextResult = makeA2aBrokerContext();
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const response = await server.app.request("http://localhost/api/agents");

    expect(response.status).toBe(200);
    const agents = await response.json() as Array<Record<string, unknown>>;
    expect(agents.filter((agent) => agent.id === "weather-a2a.local")).toHaveLength(1);
    expect(agents.find((agent) => agent.id === "weather-a2a.local")).toMatchObject({
      name: "Projected A2A Agent",
    });
  });

  test("coalesces Scoutbot placeholders and projects broker-native authority and activity", async () => {
    stubs.queryAgentsResult = [
      {
        id: "scoutbot",
        definitionId: "scoutbot",
        name: "Scout",
        handle: "scoutbot",
        role: "operator-assistant",
      },
      {
        id: "scoutbot.test-node",
        definitionId: "scoutbot",
        name: "Scoutbot",
        handle: "scoutbot",
      },
    ];
    stubs.scoutBrokerContextResult = makeA2aBrokerContext({
      snapshot: {
        agents: {
          scoutbot: {
            id: "scoutbot",
            kind: "agent",
            definitionId: "scoutbot",
            displayName: "Scout",
            handle: "scoutbot",
            labels: ["assistant", "scout", "scoutbot"],
            selector: "@scoutbot",
            defaultSelector: "@scoutbot",
            agentClass: "operator",
            capabilities: ["chat", "invoke", "deliver"],
            wakePolicy: "keep_warm",
            homeNodeId: "node-1",
            authorityNodeId: "node-1",
            advertiseScope: "local",
            metadata: {
              brokerRegistered: true,
              source: "scoutbot",
              role: "operator-assistant",
              roleConfig: {
                roleId: "scoutbot",
                grants: {
                  read: ["agents_search", "broker_feed"],
                  write: ["messages_send", "ask"],
                  shell: false,
                  codebaseWrites: false,
                },
              },
            },
          },
        },
        endpoints: {
          "endpoint.scoutbot": {
            id: "endpoint.scoutbot",
            agentId: "scoutbot",
            nodeId: "node-1",
            harness: "codex",
            transport: "codex_app_server",
            state: "waiting",
            cwd: "/tmp/openscout",
            projectRoot: "/tmp/openscout",
            metadata: {
              source: "scoutbot",
              approvalPolicy: "never",
              sandbox: "read-only",
              shellTool: false,
            },
          },
        },
        messages: {
          "msg-scout": {
            id: "msg-scout",
            conversationId: "dm.operator.scoutbot",
            actorId: "scoutbot",
            originNodeId: "node-1",
            class: "agent",
            body: "I dispatched the review.",
            visibility: "private",
            policy: "durable",
            createdAt: 1_700_000_200_000,
          },
        },
        invocations: {},
        flights: {},
      },
    });
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const response = await server.app.request("http://localhost/api/agents");
    const agents = await response.json() as Array<Record<string, unknown>>;
    const scoutbots = agents.filter((agent) => agent.definitionId === "scoutbot");

    expect(scoutbots).toHaveLength(1);
    expect(scoutbots[0]).toMatchObject({
      id: "scoutbot",
      agentClass: "operator",
      role: "operator-assistant",
      authorityProfile: {
        roleId: "scoutbot",
        readTools: ["agents_search", "broker_feed"],
        writeTools: ["messages_send", "ask"],
        shell: false,
        codebaseWrites: false,
      },
      runtimePolicy: {
        approvalPolicy: "never",
        sandbox: "read-only",
        shellTool: false,
      },
      brokerActivity: [expect.objectContaining({
        id: "msg-scout",
        kind: "message",
        summary: "I dispatched the review.",
      })],
    });
  });

  test("returns batched observe payloads for the requested agent ids", async () => {
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });
    const response = await server.app.request(
      "http://localhost/api/observe/agents?ids=agent-1,agent-2",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  test("coalesces concurrent observe requests for the same actor", async () => {
    stubs.agentObservePayloadResult = {
      agentId: "agent-1",
      sessionId: "thread-1",
      data: { live: true, events: [] },
    };
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });
    const url = "http://localhost/api/agents/agent-1/observe?sessionId=thread-1";

    const [first, second] = await Promise.all([
      server.app.request(url),
      server.app.request(url),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(stubs.loadAgentObservePayloadCalls).toBe(1);
  });

  test("bounds the observe response cache", async () => {
    stubs.agentObservePayloadResult = {
      agentId: "agent",
      sessionId: "thread",
      data: { live: true, events: [] },
    };
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    for (let index = 0; index < 33; index += 1) {
      const response = await server.app.request(
        `http://localhost/api/agents/agent-${index}/observe`,
      );
      expect(response.status).toBe(200);
    }
    expect(stubs.loadAgentObservePayloadCalls).toBe(33);

    const evicted = await server.app.request(
      "http://localhost/api/agents/agent-0/observe",
    );
    expect(evicted.status).toBe(200);
    expect(stubs.loadAgentObservePayloadCalls).toBe(34);
  });

  test("serves a session actor's trace through the session-ref fallback", async () => {
    stubs.agentObservePayloadResult = null;
    stubs.sessionRefObservePayloadResult = {
      kind: "broker",
      refId: "session-actor-1",
      agentId: null,
      source: "history",
      fidelity: "synthetic",
      historyPath: null,
      sessionId: "thread-1",
      updatedAt: Date.now(),
      data: { live: true, events: [] },
    };
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const response = await server.app.request(
      "http://localhost/api/agents/session-actor-1/observe",
    );

    expect(response.status).toBe(200);
    const payload = await response.json() as { agentId?: string | null; sessionId?: string };
    // The native decoder requires a string agentId; the route echoes the
    // requested id when the session-ref payload carries none.
    expect(payload.agentId).toBe("session-actor-1");
    expect(payload.sessionId).toBe("thread-1");
  });

  test("returns 404 when neither agent nor session-ref observe resolves", async () => {
    stubs.agentObservePayloadResult = null;
    stubs.sessionRefObservePayloadResult = null;
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const response = await server.app.request(
      "http://localhost/api/agents/session-actor-unknown/observe",
    );

    expect(response.status).toBe(404);
  });

  test("does not advertise terminal takeover for protocol-backed sessions", async () => {
    stubs.queryAgentsResult = [
      {
        id: "agent-1",
        name: "Codex Relay",
        harness: "codex",
        transport: "codex_app_server",
        harnessSessionId: "codex-thread-1",
        cwd: "/tmp/project",
        projectRoot: "/tmp/project",
      },
    ];
    stubs.scoutBrokerContextResult = {
      snapshot: {
        endpoints: {
          "endpoint-1": {
            id: "endpoint-1",
            agentId: "agent-1",
            nodeId: "node-1",
            harness: "codex",
            transport: "codex_app_server",
            state: "active",
            sessionId: "codex-thread-1",
            cwd: "/tmp/project",
            projectRoot: "/tmp/project",
            metadata: {
              threadPath: "/tmp/project/.codex/thread.jsonl",
            },
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
      "http://localhost/api/agents/agent-1/session-catalog",
    );

    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      activeSessionId: "codex-thread-1",
      resumeCommand: "codex resume -C /tmp/project codex-thread-1",
    });
    expect(body.sessions).toEqual([
      expect.objectContaining({
        id: "codex-thread-1",
        transport: "codex_app_server",
        canObserve: true,
        canTakeover: false,
      }),
    ]);
  });

  test("advertises terminal takeover only for CLI resume transports", async () => {
    stubs.queryAgentsResult = [
      {
        id: "agent-1",
        name: "Codex CLI",
        harness: "codex",
        transport: "codex_exec",
        harnessSessionId: "codex-thread-1",
        cwd: "/tmp/project",
        projectRoot: "/tmp/project",
      },
    ];
    stubs.scoutBrokerContextResult = {
      snapshot: {
        endpoints: {
          "endpoint-1": {
            id: "endpoint-1",
            agentId: "agent-1",
            nodeId: "node-1",
            harness: "codex",
            transport: "codex_exec",
            state: "active",
            sessionId: "codex-thread-1",
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

    const response = await server.app.request(
      "http://localhost/api/agents/agent-1/session-catalog",
    );

    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body.sessions).toEqual([
      expect.objectContaining({
        id: "codex-thread-1",
        transport: "codex_exec",
        canTakeover: true,
      }),
    ]);
  });

  test("serves a bounded tmux peek for a broker-backed agent", async () => {
    stubs.queryAgentsResult = [
      {
        id: "agent-1",
        name: "Claude Relay",
        harness: "claude",
        transport: "tmux",
        harnessSessionId: "fallback-session",
        cwd: "/tmp/project",
        projectRoot: "/tmp/project",
      },
    ];
    stubs.scoutBrokerContextResult = {
      snapshot: {
        endpoints: {
          "endpoint-1": {
            id: "endpoint-1",
            agentId: "agent-1",
            nodeId: "node-1",
            harness: "claude",
            transport: "tmux",
            state: "active",
            sessionId: "tmux-session",
            pane: "%3",
            cwd: "/tmp/project",
            metadata: {
              tmuxSession: "tmux-session",
            },
          },
        },
      },
    };
    const captureCalls: Array<Record<string, unknown>> = [];
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
      captureTmuxPane: (request) => {
        captureCalls.push(request);
        return { body: "\x1B[32mWorking\x1B[0m\nDone\n\n" };
      },
    });

    const response = await server.app.request(
      "http://localhost/api/agents/agent-1/tmux-peek?lines=12&cols=60",
    );

    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      available: true,
      agentId: "agent-1",
      sessionId: "tmux-session",
      lineCount: 12,
      columnCount: 60,
      truncated: false,
      reason: null,
    });
    const rows = String(body.body).split("\n");
    expect(rows).toHaveLength(12);
    expect(rows.every((row) => Array.from(row).length === 60)).toBe(true);
    expect(rows.slice(0, 9).every((row) => row === " ".repeat(60))).toBe(true);
    expect(rows.at(-3)?.trimEnd()).toBe("Working");
    expect(rows.at(-2)?.trimEnd()).toBe("Done");
    expect(rows.at(-1)?.trimEnd()).toBe("");
    expect(typeof body.capturedAt).toBe("number");
    expect(captureCalls).toEqual([
      expect.objectContaining({
        agentId: "agent-1",
        sessionId: "tmux-session",
        paneTarget: "%3",
        cwd: "/tmp/project",
        lines: 12,
        columns: 60,
      }),
    ]);
  });

  test("projects active Claude tmux permission prompts into agent and operator attention", async () => {
    useIsolatedOpenScoutHome();
    const agentId = "paper-screen-fable.work-hud-013-voice-settings.arachs-mac-mini-local";
    const sessionId = "relay-paper-screen-fable-work-hud-013-voice-settings-arachs-mac-mini-local-claude";
    stubs.queryAgentsResult = [{
      id: agentId,
      definitionId: "paper-screen-fable",
      name: "Paper Screen Fable",
      handle: "paper-screen-fable",
      agentClass: "general",
      harness: "claude",
      state: "working",
      projectRoot: "/Users/arach/dev/hudson",
      cwd: "/Users/arach/dev/hudson",
      updatedAt: 1_700_000_000_000,
      createdAt: 1_700_000_000_000,
      transport: "tmux",
      selector: "@paper-screen-fable",
      defaultSelector: "@paper-screen-fable",
      nodeQualifier: "arachs-mac-mini-local",
      workspaceQualifier: "work-hud-013-voice-settings",
      wakePolicy: "on_demand",
      capabilities: ["chat", "invoke", "deliver"],
      project: "Hudson",
      branch: "work/hud-013-voice-settings",
      role: "Agent",
      model: "fable",
      harnessSessionId: null,
      terminalSurface: {
        backend: "tmux",
        sessionName: sessionId,
        paneId: sessionId,
        socketDir: null,
      },
      harnessLogPath: null,
      conversationId: null,
      authorityNodeId: null,
      authorityNodeName: null,
      homeNodeId: null,
      homeNodeName: null,
      ownerId: null,
      ownerName: null,
      ownerHandle: null,
      staleLocalRegistration: false,
      retiredFromFleet: false,
      replacedByAgentId: null,
    }];
    const captureTmuxPane = () => ({
      body: `
 Bash command

   curl -s http://127.0.0.1:29980/api/files

 Permission rule Bash(curl:*) requires confirmation for this command.
 /permissions to update rules

 Do you want to proceed?
   1. Yes
 ❯ 2. No

 Esc to cancel · Tab to amend · ctrl+e to explain
`,
    });
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
      captureTmuxPane,
    });

    const agentResponse = await server.app.request("http://localhost/api/agents?attention=1");
    const agents = await agentResponse.json() as Array<{ id: string; state: string; pendingAsk?: string }>;
    expect(agents.find((agent) => agent.id === agentId)).toMatchObject({
      state: "needs_attention",
      pendingAsk: "Permission rule Bash(curl:*) requires confirmation.",
    });

    const brokerContextCallsBeforeSummary = stubs.loadScoutBrokerContextCalls;
    const summaryResponse = await server.app.request(
      "http://localhost/api/agents?detail=summary&attention=1",
    );
    const summaryAgents = await summaryResponse.json() as Array<{
      id: string;
      state: string;
      pendingAsk?: string;
    }>;
    expect(summaryAgents.find((agent) => agent.id === agentId)).toMatchObject({
      state: "needs_attention",
      pendingAsk: "Permission rule Bash(curl:*) requires confirmation.",
    });
    expect(stubs.loadScoutBrokerContextCalls).toBe(brokerContextCallsBeforeSummary);

    const attentionResponse = await server.app.request("http://localhost/api/operator-attention");
    const attention = await attentionResponse.json() as {
      items: Array<{
        id: string;
        agentId: string | null;
        title: string;
        actions: Array<{ kind: string; route?: Record<string, string> }>;
      }>;
    };
    expect(attention.items.find((item) => item.agentId === agentId)).toMatchObject({
      id: `tmux-host-permission:${agentId}:${sessionId}`,
      title: "Claude needs permission",
      actions: [{
        kind: "open",
        route: { view: "terminal", agentId, mode: "takeover" },
      }],
    });
  });

  test("native host destinations forward to the chosen peer and fail closed", async () => {
    const calls: Array<{ path: string; method: string; body: string }> = [];
    const machine = makePortalPeerMachine({
      id: "mach-native-peer", name: "mini", scoutNodeId: "node-mini",
      capabilities: ["scout-broker", "scout-web"],
      lastSeenAt: Date.now(),
      routes: [{ kind: "lan", host: "192.168.1.40", lastSeenAt: Date.now() }],
    });
    let fail = false;
    let peerAddress = "127.0.0.1";
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout", assetMode: "static", staticRoot: makeStaticRoot(),
      portalHost: "scout.local", authToken: "native-test", resolvePeerAddress: () => peerAddress,
      portalMachines: async () => [machine],
      hostWebRequest: async (input) => {
        if (fail) throw new Error("route unavailable");
        expect(input.nodeId).toBe("node-mini");
        calls.push({ path: input.path, method: input.method, body: input.body ? JSON.stringify(input.body) : "" });
        return { status: 200, body: { destination: "mini" } };
      },
    });
    const request = (path: string, init?: RequestInit) => server.app.request(
      `http://localhost/api/hosts/mach-native-peer/${path}`, {
        ...init, headers: { authorization: "Bearer native-test", ...Object.fromEntries(new Headers(init?.headers)) },
      });
    expect((await server.app.request("http://localhost/api/hosts/mach-native-peer/api/runner/options")).status).toBe(401);
    expect((await request("api/runner/options")).status).toBe(200);
    expect((await request("api/sessions", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: { projectPath: "/remote/project" } }) })).status).toBe(200);
    expect((await request("api/messages?conversationId=remote-chat")).status).toBe(200);
    expect(calls.map(c => c.path)).toEqual(["/api/runner/options", "/api/sessions", "/api/messages?conversationId=remote-chat"]);
    expect(JSON.parse(calls[1].body).target.projectPath).toBe("/remote/project");
    expect(calls[1].method).toBe("POST");
    expect((await request("api/hosts/another/api/sessions")).status).toBe(400);
    expect((await request("api/sessions", { method: "DELETE" })).status).toBe(405);
    expect((await server.app.request("http://localhost/api/hosts/unknown/api/sessions", { method: "POST", headers: { authorization: "Bearer native-test" } })).status).toBe(404);
    machine.capabilities = ["scout-web"];
    expect((await request("api/sessions", { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).status).toBe(409);
    machine.capabilities = ["scout-web", "scout-broker"];
    fail = true;
    expect((await request("api/sessions", { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).status).toBe(502);
    peerAddress = "192.168.1.90";
    const denied = await request("api/sessions", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect([403, 404]).toContain(denied.status);
    expect(calls).toHaveLength(3);
  });

  test("loads and updates local agent config through the web API", async () => {
    const home = useIsolatedOpenScoutHome();
    const projectRoot = join(home, "dev", "openscout");
    mkdirSync(projectRoot, { recursive: true });
    await writeRelayAgentOverrides({
      scoutbot: {
        agentId: "scoutbot",
        definitionId: "scoutbot",
        displayName: "Scoutbot",
        projectName: "OpenScout",
        projectRoot,
        source: "manual",
        systemPrompt: "Scoutbot prompt",
        launchArgs: ["--color", "never", "--model", "gpt-5.3-codex"],
        runtime: {
          cwd: projectRoot,
          harness: "codex",
          transport: "codex_app_server",
          sessionId: "scoutbot-codex",
          wakePolicy: "on_demand",
        },
      },
    });
    const agentId = buildRelayAgentInstance("scoutbot", projectRoot).id;
    const server = await createOpenScoutWebServer({
      currentDirectory: projectRoot,
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const getResponse = await server.app.request(
      `http://localhost/api/agents/${agentId}/config`,
    );
    expect(getResponse.status).toBe(200);
    expect(await getResponse.json()).toMatchObject({
      model: "gpt-5.3-codex",
      systemPrompt: "Scoutbot prompt",
    });

    const postResponse = await server.app.request(
      `http://localhost/api/agents/${agentId}/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.4-mini",
          systemPrompt: "Updated Scoutbot prompt",
          restart: false,
        }),
      },
    );

    expect(postResponse.status).toBe(200);
    const postJson = await postResponse.json() as {
      config: { model: string | null; systemPrompt: string; launchArgs: string[] };
      restarted: boolean;
    };
    expect(postJson).toMatchObject({
      restarted: false,
      config: {
        model: "gpt-5.4-mini",
        systemPrompt: "Updated Scoutbot prompt",
      },
    });
    expect(postJson.config.launchArgs.join("\n")).toContain("gpt-5.4-mini");
    expect(postJson.config.launchArgs.join("\n")).not.toContain("gpt-5.3-codex");
  });

  test("serves fast HUD runner options with runtime and effort controls", async () => {
    const home = useIsolatedOpenScoutHome();
    process.env.OPENSCOUT_HOME = join(home, ".openscout");
    const projectRoot = mkdtempSync(join(tmpdir(), "openscout-runner-project-"));
    testDirectories.add(projectRoot);
    writeFileSync(join(projectRoot, "package.json"), "{\"name\":\"runner-project\"}\n", "utf8");
    stubs.queryAgentsResult = [
      {
        id: "agent-1",
        name: "Agent One",
        handle: "agent-one",
        state: "working",
        harness: "claude",
        model: "claude-opus-5",
        projectRoot,
        cwd: projectRoot,
        harnessSessionId: "session-1",
      },
      {
        id: "agent-observed",
        name: "Observed Codex",
        state: "available",
        harness: "codex",
        model: "gpt-custom",
        projectRoot,
        cwd: projectRoot,
      },
    ];
    const server = await createOpenScoutWebServer({
      currentDirectory: projectRoot,
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const response = await server.app.request("http://localhost/api/runner/options");

    expect(response.status).toBe(200);
    const payload = await response.json() as {
      defaults: {
        directory: string;
        harness: string;
        model: string;
        reasoningEffort: string;
        persistence: string;
      };
      defaultsByHarness: Record<string, { model: string | null; reasoningEffort: string | null }>;
      runners: Array<{ id: string; supports: string[] }>;
      harnesses: Array<{ id: string; label: string }>;
      models: Array<{ id: string; label: string; family?: string; version?: string; harnesses: string[] }>;
      efforts: Array<{ id: string; label: string; harnesses: string[]; models?: string[] }>;
      projects: Array<{ title: string; root: string }>;
      agents: Array<{ id: string; projectRoot: string | null; harnessSessionId: string | null }>;
    };
    expect(payload.defaults).toEqual(expect.objectContaining({
      directory: projectRoot,
      harness: "claude",
      model: "claude-opus-5-5",
      reasoningEffort: "medium",
      persistence: "sticky",
    }));
    expect(payload.catalogVersion).toBe("openscout.runtime-catalog.v1");
    expect(payload.defaultsByHarness.codex).toEqual({
      model: "gpt-6-astra",
      reasoningEffort: "low",
    });
    expect(payload.runners).toContainEqual(expect.objectContaining({
      id: "scout",
      supports: expect.arrayContaining(["claude", "codex"]),
    }));
    expect(payload.harnesses.map((entry) => entry.id)).toEqual(expect.arrayContaining(["claude", "codex"]));
    expect(payload.harnesses.map((entry) => entry.id)).not.toContain("grok");
    expect(payload.harnesses).toContainEqual(expect.objectContaining({ id: "grok-acp", label: "Grok" }));
    expect(payload.models).toContainEqual(expect.objectContaining({
      id: "claude-opus-5",
      family: "Opus",
      version: "5",
      harnesses: ["claude"],
    }));
    expect(payload.models.some((entry) => entry.harnesses.includes("codex"))).toBe(true);
    expect(payload.models.some((entry) => entry.id === "gpt-custom")).toBe(false);
    expect(new Set(payload.models.map((entry) => `${entry.harnesses.join(",")}:${entry.id}`)).size)
      .toBe(payload.models.length);
    expect(payload.models.some((entry) => entry.id.startsWith("gpt-5.4"))).toBe(false);
    expect(payload.efforts.map((entry) => entry.id)).toEqual(expect.arrayContaining(["medium", "high", "xhigh"]));
    expect(payload.efforts).toContainEqual(expect.objectContaining({
      id: "low",
      label: "Light",
    }));
    expect(payload.efforts).toContainEqual(expect.objectContaining({
      id: "xhigh",
      label: "Extra High",
    }));
    expect(payload.efforts.some((entry) => entry.harnesses.includes("codex"))).toBe(true);
    expect(payload.projects).toContainEqual(expect.objectContaining({ root: projectRoot }));
    expect(payload.agents).toContainEqual(expect.objectContaining({
      id: "agent-1",
      projectRoot,
      harnessSessionId: "session-1",
    }));
  });

  test("runner options layer project, user, and harness-native runtime lists", async () => {
    globalThis.fetch = (async () => Response.json({ catalog: SCOUT_RUNTIME_CATALOG, warnings: [], localCodexModels: {
      state: "verified", models: SCOUT_RUNTIME_CATALOG.harnesses.find((entry) => entry.id === "codex")!.models.map((model) => ({
        id: model.id, model: model.id, isDefault: model.default === true, hidden: false,
        supportedReasoningEfforts: model.reasoningEfforts ?? ["low", "medium", "high", "xhigh"],
      })),
    } })) as typeof fetch;
    const home = useIsolatedOpenScoutHome();
    process.env.OPENSCOUT_HOME = join(home, ".openscout");
    mkdirSync(process.env.OPENSCOUT_HOME, { recursive: true });
    writeFileSync(join(process.env.OPENSCOUT_HOME, "user.json"), JSON.stringify({
      runtimeShortlist: ["codex/gpt-5.6-sol"],
      runtimePresets: [{ id: "spark", label: "Spark", runtime: "codex/gpt-5.6-sol/high" }],
    }), "utf8");

    const projectRoot = mkdtempSync(join(tmpdir(), "openscout-runner-lists-"));
    testDirectories.add(projectRoot);
    writeFileSync(join(projectRoot, "package.json"), "{\"name\":\"runner-lists\"}\n", "utf8");
    mkdirSync(join(projectRoot, ".openscout"), { recursive: true });
    writeFileSync(join(projectRoot, ".openscout", "project.json"), JSON.stringify({
      version: 1,
      project: { id: "runner-lists", name: "Runner Lists", root: "." },
      agent: {
        id: "runner-lists",
        runtime: {
          shortlist: ["claude/claude-opus-5"],
          presets: [{ id: "fusion", runtime: "claude/claude-fable-5/medium" }],
        },
      },
    }), "utf8");

    // Harness-native layer: codex config.toml supplies a default model and a
    // profile; claude settings.json supplies an alias that is not a catalog id
    // and must drop silently.
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), [
      'model = "gpt-6-astra"',
      "",
      "[profiles.deep]",
      'model = "gpt-5.6-sol"',
      'model_reasoning_effort = "high"',
    ].join("\n"), "utf8");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ model: "opus" }), "utf8");

    const server = await createOpenScoutWebServer({
      currentDirectory: projectRoot,
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const response = await server.app.request("http://localhost/api/runner/options");
    expect(response.status).toBe(200);
    const payload = await response.json() as {
      shortlist: Array<{ harness: string; model: string; origin: string }>;
      presets: Array<{ id: string; harness: string; model?: string; effort?: string; origin: string }>;
      warnings?: string[];
    };

    // project → user → harness ordering, dedupe by harness+model.
    expect(payload.shortlist).toEqual([
      { harness: "claude", model: "claude-opus-5", origin: "project" },
      { harness: "codex", model: "gpt-5.6-sol", origin: "user" },
      { harness: "codex", model: "gpt-6-astra", origin: "harness-default" },
    ]);
    // The claude "opus" alias is not a catalog id — dropped, not warned.
    expect(payload.shortlist.some((entry) => entry.model === "opus")).toBe(false);

    const presetIds = payload.presets.map((preset) => preset.id);
    expect(presetIds.slice(0, 2)).toEqual(["fusion", "spark"]);
    expect(payload.presets).toContainEqual(expect.objectContaining({
      id: "deep",
      harness: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      origin: "harness-profile",
    }));
    expect(payload.presets).toContainEqual(expect.objectContaining({
      id: "fable",
      harness: "claude",
      origin: "broker-profile",
    }));
    // The `oc` alias must not produce a second opencode preset.
    expect(presetIds.filter((id) => id === "oc")).toHaveLength(0);
    expect(presetIds.filter((id) => id === "opencode")).toHaveLength(1);
  });

  test("serves models from scoutd's refreshed runtime catalog without a web rebuild", async () => {
    const liveCatalog = {
      ...SCOUT_RUNTIME_CATALOG,
      revision: "2026-08-12.2",
      harnesses: SCOUT_RUNTIME_CATALOG.harnesses.map((harness) => harness.id === "grok"
        ? {
            ...harness,
            models: [{
              id: "grok-next-live",
              label: "Grok Next Live",
              enabled: true,
              default: true,
              family: "Grok",
              version: "Next",
            }, ...harness.models.map((model) => ({ ...model, default: false }))],
          }
        : harness),
    };
    globalThis.fetch = (async (input) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      return url.pathname === "/v1/runtime-catalog"
        ? Response.json({ catalog: liveCatalog, warnings: [] })
        : new Response(null, { status: 404 });
    }) as typeof fetch;
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
      backgroundServices: false,
    });

    const response = await server.app.request("http://localhost/api/runner/options");
    const payload = await response.json() as {
      catalogRevision: string;
      defaultsByHarness: Record<string, { model: string | null }>;
      models: Array<{ id: string; harnesses: string[] }>;
    };

    expect(response.status).toBe(200);
    expect(payload.catalogRevision).toBe("2026-08-12.2");
    expect(payload.defaultsByHarness.grok?.model).toBe("grok-next-live");
    expect(payload.models).toContainEqual(expect.objectContaining({
      id: "grok-next-live",
      harnesses: ["grok"],
    }));
  });

  test("defaults HUD runner options to a known project when process cwd is not a project", async () => {
    const home = useIsolatedOpenScoutHome();
    process.env.OPENSCOUT_HOME = join(home, ".openscout");
    const launcherDirectory = mkdtempSync(join(tmpdir(), "openscout-runner-launcher-"));
    testDirectories.add(launcherDirectory);
    const projectRoot = join(home, "dev", "runner-project");
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(join(projectRoot, "package.json"), "{\"name\":\"runner-project\"}\n", "utf8");
    stubs.queryAgentsResult = [{
      id: "agent-1",
      name: "Agent One",
      harness: "claude",
      model: "claude-opus-5",
      projectRoot,
      cwd: projectRoot,
    }];
    const server = await createOpenScoutWebServer({
      currentDirectory: launcherDirectory,
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const response = await server.app.request("http://localhost/api/runner/options");
    const payload = await response.json() as {
      defaults: { directory: string };
      projects: Array<{ root: string }>;
    };

    expect(response.status).toBe(200);
    expect(payload.defaults.directory).toBe(projectRoot);
    expect(payload.projects).toContainEqual(expect.objectContaining({ root: projectRoot }));
    expect(payload.projects.some((project) => project.root === launcherDirectory)).toBe(false);
  });

  test("keeps project-path ask routing when session initiation targets an existing agent", async () => {
    process.env.OPENSCOUT_OPERATOR_NAME = "operator";
    stubs.queryAgentsResult = [
      {
        id: "agent-1",
        definitionId: "agent-1",
        name: "Hudson",
        projectRoot: "/tmp/openscout",
        cwd: "/tmp/openscout",
        harness: "codex",
        model: "gpt-test",
      },
    ];
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/fallback",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const response = await server.app.request("http://localhost/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        target: { agentId: "agent-1" },
        seed: { instructions: "Please take this on." },
      }),
    });

    expect(response.status).toBe(200);
    expect(askScoutQuestionCalls).toHaveLength(1);
    expect(askScoutQuestionCalls[0]).toMatchObject({
      senderId: "operator",
      target: { kind: "project_path", projectPath: "/tmp/openscout" },
      targetAgentId: "agent-1",
      body: "Please take this on.",
      executionHarness: "codex",
      executionModel: "gpt-test",
      currentDirectory: "/tmp/openscout",
      source: "scout-session-initiation",
    });
    expect(askScoutQuestionCalls[0]).not.toHaveProperty("targetLabel");
  });

  test("routes cross-harness session initiation as a project handoff instead of the existing agent", async () => {
    process.env.OPENSCOUT_OPERATOR_NAME = "operator";
    stubs.queryAgentsResult = [
      {
        id: "agent-1",
        definitionId: "agent-1",
        name: "Hudson",
        projectRoot: "/tmp/openscout",
        cwd: "/tmp/openscout",
        harness: "claude",
        model: "sonnet-test",
      },
    ];
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/fallback",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const response = await server.app.request("http://localhost/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        target: { agentId: "agent-1", projectPath: "/tmp/openscout" },
        execution: { session: "new", harness: "codex", model: "gpt-test" },
        seed: { instructions: "Please take this from Codex." },
      }),
    });

    expect(response.status).toBe(200);
    expect(askScoutQuestionCalls).toHaveLength(1);
    expect(askScoutQuestionCalls[0]).toMatchObject({
      senderId: "operator",
      target: { kind: "project_path", projectPath: "/tmp/openscout" },
      body: "Please take this from Codex.",
      executionHarness: "codex",
      executionModel: "gpt-test",
      currentDirectory: "/tmp/openscout",
      source: "scout-session-initiation",
    });
    expect(askScoutQuestionCalls[0]).not.toHaveProperty("targetAgentId");
    expect(askScoutQuestionCalls[0]).not.toHaveProperty("targetLabel");
    expect(askScoutQuestionCalls[0]).toHaveProperty("projectAgent");
    expect((askScoutQuestionCalls[0].projectAgent as Record<string, unknown>).handle).not.toBe("Hudson");
  });

  test("anchors session initiation conversations when seeded from a message", async () => {
    process.env.OPENSCOUT_OPERATOR_NAME = "operator";
    stubs.queryConversationDefinitionByIdImpl = (conversationId) => {
      if (conversationId !== "c.agent-1") return null;
      return {
        id: "c.agent-1",
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
        agents: {},
        actors: {},
        endpoints: {},
        conversations: {
          "c.parent": {
            id: "c.parent",
            kind: "direct",
            title: "Parent",
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

    const response = await server.app.request("http://localhost/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        target: { projectPath: "/tmp/openscout" },
        seed: {
          instructions: "Follow this side question.",
          fromConversationId: "c.parent",
          fromMessageId: "msg-anchor",
        },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      conversationId: "c.agent-1",
      anchoredConversationId: "c.agent-1",
      provenance: {
        fromConversationId: "c.parent",
        fromMessageId: "msg-anchor",
      },
    });
    expect(upsertScoutConversationCalls).toEqual([
      expect.objectContaining({
        id: "c.agent-1",
        parentConversationId: "c.parent",
        messageId: "msg-anchor",
      }),
    ]);
  });

  test("keeps session initiation successful when the source message anchor is missing", async () => {
    process.env.OPENSCOUT_OPERATOR_NAME = "operator";
    stubs.queryConversationDefinitionByIdImpl = (conversationId) => {
      if (conversationId !== "c.agent-1") return null;
      return {
        id: "c.agent-1",
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
        agents: {},
        actors: {},
        endpoints: {},
        conversations: {
          "c.parent": {
            id: "c.parent",
            kind: "direct",
            title: "Parent",
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

    const response = await server.app.request("http://localhost/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        target: { projectPath: "/tmp/openscout" },
        seed: {
          instructions: "Follow this side question.",
          fromConversationId: "c.parent",
          fromMessageId: "msg-missing",
        },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      conversationId: "c.agent-1",
      anchoredConversationId: null,
      anchorError: "could not anchor session conversation: Message msg-missing is not available.",
      provenance: {
        fromConversationId: "c.parent",
        fromMessageId: "msg-missing",
      },
    });
    expect(upsertScoutConversationCalls).toEqual([]);
  });

  test("keeps session initiation successful without anchoring when the source message is in another chat", async () => {
    process.env.OPENSCOUT_OPERATOR_NAME = "operator";
    stubs.queryConversationDefinitionByIdImpl = (conversationId) => {
      if (conversationId !== "c.agent-1") return null;
      return {
        id: "c.agent-1",
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
        agents: {},
        actors: {},
        endpoints: {},
        conversations: {
          "c.parent": {
            id: "c.parent",
            kind: "direct",
            title: "Parent",
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

    const response = await server.app.request("http://localhost/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        target: { projectPath: "/tmp/openscout" },
        seed: {
          instructions: "Follow this side question.",
          fromConversationId: "c.parent",
          fromMessageId: "msg-anchor",
        },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      conversationId: "c.agent-1",
      anchoredConversationId: null,
      anchorError: "could not anchor session conversation: Message msg-anchor is not in conversation c.parent.",
      provenance: {
        fromConversationId: "c.parent",
        fromMessageId: "msg-anchor",
      },
    });
    expect(upsertScoutConversationCalls).toEqual([]);
  });

  test("rejects session initiation fork without a source", async () => {
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const response = await server.app.request("http://localhost/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        target: { projectPath: "/tmp/openscout" },
        execution: { session: "fork", harness: "codex" },
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "session 'fork' requires execution.forkFromSessionId or execution.forkFromStateId",
    });
    expect(askScoutQuestionCalls).toEqual([]);
  });
});

test("published Codex choices submit without installed model discovery, and Default omits overrides", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "openscout-codex-published-"));
  testDirectories.add(projectRoot);
  let catalogReads = 0;
  globalThis.fetch = (async (input) => {
    if (String(input).includes("/v1/runtime-catalog")) catalogReads++;
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  const server = await createOpenScoutWebServer({ currentDirectory: projectRoot, assetMode: "static", staticRoot: makeStaticRoot(), backgroundServices: false });
  const start = (model?: string) => server.app.request("/api/sessions", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ target: { projectPath: projectRoot }, execution: { harness: "codex", ...(model ? { model, reasoningEffort: "high" } : {}) }, seed: { instructions: "Keep this draft" } }) });
  expect((await start("gpt-6.1-sol")).status).toBe(200);
  expect(askScoutQuestionCalls[0]?.executionModel).toBe("gpt-6.1-sol");
  expect(askScoutQuestionCalls[0]?.executionReasoningEffort).toBe("high");
  expect((await start()).status).toBe(200);
  expect(askScoutQuestionCalls[1]).not.toHaveProperty("executionModel");
  expect(askScoutQuestionCalls[1]).not.toHaveProperty("executionReasoningEffort");
  expect(catalogReads).toBe(0);
});

test("named Codex targets retain their execution context even when their path also exists locally", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "openscout-codex-shared-peer-path-"));
  testDirectories.add(projectRoot);
  stubs.queryAgentsResult = [
    { id: "peer-agent", name: "Peer", harness: "codex", projectRoot, cwd: projectRoot, authorityNodeId: "peer-node", model: "remote-model" },
    { id: "local-agent", name: "Local custom context", harness: "codex", projectRoot: null, cwd: projectRoot, authorityNodeId: "node-1", model: "custom-home-model" },
  ];
  let localCatalogReads = 0;
  globalThis.fetch = (async (input) => {
    if (String(input).includes("/v1/runtime-catalog")) localCatalogReads++;
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  const server = await createOpenScoutWebServer({ currentDirectory: projectRoot, assetMode: "static", staticRoot: makeStaticRoot(), backgroundServices: false });
  for (const target of stubs.queryAgentsResult) {
    const response = await server.app.request("/api/sessions", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: { agentId: target.id }, execution: { harness: "codex", session: "new" }, seed: { instructions: "Use this target's context" } }) });
    expect(response.status).toBe(200);
  }
  expect(localCatalogReads).toBe(0);
  expect(askScoutQuestionCalls.map((call) => call.targetAgentId)).toEqual(["peer-agent", "local-agent"]);
});

test("manual model refresh bypasses the web options cache and exposes new published choices", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "openscout-refresh-models-"));
  testDirectories.add(projectRoot);
  const catalog = structuredClone(SCOUT_RUNTIME_CATALOG);
  catalog.revision = "2099-01-01.1";
  const codex = catalog.harnesses.find((harness) => harness.id === "codex")!;
  codex.models = codex.models.map((model) => ({ ...model, enabled: false, default: false }));
  codex.models.push({ id: "gpt-published-next", label: "Published Next", enabled: true, default: true, reasoningEfforts: ["high"] });
  const forceQueries: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    if (url.pathname !== "/v1/runtime-catalog") return new Response(null, { status: 404 });
    forceQueries.push(url.searchParams.get("force") ?? "");
    return Response.json({ catalog: url.searchParams.has("force") ? catalog : SCOUT_RUNTIME_CATALOG,
      source: "remote", checkedAt: 1_000, warnings: [] });
  }) as typeof fetch;
  const server = await createOpenScoutWebServer({ currentDirectory: projectRoot, assetMode: "static", staticRoot: makeStaticRoot(), backgroundServices: false });
  await server.app.request("/api/runner/options");
  const refreshed = await server.app.request("/api/runner/options?force=true");
  expect(refreshed.status).toBe(200);
  const payload = await refreshed.json() as { models: Array<{ id: string }>; catalogRevision: string; source: string; checkedAt: number };
  expect(forceQueries).toEqual(["", "true"]);
  expect(payload.catalogRevision).toBe(catalog.revision);
  expect(payload.source).toBe("remote");
  expect(payload.checkedAt).toBe(1_000);
  expect(payload.models.some((model) => model.id === "gpt-published-next")).toBe(true);
  expect(payload.models.some((model) => model.id === "gpt-6-astra")).toBe(false);
  const cached = await (await server.app.request("/api/runner/options")).json() as typeof payload;
  expect(cached.catalogRevision).toBe(catalog.revision);
  expect(forceQueries).toEqual(["", "true"]);
  const submitted = await server.app.request("/api/sessions", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ target: { projectPath: projectRoot }, execution: { harness: "codex", model: "gpt-published-next", reasoningEffort: "high" }, seed: { instructions: "Use published data" } }) });
  expect(submitted.status).toBe(200);
  expect(askScoutQuestionCalls[0]?.executionModel).toBe("gpt-published-next");
});
