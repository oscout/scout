import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LOCAL_CONFIG_VERSION,
  writeLocalConfig,
} from "@openscout/runtime/local-config";
import {
  resolveRelayAgentConfig,
  writeOpenScoutSettings,
  writeProjectConfig,
} from "@openscout/runtime/setup";

import {
  askScoutQuestion,
  loadScoutBrokerContext,
  loadScoutMessages,
  openScoutPeerSession,
  readScoutBrokerHealth,
  readScoutBrokerTailRecent,
  resolveScoutBrokerUrl,
  ScoutDirectDeliveryUnavailableError,
  sendScoutConversationSteer,
  sendScoutConversationMessage,
  sendScoutDirectMessage,
  sendScoutMessage,
} from "./service.ts";

const originalHome = process.env.HOME;
const originalOpenScoutHome = process.env.OPENSCOUT_HOME;
const originalSupportDirectory = process.env.OPENSCOUT_SUPPORT_DIRECTORY;
const originalControlHome = process.env.OPENSCOUT_CONTROL_HOME;
const originalRelayHub = process.env.OPENSCOUT_RELAY_HUB;
const originalBrokerUrl = process.env.OPENSCOUT_BROKER_URL;
const originalBrokerInternalUrl = process.env.OPENSCOUT_BROKER_INTERNAL_URL;
const originalBrokerSocketPath = process.env.OPENSCOUT_BROKER_SOCKET_PATH;
const originalSkipUserProjectHints = process.env.OPENSCOUT_SKIP_USER_PROJECT_HINTS;
const originalFetch = globalThis.fetch;
const testDirectories = new Set<string>();

afterEach(() => {
  process.env.HOME = originalHome;
  if (originalOpenScoutHome === undefined) {
    delete process.env.OPENSCOUT_HOME;
  } else {
    process.env.OPENSCOUT_HOME = originalOpenScoutHome;
  }
  if (originalSupportDirectory === undefined) {
    delete process.env.OPENSCOUT_SUPPORT_DIRECTORY;
  } else {
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = originalSupportDirectory;
  }
  if (originalControlHome === undefined) {
    delete process.env.OPENSCOUT_CONTROL_HOME;
  } else {
    process.env.OPENSCOUT_CONTROL_HOME = originalControlHome;
  }
  if (originalRelayHub === undefined) {
    delete process.env.OPENSCOUT_RELAY_HUB;
  } else {
    process.env.OPENSCOUT_RELAY_HUB = originalRelayHub;
  }
  if (originalBrokerUrl === undefined) {
    delete process.env.OPENSCOUT_BROKER_URL;
  } else {
    process.env.OPENSCOUT_BROKER_URL = originalBrokerUrl;
  }
  if (originalBrokerInternalUrl === undefined) {
    delete process.env.OPENSCOUT_BROKER_INTERNAL_URL;
  } else {
    process.env.OPENSCOUT_BROKER_INTERNAL_URL = originalBrokerInternalUrl;
  }
  if (originalBrokerSocketPath === undefined) {
    delete process.env.OPENSCOUT_BROKER_SOCKET_PATH;
  } else {
    process.env.OPENSCOUT_BROKER_SOCKET_PATH = originalBrokerSocketPath;
  }
  if (originalSkipUserProjectHints === undefined) {
    delete process.env.OPENSCOUT_SKIP_USER_PROJECT_HINTS;
  } else {
    process.env.OPENSCOUT_SKIP_USER_PROJECT_HINTS = originalSkipUserProjectHints;
  }
  globalThis.fetch = originalFetch;
  for (const directory of testDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  testDirectories.clear();
});

function useIsolatedOpenScoutHome(): string {
  const home = mkdtempSync(join(tmpdir(), "openscout-desktop-broker-"));
  testDirectories.add(home);
  process.env.HOME = home;
  process.env.OPENSCOUT_HOME = join(home, ".openscout");
  process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(home, "Library", "Application Support", "OpenScout");
  process.env.OPENSCOUT_CONTROL_HOME = join(home, ".openscout", "control-plane");
  process.env.OPENSCOUT_RELAY_HUB = join(home, ".openscout", "relay");
  process.env.OPENSCOUT_BROKER_URL = "http://broker.test";
  process.env.OPENSCOUT_BROKER_SOCKET_PATH = join(home, "broker.sock");
  process.env.OPENSCOUT_SKIP_USER_PROJECT_HINTS = "1";
  return home;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

describe("resolveScoutBrokerUrl", () => {
  test("uses local config host and broker port for same-machine broker API", () => {
    useIsolatedOpenScoutHome();
    writeLocalConfig({
      version: LOCAL_CONFIG_VERSION,
      host: "127.0.0.1",
      ports: { broker: 43110 },
    });
    delete process.env.OPENSCOUT_BROKER_INTERNAL_URL;
    process.env.OPENSCOUT_BROKER_URL = "http://mesh.example.test:43110";

    expect(resolveScoutBrokerUrl()).toBe("http://127.0.0.1:43110");
  });
});

describe("loadScoutBrokerContext", () => {
  test("requests a 24-hour working-set snapshot by default", async () => {
    useIsolatedOpenScoutHome();
    let snapshotSince: number | null = null;
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (url.pathname === "/v1/snapshot") {
        snapshotSince = Number(url.searchParams.get("since"));
        return jsonResponse({
          nodes: {},
          actors: {},
          agents: {},
          endpoints: {},
          conversations: {},
          bindings: {},
          messages: {},
          readCursors: {},
          invocations: {},
          flights: {},
          collaborationRecords: {},
        });
      }
      return jsonResponse({ error: "unexpected request" }, 404);
    }) as unknown as typeof fetch;

    const expectedSince = Date.now() - 24 * 60 * 60 * 1_000;
    const context = await loadScoutBrokerContext();

    expect(context?.node.id).toBe("node-1");
    expect(snapshotSince).toBeGreaterThanOrEqual(expectedSince - 60 * 1_000);
    expect(snapshotSince).toBeLessThanOrEqual(Date.now() - 24 * 60 * 60 * 1_000);
  });

  test("coalesces concurrent reads for the same bounded snapshot", async () => {
    useIsolatedOpenScoutHome();
    let snapshotRequests = 0;
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (url.pathname === "/v1/snapshot") {
        snapshotRequests += 1;
        await Bun.sleep(10);
        return jsonResponse({
          nodes: {},
          actors: {},
          agents: {},
          endpoints: {},
          conversations: {},
          bindings: {},
          messages: {},
          readCursors: {},
          invocations: {},
          flights: {},
          collaborationRecords: {},
        });
      }
      return jsonResponse({ error: "unexpected request" }, 404);
    }) as unknown as typeof fetch;

    const contexts = await Promise.all([
      loadScoutBrokerContext(undefined, { since: 1234 }),
      loadScoutBrokerContext(undefined, { since: 1234 }),
      loadScoutBrokerContext(undefined, { since: 1234 }),
    ]);

    expect(contexts.every((context) => context?.node.id === "node-1")).toBe(true);
    expect(snapshotRequests).toBe(1);
  });

  test("invalidates cached snapshots after a successful broker write", async () => {
    const home = useIsolatedOpenScoutHome();
    let snapshotRequests = 0;
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        snapshotRequests += 1;
        return jsonResponse({
          nodes: {},
          actors: {
            operator: { id: "operator", kind: "person", displayName: "Operator" },
          },
          agents: {},
          endpoints: {},
          conversations: {},
          bindings: {},
          messages: {},
          readCursors: {},
          invocations: {},
          flights: {},
          collaborationRecords: {},
        });
      }
      if (
        request.method === "POST"
        && (url.pathname === "/v1/conversations" || url.pathname === "/v1/messages")
      ) {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ error: "unexpected request" }, 404);
    }) as unknown as typeof fetch;

    await loadScoutBrokerContext();
    await sendScoutMessage({
      senderId: "operator",
      body: "Keep the first paint continuous.",
      channel: "lifecycle-cache-test",
      currentDirectory: home,
    });
    await loadScoutBrokerContext();

    expect(snapshotRequests).toBe(2);
  });
});

describe("readScoutBrokerHealth", () => {
  test("preserves broker build identity and child service states", async () => {
    useIsolatedOpenScoutHome();
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({
          ok: true,
          nodeId: "node-1",
          meshId: "mesh-1",
          build: {
            packageName: "@openscout/runtime",
            version: "0.test",
            mode: "dev",
          },
          services: {
            web: {
              managed: true,
              managedBy: "broker",
              state: "running",
              pid: 4321,
              port: 43120,
              url: "http://127.0.0.1:43120",
              healthy: null,
            },
            localEdge: {
              managed: true,
              managedBy: "base",
              state: "unknown",
              healthy: null,
            },
          },
          counts: {
            nodes: 1,
            actors: 2,
            agents: 3,
            conversations: 4,
            messages: 5,
            flights: 6,
            collaborationRecords: 7,
          },
        });
      }
      return jsonResponse({ error: "unexpected request" }, 404);
    }) as unknown as typeof fetch;

    const health = await readScoutBrokerHealth();

    expect(health.reachable).toBe(true);
    expect(health.build?.version).toBe("0.test");
    expect(health.services?.web?.state).toBe("running");
    expect(health.services?.web?.pid).toBe(4321);
    expect(health.services?.localEdge?.managedBy).toBe("base");
    expect(health.counts?.collaborationRecords).toBe(7);
  });
});

describe("readScoutBrokerTailRecent", () => {
  test("requests transcript backfill for a cold tail snapshot", async () => {
    useIsolatedOpenScoutHome();
    let requestedUrl: URL | null = null;
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requestedUrl = new URL(request.url);
      return jsonResponse({ events: [] });
    }) as typeof fetch;

    await readScoutBrokerTailRecent(50);

    expect(requestedUrl?.pathname).toBe("/v1/tail/recent");
    expect(requestedUrl?.searchParams.get("limit")).toBe("50");
    expect(requestedUrl?.searchParams.get("transcripts")).toBe("1");
  });
});

describe("askScoutQuestion", () => {
  test("registers discovered targets and lets the broker wake them on demand", async () => {
    const home = useIsolatedOpenScoutHome();
    const workspaceRoot = join(home, "dev");
    const talkieRoot = join(workspaceRoot, "talkie");

    mkdirSync(join(talkieRoot, ".git"), { recursive: true });
    writeFileSync(join(talkieRoot, "AGENTS.md"), "# talkie\n", "utf8");

    await writeOpenScoutSettings({
      discovery: {
        workspaceRoots: [workspaceRoot],
        includeCurrentRepo: false,
      },
    });

    const requests: Array<{ method: string; path: string; body?: any }> = [];
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      requests.push({ method: request.method, path: url.pathname });

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        return jsonResponse({
          actors: {},
          agents: {},
          endpoints: {},
          conversations: {},
          messages: {},
          flights: {},
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/actors") {
        return jsonResponse({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/agents") {
        return jsonResponse({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/messages") {
        return jsonResponse({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/conversations") {
        return jsonResponse({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/deliver") {
        const body = await request.json() as { requesterId: string; targetLabel: string; body: string };
        requests[requests.length - 1]!.body = body;
        return jsonResponse({
          kind: "delivery",
          accepted: true,
          routeKind: "dm",
          conversation: {
            id: "dm.operator.talkie",
            kind: "direct",
            title: "Talkie",
            visibility: "private",
            authorityNodeId: "node-1",
            participantIds: ["operator", "talkie"],
          },
          message: {
            id: "msg-1",
            conversationId: "dm.operator.talkie",
            actorId: body.requesterId,
            originNodeId: "node-1",
            class: "agent",
            body: body.body,
            visibility: "private",
            policy: "durable",
            createdAt: Date.now(),
          },
          flight: {
            id: "flt-1",
            invocationId: "inv-1",
            requesterId: body.requesterId,
            targetAgentId: "talkie",
            state: "waking",
            summary: "Talkie waking.",
            startedAt: Date.now(),
          },
        });
      }

      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    const result = await askScoutQuestion({
      senderId: "operator",
      targetLabel: "talkie",
      body: "build it for me",
      currentDirectory: workspaceRoot,
    });

    expect(result.usedBroker).toBe(true);
    expect(result.flight?.id).toBe("flt-1");
    expect(result.flight?.state).toBe("waking");
    expect(result.unresolvedTarget).toBeUndefined();
    expect(result.targetDiagnostic).toBeUndefined();
    expect(requests.some((request) => request.path === "/v1/agents")).toBe(false);
    expect(requests.some((request) => request.path === "/v1/messages")).toBe(false);
    expect(requests.some((request) => request.path === "/v1/invocations")).toBe(false);
    expect(requests.some((request) => request.path === "/v1/deliver")).toBe(true);
    expect(requests.find((request) => request.path === "/v1/deliver")?.body?.execution)
      .toEqual({ session: "new" });
    expect(requests.some((request) => request.path === "/v1/endpoints")).toBe(false);
  }, 15000);

  test("returns broker delivery rejections as structured unresolved targets", async () => {
    const home = useIsolatedOpenScoutHome();

    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        return jsonResponse({
          actors: {
            operator: {
              id: "operator",
              kind: "person",
              displayName: "Operator",
            },
          },
          agents: {},
          endpoints: {},
          conversations: {},
          messages: {},
          flights: {},
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/deliver") {
        return jsonResponse({
          kind: "rejected",
          accepted: false,
          reason: "unknown_target",
          rejection: {
            id: "dispatch-1",
            requesterId: "operator",
            kind: "unknown",
            askedLabel: "@ghost",
            detail: "no agent matches @ghost",
            candidates: [],
            dispatchedAt: Date.now(),
            dispatcherNodeId: "node-1",
          },
        }, 422);
      }

      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    const result = await askScoutQuestion({
      senderId: "operator",
      targetLabel: "ghost",
      body: "build it for me",
      currentDirectory: home,
    });

    expect(result.usedBroker).toBe(true);
    expect(result.unresolvedTarget).toBe("ghost");
    expect(result.targetDiagnostic).toEqual({
      agentId: "@ghost",
      state: "unknown",
      registrationKind: null,
      projectRoot: null,
    });
  }, 15000);

  test("preserves exact session choices for session-only handle ambiguity", async () => {
    const home = useIsolatedOpenScoutHome();
    const detail = "@composer-review matches multiple live targets: session:session-one, session:session-two; use one exact session:<id> target";

    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        return jsonResponse({
          actors: {
            operator: {
              id: "operator",
              kind: "person",
              displayName: "Operator",
            },
          },
          agents: {},
          endpoints: {},
          conversations: {},
          messages: {},
          flights: {},
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/deliver") {
        return jsonResponse({
          kind: "rejected",
          accepted: false,
          reason: "ambiguous_target",
          rejection: {
            id: "dispatch-session-ambiguity",
            requesterId: "operator",
            kind: "ambiguous",
            askedLabel: "@composer-review",
            detail,
            candidates: [],
            dispatchedAt: Date.now(),
            dispatcherNodeId: "node-1",
          },
        }, 422);
      }

      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    const result = await askScoutQuestion({
      senderId: "operator",
      target: {
        kind: "existing_handle",
        handle: "composer-review",
        value: "@composer-review",
      },
      body: "build it for me",
      currentDirectory: home,
    });

    expect(result.usedBroker).toBe(true);
    expect(result.unresolvedTarget).toBe("@composer-review");
    expect(result.targetDiagnostic).toEqual({
      state: "ambiguous",
      detail,
      candidates: [],
    });
  }, 15000);

  test("refreshes stale exact targets before asking", async () => {
    const home = useIsolatedOpenScoutHome();
    const repo = join(home, "dev", "openscout");
    mkdirSync(join(repo, ".git"), { recursive: true });
    await writeProjectConfig(repo, {
      version: 1,
      project: {
        id: "openscout",
        name: "OpenScout",
      },
      agent: {
        id: "project-agent",
      },
    });
    const configured = await resolveRelayAgentConfig("project-agent", {
      currentDirectory: repo,
    });
    expect(configured).not.toBeNull();
    const configuredAgentId = configured!.agentId;

    const requests: Array<{ method: string; path: string; body?: any }> = [];
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.json() : undefined;
      requests.push({ method: request.method, path: url.pathname, body });

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        return jsonResponse({
          actors: {
            operator: {
              id: "operator",
              kind: "person",
              displayName: "Operator",
            },
          },
          agents: {
            [configuredAgentId]: {
              id: configuredAgentId,
              kind: "agent",
              definitionId: "project-agent",
              displayName: "Project Agent",
              metadata: {
                staleLocalRegistration: true,
                projectRoot: repo,
              },
            },
          },
          endpoints: {},
          conversations: {},
          messages: {},
          flights: {},
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/actors") {
        return jsonResponse({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/agents") {
        return jsonResponse({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/deliver") {
        return jsonResponse({
          kind: "delivery",
          accepted: true,
          routeKind: "dm",
          conversation: {
            id: `dm.operator.${configuredAgentId}`,
            kind: "direct",
            title: "Project Agent",
            visibility: "private",
            authorityNodeId: "node-1",
            participantIds: ["operator", configuredAgentId],
          },
          message: {
            id: "msg-1",
            conversationId: `dm.operator.${configuredAgentId}`,
            actorId: "operator",
            originNodeId: "node-1",
            class: "agent",
            body: body.body,
            visibility: "private",
            policy: "durable",
            createdAt: Date.now(),
          },
          targetAgentId: configuredAgentId,
          flight: {
            id: "flt-1",
            invocationId: "inv-1",
            requesterId: "operator",
            targetAgentId: configuredAgentId,
            state: "waking",
          },
        });
      }

      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    const result = await askScoutQuestion({
      senderId: "operator",
      targetLabel: configuredAgentId,
      targetAgentId: configuredAgentId,
      body: "inspect state",
      currentDirectory: repo,
    });

    expect(result.usedBroker).toBe(true);
    expect(result.flight?.targetAgentId).toBe(configuredAgentId);
    expect(requests.some((request) => (
      request.method === "POST" &&
      request.path === "/v1/agents" &&
      request.body?.id === configuredAgentId &&
      request.body?.metadata?.staleLocalRegistration !== true
    ))).toBe(true);
    expect(requests.find((request) => request.path === "/v1/deliver")?.body)
      .toMatchObject({
        targetAgentId: configuredAgentId,
        targetLabel: configuredAgentId,
        execution: { session: "new" },
      });
  }, 15000);
});

describe("sendScoutMessage", () => {
  test("creates named channels with opaque conversation ids and alias metadata", async () => {
    const home = useIsolatedOpenScoutHome();
    const requests: Array<{ method: string; path: string; search: string; body?: any }> = [];
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.json() : undefined;
      requests.push({ method: request.method, path: url.pathname, search: url.search, body });

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        return jsonResponse({
          actors: {
            operator: {
              id: "operator",
              kind: "person",
              displayName: "Operator",
            },
          },
          agents: {},
          endpoints: {},
          conversations: {},
          messages: {},
          flights: {},
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/conversations") {
        return jsonResponse({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/messages") {
        return jsonResponse({ ok: true });
      }

      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    const result = await sendScoutMessage({
      senderId: "operator",
      body: "ship the channel primitive",
      channel: "talkie-next",
      currentDirectory: home,
      createdAtMs: 12345,
    });

    const conversationPost = requests.find((request) => request.path === "/v1/conversations");
    const messagePost = requests.find((request) => request.path === "/v1/messages");

    expect(result).toEqual({
      usedBroker: true,
      conversationId: conversationPost?.body?.id,
      messageId: messagePost?.body?.id,
      invokedTargets: [],
      unresolvedTargets: [],
    });
    expect(conversationPost?.body).toEqual(expect.objectContaining({
      kind: "channel",
      title: "talkie-next",
      visibility: "workspace",
      metadata: expect.objectContaining({
        channel: "talkie-next",
        naturalKey: "channel:talkie-next",
      }),
    }));
    expect(conversationPost?.body?.id).toMatch(/^chn-[0-9a-f]{32}$/);
    expect(messagePost?.body).toMatchObject({
      conversationId: conversationPost?.body?.id,
      actorId: "operator",
      body: "ship the channel primitive",
      metadata: {
        relayChannel: "talkie-next",
      },
    });
  }, 15000);
});

describe("sendScoutConversationMessage", () => {
  test("fans a group Chat post out to its agent participants without creating invocations", async () => {
    const home = useIsolatedOpenScoutHome();
    const requests: Array<{ method: string; path: string; body?: any }> = [];
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.json() : undefined;
      requests.push({ method: request.method, path: url.pathname, body });

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        return jsonResponse({
          actors: { operator: { id: "operator", kind: "person", displayName: "Operator" } },
          agents: {
            fable: { id: "fable", kind: "agent", displayName: "Fable" },
            talkie: { id: "talkie", kind: "agent", displayName: "Talkie" },
          },
          endpoints: {},
          conversations: {
            "chn-iris": {
              id: "chn-iris",
              kind: "channel",
              title: "iris-architecture",
              visibility: "workspace",
              authorityNodeId: "node-1",
              participantIds: ["operator", "fable", "talkie"],
            },
            "chn-iris-thread": {
              id: "chn-iris-thread",
              kind: "thread",
              title: "Thread · iris-architecture",
              visibility: "workspace",
              authorityNodeId: "node-1",
              participantIds: ["operator", "fable", "talkie"],
              parentConversationId: "chn-iris",
              messageId: "msg-anchor",
            },
          },
          messages: {},
          flights: {},
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/messages") {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    const result = await sendScoutConversationMessage({
      conversationId: "chn-iris",
      senderId: "operator",
      body: "Keep the first slice simple.",
      clientMessageId: "web-channel-stable-1",
      notifyParticipantAgents: true,
      currentDirectory: home,
      source: "scout-web",
    });
    const messagePost = requests.find((request) => request.path === "/v1/messages");

    expect(result.invokedTargets).toEqual([]);
    expect(result.notifiedTargets).toEqual(["fable", "talkie"]);
    expect(requests.some((request) => request.path === "/v1/invocations")).toBe(false);
    expect(messagePost?.body).toMatchObject({
      audience: { notify: ["fable", "talkie"], reason: "conversation_visibility" },
      metadata: {
        deliveryIntent: "group_message",
        relayTargetIds: ["fable", "talkie"],
        clientMessageId: "web-channel-stable-1",
      },
    });

    await sendScoutConversationMessage({
      conversationId: "chn-iris",
      senderId: "operator",
      body: "Keep the first slice simple.",
      clientMessageId: "web-channel-stable-1",
      notifyParticipantAgents: true,
      currentDirectory: home,
      source: "scout-web",
    });
    const retriedMessagePosts = requests.filter((request) => request.path === "/v1/messages");
    expect(retriedMessagePosts).toHaveLength(2);
    expect(retriedMessagePosts[0]?.body.id).toBe(retriedMessagePosts[1]?.body.id);
    expect(retriedMessagePosts[0]?.body.id).toMatch(/^m-client-/);

    requests.length = 0;
    const threadResult = await sendScoutConversationMessage({
      conversationId: "chn-iris-thread",
      senderId: "operator",
      body: "Keep this in the child thread.",
      notifyParticipantAgents: true,
      currentDirectory: home,
      source: "scout-web",
    });
    const threadMessagePost = requests.find((request) => request.path === "/v1/messages");

    expect(threadResult.invokedTargets).toEqual([]);
    expect(threadResult.notifiedTargets).toEqual(["fable", "talkie"]);
    expect(requests.some((request) => request.path === "/v1/invocations")).toBe(false);
    expect(threadMessagePost?.body).toMatchObject({
      conversationId: "chn-iris-thread",
      audience: { notify: ["fable", "talkie"], reason: "conversation_visibility" },
    });
  }, 15000);

  test("appends operator contributions to the existing conversation", async () => {
    const home = useIsolatedOpenScoutHome();
    const requests: Array<{ method: string; path: string; body?: any }> = [];
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.json() : undefined;
      requests.push({ method: request.method, path: url.pathname, body });

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        return jsonResponse({
          actors: {
            operator: {
              id: "operator",
              kind: "person",
              displayName: "Operator",
            },
          },
          agents: {
            "hudson.main.mini": {
              id: "hudson.main.mini",
              kind: "agent",
              handle: "hudson",
              selector: "@hudson",
              displayName: "Hudson",
              metadata: { selector: "@hudson" },
            },
            "narrative-studio.main.mini": {
              id: "narrative-studio.main.mini",
              kind: "agent",
              handle: "narrative-studio",
              selector: "@narrative-studio",
              displayName: "Narrative Studio",
              metadata: { selector: "@narrative-studio" },
            },
          },
          endpoints: {},
          conversations: {
            "dm.hudson.main.mini.narrative-studio.main.mini": {
              id: "dm.hudson.main.mini.narrative-studio.main.mini",
              kind: "direct",
              title: "Hudson <> Narrative Studio",
              visibility: "private",
              authorityNodeId: "node-1",
              participantIds: ["hudson.main.mini", "narrative-studio.main.mini"],
            },
          },
          messages: {},
          flights: {},
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/messages") {
        return jsonResponse({ ok: true });
      }

      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    const result = await sendScoutConversationMessage({
      conversationId: "dm.hudson.main.mini.narrative-studio.main.mini",
      senderId: "operator",
      body: "@hudson hi",
      currentDirectory: home,
      source: "scout-web",
    });
    const messagePost = requests.find((request) => request.path === "/v1/messages");

    expect(result).toEqual({
      usedBroker: true,
      conversationId: "dm.hudson.main.mini.narrative-studio.main.mini",
      messageId: messagePost?.body?.id,
      invokedTargets: ["hudson.main.mini"],
      unresolvedTargets: [],
    });
    expect(requests.some((request) => request.path === "/v1/deliver")).toBe(false);
    expect(messagePost?.body)
      .toMatchObject({
        conversationId: "dm.hudson.main.mini.narrative-studio.main.mini",
        actorId: "operator",
        body: "@hudson hi",
        mentions: [{ actorId: "hudson.main.mini", label: "@hudson" }],
        audience: { notify: ["hudson.main.mini"], reason: "mention" },
        metadata: {
          source: "scout-web",
          destinationKind: "conversation",
          destinationId: "dm.hudson.main.mini.narrative-studio.main.mini",
        },
      });
  }, 15000);
});

describe("sendScoutConversationSteer", () => {
  test("routes a conversation-local session by its visible runtime name", async () => {
    const home = useIsolatedOpenScoutHome();
    const requests: Array<{ method: string; path: string; body?: any }> = [];
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.json() : undefined;
      requests.push({ method: request.method, path: url.pathname, body });
      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        return jsonResponse({
          actors: {
            operator: { id: "operator", kind: "person", displayName: "Operator" },
            "session-gauss": { id: "session-gauss", kind: "session", displayName: "openscout-gauss-4" },
          },
          agents: {},
          endpoints: {
            "endpoint-gauss": {
              id: "endpoint-gauss",
              agentId: "session-gauss",
              nodeId: "node-1",
              harness: "claude",
              transport: "tmux",
              state: "idle",
              sessionId: "session-gauss",
            },
          },
          conversations: {
            "chn-engineering": {
              id: "chn-engineering",
              kind: "channel",
              title: "engineering-ci",
              visibility: "workspace",
              shareMode: "local",
              authorityNodeId: "node-1",
              participantIds: ["operator", "session-gauss"],
            },
          },
          messages: {},
          flights: {},
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/messages") {
        return jsonResponse({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/invocations") {
        return jsonResponse({
          accepted: true,
          invocationId: body.id,
          flightId: "flight-gauss",
          targetAgentId: body.targetAgentId,
          state: "queued",
        });
      }
      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    const result = await sendScoutConversationSteer({
      conversationId: "chn-engineering",
      senderId: "operator",
      body: "@openscout-gauss-4 consolidate the feedback",
      intent: "invoke",
      currentDirectory: home,
      source: "scout-web",
    });

    expect(result).toMatchObject({
      usedBroker: true,
      invokedTargets: ["session-gauss"],
      unresolvedTargets: [],
    });
    expect(requests.find((request) => request.path === "/v1/messages")?.body)
      .toMatchObject({
        mentions: [expect.objectContaining({ actorId: "session-gauss" })],
        metadata: expect.objectContaining({ relayTargetIds: ["session-gauss"] }),
      });
    expect(requests.find((request) => request.path === "/v1/invocations")?.body)
      .toMatchObject({ targetAgentId: "session-gauss", action: "consult" });
  }, 15000);

  test("records one operator message and wakes every non-human participant in an agent-to-agent conversation", async () => {
    const home = useIsolatedOpenScoutHome();
    const requests: Array<{ method: string; path: string; body?: any }> = [];
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.json() : undefined;
      requests.push({ method: request.method, path: url.pathname, body });

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        return jsonResponse({
          actors: {
            operator: {
              id: "operator",
              kind: "person",
              displayName: "Operator",
            },
          },
          agents: {
            "hudson.main.mini": {
              id: "hudson.main.mini",
              kind: "agent",
              handle: "hudson",
              selector: "@hudson",
              displayName: "Hudson",
              metadata: { selector: "@hudson" },
            },
            "narrative-studio.main.mini": {
              id: "narrative-studio.main.mini",
              kind: "agent",
              handle: "narrative-studio",
              selector: "@narrative-studio",
              displayName: "Narrative Studio",
              metadata: { selector: "@narrative-studio" },
            },
          },
          endpoints: {
            "endpoint-hudson": {
              id: "endpoint-hudson",
              agentId: "hudson.main.mini",
              nodeId: "node-1",
              harness: "claude",
              transport: "tmux",
              state: "idle",
              sessionId: "relay-hudson-claude",
            },
            "endpoint-narrative": {
              id: "endpoint-narrative",
              agentId: "narrative-studio.main.mini",
              nodeId: "node-1",
              harness: "claude",
              transport: "claude_stream_json",
              state: "idle",
              sessionId: "relay-narrative-claude",
            },
          },
          conversations: {
            "c.hudson-narrative": {
              id: "c.hudson-narrative",
              kind: "direct",
              title: "Hudson <> Narrative Studio",
              visibility: "private",
              authorityNodeId: "node-1",
              participantIds: ["hudson.main.mini", "narrative-studio.main.mini"],
            },
          },
          messages: {},
          flights: {},
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/messages") {
        return jsonResponse({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/invocations") {
        return jsonResponse({
          accepted: true,
          invocationId: body.id,
          flightId: `flight-${body.targetAgentId}`,
          targetAgentId: body.targetAgentId,
          state: "queued",
          flight: {
            id: `flight-${body.targetAgentId}`,
            invocationId: body.id,
            requesterId: body.requesterId,
            targetAgentId: body.targetAgentId,
            state: "queued",
          },
        });
      }

      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    const result = await sendScoutConversationSteer({
      conversationId: "c.hudson-narrative",
      senderId: "operator",
      body: "Who has next?",
      steerContextByTargetAgentId: {
        "hudson.main.mini": {
          runId: "run:flight:flt-hudson-active",
          flightId: "flt-hudson-active",
        },
      },
      currentDirectory: home,
      source: "scout-web",
    });

    expect(result).toMatchObject({
      usedBroker: true,
      conversationId: "c.hudson-narrative",
      invokedTargets: ["hudson.main.mini", "narrative-studio.main.mini"],
      unresolvedTargets: [],
    });
    const messagePost = requests.find((request) => request.path === "/v1/messages")?.body;
    expect(messagePost).toMatchObject({
      conversationId: "c.hudson-narrative",
      actorId: "operator",
      body: "Who has next?",
      audience: {
        notify: ["hudson.main.mini", "narrative-studio.main.mini"],
        reason: "direct_message",
      },
      metadata: {
        source: "scout-web",
        destinationKind: "conversation",
        destinationId: "c.hudson-narrative",
        intent: "steer",
        relayTargetIds: ["hudson.main.mini", "narrative-studio.main.mini"],
      },
    });

    const invocationPosts = requests
      .filter((request) => request.path === "/v1/invocations")
      .map((request) => request.body);
    expect(invocationPosts).toHaveLength(2);
    expect(invocationPosts).toEqual([
      expect.objectContaining({
        targetAgentId: "hudson.main.mini",
        action: "wake",
        conversationId: "c.hudson-narrative",
        messageId: messagePost.id,
        execution: {
          session: "existing",
          targetSessionId: "relay-hudson-claude",
        },
        metadata: expect.objectContaining({
          intent: "steer",
          relayTarget: "hudson.main.mini",
          relayMessageId: messagePost.id,
          parentRunId: "run:flight:flt-hudson-active",
          steeredFlightId: "flt-hudson-active",
        }),
      }),
      expect.objectContaining({
        targetAgentId: "narrative-studio.main.mini",
        action: "wake",
        conversationId: "c.hudson-narrative",
        messageId: messagePost.id,
        execution: {
          session: "existing",
          targetSessionId: "relay-narrative-claude",
        },
        metadata: expect.objectContaining({
          intent: "steer",
          relayTarget: "narrative-studio.main.mini",
          relayMessageId: messagePost.id,
        }),
      }),
    ]);

    requests.length = 0;
    const scopedResult = await sendScoutConversationSteer({
      conversationId: "c.hudson-narrative",
      senderId: "operator",
      body: "@Tesla take this one.",
      currentDirectory: home,
      source: "scout-web",
    });

    expect(scopedResult).toMatchObject({
      usedBroker: true,
      conversationId: "c.hudson-narrative",
      invokedTargets: ["hudson.main.mini"],
      unresolvedTargets: [],
    });
    expect(requests.find((request) => request.path === "/v1/messages")?.body)
      .toMatchObject({
        mentions: [{ actorId: "hudson.main.mini", label: "@Tesla" }],
        audience: {
          notify: ["hudson.main.mini"],
          reason: "direct_message",
        },
      });
    expect(requests.filter((request) => request.path === "/v1/invocations").map((request) => request.body.targetAgentId))
      .toEqual(["hudson.main.mini"]);

    requests.length = 0;
    const tellResult = await sendScoutConversationSteer({
      conversationId: "c.hudson-narrative",
      senderId: "operator",
      body: "Heads up for Hudson.",
      targetParticipantIds: ["hudson.main.mini"],
      intent: "tell",
      currentDirectory: home,
      source: "scout-web",
    });

    expect(tellResult).toMatchObject({
      usedBroker: true,
      conversationId: "c.hudson-narrative",
      invokedTargets: ["hudson.main.mini"],
      unresolvedTargets: [],
    });
    const tellMessagePost = requests.find((request) => request.path === "/v1/messages")?.body;
    expect(tellMessagePost).toMatchObject({
      metadata: expect.objectContaining({
        intent: "tell",
        relayTargetIds: ["hudson.main.mini"],
      }),
    });
    expect(requests.find((request) => request.path === "/v1/invocations")?.body)
      .toMatchObject({
        targetAgentId: "hudson.main.mini",
        labels: ["tell"],
        metadata: expect.objectContaining({
          intent: "tell",
          sourceIntent: "direct_message",
          relayMessageId: tellMessagePost.id,
        }),
      });

    requests.length = 0;
    const invokeResult = await sendScoutConversationSteer({
      conversationId: "c.hudson-narrative",
      senderId: "operator",
      body: "Review the current implementation.",
      targetParticipantIds: ["hudson.main.mini"],
      intent: "invoke",
      execution: { harness: "claude", model: "opus-test" },
      currentDirectory: home,
      source: "scout-web",
    });

    expect(invokeResult).toMatchObject({
      usedBroker: true,
      conversationId: "c.hudson-narrative",
      invokedTargets: ["hudson.main.mini"],
    });
    const invokeMessagePost = requests.find((request) => request.path === "/v1/messages")?.body;
    expect(invokeMessagePost).toMatchObject({
      conversationId: "c.hudson-narrative",
      metadata: expect.objectContaining({
        intent: "invoke",
      }),
    });
    expect(requests.find((request) => request.path === "/v1/invocations")?.body)
      .toMatchObject({
        targetAgentId: "hudson.main.mini",
        action: "consult",
        conversationId: "c.hudson-narrative",
        messageId: invokeMessagePost.id,
        execution: {
          session: "existing",
          targetSessionId: "relay-hudson-claude",
          harness: "claude",
          model: "opus-test",
        },
        labels: ["invoke"],
        metadata: expect.objectContaining({
          intent: "invoke",
          relayMessageId: invokeMessagePost.id,
        }),
      });

    requests.length = 0;
    await sendScoutConversationSteer({
      conversationId: "c.hudson-narrative",
      senderId: "operator",
      body: "",
      attachments: [{ id: "att-only", mediaType: "image/png", data: "aW1hZ2U=" }],
      targetParticipantIds: ["hudson.main.mini"],
      intent: "invoke",
      currentDirectory: home,
      source: "scout-web",
    });
    expect(requests.find((request) => request.path === "/v1/invocations")?.body)
      .toMatchObject({
        task: "Review the attached message.",
        conversationId: "c.hudson-narrative",
      });
  }, 15000);

  test("does not steer an offline cardless session participant", async () => {
    const home = useIsolatedOpenScoutHome();
    const requests: Array<{ method: string; path: string; body?: any }> = [];
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.json() : undefined;
      requests.push({ method: request.method, path: url.pathname, body });

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        return jsonResponse({
          actors: {
            operator: {
              id: "operator",
              kind: "person",
              displayName: "Operator",
            },
            "session-lattices": {
              id: "session-lattices",
              kind: "session",
              displayName: "lattices-schubert",
              handle: "project-schubert",
              metadata: {
                cardless: true,
                handle: "project-schubert",
                projectRoot: "/Users/example/dev/lattices",
              },
            },
          },
          agents: {},
          endpoints: {
            "endpoint-lattices": {
              id: "endpoint-lattices",
              agentId: "session-lattices",
              nodeId: "node-1",
              harness: "codex",
              transport: "codex_app_server",
              state: "offline",
              sessionId: "session-lattices",
              projectRoot: "/Users/example/dev/lattices",
              cwd: "/Users/example/dev/lattices",
              metadata: {
                cardless: true,
                handle: "project-schubert",
              },
            },
          },
          conversations: {
            "c.session-lattices": {
              id: "c.session-lattices",
              kind: "direct",
              title: "lattices-schubert",
              visibility: "private",
              authorityNodeId: "node-1",
              participantIds: ["operator", "session-lattices"],
            },
          },
          messages: {},
          flights: {},
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/messages") {
        return jsonResponse({ ok: true });
      }

      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    const result = await sendScoutConversationSteer({
      conversationId: "c.session-lattices",
      senderId: "operator",
      body: "still there?",
      targetParticipantIds: ["session-lattices"],
      currentDirectory: home,
      source: "scout-web",
    });

    expect(result).toMatchObject({
      usedBroker: true,
      conversationId: "c.session-lattices",
      invokedTargets: [],
      unresolvedTargets: ["session-lattices"],
    });
    expect(requests.filter((request) => request.path === "/v1/invocations")).toHaveLength(0);
    expect(requests.find((request) => request.path === "/v1/messages")?.body)
      .toMatchObject({
        conversationId: "c.session-lattices",
        metadata: {
          intent: "steer",
          relayTargetIds: [],
        },
      });
  }, 15000);
});

describe("loadScoutMessages", () => {
  test("resolves channel aliases to opaque conversation ids", async () => {
    const home = useIsolatedOpenScoutHome();
    const requests: Array<{ method: string; path: string; search: string }> = [];
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      requests.push({ method: request.method, path: url.pathname, search: url.search });

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        return jsonResponse({
          actors: {},
          agents: {},
          endpoints: {},
          conversations: {
            "conv.11111111-1111-4111-8111-111111111111": {
              id: "conv.11111111-1111-4111-8111-111111111111",
              kind: "channel",
              title: "talkie-next",
              visibility: "workspace",
              authorityNodeId: "node-1",
              participantIds: ["operator"],
              metadata: {
                channel: "talkie-next",
                naturalKey: "channel:talkie-next",
              },
            },
          },
          messages: {},
          flights: {},
        });
      }
      if (request.method === "GET" && url.pathname === "/v1/messages") {
        return jsonResponse([]);
      }

      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    const messages = await loadScoutMessages({
      channel: "talkie-next",
      baseUrl: "http://broker.test",
    });

    const messagesRequest = requests.find((request) => request.path === "/v1/messages");
    const params = new URLSearchParams(messagesRequest?.search ?? "");

    expect(messages).toEqual([]);
    expect(params.get("conversationId")).toBe("conv.11111111-1111-4111-8111-111111111111");
  }, 15000);
});

describe("openScoutPeerSession", () => {
  test("auto-registers a configured local agent and creates a direct conversation", async () => {
    const home = useIsolatedOpenScoutHome();
    const workspaceRoot = join(home, "dev");
    const talkieRoot = join(workspaceRoot, "talkie");

    mkdirSync(join(talkieRoot, ".git"), { recursive: true });
    writeFileSync(join(talkieRoot, "AGENTS.md"), "# talkie\n", "utf8");

    await writeOpenScoutSettings({
      discovery: {
        workspaceRoots: [workspaceRoot],
        includeCurrentRepo: false,
      },
    });

    const requests: Array<{ method: string; path: string; body?: any }> = [];
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.json() : undefined;
      requests.push({ method: request.method, path: url.pathname, body });

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        return jsonResponse({
          actors: {},
          agents: {},
          endpoints: {},
          conversations: {},
          messages: {},
          flights: {},
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/actors") {
        return jsonResponse({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/agents") {
        return jsonResponse({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/endpoints") {
        return jsonResponse({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/conversations") {
        return jsonResponse({ ok: true });
      }

      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    const result = await openScoutPeerSession({
      sourceId: "operator",
      targetId: "talkie",
      currentDirectory: talkieRoot,
      sourceName: "Operator",
    });

    expect(result.sourceId).toBe("operator");
    expect(result.targetId).toContain("talkie");
    expect(result.conversation.participantIds).toEqual(["operator", result.targetId]);
    expect(result.conversation.kind).toBe("direct");
    expect(result.existed).toBe(false);

    const actorPosts = requests.filter((request) => request.path === "/v1/actors");
    const agentPosts = requests.filter((request) => request.path === "/v1/agents");
    const endpointPosts = requests.filter((request) => request.path === "/v1/endpoints");
    const conversationPost = requests.find((request) => request.path === "/v1/conversations");

    expect(actorPosts.some((request) => request.body?.id === "operator")).toBe(true);
    expect(actorPosts.some((request) => request.body?.id === result.targetId)).toBe(true);
    expect(agentPosts.some((request) => request.body?.id === result.targetId)).toBe(true);
    expect(endpointPosts.some((request) => request.body?.agentId === result.targetId)).toBe(true);
    expect(conversationPost?.body).toEqual(expect.objectContaining({
      kind: "direct",
      participantIds: ["operator", result.targetId],
      visibility: "private",
    }));
  }, 15000);
});

describe("sendScoutDirectMessage", () => {
  test("gives attachment-only mobile consults a broker-valid task body", async () => {
    useIsolatedOpenScoutHome();
    const agentId = "project-woolf-15.main.node-1";
    const deliveredBodies: Record<string, unknown>[] = [];

    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.json() as Record<string, unknown> : null;

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        return jsonResponse({
          actors: {},
          agents: {
            [agentId]: {
              id: agentId,
              kind: "agent",
              displayName: "Project Woolf 15",
            },
          },
          endpoints: {
            "endpoint-woolf": {
              id: "endpoint-woolf",
              agentId,
              nodeId: "node-1",
              harness: "claude",
              transport: "tmux",
              state: "idle",
            },
          },
          conversations: {},
          messages: {},
          flights: {},
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/deliver") {
        if (body) deliveredBodies.push(body);
        return jsonResponse({
          kind: "delivery",
          accepted: true,
          routeKind: "dm",
          conversation: {
            id: "chn-woolf",
            kind: "direct",
            title: "Project Woolf 15",
            visibility: "private",
            shareMode: "local",
            authorityNodeId: "node-1",
            participantIds: ["operator", agentId],
          },
          message: {
            id: "msg-woolf",
            conversationId: "chn-woolf",
            actorId: "operator",
            originNodeId: "node-1",
            class: "agent",
            body: "Review the attached message.",
            visibility: "private",
            policy: "durable",
            createdAt: Date.now(),
          },
          targetAgentId: agentId,
        });
      }
      return jsonResponse({ error: "unexpected request" }, 404);
    }) as unknown as typeof fetch;

    await sendScoutDirectMessage({
      agentId,
      body: "",
      attachments: [{
        id: "att-photo",
        mediaType: "image/jpeg",
        fileName: "Photo.jpg",
        url: "http://127.0.0.1:43132/files/att-photo",
      }],
      source: "scout-mobile",
      clientMessageId: "ios-stable-photo",
    });

    await sendScoutDirectMessage({
      agentId,
      body: "",
      attachments: [{
        id: "att-photo",
        mediaType: "image/jpeg",
        fileName: "Photo.jpg",
        url: "http://127.0.0.1:43132/files/att-photo",
      }],
      source: "scout-mobile",
      clientMessageId: "ios-stable-photo",
    });

    expect(deliveredBodies[0]).toMatchObject({
      body: "Review the attached message.",
      attachments: [{
        id: "att-photo",
        mediaType: "image/jpeg",
        fileName: "Photo.jpg",
        url: "http://127.0.0.1:43132/files/att-photo",
      }],
      intent: "consult",
    });
    expect(deliveredBodies[0]?.id).toBe(deliveredBodies[1]?.id);
    expect(deliveredBodies[0]?.id).toMatch(/^deliver-client-[a-f0-9]{32}$/);
  });

  test("asks the broker to route a cached superseded endpoint and exposes typed recovery", async () => {
    useIsolatedOpenScoutHome();
    const agentId = "stale-session.node-1";
    let deliveryRequests = 0;

    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        return jsonResponse({
          actors: {},
          agents: { [agentId]: { id: agentId, kind: "agent", displayName: "Stale session" } },
          endpoints: {
            "endpoint-stale": {
              id: "endpoint-stale",
              agentId,
              nodeId: "node-1",
              harness: "claude",
              transport: "tmux",
              state: "offline",
              metadata: { retiredFromFleet: true },
            },
          },
          conversations: {},
          messages: {},
          flights: {},
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/deliver") {
        deliveryRequests += 1;
        return jsonResponse({
          kind: "question",
          accepted: false,
          question: { detail: "The exact session is no longer attachable." },
          remediation: {
            kind: "session_reference_not_attachable",
            detail: "Start a replacement session.",
          },
        }, 409);
      }
      return jsonResponse({ error: "unexpected request" }, 404);
    }) as unknown as typeof fetch;

    await expect(sendScoutDirectMessage({
      agentId,
      body: "continue",
      clientMessageId: "ios-stale-session",
    })).rejects.toBeInstanceOf(ScoutDirectDeliveryUnavailableError);
    expect(deliveryRequests).toBe(1);
  });
});
