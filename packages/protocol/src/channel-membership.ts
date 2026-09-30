import type { MetadataMap } from "./common.js";

/** Broker-written removals preserve history while invalidating older join links. */
export const CHANNEL_MEMBER_REMOVALS_KEY = "channelMemberRemovals";

export interface ChannelMemberRemoval {
  removedAt: number;
  removedByActorId: string;
  blockedInviteIds: string[];
}

export function readChannelMemberRemoval(metadata: MetadataMap | undefined, actorId: string): ChannelMemberRemoval | null {
  const records = metadata?.[CHANNEL_MEMBER_REMOVALS_KEY];
  if (!records || typeof records !== "object" || Array.isArray(records) || !Object.hasOwn(records, actorId)) return null;
  const value = (records as Record<string, unknown>)[actorId];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.removedAt !== "number" || !Number.isFinite(entry.removedAt)
    || typeof entry.removedByActorId !== "string" || !Array.isArray(entry.blockedInviteIds)
    || !entry.blockedInviteIds.every(id => typeof id === "string")) return null;
  return { removedAt: entry.removedAt, removedByActorId: entry.removedByActorId, blockedInviteIds: entry.blockedInviteIds as string[] };
}
