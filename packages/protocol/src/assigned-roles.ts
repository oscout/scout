/**
 * Assigned roles: small explicit duties with hooks and allowed actions.
 *
 * Not agentClass, harness, or identity. No assignment → no hooks → no mission log.
 * First role: orchestrator (mission spine + cheap mission log).
 *
 * See docs/proposals/assigned-roles-and-mission-log.md
 */

import type { MetadataMap, ScoutId } from "./common.js";

/* ── Hook moments ── */

export const SCOUT_ROLE_HOOK_IDS = [
  "mission.started",
  "turn.ended",
  "delegation.created",
  "child.updated",
  "waiting.entered",
  "mission.heartbeat",
  "mission.finished",
] as const;

export type ScoutRoleHookId = (typeof SCOUT_ROLE_HOOK_IDS)[number];

/**
 * Scout-side lifecycle moments (broker fires these; role definitions bind actions).
 * Distinct from optional soft "hooks" the agent may also honor.
 */
export const SCOUT_ROLE_LIFECYCLE_EVENT_IDS = [
  "ask.completed",
  "ask.failed",
  "work.completed",
] as const;

export type ScoutRoleLifecycleEventId = (typeof SCOUT_ROLE_LIFECYCLE_EVENT_IDS)[number];

/** Who must hold the role for a lifecycle binding to run. */
export type ScoutRoleLifecycleWhen = "target" | "requester" | "either";

/* ── Actions (v0 string ids; expand as tools land) ── */

export const SCOUT_MISSION_LOG_APPEND = "mission_log.append" as const;
export const SCOUT_WORK_CHILD_LINK = "work.child_link" as const;
export const SCOUT_WORK_SET_NEXT_MOVE = "work.set_next_move" as const;

export const SCOUT_ROLE_ACTION_IDS = [
  SCOUT_MISSION_LOG_APPEND,
  SCOUT_WORK_CHILD_LINK,
  SCOUT_WORK_SET_NEXT_MOVE,
] as const;

/** Closed set for catalog authoring; open only at untrusted boundaries if needed. */
export type ScoutRoleActionId = (typeof SCOUT_ROLE_ACTION_IDS)[number];

/**
 * Role-owned function at a lifecycle moment.
 * Example: orchestrator → on ask.completed → mission_log.append (post_ask_summary).
 */
export interface ScoutRoleLifecycleBinding {
  on: ScoutRoleLifecycleEventId;
  action: ScoutRoleActionId;
  when: ScoutRoleLifecycleWhen;
  /**
   * Stable function id for logs/telemetry (role-defined name of the behavior).
   * e.g. post_ask_summary, post_work_summary
   */
  functionId: string;
}

/* ── Catalog ── */

export const SCOUT_ORCHESTRATOR_ROLE_ID = "orchestrator" as const;

/** Built-in role ids. Future roles append here and stay closed in the catalog. */
export type ScoutBuiltinRoleId = typeof SCOUT_ORCHESTRATOR_ROLE_ID;

/** Role id on definitions/assignments; catalog rows use built-ins. */
export type ScoutRoleId = ScoutBuiltinRoleId | (string & {});

export interface ScoutRoleDefinition {
  id: ScoutRoleId;
  label: string;
  summary: string;
  hooks: readonly ScoutRoleHookId[];
  actions: readonly ScoutRoleActionId[];
  /**
   * Scout-enforced lifecycle functions for this role.
   * Fired by the broker at ask/work boundaries — not agent-loaded hooks.
   */
  lifecycle?: readonly ScoutRoleLifecycleBinding[];
}

/** Orchestrator lifecycle: auto post-ask / post-work summary into mission log. */
export const SCOUT_ORCHESTRATOR_LIFECYCLE: readonly ScoutRoleLifecycleBinding[] = [
  {
    on: "ask.completed",
    action: SCOUT_MISSION_LOG_APPEND,
    when: "either",
    functionId: "post_ask_summary",
  },
  {
    on: "ask.failed",
    action: SCOUT_MISSION_LOG_APPEND,
    when: "either",
    functionId: "post_ask_summary",
  },
  {
    on: "work.completed",
    action: SCOUT_MISSION_LOG_APPEND,
    when: "target",
    functionId: "post_work_summary",
  },
] as const;

export const SCOUT_ORCHESTRATOR_ROLE: ScoutRoleDefinition = {
  id: SCOUT_ORCHESTRATOR_ROLE_ID,
  label: "Orchestrator",
  summary:
    "Owns a long-running mission spine and keeps a cheap mission log current.",
  hooks: SCOUT_ROLE_HOOK_IDS,
  actions: [
    SCOUT_MISSION_LOG_APPEND,
    SCOUT_WORK_CHILD_LINK,
    SCOUT_WORK_SET_NEXT_MOVE,
  ],
  lifecycle: SCOUT_ORCHESTRATOR_LIFECYCLE,
};

/** Built-in catalog. Future roles (qa, sre, reviewer) append here. */
export const SCOUT_ROLE_CATALOG: readonly ScoutRoleDefinition[] = [
  SCOUT_ORCHESTRATOR_ROLE,
] as const;

/* ── Assignment scope ── */

/**
 * Mission scope uses a work-item id in v0 (campaign root).
 * Agent scope is a standing duty on that agent.
 * Project scope is reserved for Slice 1+ (requires projectRoot in context).
 */
export type ScoutRoleAssignmentScope =
  | { kind: "mission"; missionId: ScoutId }
  | { kind: "agent" }
  | { kind: "project"; projectRoot: string };

export interface ScoutRoleAssignment {
  id: ScoutId;
  roleId: ScoutRoleId;
  agentId: ScoutId;
  scope: ScoutRoleAssignmentScope;
  assignedById: ScoutId;
  assignedAt: number;
  active: boolean;
  revokedAt?: number;
  revokedById?: ScoutId;
  metadata?: MetadataMap;
}

/** Context used to decide whether an assignment applies. */
export interface ScoutRoleScopeContext {
  missionId?: ScoutId;
  projectRoot?: string;
}

/* ── Mission log (situation plane; not chat) ── */

export const SCOUT_MISSION_LOG_KINDS = [
  "heartbeat",
  "progress",
  "delegation",
  "waiting",
  "decision",
  "risk",
  "integration",
  "done",
  "failed",
] as const;

export type ScoutMissionLogKind = (typeof SCOUT_MISSION_LOG_KINDS)[number];

/** Soft limits for writers, tool schemas, and prompts — single source of truth. */
export const SCOUT_MISSION_LOG_LIMITS = {
  intentMaxWords: 16,
  /** Short current-action line (field name: `status`, not `now`). */
  statusMaxWords: 24,
  noteMaxChars: 240,
} as const;

export interface ScoutMissionLogBlocker {
  label: string;
  ownerId?: ScoutId;
  metadata?: MetadataMap;
}

export interface ScoutMissionLogRefs {
  messageId?: ScoutId;
  flightId?: ScoutId;
  workId?: ScoutId;
  sessionId?: ScoutId;
  invocationId?: ScoutId;
}

/**
 * Cheap structured entry written by an assigned orchestrator (or other role
 * that lists mission_log.append). Prefer short intent/status; optional note max
 * one sentence when truly useful.
 *
 * v0 persistence may map only a subset into work.progress + collaboration_events
 * (lossy). Full fidelity wants an append-only log store in Slice 2+.
 */
export interface ScoutMissionLogEntry {
  id: ScoutId;
  /** Work-item id of the campaign root (v0). */
  missionId: ScoutId;
  /** Child work / flight node when the entry is about a branch. */
  nodeId?: ScoutId;
  at: number;
  /** Per-mission monotonic order; avoids same-ms collisions in UI. */
  seq?: number;
  actorId: ScoutId;
  kind: ScoutMissionLogKind;
  /** Stable goal for this node (keep short). */
  intent: string;
  /** Current action / state (keep short). Not a timestamp. */
  status: string;
  checkpoint?: string;
  blockers?: ScoutMissionLogBlocker[];
  refs?: ScoutMissionLogRefs;
  note?: string;
  metadata?: MetadataMap;
}

export interface ScoutMissionLogAppendInput {
  missionId: ScoutId;
  nodeId?: ScoutId;
  actorId: ScoutId;
  kind: ScoutMissionLogKind;
  intent: string;
  status: string;
  checkpoint?: string;
  blockers?: ScoutMissionLogBlocker[];
  refs?: ScoutMissionLogRefs;
  note?: string;
  metadata?: MetadataMap;
  /** Caller-supplied id; store may assign if omitted. */
  id?: ScoutId;
  at?: number;
  seq?: number;
}

/* ── Helpers ── */

export function scoutRoleDefinition(
  roleId: string,
  catalog: readonly ScoutRoleDefinition[] = SCOUT_ROLE_CATALOG,
): ScoutRoleDefinition | undefined {
  return catalog.find((role) => role.id === roleId);
}

export function isScoutRoleHookId(value: string): value is ScoutRoleHookId {
  return (SCOUT_ROLE_HOOK_IDS as readonly string[]).includes(value);
}

export function isScoutMissionLogKind(value: string): value is ScoutMissionLogKind {
  return (SCOUT_MISSION_LOG_KINDS as readonly string[]).includes(value);
}

export function assignmentAppliesTo(
  assignment: ScoutRoleAssignment,
  ctx: ScoutRoleScopeContext,
): boolean {
  switch (assignment.scope.kind) {
    case "agent":
      return true;
    case "mission":
      return ctx.missionId !== undefined
        && assignment.scope.missionId === ctx.missionId;
    case "project":
      return ctx.projectRoot !== undefined
        && assignment.scope.projectRoot === ctx.projectRoot;
    default:
      return false;
  }
}

export function activeScoutRoleAssignments(
  assignments: readonly ScoutRoleAssignment[],
): ScoutRoleAssignment[] {
  return assignments.filter((assignment) => assignment.active);
}

export function scoutRoleAssignmentsForAgent(
  assignments: readonly ScoutRoleAssignment[],
  agentId: string,
  opts?: { activeOnly?: boolean },
): ScoutRoleAssignment[] {
  const activeOnly = opts?.activeOnly ?? true;
  return assignments.filter((assignment) => {
    if (assignment.agentId !== agentId) return false;
    if (activeOnly && !assignment.active) return false;
    return true;
  });
}

export function scoutRoleAssignmentsForMission(
  assignments: readonly ScoutRoleAssignment[],
  missionId: string,
  opts?: {
    activeOnly?: boolean;
    roleId?: string;
    /** Include standing agent-scope assignments (default true for "who covers this mission"). */
    includeStanding?: boolean;
  },
): ScoutRoleAssignment[] {
  const activeOnly = opts?.activeOnly ?? true;
  const includeStanding = opts?.includeStanding ?? true;
  const ctx: ScoutRoleScopeContext = { missionId };

  return assignments.filter((assignment) => {
    if (activeOnly && !assignment.active) return false;
    if (opts?.roleId && assignment.roleId !== opts.roleId) return false;
    if (assignment.scope.kind === "agent") return includeStanding;
    return assignmentAppliesTo(assignment, ctx);
  });
}

/** Distinct agent ids holding an active role for a mission (incl. standing if enabled). */
export function activeRoleHoldersForMission(
  assignments: readonly ScoutRoleAssignment[],
  missionId: string,
  roleId: string,
  opts?: { includeStanding?: boolean },
): ScoutId[] {
  const rows = scoutRoleAssignmentsForMission(assignments, missionId, {
    activeOnly: true,
    roleId,
    includeStanding: opts?.includeStanding ?? true,
  });
  return [...new Set(rows.map((row) => row.agentId))];
}

/**
 * True when this agent may write the mission log for a mission under the
 * anti-spam rules: active assignment whose definition includes mission_log.append
 * and whose scope applies to the mission (or standing agent-scope).
 */
export function agentMayWriteMissionLog(opts: {
  agentId: string;
  missionId: string;
  assignments: readonly ScoutRoleAssignment[];
  catalog?: readonly ScoutRoleDefinition[];
  projectRoot?: string;
}): boolean {
  const catalog = opts.catalog ?? SCOUT_ROLE_CATALOG;
  const ctx: ScoutRoleScopeContext = {
    missionId: opts.missionId,
    projectRoot: opts.projectRoot,
  };

  for (const assignment of opts.assignments) {
    if (!assignment.active) continue;
    if (assignment.agentId !== opts.agentId) continue;
    if (!assignmentAppliesTo(assignment, ctx)) continue;
    const definition = scoutRoleDefinition(assignment.roleId, catalog);
    if (!definition?.actions.includes(SCOUT_MISSION_LOG_APPEND)) continue;
    return true;
  }
  return false;
}

export function roleDefinitionAllowsHook(
  definition: ScoutRoleDefinition,
  hookId: ScoutRoleHookId,
): boolean {
  return definition.hooks.includes(hookId);
}

export function assignmentsMatchingHook(opts: {
  hookId: ScoutRoleHookId;
  assignments: readonly ScoutRoleAssignment[];
  context?: ScoutRoleScopeContext;
  catalog?: readonly ScoutRoleDefinition[];
}): ScoutRoleAssignment[] {
  const catalog = opts.catalog ?? SCOUT_ROLE_CATALOG;
  const ctx = opts.context ?? {};

  return opts.assignments.filter((assignment) => {
    if (!assignment.active) return false;
    if (!assignmentAppliesTo(assignment, ctx)) return false;
    const definition = scoutRoleDefinition(assignment.roleId, catalog);
    if (!definition || !roleDefinitionAllowsHook(definition, opts.hookId)) {
      return false;
    }
    return true;
  });
}

export type MissionLogEntryValidation =
  | { ok: true }
  | { ok: false; errors: string[] };

function wordCount(value: string): number {
  return value.trim().split(/\s+/u).filter(Boolean).length;
}

/** Soft structural validation for writers and tests (untrusted tool args). */
export function validateMissionLogEntryFields(
  input: Pick<ScoutMissionLogAppendInput, "intent" | "status" | "note" | "kind">,
): MissionLogEntryValidation {
  const errors: string[] = [];
  if (typeof input.intent !== "string" || !input.intent.trim()) {
    errors.push("intent is required");
  } else if (wordCount(input.intent) > SCOUT_MISSION_LOG_LIMITS.intentMaxWords) {
    errors.push(`intent should be ≤ ${SCOUT_MISSION_LOG_LIMITS.intentMaxWords} words`);
  }

  if (typeof input.status !== "string" || !input.status.trim()) {
    errors.push("status is required");
  } else if (wordCount(input.status) > SCOUT_MISSION_LOG_LIMITS.statusMaxWords) {
    errors.push(`status should be ≤ ${SCOUT_MISSION_LOG_LIMITS.statusMaxWords} words`);
  }

  if (typeof input.kind !== "string" || !isScoutMissionLogKind(input.kind)) {
    errors.push(`unknown kind: ${String(input.kind)}`);
  }

  if (input.note !== undefined && input.note !== null) {
    if (typeof input.note !== "string") {
      errors.push("note must be a string");
    } else if (input.note.trim().length > SCOUT_MISSION_LOG_LIMITS.noteMaxChars) {
      errors.push(`note should be ≤ ${SCOUT_MISSION_LOG_LIMITS.noteMaxChars} characters`);
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
