import { describe, expect, test } from "bun:test";

import type {
  ActorIdentity,
  AgentDefinition,
  AgentEndpoint,
  InvocationRequest,
} from "@openscout/protocol";

import { createInMemoryControlRuntime } from "./broker.js";
import {
  BrokerLocalEndpointResolver,
  PENDING_PROVISIONED_RUNTIME_TRUST_MS,
} from "./broker-local-endpoint-resolver.js";
import type { LocalAgentBinding } from "./local-agents.js";

function testActor(input: Partial<ActorIdentity> = {}): ActorIdentity {
  return {
    id: "agent-1",
    kind: "agent",
    displayName: "Agent One",
    handle: "agent-one",
    labels: ["agent"],
    metadata: {},
    ...input,
  };
}

function testAgent(input: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    ...testActor(input),
    id: "agent-1",
    kind: "agent",
    definitionId: "agent-1",
    selector: "@agent-one",
    defaultSelector: "@agent-one",
    agentClass: "general",
    capabilities: ["chat", "invoke", "deliver"],
    wakePolicy: "on_demand",
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
    transport: "codex_app_server",
    state: "idle",
    sessionId: "session-1",
    metadata: {},
    ...input,
  };
}

function testInvocation(input: Partial<InvocationRequest> = {}): InvocationRequest {
  return {
    id: "invocation-1",
    requesterId: "operator",
    requesterNodeId: "node-1",
    targetAgentId: "agent-1",
    action: "consult",
    task: "hello",
    ensureAwake: false,
    stream: false,
    createdAt: 1_000,
    metadata: {},
    ...input,
  };
}

function createResolver(input: {
  bindings?: Record<string, LocalAgentBinding | null>;
  onlineSession?: {
    externalSessionId?: string | null;
    metadata?: Record<string, unknown>;
  };
  isolatedEndpoint?: AgentEndpoint | null;
  now?: number;
} = {}) {
  const runtime = createInMemoryControlRuntime({}, { localNodeId: "node-1" });
  const persistedEndpoints: AgentEndpoint[] = [];
  const upsertedActors: ActorIdentity[] = [];
  const upsertedAgents: AgentDefinition[] = [];
  const ensuredBindings: Array<{ agentId: string; harness?: string }> = [];
  const ensuredSessionEndpoints: AgentEndpoint[] = [];
  const isolatedInvocations: InvocationRequest[] = [];
  const resolver = new BrokerLocalEndpointResolver({
    nodeId: "node-1",
    runtime,
    isLocalAgentEndpointAlive: (endpoint) => endpoint.metadata?.alive === true,
    async ensureLocalSessionEndpointOnline(endpoint) {
      ensuredSessionEndpoints.push(endpoint);
      return input.onlineSession ?? { externalSessionId: "revived-session" };
    },
    async ensureLocalAgentBindingOnline(agentId, _nodeId, options) {
      ensuredBindings.push({ agentId, harness: options.harness });
      return input.bindings?.[agentId] ?? null;
    },
    async createIsolatedAgentEndpoint(invocation) {
      isolatedInvocations.push(invocation);
      return input.isolatedEndpoint ?? null;
    },
    async upsertActor(actor) {
      upsertedActors.push(actor);
      await runtime.upsertActor(actor);
    },
    async upsertAgent(agent) {
      upsertedAgents.push(agent);
      await runtime.upsertAgent(agent);
    },
    async persistEndpoint(endpoint) {
      persistedEndpoints.push(endpoint);
      await runtime.upsertEndpoint(endpoint);
    },
    now: () => input.now ?? 10_000,
  });

  return {
    runtime,
    resolver,
    persistedEndpoints,
    upsertedActors,
    upsertedAgents,
    ensuredBindings,
    ensuredSessionEndpoints,
    isolatedInvocations,
  };
}

describe("BrokerLocalEndpointResolver", () => {
  test("selects active endpoints by transport preference and session aliases", async () => {
    const harness = createResolver();
    await harness.runtime.upsertEndpoint(testEndpoint({
      id: "codex",
      transport: "codex_app_server",
      metadata: { alive: true, lastStartedAt: 2_000 },
    }));
    await harness.runtime.upsertEndpoint(testEndpoint({
      id: "tmux",
      transport: "tmux",
      metadata: { alive: true, lastStartedAt: 1_000, tmuxSession: "tmux-session" },
    }));
    await harness.runtime.upsertEndpoint(testEndpoint({
      id: "stale",
      transport: "codex_app_server",
      metadata: { staleLocalRegistration: true, lastStartedAt: 10_000 },
    }));

    expect(harness.resolver.activeLocalEndpointForAgent("agent-1")?.id).toBe("tmux");
    expect(harness.resolver.activeLocalEndpointForAgent("agent-1", undefined, "tmux-session")?.id).toBe("tmux");
    expect(harness.resolver.activeLocalEndpointForAgent("agent-1", undefined, "missing")).toBeUndefined();
  });

  test("returns existing pairing endpoints and honors existing-session requests", async () => {
    const harness = createResolver();
    await harness.runtime.upsertEndpoint(testEndpoint({
      id: "pairing",
      transport: "pairing_bridge",
      sessionId: "pairing-session",
      metadata: { source: "pairing-session", managedByScout: true },
    }));

    await expect(harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      execution: { targetSessionId: "pairing-session" },
    }))).resolves.toEqual(expect.objectContaining({ id: "pairing" }));
    await expect(harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      targetAgentId: "missing-agent",
      execution: { session: "existing" },
      ensureAwake: true,
    }))).resolves.toBeUndefined();
  });

  test("rejects stale exact-session endpoints before trying to revive them", async () => {
    const harness = createResolver();
    await harness.runtime.upsertEndpoint(testEndpoint({
      id: "stale-session",
      sessionId: "thread-1",
      state: "waiting",
      metadata: {
        staleLocalRegistration: true,
        replacedByAgentId: "agent-2",
      },
    }));

    await expect(harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      execution: { targetSessionId: "thread-1" },
      ensureAwake: true,
    }))).rejects.toThrow("endpoint stale-session is a superseded local registration replaced by current setup");
    expect(harness.ensuredSessionEndpoints).toEqual([]);
  });

  test("revives managed local-session endpoints for exact-session wake requests", async () => {
    const harness = createResolver({
      onlineSession: {
        externalSessionId: "thread-revived",
        metadata: { runtimeInstanceId: "runtime-1" },
      },
      now: 12_000,
    });
    await harness.runtime.upsertEndpoint(testEndpoint({
      id: "local-session",
      transport: "codex_app_server",
      state: "waiting",
      sessionId: "thread-old",
      metadata: {
        source: "local-session",
        managedByScout: true,
        threadId: "thread-old",
        lastError: "offline",
        lastFailedAt: 9_000,
      },
    }));

    const endpoint = await harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      execution: { targetSessionId: "thread-old" },
      ensureAwake: true,
    }));

    expect(endpoint).toEqual(expect.objectContaining({
      id: "local-session",
      state: "idle",
      sessionId: "thread-old",
      metadata: expect.objectContaining({
        source: "local-session",
        managedByScout: true,
        runtimeInstanceId: "runtime-1",
        externalSessionId: "thread-revived",
        threadId: "thread-revived",
        lastResumedAt: 12_000,
      }),
    }));
    expect(endpoint?.metadata?.lastError).toBeUndefined();
    expect(endpoint?.metadata?.lastFailedAt).toBeUndefined();
    expect(harness.persistedEndpoints).toHaveLength(1);
  });

  test("rejects placement changes before reviving an exact session", async () => {
    const harness = createResolver();
    await harness.runtime.upsertEndpoint(testEndpoint({
      id: "background-session",
      state: "waiting",
      sessionId: "thread-background",
      metadata: {
        source: "local-session",
        managedByScout: true,
        placement: "background",
        threadId: "thread-background",
      },
    }));

    await expect(harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      execution: {
        session: "existing",
        targetSessionId: "thread-background",
        placement: "foreground",
      },
      ensureAwake: true,
    }))).rejects.toThrow("session thread-background is background; request foreground with a new session instead");
    expect(harness.ensuredSessionEndpoints).toEqual([]);
  });

  test("revives registry-backed Codex endpoints for exact-session wake requests", async () => {
    const harness = createResolver({
      onlineSession: {
        externalSessionId: "thread-current",
      },
      now: 13_000,
    });
    await harness.runtime.upsertEndpoint(testEndpoint({
      id: "registry-codex",
      transport: "codex_app_server",
      state: "waiting",
      sessionId: "relay-agent-codex",
      metadata: {
        source: "relay-agent-registry",
        runtimeInstanceId: "relay-agent-codex",
        externalSessionId: "thread-current",
        threadId: "thread-current",
        lastError: "codex_app_server session unavailable: relay-agent-codex",
        lastFailedAt: 9_000,
      },
    }));

    const endpoint = await harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      execution: { session: "existing", targetSessionId: "relay-agent-codex" },
      ensureAwake: true,
    }));

    expect(endpoint).toEqual(expect.objectContaining({
      id: "registry-codex",
      state: "idle",
      sessionId: "relay-agent-codex",
      metadata: expect.objectContaining({
        source: "relay-agent-registry",
        runtimeInstanceId: "relay-agent-codex",
        externalSessionId: "thread-current",
        threadId: "thread-current",
        lastResumedAt: 13_000,
      }),
    }));
    expect(endpoint?.metadata?.lastError).toBeUndefined();
    expect(endpoint?.metadata?.lastFailedAt).toBeUndefined();
    expect(harness.ensuredSessionEndpoints.map((candidate) => candidate.id)).toEqual(["registry-codex"]);
    expect(harness.persistedEndpoints).toHaveLength(1);
  });

  test("fails exact-session wake requests when the matching endpoint cannot be resumed", async () => {
    const harness = createResolver({ now: 14_000 });
    await harness.runtime.upsertEndpoint(testEndpoint({
      id: "missing-tmux",
      transport: "tmux",
      state: "waiting",
      sessionId: "relay-agent-claude",
      metadata: {
        source: "relay-agent-registry",
        tmuxSession: "relay-agent-claude",
      },
    }));

    await expect(harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      execution: { session: "existing", targetSessionId: "relay-agent-claude" },
      ensureAwake: true,
    }))).rejects.toThrow("session relay-agent-claude is not currently reachable");
    expect(harness.ensuredSessionEndpoints).toEqual([]);
    expect(harness.persistedEndpoints).toEqual([
      expect.objectContaining({
        id: "missing-tmux",
        state: "offline",
        metadata: expect.objectContaining({
          lastError: "tmux session missing: relay-agent-claude",
          lastFailedAt: 14_000,
        }),
      }),
    ]);
  });

  test("selects a wakeable session-backed endpoint only when wake is requested", async () => {
    const harness = createResolver();
    const endpoint = testEndpoint({
      id: "cardless-session",
      agentId: "session-cardless",
      transport: "claude_stream_json",
      harness: "claude",
      sessionId: "session-cardless",
      metadata: {
        source: "scout-cardless-session",
        cardless: true,
        sessionBacked: true,
        pendingExternalSession: true,
        pendingExternalSessionAt: 9_000,
      },
    });
    await harness.runtime.upsertEndpoint(endpoint);

    await expect(harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      targetAgentId: "session-cardless",
      ensureAwake: false,
      execution: { harness: "claude" },
    }))).resolves.toBeUndefined();
    await expect(harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      targetAgentId: "session-cardless",
      ensureAwake: true,
      execution: { harness: "claude" },
    }))).resolves.toEqual(endpoint);
    expect(harness.ensuredBindings).toEqual([]);
  });

  test("persists a provider thread while preserving pending-session routing identity", async () => {
    const harness = createResolver({
      onlineSession: {
        externalSessionId: "019ff3f8-322d-7572-990f-447725ffd348",
      },
    });
    const endpoint = testEndpoint({
      id: "spinoza-2",
      agentId: "session-spinoza-2",
      sessionId: "session-spinoza-2",
      metadata: {
        source: "scout-cardless-session",
        sessionBacked: true,
        pendingExternalSession: true,
      },
    });

    const prepared = await harness.resolver.prepareLocalEndpointForInvocation(endpoint);

    expect(prepared).toEqual(expect.objectContaining({
      id: endpoint.id,
      sessionId: "session-spinoza-2",
      metadata: expect.objectContaining({
        externalSessionId: "019ff3f8-322d-7572-990f-447725ffd348",
        threadId: "019ff3f8-322d-7572-990f-447725ffd348",
        pendingExternalSession: false,
      }),
    }));
    expect(harness.ensuredSessionEndpoints).toEqual([endpoint]);
    expect(harness.persistedEndpoints).toEqual([prepared]);
  });

  test("promotes Pi provider metadata instead of its Scout runtime result id", async () => {
    const harness = createResolver({
      onlineSession: {
        externalSessionId: "runtime-pi-spinoza",
        metadata: {
          externalSessionId: "native-pi-spinoza",
          threadId: "native-pi-spinoza",
        },
      },
    });
    const endpoint = testEndpoint({
      id: "pi-spinoza",
      agentId: "session-pi-spinoza",
      sessionId: "runtime-pi-spinoza",
      transport: "pi_rpc",
      harness: "pi",
      metadata: {
        source: "scout-cardless-session",
        sessionBacked: true,
        pendingExternalSession: true,
      },
    });

    const prepared = await harness.resolver.prepareLocalEndpointForInvocation(endpoint);

    expect(prepared.sessionId).toBe("runtime-pi-spinoza");
    expect(prepared.metadata).toEqual(expect.objectContaining({
      externalSessionId: "native-pi-spinoza",
      threadId: "native-pi-spinoza",
      pendingExternalSession: false,
    }));
  });

  test("does not preflight unsupported direct transports", async () => {
    const harness = createResolver();
    const endpoint = testEndpoint({
      transport: "grok_acp",
      harness: "grok",
      metadata: {
        sessionBacked: true,
        pendingExternalSession: true,
      },
    });

    await expect(harness.resolver.prepareLocalEndpointForInvocation(endpoint)).resolves.toEqual(endpoint);
    expect(harness.ensuredSessionEndpoints).toEqual([]);
    expect(harness.persistedEndpoints).toEqual([]);
  });

  test("starts and persists a local binding when wake is requested without an exact session", async () => {
    const actor = testActor({ id: "actor-1" });
    const agent = testAgent({ id: "agent-1" });
    const endpoint = testEndpoint({ id: "started-endpoint" });
    const harness = createResolver({
      bindings: {
        "agent-1": { actor, agent, endpoint },
      },
    });

    await expect(harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      ensureAwake: true,
      execution: { harness: "codex" },
    }))).resolves.toEqual(endpoint);
    expect(harness.ensuredBindings).toEqual([{ agentId: "agent-1", harness: "codex" }]);
    expect(harness.upsertedActors).toEqual([actor]);
    expect(harness.upsertedAgents).toEqual([agent]);
    expect(harness.persistedEndpoints).toEqual([endpoint]);
  });

  test("spawns an isolated endpoint for an exact runtime instead of reusing a live durable endpoint", async () => {
    const isolatedEndpoint = testEndpoint({
      id: "isolated-endpoint",
      sessionId: "isolated-session",
      metadata: { isolatedExecution: true },
    });
    const harness = createResolver({ isolatedEndpoint });
    await harness.runtime.upsertEndpoint(testEndpoint({
      id: "durable-endpoint",
      metadata: { alive: true },
    }));

    await expect(harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      ensureAwake: true,
      execution: { harness: "codex", model: "gpt-5.6-sol", reasoningEffort: "xhigh" },
    }))).resolves.toEqual(isolatedEndpoint);
    expect(harness.isolatedInvocations).toHaveLength(1);
    expect(harness.persistedEndpoints).toEqual([isolatedEndpoint]);
    expect(harness.ensuredBindings).toEqual([]);
  });

  test("fails closed instead of reusing an unobserved exact runtime when wake is disabled", async () => {
    const harness = createResolver();
    await harness.runtime.upsertEndpoint(testEndpoint({
      id: "unobserved-no-wake",
      metadata: { alive: true },
    }));

    await expect(harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      ensureAwake: false,
      execution: { harness: "codex", model: "gpt-5.6-sol", reasoningEffort: "xhigh" },
    }))).rejects.toThrow("session_runtime_unobserved");
    expect(harness.isolatedInvocations).toEqual([]);
  });

  test("reuses an observed exact runtime when wake is disabled", async () => {
    const harness = createResolver();
    const endpoint = testEndpoint({
      id: "observed-no-wake",
      metadata: {
        alive: true,
        observedRuntime: {
          harness: "codex",
          model: "gpt-5.6-sol",
          reasoningEffort: "xhigh",
        },
      },
    });
    await harness.runtime.upsertEndpoint(endpoint);

    await expect(harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      ensureAwake: false,
      execution: { harness: "codex", model: "gpt-5.6-sol", reasoningEffort: "xhigh" },
    }))).resolves.toEqual(endpoint);
  });

  test("allows an exact existing session only when every requested dimension was observed to match", async () => {
    const harness = createResolver();
    const endpoint = testEndpoint({
      id: "observed-endpoint",
      sessionId: "observed-session",
      metadata: {
        alive: true,
        observedRuntime: {
          harness: "codex",
          model: "gpt-5.6-sol",
          reasoningEffort: "xhigh",
        },
      },
    });
    await harness.runtime.upsertEndpoint(endpoint);

    await expect(harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      ensureAwake: true,
      execution: {
        harness: "codex",
        model: "gpt-5.6-sol",
        reasoningEffort: "xhigh",
        targetSessionId: "observed-session",
      },
    }))).resolves.toEqual(endpoint);
    expect(harness.isolatedInvocations).toEqual([]);
  });

  test("allows the first exact invocation into a matching Scout-provisioned pending session", async () => {
    const harness = createResolver();
    const endpoint = testEndpoint({
      id: "pending-endpoint",
      sessionId: "pending-session",
      metadata: {
        alive: true,
        source: "scout-cardless-session",
        sessionBacked: true,
        pendingExternalSession: true,
        pendingExternalSessionAt: 9_000,
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
      },
    });
    await harness.runtime.upsertEndpoint(endpoint);

    await expect(harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      ensureAwake: true,
      execution: {
        harness: "codex",
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        targetSessionId: "pending-session",
      },
    }))).resolves.toEqual(endpoint);
  });

  test("still rejects a pending session whose provisioned runtime does not match", async () => {
    const harness = createResolver();
    await harness.runtime.upsertEndpoint(testEndpoint({
      id: "pending-mismatch",
      sessionId: "pending-mismatch-session",
      metadata: {
        alive: true,
        source: "scout-cardless-session",
        sessionBacked: true,
        pendingExternalSession: true,
        pendingExternalSessionAt: 9_000,
        model: "gpt-5.6-terra",
      },
    }));

    await expect(harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      execution: {
        harness: "codex",
        model: "gpt-5.6-sol",
        targetSessionId: "pending-mismatch-session",
      },
    }))).rejects.toThrow("session_runtime_mismatch");
  });

  test("expires provisioned runtime trust when a pending session never attaches", async () => {
    const now = PENDING_PROVISIONED_RUNTIME_TRUST_MS + 20_000;
    const harness = createResolver({ now });
    await harness.runtime.upsertEndpoint(testEndpoint({
      id: "expired-pending",
      sessionId: "expired-pending-session",
      metadata: {
        alive: true,
        source: "scout-isolated-agent-session",
        sessionBacked: true,
        pendingExternalSession: true,
        pendingExternalSessionAt: 10_000,
        model: "gpt-5.6-sol",
      },
    }));

    await expect(harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      execution: {
        harness: "codex",
        model: "gpt-5.6-sol",
        targetSessionId: "expired-pending-session",
      },
    }))).rejects.toThrow("session_runtime_unobserved");
  });

  test("fails closed when an exact existing session is unobserved or mismatched", async () => {
    const harness = createResolver();
    await harness.runtime.upsertEndpoint(testEndpoint({
      id: "unobserved-endpoint",
      sessionId: "unobserved-session",
      metadata: { alive: true },
    }));
    await harness.runtime.upsertEndpoint(testEndpoint({
      id: "mismatched-endpoint",
      sessionId: "mismatched-session",
      metadata: {
        alive: true,
        observedRuntime: { harness: "codex", model: "gpt-5.6-terra" },
      },
    }));

    await expect(harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      execution: { harness: "codex", model: "gpt-5.6-sol", targetSessionId: "unobserved-session" },
    }))).rejects.toThrow("session_runtime_unobserved");
    await expect(harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      execution: { harness: "codex", model: "gpt-5.6-sol", targetSessionId: "mismatched-session" },
    }))).rejects.toThrow("session_runtime_mismatch");
  });
});
