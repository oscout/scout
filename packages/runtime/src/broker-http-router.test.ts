import { EventEmitter } from "node:events";
import { generateKeyPairSync } from "node:crypto";
import { PassThrough } from "node:stream";

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import type { TrustedPeerRecord } from "@openscout/protocol";

import {
  createBrokerHttpRouter,
  type BrokerHttpRouterDeps,
} from "./broker-http-router.js";
import { migrateControlPlaneDatabaseSchema } from "./control-plane-migrations.js";
import { nodeFingerprint, nodeKeyId } from "./node-identity.js";
import {
  TrustEndpointRateLimiter,
  TrustEnrollmentService,
} from "./mesh-trust-enrollment.js";

class FakeResponse extends EventEmitter {
  body = "";
  destroyed = false;
  headers: Record<string, string> | undefined;
  status: number | undefined;
  writableEnded = false;

  writeHead(status: number, headers: Record<string, string> = {}): void {
    this.status = status;
    this.headers = headers;
  }

  write(chunk: string): void {
    this.body += chunk;
  }

  end(chunk?: string): void {
    if (chunk) {
      this.body += chunk;
    }
    this.writableEnded = true;
  }
}

type Harness = {
  cursorBodies: unknown[];
  deliverCalls: Array<{ payload: unknown; signal?: AbortSignal }>;
  invocationCalls: unknown[];
  deps: BrokerHttpRouterDeps;
  routed: ReturnType<typeof createBrokerHttpRouter>;
};

function createHarness(overrides: Partial<BrokerHttpRouterDeps> = {}): Harness {
  const cursorBodies: unknown[] = [];
  const deliverCalls: Array<{ payload: unknown; signal?: AbortSignal }> = [];
  const invocationCalls: unknown[] = [];
  const node = {
    id: "node-1",
    name: "Node 1",
    meshId: "mesh-1",
    endpoints: [],
    lastSeenAt: 1,
  };
  const cursor = {
    conversationId: "conversation-1",
    actorId: "agent-1",
    lastReadAt: 100,
    updatedAt: 100,
  };
  const deps = {
    host: "127.0.0.1",
    port: 43110,
    nodeId: "node-1",
    meshId: "mesh-1",
    operatorActorId: "operator",
    runtime: {
      snapshot: () => ({ nodes: { [node.id]: node } }),
      recentEvents: (limit: number) => [{ id: "evt-1", limit }],
      collaborationRecord: () => undefined,
      flightForInvocation: () => undefined,
      deleteEndpoint: () => {},
      upsertAgentIdentity: () => {},
      upsertEndpoint: () => {},
    },
    journal: {
      listDeliveries: () => [],
      listScoutDispatches: () => [],
    },
    knownInvocations: new Map(),
    brokerService: {
      baseUrl: "http://broker.test",
      readHealth: async () => ({ ok: true, nodeId: "node-1", meshId: "mesh-1" }),
      readNode: async () => node,
      readSnapshot: async () => ({ nodes: { [node.id]: node } }),
      executeCommand: async () => ({ ok: true }),
      deliver: async (payload: unknown, options?: { signal?: AbortSignal }) => {
        deliverCalls.push({ payload, signal: options?.signal });
        return { kind: "delivery", deliveryId: "delivery-1" };
      },
    },
    webControl: {
      corsHeaders: () => ({ "access-control-allow-origin": "http://app.test" }),
      status: async () => ({ ok: true }),
      startIfNeeded: async () => ({ ok: true }),
      restartIfManaged: async () => ({ ok: true }),
      startContextFromRequest: () => ({ from: "test" }),
      failureStatus: (error: unknown) => ({ ok: false, detail: String(error) }),
    },
    a2aService: {
      agentCardForRequest: async () => ({ name: "OpenScout" }),
      handleJsonRpc: async () => ({ jsonrpc: "2.0", id: null, result: {} }),
      listScoutAgentCards: async () => [],
    },
    brokerRepoTailService: {
      warmRepoWatchSnapshot: () => {},
      readRepoWatchSnapshotForUrl: async () => ({ ok: true }),
      readTailRecentPayloadWithTiming: async () => ({
        payload: { generatedAt: 1, limit: 0, cursor: null, events: [] },
        timings: [],
      }),
      readTailRecentPayload: async () => ({ generatedAt: 1, limit: 0, cursor: null, events: [] }),
    },
    getHarnessTopologySnapshot: async () => ({ nodes: [] }),
    getTailDiscovery: async () => ({ tails: [] }),
    nudgeHarnessTopologyScan: async () => ({ ok: true }),
    deliveryHttpService: {
      readInboxItems: async () => [],
      readInboxSnapshot: async () => ({ targetId: "agent-1", items: [] }),
      claimInboxItem: async () => ({ ok: true, claimed: null }),
      acknowledgeInboxItem: async () => ({ status: 200, body: { ok: true } }),
      nackInboxItem: async () => ({ status: 200, body: { ok: true } }),
      listDeliveries: () => [],
      claimDelivery: async () => ({ ok: true, claimed: null }),
      listDeliveryAttempts: () => [],
      recordDeliveryAttempt: async () => ({ ok: true }),
      updateDeliveryStatus: async () => ({ ok: true }),
    },
    durableActionHttpService: {
      recordAction: async () => ({ ok: true, actionId: "action-1" }),
      heartbeat: async () => ({ status: 200, body: { ok: true } }),
    },
    controlStreams: {
      addInboxStream: () => {},
      addInvocationStream: () => {},
      addEventStream: () => {},
    },
    managedSessionHttpService: {
      listPairingSessionCandidates: async () => [],
      attachPairingSession: async () => ({ ok: true }),
      detachPairingSession: async () => ({ ok: true }),
      attachLocalSession: async () => ({ ok: true }),
      ensureLocalSession: async () => ({ ok: true }),
      detachLocalSession: async () => ({ ok: true }),
    },
    meshDiscoveryService: {
      discoverPeers: async () => ({ discovered: [], probes: [] }),
    },
    meshHttpService: {
      receiveMessageBundle: async () => ({ status: 200, body: { ok: true } }),
      receiveInvocationBundle: async () => ({ status: 200, body: { ok: true } }),
      receiveCollaborationRecordBundle: async () => ({ status: 200, body: { ok: true } }),
      receiveCollaborationEventBundle: async () => ({ status: 200, body: { ok: true } }),
    },
    threadEvents: {
      streamWatch: async () => {},
    },
    handleCommand: async () => ({ ok: true }),
    handleInvocationRequest: async (payload: unknown) => {
      invocationCalls.push(payload);
      return { ok: true };
    },
    recordFlight: async () => {},
    listReadCursorsForConversation: () => [cursor],
    resolveReadCursor: async (_conversationId: string, body: unknown) => {
      cursorBodies.push(body);
      return cursor;
    },
    recordReadCursor: async () => {},
    acknowledgeDeliveriesForReadCursor: async () => ["delivery-1"],
    deliveryAcceptanceService: {
      accept: async () => ({ kind: "delivery", deliveryId: "fallback-delivery" }),
    },
    rendezvousService: {
      match: async (request: { topic: string; projectRoot: string; participantId: string }) => ({
        status: "waiting",
        topic: request.topic,
        projectRoot: request.projectRoot,
        participantId: request.participantId,
        joinedAt: 1,
        expiresAt: 2,
      }),
    },
    ...overrides,
  } as unknown as BrokerHttpRouterDeps;

  return {
    cursorBodies,
    deliverCalls,
    invocationCalls,
    deps,
    routed: createBrokerHttpRouter(deps),
  };
}

async function requestRouter(
  harness: Harness,
  method: string,
  path: string,
  options: {
    body?: unknown;
    rawBody?: string;
    transportContext?: { transport: "unix-socket" | "loopback" | "remote"; remoteAddress?: string };
  } = {},
): Promise<{ body: unknown; rawBody: string; response: FakeResponse }> {
  const request = new PassThrough() as PassThrough & {
    headers: Record<string, string>;
    method: string;
    url: string;
    transportContext?: { transport: "unix-socket" | "loopback" | "remote"; remoteAddress?: string };
  };
  request.headers = { host: "broker.test" };
  request.method = method;
  request.url = path;
  if (options.transportContext) {
    request.transportContext = options.transportContext;
  }
  const response = new FakeResponse();

  const routed = harness.routed(request as never, response as never);
  if (options.rawBody !== undefined) {
    request.end(options.rawBody);
  } else if (options.body !== undefined) {
    request.end(JSON.stringify(options.body));
  } else {
    request.end();
  }
  await routed;

  return {
    body: response.body ? JSON.parse(response.body) : null,
    rawBody: response.body,
    response,
  };
}

describe("createBrokerHttpRouter", () => {
  test("passes snapshot cutoffs to the broker service", async () => {
    const queries: unknown[] = [];
    const harness = createHarness({
      brokerService: {
        ...createHarness().deps.brokerService,
        readSnapshot: async (query) => {
          queries.push(query);
          return { nodes: {} } as never;
        },
      },
    });

    const result = await requestRouter(
      harness,
      "GET",
      "/v1/snapshot?since=1234&scope=conversations",
    );

    expect(result.response.status).toBe(200);
    expect(queries).toEqual([{ since: 1234, scope: "conversations" }]);
  });

  test("forces mesh snapshot reads to the agents-only scope", async () => {
    const queries: unknown[] = [];
    const harness = createHarness({
      brokerService: {
        ...createHarness().deps.brokerService,
        readSnapshot: async (query) => {
          queries.push(query);
          return { agents: {} } as never;
        },
      },
    });

    const results = await Promise.all([
      requestRouter(harness, "GET", "/v1/mesh/snapshot?scope=agents"),
      requestRouter(harness, "GET", "/v1/mesh/snapshot"),
      requestRouter(harness, "GET", "/v1/mesh/snapshot?scope=conversations"),
    ]);

    expect(results.map((result) => result.response.status)).toEqual([200, 200, 200]);
    expect(queries).toEqual([
      { since: null, scope: "agents" },
      { since: null, scope: "agents" },
      { since: null, scope: "agents" },
    ]);
  });

  test("serves the bounded conversation projection without reading the registry snapshot", async () => {
    const queries: unknown[] = [];
    const harness = createHarness({
      brokerService: {
        ...createHarness().deps.brokerService,
        readConversationProjection: async (query) => {
          queries.push(query);
          return {
            projectionId: "projection-1",
            projectionVersion: 1,
            sequence: 7,
            generatedAt: 10,
            sourceFreshAt: null,
            items: [],
            total: 0,
            hasMore: false,
            engagedFeedId: null,
            identityRedirects: [],
          };
        },
      },
    });

    const result = await requestRouter(
      harness,
      "GET",
      "/v1/conversation-projection?limit=160",
    );

    expect(result.response.status).toBe(200);
    expect(queries).toEqual([{ limit: 160 }]);
    expect(result.body).toMatchObject({ projectionId: "projection-1", sequence: 7 });
  });

  test("forwards scoped alias writes to the authoritative broker without touching the local store", async () => {
    const forwards: Array<{ nodeSelector: string; path: string; method: string; body?: unknown }> = [];
    const harness = createHarness({
      routeAliasService: {} as BrokerHttpRouterDeps["routeAliasService"],
      forwardRouteAliasRequest: async (input) => {
        forwards.push(input);
        return { status: 201, body: { binding: { id: "alias-remote", revision: 1 } } };
      },
    });

    const result = await requestRouter(harness, "POST", "/v1/aliases", {
      body: {
        alias: "review",
        scope: { projectRoot: "/work/alpha", nodeId: "node-remote" },
        target: { kind: "agent_id", agentId: "agent-remote" },
        caller: { actorId: "operator", currentDirectory: "/work/alpha" },
      },
    });

    expect(result.response.status).toBe(201);
    expect(result.body).toEqual({ binding: { id: "alias-remote", revision: 1 } });
    expect(forwards).toEqual([expect.objectContaining({
      nodeSelector: "node-remote",
      path: "/v1/aliases",
      method: "POST",
      body: expect.objectContaining({ alias: "review" }),
    })]);
  });

  test("forwards host-qualified alias delivery wholesale so exact remote sessions resolve at authority", async () => {
    const forwards: Array<{ nodeSelector: string; path: string; method: string; body?: unknown }> = [];
    const harness = createHarness({
      forwardRouteAliasRequest: async (input) => {
        forwards.push(input);
        return { status: 202, body: { kind: "delivery", accepted: true, aliasResolution: { bindingId: "alias-remote", revision: 3 } } };
      },
    });

    const result = await requestRouter(harness, "POST", "/v1/deliver", {
      body: {
        body: "continue exactly there",
        intent: "consult",
        target: { kind: "route_alias", alias: "patch", scope: { projectRoot: "/work/alpha", nodeId: "node-remote" } },
      },
    });

    expect(result.response.status).toBe(202);
    expect(result.body).toEqual(expect.objectContaining({
      kind: "delivery",
      aliasResolution: { bindingId: "alias-remote", revision: 3 },
    }));
    expect(forwards).toEqual([expect.objectContaining({
      nodeSelector: "node-remote",
      path: "/v1/deliver",
      method: "POST",
    })]);
    expect(harness.deliverCalls).toEqual([]);
  });

  test("routes common JSON responses and CORS preflight without daemon state", async () => {
    const harness = createHarness();

    const health = await requestRouter(harness, "GET", "/health");
    expect(health.response.status).toBe(200);
    expect(health.body).toEqual({ ok: true, nodeId: "node-1", meshId: "mesh-1" });

    const preflight = await requestRouter(harness, "OPTIONS", "/v1/web/status");
    expect(preflight.response.status).toBe(204);
    expect(preflight.response.headers).toEqual({
      "access-control-allow-origin": "http://app.test",
    });
    expect(preflight.rawBody).toBe("");

    const missing = await requestRouter(harness, "GET", "/missing");
    expect(missing.response.status).toBe(404);
    expect(missing.body).toEqual({ error: "not_found" });
  });

  test("maps deliver outcomes onto transport status codes and passes an abort signal", async () => {
    const outcomes = [
      { kind: "delivery", deliveryId: "delivery-1" },
      { kind: "question", questionId: "question-1" },
      { kind: "unavailable", detail: "offline" },
    ];
    const harness = createHarness({
      brokerService: {
        ...createHarness().deps.brokerService,
        deliver: async (payload: unknown, options?: { signal?: AbortSignal }) => {
          harness.deliverCalls.push({ payload, signal: options?.signal });
          return outcomes.shift();
        },
      },
    } as Partial<BrokerHttpRouterDeps>);

    const delivery = await requestRouter(harness, "POST", "/v1/deliver", {
      body: { target: "agent-1", body: "hello", intent: "tell" },
    });
    const question = await requestRouter(harness, "POST", "/v1/deliver", {
      body: { target: "agent-2", body: "need input", intent: "tell" },
    });
    const unavailable = await requestRouter(harness, "POST", "/v1/deliver", {
      body: { target: "agent-3", body: "wake", intent: "tell" },
    });

    expect(delivery.response.status).toBe(202);
    expect(question.response.status).toBe(409);
    expect(unavailable.response.status).toBe(422);
    expect(harness.deliverCalls).toHaveLength(3);
    expect(harness.deliverCalls[0]?.payload).toEqual({
      target: "agent-1",
      body: "hello",
      intent: "tell",
    });
    expect(harness.deliverCalls[0]?.signal).toBeInstanceOf(AbortSignal);

    const malformedSignal = await requestRouter(harness, "POST", "/v1/deliver", {
      body: {
        targetLabel: "@operator",
        body: "Optional input",
        intent: "tell",
        operatorSignal: {
          kind: "consult",
          blocking: false,
          replyExpectation: "optional",
          defaultAction: " ",
        },
      },
    });
    expect(malformedSignal.response.status).toBe(400);
    expect(malformedSignal.body).toMatchObject({ error: "invalid_request" });
    expect(harness.deliverCalls).toHaveLength(3);
  });

  test("maps rendezvous results and validation failures onto HTTP statuses", async () => {
    const requests: unknown[] = [];
    const harness = createHarness({
      rendezvousService: {
        match: async (request: unknown) => {
          requests.push(request);
          const codename = (request as { codename?: string }).codename;
          if (codename === "BAD") {
            throw new Error("codename is invalid");
          }
          if (codename === "NO4FND") {
            return {
              status: "not_found",
              codename,
              projectRoot: "/repo",
              participantId: "session:three",
              suggestion: "check_codename_or_create",
            };
          }
          if (codename === "EX5PRD") {
            return {
              status: "expired",
              codename,
              projectRoot: "/repo",
              participantId: "session:three",
              expiresAt: 1,
              suggestion: "choose_another_codename",
            };
          }
          if (codename === "USED22") {
            return {
              status: "consumed",
              codename,
              projectRoot: "/repo",
              participantId: "session:three",
              expiresAt: 2,
              suggestion: "choose_another_codename",
            };
          }
          if (codename === "OTHER2") {
            return {
              status: "project_mismatch",
              codename,
              projectRoot: "/repo",
              participantId: "session:three",
              suggestion: "run_in_invitation_project",
            };
          }
          return {
            status: "codename_busy",
            codename: "BlueBird",
            projectRoot: "/repo",
            participantId: "session:three",
            participantCount: 2,
            expiresAt: 2,
            suggestion: "choose_another_codename",
          };
        },
      },
    } as Partial<BrokerHttpRouterDeps>);

    const busy = await requestRouter(harness, "POST", "/v1/rendezvous/match", {
      body: {
        action: "join",
        codename: "BlueBird",
        projectRoot: "/repo",
        participantId: "session:three",
        waitMs: 0,
      },
    });
    const invalid = await requestRouter(harness, "POST", "/v1/rendezvous/match", {
      body: {
        action: "join",
        codename: "BAD",
        projectRoot: "/repo",
        participantId: "session:three",
        waitMs: 0,
      },
    });
    const notFound = await requestRouter(harness, "POST", "/v1/rendezvous/match", {
      body: { action: "join", codename: "NO4FND", projectRoot: "/repo", participantId: "session:three" },
    });
    const expired = await requestRouter(harness, "POST", "/v1/rendezvous/match", {
      body: { action: "join", codename: "EX5PRD", projectRoot: "/repo", participantId: "session:three" },
    });
    const consumed = await requestRouter(harness, "POST", "/v1/rendezvous/match", {
      body: { action: "join", codename: "USED22", projectRoot: "/repo", participantId: "session:three" },
    });
    const projectMismatch = await requestRouter(harness, "POST", "/v1/rendezvous/match", {
      body: { action: "join", codename: "OTHER2", projectRoot: "/repo", participantId: "session:three" },
    });

    expect(busy.response.status).toBe(409);
    expect(busy.body).toMatchObject({ status: "codename_busy", participantCount: 2 });
    expect(notFound.response.status).toBe(404);
    expect(expired.response.status).toBe(410);
    expect(consumed.response.status).toBe(409);
    expect(projectMismatch.response.status).toBe(409);
    expect(invalid.response.status).toBe(400);
    expect(requests).toHaveLength(6);
  });

  test("validates invocation requests before dispatch", async () => {
    const harness = createHarness();

    const accepted = await requestRouter(harness, "POST", "/v1/invocations", {
      body: {
        id: "inv-1",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "agent-1",
        action: "consult",
        task: "help",
        ensureAwake: true,
        stream: false,
        createdAt: 100,
      },
    });
    expect(accepted.response.status).toBe(202);
    expect(accepted.body).toEqual({ ok: true });
    expect(harness.invocationCalls).toEqual([
      expect.objectContaining({
        id: "inv-1",
        action: "consult",
        task: "help",
      }),
    ]);

    const invalidShape = await requestRouter(harness, "POST", "/v1/invocations", {
      body: {
        id: "inv-2",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "agent-1",
        action: "dance",
        task: "help",
        ensureAwake: true,
        stream: false,
        createdAt: 100,
      },
    });
    expect(invalidShape.response.status).toBe(400);
    expect(invalidShape.body).toMatchObject({
      error: "invalid_request",
    });

    const invalidContinuation = await requestRouter(harness, "POST", "/v1/invocations", {
      body: {
        id: "inv-3",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "agent-1",
        action: "consult",
        task: "help",
        execution: { session: "existing" },
        ensureAwake: true,
        stream: false,
        createdAt: 100,
      },
    });
    expect(invalidContinuation.response.status).toBe(400);
    expect(invalidContinuation.body).toMatchObject({
      error: "invalid_request",
      detail: expect.stringContaining("session existing requires targetSessionId"),
    });
    expect(harness.invocationCalls).toHaveLength(1);
  });

  test("returns JSON-RPC parse errors on malformed A2A requests", async () => {
    const harness = createHarness();

    const result = await requestRouter(harness, "POST", "/v1/a2a/rpc", {
      rawBody: "{not-json",
    });

    expect(result.response.status).toBe(200);
    expect(result.response.headers?.["cache-control"]).toBe("no-cache");
    expect(result.body).toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32700,
      },
    });
  });

  test("wires read cursor GET and POST routes through explicit dependencies", async () => {
    const harness = createHarness();

    const listed = await requestRouter(harness, "GET", "/v1/conversations/conversation-1/read-cursors");
    expect(listed.response.status).toBe(200);
    expect(listed.body).toEqual([{
      conversationId: "conversation-1",
      actorId: "agent-1",
      lastReadAt: 100,
      updatedAt: 100,
    }]);

    const updated = await requestRouter(harness, "POST", "/v1/conversations/conversation-1/read-cursors", {
      body: {
        actorId: "agent-1",
        lastReadSeq: 7,
      },
    });
    expect(updated.response.status).toBe(200);
    expect(updated.body).toEqual({
      ok: true,
      cursor: {
        conversationId: "conversation-1",
        actorId: "agent-1",
        lastReadAt: 100,
        updatedAt: 100,
      },
      acknowledgedDeliveries: ["delivery-1"],
    });
    expect(harness.cursorBodies).toEqual([{ actorId: "agent-1", lastReadSeq: 7 }]);
  });

  test("routes assigned-role and mission-log writes through the broker database", async () => {
    const unavailable = createHarness();
    const unavailableResult = await requestRouter(
      unavailable,
      "GET",
      "/v1/roles/assignments",
    );
    expect(unavailableResult.response.status).toBe(503);

    const db = new Database(":memory:");
    try {
      migrateControlPlaneDatabaseSchema(db);
      const harness = createHarness({ openRolesDb: () => db });

      const catalog = await requestRouter(harness, "GET", "/v1/roles/catalog");
      expect(catalog.response.status).toBe(200);
      expect(catalog.body).toMatchObject({
        roles: [expect.objectContaining({ id: "orchestrator" })],
      });

      const assigned = await requestRouter(harness, "POST", "/v1/roles/assignments", {
        body: {
          roleId: "orchestrator",
          agentId: "agent-1",
          scope: { kind: "mission", missionId: "work-1" },
        },
      });
      expect(assigned.response.status).toBe(201);
      expect(assigned.body).toMatchObject({
        assignment: {
          roleId: "orchestrator",
          agentId: "agent-1",
          active: true,
        },
      });

      const listed = await requestRouter(
        harness,
        "GET",
        "/v1/roles/assignments?missionId=work-1",
      );
      expect(listed.response.status).toBe(200);
      expect(listed.body).toMatchObject({
        assignments: [expect.objectContaining({ agentId: "agent-1" })],
      });

      const appended = await requestRouter(harness, "POST", "/v1/missions/work-1/log", {
        body: {
          actorId: "agent-1",
          kind: "progress",
          intent: "Ship the role shell",
          status: "verified",
        },
      });
      expect(appended.response.status).toBe(201);
      expect(appended.body).toMatchObject({
        entry: {
          missionId: "work-1",
          actorId: "agent-1",
          seq: 1,
        },
      });

      const log = await requestRouter(harness, "GET", "/v1/missions/work-1/log");
      expect(log.response.status).toBe(200);
      expect(log.body).toMatchObject({
        missionId: "work-1",
        entries: [expect.objectContaining({ status: "verified" })],
      });

      const assignmentId = (assigned.body as { assignment: { id: string } }).assignment.id;
      const revoked = await requestRouter(
        harness,
        "POST",
        `/v1/roles/assignments/${encodeURIComponent(assignmentId)}/revoke`,
      );
      expect(revoked.response.status).toBe(200);
      expect(revoked.body).toMatchObject({ assignment: { active: false } });

      const denied = await requestRouter(harness, "POST", "/v1/missions/work-1/log", {
        body: {
          actorId: "agent-1",
          kind: "progress",
          intent: "Write after revoke",
          status: "should fail",
        },
      });
      expect(denied.response.status).toBe(400);
      expect(denied.body).toMatchObject({
        error: "bad_request",
        detail: expect.stringContaining("not an assigned mission-log writer"),
      });
    } finally {
      db.close();
    }
  });

  describe("mesh trust operator routes", () => {
    function trustHarness(peers: BrokerHttpRouterDeps["meshTrust"] extends infer T
      ? T extends { peers: infer P } ? P : never
      : never) {
      return createHarness({
        meshTrust: {
          enrollment: new TrustEnrollmentService({
            keyId: "f".repeat(64),
            publicKey: "local-public-key",
            nodeId: "node-1",
            fingerprint: "osc1:aaaa-bbbb",
          }),
          rateLimiter: new TrustEndpointRateLimiter(),
          nodeCard: () => ({ keyId: "f".repeat(64) }) as never,
          gateMode: () => "verify-warn",
          persistGrant: () => true,
          peers,
        },
      });
    }

    function memoryPeerStore(seed: TrustedPeerRecord[] = []) {
      const records = new Map(seed.map((peer) => [peer.keyId, peer]));
      return {
        records,
        store: {
          listTrustedPeers: () => [...records.values()],
          trustedPeer: (keyId: string) => records.get(keyId),
          upsertTrustedPeer: (peer: TrustedPeerRecord) => {
            records.set(peer.keyId, peer);
          },
          revokeTrustedPeer: (keyId: string) => records.delete(keyId),
        },
      };
    }

    function peerFixture(overrides: Partial<TrustedPeerRecord> = {}): TrustedPeerRecord {
      return {
        keyId: "a".repeat(64),
        publicKey: "peer-public-key",
        fingerprint: "osc1:cccc-dddd",
        label: "peer-a",
        tier: "observe",
        grantedVia: "sas",
        grantedAt: 1,
        ...overrides,
      };
    }

    test("lists trusted peers, 503 when persistence is disabled", async () => {
      const { store } = memoryPeerStore([peerFixture()]);
      const harness = trustHarness(store);

      const listed = await requestRouter(harness, "GET", "/v1/trust/peers");
      expect(listed.response.status).toBe(200);
      expect(listed.body).toMatchObject({
        peers: [expect.objectContaining({ keyId: "a".repeat(64), tier: "observe" })],
      });

      const disabled = trustHarness(null);
      const unavailable = await requestRouter(disabled, "GET", "/v1/trust/peers");
      expect(unavailable.response.status).toBe(503);
      expect(unavailable.body).toMatchObject({ error: "trust_persistence_unavailable" });
    });

    test("revokes a peer by full key ID", async () => {
      const { records, store } = memoryPeerStore([peerFixture()]);
      const harness = trustHarness(store);

      const malformed = await requestRouter(harness, "POST", "/v1/trust/revoke", {
        body: { keyId: "not-a-key-id" },
      });
      expect(malformed.response.status).toBe(400);

      const missing = await requestRouter(harness, "POST", "/v1/trust/revoke", {
        body: { keyId: "b".repeat(64) },
      });
      expect(missing.response.status).toBe(404);
      expect(missing.body).toMatchObject({ error: "unknown_peer" });

      const revoked = await requestRouter(harness, "POST", "/v1/trust/revoke", {
        body: { keyId: "a".repeat(64) },
      });
      expect(revoked.response.status).toBe(200);
      expect(revoked.body).toMatchObject({ keyId: "a".repeat(64), state: "revoked" });
      expect(records.size).toBe(0);
    });

    test("adjusts an existing peer's tier and label", async () => {
      const { records, store } = memoryPeerStore([peerFixture()]);
      const harness = trustHarness(store);

      const missing = await requestRouter(harness, "POST", "/v1/trust/grant", {
        body: { keyId: "b".repeat(64), tier: "control" },
      });
      expect(missing.response.status).toBe(404);

      const badTier = await requestRouter(harness, "POST", "/v1/trust/grant", {
        body: { keyId: "a".repeat(64), tier: "admin" },
      });
      expect(badTier.response.status).toBe(400);

      const granted = await requestRouter(harness, "POST", "/v1/trust/grant", {
        body: { keyId: "a".repeat(64), tier: "control", label: "peer-a-renamed" },
      });
      expect(granted.response.status).toBe(200);
      expect(granted.body).toMatchObject({
        peer: { keyId: "a".repeat(64), tier: "control", label: "peer-a-renamed" },
      });
      expect(records.get("a".repeat(64))?.tier).toBe("control");
    });

    test("installs a direct grant only when key ID and fingerprint match the public key", async () => {
      const { publicKey } = generateKeyPairSync("ed25519");
      const publicKeyBase64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
      const keyId = nodeKeyId(publicKeyBase64);
      const fingerprint = nodeFingerprint(publicKeyBase64);
      const { records, store } = memoryPeerStore();
      const harness = trustHarness(store);

      const mismatched = await requestRouter(harness, "POST", "/v1/trust/grant", {
        body: {
          keyId: "c".repeat(64),
          publicKey: publicKeyBase64,
          fingerprint,
          label: "peer-c",
          tier: "observe",
        },
      });
      expect(mismatched.response.status).toBe(400);
      expect(records.size).toBe(0);

      const granted = await requestRouter(harness, "POST", "/v1/trust/grant", {
        body: {
          keyId,
          publicKey: publicKeyBase64,
          fingerprint,
          label: "peer-c",
          tier: "control",
          nodeId: "node-c",
        },
      });
      expect(granted.response.status).toBe(200);
      expect(granted.body).toMatchObject({
        peer: { keyId, fingerprint, tier: "control", grantedVia: "sas" },
      });
      expect(records.get(keyId)?.publicKey).toBe(publicKeyBase64);

      // §3c SSH install-grant: grantedVia + TLS pin from verified card.
      const sshKey = generateKeyPairSync("ed25519");
      const sshPublicKey = sshKey.publicKey.export({ type: "spki", format: "der" }).toString("base64");
      const sshKeyId = nodeKeyId(sshPublicKey);
      const sshFingerprint = nodeFingerprint(sshPublicKey);
      const tlsPin = "cd".repeat(32);
      const sshGranted = await requestRouter(harness, "POST", "/v1/trust/grant", {
        body: {
          keyId: sshKeyId,
          publicKey: sshPublicKey,
          fingerprint: sshFingerprint,
          label: "peer-ssh",
          tier: "control",
          grantedVia: "ssh",
          tlsSpkiFingerprint: tlsPin,
        },
      });
      expect(sshGranted.response.status).toBe(200);
      expect(sshGranted.body).toMatchObject({
        peer: {
          keyId: sshKeyId,
          grantedVia: "ssh",
          tlsSpkiFingerprint: tlsPin,
        },
      });
      expect(records.get(sshKeyId)?.tlsSpkiFingerprint).toBe(tlsPin);
    });

    test("lists in-flight enrollment sessions for the responder-side operator", async () => {
      const harness = trustHarness(memoryPeerStore().store);
      const result = await requestRouter(harness, "GET", "/v1/trust/enroll/sessions");
      expect(result.response.status).toBe(200);
      expect(result.body).toEqual({ sessions: [] });
    });

    test("machine-local trust mutations refuse remote callers even in verify-warn gate mode", async () => {
      // The handler re-checks the transport context itself, so a remote
      // caller is denied regardless of gate rollout mode (the harness's
      // gateMode is verify-warn, where the ingress gate would only log).
      const { records, store } = memoryPeerStore([peerFixture()]);
      const harness = trustHarness(store);
      const remote = { transport: "remote" as const, remoteAddress: "10.0.0.5" };

      for (const [path, body] of [
        ["/v1/trust/revoke", { keyId: "a".repeat(64) }],
        ["/v1/trust/grant", { keyId: "a".repeat(64), tier: "control" }],
        ["/v1/trust/enroll/approve", { enrollmentId: "enr-1", tier: "observe" }],
        ["/v1/trust/enroll/reject", { enrollmentId: "enr-1" }],
      ] as const) {
        const result = await requestRouter(harness, "POST", path, { body, transportContext: remote });
        expect(result.response.status, path).toBe(403);
        expect(result.body).toMatchObject({ error: "forbidden" });
      }
      expect(records.get("a".repeat(64))?.tier).toBe("observe");

      // Loopback (and gate-bypassing in-process callers) still pass.
      const granted = await requestRouter(harness, "POST", "/v1/trust/grant", {
        body: { keyId: "a".repeat(64), tier: "control" },
        transportContext: { transport: "loopback", remoteAddress: "127.0.0.1" },
      });
      expect(granted.response.status).toBe(200);
    });
  });

  describe("remote-tier mesh read routes (mesh trust cone §4)", () => {
    test("POST /v1/mesh/aliases/resolve reuses the local alias resolution logic", async () => {
      const resolutions: unknown[] = [];
      const harness = createHarness({
        routeAliasService: {
          resolve: (body: unknown) => {
            resolutions.push(body);
            return { resolved: true, binding: { id: "alias-1" }, proof: { revision: 1 } };
          },
        } as unknown as BrokerHttpRouterDeps["routeAliasService"],
      });

      const result = await requestRouter(harness, "POST", "/v1/mesh/aliases/resolve", {
        body: { alias: "review", caller: { actorId: "operator" } },
      });

      expect(result.response.status).toBe(200);
      expect(result.body).toMatchObject({ resolved: true });
      expect(resolutions).toHaveLength(1);
    });

    test("GET /v1/mesh/snapshot exposes only the peer agent projection", async () => {
      const harness = createHarness({
        brokerService: {
          ...createHarness().deps.brokerService,
          readSnapshot: async (query) => query?.scope === "agents"
            ? { agents: {} } as never
            : { nodes: { "node-1": { id: "node-1" } } } as never,
        },
      });

      const meshed = await requestRouter(harness, "GET", "/v1/mesh/snapshot");
      expect(meshed.response.status).toBe(200);
      expect(meshed.body).toEqual({ agents: {} });

      const local = await requestRouter(harness, "GET", "/v1/snapshot");
      expect(local.body).toEqual({ nodes: { "node-1": { id: "node-1" } } });
    });

    test("GET /v1/mesh/invocations/:id/stream reuses the invocation stream logic", async () => {
      const streams: Array<{ invocationId: string }> = [];
      const harness = createHarness({
        controlStreams: {
          addInboxStream: () => {},
          addEventStream: () => {},
          addInvocationStream: (args: { invocationId: string }) => {
            streams.push({ invocationId: args.invocationId });
          },
        } as unknown as BrokerHttpRouterDeps["controlStreams"],
      });

      await requestRouter(harness, "GET", "/v1/mesh/invocations/inv-42/stream");

      expect(streams).toEqual([{ invocationId: "inv-42" }]);
    });
  });

  describe("POST /v1/mesh/bind", () => {
    test("applies scope locally and refuses remote callers", async () => {
      const applied: string[] = [];
      const harness = createHarness({
        meshBind: {
          applyScope: async (scope) => {
            applied.push(scope);
            return {
              scope,
              port: 43110,
              tlsAddresses: scope === "mesh" ? ["192.168.1.10"] : [],
              endpoints: scope === "mesh" ? ["https://192.168.1.10:43110"] : ["http://127.0.0.1:43110"],
              brokerUrl: scope === "mesh" ? "https://192.168.1.10:43110" : "http://127.0.0.1:43110",
              tlsSpkiFingerprint: scope === "mesh" ? "a".repeat(64) : null,
              mdnsAdvertising: scope === "mesh",
              hasNonLoopbackListener: scope === "mesh",
            };
          },
          getState: () => ({ scope: "local" }),
        },
      });

      const ok = await requestRouter(harness, "POST", "/v1/mesh/bind", {
        body: { scope: "mesh" },
        transportContext: { transport: "loopback", remoteAddress: "127.0.0.1" },
      });
      expect(ok.response.status).toBe(200);
      expect(ok.body).toMatchObject({
        bind: {
          scope: "mesh",
          hasNonLoopbackListener: true,
          tlsSpkiFingerprint: "a".repeat(64),
        },
      });
      expect(applied).toEqual(["mesh"]);

      const remote = await requestRouter(harness, "POST", "/v1/mesh/bind", {
        body: { scope: "local" },
        transportContext: { transport: "remote", remoteAddress: "192.168.1.50" },
      });
      expect(remote.response.status).toBe(403);
      expect(remote.body).toMatchObject({ error: "forbidden", detail: "route is machine-local" });
      expect(applied).toEqual(["mesh"]); // remote call did not apply

      const bad = await requestRouter(harness, "POST", "/v1/mesh/bind", {
        body: { scope: "wan" },
        transportContext: { transport: "loopback" },
      });
      expect(bad.response.status).toBe(400);
    });
  });
});
