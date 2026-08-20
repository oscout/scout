import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { namedChannelNaturalKey } from "@openscout/protocol";

import { createBrokerDaemonTestHarness } from "./test-helpers/broker-daemon-harness.test";

const broker = createBrokerDaemonTestHarness();

describe("broker daemon durability routes", () => {
  test("keeps route-alias authority stable when the live hostname suffix changes", async () => {
    const controlHome = mkdtempSync(join(tmpdir(), "openscout-stable-authority-test-"));
    const projectRoot = "/work/studio";
    const first = await broker.startBroker({
      controlHome,
      env: {
        OPENSCOUT_NODE_ID: undefined,
        OPENSCOUT_NODE_NAME: "Dev-Mac-mini-372.local",
      },
    });
    expect(first.nodeId).toBe("dev-mac-mini-372-local-openscout");

    const studioAgentId = "studio.main.dev-mac-mini-372-local";
    await broker.postJson(first.baseUrl, "/v1/agents", {
      id: studioAgentId,
      definitionId: "studio",
      displayName: "Studio",
      handle: "studio",
      selector: "@studio",
      defaultSelector: "@studio",
      metadata: { projectRoot },
      agentClass: "general",
      capabilities: ["chat", "invoke"],
      wakePolicy: "on_demand",
      homeNodeId: first.nodeId,
      authorityNodeId: first.nodeId,
      advertiseScope: "local",
    });
    await broker.postJson(first.baseUrl, "/v1/aliases", {
      alias: "studio-agent",
      target: { kind: "agent_id", agentId: studioAgentId },
      scope: { projectRoot },
      caller: { actorId: "operator", currentDirectory: projectRoot },
    });

    first.child.kill();
    await first.child.exited.catch(() => {});
    broker.harnesses.delete(first);

    const restarted = await broker.startBroker({
      controlHome,
      env: {
        OPENSCOUT_NODE_ID: undefined,
        OPENSCOUT_NODE_NAME: "Dev-Mac-mini-419.local",
      },
    });
    expect(restarted.nodeId).toBe(first.nodeId);

    const resolved = await broker.postJson<{
      resolved: boolean;
      binding?: { scopeNodeId: string; target: { agentId?: string } };
    }>(restarted.baseUrl, "/v1/aliases/resolve", {
      alias: "studio-agent",
      scope: { projectRoot },
      caller: { actorId: "operator", currentDirectory: projectRoot },
    });
    expect(resolved.resolved).toBe(true);
    expect(resolved.binding?.scopeNodeId).toBe(first.nodeId);
    expect(resolved.binding?.target.agentId).toBe(studioAgentId);
  }, 20_000);

  test("journals durable action heartbeats through the HTTP surface", async () => {
    const harness = await broker.startBroker();
    const initialAction = {
      id: "action-heartbeat-1",
      kind: "message_delivery",
      subjectId: "delivery-1",
      authorityCellId: "node-1",
      state: "leased",
      leaseOwner: "worker-a",
      leaseGeneration: 1,
      leaseExpiresAt: 1_000,
      createdAt: 100,
      updatedAt: 100,
    };
    await broker.postJson(harness.baseUrl, "/v1/nodes", {
      id: "node-1",
      meshId: "openscout",
      name: "Node 1",
      advertiseScope: "local",
      registeredAt: 1,
    });
    await broker.postJson(harness.baseUrl, "/v1/durable-actions", initialAction);

    const result = await broker.postJson<{
      ok: boolean;
      actionId: string;
      leaseOwner: string;
      leaseGeneration: number;
      leaseExpiresAt: number;
    }>(
      harness.baseUrl,
      "/v1/durable-actions/action-heartbeat-1/heartbeat",
      {
        owner: "worker-a",
        generation: 1,
        leaseMs: 5_000,
        heartbeatAt: 2_000,
      },
    );

    expect(result).toMatchObject({
      ok: true,
      actionId: "action-heartbeat-1",
      leaseOwner: "worker-a",
      leaseGeneration: 1,
      leaseExpiresAt: 7_000,
    });
    expect(readFileSync(join(harness.controlHome, "broker-journal.jsonl"), "utf8"))
      .toContain('"kind":"durable.action.heartbeat"');

    const stale = await broker.postJsonStatus(
      harness.baseUrl,
      "/v1/durable-actions/action-heartbeat-1/heartbeat",
      {
        owner: "worker-b",
        generation: 1,
        leaseMs: 5_000,
        heartbeatAt: 3_000,
      },
    );
    expect(stale.status).toBe(409);

    const missing = await broker.postJsonStatus(
      harness.baseUrl,
      "/v1/durable-actions/action-missing/heartbeat",
      {
        owner: "worker-a",
        generation: 1,
        leaseMs: 5_000,
        heartbeatAt: 3_000,
      },
    );
    expect(missing.status).toBe(404);

  }, 15_000);

  test("rebuilds the sqlite projection from the file journal after degraded writes", async () => {
    const controlHome = mkdtempSync(join(tmpdir(), "openscout-runtime-test-"));
    const degradedHarness = await broker.startBroker({
      controlHome,
      env: {
        OPENSCOUT_DISABLE_SQLITE: "1",
      },
    });
    await broker.seedBasicConversation(degradedHarness);

    await broker.postJson(degradedHarness.baseUrl, "/v1/messages", {
      id: "msg-journal-replay-1",
      conversationId: "channel.shared",
      actorId: "operator",
      originNodeId: degradedHarness.nodeId,
      class: "agent",
      body: "@fabric recover projection",
      mentions: [{ actorId: "fabric", label: "@fabric" }],
      audience: {
        notify: ["fabric"],
      },
      visibility: "workspace",
      policy: "durable",
      createdAt: Date.now(),
    });

    degradedHarness.child.kill();
    await degradedHarness.child.exited.catch(() => {});
    broker.harnesses.delete(degradedHarness);

    const recoveredHarness = await broker.startBroker({ controlHome });
    const activity = await broker.waitFor(
      async () => broker.getJson<Array<{ messageId?: string }>>(recoveredHarness.baseUrl, "/v1/activity?limit=20"),
      (items) => items.some((item) => item.messageId === "msg-journal-replay-1"),
    );

    expect(activity.some((item) => item.messageId === "msg-journal-replay-1")).toBe(true);
  }, 15_000);

  test("skips redundant durable agent upserts", async () => {
    const harness = await broker.startBroker();

    const agent = {
      id: "agent-dedupe",
      kind: "agent" as const,
      definitionId: "agent-dedupe",
      displayName: "Agent Dedupe",
      handle: "agent-dedupe",
      agentClass: "builder" as const,
      capabilities: ["chat"] as const,
      wakePolicy: "on_demand" as const,
      homeNodeId: harness.nodeId,
      authorityNodeId: harness.nodeId,
      advertiseScope: "local" as const,
      metadata: {
        workspace: "/tmp/agent-dedupe",
      },
    };

    await broker.postJson(harness.baseUrl, "/v1/agents", agent);
    await broker.postJson(harness.baseUrl, "/v1/agents", agent);

    const lines = readFileSync(join(harness.controlHome, "broker-journal.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { kind: string; actor?: { id?: string }; agent?: { id?: string } });

    expect(lines.filter((entry) => entry.kind === "actor.upsert" && entry.actor?.id === agent.id)).toHaveLength(1);
    expect(lines.filter((entry) => entry.kind === "agent.upsert" && entry.agent?.id === agent.id)).toHaveLength(1);
  }, 15_000);
});
