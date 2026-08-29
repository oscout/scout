import { describe, expect, test } from "bun:test";

import type {
  AgentDefinition,
  ScoutDeliverRequest,
  ScoutDispatchRecord,
} from "@openscout/protocol";

import { createInMemoryControlRuntime } from "./broker.js";
import {
  BrokerDeliveryRouter,
  buildDeliveryReceipt,
  callerContextForDelivery,
  executionWithRouteParams,
  normalizeScoutLabels,
  projectPathRouteTarget,
  remediationForDispatch,
  shouldMaterializeProjectAgent,
} from "./broker-delivery-routing.js";

function testPayload(input: Partial<ScoutDeliverRequest> = {}): ScoutDeliverRequest {
  return {
    body: "hello",
    intent: "consult",
    ...input,
  };
}

function testAgent(input: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: "agent-1",
    kind: "agent",
    definitionId: "agent",
    displayName: "Agent One",
    handle: "agent",
    labels: ["agent"],
    selector: "@agent",
    defaultSelector: "@agent",
    metadata: {},
    agentClass: "general",
    capabilities: ["chat", "invoke", "deliver"],
    wakePolicy: "on_demand",
    homeNodeId: "node-1",
    authorityNodeId: "node-1",
    advertiseScope: "local",
    ...input,
  };
}

describe("broker delivery routing", () => {
  test("resolves caller context and label-derived execution preferences", () => {
    expect(callerContextForDelivery(testPayload({
      caller: { actorId: " caller ", nodeId: " node-caller " },
      requesterId: "requester",
      requesterNodeId: "node-requester",
    }), {
      operatorActorId: "operator",
      nodeId: "node-1",
    })).toEqual({
      requesterId: "caller",
      requesterNodeId: "node-caller",
    });

    expect(callerContextForDelivery(testPayload(), {
      operatorActorId: "operator",
      nodeId: "node-1",
    })).toEqual({
      requesterId: "operator",
      requesterNodeId: "node-1",
    });

    expect(executionWithRouteParams(testPayload({
      targetLabel: "@ranger#codex?gpt-5",
    }))).toEqual({
      harness: "codex",
      model: "gpt-5",
    });

    expect(executionWithRouteParams(testPayload({
      targetLabel: "@ranger#codex?gpt-5",
      execution: { harness: "claude" },
    }))).toEqual({
      harness: "claude",
      model: "gpt-5",
    });

    expect(executionWithRouteParams(testPayload({
      target: {
        kind: "session_id",
        sessionId: "native-thread-123",
        harness: "codex",
        value: "session:codex:native-thread-123",
      },
    }))).toEqual({
      harness: "codex",
    });

    expect(executionWithRouteParams(testPayload({
      targetLabel: "session:codex:native-thread-123",
    }))).toBeUndefined();

    const profilePayload = testPayload({
      target: {
        kind: "runtime_profile",
        profile: "Opus",
        projectPath: "/tmp/openscout",
        reasoningEffort: "HIGH",
      },
    });
    expect(executionWithRouteParams(profilePayload)).toEqual({
      harness: "claude",
      model: "opus",
      reasoningEffort: "high",
      session: "new",
    });
    expect(executionWithRouteParams({
      ...profilePayload,
      execution: { model: "claude-opus-5", reasoningEffort: "max" },
    })).toEqual({
      harness: "claude",
      model: "claude-opus-5",
      reasoningEffort: "max",
      session: "new",
    });
    expect(() => executionWithRouteParams({
      ...profilePayload,
      execution: { harness: "codex" },
    })).toThrow("requires harness \"claude\"");
    expect(projectPathRouteTarget(profilePayload)).toBe("/tmp/openscout");
  });

  test("captures implicit project-card materialization policy", () => {
    const resolved = { kind: "resolved" as const, agent: testAgent() };
    const unknown = { kind: "unknown" as const, label: "@agent" };
    const ambiguous = {
      kind: "ambiguous" as const,
      label: "@agent",
      candidates: [testAgent({ id: "agent-a" }), testAgent({ id: "agent-b" })],
    };

    expect(shouldMaterializeProjectAgent({
      resolved,
    })).toBe(false);
    expect(shouldMaterializeProjectAgent({
      projectPath: "/repo",
      resolved,
      projectAgent: { persistence: "one_time" },
    })).toBe(false);
    expect(shouldMaterializeProjectAgent({
      projectPath: "/repo",
      resolved,
      projectAgent: { persistence: "sticky", displayName: "Repo Agent" },
    })).toBe(false);
    expect(shouldMaterializeProjectAgent({
      projectPath: "/repo",
      resolved: unknown,
    })).toBe(false);
    expect(shouldMaterializeProjectAgent({
      projectPath: "/repo",
      resolved: ambiguous,
      execution: { session: "new" },
    })).toBe(false);
    expect(shouldMaterializeProjectAgent({
      projectPath: "/repo",
      resolved: ambiguous,
      execution: { session: "existing" },
    })).toBe(false);
  });

  test("does not materialize a project card before resolving a missing project path", async () => {
    const runtime = createInMemoryControlRuntime({}, { localNodeId: "node-1" });
    const router = new BrokerDeliveryRouter({
      runtimeSnapshot: () => runtime.snapshot(),
      nodeId: "node-1",
      isInactiveLocalAgent: () => false,
    });

    const result = await router.resolveWithImplicitProjectAgent({
      target: { kind: "project_path", projectPath: "/tmp/My App" },
      execution: { harness: "codex", model: "gpt-5" },
    }, {
      requesterId: "operator",
      reason: "test materialization",
    });

    expect(result).toEqual({ kind: "unknown", label: "/tmp/My App" });
  });

  test("normalizes delivery labels, remediation, and receipts", () => {
    expect(normalizeScoutLabels([" ops ", "", "ops", "runtime"])).toEqual(["ops", "runtime"]);

    const dispatch: ScoutDispatchRecord = {
      id: "dispatch-1",
      kind: "unavailable",
      askedLabel: "@ranger",
      detail: "cannot use stale registration",
      candidates: [],
      dispatchedAt: 100,
      dispatcherNodeId: "node-1",
      target: {
        agentId: "agent-1",
        displayName: "Ranger",
        reason: "superseded_registration",
        detail: "newer registration exists",
        endpointState: "offline",
      },
    };
    expect(remediationForDispatch(dispatch)).toEqual(expect.objectContaining({
      kind: "use_current_registration",
      targetAgentId: "agent-1",
      targetLabel: "@ranger",
    }));

    expect(buildDeliveryReceipt({
      requestId: "deliver-1",
      routeKind: "dm",
      requesterId: "operator",
      requesterNodeId: "node-1",
      targetAgentId: "agent-1",
      targetLabel: "@agent",
      conversationId: "conversation-1",
      messageId: "message-1",
      flightId: "flight-1",
    })).toEqual(expect.objectContaining({
      requestId: "deliver-1",
      routeKind: "dm",
      requesterId: "operator",
      targetAgentId: "agent-1",
      targetLabel: "@agent",
      conversationId: "conversation-1",
      messageId: "message-1",
      flightId: "flight-1",
      acceptedAt: expect.any(Number),
    }));
  });

  test("exact session target never falls through to a project/card worker (Blink incident guard)", async () => {
    const runtime = createInMemoryControlRuntime({}, { localNodeId: "node-1" });
    // A tempting wrong agent exists — must not receive exact-session traffic.
    await runtime.upsertAgent(testAgent({
      id: "blink.codex-mobile-trust-release-hardening",
      handle: "blink.codex-mobile-trust-release-hardening",
      selector: "@blink.codex-mobile-trust-release-hardening",
      displayName: "Mobile Trust",
    }));

    let wakeCalls = 0;
    const router = new BrokerDeliveryRouter({
      runtimeSnapshot: () => runtime.snapshot(),
      nodeId: "node-1",
      isInactiveLocalAgent: () => false,
      wakeExactHarnessSession: async () => {
        wakeCalls += 1;
        return {
          ok: false,
          reason: "session_unknown",
          detail: "no harness session store entry",
        };
      },
    });

    const result = await router.resolveWithImplicitProjectAgent({
      target: {
        kind: "session_id",
        sessionId: "019fbee7-2a7f-7eb0-84bf-da22717c74d0",
        harness: "codex",
      },
      execution: { harness: "codex" },
    }, {
      requesterId: "operator",
      currentDirectory: "/Users/art/dev/blink",
      reason: "blink incident guard",
    });

    expect(wakeCalls).toBe(1);
    expect(result.kind).toBe("unknown");
    if (result.kind === "unknown") {
      expect(result.label).toContain("019fbee7");
      expect(result.detail).toContain("no harness session store entry");
    }
    // Must not resolve to the tempting agent card.
    expect(result.kind === "resolved" ? result.agent.id : null).toBeNull();
  });

  test("exact session wake then re-resolves to cardless session endpoint", async () => {
    const runtime = createInMemoryControlRuntime({}, { localNodeId: "node-1" });
    const sessionId = "019fbee7-2a7f-7eb0-84bf-da22717c74d0";
    const scoutSessionId = `flat-codex-${sessionId}`;

    const router = new BrokerDeliveryRouter({
      runtimeSnapshot: () => runtime.snapshot(),
      nodeId: "node-1",
      isInactiveLocalAgent: () => false,
      wakeExactHarnessSession: async () => {
        await runtime.upsertActor({
          id: scoutSessionId,
          kind: "session",
          displayName: "blink:019fbee7",
          handle: scoutSessionId,
          labels: ["cardless-session", "session"],
          metadata: { cardless: true, flatDispatch: true },
        });
        await runtime.upsertEndpoint({
          id: `endpoint.${scoutSessionId}.node-1.codex_app_server`,
          agentId: scoutSessionId,
          nodeId: "node-1",
          harness: "codex",
          transport: "codex_app_server",
          state: "idle",
          cwd: "/Users/art/dev/blink",
          projectRoot: "/Users/art/dev/blink",
          sessionId: scoutSessionId,
          metadata: {
            cardless: true,
            flatDispatch: true,
            externalSessionId: sessionId,
            threadId: sessionId,
            nativeSessionId: sessionId,
          },
        });
        return { ok: true };
      },
    });

    const result = await router.resolveWithImplicitProjectAgent({
      target: {
        kind: "session_id",
        sessionId,
        harness: "codex",
      },
    }, {
      requesterId: "operator",
      currentDirectory: "/Users/art/dev/blink",
      reason: "wake resume",
    });

    expect(result.kind).toBe("resolved_session");
    if (result.kind === "resolved_session") {
      expect(result.session.endpoint.metadata?.externalSessionId).toBe(sessionId);
      expect(result.session.endpoint.metadata?.flatDispatch).toBe(true);
    }
  });
});
