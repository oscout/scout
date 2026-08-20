import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { namedChannelNaturalKey } from "@openscout/protocol";

import { createBrokerDaemonTestHarness } from "./test-helpers/broker-daemon-harness.test";

const broker = createBrokerDaemonTestHarness();

describe("broker daemon managed sessions", () => {
  test("attaches and detaches pairing sessions as Scout-managed fleet identities", async () => {
    const pairing = broker.startPairingBridgeServer({
      sessions: [
        {
          id: "session-newell-1",
          name: "Majestic Newell",
          adapterType: "codex",
          status: "active",
          cwd: "/tmp/majestic",
          model: "gpt-5.4",
        },
      ],
    });
    const home = broker.configurePairingHome(pairing.port);
    const harness = await broker.startBroker({
      env: {
        HOME: home,
      },
    });

    const browse = await broker.getJson<Array<{
      externalSessionId: string;
      suggestedSelector: string;
    }>>(harness.baseUrl, "/v1/pairing/sessions");
    expect(browse).toHaveLength(1);
    expect(browse[0]?.externalSessionId).toBe("session-newell-1");

    const attached = await broker.postJson<{
      ok: boolean;
      agentId: string;
      selector: string;
      endpointId: string;
    }>(harness.baseUrl, "/v1/pairing/attach", {
      externalSessionId: "session-newell-1",
      alias: "@newell",
      displayName: "Newell",
    });
    expect(attached.ok).toBe(true);
    expect(attached.selector).toBe("@newell");

    const attachedSnapshot = await broker.getJson<{
      agents: Record<string, {
        id: string;
        displayName: string;
        selector?: string;
        metadata?: Record<string, unknown>;
      }>;
      endpoints: Record<string, {
        id: string;
        state: string;
        sessionId?: string;
        metadata?: Record<string, unknown>;
      }>;
    }>(harness.baseUrl, "/v1/snapshot");

    expect(attachedSnapshot.agents[attached.agentId]?.displayName).toBe("Newell");
    expect(attachedSnapshot.agents[attached.agentId]?.selector).toBe("@newell");
    expect(attachedSnapshot.agents[attached.agentId]?.metadata?.source).toBe("scout-managed");
    expect(attachedSnapshot.endpoints[attached.endpointId]?.sessionId).toBe("session-newell-1");
    expect(attachedSnapshot.endpoints[attached.endpointId]?.metadata?.managedByScout).toBe(true);

    const detached = await broker.postJson<{
      ok: boolean;
      agentId: string;
      endpointId: string;
      detached: boolean;
    }>(harness.baseUrl, "/v1/pairing/detach", {
      agentId: attached.agentId,
    });
    expect(detached.ok).toBe(true);
    expect(detached.detached).toBe(true);

    const detachedSnapshot = await broker.getJson<{
      agents: Record<string, {
        id: string;
        selector?: string;
      }>;
      endpoints: Record<string, {
        id: string;
        state: string;
        sessionId?: string;
      }>;
    }>(harness.baseUrl, "/v1/snapshot");

    expect(detachedSnapshot.agents[attached.agentId]?.selector).toBe("@newell");
    expect(detachedSnapshot.endpoints[attached.endpointId]?.state).toBe("offline");
    expect(detachedSnapshot.endpoints[attached.endpointId]?.sessionId).toBeUndefined();
  }, 15_000);

  test("attaches Codex local sessions as bridge-backed managed identities", async () => {
    const pairing = broker.startPairingBridgeServer({
      sessions: [],
    });
    const home = broker.configurePairingHome(pairing.port);
    const harness = await broker.startBroker({
      env: {
        HOME: home,
      },
    });

    const attached = await broker.postJson<{
      ok: boolean;
      agentId: string;
      selector: string;
      endpointId: string;
      sessionId: string;
    }>(harness.baseUrl, "/v1/local-sessions/attach", {
      externalSessionId: "019d9762-19f7-7792-8962-90d924ce7faa",
      transport: "codex_app_server",
      cwd: "/tmp/codex-here",
      alias: "@codex-here",
      displayName: "Codex Here",
    });

    expect(attached.ok).toBe(true);
    expect(attached.selector).toBe("@codex-here");
    expect(attached.sessionId).toBe("pairing-019d9762");

    const snapshot = await broker.getJson<{
      agents: Record<string, {
        id: string;
        displayName: string;
        selector?: string;
        metadata?: Record<string, unknown>;
      }>;
      endpoints: Record<string, {
        id: string;
        transport: string;
        state: string;
        sessionId?: string;
        metadata?: Record<string, unknown>;
      }>;
    }>(harness.baseUrl, "/v1/snapshot");

    expect(snapshot.agents[attached.agentId]?.displayName).toBe("Codex Here");
    expect(snapshot.agents[attached.agentId]?.selector).toBe("@codex-here");
    expect(snapshot.agents[attached.agentId]?.metadata?.externalSource).toBe("local-session");
    expect(snapshot.endpoints[attached.endpointId]?.transport).toBe("pairing_bridge");
    expect(snapshot.endpoints[attached.endpointId]?.sessionId).toBe("pairing-019d9762");
    expect(snapshot.endpoints[attached.endpointId]?.metadata?.source).toBe("local-session");
    expect(snapshot.endpoints[attached.endpointId]?.metadata?.externalSessionId).toBe("019d9762-19f7-7792-8962-90d924ce7faa");
    expect(snapshot.endpoints[attached.endpointId]?.metadata?.pairingSessionId).toBe("pairing-019d9762");
    expect(snapshot.endpoints[attached.endpointId]?.metadata?.threadId).toBe("019d9762-19f7-7792-8962-90d924ce7faa");

    const detached = await broker.postJson<{
      ok: boolean;
      agentId: string;
      endpointId: string;
      detached: boolean;
    }>(harness.baseUrl, "/v1/local-sessions/detach", {
      alias: "@codex-here",
    });

    expect(detached).toEqual({
      ok: true,
      agentId: attached.agentId,
      endpointId: attached.endpointId,
      detached: true,
    });

    const detachedSnapshot = await broker.getJson<{
      agents: Record<string, {
        id: string;
        selector?: string;
      }>;
      endpoints: Record<string, {
        id: string;
        state: string;
        metadata?: Record<string, unknown>;
      }>;
    }>(harness.baseUrl, "/v1/snapshot");
    expect(detachedSnapshot.agents[attached.agentId]?.selector).toBe("@codex-here");
    expect(detachedSnapshot.endpoints[attached.endpointId]?.state).toBe("offline");
    expect(detachedSnapshot.endpoints[attached.endpointId]?.metadata).toEqual(expect.objectContaining({
      lastError: "local session detached",
      lastFailedAt: expect.any(Number),
    }));
  }, 15_000);

  test("dispatches to an attached Codex local session instead of queueing when it is ready", async () => {
    const pairing = broker.startPairingBridgeServer({
      sessions: [],
    });
    const home = broker.configurePairingHome(pairing.port);
    const harness = await broker.startBroker({
      env: {
        HOME: home,
      },
    });

    const attached = await broker.postJson<{
      ok: boolean;
      agentId: string;
      selector: string;
      endpointId: string;
    }>(harness.baseUrl, "/v1/local-sessions/attach", {
      externalSessionId: "019d9762-19f7-7792-8962-90d924ce7fbb",
      transport: "codex_app_server",
      cwd: "/tmp/codex-ready",
      alias: "@codex-ready",
      displayName: "Codex Ready",
    });
    expect(attached.ok).toBe(true);

    const delivered = await broker.postJson<{
      kind: string;
      accepted: boolean;
      flight?: { id: string; targetAgentId: string };
      receipt?: { targetAgentId?: string; targetLabel?: string; flightId?: string };
    }>(harness.baseUrl, "/v1/deliver", {
      id: "deliver-codex-ready-session",
      caller: {
        actorId: "operator",
        nodeId: harness.nodeId,
      },
      target: {
        kind: "agent_label",
        label: "@codex-ready",
      },
      body: "Reply from the attached ready session.",
      intent: "consult",
      createdAt: Date.now(),
    });

    expect(delivered.kind).toBe("delivery");
    expect(delivered.accepted).toBe(true);
    expect(delivered.flight?.targetAgentId).toBe(attached.agentId);
    expect(delivered.receipt?.targetLabel).toBe("@codex-ready");

    const completed = await broker.waitFor(
      () => broker.getJson<{
        flights: Record<string, {
          state: string;
          output?: string;
          summary?: string;
          metadata?: Record<string, unknown>;
        }>;
      }>(harness.baseUrl, "/v1/snapshot"),
      (snapshot) => snapshot.flights[delivered.flight?.id ?? ""]?.state === "completed",
    );
    const flight = completed.flights[delivered.flight!.id];

    expect(flight?.summary).toBe("Codex Ready replied.");
    expect(flight?.output).toContain("Pairing reply:");
    expect(flight?.metadata?.dispatchAck).toEqual(expect.objectContaining({
      endpointId: attached.endpointId,
      transport: "pairing_bridge",
      strategy: "attach",
    }));
    expect(flight?.metadata?.dispatchOutcome).toBeUndefined();
  }, 15_000);
});
