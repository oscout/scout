import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import type { FlightRecord, InvocationRequest } from "@openscout/protocol";
import { SCOUT_ORCHESTRATOR_ROLE_ID } from "@openscout/protocol";

import {
  assignRole,
  listMissionLogEntries,
} from "./assigned-roles-store.js";
import { migrateControlPlaneDatabaseSchema } from "./control-plane-migrations.js";
import {
  applyRoleLifecycleForTerminalFlight,
  planRoleLifecycleMissionLogs,
} from "./role-lifecycle.js";
import type { ControlPlaneSqliteDatabase } from "./sqlite-adapter.js";

function openTestDb(): ControlPlaneSqliteDatabase {
  const db = new Database(":memory:");
  migrateControlPlaneDatabaseSchema(db as unknown as ControlPlaneSqliteDatabase);
  return db as unknown as ControlPlaneSqliteDatabase;
}

function flight(overrides: Partial<FlightRecord> = {}): FlightRecord {
  return {
    id: "flight-1",
    invocationId: "inv-1",
    requesterId: "orch-1",
    targetAgentId: "worker-1",
    state: "completed",
    summary: "Landed workspace manifest export",
    output: "done",
    startedAt: 1_000,
    completedAt: 2_000,
    metadata: {},
    ...overrides,
  };
}

function invocation(overrides: Partial<InvocationRequest> = {}): InvocationRequest {
  return {
    id: "inv-1",
    requesterId: "orch-1",
    requesterNodeId: "node-1",
    targetAgentId: "worker-1",
    action: "consult",
    task: "Ship surfaces manifest",
    collaborationRecordId: "work-mission-1",
    ensureAwake: false,
    stream: false,
    createdAt: 1_000,
    metadata: {},
    ...overrides,
  };
}

describe("planRoleLifecycleMissionLogs", () => {
  test("plans post_ask_summary when requester is orchestrator", () => {
    const planned = planRoleLifecycleMissionLogs(
      {
        lifecycle: "ask.completed",
        flight: flight(),
        invocation: invocation(),
      },
      [
        {
          id: "a1",
          roleId: SCOUT_ORCHESTRATOR_ROLE_ID,
          agentId: "orch-1",
          scope: { kind: "mission", missionId: "work-mission-1" },
          assignedById: "operator",
          assignedAt: 1,
          active: true,
        },
      ],
    );

    expect(planned).toHaveLength(1);
    expect(planned[0]!.binding.functionId).toBe("post_ask_summary");
    expect(planned[0]!.input.kind).toBe("integration");
    expect(planned[0]!.input.actorId).toBe("orch-1");
    expect(planned[0]!.input.missionId).toBe("work-mission-1");
    expect(planned[0]!.input.refs?.flightId).toBe("flight-1");
    expect(planned[0]!.input.status).toContain("worker-1");
  });

  test("plans progress when target is orchestrator", () => {
    const planned = planRoleLifecycleMissionLogs(
      {
        lifecycle: "ask.completed",
        flight: flight({ targetAgentId: "orch-1", requesterId: "operator" }),
        invocation: invocation({
          targetAgentId: "orch-1",
          requesterId: "operator",
          collaborationRecordId: "work-mission-1",
        }),
      },
      [
        {
          id: "a1",
          roleId: SCOUT_ORCHESTRATOR_ROLE_ID,
          agentId: "orch-1",
          scope: { kind: "mission", missionId: "work-mission-1" },
          assignedById: "operator",
          assignedAt: 1,
          active: true,
        },
      ],
    );

    expect(planned).toHaveLength(1);
    expect(planned[0]!.input.kind).toBe("progress");
    expect(planned[0]!.input.actorId).toBe("orch-1");
  });

  test("skips when no orchestrator assignment", () => {
    const planned = planRoleLifecycleMissionLogs(
      {
        lifecycle: "ask.completed",
        flight: flight(),
        invocation: invocation(),
      },
      [],
    );
    expect(planned).toHaveLength(0);
  });

  test("standing orchestrator uses collaborationRecordId as mission", () => {
    const planned = planRoleLifecycleMissionLogs(
      {
        lifecycle: "ask.completed",
        flight: flight(),
        invocation: invocation({ collaborationRecordId: "work-abc" }),
      },
      [
        {
          id: "a1",
          roleId: SCOUT_ORCHESTRATOR_ROLE_ID,
          agentId: "orch-1",
          scope: { kind: "agent" },
          assignedById: "operator",
          assignedAt: 1,
          active: true,
        },
      ],
    );
    expect(planned).toHaveLength(1);
    expect(planned[0]!.input.missionId).toBe("work-abc");
  });

  test("standing orchestrator with no work id skips (no spam sink)", () => {
    const planned = planRoleLifecycleMissionLogs(
      {
        lifecycle: "ask.completed",
        flight: flight(),
        invocation: invocation({ collaborationRecordId: undefined }),
      },
      [
        {
          id: "a1",
          roleId: SCOUT_ORCHESTRATOR_ROLE_ID,
          agentId: "orch-1",
          scope: { kind: "agent" },
          assignedById: "operator",
          assignedAt: 1,
          active: true,
        },
      ],
    );
    expect(planned).toHaveLength(0);
  });

  test("mission-scoped orchestrator does not log unrelated missions", () => {
    const planned = planRoleLifecycleMissionLogs(
      {
        lifecycle: "ask.completed",
        flight: flight(),
        invocation: invocation({ collaborationRecordId: "work-B" }),
      },
      [
        {
          id: "a1",
          roleId: SCOUT_ORCHESTRATOR_ROLE_ID,
          agentId: "orch-1",
          scope: { kind: "mission", missionId: "work-A" },
          assignedById: "operator",
          assignedAt: 1,
          active: true,
        },
      ],
    );
    expect(planned).toHaveLength(0);
  });

  test("mission-scoped orchestrator logs only its mission", () => {
    const planned = planRoleLifecycleMissionLogs(
      {
        lifecycle: "ask.completed",
        flight: flight(),
        invocation: invocation({ collaborationRecordId: "work-A" }),
      },
      [
        {
          id: "a1",
          roleId: SCOUT_ORCHESTRATOR_ROLE_ID,
          agentId: "orch-1",
          scope: { kind: "mission", missionId: "work-A" },
          assignedById: "operator",
          assignedAt: 1,
          active: true,
        },
      ],
    );
    expect(planned).toHaveLength(1);
    expect(planned[0]!.input.missionId).toBe("work-A");
  });
});

describe("applyRoleLifecycleForTerminalFlight", () => {
  test("writes mission log and is idempotent per flight", () => {
    const db = openTestDb();
    assignRole(db, {
      roleId: SCOUT_ORCHESTRATOR_ROLE_ID,
      agentId: "orch-1",
      scope: { kind: "mission", missionId: "work-mission-1" },
      assignedById: "operator",
    });

    const first = applyRoleLifecycleForTerminalFlight(db, {
      flight: flight(),
      invocation: invocation(),
    });
    expect(first.written).toBe(1);
    expect(first.errors).toEqual([]);

    const second = applyRoleLifecycleForTerminalFlight(db, {
      flight: flight(),
      invocation: invocation(),
    });
    expect(second.written).toBe(0);
    expect(second.skipped).toBe(1);

    const log = listMissionLogEntries(db, { missionId: "work-mission-1" });
    expect(log).toHaveLength(1);
    expect(log[0]!.metadata?.functionId).toBe("post_ask_summary");
    expect(log[0]!.metadata?.source).toBe("role_lifecycle");
  });

  test("failed flight logs kind failed", () => {
    const db = openTestDb();
    assignRole(db, {
      roleId: SCOUT_ORCHESTRATOR_ROLE_ID,
      agentId: "orch-1",
      scope: { kind: "mission", missionId: "work-mission-1" },
      assignedById: "operator",
    });

    const result = applyRoleLifecycleForTerminalFlight(db, {
      flight: flight({
        state: "failed",
        error: "worker timed out",
        summary: "Worker timed out",
      }),
      invocation: invocation(),
    });
    expect(result.written).toBe(1);
    const log = listMissionLogEntries(db, { missionId: "work-mission-1" });
    expect(log[0]!.kind).toBe("failed");
  });

  test("uses flight projectPath for a project-scoped orchestrator", () => {
    const db = openTestDb();
    assignRole(db, {
      roleId: SCOUT_ORCHESTRATOR_ROLE_ID,
      agentId: "orch-1",
      scope: { kind: "project", projectRoot: "/repo" },
      assignedById: "operator",
    });

    const result = applyRoleLifecycleForTerminalFlight(db, {
      flight: flight({ metadata: { projectPath: "/repo" } }),
      invocation: invocation({ metadata: {} }),
    });

    expect(result.written).toBe(1);
    expect(result.errors).toEqual([]);
    expect(listMissionLogEntries(db, { missionId: "work-mission-1" })).toHaveLength(1);
  });
});
