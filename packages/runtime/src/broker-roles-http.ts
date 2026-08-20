/**
 * Broker HTTP handlers for assigned roles + mission log.
 * Canonical writer path — web proxies here; does not create schema (migrations own DDL).
 */

import { SCOUT_ROLE_CATALOG } from "@openscout/protocol";
import type { ScoutMissionLogAppendInput } from "@openscout/protocol";

import {
  appendMissionLogEntry,
  assignRole,
  listMissionLogEntries,
  listRoleAssignments,
  revokeRole,
  type AssignRoleInput,
  type ListMissionLogOpts,
  type ListRoleAssignmentsOpts,
  type RevokeRoleInput,
} from "./assigned-roles-store.js";
import type { ControlPlaneSqliteDatabase } from "./sqlite-adapter.js";

export type BrokerRolesDb = ControlPlaneSqliteDatabase;

export function brokerRolesCatalog() {
  return { roles: SCOUT_ROLE_CATALOG };
}

export function brokerListRoleAssignments(
  db: BrokerRolesDb,
  opts: ListRoleAssignmentsOpts = {},
) {
  return { assignments: listRoleAssignments(db, opts) };
}

export function brokerAssignRole(db: BrokerRolesDb, input: AssignRoleInput) {
  return { assignment: assignRole(db, input) };
}

export function brokerRevokeRole(db: BrokerRolesDb, input: RevokeRoleInput) {
  return { assignment: revokeRole(db, input) };
}

export function brokerListMissionLog(db: BrokerRolesDb, opts: ListMissionLogOpts) {
  return {
    missionId: opts.missionId,
    entries: listMissionLogEntries(db, opts),
  };
}

export function brokerAppendMissionLog(
  db: BrokerRolesDb,
  input: ScoutMissionLogAppendInput,
  opts?: { projectRoot?: string },
) {
  // Never accept client bypass — permission gate always enforced here.
  return {
    entry: appendMissionLogEntry(db, input, {
      projectRoot: opts?.projectRoot,
    }),
  };
}

export function parseRoleScope(body: {
  kind?: string;
  missionId?: string;
  projectRoot?: string;
}): AssignRoleInput["scope"] {
  const kind = (body.kind ?? "agent").trim();
  if (kind === "mission") {
    const missionId = body.missionId?.trim();
    if (!missionId) throw new Error("scope.missionId is required for mission scope");
    return { kind: "mission", missionId };
  }
  if (kind === "project") {
    const projectRoot = body.projectRoot?.trim();
    if (!projectRoot) throw new Error("scope.projectRoot is required for project scope");
    return { kind: "project", projectRoot };
  }
  if (kind === "agent") {
    return { kind: "agent" };
  }
  throw new Error(`unknown scope.kind: ${kind}`);
}
