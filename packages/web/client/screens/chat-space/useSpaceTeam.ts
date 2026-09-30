/**
 * The space-wide team read behind the Team panel.
 *
 * There is no space roster endpoint: the hook re-reads every channel's
 * members and invitations — the same calls the members panel already makes —
 * and hands them to `buildSpaceTeam`. A channel that refuses is a reported
 * gap in the result, never a silent contribution of nobody. It only reads
 * while the panel is open, and polls at the roster's own interval.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChannelInvitePublicView, ConversationDefinition } from "@openscout/protocol";

import {
  ChatApiError,
  type ChannelMemberView,
  type ChatApi,
  type ChatCapabilities,
} from "./chat-api.ts";
import { ROSTER_POLL_MS } from "./chat-space-model.ts";
import {
  buildSpaceTeam,
  type SpaceTeam,
  type SpaceTeamChannelInput,
} from "./space-team-model.ts";
import { usePoll } from "./use-poll.ts";

function readError(reason: unknown, subject: string): string {
  if (reason instanceof ChatApiError && reason.isUnauthenticated) {
    return `Only members can see this channel's ${subject}`;
  }
  return reason instanceof Error
    ? reason.message
    : `This channel's ${subject} could not be read.`;
}

export function useSpaceTeam({
  api,
  capabilities,
  channels,
  space,
  enabled,
  viewerActorId,
}: {
  api: ChatApi;
  capabilities: ChatCapabilities;
  channels: ConversationDefinition[];
  space: string;
  enabled: boolean;
  viewerActorId: string;
}): { team: SpaceTeam | null; loading: boolean; reload: () => Promise<void> } {
  const [team, setTeam] = useState<SpaceTeam | null>(null);
  const [loading, setLoading] = useState(false);
  // A read that finishes after a newer one started — or after the panel
  // closed — is dropped rather than applied.
  const generation = useRef(0);

  const reload = useCallback(async () => {
    // No read while the panel is closed: the next open re-reads fresh anyway.
    if (!enabled) return;
    const gen = ++generation.current;
    setLoading(true);
    try {
      const settled = await Promise.allSettled(
        channels.map(async (channel): Promise<SpaceTeamChannelInput> => {
          const [membersRead, invitesRead] = await Promise.allSettled([
            api.members(channel.id, space),
            // A server that does not list invitations is not asked to.
            capabilities.inviteList
              ? api.invites(channel.id, space)
              : Promise.resolve(null),
          ]);
          const errors: string[] = [];
          if (membersRead.status === "rejected") {
            errors.push(readError(membersRead.reason, "roster"));
          }
          if (invitesRead.status === "rejected") {
            errors.push(readError(invitesRead.reason, "invitations"));
          }
          const members: ChannelMemberView[] | null =
            membersRead.status === "fulfilled" ? membersRead.value.members ?? [] : null;
          const invites: ChannelInvitePublicView[] | null =
            invitesRead.status === "fulfilled" ? invitesRead.value?.invites ?? [] : null;
          return {
            channel,
            members,
            invites,
            ...(errors.length > 0 ? { error: errors.join(" ") } : {}),
          };
        }),
      );
      if (gen !== generation.current) return;
      const inputs = settled.map((outcome, index): SpaceTeamChannelInput =>
        outcome.status === "fulfilled"
          ? outcome.value
          : {
              channel: channels[index]!,
              members: null,
              invites: null,
              error: readError(outcome.reason, "roster"),
            });
      setTeam(buildSpaceTeam(inputs, viewerActorId));
    } finally {
      if (gen === generation.current) setLoading(false);
    }
  }, [api, capabilities.inviteList, channels, enabled, space, viewerActorId]);

  useEffect(() => {
    if (!enabled) {
      generation.current += 1;
      setLoading(false);
      return;
    }
    void reload();
  }, [enabled, reload]);

  usePoll(reload, ROSTER_POLL_MS, enabled);

  return { team, loading, reload };
}
