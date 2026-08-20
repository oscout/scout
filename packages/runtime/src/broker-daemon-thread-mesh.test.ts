import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { namedChannelNaturalKey } from "@openscout/protocol";

import { createBrokerDaemonTestHarness } from "./test-helpers/broker-daemon-harness.test";

const broker = createBrokerDaemonTestHarness();

describe("broker daemon thread and mesh routes", () => {
  test("replays thread events and snapshots for shared conversations", async () => {
    const harness = await broker.startBroker();
    await broker.seedBasicConversation(harness);

    await broker.postJson(harness.baseUrl, "/v1/conversations", {
      id: "channel.shared.thread-events",
      kind: "channel",
      title: "shared thread events",
      visibility: "workspace",
      shareMode: "shared",
      authorityNodeId: harness.nodeId,
      participantIds: ["operator", "fabric"],
      metadata: { surface: "test" },
    });

    await broker.postJson(harness.baseUrl, "/v1/messages", {
      id: "msg-thread-event-1",
      conversationId: "channel.shared.thread-events",
      actorId: "operator",
      originNodeId: harness.nodeId,
      class: "agent",
      body: "@fabric replay this message",
      mentions: [{ actorId: "fabric", label: "@fabric" }],
      visibility: "workspace",
      policy: "durable",
      createdAt: Date.now(),
    });

    const replayedEvents = await broker.getJson<Array<{
      kind: string;
      conversationId: string;
      payload: { message?: { id?: string } };
    }>>(
      harness.baseUrl,
      "/v1/conversations/channel.shared.thread-events/thread-events?afterSeq=0&limit=20",
    );
    expect(replayedEvents.some((event) => event.kind === "message.posted" && event.payload.message?.id === "msg-thread-event-1")).toBe(true);

    const snapshot = await broker.getJson<{
      latestSeq: number;
      messages?: Array<{ id?: string }>;
    }>(
      harness.baseUrl,
      "/v1/conversations/channel.shared.thread-events/thread-snapshot",
    );
    expect(snapshot.latestSeq).toBeGreaterThan(0);
    expect(snapshot.messages?.some((message) => message.id === "msg-thread-event-1")).toBe(true);
  }, 15_000);

  test("rejects thread watch and snapshot requests for local conversations", async () => {
    const harness = await broker.startBroker();
    await broker.seedBasicConversation(harness);

    const openResponse = await broker.requestJson(harness.baseUrl, "/v1/thread-watches/open", {
      method: "POST",
      body: JSON.stringify({
        conversationId: "channel.shared",
        watcherNodeId: "node-remote",
        watcherId: "watch-local-forbidden",
      }),
    });
    expect(openResponse.status).toBe(403);
    expect((openResponse.body as { code?: string }).code).toBe("forbidden");

    const snapshotResponse = await broker.requestJson(
      harness.baseUrl,
      "/v1/conversations/channel.shared/thread-snapshot",
    );
    expect(snapshotResponse.status).toBe(403);
    expect((snapshotResponse.body as { code?: string }).code).toBe("forbidden");
  }, 15_000);

  test("supports thread watch backlog, live delivery, renew, and close", async () => {
    const harness = await broker.startBroker();
    await broker.seedBasicConversation(harness);

    await broker.postJson(harness.baseUrl, "/v1/conversations", {
      id: "channel.shared.watch",
      kind: "channel",
      title: "shared watch",
      visibility: "workspace",
      shareMode: "shared",
      authorityNodeId: harness.nodeId,
      participantIds: ["operator", "fabric"],
      metadata: { surface: "test" },
    });

    await broker.postJson(harness.baseUrl, "/v1/messages", {
      id: "msg-watch-1",
      conversationId: "channel.shared.watch",
      actorId: "operator",
      originNodeId: harness.nodeId,
      class: "agent",
      body: "first shared watch event",
      visibility: "workspace",
      policy: "durable",
      createdAt: Date.now(),
    });

    const initialWatch = await broker.postJson<{
      watchId: string;
      acceptedAfterSeq: number;
      latestSeq: number;
      leaseExpiresAt: number;
    }>(harness.baseUrl, "/v1/thread-watches/open", {
      conversationId: "channel.shared.watch",
      watcherNodeId: "node-remote",
      watcherId: "watch-live",
      afterSeq: 0,
      leaseMs: 10_000,
    });
    expect(initialWatch.acceptedAfterSeq).toBe(0);
    expect(initialWatch.latestSeq).toBeGreaterThanOrEqual(1);

    const backlogEvent = await broker.waitForThreadEvent(
      harness.baseUrl,
      initialWatch.watchId,
      (event) => event.kind === "message.posted" && event.payload?.message?.id === "msg-watch-1",
    );
    expect(backlogEvent.payload?.message?.id).toBe("msg-watch-1");

    const renewed = await broker.postJson<{
      watchId: string;
      leaseExpiresAt: number;
    }>(harness.baseUrl, "/v1/thread-watches/renew", {
      watchId: initialWatch.watchId,
      leaseMs: 20_000,
    });
    expect(renewed.watchId).toBe(initialWatch.watchId);
    expect(renewed.leaseExpiresAt).toBeGreaterThan(initialWatch.leaseExpiresAt);

    const resumedWatch = await broker.postJson<{
      watchId: string;
      acceptedAfterSeq: number;
    }>(harness.baseUrl, "/v1/thread-watches/open", {
      conversationId: "channel.shared.watch",
      watcherNodeId: "node-remote",
      watcherId: "watch-live",
      afterSeq: 1,
      leaseMs: 20_000,
    });
    expect(resumedWatch.watchId).toBe(initialWatch.watchId);
    expect(resumedWatch.acceptedAfterSeq).toBe(1);

    const liveEvent = await broker.waitForThreadEvent(
      harness.baseUrl,
      resumedWatch.watchId,
      (event) => event.kind === "message.posted" && event.payload?.message?.id === "msg-watch-2",
      {
        triggerOnHello: async () => {
          await broker.postJson(harness.baseUrl, "/v1/messages", {
            id: "msg-watch-2",
            conversationId: "channel.shared.watch",
            actorId: "fabric",
            originNodeId: harness.nodeId,
            class: "agent",
            body: "second shared watch event",
            visibility: "workspace",
            policy: "durable",
            createdAt: Date.now(),
          });
        },
      },
    );
    expect(liveEvent.payload?.message?.id).toBe("msg-watch-2");

    const closeResponse = await broker.postJson<{ ok: boolean; watchId: string }>(
      harness.baseUrl,
      "/v1/thread-watches/close",
      {
        watchId: resumedWatch.watchId,
        reason: "test_complete",
      },
    );
    expect(closeResponse.ok).toBe(true);
    expect(closeResponse.watchId).toBe(resumedWatch.watchId);

    const renewAfterClose = await broker.requestJson(harness.baseUrl, "/v1/thread-watches/renew", {
      method: "POST",
      body: JSON.stringify({
        watchId: resumedWatch.watchId,
      }),
    });
    expect(renewAfterClose.status).toBe(404);
    expect((renewAfterClose.body as { code?: string }).code).toBe("invalid_request");
  }, 20_000);

  test("forwards remote thread writes to the authority without mirroring history", async () => {
    const authority = await broker.startBroker();
    const remote = await broker.startBroker();

    const sharedConversation = {
      id: "channel.shared.remote",
      kind: "channel",
      title: "shared remote",
      visibility: "workspace",
      shareMode: "shared",
      authorityNodeId: authority.nodeId,
      participantIds: ["remote-agent"],
      metadata: { surface: "test" },
    };

    await broker.postJson(remote.baseUrl, "/v1/nodes", {
      id: authority.nodeId,
      meshId: "openscout",
      name: "Authority",
      advertiseScope: "local",
      brokerUrl: authority.baseUrl,
      registeredAt: Date.now(),
    });

    await broker.postJson(authority.baseUrl, "/v1/agents", {
      id: "remote-agent",
      kind: "agent",
      definitionId: "remote-agent",
      displayName: "Remote Agent",
      handle: "remote-agent",
      labels: ["test"],
      selector: "@remote-agent",
      defaultSelector: "@remote-agent",
      metadata: { source: "test" },
      agentClass: "general",
      capabilities: ["chat"],
      wakePolicy: "on_demand",
      homeNodeId: remote.nodeId,
      authorityNodeId: remote.nodeId,
      advertiseScope: "local",
    });

    await broker.postJson(remote.baseUrl, "/v1/agents", {
      id: "remote-agent",
      kind: "agent",
      definitionId: "remote-agent",
      displayName: "Remote Agent",
      handle: "remote-agent",
      labels: ["test"],
      selector: "@remote-agent",
      defaultSelector: "@remote-agent",
      metadata: { source: "test" },
      agentClass: "general",
      capabilities: ["chat"],
      wakePolicy: "on_demand",
      homeNodeId: remote.nodeId,
      authorityNodeId: remote.nodeId,
      advertiseScope: "local",
    });

    await broker.postJson(authority.baseUrl, "/v1/conversations", sharedConversation);
    await broker.postJson(remote.baseUrl, "/v1/conversations", sharedConversation);

    await broker.postJson(remote.baseUrl, "/v1/messages", {
      id: "msg-remote-1",
      conversationId: sharedConversation.id,
      actorId: "remote-agent",
      originNodeId: remote.nodeId,
      class: "agent",
      body: "reply from remote authority forwarding",
      visibility: "workspace",
      policy: "durable",
      createdAt: Date.now(),
    });

    const authorityMessages = await broker.getJson<Array<{ id: string }>>(
      authority.baseUrl,
      `/v1/messages?conversationId=${encodeURIComponent(sharedConversation.id)}`,
    );
    expect(authorityMessages.some((message) => message.id === "msg-remote-1")).toBe(true);

    const remoteSnapshot = await broker.getJson<{ messages: Record<string, { id: string }> }>(
      remote.baseUrl,
      "/v1/snapshot",
    );
    expect(remoteSnapshot.messages["msg-remote-1"]).toBeUndefined();
  }, 40_000);

  test("keeps node-local scoutbot authority when syncing peer agents", async () => {
    const local = await broker.startBroker();
    const peer = await broker.startBroker();
    const scoutbotAgent = (authorityNodeId: string) => ({
      id: "scoutbot",
      kind: "agent",
      definitionId: "scoutbot",
      displayName: "Scout",
      handle: "scoutbot",
      labels: ["assistant", "scout", "scoutbot"],
      selector: "@scoutbot",
      defaultSelector: "@scoutbot",
      metadata: { source: "scoutbot" },
      agentClass: "operator",
      capabilities: ["chat", "invoke", "deliver"],
      wakePolicy: "keep_warm",
      homeNodeId: authorityNodeId,
      authorityNodeId,
      advertiseScope: "local",
    });

    await broker.postJson(local.baseUrl, "/v1/agents", scoutbotAgent(local.nodeId));
    await broker.postJson(peer.baseUrl, "/v1/agents", scoutbotAgent(peer.nodeId));
    await broker.postJson(local.baseUrl, "/v1/nodes", {
      id: peer.nodeId,
      meshId: "openscout",
      name: "Peer",
      advertiseScope: "mesh",
      brokerUrl: peer.baseUrl,
      registeredAt: Date.now(),
    });

    await broker.postJson(local.baseUrl, "/v1/mesh/discover", { seeds: [] });

    const snapshot = await broker.getJson<{
      agents: Record<string, { homeNodeId: string; authorityNodeId: string }>;
    }>(local.baseUrl, "/v1/snapshot");
    expect(snapshot.agents.scoutbot?.homeNodeId).toBe(local.nodeId);
    expect(snapshot.agents.scoutbot?.authorityNodeId).toBe(local.nodeId);
  }, 40_000);

  test("fails remote-authority message posts when the authority broker stalls", async () => {
    const harness = await broker.startBroker();
    const hangingBrokerUrl = broker.startHangingPeerServer();
    const authorityNodeId = "peer-authority";
    const conversationId = "dm.sender-air.target-mini";

    await broker.postJson(harness.baseUrl, "/v1/nodes", {
      id: authorityNodeId,
      meshId: "openscout",
      name: "Peer Authority",
      advertiseScope: "mesh",
      brokerUrl: hangingBrokerUrl,
      registeredAt: Date.now(),
    });

    await broker.postJson(harness.baseUrl, "/v1/agents", {
      id: "sender-air",
      kind: "agent",
      definitionId: "sender-air",
      displayName: "Sender Air",
      handle: "sender-air",
      labels: ["test"],
      selector: "@sender-air",
      defaultSelector: "@sender-air",
      metadata: { source: "test" },
      agentClass: "general",
      capabilities: ["chat"],
      wakePolicy: "on_demand",
      homeNodeId: harness.nodeId,
      authorityNodeId: harness.nodeId,
      advertiseScope: "local",
    });

    await broker.postJson(harness.baseUrl, "/v1/agents", {
      id: "target-mini",
      kind: "agent",
      definitionId: "target-mini",
      displayName: "Target Mini",
      handle: "target-mini",
      labels: ["test"],
      selector: "@target-mini",
      defaultSelector: "@target-mini",
      metadata: { source: "test" },
      agentClass: "general",
      capabilities: ["chat"],
      wakePolicy: "on_demand",
      homeNodeId: authorityNodeId,
      authorityNodeId,
      advertiseScope: "local",
    });

    await broker.postJson(harness.baseUrl, "/v1/conversations", {
      id: conversationId,
      kind: "direct",
      title: "sender-air <> target-mini",
      visibility: "private",
      shareMode: "shared",
      authorityNodeId,
      participantIds: ["sender-air", "target-mini"],
      metadata: { surface: "test" },
    });

    const startedAt = Date.now();
    const response = await fetch(`${harness.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: "msg-stalled-authority",
        conversationId,
        actorId: "sender-air",
        originNodeId: harness.nodeId,
        class: "agent",
        body: "stalled authority forward",
        visibility: "private",
        policy: "durable",
        createdAt: Date.now(),
      }),
      signal: AbortSignal.timeout(6_500),
    });

    expect(response.status).toBe(400);
    expect(Date.now() - startedAt).toBeLessThan(6_500);

    const body = await response.json() as { error?: string; detail?: string };
    expect(body.error).toBe("bad_request");
    expect(body.detail).toContain("peer broker unreachable");
  }, 10_000);

  test("rejects thread protocol requests on a non-authority broker", async () => {
    const authority = await broker.startBroker();
    const remote = await broker.startBroker();

    await broker.postJson(remote.baseUrl, "/v1/conversations", {
      id: "channel.shared.non-authority",
      kind: "channel",
      title: "shared non authority",
      visibility: "workspace",
      shareMode: "shared",
      authorityNodeId: authority.nodeId,
      participantIds: ["operator"],
      metadata: { surface: "test" },
    });

    const openResponse = await broker.requestJson(remote.baseUrl, "/v1/thread-watches/open", {
      method: "POST",
      body: JSON.stringify({
        conversationId: "channel.shared.non-authority",
        watcherNodeId: "node-subscriber",
        watcherId: "watch-not-authority",
      }),
    });
    expect(openResponse.status).toBe(409);
    expect((openResponse.body as { code?: string }).code).toBe("no_responder");

    const replayResponse = await broker.requestJson(
      remote.baseUrl,
      "/v1/conversations/channel.shared.non-authority/thread-events?afterSeq=0&limit=20",
    );
    expect(replayResponse.status).toBe(409);
    expect((replayResponse.body as { code?: string }).code).toBe("no_responder");
  }, 20_000);
});
