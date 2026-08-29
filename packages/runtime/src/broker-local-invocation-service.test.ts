import { describe, expect, test } from "bun:test";

import {
  createScoutExecutionResolution,
  type ActorIdentity,
  type AgentDefinition,
  type AgentEndpoint,
  type ConversationDefinition,
  type FlightRecord,
  type InvocationRequest,
  type MessageRecord,
} from "@openscout/protocol";

import { promoteLocalEndpointProviderSession } from "./broker-local-endpoint-resolver.js";
import { applyInvocationStatusPatch } from "./broker-local-invocation-helpers.js";
import { BrokerLocalInvocationService } from "./broker-local-invocation-service.js";
import { DispatchStalledError } from "./dispatch-stalled.js";
import { RequesterWaitTimeoutError } from "./requester-timeout.js";

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
    wakePolicy: "on_demand",
    homeNodeId: "node-1",
    authorityNodeId: "node-1",
    advertiseScope: "local",
    ...input,
  };
}

function testActor(input: Partial<ActorIdentity> = {}): ActorIdentity {
  return {
    id: "agent-1",
    kind: "agent",
    displayName: "Agent One",
    handle: "agent-one",
    metadata: {},
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
    sessionId: "session-1",
    metadata: { agentName: "agent-one" },
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
    conversationId: "conversation-1",
    messageId: "message-1",
    ensureAwake: false,
    stream: false,
    createdAt: 1_000,
    metadata: {},
    ...input,
  };
}

function testFlight(input: Partial<FlightRecord> = {}): FlightRecord {
  return {
    id: "flight-1",
    invocationId: "invocation-1",
    requesterId: "operator",
    targetAgentId: "agent-1",
    state: "waking",
    startedAt: 1_000,
    metadata: {},
    ...input,
  };
}

function testConversation(input: Partial<ConversationDefinition> = {}): ConversationDefinition {
  return {
    id: "conversation-1",
    kind: "direct",
    title: "Agent One",
    visibility: "workspace",
    shareMode: "local",
    authorityNodeId: "node-1",
    participantIds: ["operator", "agent-1"],
    metadata: {},
    ...input,
  };
}

function testMessage(input: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id: "message-1",
    conversationId: "conversation-1",
    actorId: "operator",
    originNodeId: "node-1",
    class: "agent",
    body: "hello",
    visibility: "workspace",
    policy: "durable",
    createdAt: 1_000,
    ...input,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) {
      return;
    }
    await tick();
  }
  throw new Error("condition was not met");
}

function createHarness(input: {
  endpoint?: AgentEndpoint;
  resolveError?: Error;
  invokeResult?: { output: string; externalSessionId?: string; metadata?: Record<string, unknown> };
  invokeError?: Error;
  invokeEndpoint?: (endpoint: AgentEndpoint, invocation: InvocationRequest) => Promise<{ output: string; externalSessionId?: string; metadata?: Record<string, unknown> }>;
  ensureResult?: { externalSessionId?: string | null; metadata?: Record<string, unknown> };
  ensureEndpoint?: (endpoint: AgentEndpoint) => Promise<{ externalSessionId?: string | null; metadata?: Record<string, unknown> }>;
  previousEndpoint?: AgentEndpoint;
  actor?: ActorIdentity;
  agent?: AgentDefinition;
  conversation?: ConversationDefinition;
  message?: MessageRecord;
  now?: number;
} = {}) {
  const agents: Record<string, AgentDefinition> = {};
  const actors: Record<string, ActorIdentity> = {};
  const conversations: Record<string, ConversationDefinition> = {};
  const messages: Record<string, MessageRecord> = {};
  const flights: Record<string, FlightRecord> = {};
  const endpoints: Record<string, AgentEndpoint> = {};
  const persistedFlights: FlightRecord[] = [];
  const persistedEndpoints: AgentEndpoint[] = [];
  const postedMessages: MessageRecord[] = [];
  const statusMessages: Array<{ invocation: InvocationRequest; flight: { summary?: string; error?: string } }> = [];
  const warnings: string[] = [];
  const activeInvocationTasks = new Map<string, Promise<void>>();
  const endpoint = input.endpoint;
  if (input.agent !== null) {
    const agent = input.agent ?? testAgent();
    agents[agent.id] = agent;
    actors[agent.id] = testActor(agent);
  }
  if (input.actor) {
    actors[input.actor.id] = input.actor;
  }
  const conversation = input.conversation ?? testConversation();
  conversations[conversation.id] = conversation;
  if (input.message) {
    messages[input.message.id] = input.message;
  }
  if (endpoint) {
    endpoints[endpoint.id] = endpoint;
  }

  const service = new BrokerLocalInvocationService({
    nodeId: "node-1",
    runtime: {
      actor: (actorId) => actors[actorId],
      agent: (agentId) => agents[agentId],
      conversation: (conversationId) => conversations[conversationId],
      message: (messageId) => messages[messageId],
      flightForInvocation: (invocationId) =>
        Object.values(flights).find((flight) => flight.invocationId === invocationId),
      snapshot: () => ({
        nodes: {},
        actors,
        agents,
        endpoints,
        conversations,
        bindings: {},
        messages,
        readCursors: {},
        invocations: {},
        flights,
        collaborationRecords: {},
      }),
    },
    endpointResolver: {
      activeLocalEndpointForAgent: () => input.previousEndpoint ?? endpoint,
      async resolveLocalEndpointForInvocation() {
        if (input.resolveError) {
          throw input.resolveError;
        }
        return endpoint;
      },
      async prepareLocalEndpointForInvocation(nextEndpoint) {
        if (!endpoint || (!input.ensureEndpoint && !input.ensureResult)) {
          return nextEndpoint;
        }
        const sessionResult = input.ensureEndpoint
          ? await input.ensureEndpoint(nextEndpoint)
          : input.ensureResult ?? {};
        const preparedEndpoint = promoteLocalEndpointProviderSession(nextEndpoint, sessionResult);
        persistedEndpoints.push(preparedEndpoint);
        endpoints[preparedEndpoint.id] = preparedEndpoint;
        return preparedEndpoint;
      },
    },
    activeInvocationTasks,
    createId: () => "msg-generated",
    // Mirrors the daemon's transitionInvocation: read the invocation's current
    // flight, apply the patch with the real merge helper, persist the result.
    async transitionInvocation(invocationId, patch) {
      const current = Object.values(flights).find((flight) => flight.invocationId === invocationId);
      if (!current) {
        throw new Error(`cannot transition invocation ${invocationId}: no flight recorded`);
      }
      const next = applyInvocationStatusPatch(current, patch);
      persistedFlights.push(next);
      flights[next.id] = next;
      return next;
    },
    async persistEndpoint(nextEndpoint) {
      persistedEndpoints.push(nextEndpoint);
      endpoints[nextEndpoint.id] = nextEndpoint;
    },
    async postInvocationStatusMessage(invocation, flight) {
      statusMessages.push({ invocation, flight });
    },
    async postConversationMessage(message) {
      postedMessages.push(message);
      return { ok: true };
    },
    existingBrokerReplyForInvocation: () => null,
    completeInvocationForBrokerReply: async () => false,
    messageVisibilityForConversation: (conversationInput) => conversationInput?.visibility ?? "workspace",
    scoutbotReplyProvenanceMetadata: () => ({ provenance: "test" }),
    async invokePairingSessionEndpoint(nextEndpoint, nextInvocation) {
      if (input.invokeEndpoint) {
        return input.invokeEndpoint(nextEndpoint, nextInvocation);
      }
      if (input.invokeError) {
        throw input.invokeError;
      }
      return input.invokeResult ?? { output: "agent reply" };
    },
    async invokeLocalAgentEndpoint(nextEndpoint, nextInvocation) {
      if (input.invokeEndpoint) {
        return input.invokeEndpoint(nextEndpoint, nextInvocation);
      }
      if (input.invokeError) {
        throw input.invokeError;
      }
      return input.invokeResult ?? { output: "agent reply" };
    },
    warn: (message) => warnings.push(message),
    now: () => input.now ?? 10_000,
  });

  return {
    activeInvocationTasks,
    persistedFlights,
    persistedEndpoints,
    postedMessages,
    service,
    statusMessages,
    warnings,
    // Dispatch persists the initial flight before launch; tests seed it the
    // same way so transitionInvocation has a current record to patch.
    seedFlight(flight: FlightRecord) {
      flights[flight.id] = flight;
    },
  };
}

describe("BrokerLocalInvocationService", () => {
  test("queues when no runnable endpoint is available", async () => {
    const harness = createHarness({ endpoint: undefined, now: 11_000 });

    harness.seedFlight(testFlight());
    await harness.service.execute(testInvocation());

    expect(harness.persistedFlights).toEqual([
      expect.objectContaining({
        id: "flight-1",
        state: "queued",
        summary: "Message stored for Agent One. Will deliver when online.",
        metadata: expect.objectContaining({
          dispatchOutcome: {
            status: "queued_until_online",
            reason: "no_runnable_endpoint",
            checkedAt: 11_000,
          },
        }),
      }),
    ]);
    expect(harness.persistedEndpoints).toEqual([]);
    expect(harness.postedMessages).toEqual([]);
    expect(harness.statusMessages).toEqual([]);
  });

  test("does not prepare a provider session when the target actor is missing", async () => {
    let prepared = false;
    const endpoint = testEndpoint({
      agentId: "missing-session-actor",
      transport: "codex_app_server",
      sessionId: "missing-session-actor",
      metadata: {
        sessionBacked: true,
        pendingExternalSession: true,
      },
    });
    const harness = createHarness({
      agent: null,
      endpoint,
      async ensureEndpoint() {
        prepared = true;
        return { externalSessionId: "provider-session-should-not-start" };
      },
    });

    harness.seedFlight(testFlight({ targetAgentId: "missing-session-actor" }));
    await harness.service.execute(testInvocation({ targetAgentId: "missing-session-actor" }));

    expect(prepared).toBe(false);
    expect(harness.persistedEndpoints).toEqual([]);
    expect(harness.persistedFlights.at(-1)?.state).toBe("queued");
  });

  test("runs a pairing endpoint to completion and posts a broker reply", async () => {
    const endpoint = testEndpoint({
      id: "endpoint-pairing",
      transport: "pairing_bridge",
      metadata: { agentName: "Agent One", startedAt: "1" },
    });
    const harness = createHarness({
      endpoint,
      previousEndpoint: endpoint,
      invokeResult: {
        output: "done",
        externalSessionId: "provider-session-2",
        metadata: { traceId: "trace-1" },
      },
      now: 20_000,
    });

    harness.seedFlight(testFlight());
    await harness.service.execute(testInvocation());

    expect(harness.persistedFlights.map((flight) => flight.state)).toEqual(["running", "completed"]);
    expect(harness.persistedFlights[0]?.metadata?.dispatchAck).toEqual(expect.objectContaining({
      endpointId: "endpoint-pairing",
      transport: "pairing_bridge",
      strategy: "attach",
    }));
    expect(harness.persistedFlights[1]).toEqual(expect.objectContaining({
      state: "completed",
      summary: "Agent One replied.",
      output: "done",
    }));
    expect(harness.persistedEndpoints).toHaveLength(2);
    expect(harness.persistedEndpoints[0]).toEqual(expect.objectContaining({
      id: "endpoint-pairing",
      state: "active",
    }));
    expect(harness.persistedEndpoints[1]).toEqual(expect.objectContaining({
      id: "endpoint-pairing",
      state: "idle",
      sessionId: "session-1",
      metadata: expect.objectContaining({
        traceId: "trace-1",
        externalSessionId: "provider-session-2",
        lastCompletedAt: 20_000,
      }),
    }));
    expect(harness.postedMessages).toHaveLength(1);
    expect(harness.postedMessages[0]).toEqual(expect.objectContaining({
      id: "msg-generated",
      actorId: "agent-1",
      body: "done",
      replyToMessageId: "message-1",
      audience: { notify: ["operator"] },
      metadata: expect.objectContaining({
        invocationId: "invocation-1",
        flightId: "flight-1",
        provenance: "test",
        responderTransport: "pairing_bridge",
      }),
    }));
  });

  test("promotes harness-observed runtime into the durable dispatch trace", async () => {
    const endpoint = testEndpoint({
      harness: "codex",
      transport: "codex_app_server",
    });
    const harness = createHarness({
      endpoint,
      invokeResult: {
        output: "done",
        metadata: {
          observedRuntime: {
            harness: "codex",
            model: "gpt-5.6-sol",
            reasoningEffort: "high",
          },
          observedRuntimeAt: 19_500,
        },
      },
      now: 20_000,
    });
    const executionResolution = createScoutExecutionResolution({
      requested: { harness: "codex", model: "5.6", reasoningEffort: "xhigh" },
      resolved: { harness: "codex", model: "gpt-5.6-sol", reasoningEffort: "xhigh" },
      source: { harness: "flag", model: "flag", reasoningEffort: "flag" },
      resolvedAt: 10_000,
    });

    harness.seedFlight(testFlight());
    await harness.service.execute(testInvocation({ executionResolution }));

    const completed = harness.persistedFlights.at(-1);
    expect(completed?.metadata?.dispatchAck).toEqual(expect.objectContaining({
      executionResolution: expect.objectContaining({
        observedAt: 19_500,
        harness: expect.objectContaining({ observed: "codex", drift: "match" }),
        model: expect.objectContaining({ observed: "gpt-5.6-sol", drift: "match" }),
        reasoningEffort: expect.objectContaining({ observed: "high", drift: "mismatch" }),
      }),
    }));
  });

  test("keeps inline and none replies durable without enqueueing requester notifications", async () => {
    for (const replyMode of ["inline", "none"] as const) {
      const endpoint = testEndpoint();
      const harness = createHarness({
        endpoint,
        previousEndpoint: endpoint,
        invokeResult: { output: `${replyMode} reply` },
      });

      harness.seedFlight(testFlight());
      await harness.service.execute(testInvocation({ metadata: { replyMode } }));

      expect(harness.postedMessages).toHaveLength(1);
      expect(harness.postedMessages[0]?.body).toBe(`${replyMode} reply`);
      expect(harness.postedMessages[0]?.audience).toEqual({ delivery: "none" });
    }
  });

  test("enqueues requester notifications for explicit notify replies", async () => {
    const endpoint = testEndpoint();
    const harness = createHarness({ endpoint, previousEndpoint: endpoint });

    harness.seedFlight(testFlight());
    await harness.service.execute(testInvocation({ metadata: { replyMode: "notify" } }));

    expect(harness.postedMessages[0]?.audience).toEqual({ notify: ["operator"] });
  });

  test("runs a cardless session endpoint without an agent card", async () => {
    const sessionActor = testActor({
      id: "session-cardless-1",
      kind: "session",
      displayName: "openscout:session",
      handle: "session-cardless-1",
      metadata: { cardless: true },
    });
    const endpoint = testEndpoint({
      id: "endpoint-cardless",
      agentId: sessionActor.id,
      transport: "tmux",
      harness: "claude",
      sessionId: sessionActor.id,
      metadata: {
        cardless: true,
        sessionBacked: true,
        pendingExternalSession: true,
      },
    });
    const harness = createHarness({
      agent: null,
      actor: sessionActor,
      endpoint,
      invokeResult: {
        output: "session reply",
        externalSessionId: "provider-session-1",
      },
      now: 25_000,
    });

    harness.seedFlight(testFlight({ targetAgentId: sessionActor.id }));
    await harness.service.execute(testInvocation({ targetAgentId: sessionActor.id }));

    expect(harness.persistedFlights.map((flight) => flight.state)).toEqual(["running", "completed"]);
    expect(harness.persistedFlights[1]).toEqual(expect.objectContaining({
      state: "completed",
      summary: "openscout:session replied.",
      output: "session reply",
    }));
    expect(harness.persistedFlights[0]?.metadata?.dispatchAck).toEqual(expect.objectContaining({
      sessionId: sessionActor.id,
    }));
    expect(harness.persistedFlights[1]?.metadata?.dispatchAck).toEqual(expect.objectContaining({
      sessionId: "provider-session-1",
      refinesSessionId: sessionActor.id,
    }));
    expect(harness.persistedFlights[1]?.metadata?.sessionTrace).toEqual([
      expect.objectContaining({ sessionId: "provider-session-1", startedAt: 25_000 }),
    ]);
    expect(harness.persistedEndpoints.at(-1)).toEqual(expect.objectContaining({
      id: "endpoint-cardless",
      state: "idle",
      metadata: expect.objectContaining({
        externalSessionId: "provider-session-1",
        pendingExternalSession: false,
      }),
    }));
    expect(harness.postedMessages).toHaveLength(1);
    expect(harness.postedMessages[0]).toEqual(expect.objectContaining({
      actorId: sessionActor.id,
      body: "session reply",
      metadata: expect.objectContaining({
        responderSessionId: sessionActor.id,
        responderAgentName: sessionActor.handle,
      }),
    }));
  });

  test("records a provider replacement on one endpoint as a second session span", async () => {
    const sessionActor = testActor({
      id: "session-cardless-replaced",
      kind: "session",
      displayName: "openscout:replaced-session",
      handle: "session-cardless-replaced",
      metadata: { cardless: true },
    });
    const endpoint = testEndpoint({
      id: "endpoint-cardless-replaced",
      agentId: sessionActor.id,
      transport: "tmux",
      harness: "claude",
      sessionId: sessionActor.id,
      metadata: {
        cardless: true,
        sessionBacked: true,
        pendingExternalSession: false,
        externalSessionId: "provider-session-a",
      },
    });
    const harness = createHarness({
      agent: null,
      actor: sessionActor,
      endpoint,
      invokeResult: {
        output: "replacement reply",
        externalSessionId: "provider-session-b",
      },
      now: 26_000,
    });

    harness.seedFlight(testFlight({ targetAgentId: sessionActor.id }));
    await harness.service.execute(testInvocation({ targetAgentId: sessionActor.id }));

    expect(harness.persistedFlights.at(-1)?.metadata?.dispatchAck).toEqual(expect.objectContaining({
      sessionId: "provider-session-b",
    }));
    expect(harness.persistedFlights.at(-1)?.metadata?.dispatchAck).not.toHaveProperty("refinesSessionId");
    expect(harness.persistedFlights.at(-1)?.metadata?.sessionTrace).toEqual([
      expect.objectContaining({
        sessionId: "provider-session-a",
        endedAt: 26_000,
      }),
      expect.objectContaining({
        sessionId: "provider-session-b",
        startedAt: 26_000,
      }),
    ]);
  });

  test("uses pointer-forward alias copy for cardless session dispatch acks", async () => {
    const sessionActor = testActor({
      id: "session-chopin-1",
      kind: "session",
      displayName: "Project Chopin",
      handle: "project-chopin",
      metadata: { cardless: true, handle: "project-chopin" },
    });
    const endpoint = testEndpoint({
      id: "endpoint-chopin",
      agentId: sessionActor.id,
      transport: "codex_app_server",
      harness: "codex",
      sessionId: sessionActor.id,
      projectRoot: "/Users/art/dev/scope",
      cwd: "/Users/art/dev/scope",
      metadata: {
        cardless: true,
        handle: "project-chopin",
        sessionBacked: true,
        pendingExternalSession: true,
      },
    });
    const harness = createHarness({
      agent: null,
      actor: sessionActor,
      endpoint,
      invokeResult: { output: "done" },
      now: 25_000,
    });

    harness.seedFlight(testFlight({ targetAgentId: sessionActor.id }));
    await harness.service.execute(testInvocation({ targetAgentId: sessionActor.id }));

    expect(harness.persistedFlights[0]?.summary).toBe(
      "alias project-chopin → session-chopin-1 (scope, codex) acknowledged via attach.",
    );
  });

  test("keeps a provider session provisional until a deferred cardless turn completes", async () => {
    const turnGate = deferred();
    const sessionActor = testActor({
      id: "session-spinoza-2",
      kind: "session",
      displayName: "Project Spinoza 2",
      handle: "project-spinoza-2",
      metadata: { cardless: true, handle: "project-spinoza-2" },
    });
    const endpoint = testEndpoint({
      id: "endpoint-spinoza-2",
      agentId: sessionActor.id,
      transport: "codex_app_server",
      harness: "codex",
      sessionId: sessionActor.id,
      projectRoot: "/Users/art/dev/openscout-derived-state-retention",
      cwd: "/Users/art/dev/openscout-derived-state-retention",
      metadata: {
        cardless: true,
        handle: "project-spinoza-2",
        sessionBacked: true,
        pendingExternalSession: true,
      },
    });
    let invokedEndpoint: AgentEndpoint | null = null;
    const harness = createHarness({
      agent: null,
      actor: sessionActor,
      endpoint,
      ensureResult: {
        externalSessionId: null,
      },
      async invokeEndpoint(nextEndpoint) {
        invokedEndpoint = nextEndpoint;
        await turnGate.promise;
        return {
          output: "investigation complete",
          externalSessionId: "019ff3f8-322d-7572-990f-447725ffd348",
        };
      },
      now: 30_000,
    });

    harness.seedFlight(testFlight({ targetAgentId: sessionActor.id }));
    const execution = harness.service.execute(testInvocation({ targetAgentId: sessionActor.id }));

    await waitFor(() => invokedEndpoint !== null);

    expect(harness.persistedEndpoints[0]).toEqual(expect.objectContaining({
      id: endpoint.id,
      state: "idle",
      // The Scout-owned id remains stable for routing.
      sessionId: sessionActor.id,
      metadata: expect.objectContaining({
        pendingExternalSession: true,
      }),
    }));
    expect(harness.persistedEndpoints[0]?.metadata?.externalSessionId).toBeUndefined();
    expect(harness.persistedEndpoints[0]?.metadata?.threadId).toBeUndefined();
    expect(invokedEndpoint).toEqual(expect.objectContaining({
      sessionId: sessionActor.id,
      metadata: expect.objectContaining({
        pendingExternalSession: true,
      }),
    }));
    expect(harness.persistedFlights).toHaveLength(1);
    expect(harness.persistedFlights[0]).toEqual(expect.objectContaining({
      state: "running",
      summary: "alias project-spinoza-2 → session-spinoza-2 (openscout-derived-state-retention, codex) acknowledged via attach.",
      metadata: expect.objectContaining({
        dispatchAck: expect.objectContaining({
          sessionId: sessionActor.id,
        }),
        sessionTrace: [expect.objectContaining({
          sessionId: sessionActor.id,
        })],
      }),
    }));

    turnGate.resolve();
    await execution;

    expect(harness.persistedFlights.at(-1)).toEqual(expect.objectContaining({
      state: "completed",
      output: "investigation complete",
      metadata: expect.objectContaining({
        dispatchAck: expect.objectContaining({
          sessionId: "019ff3f8-322d-7572-990f-447725ffd348",
          refinesSessionId: sessionActor.id,
        }),
      }),
    }));
    expect(harness.persistedEndpoints.at(-1)).toEqual(expect.objectContaining({
      id: endpoint.id,
      state: "idle",
      sessionId: sessionActor.id,
      metadata: expect.objectContaining({
        externalSessionId: "019ff3f8-322d-7572-990f-447725ffd348",
        threadId: "019ff3f8-322d-7572-990f-447725ffd348",
        pendingExternalSession: false,
      }),
    }));
  });

  test("adds originating message attachments to local invocation context", async () => {
    let capturedInvocation: InvocationRequest | null = null;
    const endpoint = testEndpoint({
      id: "endpoint-tmux",
      transport: "tmux",
      harness: "claude",
    });
    const harness = createHarness({
      endpoint,
      message: testMessage({
        attachments: [
          {
            id: "att-1",
            mediaType: "image/png",
            fileName: "screenshot.png",
            url: "http://127.0.0.1:3200/api/blobs/blob-1",
          },
        ],
      }),
      async invokeEndpoint(_endpoint, invocation) {
        capturedInvocation = invocation;
        return { output: "" };
      },
    });

    harness.seedFlight(testFlight());
    await harness.service.execute(testInvocation({ action: "wake" }));

    expect(capturedInvocation?.context).toEqual({
      scoutMessageAttachments: [
        {
          id: "att-1",
          mediaType: "image/png",
          fileName: "screenshot.png",
          url: "http://127.0.0.1:3200/api/blobs/blob-1",
        },
      ],
    });
    expect(harness.persistedFlights.map((flight) => flight.state)).toEqual(["running", "completed"]);
  });

  test("keeps requester wait timeout flights running", async () => {
    const endpoint = testEndpoint({
      id: "endpoint-tmux",
      transport: "tmux",
    });
    const harness = createHarness({
      endpoint,
      invokeError: new RequesterWaitTimeoutError({ label: "agent", timeoutMs: 5_000 }),
      now: 30_000,
    });

    harness.seedFlight(testFlight());
    await harness.service.execute(testInvocation());

    expect(harness.persistedFlights.map((flight) => flight.state)).toEqual(["running", "running"]);
    expect(harness.persistedFlights[1]).toEqual(expect.objectContaining({
      state: "running",
      summary: "Agent One is still working.",
      error: undefined,
      completedAt: undefined,
      metadata: expect.objectContaining({
        requesterTimedOut: true,
        timeoutMs: 5_000,
        timeoutScope: "requester_wait",
      }),
    }));
    expect(harness.statusMessages).toEqual([]);
    expect(harness.warnings).toEqual([
      "[openscout-runtime] Agent One is still working; requester wait timed out after 5000ms.",
    ]);
  });

  test("keeps grok-acp requester wait timeouts running instead of failing", async () => {
    const endpoint = testEndpoint({
      id: "endpoint-grok-acp",
      transport: "grok_acp",
      harness: "grok-acp",
      metadata: { agentName: "Grok ACP" },
    });
    const harness = createHarness({
      endpoint,
      invokeError: new RequesterWaitTimeoutError({ label: "Grok ACP", timeoutMs: 100 }),
      now: 31_000,
    });

    harness.seedFlight(testFlight());
    await harness.service.execute(testInvocation({ timeoutMs: 100 }));

    expect(harness.persistedFlights.map((flight) => flight.state)).toEqual(["running", "running"]);
    expect(harness.persistedFlights[1]).toEqual(expect.objectContaining({
      state: "running",
      summary: "Agent One is still working.",
      error: undefined,
      completedAt: undefined,
      metadata: expect.objectContaining({
        requesterTimedOut: true,
        timeoutMs: 100,
        timeoutScope: "requester_wait",
      }),
    }));
    expect(harness.statusMessages).toEqual([]);
  });

  test("dispatch verification stalls do not mark a live endpoint offline", async () => {
    const endpoint = testEndpoint({
      id: "endpoint-tmux",
      transport: "tmux",
      state: "working",
    });
    const harness = createHarness({
      endpoint,
      invokeError: new DispatchStalledError({
        sessionName: "session-live",
        paneTail: "❯ queued prompt remains visible",
        retries: 1,
      }),
      now: 32_000,
    });

    harness.seedFlight(testFlight());
    await harness.service.execute(testInvocation());

    expect(harness.persistedFlights.map((flight) => flight.state)).toEqual(["running", "failed"]);
    expect(harness.persistedEndpoints).toHaveLength(2);
    expect(harness.persistedEndpoints[0]).toEqual(expect.objectContaining({
      state: "active",
    }));
    expect(harness.persistedEndpoints[1]).toEqual(expect.objectContaining({
      state: "working",
      metadata: expect.objectContaining({
        lastFailureStage: "dispatch_stalled",
        lastError: "tmux dispatch for session session-live left the prompt in the composer after submit + 1 retry.",
      }),
    }));
    expect(harness.statusMessages).toHaveLength(1);
  });

  test("a late transport error does not overwrite a broker-reply completion", async () => {
    // Reproduced by adversarial review on #296: broker reply completes the
    // invocation mid-invoke, then the transport errors. The failure path must
    // not overwrite the terminal completed record (which would strand a
    // `failed` state carrying the successful output).
    const harness = createHarness({
      endpoint: testEndpoint({ id: "endpoint-tmux", transport: "tmux" }),
      async invokeEndpoint() {
        harness.seedFlight(testFlight({
          state: "completed",
          summary: "Agent One replied.",
          output: "broker reply body",
          completedAt: 40_000,
          metadata: { completedByBrokerReply: true },
        }));
        throw new Error("transport exploded after reply");
      },
      now: 41_000,
    });

    harness.seedFlight(testFlight());
    await harness.service.execute(testInvocation());

    expect(harness.persistedFlights.map((flight) => flight.state)).toEqual(["running"]);
    expect(harness.statusMessages).toEqual([]);
    // Endpoint bookkeeping still records the transport failure.
    expect(harness.persistedEndpoints.at(-1)).toEqual(expect.objectContaining({
      state: "offline",
      metadata: expect.objectContaining({ lastError: "transport exploded after reply" }),
    }));
  });

  test("a late transport error does not overwrite a cancellation", async () => {
    const harness = createHarness({
      endpoint: testEndpoint({ id: "endpoint-tmux", transport: "tmux" }),
      async invokeEndpoint() {
        harness.seedFlight(testFlight({
          state: "cancelled",
          summary: "Cancelled by requester.",
          completedAt: 40_000,
          metadata: { a2aCancelledAt: 40_000 },
        }));
        throw new Error("transport exploded after cancel");
      },
      now: 41_000,
    });

    harness.seedFlight(testFlight());
    await harness.service.execute(testInvocation());

    const terminalStates = harness.persistedFlights.map((flight) => flight.state);
    expect(terminalStates).not.toContain("failed");
    expect(harness.statusMessages).toEqual([]);
  });

  test("re-entering running clears a prior attempt's transient failure metadata", async () => {
    // Reproduced by adversarial review on #296: failure metadata written
    // before the running transition leaked into the eventual success record
    // through the key-wise metadata merge.
    const harness = createHarness({
      endpoint: testEndpoint(),
      invokeResult: { output: "second attempt reply" },
      now: 50_000,
    });

    harness.seedFlight(testFlight({
      state: "failed",
      error: "dispatch stalled",
      completedAt: 45_000,
      metadata: {
        failureStage: "dispatch_stalled",
        dispatchStalledSession: "scout-tmux-1",
        dispatchStalledRetries: 2,
        dispatchStalledPaneTail: "…",
        keepMe: "not-transient",
      },
    }));
    await harness.service.execute(testInvocation());

    const completed = harness.persistedFlights.at(-1);
    expect(completed).toEqual(expect.objectContaining({ state: "completed", output: "second attempt reply" }));
    expect(completed?.metadata?.failureStage).toBeUndefined();
    expect(completed?.metadata?.dispatchStalledSession).toBeUndefined();
    expect(completed?.metadata?.dispatchStalledRetries).toBeUndefined();
    expect(completed?.metadata?.dispatchStalledPaneTail).toBeUndefined();
    expect(completed?.metadata?.keepMe).toBe("not-transient");
    expect(completed?.metadata?.dispatchAck).toBeDefined();
  });

  test("launch deduplicates active invocation tasks", async () => {
    const endpoint = testEndpoint();
    const harness = createHarness({ endpoint });
    const invocation = testInvocation();
    const flight = testFlight();

    harness.seedFlight(flight);
    harness.service.launch(invocation);
    harness.service.launch(invocation);
    expect(harness.service.hasActiveInvocation(invocation.id)).toBe(true);
    expect(harness.activeInvocationTasks).toHaveLength(1);
    await harness.activeInvocationTasks.get(invocation.id);
    expect(harness.service.hasActiveInvocation(invocation.id)).toBe(false);
  });

  test("serializes different invocations for the same local route", async () => {
    const endpoint = testEndpoint();
    const firstGate = deferred();
    const started: string[] = [];
    const harness = createHarness({
      endpoint,
      async invokeEndpoint(_endpoint, nextInvocation) {
        started.push(nextInvocation.id);
        if (nextInvocation.id === "invocation-1") {
          await firstGate.promise;
        }
        return { output: `reply ${nextInvocation.id}` };
      },
    });

    const firstInvocation = testInvocation({ id: "invocation-1" });
    const secondInvocation = testInvocation({ id: "invocation-2" });
    harness.seedFlight(testFlight({ id: "flight-1", invocationId: firstInvocation.id }));
    harness.seedFlight(testFlight({ id: "flight-2", invocationId: secondInvocation.id }));
    harness.service.launch(firstInvocation);
    harness.service.launch(secondInvocation);

    await waitFor(() => started.length === 1);
    expect(started).toEqual(["invocation-1"]);

    firstGate.resolve();
    await harness.activeInvocationTasks.get(secondInvocation.id);

    expect(started).toEqual(["invocation-1", "invocation-2"]);
    expect(harness.persistedFlights.filter((flight) => flight.state === "running").map((flight) => flight.invocationId))
      .toEqual(["invocation-1", "invocation-2"]);
  });
});
