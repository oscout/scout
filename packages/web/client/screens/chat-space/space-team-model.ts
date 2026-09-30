/**
 * The space-level team view — a pure aggregation of what each channel's
 * roster and invitation list already serve.
 *
 * There is no space-roster endpoint, and this model never pretends there is:
 * it unions the per-channel reads the surface is already allowed to make, so
 * a channel whose read failed is a reported gap (`channelErrors`), not an
 * absent contribution that would pass for "nobody there".
 */

import type {
  ChannelInvitePublicView,
  ConversationDefinition,
} from "@openscout/protocol";

import type { ChannelMemberView } from "./chat-api.ts";
import {
  isAgentMember,
  memberDisplayName,
  mergeChannelRoster,
} from "./chat-space-model.ts";

/** One channel's contribution to the space read. */
export interface SpaceTeamChannelInput {
  channel: ConversationDefinition;
  /** Null when the roster read failed or was never made — never an empty roster. */
  members: ChannelMemberView[] | null;
  /** Null where the server cannot list invitations, or that read failed. */
  invites: ChannelInvitePublicView[] | null;
  error?: string;
}

export interface TeamAgent {
  member: ChannelMemberView;
  /** Every channel this actor was listed in, in the order first seen. */
  channelIds: string[];
}

export interface TeamPerson {
  member: ChannelMemberView;
  channelIds: string[];
  /** Agents whose owner is this person, sorted by name. */
  agents: TeamAgent[];
}

export interface TeamInvite {
  channel: ConversationDefinition;
  invite: ChannelInvitePublicView;
}

export interface SpaceTeam {
  people: TeamPerson[];
  /** Agents whose `owner` is absent or names nobody in the space's people. */
  unownedAgents: TeamAgent[];
  /** Outstanding invitations only — a revoked or spent one is not outstanding. */
  invites: TeamInvite[];
  channelErrors: Array<{ channel: ConversationDefinition; message: string }>;
}

/**
 * Which of two roster readings of the same actor says more about reception.
 * The winner's live fields stand; identity still merges field-by-field.
 */
function receptionScore(member: ChannelMemberView): number {
  const reception = member.reception;
  if (!reception) return 0;
  let score = 0;
  if (reception.listening) score += 4;
  if (reception.attachedSessionId) score += 2;
  if (reception.evidenceAt) score += 1;
  if (reception.summary?.trim()) score += 1;
  if (reception.detail?.trim()) score += 1;
  return score;
}

/**
 * Fold the per-channel reads into one space team.
 *
 * Members dedupe by `actorId` — the same person in three channels is one
 * person here, holding all three ids. `kind: "unknown"` records are dropped
 * before anything else: they are former members and thin snapshot reads, and
 * neither belongs in a team list. Invitations keep only the live ones and
 * order by how soon they lapse, unexpiring links last.
 */
export function buildSpaceTeam(
  inputs: SpaceTeamChannelInput[],
  viewerActorId: string,
): SpaceTeam {
  const byActor = new Map<string, { member: ChannelMemberView; channelIds: string[] }>();
  const invites: TeamInvite[] = [];
  const channelErrors: SpaceTeam["channelErrors"] = [];

  for (const input of inputs) {
    if (input.error || input.members === null) {
      channelErrors.push({
        channel: input.channel,
        message: input.error ?? "This channel's roster could not be read.",
      });
    }
    for (const member of input.members ?? []) {
      // Former members are nobody's teammate anymore.
      if (member.kind === "unknown") continue;
      const prior = byActor.get(member.actorId);
      if (!prior) {
        byActor.set(member.actorId, { member, channelIds: [input.channel.id] });
        continue;
      }
      if (!prior.channelIds.includes(input.channel.id)) {
        prior.channelIds.push(input.channel.id);
      }
      // mergeChannelRoster lets the second list's fields win; ordering the
      // pair by reception richness keeps the better live reading, and the
      // newer reading takes ties — the last-writer rule a single roster uses.
      const incomingRicher = receptionScore(member) >= receptionScore(prior.member);
      const [previous, next] = incomingRicher
        ? [prior.member, member]
        : [member, prior.member];
      prior.member = mergeChannelRoster([previous], [next])[0] ?? member;
    }
    for (const invite of input.invites ?? []) {
      if (invite.state === "active") invites.push({ channel: input.channel, invite });
    }
  }

  const people: TeamPerson[] = [];
  const agents: TeamAgent[] = [];
  for (const { member, channelIds } of byActor.values()) {
    if (isAgentMember(member)) agents.push({ member, channelIds });
    else people.push({ member, channelIds, agents: [] });
  }

  const byName = (left: ChannelMemberView, right: ChannelMemberView) =>
    memberDisplayName(left).localeCompare(memberDisplayName(right));
  agents.sort((left, right) => byName(left.member, right.member));

  // The viewer first, then everybody else by name — the person reading the
  // panel finds themselves without scanning.
  people.sort((left, right) => {
    const viewerDelta =
      Number(right.member.actorId === viewerActorId)
      - Number(left.member.actorId === viewerActorId);
    if (viewerDelta !== 0) return viewerDelta;
    return byName(left.member, right.member);
  });

  const peopleByActor = new Map(people.map((person) => [person.member.actorId, person]));
  const unownedAgents: TeamAgent[] = [];
  for (const agent of agents) {
    const owner = agent.member.owner?.actorId
      ? peopleByActor.get(agent.member.owner.actorId)
      : undefined;
    if (owner) owner.agents.push(agent);
    else unownedAgents.push(agent);
  }

  invites.sort((left, right) => {
    const a = left.invite.expiresAt;
    const b = right.invite.expiresAt;
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return a - b;
  });

  return { people, unownedAgents, invites, channelErrors };
}
