import type { ChannelReception } from "@openscout/protocol";

import { normalizeAgentState } from "../../lib/agent-state.ts";
import type { Agent, SessionEntry } from "../../lib/types.ts";

export type ChannelMemberStatus = "working" | "waiting" | "available" | "unknown" | "offline" | "you";

export type ChannelMemberActivity = {
  actorId: string | null;
  status: string;
  updatedAt: number;
  active: boolean;
};

export type ChannelMemberProfile = {
  id: string;
  actorIds: string[];
  name: string;
  detail: string;
  status: ChannelMemberStatus;
  /**
   * The connection plane, kept deliberately separate from `status`.
   *
   * `status` is the activity plane (working/waiting): what this member is
   * doing. `connection` is whether a message would reach them at all. Blending
   * the two is how a surface ends up claiming an unreachable agent is
   * "available", so they never share a field.
   */
  connection: ChannelReception | null;
  lastActivityAt: number | null;
  isOperator: boolean;
  /** A human member. Agents and sessions are not people. */
  isPerson: boolean;
  /** True only for the viewer's own actor. This, not `isOperator`, renders "You". */
  isSelf: boolean;
  agentId: string | null;
  sessionId: string | null;
  preferredRoute: "agent" | "session" | null;
  harness: string | null;
  model: string | null;
  reasoningEffort: string | null;
  workspaceRoot: string | null;
};

type RichParticipant = NonNullable<SessionEntry["participants"]>[number];

const WAITING_ACTIVITY_STATES = new Set([
  "blocked",
  "dispatching",
  "needs attention",
  "needs_attention",
  "pending",
  "queued",
  "waiting",
  "waking",
]);

const WORKING_ACTIVITY_STATES = new Set([
  "active",
  "executing",
  "in progress",
  "in_progress",
  "running",
  "working",
]);

const MEMBER_STATUS_RANK: Record<ChannelMemberStatus, number> = {
  working: 0,
  waiting: 1,
  you: 2,
  available: 3,
  unknown: 4,
  offline: 5,
};

/**
 * Group key for one participant.
 *
 * People are grouped by their own actor id. The previous behaviour folded
 * every `kind === "person"` participant into a single "operator" group, which
 * is right for the single-operator shell and wrong the moment a channel has
 * two humans in it: a teammate would have been absorbed into the viewer.
 * `"operator"` survives as a key only for the literal local operator actor,
 * so operator-shell data groups exactly as it did before.
 */
function participantGroupKey(participant: RichParticipant): string {
  if (participant.actorId === "operator") return "operator";
  if (participant.kind === "person") return `person:${participant.actorId}`;
  if (participant.sessionId?.trim()) return `session:${participant.sessionId.trim()}`;
  if (participant.agentId?.trim()) return `agent:${participant.agentId.trim()}`;
  return `actor:${participant.actorId}`;
}

function preferredParticipant(group: RichParticipant[]): RichParticipant {
  return group.find((participant) => participant.kind === "session") ?? group[0]!;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function matchingAgent(group: RichParticipant[], agents: Agent[]): Agent | null {
  const identities = new Set(uniqueStrings(group.flatMap((participant) => [
    participant.agentId,
    participant.actorId,
  ])));
  return agents.find((agent) => identities.has(agent.id)) ?? null;
}

function activityStatus(activity: ChannelMemberActivity[]): ChannelMemberStatus | null {
  if (activity.length === 0) return null;
  const states = activity.map((item) => item.status.trim().toLowerCase());
  if (states.some((state) => WORKING_ACTIVITY_STATES.has(state))) return "working";
  if (states.some((state) => WAITING_ACTIVITY_STATES.has(state))) return "waiting";
  // An active work record without execution proof is pending context, not
  // proof that an agent is currently running.
  return "waiting";
}

function fallbackParticipant(participantId: string, agents: Agent[]): RichParticipant {
  const agent = agents.find((candidate) => candidate.id === participantId);
  return {
    actorId: participantId,
    kind: participantId === "operator" ? "person" : "agent",
    displayName: participantId === "operator" ? "Operator" : (agent?.name ?? participantId),
    label: participantId === "operator" ? "Operator" : (agent?.name ?? participantId),
    scopedAlias: agent?.handle ?? null,
    agentId: agent?.id ?? null,
    sessionId: agent?.harnessSessionId ?? null,
    harness: agent?.harness ?? null,
    transport: agent?.transport ?? null,
    workspaceRoot: agent?.projectRoot ?? agent?.cwd ?? null,
  };
}

export function channelDisplayLabel(session: SessionEntry | null, channelId: string): string {
  const alias = session?.alias?.trim();
  if (alias) return alias.startsWith("#") ? alias : `#${alias}`;
  const title = session?.title?.trim();
  if (title) return title.startsWith("#") ? title : `#${title}`;
  return channelId;
}

export function sharedChannelWorkspace(members: ChannelMemberProfile[]): string | null {
  // People have no workspace. Filtering on `isOperator` used to be equivalent
  // because every person was the operator; with distinct humans it would let a
  // second teammate's empty workspace break the inference.
  const roots = uniqueStrings(
    members.filter((member) => !member.isPerson).map((member) => member.workspaceRoot),
  );
  if (roots.length !== 1) return null;
  return roots[0]!.split(/[\\/]/).filter(Boolean).at(-1) ?? roots[0]!;
}

/**
 * Build the member list for a channel, from the viewer's point of view.
 *
 * `viewerActorId` decides only which member renders as "You" -- it never
 * changes who is a member or how participants group. The operator shell passes
 * nothing and gets the local operator, which reproduces its previous output
 * exactly. `receptionByActorId` carries the connection plane when the caller
 * has it; without it members simply have no connection claim, which is the
 * honest default.
 */
export function buildChannelMembers(
  session: SessionEntry | null,
  agents: Agent[],
  activity: ChannelMemberActivity[],
  options?: {
    viewerActorId?: string | null;
    receptionByActorId?: Record<string, ChannelReception>;
  },
): ChannelMemberProfile[] {
  if (!session) return [];

  const viewerActorId = options?.viewerActorId?.trim() || "operator";
  const receptionByActorId = options?.receptionByActorId ?? {};

  const richByActorId = new Map(
    (session.participants ?? []).map((participant) => [participant.actorId, participant]),
  );
  const participants = session.participantIds.map((participantId) =>
    richByActorId.get(participantId) ?? fallbackParticipant(participantId, agents)
  );
  const groups = new Map<string, RichParticipant[]>();
  for (const participant of participants) {
    const key = participantGroupKey(participant);
    groups.set(key, [...(groups.get(key) ?? []), participant]);
  }

  return [...groups.entries()].map<ChannelMemberProfile>(([id, group]) => {
    const primary = preferredParticipant(group);
    const agent = matchingAgent(group, agents);
    const actorIds = uniqueStrings(group.flatMap((participant) => [
      participant.actorId,
      participant.agentId,
      participant.sessionId,
    ]));
    const actorIdSet = new Set(actorIds);
    const memberActivity = activity.filter(
      (item) => item.active && item.actorId && actorIdSet.has(item.actorId),
    );
    const isOperator = id === "operator";
    const isPerson = group.some((participant) => participant.kind === "person")
      || isOperator;
    const isSelf = actorIds.includes(viewerActorId);
    const connection = actorIds
      .map((candidate) => receptionByActorId[candidate])
      .find((candidate): candidate is ChannelReception => Boolean(candidate)) ?? null;
    const channelStatus = activityStatus(memberActivity);
    const rawAgentState = agent?.state?.trim().toLowerCase();
    const fallbackStatus: ChannelMemberStatus = !agent
      ? "unknown"
      : normalizeAgentState(agent.state, agent) === "blocked" || rawAgentState === "offline"
        ? "offline"
        : "available";
    const status: ChannelMemberStatus = isSelf
      ? "you"
      : (channelStatus ?? fallbackStatus);
    const name = isSelf
      ? "You"
      : (primary.scopedAlias?.trim() || primary.displayName.trim() || primary.actorId);
    const detailParts = uniqueStrings([
      !isSelf && primary.displayName.trim() !== name ? primary.displayName : null,
      primary.harness,
    ]);
    const primaryIsSession = primary.kind === "session";
    const sessionId = primary.sessionId?.trim() || agent?.harnessSessionId?.trim() || null;
    const agentId = agent?.id ?? group.find((participant) => participant.agentId)?.agentId ?? null;

    return {
      id,
      actorIds,
      name,
      detail: isSelf ? "In channel" : (detailParts.join(" · ") || primary.label),
      status,
      lastActivityAt: memberActivity.length > 0
        ? Math.max(...memberActivity.map((item) => item.updatedAt))
        : agent?.updatedAt ?? null,
      isOperator,
      isPerson,
      isSelf,
      connection,
      agentId,
      sessionId,
      preferredRoute: isSelf
        ? null
        : primaryIsSession && sessionId
          ? "session"
          : agentId
            ? "agent"
            : sessionId
              ? "session"
              : null,
      harness: primary.harness ?? agent?.harness ?? null,
      model: agent?.model ?? null,
      reasoningEffort: agent?.reasoningEffort ?? null,
      workspaceRoot: primary.workspaceRoot ?? agent?.projectRoot ?? agent?.cwd ?? null,
    };
  }).sort((left, right) => {
    const statusDelta = MEMBER_STATUS_RANK[left.status] - MEMBER_STATUS_RANK[right.status];
    if (statusDelta !== 0) return statusDelta;
    const activityDelta = (right.lastActivityAt ?? 0) - (left.lastActivityAt ?? 0);
    if (activityDelta !== 0) return activityDelta;
    return left.name.localeCompare(right.name);
  });
}

export function channelMemberForActor(
  members: ChannelMemberProfile[],
  actorId: string | null,
): ChannelMemberProfile | null {
  if (!actorId) return null;
  return members.find((member) => member.actorIds.includes(actorId)) ?? null;
}

export function channelMemberStatusLabel(status: ChannelMemberStatus): string {
  switch (status) {
    case "working": return "Working";
    case "waiting": return "Waiting";
    case "available": return "Available";
    case "unknown": return "Unknown";
    case "offline": return "Offline";
    case "you": return "You";
  }
}
