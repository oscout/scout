import { describe, expect, test } from "bun:test";
import type { WorkItemRecord } from "@openscout/protocol";

import {
  deriveIssueBindingKey,
  evaluateIssueRunnerEligibility,
  planIssueRunnerDispatches,
  resolveIssueWorkspacePath,
  sortIssueRunnerCandidates,
  type ExternalIssueSnapshot,
  type IssueClaim,
  type IssueRunnerIssueInput,
  type IssueRunnerProfile,
} from "./issue-runner.js";

const now = 1_700_000_000_000;

function profile(overrides: Partial<IssueRunnerProfile> = {}): IssueRunnerProfile {
  return {
    id: "profile.runtime",
    displayName: "Runtime Runner",
    enabled: true,
    projectRoot: "/repo/openscout",
    revision: "rev-1",
    tracker: {
      kind: "github",
      sourceInstanceId: "openscout",
      activeStates: ["ready", "blocked"],
      terminalStates: ["done", "closed"],
      blockedStates: ["blocked"],
      labelBlocklist: ["blocked"],
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
      root: "/tmp/openscout-issue-runner",
      mode: "worktree",
      baseRef: "main",
      cleanupTerminal: true,
    },
    agent: {
      agentId: "agent.runtime",
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
      reviewerId: "person.art",
      artifactPolicy: "patch",
    },
    promptTemplate: "Work on the issue and prepare a review handoff.",
    ...overrides,
  };
}

function issue(overrides: Partial<ExternalIssueSnapshot> = {}): ExternalIssueSnapshot {
  return {
    source: "github",
    sourceInstanceId: "openscout",
    externalId: "issue-24",
    identifier: "SCO-024",
    title: "Autonomous issue runner",
    state: "ready",
    priority: 2,
    labels: ["runtime"],
    createdAt: 100,
    updatedAt: 200,
    lastSeenAt: now,
    ...overrides,
  };
}

function workItem(overrides: Partial<WorkItemRecord> = {}): WorkItemRecord {
  return {
    id: "work.sco-024",
    kind: "work_item",
    title: "SCO-024: Autonomous issue runner",
    state: "open",
    acceptanceState: "none",
    createdById: "person.art",
    ownerId: "agent.runtime",
    nextMoveOwnerId: "agent.runtime",
    labels: ["runtime"],
    createdAt: 100,
    updatedAt: 200,
    ...overrides,
  };
}

function candidate(overrides: Partial<IssueRunnerIssueInput> = {}): IssueRunnerIssueInput {
  return {
    externalIssue: issue(),
    workItem: workItem(),
    ...overrides,
  };
}

function claim(overrides: Partial<IssueClaim> = {}): IssueClaim {
  const externalIssue = issue();
  const bindingKey = deriveIssueBindingKey("profile.runtime", externalIssue);
  return {
    id: "claim-1",
    profileId: "profile.runtime",
    bindingKey,
    workId: "work.sco-024",
    runnerId: "agent.runtime",
    generation: 3,
    state: "running",
    leaseOwnerId: "runner-daemon",
    leaseExpiresAt: now + 60_000,
    workspaceId: "workspace-1",
    attempt: 1,
    createdAt: now - 10_000,
    updatedAt: now - 5_000,
    ...overrides,
  };
}

describe("issue-runner workspace paths", () => {
  test("rejects traversal and keeps resolved paths under the root", () => {
    const rejected = resolveIssueWorkspacePath("/tmp/openscout-issue-runner", "../escape");
    expect(rejected.ok).toBe(false);

    const resolved = resolveIssueWorkspacePath("/tmp/openscout-issue-runner", "profile-SCO-024-abc123");
    expect(resolved).toEqual({
      ok: true,
      rootPath: "/tmp/openscout-issue-runner",
      workspaceKey: "profile-SCO-024-abc123",
      workspacePath: "/tmp/openscout-issue-runner/profile-SCO-024-abc123",
    });
  });
});

describe("deriveIssueBindingKey", () => {
  test("is stable across human identifier changes and separates durable identity", () => {
    const original = issue({
      identifier: "SCO-024",
      externalId: "gid://github/Issue/24",
    });
    const renamed = issue({
      identifier: "RUNTIME-24",
      externalId: "gid://github/Issue/24",
    });

    expect(deriveIssueBindingKey("profile.runtime", original))
      .toBe(deriveIssueBindingKey("profile.runtime", renamed));
    expect(deriveIssueBindingKey("profile.runtime", original))
      .not.toBe(deriveIssueBindingKey("profile.runtime", issue({ externalId: "gid://github/Issue/25" })));
  });
});

describe("sortIssueRunnerCandidates", () => {
  test("orders by priority, then oldest issue timestamp, then identifier", () => {
    const sorted = sortIssueRunnerCandidates("profile.runtime", [
      candidate({ externalIssue: issue({ identifier: "SCO-003", externalId: "3", priority: null, createdAt: 1 }) }),
      candidate({ externalIssue: issue({ identifier: "SCO-002", externalId: "2", priority: 1, createdAt: 50 }) }),
      candidate({ externalIssue: issue({ identifier: "SCO-001", externalId: "1", priority: 1, createdAt: 10 }) }),
    ]);

    expect(sorted.map((entry) => entry.externalIssue.identifier)).toEqual([
      "SCO-001",
      "SCO-002",
      "SCO-003",
    ]);
  });
});

describe("evaluateIssueRunnerEligibility", () => {
  test("rejects terminal and blocked tracker states", () => {
    const terminal = evaluateIssueRunnerEligibility({
      profile: profile(),
      issue: candidate({ externalIssue: issue({ state: "done" }) }),
      now,
    });
    expect(terminal.eligible).toBe(false);
    expect(terminal.failures.map((entry) => entry.category)).toContain("issue_terminal_state");

    const blocked = evaluateIssueRunnerEligibility({
      profile: profile(),
      issue: candidate({ externalIssue: issue({ state: "blocked" }) }),
      now,
    });
    expect(blocked.eligible).toBe(false);
    expect(blocked.failures.map((entry) => entry.category)).toContain("issue_blocked_state");
  });

  test("rejects terminal Scout work items", () => {
    const result = evaluateIssueRunnerEligibility({
      profile: profile(),
      issue: candidate({ workItem: workItem({ state: "done" }) }),
      now,
    });

    expect(result.eligible).toBe(false);
    expect(result.failures.map((entry) => entry.category)).toContain("work_item_terminal_state");
  });

  test("blocks dispatch while an active claim lease exists", () => {
    const result = evaluateIssueRunnerEligibility({
      profile: profile(),
      issue: candidate({ claim: claim() }),
      now,
    });

    expect(result.eligible).toBe(false);
    expect(result.blockingClaim?.id).toBe("claim-1");
    expect(result.failures.map((entry) => entry.category)).toContain("active_claim");
  });

  test("allows an expired claim to be reclaimed with a new generation", () => {
    const result = evaluateIssueRunnerEligibility({
      profile: profile(),
      issue: candidate({ claim: claim({ leaseExpiresAt: now - 1 }) }),
      now,
    });

    expect(result.eligible).toBe(true);
    expect(result.claimGeneration).toBe(4);
    expect(result.reclaimingExpiredClaim).toBe(true);
    expect(result.failures).toEqual([]);
  });
});

describe("planIssueRunnerDispatches", () => {
  test("builds a deterministic dispatch plan with claim and workspace metadata", () => {
    const plan = planIssueRunnerDispatches({
      profile: profile(),
      candidates: [candidate()],
      now,
      runnerId: "runner-daemon",
      leaseOwnerId: "runner-daemon",
    });

    expect(plan.ineligible).toEqual([]);
    expect(plan.dispatches).toHaveLength(1);
    expect(plan.dispatches[0]).toEqual(expect.objectContaining({
      profileId: "profile.runtime",
      runnerId: "runner-daemon",
      bindingKey: deriveIssueBindingKey("profile.runtime", issue()),
      claim: expect.objectContaining({
        profileId: "profile.runtime",
        workId: "work.sco-024",
        runnerId: "runner-daemon",
        generation: 1,
        state: "claimed",
        leaseOwnerId: "runner-daemon",
        leaseExpiresAt: now + 120_000,
      }),
      workspace: expect.objectContaining({
        profileId: "profile.runtime",
        workId: "work.sco-024",
        mode: "worktree",
        projectRoot: "/repo/openscout",
        baseRef: "main",
        requestedPermissionProfile: "workspace_write",
      }),
      invocation: expect.objectContaining({
        targetAgentId: "agent.runtime",
        action: "execute",
        collaborationRecordId: "work.sco-024",
        task: "Work on the issue and prepare a review handoff.",
      }),
    }));
    expect(plan.dispatches[0]?.workspace.path?.startsWith("/tmp/openscout-issue-runner/")).toBe(true);
    expect(plan.dispatches[0]?.invocation.context.issueRunner).toEqual(expect.objectContaining({
      profileId: "profile.runtime",
      claimGeneration: 1,
      workItemId: "work.sco-024",
      workspacePath: plan.dispatches[0]?.workspace.path,
    }));
  });
});
