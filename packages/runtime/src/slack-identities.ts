import { createHash } from "node:crypto";

function stableId(prefix: string, value: string): string {
  return `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

export function slackActorId(teamId: string, userId: string): string {
  return stableId("slack-person", `${teamId}:${userId}`);
}

export function slackBindingId(teamId: string, channelId: string, threadTs: string, installationId?: string): string {
  return stableId("binding-slack", `${installationId ? `${installationId}:` : ""}${teamId}:${channelId}:${threadTs}`);
}

export function slackDeliveryId(teamId: string, channelId: string, eventTs: string, installationId?: string): string {
  return stableId("deliver-slack", `${installationId ? `${installationId}:` : ""}${teamId}:${channelId}:${eventTs}`);
}

