/**
 * Soft-mode prompt fragment for agents with an active orchestrator assignment.
 * Inject into the agent system/tool preamble when assignment is present.
 */

import {
  SCOUT_MISSION_LOG_LIMITS,
  SCOUT_ORCHESTRATOR_ROLE,
  type ScoutRoleAssignment,
} from "./assigned-roles.js";

export function orchestratorSoftPrompt(opts: {
  assignment: ScoutRoleAssignment;
  missionId?: string;
}): string {
  const missionLine =
    opts.assignment.scope.kind === "mission"
      ? `Mission (work id): ${opts.assignment.scope.missionId}`
      : opts.missionId
        ? `Active mission context: ${opts.missionId} (standing orchestrator assignment)`
        : "Standing orchestrator: prefer mission-scoped assignment when a campaign exists.";

  return [
    `# Orchestrator role (assigned)`,
    "",
    `You are assigned the **${SCOUT_ORCHESTRATOR_ROLE.label}** role.`,
    SCOUT_ORCHESTRATOR_ROLE.summary,
    missionLine,
    "",
    "## Duties",
    "- Own the mission spine: keep child work/asks linked under the campaign root.",
    "- On mission moments (turn end, delegation, waiting, finish), append a short mission log entry.",
    "- When blocked, set who holds the next move.",
    "- Do not spam: only mission-level moments, not every tool call.",
    "",
    "## Mission log fields",
    `- intent: stable goal (≤ ${SCOUT_MISSION_LOG_LIMITS.intentMaxWords} words)`,
    `- status: current action (≤ ${SCOUT_MISSION_LOG_LIMITS.statusMaxWords} words)`,
    `- kind: heartbeat | progress | delegation | waiting | decision | risk | integration | done | failed`,
    `- note: optional, ≤ ${SCOUT_MISSION_LOG_LIMITS.noteMaxChars} chars`,
    "",
    "## How to write",
    "- CLI: `scout role log-append <missionId> --actor <you> --kind progress --intent \"...\" --status \"...\"`",
    "- HTTP: `POST /api/missions/<missionId>/log` with actorId, kind, intent, status",
    "- Verbose chat stays in DMs; mission log is the cheap reconstruction stream.",
  ].join("\n");
}
