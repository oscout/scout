import { expect, test } from "bun:test";
import { runtimeSessionHandleForEndpoint } from "./runtime-session-handle.js";
import type { AgentEndpoint } from "@openscout/protocol";
import { createBrokerDaemonTestHarness } from "./test-helpers/broker-daemon-harness.test";
const broker = createBrokerDaemonTestHarness();

test("new mailbox work emits a control-stream hint after durable acceptance", async () => {
  const h = await broker.startBroker({ env: { OPENSCOUT_EXTERNAL_SESSION_CONNECTIONS: "[]" } });
  await broker.seedBasicConversation(h);
  const attached = await broker.postJson<{ sessionId: string }>(h.baseUrl, "/v1/external-sessions/attach", {
    ownerId: "muse", nativeSessionId: "muse-stream-test",
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  const response = await fetch(`${h.baseUrl}/v1/events/stream`, { signal: controller.signal });
  const reader = response.body!.getReader();
  try {
    // Read hello before dispatch, so the subscription cannot race queue creation.
    await reader.read();
    await broker.postJson(h.baseUrl, "/v1/deliver", {
      id: "mailbox-stream-test", caller: { actorId: "operator", nodeId: h.nodeId },
      target: { kind: "session_id", sessionId: attached.sessionId }, body: "Event-driven hello",
      intent: "consult", ensureAwake: true, createdAt: Date.now(),
    });
    const decoder = new TextDecoder();
    let data = "";
    while (!data.includes('"phase":"mailbox_queued"')) {
      const { value, done } = await reader.read();
      if (done) throw new Error("stream closed before mailbox event");
      data += decoder.decode(value, { stream: true });
    }
    expect(data).toContain("event: delivery.state.changed");
    expect(data).toContain(`"sessionId":"${attached.sessionId}"`);
    const hint = data.split("\n\n").find((frame) => frame.includes('"phase":"mailbox_queued"'))!;
    expect(hint).not.toContain("mailboxBody");
    const mailbox = await broker.postJson<{ items: Array<{ body: string }> }>(h.baseUrl, "/v1/external-sessions/poll", {
      ownerId: "muse", sessionId: attached.sessionId,
    });
    expect(mailbox.items).toHaveLength(1);
    expect(mailbox.items[0]!.body).toContain("Event-driven hello");
  } finally {
    clearTimeout(timeout);
    controller.abort();
    await reader.cancel().catch(() => {});
  }
}, 20_000);

test("real broker routes an attached exact session into cloud transport and durably records rejection", async () => {
  const harness = await broker.startBroker({ env: {
    OPENSCOUT_EXTERNAL_SESSION_CONNECTIONS: JSON.stringify([{ id: "devin-test", ownerId: "owner", agentId: "devin-test", provider: "devin", organizationId: "org-test", tokenEnv: "SCOUT_TEST_MISSING_DEVIN_KEY" }]),
    SCOUT_TEST_MISSING_DEVIN_KEY: "",
  } });
  await broker.seedBasicConversation(harness);
  await broker.postJson(harness.baseUrl, "/v1/agents", {
    id: "devin-test", kind: "agent", definitionId: "devin-test", displayName: "Devin Test", handle: "devin-test",
    agentClass: "bridge", capabilities: ["chat", "invoke"], wakePolicy: "on_demand", homeNodeId: harness.nodeId, authorityNodeId: harness.nodeId, advertiseScope: "local",
  });
  const endpoint: AgentEndpoint = { id: "external-test", agentId: "devin-test", nodeId: harness.nodeId, harness: "devin", transport: "http", state: "idle", sessionId: "devin-test:org-test:devin-abcdef",
    metadata: { externalSession: true, connectionId: "devin-test", ownerId: "owner", nativeSessionId: "devin-abcdef", externalSessionId: "devin-test:org-test:devin-abcdef" } };
  await broker.postJson(harness.baseUrl, "/v1/endpoints", endpoint);
  const receipt = await broker.postJson<{ accepted: boolean; flight: { invocationId: string; id: string } }>(harness.baseUrl, "/v1/deliver", {
    id: "external-test-request", caller: { actorId: "operator", nodeId: harness.nodeId },
    target: { kind: "session_id", sessionId: runtimeSessionHandleForEndpoint(endpoint) }, body: "Test routing without making a provider call", intent: "consult", ensureAwake: true, createdAt: Date.now(),
  });
  expect(receipt.accepted).toBe(true);
  expect(receipt.flight?.invocationId).toBeTruthy();
  let result: { flight?: { state: string; error?: string; metadata?: Record<string, unknown> } } = {};
  for (let i = 0; i < 100; i++) {
    result = await broker.getJson(harness.baseUrl, `/v1/invocations/${receipt.flight.invocationId}`);
    if (result.flight?.state === "failed") break;
    await Bun.sleep(30);
  }
  expect(result.flight?.state).toBe("failed");
  expect(result.flight?.error).toBe("external_session_credential_missing");
  expect(result.flight?.metadata?.externalDeliveryId).toBeTruthy();
}, 20_000);

test("existing MCP identity attaches isolated mailboxes and completes an exact-session round trip without API credentials", async () => {
  const h = await broker.startBroker({ env: { OPENSCOUT_EXTERNAL_SESSION_CONNECTIONS: "[]" } });
  await broker.seedBasicConversation(h);
  const attach = (nativeSessionId: string) => broker.postJson<{ sessionId: string; agentId: string; wake: string }>(h.baseUrl, "/v1/external-sessions/attach", { ownerId: "devin_cloud", nativeSessionId });
  const sender = await broker.postJson<{ sessionId: string }>(h.baseUrl, "/v1/external-sessions/attach", { ownerId: "operator", nativeSessionId: "current-codex-thread" });
  const a = await attach("devin-conversation-a"); const b = await attach("devin-conversation-b");
  expect(a.sessionId).not.toBe(b.sessionId);
  expect(a.agentId).toBe("devin_cloud");
  expect(a.wake).toBe("none");
  const ask = await broker.postJson<{ accepted: boolean; flight: { invocationId: string; id: string } }>(h.baseUrl, "/v1/deliver", {
    id: "mcp-poll-roundtrip", replyToSessionId: sender.sessionId, caller: { actorId: "operator", nodeId: h.nodeId },
    target: { kind: "session_id", sessionId: a.sessionId }, body: "Confirm the connection", intent: "consult", ensureAwake: true, createdAt: Date.now(),
  });
  expect(ask.accepted).toBe(true);
  const poll = (sessionId: string) => broker.postJson<{ items: Array<{ deliveryId: string; body: string; status: string }> }>(h.baseUrl, "/v1/external-sessions/poll", { ownerId: "devin_cloud", sessionId });
  let inbox = await poll(a.sessionId);
  for (let i = 0; !inbox.items.length && i < 50; i++) { await Bun.sleep(20); inbox = await poll(a.sessionId); }
  expect(inbox.items).toHaveLength(1);
  expect(inbox.items[0]!.body).toContain("Confirm the connection");
  expect((await poll(b.sessionId)).items).toHaveLength(0);
  expect((await poll(a.sessionId)).items[0]!.deliveryId).toBe(inbox.items[0]!.deliveryId);
  await broker.postJson(h.baseUrl, "/v1/external-sessions/ack", { ownerId: "devin_cloud", sessionId: a.sessionId, deliveryId: inbox.items[0]!.deliveryId });
  const pending = await broker.getJson<{ flight: { state: string } }>(h.baseUrl, `/v1/invocations/${ask.flight.invocationId}`);
  expect(pending.flight.state).toBe("waiting");
  const args = { ownerId: "devin_cloud", sessionId: a.sessionId, deliveryId: inbox.items[0]!.deliveryId, body: "Connection confirmed" };
  await broker.postJson(h.baseUrl, "/v1/external-sessions/reply", args);
  const retry = await broker.postJson<{ duplicate: boolean }>(h.baseUrl, "/v1/external-sessions/reply", args);
  expect(retry.duplicate).toBe(true);
  const done = await broker.getJson<{ flight: { state: string; output: string } }>(h.baseUrl, `/v1/invocations/${ask.flight.invocationId}`);
  expect(done.flight.state).toBe("completed");
  expect(done.flight.output).toBe("Connection confirmed");
  expect((await poll(a.sessionId)).items).toHaveLength(0);
  const pollSender = () => broker.postJson<{ items: Array<{ deliveryId: string; kind: string; body: string }> }>(h.baseUrl, "/v1/external-sessions/poll", { ownerId: "operator", sessionId: sender.sessionId });
  let results = await pollSender();
  for (let i = 0; !results.items.length && i < 50; i++) { await Bun.sleep(20); results = await pollSender(); }
  expect(results.items).toHaveLength(1);
  expect(results.items[0]!.kind).toBe("result");
  expect(results.items[0]!.body).toContain("Connection confirmed");
  await broker.postJson(h.baseUrl, "/v1/external-sessions/ack", { ownerId: "operator", sessionId: sender.sessionId, deliveryId: results.items[0]!.deliveryId });
  expect((await pollSender()).items).toHaveLength(0);
  const snapshot = await broker.getJson<{ agents: Record<string, unknown> }>(h.baseUrl, "/v1/snapshot?scope=agents");
  expect(snapshot.agents.devin_cloud).toBeUndefined(); // Attachment creates no agent card, especially not one per session.
}, 20_000);
