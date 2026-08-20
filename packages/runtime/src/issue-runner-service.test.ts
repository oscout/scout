import { describe, expect, test } from "bun:test";
import type { WorkItemRecord } from "@openscout/protocol";

import { createInMemoryControlRuntime } from "./broker.js";
import {
  deriveIssueBindingKey,
  type IssueClaim,
  type IssueRunnerProfile,
} from "./issue-runner.js";
import {
  applyScoutIssueRunnerDispatches,
  buildScoutExternalIssueSnapshot,
  planScoutIssueRunnerTick,
  readScoutIssueRunnerProfileState,
  runScoutIssueRunnerTick,
} from "./issue-runner-service.js";

const now = 1_700_000_000_000;

function profile(overrides: Partial<IssueRunnerProfile> = {}): IssueRunnerProfile {
  return {
    id: "profile.scout",
    displayName: "Scout Native Runner",
    enabled: true,
    projectRoot: "/repo/openscout",
    revision: "rev-scout-1",
    tracker: {
      kind: "scout",
      sourceInstanceId: "openscout-local",
      activeStates: ["open", "working"],
      terminalStates: ["done", "cancelled"],
    },
    polling: {
      intervalMs: 60_000,
      staleSourceAfterMs: 30_000,
    },
    claim: {
      leaseMs: 120_000,
      heartbeatMs: 30_000,
      staleGraceMs: 60_000,
    },
    workspace: {
      root: "/tmp/openscout-scout-runner",
      mode: "worktree",
      baseRef: "main",
    },
    agent: {
      agentId: "agent.runner",
      maxConcurrentRuns: 3,
    },
    continuation: {
      maxTurnsPerAttempt: 4,
      maxAttemptsPerIssue: 2,
      continueInSameThread: true,
      stallAfterMs: 300_000,
    },
    retry: {
      maxAttempts: 2,
      initialBackoffMs: 60_000,
      maxBackoffMs: 300_000,
      retryableFailureKinds: ["timeout"],
    },
    permissions: {
      permissionProfile: "workspace_write",
      requireReviewBeforeIssueDone: true,
    },
    handoff: {
      createReviewTask: true,
      artifactPolicy: "patch",
    },
    promptTemplate: "Work this Scout item and prepare a review handoff.",
    ...overrides,
  };
}

function workItem(overrides: Partial<WorkItemRecord> = {}): WorkItemRecord {
  return {
    id: "work.sco-024",
    kind: "work_item",
    title: "SCO-024: Scout-native issue runner",
    summary: "Dispatch Scout work items through the issue runner.",
    state: "open",
    acceptanceState: "none",
    createdById: "person.art",
    ownerId: "agent.runner",
    nextMoveOwnerId: "agent.runner",
    priority: "high",
    labels: ["runtime"],
    createdAt: 100,
    updatedAt: 200,
    ...overrides,
  };
}

async function runtimeWithWorkItem(record: WorkItemRecord) {
  const runtime = createInMemoryControlRuntime({}, { localNodeId: "node-1" });
  await runtime.upsertNode({
    id: "node-1",
    meshId: "mesh-1",
    name: "Node 1",
    advertiseScope: "local",
    registeredAt: 1,
  });
  await runtime.upsertAgent({
    id: "agent.runner",
    kind: "agent",
    definitionId: "agent.runner",
    displayName: "Runner Agent",
    agentClass: "builder",
    capabilities: ["execute"],
    wakePolicy: "on_demand",
    homeNodeId: "node-1",
    authorityNodeId: "node-1",
    advertiseScope: "local",
  });
  await runtime.upsertCollaboration(record);

  return runtime;
}

function existingClaim(
  record: WorkItemRecord,
  overrides: Partial<IssueClaim> = {},
): IssueClaim {
  const runnerProfile = profile();
  const externalIssue = buildScoutExternalIssueSnapshot({
    workItem: record,
    profile: runnerProfile,
    now,
  });
  const bindingKey = deriveIssueBindingKey(runnerProfile.id, externalIssue);

  return {
    id: "claim-existing",
    profileId: runnerProfile.id,
    bindingKey,
    workId: record.id,
    runnerId: "runner-daemon",
    generation: 2,
    state: "running",
    leaseOwnerId: "runner-daemon",
    leaseExpiresAt: now + 60_000,
    workspaceId: "workspace-existing",
    attempt: 1,
    createdAt: now - 20_000,
    updatedAt: now - 10_000,
    ...overrides,
  };
}

function withStoredClaim(record: WorkItemRecord, claim: IssueClaim): WorkItemRecord {
  return {
    ...record,
    metadata: {
      ...(record.metadata ?? {}),
      issueRunner: {
        version: 1,
        profiles: {
          [claim.profileId]: {
            source: "scout",
            profileId: claim.profileId,
            claim,
          },
        },
      },
    },
  };
}

describe("Scout issue runner service", () => {
  test("plans and applies an eligible Scout work item dispatch", async () => {
    const runtime = await runtimeWithWorkItem(workItem());
    const tick = await runScoutIssueRunnerTick({
      runtime,
      profile: profile(),
      now,
      runnerId: "runner-daemon",
      leaseOwnerId: "runner-daemon",
      requesterId: "runner-daemon",
      requesterNodeId: "node-1",
    });

    expect(tick.planner.ineligible).toEqual([]);
    expect(tick.dispatches).toHaveLength(1);
    expect(tick.dispatches[0]?.dispatch.issue).toEqual(expect.objectContaining({
      source: "scout",
      sourceInstanceId: "openscout-local",
      externalId: "work.sco-024",
      state: "open",
      priority: 1,
    }));
    expect(tick.apply.applied).toHaveLength(1);

    const stored = runtime.snapshot().collaborationRecords["work.sco-024"] as WorkItemRecord;
    const state = readScoutIssueRunnerProfileState(stored.metadata, "profile.scout");
    expect(state).toEqual(expect.objectContaining({
      source: "scout",
      profileId: "profile.scout",
    }));
    expect(state?.binding).toEqual(expect.objectContaining({
      source: "scout",
      workId: "work.sco-024",
    }));
    expect(state?.claim).toEqual(expect.objectContaining({
      state: "running",
      generation: 1,
      workId: "work.sco-024",
      leaseOwnerId: "runner-daemon",
    }));
    expect(state?.workspace.path?.startsWith("/tmp/openscout-scout-runner/")).toBe(true);
    expect(state?.runner.flightId).toBe(tick.apply.applied[0]?.flight.id);
  });

  test("skips terminal Scout work items", async () => {
    const runtime = await runtimeWithWorkItem(workItem({
      state: "done",
      ownerId: undefined,
      nextMoveOwnerId: undefined,
    }));
    const tick = planScoutIssueRunnerTick({
      snapshot: runtime.snapshot(),
      profile: profile(),
      now,
    });

    expect(tick.dispatches).toEqual([]);
    expect(tick.planner.ineligible).toHaveLength(1);
    expect(tick.planner.ineligible[0]?.failures.map((failure) => failure.category)).toContain("work_item_terminal_state");
  });

  test("skips work items with an existing active claim", async () => {
    const record = workItem();
    const runtime = await runtimeWithWorkItem(withStoredClaim(record, existingClaim(record)));
    const tick = planScoutIssueRunnerTick({
      snapshot: runtime.snapshot(),
      profile: profile(),
      now,
    });

    expect(tick.dispatches).toEqual([]);
    expect(tick.planner.ineligible[0]?.blockingClaim?.id).toBe("claim-existing");
    expect(tick.planner.ineligible[0]?.failures.map((failure) => failure.category)).toContain("active_claim");
  });

  test("reclaims an expired Scout claim with a later generation", async () => {
    const record = workItem();
    const runtime = await runtimeWithWorkItem(withStoredClaim(
      record,
      existingClaim(record, { leaseExpiresAt: now - 1 }),
    ));
    const tick = await runScoutIssueRunnerTick({
      runtime,
      profile: profile(),
      now,
      runnerId: "runner-daemon",
      leaseOwnerId: "runner-daemon",
      requesterId: "runner-daemon",
      requesterNodeId: "node-1",
    });

    expect(tick.dispatches).toHaveLength(1);
    expect(tick.dispatches[0]?.dispatch.claim).toEqual(expect.objectContaining({
      generation: 3,
      metadata: expect.objectContaining({
        previousClaimId: "claim-existing",
        reclaimingExpiredClaim: true,
      }),
    }));
    expect(tick.apply.applied).toHaveLength(1);

    const stored = runtime.snapshot().collaborationRecords["work.sco-024"] as WorkItemRecord;
    const state = readScoutIssueRunnerProfileState(stored.metadata, "profile.scout");
    expect(state?.claim.generation).toBe(3);
    expect(state?.claim.metadata?.fencing).toEqual(expect.objectContaining({
      generation: 3,
      claimId: tick.dispatches[0]?.dispatch.claim.id,
    }));
  });

  test("builds invocation metadata and execution permissions from the dispatch plan", async () => {
    const runtime = await runtimeWithWorkItem(workItem());
    const tick = await runScoutIssueRunnerTick({
      runtime,
      profile: profile(),
      now,
      runnerId: "runner-daemon",
      leaseOwnerId: "runner-daemon",
      requesterId: "runner-daemon",
      requesterNodeId: "node-1",
    });
    const invocation = tick.apply.applied[0]?.invocation;

    expect(invocation).toEqual(expect.objectContaining({
      targetAgentId: "agent.runner",
      action: "execute",
      collaborationRecordId: "work.sco-024",
      ensureAwake: true,
      stream: true,
      execution: {
        permissionProfile: "workspace_write",
      },
    }));
    expect(invocation?.metadata).toEqual(expect.objectContaining({
      source: "external_issue",
      externalIssueSource: "scout",
      profileId: "profile.scout",
      workId: "work.sco-024",
      collaborationRecordId: "work.sco-024",
      dispatchId: tick.dispatches[0]?.dispatch.id,
    }));
    expect(invocation?.context?.issueRunner).toEqual(expect.objectContaining({
      source: "scout",
      profileId: "profile.scout",
      workItemId: "work.sco-024",
      invocationId: invocation?.id,
    }));
  });

  test("writes durable work item claim metadata before invoking the agent", async () => {
    const runtime = await runtimeWithWorkItem(workItem());
    const tick = planScoutIssueRunnerTick({
      snapshot: runtime.snapshot(),
      profile: profile(),
      now,
      runnerId: "runner-daemon",
      leaseOwnerId: "runner-daemon",
      requesterId: "runner-daemon",
      requesterNodeId: "node-1",
    });
    const eventCountBeforeApply = runtime.recentEvents().length;

    const result = await applyScoutIssueRunnerDispatches({
      runtime,
      dispatches: tick.dispatches,
      now,
    });

    const events = runtime.recentEvents().slice(eventCountBeforeApply);
    expect(events[0]?.kind).toBe("collaboration.upserted");
    expect(events[1]?.kind).toBe("invocation.requested");
    expect(result.applied).toHaveLength(1);

    const firstUpsert = events[0]?.payload.record as WorkItemRecord | undefined;
    const firstState = readScoutIssueRunnerProfileState(firstUpsert?.metadata, "profile.scout");
    expect(firstState?.claim).toEqual(expect.objectContaining({
      state: "claimed",
      generation: 1,
    }));
    expect(firstState?.runner.invocationId).toBe(result.applied[0]?.invocation.id);

    const finalStored = runtime.snapshot().collaborationRecords["work.sco-024"] as WorkItemRecord;
    const finalState = readScoutIssueRunnerProfileState(finalStored.metadata, "profile.scout");
    expect(finalState?.claim.state).toBe("running");
    expect(finalState?.runner.flightId).toBe(result.applied[0]?.flight.id);
  });

  test("replaying the same dispatch is idempotently fenced by the stored claim", async () => {
    const runtime = await runtimeWithWorkItem(workItem());
    const tick = planScoutIssueRunnerTick({
      snapshot: runtime.snapshot(),
      profile: profile(),
      now,
      runnerId: "runner-daemon",
      leaseOwnerId: "runner-daemon",
      requesterId: "runner-daemon",
      requesterNodeId: "node-1",
    });

    const first = await applyScoutIssueRunnerDispatches({
      runtime,
      dispatches: tick.dispatches,
      now,
    });
    const replay = await applyScoutIssueRunnerDispatches({
      runtime,
      dispatches: tick.dispatches,
      now: now + 1,
    });

    expect(first.applied).toHaveLength(1);
    expect(replay.applied).toEqual([]);
    expect(replay.skipped).toEqual([
      expect.objectContaining({
        reason: "active_claim",
        claim: expect.objectContaining({
          id: tick.dispatches[0]?.dispatch.claim.id,
          generation: 1,
        }),
      }),
    ]);
    expect(Object.values(runtime.snapshot().invocations)).toHaveLength(1);
  });

  test("does not overwrite a lower-generation claim that was renewed after planning", async () => {
    const record = workItem();
    const runtime = await runtimeWithWorkItem(withStoredClaim(
      record,
      existingClaim(record, { leaseExpiresAt: now - 1 }),
    ));
    const tick = planScoutIssueRunnerTick({
      snapshot: runtime.snapshot(),
      profile: profile(),
      now,
      runnerId: "runner-daemon",
      leaseOwnerId: "runner-daemon",
      requesterId: "runner-daemon",
      requesterNodeId: "node-1",
    });

    await runtime.upsertCollaboration(withStoredClaim(
      record,
      existingClaim(record, {
        id: "claim-renewed",
        generation: 2,
        leaseExpiresAt: now + 60_000,
        updatedAt: now + 1,
      }),
    ));

    const result = await applyScoutIssueRunnerDispatches({
      runtime,
      dispatches: tick.dispatches,
      now: now + 1,
    });

    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([
      expect.objectContaining({
        reason: "active_claim",
        claim: expect.objectContaining({
          id: "claim-renewed",
          generation: 2,
        }),
      }),
    ]);
    expect(Object.values(runtime.snapshot().invocations)).toHaveLength(0);
  });

  test("skips dispatches whose target agent disappeared before claim", async () => {
    const runtime = await runtimeWithWorkItem(workItem());
    const tick = planScoutIssueRunnerTick({
      snapshot: runtime.snapshot(),
      profile: profile(),
      now,
      runnerId: "runner-daemon",
      leaseOwnerId: "runner-daemon",
      requesterId: "runner-daemon",
      requesterNodeId: "node-1",
    });
    tick.dispatches[0]!.invocation.targetAgentId = "agent.missing";

    const result = await applyScoutIssueRunnerDispatches({
      runtime,
      dispatches: tick.dispatches,
      now,
    });

    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([
      expect.objectContaining({
        reason: "target_agent_missing",
        error: "unknown agent: agent.missing",
      }),
    ]);
    const stored = runtime.snapshot().collaborationRecords["work.sco-024"] as WorkItemRecord;
    expect(readScoutIssueRunnerProfileState(stored.metadata, "profile.scout")).toBeUndefined();
    expect(Object.values(runtime.snapshot().invocations)).toHaveLength(0);
  });

  test("marks a claim terminal when invoke fails after claiming", async () => {
    const runtime = await runtimeWithWorkItem(workItem());
    const tick = planScoutIssueRunnerTick({
      snapshot: runtime.snapshot(),
      profile: profile(),
      now,
      runnerId: "runner-daemon",
      leaseOwnerId: "runner-daemon",
      requesterId: "runner-daemon",
      requesterNodeId: "node-1",
    });
    const failingRuntime = {
      snapshot: () => runtime.snapshot(),
      upsertCollaboration: runtime.upsertCollaboration.bind(runtime),
      invokeAgent: async () => {
        throw new Error("adapter offline");
      },
    };

    const result = await applyScoutIssueRunnerDispatches({
      runtime: failingRuntime,
      dispatches: tick.dispatches,
      now,
    });

    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([
      expect.objectContaining({
        reason: "invoke_failed",
        error: "adapter offline",
        claim: expect.objectContaining({
          state: "cancelled",
          nextRetryAt: now + profile().retry.initialBackoffMs,
          lastError: expect.objectContaining({
            message: "adapter offline",
            retryable: true,
          }),
        }),
      }),
    ]);

    const stored = runtime.snapshot().collaborationRecords["work.sco-024"] as WorkItemRecord;
    const state = readScoutIssueRunnerProfileState(stored.metadata, "profile.scout");
    expect(state?.claim).toEqual(expect.objectContaining({
      state: "cancelled",
      nextRetryAt: now + profile().retry.initialBackoffMs,
      lastError: expect.objectContaining({
        kind: "agent",
        message: "adapter offline",
      }),
    }));
    expect(Object.values(runtime.snapshot().invocations)).toHaveLength(0);
  });

  test("honors retry backoff and max attempts after invoke failures", async () => {
    const runtime = await runtimeWithWorkItem(workItem());
    const runnerProfile = profile();
    const firstTick = planScoutIssueRunnerTick({
      snapshot: runtime.snapshot(),
      profile: runnerProfile,
      now,
      runnerId: "runner-daemon",
      leaseOwnerId: "runner-daemon",
      requesterId: "runner-daemon",
      requesterNodeId: "node-1",
    });
    const failingRuntime = {
      snapshot: () => runtime.snapshot(),
      upsertCollaboration: runtime.upsertCollaboration.bind(runtime),
      invokeAgent: async () => {
        throw new Error("adapter offline");
      },
    };

    await applyScoutIssueRunnerDispatches({
      runtime: failingRuntime,
      dispatches: firstTick.dispatches,
      now,
    });

    const immediateRetry = planScoutIssueRunnerTick({
      snapshot: runtime.snapshot(),
      profile: runnerProfile,
      now: now + 1,
      runnerId: "runner-daemon",
      leaseOwnerId: "runner-daemon",
      requesterId: "runner-daemon",
      requesterNodeId: "node-1",
    });
    expect(immediateRetry.dispatches).toEqual([]);
    expect(immediateRetry.planner.ineligible[0]?.failures.map((failure) => failure.category)).toContain("not_due");

    const secondTick = planScoutIssueRunnerTick({
      snapshot: runtime.snapshot(),
      profile: runnerProfile,
      now: now + runnerProfile.retry.initialBackoffMs + 1,
      runnerId: "runner-daemon",
      leaseOwnerId: "runner-daemon",
      requesterId: "runner-daemon",
      requesterNodeId: "node-1",
    });
    expect(secondTick.dispatches[0]?.dispatch.claim.attempt).toBe(2);

    await applyScoutIssueRunnerDispatches({
      runtime: failingRuntime,
      dispatches: secondTick.dispatches,
      now: now + runnerProfile.retry.initialBackoffMs + 1,
    });

    const cappedRetry = planScoutIssueRunnerTick({
      snapshot: runtime.snapshot(),
      profile: runnerProfile,
      now: now + runnerProfile.retry.initialBackoffMs + runnerProfile.retry.maxBackoffMs + 2,
      runnerId: "runner-daemon",
      leaseOwnerId: "runner-daemon",
      requesterId: "runner-daemon",
      requesterNodeId: "node-1",
    });

    expect(cappedRetry.dispatches).toEqual([]);
    expect(cappedRetry.planner.ineligible[0]?.failures.map((failure) => failure.category)).toContain("max_attempts");
  });
});
