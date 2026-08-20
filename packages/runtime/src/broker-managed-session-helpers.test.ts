import { describe, expect, test } from "bun:test";

import type {
  AgentDefinition,
  AgentEndpoint,
} from "@openscout/protocol";

import { createInMemoryControlRuntime } from "./broker.js";
import {
  buildManagedLocalSessionAgent,
  buildManagedLocalSessionEndpointBinding,
  buildManagedLocalSessionPairingEndpointBinding,
  buildManagedPairingAgent,
  isGeneratedLocalAgentMetadata,
  isLegacyPairingSessionMetadata,
  isManagedLocalSessionMetadata,
  isManagedPairingSessionMetadata,
  legacyPairingEndpoints,
  managedLocalSessionDefaultDisplayName,
  managedLocalSessionEndpointForAgent,
  managedPairingEndpointForAgent,
  managedPairingEndpoints,
  normalizeManagedAgentSelector,
  pairingExternalSessionId,
  resolveManagedSessionAttachTarget,
  sameSerializedRecord,
  suggestedManagedLocalSessionSelector,
  uniqueManagedAgentSelector,
  updateManagedSessionAgent,
} from "./broker-managed-session-helpers.js";
import type { PairingSession } from "./pairing-session-agents.js";

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
    wakePolicy: "manual",
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
    transport: "pairing_bridge",
    state: "idle",
    metadata: {},
    ...input,
  };
}

function testPairingSession(input: Partial<PairingSession> = {}): PairingSession {
  return {
    id: "session-1",
    name: "Codex Repo",
    adapterType: "codex",
    status: "idle",
    cwd: "/tmp/repo",
    model: "gpt-5",
    providerMeta: { provider: "openai" },
    ...input,
  };
}

describe("broker managed session helpers", () => {
  test("classifies managed local, pairing, legacy, and generated metadata", () => {
    expect(isGeneratedLocalAgentMetadata({ source: "relay-agent-registry" })).toBe(true);
    expect(isGeneratedLocalAgentMetadata({ source: "project-inferred" })).toBe(true);
    expect(isGeneratedLocalAgentMetadata({ source: "local-session" })).toBe(false);

    expect(isManagedPairingSessionMetadata({ source: "pairing-session", managedByScout: true })).toBe(true);
    expect(isManagedPairingSessionMetadata({ source: "pairing-session" })).toBe(false);
    expect(isLegacyPairingSessionMetadata({ source: "pairing-session" })).toBe(true);
    expect(isLegacyPairingSessionMetadata({ source: "pairing-session", managedByScout: true })).toBe(false);

    expect(isManagedLocalSessionMetadata({ source: "local-session", managedByScout: true })).toBe(true);
    expect(isManagedLocalSessionMetadata({ source: "local-session" })).toBe(false);
  });

  test("normalizes requested selectors and allocates unique aliases against the snapshot", () => {
    const runtime = createInMemoryControlRuntime({
      agents: {
        "agent-1": testAgent({
          id: "agent-1",
          selector: "@codex-repo",
          defaultSelector: "@codex-repo",
          handle: "codex-repo",
        }),
      },
    }, { localNodeId: "node-1" });

    expect(normalizeManagedAgentSelector(" @@My Agent!! ")).toBe("@my-agent");
    expect(() => normalizeManagedAgentSelector("!!!")).toThrow("Alias must contain at least one alphanumeric character.");
    expect(uniqueManagedAgentSelector(runtime.snapshot(), "@codex-repo", {
      nodeId: "node-1",
      isInactiveLocalAgent: () => false,
    })).toBe("@codex-repo-2");
    expect(uniqueManagedAgentSelector(runtime.snapshot(), "@codex-repo", {
      nodeId: "node-1",
      isInactiveLocalAgent: () => false,
      currentAgentId: "agent-1",
    })).toBe("@codex-repo");
    expect(uniqueManagedAgentSelector(runtime.snapshot(), "@codex-repo", {
      nodeId: "node-1",
      isInactiveLocalAgent: (agent) => agent?.id === "agent-1",
    })).toBe("@codex-repo");
  });

  test("builds and updates managed pairing agents without daemon globals", () => {
    const agent = buildManagedPairingAgent({
      session: testPairingSession(),
      selector: "@codex-repo",
      nodeId: "node-1",
      createId: () => "pairing-agent-1",
    });

    expect(agent).toEqual(expect.objectContaining({
      id: "pairing-agent-1",
      displayName: "Codex Repo",
      handle: "codex-repo",
      selector: "@codex-repo",
      homeNodeId: "node-1",
      authorityNodeId: "node-1",
      capabilities: ["chat", "invoke", "deliver"],
      metadata: expect.objectContaining({
        source: "scout-managed",
        externalSource: "pairing-session",
        managedByScout: true,
        selector: "@codex-repo",
        sessionBacked: true,
      }),
    }));

    expect(updateManagedSessionAgent(agent, {
      selector: "@codex-repo-2",
      displayName: "Repo Pairing",
    })).toEqual(expect.objectContaining({
      displayName: "Repo Pairing",
      handle: "codex-repo-2",
      selector: "@codex-repo-2",
      defaultSelector: "@codex-repo-2",
      metadata: expect.objectContaining({
        selector: "@codex-repo-2",
        defaultSelector: "@codex-repo-2",
        managedByScout: true,
        sessionBacked: true,
      }),
    }));
  });

  test("builds managed local-session agents and direct endpoint bindings", () => {
    const agent = buildManagedLocalSessionAgent({
      transport: "codex_app_server",
      selector: "@codex-repo",
      cwd: "/tmp/repo",
      projectRoot: "/tmp/repo",
      nodeId: "node-1",
      createId: () => "local-session-agent-1",
    });

    expect(managedLocalSessionDefaultDisplayName({
      transport: "codex_app_server",
      cwd: "/tmp/repo",
    })).toBe("Codex (repo)");
    expect(suggestedManagedLocalSessionSelector({
      transport: "claude_stream_json",
      cwd: "/tmp/My Repo",
    })).toBe("@claude-my-repo");
    expect(agent).toEqual(expect.objectContaining({
      id: "local-session-agent-1",
      displayName: "Codex (repo)",
      labels: ["local-session", "managed", "codex_app_server"],
      metadata: expect.objectContaining({
        source: "scout-managed",
        externalSource: "local-session",
        attachedTransport: "codex_app_server",
      }),
    }));

    const endpoint = buildManagedLocalSessionEndpointBinding({
      agentId: agent.id,
      transport: "codex_app_server",
      harness: "codex",
      sessionId: "thread-1",
      cwd: "/tmp/repo/worktree",
      projectRoot: "/tmp/repo",
      selector: agent.selector,
      nodeId: "node-1",
    });

    expect(endpoint).toEqual(expect.objectContaining({
      id: "endpoint.local-session-agent-1.node-1.codex_app_server",
      agentId: "local-session-agent-1",
      nodeId: "node-1",
      harness: "codex",
      transport: "codex_app_server",
      state: "idle",
      cwd: "/tmp/repo/worktree",
      projectRoot: "/tmp/repo",
      sessionId: "thread-1",
      metadata: expect.objectContaining({
        source: "local-session",
        managedByScout: true,
        threadId: "thread-1",
        externalSessionId: "thread-1",
        runtimeInstanceId: "attached-local-session-agent-1",
        project: "repo",
      }),
    }));
  });

  test("builds pairing-backed local-session endpoints with local-session metadata", () => {
    const endpoint = buildManagedLocalSessionPairingEndpointBinding({
      agentId: "agent-1",
      transport: "codex_app_server",
      threadId: "thread-1",
      session: testPairingSession({ id: "pairing-1" }),
      cwd: "/tmp/repo/worktree",
      projectRoot: "/tmp/repo",
      selector: "@codex-repo",
      definitionId: "codex-repo",
      nodeId: "node-1",
    });

    expect(endpoint).toEqual(expect.objectContaining({
      id: "endpoint.agent-1.node-1.pairing",
      transport: "pairing_bridge",
      sessionId: "pairing-1",
      cwd: "/tmp/repo/worktree",
      projectRoot: "/tmp/repo",
      metadata: expect.objectContaining({
        source: "local-session",
        managedByScout: true,
        externalSource: "local-session",
        attachedTransport: "codex_app_server",
        threadId: "thread-1",
        externalSessionId: "thread-1",
        pairingSessionId: "pairing-1",
        pairingAdapterType: "codex",
      }),
    }));
  });

  test("finds managed endpoints and extracts external pairing session ids", () => {
    const managedPairing = testEndpoint({
      id: "managed-pairing",
      agentId: "agent-1",
      nodeId: "node-1",
      transport: "pairing_bridge",
      sessionId: "session-direct",
      metadata: { source: "pairing-session", managedByScout: true },
    });
    const legacyPairing = testEndpoint({
      id: "legacy-pairing",
      agentId: "agent-2",
      nodeId: "node-1",
      transport: "pairing_bridge",
      metadata: { source: "pairing-session", externalSessionId: "legacy-external" },
    });
    const localSession = testEndpoint({
      id: "local-session",
      agentId: "agent-3",
      nodeId: "node-1",
      transport: "pairing_bridge",
      metadata: { source: "local-session", managedByScout: true, externalSessionId: "thread-1" },
    });
    const runtime = createInMemoryControlRuntime({
      endpoints: {
        [managedPairing.id]: managedPairing,
        [legacyPairing.id]: legacyPairing,
        [localSession.id]: localSession,
      },
    }, { localNodeId: "node-1" });
    const snapshot = runtime.snapshot();

    expect(managedPairingEndpointForAgent(snapshot, "agent-1")).toEqual(managedPairing);
    expect(managedPairingEndpoints(snapshot, "node-1")).toEqual([managedPairing]);
    expect(legacyPairingEndpoints(snapshot, "node-1")).toEqual([legacyPairing]);
    expect(managedLocalSessionEndpointForAgent(snapshot, "agent-3", "node-1")).toEqual(localSession);
    expect(pairingExternalSessionId(managedPairing)).toBe("session-direct");
    expect(pairingExternalSessionId(legacyPairing)).toBe("legacy-external");
  });

  test("resolves attach targets by direct agent id or alias and rejects ownership conflicts", () => {
    const runtime = createInMemoryControlRuntime({
      agents: {
        "agent-1": testAgent({
          id: "agent-1",
          selector: "@codex-repo",
          defaultSelector: "@codex-repo",
          handle: "codex-repo",
        }),
        "remote-agent": testAgent({
          id: "remote-agent",
          selector: "@remote",
          defaultSelector: "@remote",
          handle: "remote",
          authorityNodeId: "node-2",
        }),
      },
    }, { localNodeId: "node-1" });
    const snapshot = runtime.snapshot();
    const options = {
      nodeId: "node-1",
      isInactiveLocalAgent: () => false,
    };

    expect(resolveManagedSessionAttachTarget(snapshot, { selector: "@codex-repo" }, options)?.id).toBe("agent-1");
    expect(resolveManagedSessionAttachTarget(snapshot, { agentId: "agent-1" }, options)?.id).toBe("agent-1");
    expect(resolveManagedSessionAttachTarget(snapshot, { selector: "@missing" }, options)).toBeNull();
    expect(() => resolveManagedSessionAttachTarget(snapshot, { selector: "@remote" }, options))
      .toThrow("alias @remote is owned by node-2, not node-1");
    expect(() => resolveManagedSessionAttachTarget(snapshot, {
      agentId: "agent-1",
      selector: "@remote",
    }, options)).toThrow("alias @remote is owned by node-2, not node-1");
  });

  test("compares serialized records for no-op persistence checks", () => {
    expect(sameSerializedRecord({ id: "one" }, { id: "one" })).toBe(true);
    expect(sameSerializedRecord({ id: "one" }, { id: "two" })).toBe(false);
    expect(sameSerializedRecord(undefined, { id: "one" })).toBe(false);
  });
});
