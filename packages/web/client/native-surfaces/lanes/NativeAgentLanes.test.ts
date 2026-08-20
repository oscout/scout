import { describe, expect, test } from "bun:test";

import type {
  FleetAgentSnapshot,
  FleetObserveSnapshot,
  FleetTailSnapshot,
  SurfaceBootstrap,
} from "../../surface-contract/scout-surface-contract.ts";
import { buildAgentLanes } from "../../screens/ops/agent-lanes-model.ts";
import { buildNativeLaneSnapshot } from "./native-agent-lanes-data.ts";

const bootstrap: Partial<SurfaceBootstrap> = {
  hosts: [
    { id: "host_a", name: "Studio", state: "connected" },
    { id: "host_b", name: "Build", state: "connected" },
  ],
  selectedHostIds: ["host_a", "host_b"],
};

const agents: FleetAgentSnapshot = {
  hosts: ["host_a", "host_b"].map((hostId) => ({
    hostId,
    ready: true as const,
    value: {
      cursor: { epoch: `${hostId}:1`, sequence: 1, connectionRevision: 1 },
      agents: [{
        id: "agent-shared",
        name: "Codex",
        handle: "codex",
        harness: "codex",
        model: "gpt-5",
        state: "working",
        projectRoot: "/project",
        conversationId: "conversation-shared",
        sessionId: "session-shared",
        updatedAt: 1_784_665_200_000,
      }],
    },
  })),
};

const tail: FleetTailSnapshot = {
  hosts: ["host_a", "host_b"].map((hostId) => ({
    hostId,
    ready: true as const,
    value: {
      cursor: { epoch: `${hostId}:2`, sequence: 2, connectionRevision: 1 },
      nextCursor: null,
      events: [{
        id: "event-shared",
        at: 1_784_665_200_000,
        agentId: "agent-shared",
        sessionId: "conversation-shared",
        kind: "assistant",
        text: "Working",
      }],
    },
  })),
};

const observe: FleetObserveSnapshot = {
  hosts: [{
    hostId: "host_a",
    ready: true,
    value: {
      cursor: { epoch: "host_a:3", sequence: 3, connectionRevision: 1 },
      agents: [{
        agentId: "agent-shared",
        source: "live",
        fidelity: "timestamped",
        sessionId: "conversation-shared",
        updatedAt: 1_784_665_200_000,
        events: [{
          id: "observe-shared",
          at: 1_784_665_200_000,
          kind: "message",
          text: "Working",
        }],
      }],
    },
  }],
};

describe("native agent lanes fleet projection", () => {
  test("namespaces colliding agent, session, event, and observe identities by host", () => {
    const snapshot = buildNativeLaneSnapshot(agents, tail, observe, bootstrap);

    expect(snapshot.agents.map((agent) => agent.id)).toEqual([
      "host_a::agent::agent-shared",
      "host_b::agent::agent-shared",
    ]);
    expect(snapshot.tailEvents.map((event) => event.id)).toEqual([
      "host_a::event-shared",
      "host_b::event-shared",
    ]);
    expect(new Set(snapshot.tailEvents.map((event) => event.sessionId)).size).toBe(2);
    expect(snapshot.observeCache["host_a::agent::agent-shared"]?.data.events[0]?.id)
      .toBe("host_a::observe-shared");
  });

  test("does not turn registry presence into synthetic lane activity", () => {
    const updatedAt = 1_784_665_200_000;
    const sharedSessionAgents: FleetAgentSnapshot = {
      hosts: [{
        hostId: "host_a",
        ready: true,
        value: {
          cursor: { epoch: "host_a:1", sequence: 2, connectionRevision: 1 },
          agents: ["alpha", "beta"].map((id) => ({
            id,
            name: id,
            handle: null,
            harness: "codex",
            model: null,
            state: "working",
            projectRoot: "/project",
            conversationId: null,
            sessionId: "shared-project-session",
            updatedAt,
          })),
        },
      }],
    };

    const snapshot = buildNativeLaneSnapshot(sharedSessionAgents, null, null, bootstrap);
    expect(snapshot.discovery.transcripts).toEqual([]);
    expect(snapshot.agents).toEqual([]);

    const built = buildAgentLanes({
      transcripts: snapshot.discovery.transcripts,
      tailEvents: [],
      scoutAgents: snapshot.agents,
      observeCache: snapshot.observeCache,
      now: updatedAt,
      workingOnly: true,
      horizon: "30m",
    });
    expect(built.lanes).toEqual([]);
    expect(built.issues).toEqual([]);
  });
});
