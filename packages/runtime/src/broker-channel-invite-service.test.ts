import { describe, expect, test } from "bun:test";

import {
  CHANNEL_INVITE_SCOPE,
  CHANNEL_INVITES_METADATA_KEY,
  namedChannelNaturalKey,
  readChannelInvites,
  type ActorIdentity,
  type AgentDefinition,
  type ChannelInviteRoute,
  type ConversationDefinition,
} from "@openscout/protocol";

import { createRuntimeRegistrySnapshot, type RuntimeRegistrySnapshot } from "./registry.js";
import { BrokerChannelInviteService } from "./broker-channel-invite-service.js";

const NOW = 1_700_000_000_000;

const ROUTE: ChannelInviteRoute = {
  authorityNodeId: "node-local",
  host: "arts-mini.scout.local",
  baseUrl: "http://arts-mini.scout.local",
  reachability: "lan",
};

function agent(input: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: "session-tesla",
    kind: "agent",
    definitionId: "session-tesla",
    displayName: "Tesla",
    handle: "tesla",
    labels: [],
    metadata: {},
    agentClass: "general",
    capabilities: ["chat"],
    wakePolicy: "manual",
    homeNodeId: "node-local",
    authorityNodeId: "node-local",
    advertiseScope: "local",
    ...input,
  };
}

function conversation(input: Partial<ConversationDefinition> = {}): ConversationDefinition {
  return {
    id: "chn-room",
    kind: "channel",
    title: "design-room",
    visibility: "workspace",
    shareMode: "shared",
    authorityNodeId: "node-local",
    participantIds: ["operator"],
    metadata: {
      naturalKey: namedChannelNaturalKey("design-room"),
      channel: "design-room",
    },
    ...input,
  };
}

function createHarness(input: { snapshot?: RuntimeRegistrySnapshot } = {}) {
  const snapshot = input.snapshot ?? createRuntimeRegistrySnapshot();
  snapshot.conversations["chn-room"] = conversation();
  snapshot.agents["session-tesla"] = agent();
  snapshot.actors["operator"] = {
    id: "operator",
    kind: "person",
    displayName: "Arach",
    handle: "operator",
  } satisfies ActorIdentity;
  snapshot.actors["person-maya"] = {
    id: "person-maya",
    kind: "person",
    displayName: "Maya",
    handle: "maya",
  } satisfies ActorIdentity;

  const upsertedConversations: ConversationDefinition[] = [];
  const service = new BrokerChannelInviteService({
    runtime: { snapshot: () => snapshot },
    async upsertConversation(next) {
      upsertedConversations.push(next);
      snapshot.conversations[next.id] = next;
    },
  });
  return { service, snapshot, upsertedConversations };
}

const createCommand = (overrides: Record<string, unknown> = {}) => ({
  kind: "channel.invite.create" as const,
  channelId: "chn-room",
  inviteId: "inv-1",
  tokenHash: "ABCDEF01",
  tokenHint: "ab01",
  createdByActorId: "operator",
  createdAt: NOW,
  expiresAt: null,
  maxRedemptions: null,
  route: ROUTE,
  ...overrides,
});

const redeemCommand = (overrides: Record<string, unknown> = {}) => ({
  kind: "channel.invite.redeem" as const,
  channelId: "chn-room",
  tokenHash: "abcdef01",
  redemptionId: "inv-red-1",
  redeemedAt: NOW + 1_000,
  request: {
    actorId: "session-tesla",
    agentId: "session-tesla",
    sessionId: "sess.tesla",
    harness: "claude",
  },
  ...overrides,
});

describe("BrokerChannelInviteService.create", () => {
  test("stores the digest and never a raw token", async () => {
    const harness = createHarness();
    const result = await harness.service.create(createCommand());
    expect(result.ok).toBe(true);

    const stored = readChannelInvites(harness.snapshot.conversations["chn-room"]!.metadata);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.tokenHash).toBe("abcdef01");
    expect(stored[0]!.scope).toBe(CHANNEL_INVITE_SCOPE);
    expect(result.ok && result.invite).not.toHaveProperty("tokenHash");
  });

  test("creating an invitation does not add a participant", async () => {
    const harness = createHarness();
    await harness.service.create(createCommand());
    expect(harness.snapshot.conversations["chn-room"]!.participantIds).toEqual(["operator"]);
  });

  test("preserves unrelated conversation metadata", async () => {
    const harness = createHarness();
    await harness.service.create(createCommand());
    const metadata = harness.snapshot.conversations["chn-room"]!.metadata!;
    expect(metadata.channel).toBe("design-room");
    expect(metadata.naturalKey).toBe(namedChannelNaturalKey("design-room"));
  });

  test("a repeated create with the same id is idempotent", async () => {
    const harness = createHarness();
    await harness.service.create(createCommand());
    await harness.service.create(createCommand({ tokenHash: "OTHER" }));
    const stored = readChannelInvites(harness.snapshot.conversations["chn-room"]!.metadata);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.tokenHash).toBe("abcdef01");
  });

  test("refuses a direct message, which has no roster to join", async () => {
    const harness = createHarness();
    harness.snapshot.conversations["chn-dm"] = conversation({ id: "chn-dm", kind: "direct" });
    const result = await harness.service.create(createCommand({ channelId: "chn-dm" }));
    expect(result).toEqual({ ok: false, error: "Channel chn-dm not found." });
  });
});

describe("BrokerChannelInviteService.redeem", () => {
  test("membership follows redemption, not invitation", async () => {
    const harness = createHarness();
    await harness.service.create(createCommand());
    expect(harness.snapshot.conversations["chn-room"]!.participantIds).toEqual(["operator"]);

    const result = await harness.service.redeem(redeemCommand());
    expect(result.ok).toBe(true);
    expect(result.ok && result.alreadyRedeemed).toBe(false);
    expect(harness.snapshot.conversations["chn-room"]!.participantIds)
      .toEqual(["operator", "session-tesla"]);
    expect(result.ok && result.redemption.sessionId).toBe("sess.tesla");
  });

  test("an invitee person actor joins alongside their agent", async () => {
    const harness = createHarness();
    await harness.service.create(createCommand({
      invitee: { displayName: "Maya", handle: "maya", actorId: "person-maya" },
    }));
    await harness.service.redeem(redeemCommand());
    expect(harness.snapshot.conversations["chn-room"]!.participantIds)
      .toEqual(["operator", "person-maya", "session-tesla"]);
  });

  test("redeeming twice does not duplicate the redemption or the member", async () => {
    const harness = createHarness();
    await harness.service.create(createCommand({ maxRedemptions: 1 }));
    const first = await harness.service.redeem(redeemCommand());
    const second = await harness.service.redeem(
      redeemCommand({ redemptionId: "inv-red-2", redeemedAt: NOW + 9_000 }),
    );

    expect(first.ok && first.alreadyRedeemed).toBe(false);
    expect(second.ok && second.alreadyRedeemed).toBe(true);
    expect(second.ok && second.redemption.id).toBe("inv-red-1");
    expect(second.ok && second.redemption.redeemedAt).toBe(NOW + 1_000);

    const stored = readChannelInvites(harness.snapshot.conversations["chn-room"]!.metadata);
    expect(stored[0]!.redemptions).toHaveLength(1);
    expect(harness.snapshot.conversations["chn-room"]!.participantIds)
      .toEqual(["operator", "session-tesla"]);
  });

  test("a retry after a member was removed restores membership", async () => {
    const harness = createHarness();
    await harness.service.create(createCommand());
    await harness.service.redeem(redeemCommand());

    const current = harness.snapshot.conversations["chn-room"]!;
    harness.snapshot.conversations["chn-room"] = { ...current, participantIds: ["operator"] };

    const retry = await harness.service.redeem(redeemCommand({ redemptionId: "inv-red-2" }));
    expect(retry.ok && retry.alreadyRedeemed).toBe(true);
    expect(harness.snapshot.conversations["chn-room"]!.participantIds)
      .toEqual(["operator", "session-tesla"]);
  });

  test("an unregistered identity cannot join with a valid token", async () => {
    const harness = createHarness();
    await harness.service.create(createCommand());
    const result = await harness.service.redeem(
      redeemCommand({ request: { actorId: "ghost-agent", sessionId: "sess.ghost" } }),
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("not registered with this broker");
    expect(harness.snapshot.conversations["chn-room"]!.participantIds).toEqual(["operator"]);
  });

  test("an unknown token is refused without revealing whether the channel exists", async () => {
    const harness = createHarness();
    await harness.service.create(createCommand());
    const badToken = await harness.service.redeem(redeemCommand({ tokenHash: "deadbeef" }));
    const badChannel = await harness.service.redeem(redeemCommand({ channelId: "chn-nope" }));
    expect(badToken.ok).toBe(false);
    expect(badChannel.ok).toBe(false);
    expect(badToken.ok === false && badToken.error)
      .toBe(badChannel.ok === false ? badChannel.error : "");
    expect(harness.snapshot.conversations["chn-room"]!.participantIds).toEqual(["operator"]);
  });

  test("an expired invitation grants nothing", async () => {
    const harness = createHarness();
    await harness.service.create(createCommand({ expiresAt: NOW + 10 }));
    const result = await harness.service.redeem(redeemCommand({ redeemedAt: NOW + 11 }));
    expect(result.ok === false && result.rejection?.reason).toBe("expired");
    expect(harness.snapshot.conversations["chn-room"]!.participantIds).toEqual(["operator"]);
  });

  test("a revoked invitation stops working for an identity that already used it", async () => {
    const harness = createHarness();
    await harness.service.create(createCommand());
    await harness.service.redeem(redeemCommand());
    await harness.service.revoke({
      kind: "channel.invite.revoke",
      channelId: "chn-room",
      inviteId: "inv-1",
      revokedByActorId: "operator",
      revokedAt: NOW + 2_000,
    });

    const retry = await harness.service.redeem(
      redeemCommand({ redemptionId: "inv-red-2", redeemedAt: NOW + 3_000 }),
    );
    expect(retry.ok === false && retry.rejection?.reason).toBe("revoked");
  });

  test("a second identity cannot spend an exhausted single-use invitation", async () => {
    const harness = createHarness();
    harness.snapshot.agents["session-curie"] = agent({ id: "session-curie", definitionId: "session-curie" });
    await harness.service.create(createCommand({ maxRedemptions: 1 }));
    await harness.service.redeem(redeemCommand());

    const second = await harness.service.redeem(redeemCommand({
      redemptionId: "inv-red-2",
      request: { actorId: "session-curie", sessionId: "sess.curie" },
    }));
    expect(second.ok === false && second.rejection?.reason).toBe("exhausted");
    expect(harness.snapshot.conversations["chn-room"]!.participantIds)
      .toEqual(["operator", "session-tesla"]);
  });
});

describe("BrokerChannelInviteService reads", () => {
  test("revoking is idempotent and keeps the first timestamp", async () => {
    const harness = createHarness();
    await harness.service.create(createCommand());
    await harness.service.revoke({
      kind: "channel.invite.revoke",
      channelId: "chn-room",
      inviteId: "inv-1",
      revokedByActorId: "operator",
      revokedAt: NOW + 1,
    });
    const writes = harness.upsertedConversations.length;
    await harness.service.revoke({
      kind: "channel.invite.revoke",
      channelId: "chn-room",
      inviteId: "inv-1",
      revokedByActorId: "operator",
      revokedAt: NOW + 500,
    });
    expect(harness.upsertedConversations).toHaveLength(writes);
    const stored = readChannelInvites(harness.snapshot.conversations["chn-room"]!.metadata);
    expect(stored[0]!.revokedAt).toBe(NOW + 1);
  });

  test("listing returns public views, newest first, with no digest", async () => {
    const harness = createHarness();
    await harness.service.create(createCommand());
    await harness.service.create(createCommand({
      inviteId: "inv-2",
      tokenHash: "beef",
      tokenHint: "beef",
      createdAt: NOW + 5_000,
    }));
    const listed = harness.service.list("chn-room", NOW + 6_000);
    expect(listed.map((invite) => invite.id)).toEqual(["inv-2", "inv-1"]);
    expect(JSON.stringify(listed)).not.toContain("tokenHash");
  });

  test("a token digest resolves to its owning channel", async () => {
    const harness = createHarness();
    await harness.service.create(createCommand());
    const found = harness.service.findChannelForTokenHash("ABCDEF01");
    expect(found?.conversation.id).toBe("chn-room");
    expect(found?.invite.id).toBe("inv-1");
    expect(harness.service.findChannelForTokenHash("nope")).toBeNull();
    expect(harness.service.findChannelForTokenHash("  ")).toBeNull();
  });

  test("the metadata key is stable so older records keep loading", async () => {
    const harness = createHarness();
    await harness.service.create(createCommand());
    expect(Object.keys(harness.snapshot.conversations["chn-room"]!.metadata!))
      .toContain(CHANNEL_INVITES_METADATA_KEY);
  });
});
