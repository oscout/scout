import { describe, expect, test } from "bun:test";
import type { AgentEndpoint, CollaborationRecord, FlightRecord } from "@openscout/protocol";

import { createRuntimeRegistrySnapshot } from "./registry.js";
import { idleCardlessSessionExpiryCandidates } from "./broker-cardless-session-reaper.js";

const NOW = 2_000_000;
const TTL = 60_000;

function endpoint(overrides: Partial<AgentEndpoint> = {}): AgentEndpoint {
  return {
    id: "endpoint.session-old.node-1.tmux",
    agentId: "session-old",
    nodeId: "node-1",
    transport: "tmux",
    harness: "claude",
    state: "idle",
    sessionId: "session-old",
    metadata: {
      source: "scout-cardless-session",
      cardless: true,
      startedAt: NOW - TTL - 1,
    },
    ...overrides,
  };
}

function flight(state: FlightRecord["state"]): FlightRecord {
  return {
    id: "flight-1",
    invocationId: "invocation-1",
    requesterId: "operator",
    targetAgentId: "session-old",
    state,
  };
}

describe("idleCardlessSessionExpiryCandidates", () => {
  test("expires an idle cardless session after its TTL", () => {
    const candidate = endpoint();
    const snapshot = createRuntimeRegistrySnapshot({ endpoints: { [candidate.id]: candidate } });
    expect(idleCardlessSessionExpiryCandidates(snapshot, {
      nodeId: "node-1",
      now: NOW,
      idleTtlMs: TTL,
    }).map((entry) => entry.id)).toEqual([candidate.id]);
  });

  test("keeps active flights and non-idle sessions", () => {
    const candidate = endpoint();
    const activeSnapshot = createRuntimeRegistrySnapshot({
      endpoints: { [candidate.id]: candidate },
      flights: { "flight-1": flight("running") },
    });
    expect(idleCardlessSessionExpiryCandidates(activeSnapshot, {
      nodeId: "node-1", now: NOW, idleTtlMs: TTL,
    })).toEqual([]);

    const working = endpoint({ state: "active" });
    const workingSnapshot = createRuntimeRegistrySnapshot({ endpoints: { [working.id]: working } });
    expect(idleCardlessSessionExpiryCandidates(workingSnapshot, {
      nodeId: "node-1", now: NOW, idleTtlMs: TTL,
    })).toEqual([]);
  });

  test("keeps open or waiting work owned by the session", () => {
    const candidate = endpoint();
    const work: CollaborationRecord = {
      id: "work-1",
      kind: "work_item",
      title: "Waiting for operator",
      createdById: "operator",
      ownerId: candidate.agentId,
      state: "waiting",
      acceptanceState: "accepted",
      createdAt: NOW - TTL * 2,
      updatedAt: NOW - TTL * 2,
    };
    const snapshot = createRuntimeRegistrySnapshot({
      endpoints: { [candidate.id]: candidate },
      collaborationRecords: { [work.id]: work },
    });
    expect(idleCardlessSessionExpiryCandidates(snapshot, {
      nodeId: "node-1", now: NOW, idleTtlMs: TTL,
    })).toEqual([]);
  });

  test("uses the most recent completed flight as activity", () => {
    const candidate = endpoint();
    const completed = { ...flight("completed"), completedAt: NOW - 1 };
    const snapshot = createRuntimeRegistrySnapshot({
      endpoints: { [candidate.id]: candidate },
      flights: { [completed.id]: completed },
    });
    expect(idleCardlessSessionExpiryCandidates(snapshot, {
      nodeId: "node-1", now: NOW, idleTtlMs: TTL,
    })).toEqual([]);
  });
});
