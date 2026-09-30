/**
 * The Team panel: the whole space's people, their agents, and every
 * outstanding invitation, in one read-only aside.
 *
 * It is an aggregation, not a new API — every row came out of a per-channel
 * roster or invitation read the surface was already allowed to make. A
 * channel that refused is named at the bottom as a gap in the picture, and a
 * capability the server lacks is said to be absent rather than implied by an
 * empty list.
 */

import { useChatCapabilities } from "./chat-transport.tsx";
import { MemberAvatar } from "./ChatAvatar.tsx";
import { InviteRow, MemberRow } from "./ChatRightPanel.tsx";
import {
  canRevokeInvite,
  channelLabel,
  isApiParticipant,
  memberDisplayName,
} from "./chat-space-model.ts";
import type { SpaceTeam, TeamAgent } from "./space-team-model.ts";

/**
 * An owned agent nested under its person. The fact it trails is the route the
 * membership actually has — `via API` for a polling participant, the harness
 * name otherwise — plus how many of the space's channels it sits in.
 */
function TeamAgentRow({
  agent,
  onOpen,
}: {
  agent: TeamAgent;
  onOpen: (actorId: string, channelId: string) => void;
}) {
  const member = agent.member;
  const count = agent.channelIds.length;
  const fact = [
    isApiParticipant(member) ? "via API" : member.harness?.trim() || null,
    `in ${count} ${count === 1 ? "channel" : "channels"}`,
  ].filter(Boolean).join(" · ");
  return (
    <button
      type="button"
      className="chat-member-row chat-team-agent-row"
      onClick={() => onOpen(member.actorId, agent.channelIds[0]!)}
    >
      <MemberAvatar member={member} size={24} />
      <span className="chat-member-name">{memberDisplayName(member)}</span>
      <span className="chat-member-fact">{fact}</span>
    </button>
  );
}

export function TeamPanel({
  spaceTitle,
  team,
  loading,
  nowMs,
  viewerActorId,
  viewerIsOperator,
  revokingInviteId,
  inviteError,
  onOpenMember,
  onRevokeInvite,
  onInvite,
  inviteDisabled,
  onClose,
  overlay,
}: {
  /** The space's own title — the panel's scope is the space, not a channel. */
  spaceTitle: string;
  team: SpaceTeam | null;
  loading: boolean;
  nowMs: number;
  viewerActorId: string;
  viewerIsOperator: boolean;
  revokingInviteId: string | null;
  inviteError?: string | null;
  onOpenMember: (actorId: string, channelId: string) => void;
  onRevokeInvite: (channelId: string, inviteId: string) => void;
  onInvite: () => void;
  /** True when the space holds no channel an invitation could name. */
  inviteDisabled: boolean;
  onClose: () => void;
  overlay: boolean;
}) {
  const capabilities = useChatCapabilities();

  return (
    <aside className="chat-rpanel" data-overlay={overlay} aria-label="Team">
      <header className="chat-rpanel-head">
        <span className="chat-rpanel-title">Team</span>
        <span className="chat-rpanel-scope">{spaceTitle}</span>
        <button type="button" className="chat-rpanel-close" onClick={onClose} aria-label="Close panel">
          ×
        </button>
      </header>
      <div className="chat-rpanel-body">
        {loading && !team ? (
          <p className="chat-feed-notice">Reading the roster…</p>
        ) : null}

        {team ? (
          <>
            <div className="chat-psec">
              <span className="label-sm">People</span>
              {team.people.length === 0 ? (
                <p className="chat-feed-notice">The roster is empty.</p>
              ) : (
                team.people.map((person) => (
                  <div key={person.member.actorId}>
                    <MemberRow
                      member={person.member}
                      viewerActorId={viewerActorId}
                      onOpen={(actorId) => onOpenMember(actorId, person.channelIds[0]!)}
                    />
                    {person.agents.map((agent) => (
                      <TeamAgentRow key={agent.member.actorId} agent={agent} onOpen={onOpenMember} />
                    ))}
                  </div>
                ))
              )}
            </div>

            {team.unownedAgents.length > 0 ? (
              <div className="chat-psec">
                <span className="label-sm">Agents without an owner</span>
                {team.unownedAgents.map((agent) => (
                  <TeamAgentRow key={agent.member.actorId} agent={agent} onOpen={onOpenMember} />
                ))}
              </div>
            ) : null}

            <div className="chat-psec">
              <span className="label-sm">Invitations</span>
              {inviteError ? <p className="chat-sheet-error" role="alert">{inviteError}</p> : null}
              {/* The same claim the members panel makes: "not listed" and
                  "none outstanding" are different statements, and only one is
                  true on a server with no listing endpoint. */}
              {!capabilities.inviteList ? (
                <p className="chat-feed-notice">
                  This server does not list outstanding invitations. A link is shown once,
                  when you create it.
                </p>
              ) : team.invites.length === 0 ? (
                <p className="chat-feed-notice">No outstanding invitations.</p>
              ) : (
                team.invites.map(({ channel, invite }) => (
                  <InviteRow
                    key={`${channel.id}:${invite.id}`}
                    invite={invite}
                    nowMs={nowMs}
                    prefix={
                      <span className="chat-team-invite-channel">{channelLabel(channel.title)}</span>
                    }
                    onRevoke={(inviteId) => onRevokeInvite(channel.id, inviteId)}
                    busy={Boolean(revokingInviteId)}
                    canRevoke={capabilities.inviteRevoke && canRevokeInvite(invite, {
                      actorId: viewerActorId,
                      isOperator: viewerIsOperator,
                    })}
                  />
                ))
              )}
            </div>

            {!capabilities.memberRemove ? (
              <div className="chat-psec">
                <span className="label-sm">Removing members</span>
                <p className="chat-feed-notice">
                  This server does not support removing members yet. Revoke an agent's
                  invitation to stop new sessions from joining.
                </p>
              </div>
            ) : null}

            {team.channelErrors.map(({ channel, message }) => (
              <p key={channel.id} className="chat-feed-notice" data-tone="error">
                {channelLabel(channel.title)} · {message}
              </p>
            ))}

            {!capabilities.invitesRequireOwner || viewerIsOperator ? <div className="chat-psec" style={{ marginTop: "auto" }}>
              <button
                type="button"
                className="btn btn--sm"
                onClick={onInvite}
                disabled={inviteDisabled}
                title={inviteDisabled ? "Create a channel first" : undefined}
              >
                Invite
              </button>
            </div> : null}
          </>
        ) : null}
      </div>
    </aside>
  );
}
