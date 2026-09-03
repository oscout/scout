import { isOperatorDm } from "../../lib/conversations.ts";
import {
  filterAgentsByMachineScope,
  filterSessionsByMachineScope,
  machineScopedAgentIds,
} from "../../lib/machine-scope.ts";
import type { Agent, SessionEntry } from "../../lib/types.ts";

function normalizedProjectScope(agent: Agent): string {
  const project = agent.project?.trim().toLowerCase();
  if (project) return `project:${project}`;
  const root = agent.projectRoot?.trim().replace(/\/+$/, "").toLowerCase();
  return root ? `root:${root}` : "project:";
}

function normalizedMachineScope(agent: Agent): string {
  return (agent.authorityNodeId ?? agent.homeNodeId ?? "").trim().toLowerCase();
}

/** Durable identity within one project and machine; never a display-name join. */
export function agentIdentityGroupKey(
  agent: Agent | undefined,
  exactAgentId: string,
): string {
  const definitionId = agent?.definitionId.trim().toLowerCase();
  if (!agent || !definitionId) return `agent:${exactAgentId}`;
  return JSON.stringify([
    "definition",
    definitionId,
    normalizedProjectScope(agent),
    normalizedMachineScope(agent),
  ]);
}

function canonicalAgentOrder(a: Agent, b: Agent): number {
  const aIsDefinition = a.id === a.definitionId ? 0 : 1;
  const bIsDefinition = b.id === b.definitionId ? 0 : 1;
  return aIsDefinition - bIsDefinition || a.id.localeCompare(b.id);
}

export function canonicalAgentForIdentity(
  agents: Iterable<Agent>,
): Agent | undefined {
  return [...agents].sort(canonicalAgentOrder)[0];
}

function sessionMatchesConversationId(
  session: SessionEntry,
  conversationId: string,
): boolean {
  return session.id === conversationId
    || Boolean(session.equivalentConversationIds?.includes(conversationId));
}

function stableSessionOrder(a: SessionEntry, b: SessionEntry): number {
  return (a.agentId ?? "").localeCompare(b.agentId ?? "")
    || a.id.localeCompare(b.id);
}

export type AgentMasterModel = {
  agent: Agent | undefined;
  memberAgentIds: string[];
  sessions: SessionEntry[];
  master: SessionEntry | undefined;
  threads: SessionEntry[];
  thread: SessionEntry | undefined;
};

export function buildAgentMasterModel(input: {
  agentId: string;
  threadId?: string;
  machineId?: string;
  agents: Agent[];
  sessions: SessionEntry[];
}): AgentMasterModel {
  const machineId = input.machineId?.trim() || null;
  const scopedAgents = filterAgentsByMachineScope(input.agents, machineId);
  const scopedAgentIds = machineScopedAgentIds(input.agents, machineId);
  const scopedSessions = filterSessionsByMachineScope(
    input.sessions,
    scopedAgentIds,
    machineId,
  );
  const anchorAgent = scopedAgents.find((agent) => agent.id === input.agentId);
  const anchorKey = agentIdentityGroupKey(anchorAgent, input.agentId);
  const memberAgents = anchorAgent
    ? scopedAgents.filter(
        (agent) => agentIdentityGroupKey(agent, agent.id) === anchorKey,
      )
    : [];
  const memberAgentIds = new Set(memberAgents.map((agent) => agent.id));
  // If discovery lags the conversation list, keep the exact routed identity
  // usable without guessing that another same-named agent is its sibling.
  if (memberAgentIds.size === 0) memberAgentIds.add(input.agentId);

  const sessions = scopedSessions
    .filter(
      (session) =>
        isOperatorDm(session)
        && Boolean(session.agentId && memberAgentIds.has(session.agentId)),
    )
    .sort(
      (a, b) =>
        (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0)
        || stableSessionOrder(a, b),
    );

  const orderedAgents = [...memberAgents].sort(canonicalAgentOrder);
  const agent = orderedAgents[0] ?? anchorAgent;
  let master: SessionEntry | undefined;
  for (const candidate of orderedAgents) {
    if (!candidate.conversationId) continue;
    master = sessions.find((session) =>
      sessionMatchesConversationId(session, candidate.conversationId!),
    );
    if (master) break;
  }
  if (!master && agent) {
    master = [...sessions]
      .filter((session) => session.agentId === agent.id)
      .sort(stableSessionOrder)[0];
  }
  master ??= [...sessions].sort(stableSessionOrder)[0];

  const threads = sessions.filter((session) => session.id !== master?.id);
  const threadIsMaster = Boolean(
    input.threadId
    && master
    && sessionMatchesConversationId(master, input.threadId),
  );
  const thread = input.threadId && !threadIsMaster
    ? sessions.find((session) =>
        sessionMatchesConversationId(session, input.threadId!),
      )
    : undefined;

  return {
    agent,
    memberAgentIds: [...memberAgentIds].sort(),
    sessions,
    master,
    threads,
    thread,
  };
}
