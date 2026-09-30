import { z } from "zod";

// Chat routes that check their body key by key themselves (member removal,
// question responses, message and pin changes, read positions, approvals,
// participant joins) are not listed here. Identity never comes from these
// bodies: authorship is read from the channel credential.

const nullableCount = z.number().nullable().optional();

export const channelInviteCreateBody = z.object({
  createdByActorId: z.string().optional(),
  invitee: z.object({
    actorId: z.string().optional(),
    displayName: z.string().optional(),
  }).optional(),
  expiresInMs: nullableCount,
  maxRedemptions: nullableCount,
});
export type ChannelInviteCreateBody = z.input<typeof channelInviteCreateBody>;

export const channelInviteRevokeBody = z.object({
  revokedByActorId: z.string().optional(),
});
export type ChannelInviteRevokeBody = z.input<typeof channelInviteRevokeBody>;

export const channelInviteRedeemBody = z.object({
  actorId: z.string().optional(),
  agentId: z.string().optional(),
  sessionId: z.string().optional(),
  endpointId: z.string().optional(),
  nodeId: z.string().optional(),
  harness: z.string().optional(),
  projectRoot: z.string().optional(),
  displayName: z.string().optional(),
});
export type ChannelInviteRedeemBody = z.input<typeof channelInviteRedeemBody>;

export const channelInviteJoinBody = z.object({
  displayName: z.string().optional(),
});
export type ChannelInviteJoinBody = z.input<typeof channelInviteJoinBody>;

export const chatSpaceCreateBody = z.object({
  title: z.string().optional(),
  slug: z.string().optional(),
  channel: z.string().optional(),
  channelTopic: z.string().optional(),
});
export type ChatSpaceCreateBody = z.input<typeof chatSpaceCreateBody>;

export const chatChannelCreateBody = z.object({
  title: z.string().optional(),
  topic: z.string().optional(),
  space: z.string().optional(),
});
export type ChatChannelCreateBody = z.input<typeof chatChannelCreateBody>;

// Attachment pointers are resolved (and local paths gated to the operator)
// by the route, after the channel is resolved.
const chatAttachment = z.object({
  id: z.string().optional(),
  mediaType: z.string().optional(),
  fileName: z.string().optional(),
  url: z.string().optional(),
  blobKey: z.string().optional(),
  localPath: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});

export const channelMessageBody = z.object({
  requestId: z.string().optional(),
  // Parsed by the route, which owns the mention error message.
  mentionActorIds: z.unknown().optional(),
  body: z.string().optional(),
  replyToMessageId: z.string().optional(),
  attachments: z.array(chatAttachment).optional(),
});
export type ChannelMessageBody = z.input<typeof channelMessageBody>;

export const channelReactionBody = z.object({
  messageId: z.string().optional(),
  emoji: z.string().optional(),
  requestId: z.string().optional(),
  // Present only so the route can refuse it by name.
  actorId: z.unknown().optional(),
});
export type ChannelReactionBody = z.input<typeof channelReactionBody>;

export const channelAskBody = z.object({
  requestId: z.string().optional(),
  body: z.string().optional(),
  targetActorId: z.string().optional(),
  mentionActorIds: z.unknown().optional(),
  attachments: z.array(chatAttachment).optional(),
  replyToMessageId: z.string().optional(),
});
export type ChannelAskBody = z.input<typeof channelAskBody>;
