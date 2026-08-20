import { describe, expect, test } from "bun:test";

import type {
  FlightRecord,
  InvocationRequest,
} from "@openscout/protocol";

import type { BrokerInvocationDispatchJob } from "./broker-dispatch-job.js";
import { BrokerDispatchRecoveryService } from "./broker-dispatch-recovery-service.js";

function invocation(input: Partial<InvocationRequest> = {}): InvocationRequest {
  return {
    id: "invocation-1",
    requesterId: "operator",
    requesterNodeId: "node-1",
    targetAgentId: "agent-1",
    action: "consult",
    task: "hello",
    ensureAwake: false,
    stream: false,
    createdAt: 1_000,
    metadata: {},
    ...input,
  };
}

function flight(input: Partial<FlightRecord> = {}): FlightRecord {
  return {
    id: "flight-1",
    invocationId: "invocation-1",
    requesterId: "operator",
    targetAgentId: "agent-1",
    state: "queued",
    startedAt: 1_000,
    metadata: {},
    ...input,
  };
}

function dispatchJob(input: Partial<BrokerInvocationDispatchJob> = {}): BrokerInvocationDispatchJob {
  return {
    id: "dispatch-invocation-1",
    invocationId: "invocation-1",
    flightId: "flight-1",
    targetAgentId: "agent-1",
    state: "pending",
    attempts: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...input,
  };
}

function createService(input: {
  dispatchJobs?: BrokerInvocationDispatchJob[];
  flights: Record<string, FlightRecord>;
  invocations?: Record<string, InvocationRequest>;
  activeInvocationIds?: Set<string>;
}): {
  dispatched: InvocationRequest[];
  logs: string[];
  runJobs: Array<{ job: BrokerInvocationDispatchJob; invocation?: InvocationRequest }>;
  service: BrokerDispatchRecoveryService;
  warnings: string[];
} {
  const invocations = input.invocations ?? {
    "invocation-1": invocation(),
  };
  const activeInvocationIds = input.activeInvocationIds ?? new Set<string>();
  const dispatched: InvocationRequest[] = [];
  const runJobs: Array<{ job: BrokerInvocationDispatchJob; invocation?: InvocationRequest }> = [];
  const logs: string[] = [];
  const warnings: string[] = [];
  const service = new BrokerDispatchRecoveryService({
    runtimeSnapshot: () => ({ flights: input.flights }),
    dispatchJobs: () => input.dispatchJobs ?? [],
    invocationFor: (invocationId) => invocations[invocationId],
    isInvocationActive: (invocationId) => activeInvocationIds.has(invocationId),
    async runDispatchJob(job, nextInvocation) {
      runJobs.push({ job, invocation: nextInvocation });
    },
    async dispatchAcceptedInvocation(nextInvocation) {
      dispatched.push(nextInvocation);
    },
    log: (message) => logs.push(message),
    warn: (message) => warnings.push(message),
    now: () => 10_000,
  });
  return { dispatched, logs, runJobs, service, warnings };
}

describe("BrokerDispatchRecoveryService", () => {
  test("recovers queued flights through the accepted-dispatch path", async () => {
    const invocations = {
      "invocation-old": invocation({ id: "invocation-old", targetAgentId: "agent-1" }),
      "invocation-new": invocation({ id: "invocation-new", targetAgentId: "agent-1" }),
    };
    const harness = createService({
      invocations,
      dispatchJobs: [
        dispatchJob({
          id: "dispatch-new",
          invocationId: "invocation-new",
          flightId: "flight-new",
          targetAgentId: "agent-1",
          createdAt: 2_000,
          updatedAt: 2_000,
        }),
        dispatchJob({
          id: "dispatch-old",
          invocationId: "invocation-old",
          flightId: "flight-old",
          targetAgentId: "agent-1",
          createdAt: 1_000,
          updatedAt: 1_000,
        }),
      ],
      flights: {
        "flight-new": flight({
          id: "flight-new",
          invocationId: "invocation-new",
          targetAgentId: "agent-1",
          startedAt: 2_000,
        }),
        "flight-old": flight({
          id: "flight-old",
          invocationId: "invocation-old",
          targetAgentId: "agent-1",
          startedAt: 1_000,
        }),
        done: flight({
          id: "done",
          invocationId: "invocation-done",
          targetAgentId: "agent-1",
          state: "completed",
        }),
      },
    });

    const result = await harness.service.recoverQueuedFlights({ reason: "startup" });

    expect(result).toEqual({
      considered: 2,
      dispatched: 2,
      skippedActive: 0,
      skippedMissingInvocation: 0,
    });
    expect(harness.runJobs.map((item) => item.invocation?.id)).toEqual([
      "invocation-old",
      "invocation-new",
    ]);
    expect(harness.dispatched).toEqual([]);
    expect(harness.logs[0]).toContain("startup");
  });

  test("can drain only one target agent after an endpoint comes online", async () => {
    const invocations = {
      "invocation-agent-1": invocation({ id: "invocation-agent-1", targetAgentId: "agent-1" }),
      "invocation-agent-2": invocation({ id: "invocation-agent-2", targetAgentId: "agent-2" }),
    };
    const harness = createService({
      invocations,
      dispatchJobs: [
        dispatchJob({
          id: "dispatch-agent-1",
          invocationId: "invocation-agent-1",
          flightId: "flight-agent-1",
          targetAgentId: "agent-1",
        }),
        dispatchJob({
          id: "dispatch-agent-2",
          invocationId: "invocation-agent-2",
          flightId: "flight-agent-2",
          targetAgentId: "agent-2",
        }),
      ],
      flights: {
        "flight-agent-1": flight({
          id: "flight-agent-1",
          invocationId: "invocation-agent-1",
          targetAgentId: "agent-1",
        }),
        "flight-agent-2": flight({
          id: "flight-agent-2",
          invocationId: "invocation-agent-2",
          targetAgentId: "agent-2",
        }),
      },
    });

    const result = await harness.service.recoverQueuedFlights({
      reason: "endpoint_online",
      agentId: "agent-1",
    });

    expect(result.considered).toBe(1);
    expect(harness.runJobs.map((item) => item.invocation?.id)).toEqual(["invocation-agent-1"]);
  });

  test("recovers expired running dispatch jobs after restart", async () => {
    const nextInvocation = invocation({ id: "invocation-running" });
    const harness = createService({
      invocations: { [nextInvocation.id]: nextInvocation },
      dispatchJobs: [
        dispatchJob({
          id: "dispatch-running",
          invocationId: nextInvocation.id,
          state: "running",
          leaseOwner: "broker:old",
          leaseExpiresAt: 9_000,
          updatedAt: 8_000,
        }),
      ],
      flights: {
        "flight-1": flight({ invocationId: nextInvocation.id }),
      },
    });

    const result = await harness.service.recoverQueuedFlights({ reason: "startup" });

    expect(result.dispatched).toBe(1);
    expect(harness.runJobs).toEqual([
      expect.objectContaining({
        job: expect.objectContaining({ id: "dispatch-running", state: "running" }),
        invocation: nextInvocation,
      }),
    ]);
  });

  test("recovers legacy waking flights without dispatch jobs", async () => {
    const nextInvocation = invocation({ id: "invocation-waking" });
    const harness = createService({
      invocations: { [nextInvocation.id]: nextInvocation },
      flights: {
        "flight-waking": flight({
          id: "flight-waking",
          invocationId: nextInvocation.id,
          state: "waking",
        }),
      },
    });

    const result = await harness.service.recoverQueuedFlights({ reason: "startup" });

    expect(result.dispatched).toBe(1);
    expect(harness.dispatched).toEqual([nextInvocation]);
  });

  test("skips active invocations and missing invocation records", async () => {
    const harness = createService({
      invocations: {
        active: invocation({ id: "active" }),
      },
      activeInvocationIds: new Set(["active"]),
      dispatchJobs: [
        dispatchJob({
          id: "dispatch-active",
          invocationId: "active",
          flightId: "active-flight",
        }),
        dispatchJob({
          id: "dispatch-missing",
          invocationId: "missing",
          flightId: "missing-flight",
        }),
      ],
      flights: {
        active: flight({ id: "active-flight", invocationId: "active" }),
        missing: flight({ id: "missing-flight", invocationId: "missing" }),
      },
    });

    const result = await harness.service.recoverQueuedFlights({ reason: "startup" });

    expect(result).toEqual({
      considered: 2,
      dispatched: 0,
      skippedActive: 1,
      skippedMissingInvocation: 1,
    });
    expect(harness.dispatched).toEqual([]);
    expect(harness.warnings).toHaveLength(1);
  });
});
