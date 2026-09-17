import { expect, test } from "bun:test";
import { readChannelInvites, type ChannelInviteCreateCommand } from "@openscout/protocol";
import { BrokerChannelInviteService } from "./broker-channel-invite-service.js";
import { createRuntimeRegistrySnapshot } from "./registry.js";

test("overlapping channel invite commands preserve both durable invitations", async () => {
  const snapshot = createRuntimeRegistrySnapshot();
  snapshot.actors.maya = { id: "maya", kind: "person", displayName: "Maya", handle: "maya" };
  snapshot.conversations.room = {
    id: "room", kind: "channel", title: "Release", visibility: "workspace",
    shareMode: "shared", authorityNodeId: "node-a", participantIds: ["maya"],
  };
  const service = new BrokerChannelInviteService({
    runtime: { snapshot: () => snapshot },
    async upsertConversation(conversation) {
      // Real durability yields before applying to the in-memory registry.
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      snapshot.conversations[conversation.id] = conversation;
    },
  });
  const command = (id: string): ChannelInviteCreateCommand => ({
    kind: "channel.invite.create", channelId: "room", inviteId: id,
    tokenHash: id.padEnd(64, "0"), tokenHint: id, createdByActorId: "maya",
    createdAt: 100, expiresAt: null, maxRedemptions: 1,
    route: { authorityNodeId: "node-a", host: "127.0.0.1", baseUrl: "http://127.0.0.1", reachability: "local_only" },
  });
  const results = await Promise.all([service.create(command("a")), service.create(command("b"))]);
  expect(results.every((result) => result.ok)).toBe(true);
  expect(readChannelInvites(snapshot.conversations.room!.metadata).map((invite) => invite.id).sort()).toEqual(["a", "b"]);
});

test("concurrent redemptions cannot consume the same last invitation use", async () => {
  const snapshot = createRuntimeRegistrySnapshot();
  for (const id of ["maya", "jun"]) {
    snapshot.actors[id] = { id, kind: "person", displayName: id, handle: id };
  }
  snapshot.conversations.room = {
    id: "room", kind: "channel", title: "Release", visibility: "workspace",
    shareMode: "shared", authorityNodeId: "node-a", participantIds: [],
  };
  const service = new BrokerChannelInviteService({
    runtime: { snapshot: () => snapshot },
    async upsertConversation(conversation) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      snapshot.conversations[conversation.id] = conversation;
    },
  });
  const tokenHash = "a".repeat(64);
  await service.create({
    kind: "channel.invite.create", channelId: "room", inviteId: "last-use",
    tokenHash, tokenHint: "a", createdByActorId: "maya", createdAt: 100,
    expiresAt: null, maxRedemptions: 1,
    route: { authorityNodeId: "node-a", host: "127.0.0.1", baseUrl: "http://127.0.0.1", reachability: "local_only" },
  });
  const results = await Promise.all(["maya", "jun"].map((actorId) => service.redeem({
    kind: "channel.invite.redeem", channelId: "room", tokenHash,
    redemptionId: `redeem-${actorId}`, redeemedAt: 101, request: { actorId },
  })));
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect(results.filter((result) => !result.ok && result.rejection?.reason === "exhausted")).toHaveLength(1);
  expect(snapshot.conversations.room.participantIds).toHaveLength(1);
  expect(readChannelInvites(snapshot.conversations.room.metadata)[0].redemptions).toHaveLength(1);
});
