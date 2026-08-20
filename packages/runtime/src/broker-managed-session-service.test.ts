import { describe, expect, test } from "bun:test";

import type {
  AgentDefinition,
  AgentEndpoint,
} from "@openscout/protocol";

import { createInMemoryControlRuntime } from "./broker.js";
import { BrokerManagedSessionService } from "./broker-managed-session-service.js";
import type { PairingSession } from "./pairing-session-agents.js";

function testAgent(input: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: "agent-1",
    kind: "agent",
    definitionId: "agent-1",
    displayName: "Agent One",
    handle: "agent-one",
    labels: ["agent"],
    metadata: {},
    selector: "@agent-one",
    defaultSelector: "@agent-one",
    agentClass: "general",
    capabilities: ["chat", "invoke", "deliver"],
    wakePolicy: "manual",
    homeNodeId: "node-1",
    authorityNodeId: "node-1",
    advertiseScope: "local",
    ...input,
  };
}

function testEndpoint(input: Partial<AgentEndpoint> = {}): AgentEndpoint {
  return {
    id: "endpoint-1",
    agentId: "agent-1",
    nodeId: "node-1",
    harness: "codex",
    transport: "pairing_bridge",
    state: "idle",
    metadata: {},
    ...input,
  };
}

function testPairingSession(input: Partial<PairingSession> = {}): PairingSession {
  return {
    id: "session-1",
    name: "Repo Session",
    adapterType: "codex",
    status: "active",
    cwd: "/tmp/repo",
    model: "gpt-5",
    ...input,
  };
}

function createHarness(input: {
  sessions?: Record<string, PairingSession>;
  snapshotSessions?: Record<string, PairingSession | null>;
  now?: number;
} = {}) {
  const runtime = createInMemoryControlRuntime({}, { localNodeId: "node-1" });
  const sessions = new Map(Object.entries(input.sessions ?? {}));
  const snapshotSessions = new Map(Object.entries(input.snapshotSessions ?? {}));
  const persistedEndpoints: AgentEndpoint[] = [];
  const upsertedAgents: AgentDefinition[] = [];
  const ensuredThreads: string[] = [];
  const shutDownEndpointIds: string[] = [];
  let idCounter = 0;

  const service = new BrokerManagedSessionService({
    nodeId: "node-1",
    runtime,
    createId(prefix) {
      idCounter += 1;
      return `${prefix}-${idCounter}`;
    },
    isInactiveLocalAgent: (agent) => agent?.metadata?.staleLocalRegistration === true,
    async upsertAgent(agent) {
      upsertedAgents.push(agent);
      await runtime.upsertAgent(agent);
    },
    async persistEndpoint(endpoint) {
      persistedEndpoints.push(endpoint);
      await runtime.upsertEndpoint(endpoint);
    },
    async findPairingSession(externalSessionId) {
      return sessions.get(externalSessionId) ?? null;
    },
    async getPairingSessionSnapshot(externalSessionId) {
      if (!snapshotSessions.has(externalSessionId)) {
        return null;
      }
      const session = snapshotSessions.get(externalSessionId);
      return session ? { session } : null;
    },
    async ensurePairingSessionForCodexThread({ threadId, cwd, name }) {
      ensuredThreads.push(threadId);
      return testPairingSession({
        id: `pairing-${threadId.slice(0, 8)}`,
        name: name ?? "Codex",
        cwd,
      });
    },
    async shutdownLocalSessionEndpoint(endpoint) {
      shutDownEndpointIds.push(endpoint.id);
    },
    now: () => input.now ?? 10_000,
  });

  return {
    runtime,
    service,
    persistedEndpoints,
    upsertedAgents,
    ensuredThreads,
    shutDownEndpointIds,
  };
}

describe("BrokerManagedSessionService", () => {
  test("attaches pairing sessions idempotently and reuses the managed endpoint", async () => {
    const firstSession = testPairingSession({ id: "session-1", name: "First Session" });
    const secondSession = testPairingSession({ id: "session-2", name: "Second Session", model: "gpt-5.1" });
    const harness = createHarness({
      sessions: {
        "session-1": firstSession,
        "session-2": secondSession,
      },
    });

    const first = await harness.service.attachManagedPairingSession({
      externalSessionId: "session-1",
      alias: "@repo",
      displayName: "Repo",
    });
    const second = await harness.service.attachManagedPairingSession({
      externalSessionId: "session-2",
      alias: "@repo",
      displayName: "Repo Updated",
    });
    const snapshot = harness.runtime.snapshot();

    expect(second.agentId).toBe(first.agentId);
    expect(second.endpointId).toBe(first.endpointId);
    expect(Object.values(snapshot.agents).filter((agent) => agent.selector === "@repo")).toHaveLength(1);
    expect(Object.values(snapshot.endpoints).filter((endpoint) => endpoint.agentId === first.agentId)).toHaveLength(1);
    expect(snapshot.agents[first.agentId]?.displayName).toBe("Repo Updated");
    expect(snapshot.endpoints[first.endpointId]?.sessionId).toBe("session-2");
    expect(snapshot.endpoints[first.endpointId]?.metadata).toEqual(expect.objectContaining({
      externalSessionId: "session-2",
      pairingSessionId: "session-2",
      model: "gpt-5.1",
    }));
  });

  test("attaches and detaches Codex local sessions as pairing-backed managed identities", async () => {
    const harness = createHarness();

    const attached = await harness.service.attachManagedLocalSession({
      externalSessionId: "019d9762-19f7-7792-8962-90d924ce7faa",
      transport: "codex_app_server",
      cwd: "/tmp/codex-here",
      alias: "@codex-here",
      displayName: "Codex Here",
    });
    const detached = await harness.service.detachManagedLocalSession({
      alias: "@codex-here",
    });
    const snapshot = harness.runtime.snapshot();

    expect(attached.selector).toBe("@codex-here");
    expect(attached.sessionId).toBe("pairing-019d9762");
    expect(harness.ensuredThreads).toEqual(["019d9762-19f7-7792-8962-90d924ce7faa"]);
    expect(detached).toEqual({
      agentId: attached.agentId,
      endpointId: attached.endpointId,
      detached: true,
    });
    expect(snapshot.agents[attached.agentId]?.selector).toBe("@codex-here");
    expect(snapshot.endpoints[attached.endpointId]).toEqual(expect.objectContaining({
      transport: "pairing_bridge",
      state: "offline",
      sessionId: "pairing-019d9762",
      metadata: expect.objectContaining({
        source: "local-session",
        externalSessionId: "019d9762-19f7-7792-8962-90d924ce7faa",
        pairingSessionId: "pairing-019d9762",
        lastError: "local session detached",
        lastFailedAt: 10_000,
      }),
    }));
    expect(harness.shutDownEndpointIds).toEqual([]);
  });

  test("reconciles managed pairing endpoints and retires legacy pairing registrations", async () => {
    const harness = createHarness({
      snapshotSessions: {
        "session-active": testPairingSession({ id: "session-active", name: "Active Session", status: "idle" }),
        "session-missing": null,
      },
      now: 25_000,
    });
    await harness.runtime.upsertAgent(testAgent({
      id: "managed-agent",
      displayName: "Managed Agent",
      handle: "managed",
    }));
    await harness.runtime.upsertEndpoint(testEndpoint({
      id: "endpoint-managed",
      agentId: "managed-agent",
      sessionId: "session-active",
      metadata: {
        source: "pairing-session",
        managedByScout: true,
        externalSessionId: "session-active",
        stalePairingSession: true,
      },
    }));
    await harness.runtime.upsertEndpoint(testEndpoint({
      id: "endpoint-missing",
      agentId: "missing-agent",
      sessionId: "session-missing",
      metadata: {
        source: "pairing-session",
        managedByScout: true,
        externalSessionId: "session-missing",
      },
    }));
    await harness.runtime.upsertAgent(testAgent({
      id: "legacy-agent",
      metadata: { source: "pairing-session" },
    }));
    await harness.runtime.upsertEndpoint(testEndpoint({
      id: "endpoint-legacy",
      agentId: "legacy-agent",
      metadata: { source: "pairing-session" },
    }));

    await harness.service.reconcileManagedPairingEndpoints();
    await harness.service.retireLegacyPairingSessionAgents();
    const snapshot = harness.runtime.snapshot();

    expect(snapshot.endpoints["endpoint-managed"]).toEqual(expect.objectContaining({
      state: "idle",
      sessionId: "session-active",
      metadata: expect.objectContaining({
        stalePairingSession: false,
        sessionName: "Active Session",
      }),
    }));
    expect(snapshot.endpoints["endpoint-missing"]).toEqual(expect.objectContaining({
      state: "offline",
      metadata: expect.objectContaining({
        stalePairingSession: true,
        lastError: "pairing session session-missing is offline or unreachable",
        lastFailedAt: 25_000,
      }),
    }));
    expect(snapshot.agents["legacy-agent"]?.metadata).toEqual(expect.objectContaining({
      legacyAutoSync: true,
      retiredFromFleet: true,
      stalePairingSession: true,
      retiredAt: 25_000,
    }));
    expect(snapshot.endpoints["endpoint-legacy"]).toEqual(expect.objectContaining({
      state: "offline",
      metadata: expect.objectContaining({
        legacyAutoSync: true,
        retiredFromFleet: true,
        stalePairingSession: true,
        lastError: "legacy pairing auto-sync retired; re-attach through Scout to manage this session",
        lastFailedAt: 25_000,
      }),
    }));
  });
});
