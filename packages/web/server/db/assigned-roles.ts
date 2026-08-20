/**
 * Assigned roles + mission log — web proxies to the broker (canonical writer).
 * Does not open control-plane SQLite or CREATE TABLE (migrations + broker only).
 */

import type {
  ScoutMissionLogAppendInput,
  ScoutMissionLogEntry,
  ScoutRoleAssignment,
} from "@openscout/protocol";
import type {
  AssignRoleInput,
  ListMissionLogOpts,
  ListRoleAssignmentsOpts,
  RevokeRoleInput,
} from "@openscout/runtime";

import {
  resolveScoutBrokerUrl,
} from "../core/broker/service.ts";
import {
  requestScoutBrokerJson,
} from "@openscout/runtime/broker-api";
import {
  resolveBrokerSocketPathForBaseUrl,
} from "@openscout/runtime/broker-process-manager";

async function brokerGet<T>(path: string): Promise<T> {
  const baseUrl = resolveScoutBrokerUrl();
  return requestScoutBrokerJson<T>(baseUrl, path, {
    socketPath: resolveBrokerSocketPathForBaseUrl(baseUrl),
  });
}

async function brokerPost<T>(path: string, body: unknown): Promise<T> {
  const baseUrl = resolveScoutBrokerUrl();
  return requestScoutBrokerJson<T>(baseUrl, path, {
    method: "POST",
    body,
    socketPath: resolveBrokerSocketPathForBaseUrl(baseUrl),
  });
}

export async function webListRoleAssignments(
  opts: ListRoleAssignmentsOpts = {},
): Promise<ScoutRoleAssignment[]> {
  const params = new URLSearchParams();
  if (opts.agentId) params.set("agentId", opts.agentId);
  if (opts.missionId) params.set("missionId", opts.missionId);
  if (opts.roleId) params.set("roleId", opts.roleId);
  if (opts.activeOnly === false) params.set("activeOnly", "0");
  if (opts.includeStanding === false) params.set("includeStanding", "0");
  if (opts.limit != null) params.set("limit", String(opts.limit));
  const qs = params.toString();
  const data = await brokerGet<{ assignments: ScoutRoleAssignment[] }>(
    `/v1/roles/assignments${qs ? `?${qs}` : ""}`,
  );
  return data.assignments ?? [];
}

export async function webAssignRole(input: AssignRoleInput): Promise<ScoutRoleAssignment> {
  const data = await brokerPost<{ assignment: ScoutRoleAssignment }>(
    "/v1/roles/assignments",
    input,
  );
  return data.assignment;
}

export async function webRevokeRole(input: RevokeRoleInput): Promise<ScoutRoleAssignment> {
  const data = await brokerPost<{ assignment: ScoutRoleAssignment }>(
    `/v1/roles/assignments/${encodeURIComponent(input.assignmentId)}/revoke`,
    { revokedById: input.revokedById },
  );
  return data.assignment;
}

export async function webListMissionLog(
  opts: ListMissionLogOpts,
): Promise<ScoutMissionLogEntry[]> {
  const params = new URLSearchParams();
  if (opts.limit != null) params.set("limit", String(opts.limit));
  if (opts.afterSeq != null) params.set("afterSeq", String(opts.afterSeq));
  const qs = params.toString();
  const data = await brokerGet<{ entries: ScoutMissionLogEntry[] }>(
    `/v1/missions/${encodeURIComponent(opts.missionId)}/log${qs ? `?${qs}` : ""}`,
  );
  return data.entries ?? [];
}

export async function webAppendMissionLog(
  input: ScoutMissionLogAppendInput,
  opts?: { projectRoot?: string },
): Promise<ScoutMissionLogEntry> {
  // Never forward bypassPermission — broker enforces the assignment gate.
  const data = await brokerPost<{ entry: ScoutMissionLogEntry }>(
    `/v1/missions/${encodeURIComponent(input.missionId)}/log`,
    {
      actorId: input.actorId,
      kind: input.kind,
      intent: input.intent,
      status: input.status,
      checkpoint: input.checkpoint,
      nodeId: input.nodeId,
      note: input.note,
      blockers: input.blockers,
      refs: input.refs,
      projectRoot: opts?.projectRoot,
    },
  );
  return data.entry;
}
