import { describe, expect, test } from "bun:test";

import type {
  AgentDefinition,
  AgentEndpoint,
} from "@openscout/protocol";

import {
  compareLocalEndpointPreference,
  endpointAvailabilityScore,
  endpointCandidateState,
  endpointMatchesTargetSession,
  endpointSessionAliasValues,
  homeEndpointForAgent,
  isInactiveLocalAgent,
  isStaleLocalEndpoint,
  latestEndpointForAgent,
  localEndpointPreferenceRank,
} from "./broker-endpoint-selection.js";
import { createRuntimeRegistrySnapshot } from "./registry.js";

function agent(input: Partial<AgentDefinition> = {}): AgentDefinition {
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

function endpoint(input: Partial<AgentEndpoint> = {}): AgentEndpoint {
  return {
    id: "endpoint-1",
    agentId: "agent-1",
    nodeId: "node-1",
    harness: "codex",
    transport: "codex_app_server",
    state: "idle",
    sessionId: "session-1",
    metadata: {},
    ...input,
  };
}

describe("broker endpoint selection", () => {
  test("classifies endpoint candidate states and availability scores", () => {
    expect(endpointCandidateState("active")).toBe("online");
    expect(endpointCandidateState("idle")).toBe("online");
    expect(endpointCandidateState("waiting")).toBe("online");
    expect(endpointCandidateState("offline")).toBe("offline");
    expect(endpointCandidateState(undefined)).toBe("unknown");
    expect(endpointAvailabilityScore(endpoint({ state: "active" }))).toBeGreaterThan(
      endpointAvailabilityScore(endpoint({ state: "idle" })),
    );
    expect(endpointAvailabilityScore(endpoint({ state: "idle" }))).toBeGreaterThan(
      endpointAvailabilityScore(endpoint({ state: "waiting" })),
    );
    expect(endpointAvailabilityScore(endpoint({ state: "waiting" }))).toBeGreaterThan(
      endpointAvailabilityScore(endpoint({ state: "offline" })),
    );
  });

  test("shares session aliases across route resolution and execution selection", () => {
    const target = endpoint({
      id: "endpoint-codex",
      sessionId: "session-direct",
      metadata: {
        externalSessionId: "external-1",
        threadId: "thread-1",
        runtimeSessionId: "runtime-1",
        runtimeInstanceId: "instance-1",
        tmuxSession: "tmux-1",
        pairingSessionId: "pairing-1",
      },
    });

    expect(endpointSessionAliasValues(target)).toEqual([
      "endpoint-codex",
      "session-direct",
      "external-1",
      "thread-1",
      "runtime-1",
      "instance-1",
      "tmux-1",
      "pairing-1",
    ]);
    expect(endpointMatchesTargetSession(target, "thread-1")).toBe(true);
    expect(endpointMatchesTargetSession(target, " missing ")).toBe(false);
    expect(endpointMatchesTargetSession(target, "   ")).toBe(false);
  });

  test("selects home and latest endpoints while excluding stale registrations", () => {
    const snapshot = createRuntimeRegistrySnapshot({
      agents: {
        "agent-1": agent(),
        stale: agent({ id: "stale", metadata: { staleLocalRegistration: true } }),
      },
      endpoints: {
        active: endpoint({ id: "active", state: "active", metadata: { lastStartedAt: 5_000 } }),
        idle: endpoint({ id: "idle", state: "idle", metadata: { lastStartedAt: 10_000 } }),
        stale: endpoint({
          id: "stale",
          agentId: "agent-1",
          state: "active",
          metadata: { staleLocalRegistration: true, replacedByAgentId: "agent-2", lastStartedAt: 20_000 },
        }),
        "stale-agent-endpoint": endpoint({ id: "stale-agent-endpoint", agentId: "stale" }),
      },
    });

    expect(homeEndpointForAgent(snapshot, "agent-1")?.id).toBe("active");
    expect(latestEndpointForAgent(snapshot, "agent-1")?.id).toBe("stale");
    expect(isInactiveLocalAgent(snapshot.agents.stale)).toBe(true);
    expect(isStaleLocalEndpoint(snapshot, snapshot.endpoints["stale-agent-endpoint"])).toBe(true);
  });

  test("keeps local execution preference separate from display availability", () => {
    const tmux = endpoint({ id: "tmux", transport: "tmux" });
    const codexOld = endpoint({
      id: "codex-old",
      transport: "codex_app_server",
      metadata: { lastStartedAt: 1_000 },
    });
    const codexNew = endpoint({
      id: "codex-new",
      transport: "codex_app_server",
      metadata: { lastStartedAt: 2_000 },
    });
    const claude = endpoint({ id: "claude", transport: "claude_stream_json" });

    expect(localEndpointPreferenceRank(tmux)).toBeLessThan(localEndpointPreferenceRank(codexOld));
    expect(localEndpointPreferenceRank(claude)).toBeGreaterThan(localEndpointPreferenceRank(codexOld));
    expect([claude, codexOld, codexNew, tmux].sort(compareLocalEndpointPreference).map((candidate) => candidate.id))
      .toEqual(["tmux", "codex-new", "codex-old", "claude"]);
  });
});
