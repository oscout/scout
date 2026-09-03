import { afterEach, describe, expect, test } from "bun:test";

import type { AgentDefinition, IrohMeshEntrypoint, MessageRecord, NodeDefinition } from "@openscout/protocol";
import {
  OPENSCOUT_IROH_MESH_ALPN,
  OPENSCOUT_MESH_PROTOCOL_VERSION,
} from "@openscout/protocol";

import {
  DEFAULT_MESH_FORWARD_TIMEOUT_MS,
  fetchPeerAgents,
  forwardMeshMessage,
  MAX_PEER_AGENT_SNAPSHOT_BYTES,
  PeerAgentSnapshotTooLargeError,
  type MeshMessageBundle,
  PeerUnreachableError,
} from "./mesh-forwarding.js";

test("peer agent snapshots use a 2 MiB wire ceiling", () => {
  expect(MAX_PEER_AGENT_SNAPSHOT_BYTES).toBe(2 * 1024 * 1024);
});

test("fetchPeerAgents uses the broker-scoped authenticated peer client", async () => {
  const calls: string[] = [];
  const remoteAgent = {
    id: "ocean-minimax.main.ocean-iron",
    kind: "agent",
    definitionId: "ocean-minimax",
    displayName: "MiniMax M3 on ocean-iron",
    handle: "ocean-minimax",
    selector: "@ocean-minimax.main.node:ocean-iron",
    defaultSelector: "@ocean-minimax",
    labels: [],
    metadata: {},
    agentClass: "general",
    capabilities: ["chat"],
    wakePolicy: "on_demand",
    homeNodeId: "ocean-iron-openscout",
    authorityNodeId: "ocean-iron-openscout",
    advertiseScope: "mesh",
  } satisfies AgentDefinition;
  const peerFetch = async (baseUrl: string, path: string): Promise<Response> => {
    calls.push(`${baseUrl}${path}`);
    return Response.json({ agents: { [remoteAgent.id]: remoteAgent } });
  };

  await expect(fetchPeerAgents("https://ocean-iron:43110", peerFetch)).resolves.toEqual({
    authoritative: true,
    agents: [remoteAgent],
  });
  expect(calls).toEqual(["https://ocean-iron:43110/v1/mesh/snapshot?scope=agents"]);
});

test("fetchPeerAgents treats a 2xx empty agents object as authoritative", async () => {
  const peerFetch = async (): Promise<Response> => Response.json({ agents: {} });
  await expect(fetchPeerAgents("https://ocean-iron:43110", peerFetch)).resolves.toEqual({
    authoritative: true,
    agents: [],
  });
});

test("fetchPeerAgents falls back to the legacy snapshot path on 404", async () => {
  const calls: string[] = [];
  const peerFetch = async (baseUrl: string, path: string): Promise<Response> => {
    calls.push(`${baseUrl}${path}`);
    if (path.startsWith("/v1/mesh/snapshot")) {
      return new Response("missing", { status: 404 });
    }
    return Response.json({ agents: {} });
  };
  await expect(fetchPeerAgents("https://legacy-peer:43110", peerFetch)).resolves.toEqual({
    authoritative: true,
    agents: [],
  });
  expect(calls).toEqual([
    "https://legacy-peer:43110/v1/mesh/snapshot?scope=agents",
    "https://legacy-peer:43110/v1/snapshot?scope=agents",
  ]);
});

test("fetchPeerAgents never treats non-2xx, missing, or malformed agents as authoritative", async () => {
  const cases: Array<{ label: string; response: Response }> = [
    { label: "http 503", response: new Response("nope", { status: 503 }) },
    { label: "missing agents", response: Response.json({ nodes: {} }) },
    { label: "null agents", response: Response.json({ agents: null }) },
    { label: "array agents", response: Response.json({ agents: [] }) },
    { label: "string agents", response: Response.json({ agents: "agents" }) },
    { label: "non-object body", response: Response.json([]) },
  ];
  for (const testCase of cases) {
    const peerFetch = async (): Promise<Response> => testCase.response.clone();
    await expect(fetchPeerAgents("https://peer:43110", peerFetch)).resolves.toEqual({
      authoritative: false,
      agents: [],
    });
  }
});

test("fetchPeerAgents treats unparseable 2xx bodies as non-authoritative", async () => {
  const peerFetch = async (): Promise<Response> => new Response("not-json", {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  await expect(fetchPeerAgents("https://peer:43110", peerFetch)).resolves.toEqual({
    authoritative: false,
    agents: [],
  });
});

test("fetchPeerAgents rejects a declared full-registry-sized response before parsing it", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{}"));
    },
    cancel() {
      cancelled = true;
    },
  });
  const peerFetch = async (): Promise<Response> => new Response(body, {
    headers: {
      "content-length": String(MAX_PEER_AGENT_SNAPSHOT_BYTES + 1),
      "content-type": "application/json",
    },
  });

  const error = await fetchPeerAgents("https://legacy-peer:43110", peerFetch)
    .then(() => null, (cause: unknown) => cause);
  expect(error).toBeInstanceOf(PeerAgentSnapshotTooLargeError);
  expect(error).toMatchObject({
    brokerUrl: "https://legacy-peer:43110",
    observedBytes: MAX_PEER_AGENT_SNAPSHOT_BYTES + 1,
    maxBytes: MAX_PEER_AGENT_SNAPSHOT_BYTES,
  });
  expect(cancelled).toBe(true);
});

test("fetchPeerAgents stops an undeclared oversized response while streaming", async () => {
  let cancelled = false;
  let emitted = 0;
  const chunkSize = 1024 * 1024;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      emitted += 1;
      controller.enqueue(new Uint8Array(chunkSize));
    },
    cancel() {
      cancelled = true;
    },
  });
  const peerFetch = async (): Promise<Response> => new Response(body, {
    headers: { "content-type": "application/json" },
  });

  await expect(fetchPeerAgents("https://legacy-peer:43110", peerFetch))
    .rejects.toBeInstanceOf(PeerAgentSnapshotTooLargeError);
  expect(emitted).toBeLessThanOrEqual((MAX_PEER_AGENT_SNAPSHOT_BYTES / chunkSize) + 2);
  expect(cancelled).toBe(true);
});

test("forwardMeshMessage uses the injected signed and pinned peer client", async () => {
  const calls: Array<{ baseUrl: string; path: string; method?: string }> = [];
  const peerFetch = async (baseUrl: string, path: string, init?: RequestInit): Promise<Response> => {
    calls.push({ baseUrl, path, method: init?.method });
    return Response.json({ ok: true });
  };

  await expect(forwardMeshMessage(
    "https://arts-mac-mini.tailnet.example:43110",
    makeBundle(),
    { peerFetch },
  )).resolves.toEqual({ ok: true });
  expect(calls).toEqual([{
    baseUrl: "https://arts-mac-mini.tailnet.example:43110",
    path: "/v1/mesh/messages",
    method: "POST",
  }]);
});

const servers = new Set<ReturnType<typeof Bun.serve>>();

afterEach(() => {
  for (const server of servers) {
    server.stop(true);
  }
  servers.clear();
});

function startHangingServer(): string {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Promise<Response>(() => {});
    },
  });
  servers.add(server);
  return `http://127.0.0.1:${server.port}`;
}

function startJsonServer(
  handler: (request: Request) => Response | Promise<Response>,
): string {
  const server = Bun.serve({
    port: 0,
    fetch: handler,
  });
  servers.add(server);
  return `http://127.0.0.1:${server.port}`;
}

function makeIrohEntrypoint(endpointId = "peer-iroh"): IrohMeshEntrypoint {
  return {
    kind: "iroh",
    endpointId,
    endpointAddr: { id: endpointId, addrs: [] },
    alpn: OPENSCOUT_IROH_MESH_ALPN,
    bridgeProtocolVersion: OPENSCOUT_MESH_PROTOCOL_VERSION,
  };
}

function makePeerNode(input: {
  brokerUrl?: string;
  meshEntrypoints?: NodeDefinition["meshEntrypoints"];
} = {}): NodeDefinition {
  const node: NodeDefinition = {
    id: "peer-node",
    meshId: "openscout",
    name: "Peer",
    advertiseScope: "mesh",
    capabilities: ["broker"],
    registeredAt: 0,
    lastSeenAt: 0,
  };
  if (input.brokerUrl) {
    node.brokerUrl = input.brokerUrl;
  }
  if (input.meshEntrypoints) {
    node.meshEntrypoints = input.meshEntrypoints;
  }
  return node;
}

function makeBundle(): MeshMessageBundle {
  const originNode: NodeDefinition = {
    id: "origin-node",
    meshId: "openscout",
    name: "Origin",
    advertiseScope: "mesh",
    brokerUrl: "http://127.0.0.1:43110",
    capabilities: ["broker"],
    registeredAt: 0,
    lastSeenAt: 0,
  };
  const message: MessageRecord = {
    id: "msg-timeout",
    conversationId: "channel.shared.timeout",
    actorId: "actor-origin",
    originNodeId: originNode.id,
    class: "agent",
    body: "timeout probe",
    visibility: "workspace",
    policy: "durable",
    createdAt: Date.now(),
  };

  return {
    originNode,
    conversation: {
      id: message.conversationId,
      kind: "channel",
      title: "timeout",
      visibility: "workspace",
      shareMode: "shared",
      authorityNodeId: "peer-node",
      participantIds: ["actor-origin"],
      metadata: { surface: "test" },
    },
    actors: [],
    agents: [],
    bindings: [],
    message,
  };
}

describe("mesh forwarding", () => {
  test("times out a stalled peer forward instead of hanging indefinitely", async () => {
    const brokerUrl = startHangingServer();
    const startedAt = Date.now();

    try {
      await forwardMeshMessage(brokerUrl, makeBundle(), { timeoutMs: 100 });
      throw new Error("expected forwardMeshMessage to time out");
    } catch (error) {
      expect(error).toBeInstanceOf(PeerUnreachableError);
      const peerError = error as PeerUnreachableError;
      expect(peerError.url).toBe(`${brokerUrl}/v1/mesh/messages`);
      expect(Date.now() - startedAt).toBeLessThan(DEFAULT_MESH_FORWARD_TIMEOUT_MS);
    }
  });

  test("uses an advertised Iroh entrypoint when a bridge forwarder is available", async () => {
    const entrypoint = makeIrohEntrypoint();
    const peer = makePeerNode({ meshEntrypoints: [entrypoint] });
    const calls: Array<{ route: string; payload: unknown; endpointId: string }> = [];

    const result = await forwardMeshMessage(peer, makeBundle(), {
      iroh: {
        forwarder: async (receivedEntrypoint, route, payload) => {
          calls.push({
            route,
            payload,
            endpointId: receivedEntrypoint.endpointId,
          });
          return { status: 200, body: { ok: true as const, duplicate: true } };
        },
      },
    });

    expect(result).toEqual({ ok: true, duplicate: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.route).toBe("messages");
    expect(calls[0]?.endpointId).toBe(entrypoint.endpointId);
  });

  test("falls back to HTTP when Iroh forwarding cannot reach a peer with a broker URL", async () => {
    const brokerUrl = startJsonServer(async (request) => {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/v1/node") {
        // Legacy peer: no signed node card yet, client falls back to unsigned.
        return new Response(null, { status: 404 });
      }
      expect(pathname).toBe("/v1/mesh/messages");
      return Response.json({ ok: true, duplicate: false });
    });
    const peer = makePeerNode({
      brokerUrl,
      meshEntrypoints: [makeIrohEntrypoint()],
    });

    const result = await forwardMeshMessage(peer, makeBundle(), {
      iroh: {
        forwarder: async () => {
          throw new Error("iroh unavailable");
        },
      },
    });

    expect(result).toEqual({ ok: true, duplicate: false });
  });

  test("falls back to a later HTTP entrypoint when the first dial fails", async () => {
    const liveUrl = startJsonServer(async (request) => {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/v1/node") {
        return new Response(null, { status: 404 });
      }
      expect(pathname).toBe("/v1/mesh/messages");
      return Response.json({ ok: true, duplicate: false });
    });
    const peer = makePeerNode({
      brokerUrl: "http://127.0.0.1:1",
      meshEntrypoints: [{ kind: "http", url: liveUrl }],
    });

    const result = await forwardMeshMessage(peer, makeBundle(), { timeoutMs: 250 });
    expect(result).toEqual({ ok: true, duplicate: false });
  });

  test("reports unreachable when an Iroh-only peer cannot be forwarded", async () => {
    const peer = makePeerNode({ meshEntrypoints: [makeIrohEntrypoint()] });

    await expect(forwardMeshMessage(peer, makeBundle(), {
      iroh: {
        forwarder: async () => {
          throw new Error("iroh unavailable");
        },
      },
    })).rejects.toBeInstanceOf(PeerUnreachableError);
  });
});
