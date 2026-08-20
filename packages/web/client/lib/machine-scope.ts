import type {
  ActivityItem,
  Agent,
  FleetActivity,
  FleetState,
  SessionEntry,
  WorkDetail,
  WorkItem,
} from "./types.ts";

type AgentIdRecord = {
  agentId?: string | null;
  actorId?: string | null;
  authorityNodeId?: string | null;
  ownerId?: string | null;
  nextMoveOwnerId?: string | null;
  participantIds?: string[];
};

function addIfPresent(set: Set<string>, value: string | null | undefined): void {
  const normalized = value?.trim();
  if (normalized) set.add(normalized);
}

export function agentMachineIds(agent: Agent, localNodeId?: string | null): Set<string> {
  const ids = new Set<string>();
  addIfPresent(ids, agent.authorityNodeId);
  addIfPresent(ids, agent.homeNodeId);
  if (ids.size === 0) addIfPresent(ids, localNodeId);
  return ids;
}

export function agentMatchesMachineScope(
  agent: Agent,
  machineId: string | null,
  localNodeId?: string | null,
): boolean {
  if (!machineId) return true;
  return agentMachineIds(agent, localNodeId).has(machineId);
}

export function filterAgentsByMachineScope(
  agents: Agent[],
  machineId: string | null,
  localNodeId?: string | null,
): Agent[] {
  if (!machineId) return agents;
  return agents.filter((agent) => agentMatchesMachineScope(agent, machineId, localNodeId));
}

export function machineScopedAgentIds(
  agents: Agent[],
  machineId: string | null,
  localNodeId?: string | null,
): Set<string> | null {
  if (!machineId) return null;
  return new Set(
    agents
      .filter((agent) => agentMatchesMachineScope(agent, machineId, localNodeId))
      .map((agent) => agent.id),
  );
}

function idRecordMatchesScope(
  record: AgentIdRecord,
  agentIds: Set<string> | null,
  machineId?: string | null,
): boolean {
  if (!agentIds && !machineId) return true;
  if (machineId && record.authorityNodeId === machineId) return true;
  if (!agentIds) return false;
  if (record.agentId && agentIds.has(record.agentId)) return true;
  if (record.actorId && agentIds.has(record.actorId)) return true;
  if (record.ownerId && agentIds.has(record.ownerId)) return true;
  if (record.nextMoveOwnerId && agentIds.has(record.nextMoveOwnerId)) return true;
  return Boolean(record.participantIds?.some((id) => agentIds.has(id)));
}

export function sessionMatchesMachineScope(
  session: SessionEntry,
  agentIds: Set<string> | null,
  machineId?: string | null,
): boolean {
  return idRecordMatchesScope(session, agentIds, machineId);
}

export function filterSessionsByMachineScope(
  sessions: SessionEntry[],
  agentIds: Set<string> | null,
  machineId?: string | null,
): SessionEntry[] {
  if (!agentIds && !machineId) return sessions;
  return sessions.filter((session) => sessionMatchesMachineScope(session, agentIds, machineId));
}

function activityMatchesMachineScope(
  item: ActivityItem | FleetActivity,
  agentIds: Set<string> | null,
): boolean {
  return idRecordMatchesScope(item as AgentIdRecord, agentIds);
}

export function filterActivityByMachineScope<T extends ActivityItem | FleetActivity>(
  activity: T[],
  agentIds: Set<string> | null,
): T[] {
  if (!agentIds) return activity;
  return activity.filter((item) => activityMatchesMachineScope(item, agentIds));
}

function workItemMatchesMachineScope(work: WorkItem, agentIds: Set<string> | null): boolean {
  return idRecordMatchesScope(work, agentIds);
}

export function filterFleetByMachineScope(
  fleet: FleetState | null,
  agentIds: Set<string> | null,
): FleetState | null {
  if (!fleet || !agentIds) return fleet;
  const activeAsks = fleet.activeAsks.filter((ask) => idRecordMatchesScope(ask, agentIds));
  const recentCompleted = fleet.recentCompleted.filter((ask) => idRecordMatchesScope(ask, agentIds));
  const needsAttention = fleet.needsAttention.filter((item) => idRecordMatchesScope(item, agentIds));
  const activity = filterActivityByMachineScope(fleet.activity, agentIds);
  return {
    ...fleet,
    totals: {
      active: activeAsks.length,
      recentCompleted: recentCompleted.length,
      needsAttention: needsAttention.length,
      activity: activity.length,
    },
    activeAsks,
    recentCompleted,
    needsAttention,
    activity,
  };
}

export function filterWorkDetailByMachineScope(
  detail: WorkDetail,
  agentIds: Set<string> | null,
): WorkDetail | null {
  if (!agentIds) return detail;
  const activeFlights = detail.activeFlights.filter((flight) =>
    idRecordMatchesScope(flight, agentIds),
  );
  const childWork = detail.childWork.filter((work) => workItemMatchesMachineScope(work, agentIds));
  const detailMatches =
    workItemMatchesMachineScope(detail, agentIds)
    || activeFlights.length > 0
    || childWork.length > 0;
  if (!detailMatches) return null;
  return {
    ...detail,
    activeFlights,
    childWork,
  };
}
