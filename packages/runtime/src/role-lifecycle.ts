/**
 * Scout-side role lifecycle: at ask/work completion, run role-defined functions
 * (e.g. orchestrator post_ask_summary → mission_log.append).
 *
 * Agents stay free; this is broker verification + cheap visibility, not a
 * rigid workflow engine.
 */

import {
  SCOUT_MISSION_LOG_APPEND,
  SCOUT_ROLE_CATALOG,
  assignmentAppliesTo,
  scoutRoleDefinition,
  type ScoutMissionLogAppendInput,
  type ScoutMissionLogKind,
  type ScoutRoleAssignment,
  type ScoutRoleDefinition,
  type ScoutRoleLifecycleBinding,
  type ScoutRoleLifecycleEventId,
} from "@openscout/protocol";
import type { FlightRecord, InvocationRequest } from "@openscout/protocol";

import {
  appendMissionLogEntry,
  listMissionLogEntries,
  listRoleAssignments,
} from "./assigned-roles-store.js";
import type { ControlPlaneSqliteDatabase } from "./sqlite-adapter.js";

export type RoleLifecycleAskEvent = {
  lifecycle: "ask.completed" | "ask.failed";
  flight: FlightRecord;
  invocation?: InvocationRequest | null;
  /** Optional project root for project-scoped assignment matching. */
  projectRoot?: string | null;
};

function projectRootFromInvocation(
  invocation?: InvocationRequest | null,
  flight?: FlightRecord | null,
): string | null {
  return (
    metadataString(invocation?.metadata as Record<string, unknown> | undefined, "projectRoot")
    || metadataString(invocation?.metadata as Record<string, unknown> | undefined, "projectPath")
    || metadataString(invocation?.metadata as Record<string, unknown> | undefined, "cwd")
    || metadataString(flight?.metadata as Record<string, unknown> | undefined, "projectRoot")
    || metadataString(flight?.metadata as Record<string, unknown> | undefined, "projectPath")
    || metadataString(flight?.metadata as Record<string, unknown> | undefined, "cwd")
    || null
  );
}

export type RoleLifecycleWorkEvent = {
  lifecycle: "work.completed";
  workId: string;
  /** Agent treated as "target" for when: target bindings (usually owner). */
  agentId: string;
  title?: string | null;
  summary?: string | null;
  state?: string | null;
  projectRoot?: string | null;
};

export type RoleLifecycleEvent = RoleLifecycleAskEvent | RoleLifecycleWorkEvent;

export type PlannedMissionLogWrite = {
  assignment: ScoutRoleAssignment;
  binding: ScoutRoleLifecycleBinding;
  input: ScoutMissionLogAppendInput;
};

function wordClamp(text: string, maxWords: number): string {
  const words = text.replace(/\s+/gu, " ").trim().split(" ").filter(Boolean);
  if (words.length <= maxWords) return words.join(" ");
  return `${words.slice(0, maxWords).join(" ")}…`;
}

function firstLine(text: string | null | undefined, maxChars = 200): string {
  const line = (text ?? "")
    .split(/\r?\n/u)
    .map((part) => part.trim())
    .find(Boolean);
  if (!line) return "";
  return line.length > maxChars ? `${line.slice(0, maxChars - 1)}…` : line;
}

function metadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Mission/work id carried by the lifecycle event (not the assignment). */
function eventMissionId(event: RoleLifecycleEvent): string | null {
  if (event.lifecycle === "work.completed") {
    return event.workId.trim() || null;
  }
  const invocation = event.invocation;
  const flight = event.flight;
  return (
    invocation?.collaborationRecordId?.trim()
    || metadataString(invocation?.metadata as Record<string, unknown> | undefined, "workId")
    || metadataString(invocation?.metadata as Record<string, unknown> | undefined, "collaborationRecordId")
    || metadataString(flight?.metadata as Record<string, unknown> | undefined, "workId")
    || metadataString(flight?.metadata as Record<string, unknown> | undefined, "collaborationRecordId")
    || null
  );
}

/**
 * Resolve the mission sink for a write: assignment must apply to the event's
 * mission/project. Mission-scoped orchestrators only log events for *that*
 * mission (no cross-mission leak).
 */
function resolveMissionIdForAssignment(
  assignment: ScoutRoleAssignment,
  event: RoleLifecycleEvent,
): string | null {
  const missionId = eventMissionId(event);
  const projectRoot =
    event.lifecycle === "work.completed"
      ? event.projectRoot
      : event.projectRoot;

  if (!assignmentAppliesTo(assignment, {
    missionId: missionId ?? undefined,
    projectRoot: projectRoot?.trim() || undefined,
  })) {
    return null;
  }

  if (assignment.scope.kind === "mission") {
    // Event must already match (via assignmentAppliesTo); log into that mission.
    return assignment.scope.missionId;
  }

  // Standing agent / project scope: only log when the event has a concrete mission.
  return missionId;
}

function holderMatches(
  when: ScoutRoleLifecycleBinding["when"],
  assignmentAgentId: string,
  targetId: string | null | undefined,
  requesterId: string | null | undefined,
): boolean {
  const isTarget = Boolean(targetId && assignmentAgentId === targetId);
  const isRequester = Boolean(requesterId && assignmentAgentId === requesterId);
  if (when === "target") return isTarget;
  if (when === "requester") return isRequester;
  return isTarget || isRequester;
}

function logKindForAsk(lifecycle: "ask.completed" | "ask.failed", asRequester: boolean): ScoutMissionLogKind {
  if (lifecycle === "ask.failed") return "failed";
  return asRequester ? "integration" : "progress";
}

function buildAskSummaryInput(opts: {
  assignment: ScoutRoleAssignment;
  binding: ScoutRoleLifecycleBinding;
  event: RoleLifecycleAskEvent;
  missionId: string;
}): ScoutMissionLogAppendInput {
  const { assignment, binding, event, missionId } = opts;
  const flight = event.flight;
  const invocation = event.invocation;
  const asRequester = assignment.agentId === (invocation?.requesterId ?? flight.requesterId);
  const task = (invocation?.task ?? "").trim();
  const rawStatus =
    firstLine(flight.summary)
    || firstLine(flight.output)
    || firstLine(flight.error)
    || (event.lifecycle === "ask.failed" ? "Ask failed" : "Ask completed");

  const targetLabel = flight.targetAgentId;
  const status = asRequester
    ? wordClamp(`${targetLabel}: ${rawStatus}`, 24)
    : wordClamp(rawStatus, 24);

  const intent = wordClamp(
    task || (asRequester ? "Orchestrated ask" : "Orchestrator turn"),
    16,
  );

  return {
    missionId,
    actorId: assignment.agentId,
    kind: logKindForAsk(event.lifecycle, asRequester),
    intent,
    status,
    checkpoint: asRequester
      ? wordClamp(`Child ask ${flight.id} → ${flight.state}`, 24)
      : undefined,
    refs: {
      flightId: flight.id,
      invocationId: flight.invocationId,
      ...(missionId.startsWith("work-") || missionId.includes("work")
        ? { workId: missionId }
        : {}),
      ...(invocation?.collaborationRecordId
        ? { workId: invocation.collaborationRecordId }
        : {}),
    },
    metadata: {
      source: "role_lifecycle",
      lifecycle: event.lifecycle,
      functionId: binding.functionId,
      roleId: assignment.roleId,
      assignmentId: assignment.id,
      flightState: flight.state,
      asRequester,
      asTarget: assignment.agentId === flight.targetAgentId,
    },
  };
}

function buildWorkSummaryInput(opts: {
  assignment: ScoutRoleAssignment;
  binding: ScoutRoleLifecycleBinding;
  event: RoleLifecycleWorkEvent;
  missionId: string;
}): ScoutMissionLogAppendInput {
  const { assignment, binding, event, missionId } = opts;
  const title = (event.title ?? "").trim() || "Work item";
  const summary = firstLine(event.summary) || event.state || "done";
  return {
    missionId,
    actorId: assignment.agentId,
    kind: "done",
    intent: wordClamp(title, 16),
    status: wordClamp(summary, 24),
    refs: { workId: event.workId },
    metadata: {
      source: "role_lifecycle",
      lifecycle: event.lifecycle,
      functionId: binding.functionId,
      roleId: assignment.roleId,
      assignmentId: assignment.id,
      workState: event.state ?? "done",
    },
  };
}

/**
 * Pure planner: given event + assignments, which mission_log writes should run?
 * No I/O — unit-test friendly.
 */
export function planRoleLifecycleMissionLogs(
  event: RoleLifecycleEvent,
  assignments: readonly ScoutRoleAssignment[],
  catalog: readonly ScoutRoleDefinition[] = SCOUT_ROLE_CATALOG,
): PlannedMissionLogWrite[] {
  const lifecycleId: ScoutRoleLifecycleEventId = event.lifecycle;
  const planned: PlannedMissionLogWrite[] = [];

  const targetId =
    event.lifecycle === "work.completed"
      ? event.agentId
      : event.flight.targetAgentId;
  const requesterId =
    event.lifecycle === "work.completed"
      ? null
      : (event.invocation?.requesterId ?? event.flight.requesterId ?? null);

  for (const assignment of assignments) {
    if (!assignment.active) continue;
    const definition = scoutRoleDefinition(assignment.roleId, catalog);
    if (!definition?.lifecycle?.length) continue;

    for (const binding of definition.lifecycle) {
      if (binding.on !== lifecycleId) continue;
      if (binding.action !== SCOUT_MISSION_LOG_APPEND) continue;
      if (!holderMatches(binding.when, assignment.agentId, targetId, requesterId)) {
        continue;
      }
      if (!definition.actions.includes(SCOUT_MISSION_LOG_APPEND)) continue;

      const missionId = resolveMissionIdForAssignment(assignment, event);
      if (!missionId) continue;

      const input =
        event.lifecycle === "work.completed"
          ? buildWorkSummaryInput({ assignment, binding, event, missionId })
          : buildAskSummaryInput({ assignment, binding, event, missionId });

      planned.push({ assignment, binding, input });
    }
  }

  return planned;
}

function alreadyLoggedFlight(
  db: ControlPlaneSqliteDatabase,
  missionId: string,
  flightId: string,
): boolean {
  const entries = listMissionLogEntries(db, { missionId, limit: 50 });
  return entries.some((entry) => entry.refs?.flightId === flightId);
}

function alreadyLoggedWork(
  db: ControlPlaneSqliteDatabase,
  missionId: string,
  workId: string,
  functionId: string,
): boolean {
  const entries = listMissionLogEntries(db, { missionId, limit: 50 });
  return entries.some(
    (entry) =>
      entry.refs?.workId === workId
      && entry.metadata?.functionId === functionId
      && entry.kind === "done",
  );
}

export type ApplyRoleLifecycleResult = {
  planned: number;
  written: number;
  skipped: number;
  errors: string[];
};

/**
 * Apply role lifecycle for a terminal ask (flight completed/failed/cancelled).
 */
export function applyRoleLifecycleForTerminalFlight(
  db: ControlPlaneSqliteDatabase,
  input: {
    flight: FlightRecord;
    invocation?: InvocationRequest | null;
    /** Only fire when transitioning into terminal (caller responsibility). */
  },
): ApplyRoleLifecycleResult {
  const flight = input.flight;
  const terminal =
    flight.state === "completed"
    || flight.state === "failed"
    || flight.state === "cancelled";
  if (!terminal) {
    return { planned: 0, written: 0, skipped: 0, errors: [] };
  }

  const lifecycle: RoleLifecycleAskEvent["lifecycle"] =
    flight.state === "completed" ? "ask.completed" : "ask.failed";

  const agentIds = new Set<string>();
  agentIds.add(flight.targetAgentId);
  const requesterId = input.invocation?.requesterId ?? flight.requesterId;
  if (requesterId) agentIds.add(requesterId);

  const assignments: ScoutRoleAssignment[] = [];
  for (const agentId of agentIds) {
    assignments.push(
      ...listRoleAssignments(db, { agentId, activeOnly: true, limit: 50 }),
    );
  }

  const planned = planRoleLifecycleMissionLogs(
    {
      lifecycle,
      flight,
      invocation: input.invocation,
      projectRoot: projectRootFromInvocation(input.invocation, flight),
    },
    assignments,
  );

  let written = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const item of planned) {
    try {
      if (
        item.input.refs?.flightId
        && alreadyLoggedFlight(db, item.input.missionId, item.input.refs.flightId)
      ) {
        skipped += 1;
        continue;
      }
      appendMissionLogEntry(db, item.input, { bypassPermission: true });
      written += 1;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  return { planned: planned.length, written, skipped, errors };
}

/**
 * Apply role lifecycle when a work item reaches a terminal success state.
 */
export function applyRoleLifecycleForWorkCompleted(
  db: ControlPlaneSqliteDatabase,
  input: {
    workId: string;
    agentId: string;
    title?: string | null;
    summary?: string | null;
    state?: string | null;
  },
): ApplyRoleLifecycleResult {
  const assignments = listRoleAssignments(db, {
    agentId: input.agentId,
    activeOnly: true,
    limit: 50,
  });

  const planned = planRoleLifecycleMissionLogs(
    {
      lifecycle: "work.completed",
      workId: input.workId,
      agentId: input.agentId,
      title: input.title,
      summary: input.summary,
      state: input.state,
    },
    assignments,
  );

  let written = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const item of planned) {
    try {
      if (
        alreadyLoggedWork(
          db,
          item.input.missionId,
          input.workId,
          item.binding.functionId,
        )
      ) {
        skipped += 1;
        continue;
      }
      appendMissionLogEntry(db, item.input, { bypassPermission: true });
      written += 1;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  return { planned: planned.length, written, skipped, errors };
}
