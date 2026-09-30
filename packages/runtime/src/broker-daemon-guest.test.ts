import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import type { InvocationRequest, MessageRecord } from "@openscout/protocol";
import { signPeerRequest } from "./mesh-peer-auth.js";
import type { NodeIdentity } from "./node-identity.js";
import { createBrokerDaemonTestHarness } from "./test-helpers/broker-daemon-harness.test";

const broker = createBrokerDaemonTestHarness();

test("signed guest ask completes through the canonical target reply, without a flight write", async () => {
  const h = await broker.startBroker();
  await broker.seedBasicConversation(h);
  const pair = generateKeyPairSync("ed25519");
  const identity: NodeIdentity = {
    version: 1, createdAt: Date.now(),
    publicKey: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKey: pair.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
  };
  const node = await broker.getJson<{ card: { keyId: string } }>(h.baseUrl, "/v1/node");
  const installed = await broker.postJson<{ grant: { id: string; actorId: string } }>(h.baseUrl, "/v1/guest-grants", {
    requestId: "daemon-guest", clientPublicKey: identity.publicKey, label: "Muse test", allowedTargets: ["fabric"],
  });
  const guest = async (method: string, path: string, payload?: unknown) => {
    const body = payload === undefined ? "" : JSON.stringify(payload);
    const response = await fetch(h.baseUrl + path, {
      method, headers: { "content-type": "application/json", ...signPeerRequest(identity, {
        method, path, body, destinationKeyId: node.card.keyId,
      }) }, ...(method === "GET" ? {} : { body }),
    });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  const task = { requestId: "daemon-ask-01", target: "fabric", task: "Review this specification." };
  const accepted = await guest("POST", "/v1/guest/asks", task);
  expect(accepted.status).toBe(202);
  const snapshot = await broker.getJson<{ invocations: Record<string, InvocationRequest>; messages: Record<string, MessageRecord> }>(h.baseUrl, "/v1/snapshot");
  const invocation = snapshot.invocations[accepted.body.invocationId]!;
  expect(invocation.requesterId).toBe(installed.grant.actorId);
  expect(invocation.messageId).toBeTruthy();
  const message = snapshot.messages[invocation.messageId!]!;
  expect(message.body).toBe(task.task);
  expect(message.conversationId).toBe(invocation.conversationId);
  // Simulate only the agent's normal reply. The daemon owns all flight transitions.
  await broker.postJson(h.baseUrl, "/v1/messages", {
    id: "guest-target-reply", conversationId: invocation.conversationId,
    actorId: "fabric", originNodeId: h.nodeId, class: "agent",
    body: "Reviewed: preserve the original machine when resuming work.",
    replyToMessageId: invocation.messageId, audience: { notify: [installed.grant.actorId], reason: "thread_reply" },
    visibility: "private", policy: "durable", createdAt: Date.now(), metadata: { source: "test" },
  });
  const reply = await guest("GET", "/v1/guest/asks/daemon-ask-01?wait=1");
  expect(reply.status).toBe(200);
  expect(reply.body.state).toBe("completed");
  expect(reply.body.output).toBe("Reviewed: preserve the original machine when resuming work.");
  const retry = await guest("POST", "/v1/guest/asks", task);
  expect(retry.body.duplicate).toBe(true);
  expect(retry.body.invocationId).toBe(accepted.body.invocationId);
  expect((await guest("GET", "/v1/messages")).status).toBe(403);
  await broker.postJson(h.baseUrl, "/v1/guest-grants/revoke", { grantId: installed.grant.id });
  expect((await guest("GET", "/v1/guest/asks/daemon-ask-01")).status).toBe(401);
}, 20_000);

test("guest mailbox receives a local Scout ask and replies under its own grant", async () => {
  const h = await broker.startBroker();
  await broker.seedBasicConversation(h);
  const node = await broker.getJson<{ card: { keyId: string } }>(h.baseUrl, "/v1/node");
  async function enroll(requestId: string) {
    const pair = generateKeyPairSync("ed25519");
    const identity: NodeIdentity = { version: 1, createdAt: Date.now(),
      publicKey: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
      privateKey: pair.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64") };
    const installed = await broker.postJson<{ grant: { id: string; actorId: string } }>(h.baseUrl, "/v1/guest-grants", {
      requestId, clientPublicKey: identity.publicKey, label: requestId, allowedTargets: ["fabric"],
    });
    return { publicKey: identity.publicKey, grant: installed.grant, call: async (action: string, payload: unknown) => {
      const path = `/v1/guest/sessions/${action}`, body = JSON.stringify(payload);
      const response = await fetch(h.baseUrl + path, { method: "POST", body,
        headers: { "content-type": "application/json", ...signPeerRequest(identity, { method: "POST", path, body, destinationKeyId: node.card.keyId }) } });
      return { status: response.status, body: await response.json() as Record<string, any> };
    } };
  }
  const a = await enroll("mailbox-a"), b = await enroll("mailbox-b");
  const attached = await a.call("attach", { nativeSessionId: "muse-thread", ownerId: "operator", connectionId: "ignored" });
  expect(attached.status).toBe(200);
  expect(attached.body.agentId).toBe(`${a.grant.actorId}.${a.grant.id}`);
  expect(attached.body.wake).toBe("none");
  const sessionId = attached.body.sessionId;
  expect((await a.call("attach", { nativeSessionId: "muse-thread" })).body.sessionId).toBe(sessionId);
  expect((await b.call("poll", { sessionId })).status).toBe(400);
  const ask = await broker.postJson<{ accepted: boolean; flight: { invocationId: string } }>(h.baseUrl, "/v1/deliver", {
    id: "guest-mailbox-mission", caller: { actorId: "operator", nodeId: h.nodeId },
    target: { kind: "session_id", sessionId }, body: "Describe one useful Scout interaction.", intent: "consult", ensureAwake: true, createdAt: Date.now(),
  });
  expect(ask.accepted).toBe(true);
  let polled = await a.call("poll", { sessionId });
  for (let i = 0; !polled.body.items?.length && i < 50; i++) { await Bun.sleep(20); polled = await a.call("poll", { sessionId }); }
  expect(polled.body.items).toHaveLength(1);
  expect(polled.body.items[0].body).toContain("Describe one useful Scout interaction.");
  const deliveryId = polled.body.items[0].deliveryId;
  expect((await b.call("reply", { sessionId, deliveryId, body: "Wrong guest" })).status).toBe(400);
  expect((await a.call("ack", { sessionId, deliveryId })).status).toBe(200);
  const reply = { sessionId, deliveryId, body: "Receive a mission through Scout and return the result in the same conversation." };
  expect((await a.call("reply", reply)).status).toBe(200);
  expect((await a.call("reply", reply)).body.duplicate).toBe(true);
  const completed = await broker.getJson<{ flight: { state: string; output: string } }>(h.baseUrl, `/v1/invocations/${ask.flight.invocationId}`);
  expect(completed.flight.state).toBe("completed");
  expect(completed.flight.output).toBe(reply.body);
  expect((await a.call("poll", { sessionId })).body.items).toHaveLength(0);
  await broker.postJson(h.baseUrl, "/v1/guest-grants/revoke", { grantId: a.grant.id });
  for (const action of ["get", "poll", "ack", "reply", "attach"]) {
    expect((await a.call(action, { ...reply, nativeSessionId: "another" })).status).toBe(401);
  }
  await broker.postJson(h.baseUrl, "/v1/guest-grants", {
    requestId: "mailbox-a-renewed", clientPublicKey: a.publicKey, label: "replacement", allowedTargets: ["fabric"],
  });
  const renewed = await a.call("attach", { nativeSessionId: "muse-thread" });
  expect(renewed.status).toBe(200);
  expect(renewed.body.sessionId).not.toBe(sessionId);
  expect((await a.call("poll", { sessionId })).status).toBe(400);
}, 20_000);
