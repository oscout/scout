import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { SCOUT_ORCHESTRATOR_ROLE_ID } from "@openscout/protocol";

import {
  appendMissionLogEntry,
  assignRole,
  listMissionLogEntries,
  listRoleAssignments,
  revokeRole,
} from "./assigned-roles-store.js";
import { migrateControlPlaneDatabaseSchema } from "./control-plane-migrations.js";
import type { ControlPlaneSqliteDatabase } from "./sqlite-adapter.js";

function openTestDb(): ControlPlaneSqliteDatabase {
  const db = new Database(":memory:");
  migrateControlPlaneDatabaseSchema(db as unknown as ControlPlaneSqliteDatabase);
  return db as unknown as ControlPlaneSqliteDatabase;
}

describe("assigned-roles-store", () => {
  test("assign / list / revoke orchestrator on a mission", () => {
    const db = openTestDb();
    const assignment = assignRole(db, {
      roleId: SCOUT_ORCHESTRATOR_ROLE_ID,
      agentId: "orch-1",
      scope: { kind: "mission", missionId: "work-1" },
      assignedById: "operator",
    });

    expect(assignment.active).toBe(true);
    expect(assignment.roleId).toBe("orchestrator");
    expect(assignment.scope).toEqual({ kind: "mission", missionId: "work-1" });

    const listed = listRoleAssignments(db, { missionId: "work-1" });
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toBe(assignment.id);

    const revoked = revokeRole(db, {
      assignmentId: assignment.id,
      revokedById: "operator",
    });
    expect(revoked.active).toBe(false);
    expect(listRoleAssignments(db, { missionId: "work-1", activeOnly: true })).toHaveLength(0);
    expect(listRoleAssignments(db, { missionId: "work-1", activeOnly: false })).toHaveLength(1);
  });

  test("enforces single orchestrator per mission by default", () => {
    const db = openTestDb();
    assignRole(db, {
      roleId: SCOUT_ORCHESTRATOR_ROLE_ID,
      agentId: "orch-1",
      scope: { kind: "mission", missionId: "work-1" },
      assignedById: "operator",
    });

    expect(() =>
      assignRole(db, {
        roleId: SCOUT_ORCHESTRATOR_ROLE_ID,
        agentId: "orch-2",
        scope: { kind: "mission", missionId: "work-1" },
        assignedById: "operator",
      }),
    ).toThrow(/already has orchestrator/);
  });

  test("mission log append requires assignment", () => {
    const db = openTestDb();
    expect(() =>
      appendMissionLogEntry(db, {
        missionId: "work-1",
        actorId: "orch-1",
        kind: "progress",
        intent: "Ship feature",
        status: "Starting work",
      }),
    ).toThrow(/not an assigned mission-log writer/);

    assignRole(db, {
      roleId: SCOUT_ORCHESTRATOR_ROLE_ID,
      agentId: "orch-1",
      scope: { kind: "mission", missionId: "work-1" },
      assignedById: "operator",
    });

    const entry = appendMissionLogEntry(db, {
      missionId: "work-1",
      actorId: "orch-1",
      kind: "progress",
      intent: "Ship feature",
      status: "Delegating web board",
    });

    expect(entry.seq).toBe(1);
    expect(entry.status).toBe("Delegating web board");

    const second = appendMissionLogEntry(db, {
      missionId: "work-1",
      actorId: "orch-1",
      kind: "delegation",
      intent: "Ship feature",
      status: "Spawned claude for UI",
    });
    expect(second.seq).toBe(2);

    const log = listMissionLogEntries(db, { missionId: "work-1" });
    expect(log.map((e) => e.seq)).toEqual([1, 2]);
  });

  test("standing agent-scope orchestrator may write any mission log", () => {
    const db = openTestDb();
    assignRole(db, {
      roleId: SCOUT_ORCHESTRATOR_ROLE_ID,
      agentId: "orch-1",
      scope: { kind: "agent" },
      assignedById: "operator",
    });

    const entry = appendMissionLogEntry(db, {
      missionId: "work-99",
      actorId: "orch-1",
      kind: "heartbeat",
      intent: "Campaign watch",
      status: "Still coordinating",
    });
    expect(entry.missionId).toBe("work-99");
  });

  test("project-scoped orchestrator may write when projectRoot matches", () => {
    const db = openTestDb();
    assignRole(db, {
      roleId: SCOUT_ORCHESTRATOR_ROLE_ID,
      agentId: "orch-1",
      scope: { kind: "project", projectRoot: "/repo" },
      assignedById: "operator",
    });

    const entry = appendMissionLogEntry(
      db,
      {
        missionId: "work-proj",
        actorId: "orch-1",
        kind: "progress",
        intent: "Project campaign",
        status: "Writing from project scope",
      },
      { projectRoot: "/repo" },
    );
    expect(entry.missionId).toBe("work-proj");
  });

  test("allow-multiple orchestrators when enforceSingleOrchestrator is false", () => {
    const db = openTestDb();
    assignRole(db, {
      roleId: SCOUT_ORCHESTRATOR_ROLE_ID,
      agentId: "orch-1",
      scope: { kind: "mission", missionId: "work-1" },
      assignedById: "operator",
    });
    const second = assignRole(db, {
      roleId: SCOUT_ORCHESTRATOR_ROLE_ID,
      agentId: "orch-2",
      scope: { kind: "mission", missionId: "work-1" },
      assignedById: "operator",
      enforceSingleOrchestrator: false,
    });
    expect(second.agentId).toBe("orch-2");
    expect(second.active).toBe(true);
  });

  test("reactivates matching revoked assignment", () => {
    const db = openTestDb();
    const first = assignRole(db, {
      roleId: SCOUT_ORCHESTRATOR_ROLE_ID,
      agentId: "orch-1",
      scope: { kind: "mission", missionId: "work-1" },
      assignedById: "operator",
    });
    revokeRole(db, { assignmentId: first.id, revokedById: "operator" });

    const second = assignRole(db, {
      roleId: SCOUT_ORCHESTRATOR_ROLE_ID,
      agentId: "orch-1",
      scope: { kind: "mission", missionId: "work-1" },
      assignedById: "operator",
    });
    expect(second.id).toBe(first.id);
    expect(second.active).toBe(true);
  });
});
