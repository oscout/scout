import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { namedChannelNaturalKey } from "@openscout/protocol";

import {
  createBrokerDaemonTestHarness,
  type TestConversationIdentity,
} from "./test-helpers/broker-daemon-harness.test";

const broker = createBrokerDaemonTestHarness();

describe("broker daemon delivery routing", () => {
  test("accepts broker-owned delivery for a known wakeable target", async () => {
    const harness = await broker.startBroker();

    await broker.postJson(harness.baseUrl, "/v1/agents", {
      id: "ghost",
      kind: "agent",
      definitionId: "ghost",
      displayName: "Ghost",
      handle: "ghost",
      labels: ["test"],
      selector: "@ghost",
      defaultSelector: "@ghost",
      metadata: { source: "test" },
      agentClass: "general",
      capabilities: ["chat", "invoke"],
      wakePolicy: "on_demand",
      homeNodeId: harness.nodeId,
      authorityNodeId: harness.nodeId,
      advertiseScope: "local",
    });

    const response = await broker.postJson<{
      kind: string;
      accepted: boolean;
      routeKind: string;
      receipt?: {
        requestId: string;
        requesterId: string;
        requesterNodeId: string;
        targetAgentId?: string;
        targetLabel?: string;
        bindingRef?: string;
        messageId: string;
        flightId?: string;
      };
      targetAgentId?: string;
      bindingRef?: string;
      conversation?: TestConversationIdentity & { kind: string };
      message?: { id: string; conversationId: string; actorId: string; body: string };
      flight?: { id: string; state: string; targetAgentId: string };
    }>(harness.baseUrl, "/v1/deliver", {
      id: "deliver-test-1",
      caller: {
        actorId: "operator",
        nodeId: harness.nodeId,
      },
      target: {
        kind: "agent_label",
        label: "@ghost",
      },
      body: "@ghost are you there?",
      intent: "consult",
      createdAt: Date.now(),
    });

    expect(response.kind).toBe("delivery");
    expect(response.accepted).toBe(true);
    expect(response.routeKind).toBe("dm");
    expect(response.targetAgentId).toBe("ghost");
    expect(response.receipt?.requestId).toBe("deliver-test-1");
    expect(response.receipt?.requesterId).toBe("operator");
    expect(response.receipt?.requesterNodeId).toBe(harness.nodeId);
    expect(response.receipt?.targetAgentId).toBe("ghost");
    expect(response.receipt?.targetLabel).toBe("@ghost");
    expect(response.conversation?.kind).toBe("direct");
    expect(response.message?.conversationId).toBe(response.conversation?.id);
    expect(response.receipt?.messageId).toBe(response.message?.id);
    expect(response.flight?.state).toBe("waking");
    expect(response.flight?.targetAgentId).toBe("ghost");
    expect(response.receipt?.flightId).toBe(response.flight?.id);
    expect(response.bindingRef).toBe(response.flight?.id.slice(-8));
    expect(response.receipt?.bindingRef).toBe(response.bindingRef);

    const followup = await broker.postJson<{
      kind: string;
      accepted: boolean;
      targetAgentId?: string;
      bindingRef?: string;
      receipt?: { targetLabel?: string; bindingRef?: string };
      flight?: { targetAgentId: string };
    }>(harness.baseUrl, "/v1/deliver", {
      id: "deliver-test-ref",
      caller: {
        actorId: "operator",
        nodeId: harness.nodeId,
      },
      target: {
        kind: "binding_ref",
        ref: response.bindingRef,
      },
      body: "continue from the bound session",
      intent: "consult",
      createdAt: Date.now(),
    });

    expect(followup.kind).toBe("delivery");
    expect(followup.accepted).toBe(true);
    expect(followup.targetAgentId).toBe("ghost");
    expect(followup.receipt?.targetLabel).toBe("@ghost");
    expect(followup.receipt?.bindingRef).toBe(followup.bindingRef);
  }, 15_000);

  test("replays broker-owned delivery messages invocations and flights after restart", async () => {
    const controlHome = mkdtempSync(join(tmpdir(), "openscout-runtime-test-"));
    const firstHarness = await broker.startBroker({ controlHome });

    await broker.postJson(firstHarness.baseUrl, "/v1/agents", {
      id: "durable-ghost",
      kind: "agent",
      definitionId: "durable-ghost",
      displayName: "Durable Ghost",
      handle: "durable-ghost",
      labels: ["test"],
      selector: "@durable-ghost",
      defaultSelector: "@durable-ghost",
      metadata: { source: "test" },
      agentClass: "general",
      capabilities: ["chat", "invoke"],
      wakePolicy: "on_demand",
      homeNodeId: firstHarness.nodeId,
      authorityNodeId: firstHarness.nodeId,
      advertiseScope: "local",
    });

    const response = await broker.postJson<{
      kind: string;
      accepted: boolean;
      message?: { id: string; conversationId: string; body: string };
      flight?: { id: string; invocationId: string; state: string; targetAgentId: string };
      receipt?: { messageId: string; flightId?: string };
    }>(firstHarness.baseUrl, "/v1/deliver", {
      id: "deliver-restart-consult",
      caller: {
        actorId: "operator",
        nodeId: firstHarness.nodeId,
      },
      target: {
        kind: "agent_label",
        label: "@durable-ghost",
      },
      body: "Survive a broker restart.",
      intent: "consult",
      createdAt: Date.now(),
    });

    expect(response.kind).toBe("delivery");
    expect(response.accepted).toBe(true);
    expect(response.message?.id).toBe(response.receipt?.messageId);
    expect(response.flight?.id).toBe(response.receipt?.flightId);
    expect(response.flight?.state).toBe("waking");

    firstHarness.child.kill();
    await firstHarness.child.exited.catch(() => {});
    broker.harnesses.delete(firstHarness);

    const secondHarness = await broker.startBroker({ controlHome });

    const messages = await broker.getJson<Array<{ id: string; body: string; conversationId: string }>>(
      secondHarness.baseUrl,
      `/v1/messages?conversationId=${encodeURIComponent(response.message?.conversationId ?? "")}`,
    );
    expect(messages).toContainEqual(expect.objectContaining({
      id: response.message?.id,
      body: "Survive a broker restart.",
    }));

    const invocationSnapshot = await broker.getJson<{
      invocation: { id: string; targetAgentId: string } | null;
      flight: { id: string; invocationId: string; targetAgentId: string; state: string } | null;
    }>(secondHarness.baseUrl, `/v1/invocations/${response.flight?.invocationId}`);

    expect(invocationSnapshot.invocation).toEqual(expect.objectContaining({
      id: response.flight?.invocationId,
      targetAgentId: "durable-ghost",
    }));
    expect(invocationSnapshot.flight).toEqual(expect.objectContaining({
      id: response.flight?.id,
      invocationId: response.flight?.invocationId,
      targetAgentId: "durable-ghost",
    }));

    const lifecycle = await broker.getJson<{
      invocationId: string;
      flightId: string;
      targetAgentId: string;
    }>(secondHarness.baseUrl, `/v1/invocations/${response.flight?.invocationId}/lifecycle`);
    expect(lifecycle).toEqual(expect.objectContaining({
      invocationId: response.flight?.invocationId,
      flightId: response.flight?.id,
      targetAgentId: "durable-ghost",
    }));

    const deliveries = await broker.getJson<Array<{ messageId: string; targetId: string; status: string }>>(
      secondHarness.baseUrl,
      `/v1/deliveries?messageId=${encodeURIComponent(response.message?.id ?? "")}&targetId=durable-ghost`,
    );
    expect(deliveries).toContainEqual(expect.objectContaining({
      messageId: response.message?.id,
      targetId: "durable-ghost",
      status: "pending",
    }));
  }, 20_000);

  test("routes operator and message refs as replies instead of failed deliveries", async () => {
    const harness = await broker.startBroker();

    await broker.postJson(harness.baseUrl, "/v1/agents", {
      id: "designer",
      kind: "agent",
      definitionId: "designer",
      displayName: "Designer",
      handle: "designer",
      labels: ["test"],
      selector: "@designer",
      defaultSelector: "@designer",
      metadata: { source: "test" },
      agentClass: "general",
      capabilities: ["chat", "invoke"],
      wakePolicy: "on_demand",
      homeNodeId: harness.nodeId,
      authorityNodeId: harness.nodeId,
      advertiseScope: "local",
    });

    const request = await broker.postJson<{
      kind: string;
      accepted: boolean;
      conversation?: { id: string; kind: string };
      message?: {
        id: string;
        conversationId: string;
        actorId: string;
        metadata?: { returnAddress?: { sessionId?: string } };
      };
    }>(harness.baseUrl, "/v1/deliver", {
      id: "deliver-operator-request",
      caller: {
        actorId: "operator",
        nodeId: harness.nodeId,
      },
      target: {
        kind: "agent_label",
        label: "@designer",
      },
      body: "please review the rail",
      intent: "tell",
      ensureAwake: false,
      replyToSessionId: "codex-thread-123",
      createdAt: Date.now(),
    });

    expect(request.kind).toBe("delivery");
    expect(request.accepted).toBe(true);
    expect(request.message?.actorId).toBe("operator");
    expect(request.message?.metadata?.returnAddress?.sessionId).toBe(
      "codex-thread-123",
    );

    const refReply = await broker.postJson<{
      kind: string;
      accepted: boolean;
      conversation?: { id: string; kind: string };
      message?: { id: string; conversationId: string; actorId: string; replyToMessageId?: string };
      receipt?: { targetLabel?: string };
    }>(harness.baseUrl, "/v1/deliver", {
      id: "deliver-ref-reply",
      caller: {
        actorId: "designer",
        nodeId: harness.nodeId,
      },
      targetLabel: `ref:${request.message!.id}`,
      body: "review complete",
      intent: "tell",
      createdAt: Date.now(),
    });

    expect(refReply.kind).toBe("delivery");
    expect(refReply.accepted).toBe(true);
    expect(refReply.conversation?.id).toBe(request.conversation?.id);
    expect(refReply.message?.replyToMessageId).toBe(request.message?.id);
    expect(refReply.message?.actorId).toBe("designer");
    expect(refReply.receipt?.targetLabel).toBe(`ref:${request.message!.id}`);

    const operatorReply = await broker.postJson<{
      kind: string;
      accepted: boolean;
      targetAgentId?: string;
      conversation?: { id: string; kind: string };
      message?: { actorId: string; audience?: { notify?: string[]; reason?: string } };
      receipt?: { targetAgentId?: string; targetLabel?: string };
    }>(harness.baseUrl, "/v1/deliver", {
      id: "deliver-operator-direct",
      caller: {
        actorId: "designer",
        nodeId: harness.nodeId,
      },
      targetLabel: "@operator",
      body: "thread reply fallback",
      intent: "tell",
      createdAt: Date.now(),
    });

    expect(operatorReply.kind).toBe("delivery");
    expect(operatorReply.accepted).toBe(true);
    expect(operatorReply.targetAgentId).toBe("operator");
    expect(operatorReply.receipt?.targetAgentId).toBe("operator");
    expect(operatorReply.receipt?.targetLabel).toBe("@operator");
    expect(operatorReply.message?.audience?.notify).toEqual(["operator"]);

    const snapshot = await broker.getJson<{
      messages: Record<string, { body: string; metadata?: Record<string, unknown> }>;
    }>(harness.baseUrl, "/v1/snapshot");
    expect(Object.values(snapshot.messages).some((message) => message.body.includes("Scout could not route"))).toBe(false);
  }, 15_000);

  test("dispatches a direct tell without requiring the sender to request wake", async () => {
    const harness = await broker.startBroker();

    await broker.postJson(harness.baseUrl, "/v1/agents", {
      id: "hudson",
      kind: "agent",
      definitionId: "hudson",
      displayName: "Hudson",
      handle: "hudson",
      labels: ["test"],
      selector: "@hudson",
      defaultSelector: "@hudson",
      metadata: { source: "test" },
      agentClass: "general",
      capabilities: ["chat", "invoke"],
      wakePolicy: "on_demand",
      homeNodeId: harness.nodeId,
      authorityNodeId: harness.nodeId,
      advertiseScope: "local",
    });

    const response = await broker.postJson<{
      kind: string;
      accepted: boolean;
      routeKind: string;
      receipt?: {
        messageId: string;
        flightId?: string;
      };
      message?: { id: string; conversationId: string; body: string };
      flight?: { id: string; invocationId: string; state: string; targetAgentId: string };
    }>(harness.baseUrl, "/v1/deliver", {
      id: "deliver-tell-1",
      caller: {
        actorId: "operator",
        nodeId: harness.nodeId,
      },
      target: {
        kind: "agent_label",
        label: "@hudson",
      },
      body: "Can you take a look at this when you get a turn?",
      intent: "tell",
      createdAt: Date.now(),
    });

    expect(response.kind).toBe("delivery");
    expect(response.accepted).toBe(true);
    expect(response.routeKind).toBe("dm");
    expect(response.message?.body).toBe("Can you take a look at this when you get a turn?");
    expect(response.flight?.state).toBe("waking");
    expect(response.flight?.targetAgentId).toBe("hudson");
    expect(response.receipt?.flightId).toBe(response.flight?.id);

    const recorded = await broker.getJson<{
      invocation: {
        id: string;
        action: string;
        ensureAwake: boolean;
        execution?: { session?: string };
        metadata?: Record<string, unknown>;
      } | null;
      flight: { id: string; state: string } | null;
    }>(harness.baseUrl, `/v1/invocations/${response.flight?.invocationId}`);

    expect(recorded.invocation).toEqual(expect.objectContaining({
      action: "wake",
      ensureAwake: true,
      execution: { session: "new" },
      metadata: expect.objectContaining({
        sourceIntent: "direct_message",
      }),
    }));
    expect(recorded.flight?.id).toBe(response.flight?.id);

    const plannedDeliveries = await broker.getJson<Array<{ id: string; status: string; targetId: string }>>(
      harness.baseUrl,
      `/v1/deliveries?messageId=${encodeURIComponent(response.message?.id ?? "")}&targetId=hudson`,
    );
    expect(plannedDeliveries.length).toBeGreaterThan(0);
    expect(plannedDeliveries.every((delivery) => delivery.status === "pending")).toBe(true);

    const completedAt = Date.now();
    await broker.postJson(harness.baseUrl, "/v1/flights", {
      id: response.flight!.id,
      invocationId: response.flight!.invocationId,
      requesterId: "operator",
      targetAgentId: "hudson",
      state: "completed",
      summary: "Hudson received the message.",
      output: "Acknowledged.",
      startedAt: completedAt - 100,
      completedAt,
    });

    const completedDeliveries = await broker.getJson<Array<{ id: string; status: string; metadata?: Record<string, unknown> }>>(
      harness.baseUrl,
      `/v1/deliveries?messageId=${encodeURIComponent(response.message?.id ?? "")}&targetId=hudson&status=completed`,
    );
    expect(completedDeliveries.map((delivery) => delivery.id).sort()).toEqual(
      plannedDeliveries.map((delivery) => delivery.id).sort(),
    );
    expect(completedDeliveries).toContainEqual(expect.objectContaining({
      status: "completed",
      metadata: expect.objectContaining({
        flightId: response.flight?.id,
        invocationId: response.flight?.invocationId,
        flightState: "completed",
      }),
    }));
  }, 15_000);

  test("routes local Scout product labels without exposing the coordinator name", async () => {
    const harness = await broker.startBroker();

    const response = await broker.postJson<{
      kind: string;
      accepted: boolean;
      routeKind: string;
      targetAgentId?: string;
      receipt?: { targetAgentId?: string; targetLabel?: string; conversationId?: string };
      conversation?: TestConversationIdentity & { title: string };
      message?: {
        conversationId?: string;
        mentions?: Array<{ actorId: string; label: string }>;
      };
    }>(harness.baseUrl, "/v1/deliver", {
      id: "deliver-scout-local",
      caller: {
        actorId: "operator",
        nodeId: harness.nodeId,
      },
      target: {
        kind: "agent_label",
        label: "scout",
      },
      body: "local broker status",
      intent: "tell",
      createdAt: Date.now(),
      messageMetadata: {
        source: "scout-cli",
      },
    });

    expect(response.kind).toBe("delivery");
    expect(response.accepted).toBe(true);
    expect(response.targetAgentId).toBe("scout");
    expect(response.receipt?.targetAgentId).toBe("scout");
    expect(response.receipt?.targetLabel).toBe("Scout");
    broker.expectOpaqueDirectConversation(response.conversation, {
      participantIds: ["operator", "scout"],
    });
    expect(response.conversation?.title).toBe("Scout");
    expect(response.receipt?.conversationId).toBe(response.conversation?.id);
    expect(response.message?.conversationId).toBe(response.conversation?.id);
    expect(response.message?.mentions?.[0]).toEqual({ actorId: "scout", label: "@scout" });

    const legacyAlias = await broker.postJson<{
      kind: string;
      accepted: boolean;
      targetAgentId?: string;
      receipt?: { targetLabel?: string };
    }>(harness.baseUrl, "/v1/deliver", {
      id: "deliver-openscout-legacy-local",
      caller: {
        actorId: "operator",
        nodeId: harness.nodeId,
      },
      target: {
        kind: "agent_label",
        label: "openscout",
      },
      body: "legacy local alias",
      intent: "tell",
      createdAt: Date.now(),
    });

    expect(legacyAlias.kind).toBe("delivery");
    expect(legacyAlias.accepted).toBe(true);
    expect(legacyAlias.targetAgentId).toBe("scout");
    expect(legacyAlias.receipt?.targetLabel).toBe("Scout");
  }, 15_000);

  test("returns a broker question for manual offline targets it cannot wake", async () => {
    const harness = await broker.startBroker();

    await broker.postJson(harness.baseUrl, "/v1/agents", {
      id: "newell",
      kind: "agent",
      definitionId: "newell",
      displayName: "Newell",
      handle: "newell",
      labels: ["test"],
      selector: "@newell",
      defaultSelector: "@newell",
      metadata: { source: "test" },
      agentClass: "general",
      capabilities: ["chat", "invoke"],
      wakePolicy: "manual",
      homeNodeId: harness.nodeId,
      authorityNodeId: harness.nodeId,
      advertiseScope: "local",
    });

    const response = await broker.requestJson(harness.baseUrl, "/v1/deliver", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        id: "deliver-test-2",
        requesterId: "operator",
        requesterNodeId: harness.nodeId,
        targetLabel: "@newell",
        body: "@newell hello",
        intent: "consult",
        createdAt: Date.now(),
      }),
    });

    expect(response.status).toBe(409);
    const body = response.body as {
      kind: string;
      accepted: boolean;
      question?: {
        kind: string;
        askedLabel: string;
        target?: {
          agentId: string;
          reason: string;
        };
      };
    };
    expect(body.kind).toBe("question");
    expect(body.accepted).toBe(false);
    expect(body.question?.kind).toBe("unavailable");
    expect(body.question?.askedLabel).toBe("@newell");
    expect(body.question?.target?.agentId).toBe("newell");
    expect(body.question?.target?.reason).toBe("manual_wake_required");
  }, 15_000);

  test("returns a broker question for superseded direct targets before dispatch", async () => {
    const harness = await broker.startBroker();

    await broker.postJson(harness.baseUrl, "/v1/agents", {
      id: "ranger.main.mini",
      kind: "agent",
      definitionId: "ranger",
      nodeQualifier: "mini",
      workspaceQualifier: "main",
      selector: "@ranger.main.node:mini",
      defaultSelector: "@ranger",
      displayName: "Ranger",
      handle: "ranger",
      labels: ["relay", "project", "agent", "local-agent"],
      metadata: {
        staleLocalRegistration: true,
        projectRoot: "/tmp/openscout",
      },
      agentClass: "general",
      capabilities: ["chat", "invoke", "deliver"],
      wakePolicy: "on_demand",
      homeNodeId: harness.nodeId,
      authorityNodeId: harness.nodeId,
      advertiseScope: "local",
    });

    const response = await broker.requestJson(harness.baseUrl, "/v1/deliver", {
      method: "POST",
      body: JSON.stringify({
        id: "deliver-test-stale",
        requesterId: "operator",
        requesterNodeId: harness.nodeId,
        targetAgentId: "ranger.main.mini",
        targetLabel: "ranger.main.mini",
        body: "@ranger.main.mini hello",
        intent: "consult",
        createdAt: Date.now(),
      }),
    });

    expect(response.status).toBe(409);
    const body = response.body as {
      kind: string;
      accepted: boolean;
      question?: {
        kind: string;
        target?: {
          agentId?: string;
          reason?: string;
          detail?: string;
        };
      };
    };
    expect(body.kind).toBe("question");
    expect(body.accepted).toBe(false);
    expect(body.question?.kind).toBe("unavailable");
    expect(body.question?.target?.agentId).toBe("ranger.main.mini");
    expect(body.question?.target?.reason).toBe("superseded_registration");
    expect(body.question?.target?.detail).toContain("superseded local registration");

    const snapshot = await broker.getJson<{ flights: Record<string, unknown> }>(
      harness.baseUrl,
      "/v1/snapshot",
    );
    expect(Object.keys(snapshot.flights)).toHaveLength(0);
  }, 15_000);

  test("does not treat superseded endpoints as card-only routing targets", async () => {
    const harness = await broker.startBroker();
    const staleAt = Date.now() - 5_000;

    await broker.postJson(harness.baseUrl, "/v1/agents", {
      id: "ranger.main.mini",
      kind: "agent",
      definitionId: "ranger",
      nodeQualifier: "mini",
      workspaceQualifier: "main",
      selector: "@ranger.main.node:mini",
      defaultSelector: "@ranger",
      displayName: "Ranger",
      handle: "ranger",
      labels: ["relay", "project", "agent", "local-agent"],
      metadata: {
        projectRoot: "/tmp/openscout",
      },
      agentClass: "general",
      capabilities: ["chat", "invoke", "deliver"],
      wakePolicy: "on_demand",
      homeNodeId: harness.nodeId,
      authorityNodeId: harness.nodeId,
      advertiseScope: "local",
    });
    await broker.postJson(harness.baseUrl, "/v1/endpoints", {
      id: "endpoint-ranger-main",
      agentId: "ranger.main.mini",
      nodeId: harness.nodeId,
      harness: "codex",
      transport: "codex_app_server",
      state: "offline",
      sessionId: "relay-ranger-codex",
      cwd: "/tmp/openscout",
      projectRoot: "/tmp/openscout",
      metadata: {
        staleLocalRegistration: true,
        staleAt,
        replacedByAgentId: "ranger.current.mini",
      },
    });

    const response = await broker.requestJson(harness.baseUrl, "/v1/deliver", {
      method: "POST",
      body: JSON.stringify({
        id: "deliver-test-stale-endpoint",
        requesterId: "operator",
        requesterNodeId: harness.nodeId,
        targetAgentId: "ranger.main.mini",
        targetLabel: "ranger.main.mini",
        body: "@ranger.main.mini hello",
        intent: "consult",
        createdAt: Date.now(),
      }),
    });

    expect(response.status).toBe(202);
    const body = response.body as {
      kind: string;
      accepted: boolean;
      targetAgentId?: string;
      conversation?: TestConversationIdentity;
      flight?: { targetAgentId?: string; state?: string; error?: string };
    };
    expect(body.kind).toBe("delivery");
    expect(body.accepted).toBe(true);
    expect(body.targetAgentId).toBe("ranger.main.mini");
    broker.expectOpaqueDirectConversation(body.conversation, {
      participantIds: ["operator", "ranger.main.mini"],
    });
    expect(body.flight?.targetAgentId).toBe("ranger.main.mini");
    expect(body.flight?.state).toBe("waking");
    expect(body.flight?.error).toBeUndefined();

    const snapshot = await broker.getJson<{ flights: Record<string, unknown> }>(
      harness.baseUrl,
      "/v1/snapshot",
    );
    expect(Object.keys(snapshot.flights)).toHaveLength(1);
  }, 15_000);

  test("returns a broker question when the requested session endpoint is not attachable", async () => {
    const harness = await broker.startBroker();
    const staleAt = Date.now() - 5_000;

    await broker.postJson(harness.baseUrl, "/v1/agents", {
      id: "ranger.main.mini",
      kind: "agent",
      definitionId: "ranger",
      nodeQualifier: "mini",
      workspaceQualifier: "main",
      selector: "@ranger.main.node:mini",
      defaultSelector: "@ranger",
      displayName: "Ranger",
      handle: "ranger",
      labels: ["relay", "project", "agent", "local-agent"],
      metadata: {
        projectRoot: "/tmp/openscout",
      },
      agentClass: "general",
      capabilities: ["chat", "invoke", "deliver"],
      wakePolicy: "on_demand",
      homeNodeId: harness.nodeId,
      authorityNodeId: harness.nodeId,
      advertiseScope: "local",
    });
    await broker.postJson(harness.baseUrl, "/v1/endpoints", {
      id: "endpoint-ranger-main",
      agentId: "ranger.main.mini",
      nodeId: harness.nodeId,
      harness: "codex",
      transport: "codex_app_server",
      state: "offline",
      sessionId: "relay-ranger-codex",
      cwd: "/tmp/openscout",
      projectRoot: "/tmp/openscout",
      metadata: {
        staleLocalRegistration: true,
        staleAt,
        replacedByAgentId: "ranger.current.mini",
      },
    });

    const response = await broker.requestJson(harness.baseUrl, "/v1/deliver", {
      method: "POST",
      body: JSON.stringify({
        id: "deliver-test-stale-session-endpoint",
        requesterId: "operator",
        requesterNodeId: harness.nodeId,
        target: {
          kind: "session_id",
          sessionId: "relay-ranger-codex",
        },
        body: "continue the exact session",
        intent: "consult",
        createdAt: Date.now(),
      }),
    });

    expect(response.status).toBe(409);
    const body = response.body as {
      kind: string;
      accepted: boolean;
      question?: {
        target?: {
          reason?: string;
          detail?: string;
        };
      };
      remediation?: {
        kind?: string;
      };
    };
    expect(body.kind).toBe("question");
    expect(body.accepted).toBe(false);
    expect(body.question?.target?.reason).toBe("session_reference_not_attachable");
    expect(body.question?.target?.detail).toContain("endpoint endpoint-ranger-main");
    expect(body.question?.target?.detail).toContain("replacement agent is ranger.current.mini");
    expect(body.remediation?.kind).toBe("session_reference_not_attachable");

    const snapshot = await broker.getJson<{ flights: Record<string, unknown> }>(
      harness.baseUrl,
      "/v1/snapshot",
    );
    expect(Object.keys(snapshot.flights)).toHaveLength(0);
  }, 15_000);

  test("reports replacement metadata for superseded direct targets", async () => {
    const harness = await broker.startBroker();

    await broker.postJson(harness.baseUrl, "/v1/agents", {
      id: "ranger.main.mini",
      kind: "agent",
      definitionId: "ranger",
      nodeQualifier: "mini",
      workspaceQualifier: "main",
      selector: "@ranger.main.node:mini",
      defaultSelector: "@ranger",
      displayName: "Ranger",
      handle: "ranger",
      labels: ["relay", "project", "agent", "local-agent"],
      metadata: {
        staleLocalRegistration: true,
        replacedByAgentId: "ranger.codex-vox-getting-started.mini",
        projectRoot: "/tmp/openscout",
      },
      agentClass: "general",
      capabilities: ["chat", "invoke", "deliver"],
      wakePolicy: "on_demand",
      homeNodeId: harness.nodeId,
      authorityNodeId: harness.nodeId,
      advertiseScope: "local",
    });
    await broker.postJson(harness.baseUrl, "/v1/agents", {
      id: "ranger.codex-vox-getting-started.mini",
      kind: "agent",
      definitionId: "ranger",
      nodeQualifier: "mini",
      workspaceQualifier: "codex-vox-getting-started",
      selector: "@ranger.codex-vox-getting-started.node:mini",
      defaultSelector: "@ranger",
      displayName: "Ranger",
      handle: "ranger",
      labels: ["relay", "project", "agent", "local-agent"],
      metadata: {
        projectRoot: "/tmp/openscout",
      },
      agentClass: "general",
      capabilities: ["chat", "invoke", "deliver"],
      wakePolicy: "on_demand",
      homeNodeId: harness.nodeId,
      authorityNodeId: harness.nodeId,
      advertiseScope: "local",
    });

    const response = await broker.requestJson(harness.baseUrl, "/v1/deliver", {
      method: "POST",
      body: JSON.stringify({
        id: "deliver-test-stale-replaced",
        requesterId: "operator",
        requesterNodeId: harness.nodeId,
        targetAgentId: "ranger.main.mini",
        targetLabel: "ranger.main.mini",
        body: "@ranger.main.mini hello",
        intent: "consult",
        createdAt: Date.now(),
      }),
    });

    expect(response.status).toBe(409);
    const body = response.body as {
      kind: string;
      accepted: boolean;
      remediation?: {
        kind?: string;
        detail?: string;
      };
      question?: {
        kind: string;
        target?: {
          agentId?: string;
          reason?: string;
          detail?: string;
        };
      };
    };
    expect(body.kind).toBe("question");
    expect(body.accepted).toBe(false);
    expect(body.question?.kind).toBe("unavailable");
    expect(body.question?.target?.agentId).toBe("ranger.main.mini");
    expect(body.question?.target?.reason).toBe("superseded_registration");
    expect(body.question?.target?.detail).toContain("replacement agent is ranger.codex-vox-getting-started.mini");
    expect(body.remediation?.kind).toBe("use_current_registration");
  }, 15_000);

  test("does not resolve superseded label-only targets", async () => {
    const harness = await broker.startBroker();

    await broker.postJson(harness.baseUrl, "/v1/agents", {
      id: "ranger.main.mini",
      kind: "agent",
      definitionId: "ranger",
      nodeQualifier: "mini",
      workspaceQualifier: "main",
      selector: "@ranger.main.node:mini",
      defaultSelector: "@ranger",
      displayName: "Ranger",
      handle: "ranger",
      labels: ["relay", "project", "agent", "local-agent"],
      metadata: {
        staleLocalRegistration: true,
        projectRoot: "/tmp/openscout",
      },
      agentClass: "general",
      capabilities: ["chat", "invoke", "deliver"],
      wakePolicy: "on_demand",
      homeNodeId: harness.nodeId,
      authorityNodeId: harness.nodeId,
      advertiseScope: "local",
    });

    const response = await broker.requestJson(harness.baseUrl, "/v1/deliver", {
      method: "POST",
      body: JSON.stringify({
        id: "deliver-test-stale-label",
        requesterId: "operator",
        requesterNodeId: harness.nodeId,
        targetLabel: "@ranger",
        body: "@ranger hello",
        intent: "consult",
        createdAt: Date.now(),
      }),
    });

    expect(response.status).toBe(422);
    const body = response.body as {
      kind: string;
      accepted: boolean;
      reason?: string;
      rejection?: {
        kind?: string;
        askedLabel?: string;
        detail?: string;
      };
    };
    expect(body.kind).toBe("rejected");
    expect(body.accepted).toBe(false);
    expect(body.reason).toBe("unknown_target");
    expect(body.rejection?.kind).toBe("unknown");
    expect(body.rejection?.askedLabel).toBe("@ranger");

    const snapshot = await broker.getJson<{ flights: Record<string, unknown> }>(
      harness.baseUrl,
      "/v1/snapshot",
    );
    expect(Object.keys(snapshot.flights)).toHaveLength(0);
  }, 15_000);

  test("returns a broker question for last-seen-expired peer authority targets", async () => {
    const harness = await broker.startBroker();
    const stalePeerNodeId = "mini-peer";

    await broker.postJson(harness.baseUrl, "/v1/nodes", {
      id: stalePeerNodeId,
      meshId: "openscout",
      name: "Mini Peer",
      advertiseScope: "mesh",
      brokerUrl: "http://100.64.0.2:43110",
      registeredAt: Date.now() - 3 * 24 * 60 * 60 * 1000,
      lastSeenAt: Date.now() - 3 * 24 * 60 * 60 * 1000,
    });

    await broker.postJson(harness.baseUrl, "/v1/agents", {
      id: "arach.mini",
      kind: "agent",
      definitionId: "arach",
      nodeQualifier: "mini",
      selector: "@arach.node:mini",
      defaultSelector: "@arach",
      displayName: "Arach",
      handle: "arach",
      labels: ["relay", "project", "agent", "local-agent"],
      metadata: {
        projectRoot: "/Users/arach",
      },
      agentClass: "general",
      capabilities: ["chat", "invoke", "deliver"],
      wakePolicy: "on_demand",
      homeNodeId: stalePeerNodeId,
      authorityNodeId: stalePeerNodeId,
      advertiseScope: "local",
    });

    const response = await broker.requestJson(harness.baseUrl, "/v1/deliver", {
      method: "POST",
      body: JSON.stringify({
        id: "deliver-test-stale-peer",
        requesterId: "codex",
        requesterNodeId: harness.nodeId,
        targetLabel: "@arach",
        body: "@arach local status update",
        intent: "tell",
        createdAt: Date.now(),
      }),
    });

    expect(response.status).toBe(409);
    const body = response.body as {
      kind: string;
      accepted: boolean;
      question?: {
        kind: string;
        askedLabel: string;
        target?: {
          agentId: string;
          reason: string;
          detail: string;
        };
      };
    };
    expect(body.kind).toBe("question");
    expect(body.accepted).toBe(false);
    expect(body.question?.kind).toBe("unavailable");
    expect(body.question?.askedLabel).toBe("@arach");
    expect(body.question?.target?.agentId).toBe("arach.mini");
    expect(body.question?.target?.reason).toBe("unknown");
    expect(body.question?.target?.detail).toContain("peer has not been seen recently");

    const snapshot = await broker.getJson<{ flights: Record<string, unknown> }>(
      harness.baseUrl,
      "/v1/snapshot",
    );
    expect(Object.keys(snapshot.flights)).toHaveLength(0);
  }, 15_000);

  test("rejects unknown delivery targets explicitly", async () => {
    const harness = await broker.startBroker();

    const response = await broker.requestJson(harness.baseUrl, "/v1/deliver", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        id: "deliver-test-unknown",
        requesterId: "operator",
        requesterNodeId: harness.nodeId,
        targetLabel: "@mars",
        body: "@mars finish the job",
        intent: "consult",
        createdAt: Date.now(),
      }),
    });

    expect(response.status).toBe(422);
    const body = response.body as {
      kind: string;
      accepted: boolean;
      reason?: string;
      rejection?: {
        kind: string;
        askedLabel: string;
        detail: string;
      };
    };
    expect(body.kind).toBe("rejected");
    expect(body.accepted).toBe(false);
    expect(body.reason).toBe("unknown_target");
    expect(body.rejection?.kind).toBe("unknown");
    expect(body.rejection?.askedLabel).toBe("@mars");
    expect(body.rejection?.detail).toContain("@mars");
  }, 15_000);
});
