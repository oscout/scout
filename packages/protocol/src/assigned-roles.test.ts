import { describe, expect, test } from "bun:test";
import {
  SCOUT_MISSION_LOG_APPEND,
  SCOUT_ORCHESTRATOR_ROLE,
  SCOUT_ORCHESTRATOR_ROLE_ID,
  SCOUT_ROLE_CATALOG,
  activeRoleHoldersForMission,
  agentMayWriteMissionLog,
  assignmentAppliesTo,
  assignmentsMatchingHook,
  scoutRoleAssignmentsForMission,
  scoutRoleDefinition,
  validateMissionLogEntryFields,
  type ScoutRoleAssignment,
  type ScoutRoleDefinition,
} from "./assigned-roles.js";

function assignment(
  overrides: Partial<ScoutRoleAssignment> &
    Pick<ScoutRoleAssignment, "id" | "agentId" | "scope">,
): ScoutRoleAssignment {
  return {
    roleId: SCOUT_ORCHESTRATOR_ROLE_ID,
    assignedById: "operator",
    assignedAt: 1,
    active: true,
    ...overrides,
  };
}

const QA_FIXTURE_ROLE: ScoutRoleDefinition = {
  id: "qa",
  label: "QA",
  summary: "Fixture role without mission log write.",
  hooks: ["mission.finished"],
  actions: [],
};

const FIXTURE_CATALOG: readonly ScoutRoleDefinition[] = [
  SCOUT_ORCHESTRATOR_ROLE,
  QA_FIXTURE_ROLE,
];

describe("assigned roles catalog", () => {
  test("includes orchestrator with mission_log.append", () => {
    expect(scoutRoleDefinition("orchestrator")).toEqual(SCOUT_ORCHESTRATOR_ROLE);
    expect(SCOUT_ROLE_CATALOG.some((role) => role.id === "orchestrator")).toBe(true);
    expect(SCOUT_ORCHESTRATOR_ROLE.actions).toContain(SCOUT_MISSION_LOG_APPEND);
  });

  test("orchestrator lifecycle binds post_ask_summary on ask completion", () => {
    const lifecycle = SCOUT_ORCHESTRATOR_ROLE.lifecycle ?? [];
    expect(lifecycle.some((b) => b.functionId === "post_ask_summary" && b.on === "ask.completed")).toBe(true);
    expect(lifecycle.some((b) => b.functionId === "post_work_summary" && b.on === "work.completed")).toBe(true);
  });
});

describe("assignmentAppliesTo", () => {
  test("agent scope always applies", () => {
    expect(
      assignmentAppliesTo(
        assignment({ id: "a", agentId: "orch-1", scope: { kind: "agent" } }),
        { missionId: "mission-1" },
      ),
    ).toBe(true);
  });

  test("mission scope matches mission id only", () => {
    const row = assignment({
      id: "a",
      agentId: "orch-1",
      scope: { kind: "mission", missionId: "mission-1" },
    });
    expect(assignmentAppliesTo(row, { missionId: "mission-1" })).toBe(true);
    expect(assignmentAppliesTo(row, { missionId: "other" })).toBe(false);
    expect(assignmentAppliesTo(row, {})).toBe(false);
  });

  test("project scope matches projectRoot only", () => {
    const row = assignment({
      id: "a",
      agentId: "orch-1",
      scope: { kind: "project", projectRoot: "/repo" },
    });
    expect(assignmentAppliesTo(row, { projectRoot: "/repo" })).toBe(true);
    expect(assignmentAppliesTo(row, { projectRoot: "/other", missionId: "m" })).toBe(false);
  });
});

describe("agentMayWriteMissionLog", () => {
  test("denies when no assignment", () => {
    expect(
      agentMayWriteMissionLog({
        agentId: "orch-1",
        missionId: "mission-1",
        assignments: [],
      }),
    ).toBe(false);
  });

  test("allows mission-scoped orchestrator", () => {
    expect(
      agentMayWriteMissionLog({
        agentId: "orch-1",
        missionId: "mission-1",
        assignments: [
          assignment({
            id: "a1",
            agentId: "orch-1",
            scope: { kind: "mission", missionId: "mission-1" },
          }),
        ],
      }),
    ).toBe(true);
  });

  test("allows standing agent-scope orchestrator", () => {
    expect(
      agentMayWriteMissionLog({
        agentId: "orch-1",
        missionId: "mission-99",
        assignments: [
          assignment({
            id: "a2",
            agentId: "orch-1",
            scope: { kind: "agent" },
          }),
        ],
      }),
    ).toBe(true);
  });

  test("denies inactive or wrong mission", () => {
    expect(
      agentMayWriteMissionLog({
        agentId: "orch-1",
        missionId: "mission-1",
        assignments: [
          assignment({
            id: "a3",
            agentId: "orch-1",
            active: false,
            scope: { kind: "mission", missionId: "mission-1" },
          }),
          assignment({
            id: "a4",
            agentId: "orch-1",
            scope: { kind: "mission", missionId: "other" },
          }),
          assignment({
            id: "a5",
            agentId: "worker-1",
            scope: { kind: "mission", missionId: "mission-1" },
          }),
        ],
      }),
    ).toBe(false);
  });

  test("denies roles that lack mission_log.append", () => {
    expect(
      agentMayWriteMissionLog({
        agentId: "qa-1",
        missionId: "mission-1",
        catalog: FIXTURE_CATALOG,
        assignments: [
          assignment({
            id: "q1",
            agentId: "qa-1",
            roleId: "qa",
            scope: { kind: "mission", missionId: "mission-1" },
          }),
        ],
      }),
    ).toBe(false);
  });
});

describe("assignmentsMatchingHook", () => {
  test("matches active orchestrator for turn.ended", () => {
    const matched = assignmentsMatchingHook({
      hookId: "turn.ended",
      context: { missionId: "mission-1" },
      assignments: [
        assignment({
          id: "a1",
          agentId: "orch-1",
          scope: { kind: "mission", missionId: "mission-1" },
        }),
        assignment({
          id: "a2",
          agentId: "orch-2",
          active: false,
          scope: { kind: "mission", missionId: "mission-1" },
        }),
      ],
    });
    expect(matched.map((row) => row.id)).toEqual(["a1"]);
  });

  test("excludes roles that do not list the hook", () => {
    const matched = assignmentsMatchingHook({
      hookId: "turn.ended",
      context: { missionId: "mission-1" },
      catalog: FIXTURE_CATALOG,
      assignments: [
        assignment({
          id: "q1",
          agentId: "qa-1",
          roleId: "qa",
          scope: { kind: "mission", missionId: "mission-1" },
        }),
      ],
    });
    expect(matched).toEqual([]);
  });
});

describe("scoutRoleAssignmentsForMission", () => {
  test("includes standing agent-scope by default", () => {
    const rows = scoutRoleAssignmentsForMission(
      [
        assignment({
          id: "m",
          agentId: "orch-1",
          scope: { kind: "mission", missionId: "mission-1" },
        }),
        assignment({
          id: "agent",
          agentId: "orch-2",
          scope: { kind: "agent" },
        }),
      ],
      "mission-1",
    );
    expect(rows.map((row) => row.id).sort()).toEqual(["agent", "m"]);
  });

  test("can exclude standing assignments", () => {
    const rows = scoutRoleAssignmentsForMission(
      [
        assignment({
          id: "m",
          agentId: "orch-1",
          scope: { kind: "mission", missionId: "mission-1" },
        }),
        assignment({
          id: "agent",
          agentId: "orch-2",
          scope: { kind: "agent" },
        }),
      ],
      "mission-1",
      { includeStanding: false },
    );
    expect(rows.map((row) => row.id)).toEqual(["m"]);
  });
});

describe("activeRoleHoldersForMission", () => {
  test("dedupes agents holding the role", () => {
    expect(
      activeRoleHoldersForMission(
        [
          assignment({
            id: "m",
            agentId: "orch-1",
            scope: { kind: "mission", missionId: "mission-1" },
          }),
          assignment({
            id: "agent",
            agentId: "orch-1",
            scope: { kind: "agent" },
          }),
          assignment({
            id: "other",
            agentId: "orch-2",
            scope: { kind: "agent" },
          }),
        ],
        "mission-1",
        SCOUT_ORCHESTRATOR_ROLE_ID,
      ),
    ).toEqual(["orch-1", "orch-2"]);
  });
});

describe("validateMissionLogEntryFields", () => {
  test("accepts short structured fields", () => {
    expect(
      validateMissionLogEntryFields({
        kind: "progress",
        intent: "Ship unify-send",
        status: "Linking child asks under mission root",
      }),
    ).toEqual({ ok: true });
  });

  test("rejects empty, non-string, or overly long fields", () => {
    const result = validateMissionLogEntryFields({
      kind: "progress",
      intent: "",
      status: "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twentyone twentytwo twentythree twentyfour twentyfive",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.includes("intent"))).toBe(true);
      expect(result.errors.some((error) => error.includes("status"))).toBe(true);
    }

    const badTypes = validateMissionLogEntryFields({
      kind: "progress",
      // @ts-expect-error untrusted boundary
      intent: undefined,
      // @ts-expect-error untrusted boundary
      status: undefined,
    });
    expect(badTypes.ok).toBe(false);
  });
});
