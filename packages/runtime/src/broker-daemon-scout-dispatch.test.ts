import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { namedChannelNaturalKey } from "@openscout/protocol";

import { createBrokerDaemonTestHarness } from "./test-helpers/broker-daemon-harness.test";

const broker = createBrokerDaemonTestHarness();

describe("broker daemon Scout dispatch", () => {
  test("routes ambiguous invocations through scout dispatch and posts a scout message", async () => {
    const harness = await broker.startBroker();
    await broker.seedBasicConversation(harness);

    const baseAgent = {
      kind: "agent" as const,
      definitionId: "scoutie",
      displayName: "Scoutie",
      labels: ["test"],
      selector: "@scoutie",
      defaultSelector: "@scoutie",
      agentClass: "general" as const,
      capabilities: ["chat", "invoke"] as const,
      wakePolicy: "on_demand" as const,
      homeNodeId: harness.nodeId,
      authorityNodeId: harness.nodeId,
      advertiseScope: "local" as const,
    };

    await broker.postJson(harness.baseUrl, "/v1/agents", {
      ...baseAgent,
      id: "scoutie.mini.main",
      handle: "scoutie.mini.main",
      metadata: {
        definitionId: "scoutie",
        workspaceQualifier: "main",
        nodeQualifier: "mini",
      },
    });

    await broker.postJson(harness.baseUrl, "/v1/agents", {
      ...baseAgent,
      id: "scoutie.main.mini",
      handle: "scoutie.main.mini",
      metadata: {
        definitionId: "scoutie",
        workspaceQualifier: "main",
        nodeQualifier: "mini",
      },
    });

    const response = await broker.postJson<{
      accepted: boolean;
      invocationId: string;
      dispatch?: {
        id: string;
        kind: string;
        askedLabel: string;
        candidates: Array<{ agentId: string }>;
      };
    }>(harness.baseUrl, "/v1/invocations", {
      id: "inv-scout-1",
      requesterId: "operator",
      requesterNodeId: harness.nodeId,
      targetAgentId: "scoutie",
      targetLabel: "@scoutie",
      action: "consult",
      task: "who are you?",
      conversationId: "channel.shared",
      ensureAwake: true,
      stream: false,
      createdAt: Date.now(),
    });

    expect(response.accepted).toBe(true);
    expect(response.dispatch?.kind).toBe("ambiguous");
    expect(response.dispatch?.askedLabel).toBe("@scoutie");
    expect(response.dispatch?.candidates.map((candidate) => candidate.agentId).sort()).toEqual([
      "scoutie.main.mini",
      "scoutie.mini.main",
    ]);

    const journal = readFileSync(join(harness.controlHome, "broker-journal.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as {
        kind: string;
        dispatch?: { id: string; kind: string; askedLabel: string };
        message?: { actorId: string; class: string; metadata?: { scoutDispatch?: { id: string } } };
      });

    const dispatchEntries = journal.filter((entry) => entry.kind === "scout.dispatch.record");
    expect(dispatchEntries).toHaveLength(1);
    expect(dispatchEntries[0].dispatch?.kind).toBe("ambiguous");
    expect(dispatchEntries[0].dispatch?.askedLabel).toBe("@scoutie");

    const scoutMessages = journal.filter(
      (entry) => entry.kind === "message.record" && entry.message?.actorId === "scout",
    );
    expect(scoutMessages).toHaveLength(1);
    expect(scoutMessages[0].message?.class).toBe("system");
    expect(scoutMessages[0].message?.metadata?.scoutDispatch?.id).toBe(dispatchEntries[0].dispatch?.id);
  }, 15_000);

  test("emits scout dispatch without a message when the invocation carries no conversation", async () => {
    const harness = await broker.startBroker();

    const response = await broker.postJson<{ accepted: boolean; dispatch?: { kind: string } }>(
      harness.baseUrl,
      "/v1/invocations",
      {
        id: "inv-scout-2",
        requesterId: "operator",
        requesterNodeId: harness.nodeId,
        targetAgentId: "@ghost-target",
        targetLabel: "@ghost-target",
        action: "consult",
        task: "knock knock",
        ensureAwake: true,
        stream: false,
        createdAt: Date.now(),
      },
    );

    expect(response.accepted).toBe(true);
    expect(response.dispatch?.kind).toBe("unknown");

    const journal = readFileSync(join(harness.controlHome, "broker-journal.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as {
        kind: string;
        message?: { actorId: string };
      });

    const dispatchEntries = journal.filter((entry) => entry.kind === "scout.dispatch.record");
    expect(dispatchEntries).toHaveLength(1);

    const scoutMessages = journal.filter(
      (entry) => entry.kind === "message.record" && entry.message?.actorId === "scout",
    );
    expect(scoutMessages).toHaveLength(0);
  }, 15_000);
});
