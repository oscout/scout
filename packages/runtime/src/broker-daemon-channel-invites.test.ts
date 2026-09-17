import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readChannelInvites, type ConversationDefinition } from "@openscout/protocol";
import { createBrokerDaemonTestHarness } from "./test-helpers/broker-daemon-harness.test";

const broker = createBrokerDaemonTestHarness();

describe("channel invitations through the durable broker HTTP boundary", () => {
  test("preserves membership and exact-session retry across broker restart", async () => {
    const controlHome = mkdtempSync(join(tmpdir(), "openscout-chat-invite-test-"));
    const first = await broker.startBroker({ controlHome });
    const actorId = "chat-test-existing-agent";
    await broker.postJson(first.baseUrl, "/v1/actors", {
      id: actorId, kind: "agent", displayName: "Existing agent", handle: actorId,
    });
    const room = await broker.postJson<{ ok: boolean; conversationId: string }>(first.baseUrl, "/v1/conversations", {
      id: "chn-invite-recovery", kind: "channel", title: "Invitation recovery",
      visibility: "workspace", shareMode: "shared", authorityNodeId: first.nodeId,
      participantIds: ["operator"], metadata: {},
    });
    const channelId = room.conversationId;
    expect(channelId).toBeTruthy();
    const tokenHash = createHash("sha256").update("isolated-test-capability").digest("hex");
    const command = (baseUrl: string, body: unknown) => broker.postJson<any>(baseUrl, "/v1/commands", body);
    const created = await command(first.baseUrl, {
      kind: "channel.invite.create", channelId, inviteId: "cinv-recovery", tokenHash,
      tokenHint: "isolat", createdByActorId: "operator", createdAt: Date.now(),
      expiresAt: null, maxRedemptions: 1,
      route: { authorityNodeId: first.nodeId, host: "127.0.0.1", baseUrl: first.baseUrl, reachability: "local_only" },
    });
    expect(created.ok).toBe(true);
    const redeem = {
      kind: "channel.invite.redeem", channelId, tokenHash, redemptionId: "crdm-original",
      redeemedAt: Date.now(), request: { actorId, agentId: actorId, sessionId: "existing-session-a", nodeId: first.nodeId },
    };
    const joined = await command(first.baseUrl, redeem);
    expect(joined.ok).toBe(true);
    expect(joined.alreadyRedeemed).toBe(false);
    expect(joined.participantIds).toContain(actorId);

    first.child.kill();
    await first.child.exited;
    await Promise.all(first.outputDrain);
    broker.harnesses.delete(first);
    const restarted = await broker.startBroker({ controlHome });
    const snapshot = await broker.getJson<{ conversations: Record<string, ConversationDefinition> }>(restarted.baseUrl, "/v1/snapshot");
    expect(snapshot.conversations[channelId].participantIds).toContain(actorId);
    const invites = readChannelInvites(snapshot.conversations[channelId].metadata);
    expect(invites).toHaveLength(1);
    expect(invites[0].redemptions).toHaveLength(1);
    expect(invites[0].redemptions[0].sessionId).toBe("existing-session-a");

    const retry = await command(restarted.baseUrl, { ...redeem, redemptionId: "crdm-retry" });
    expect(retry.ok).toBe(true);
    expect(retry.alreadyRedeemed).toBe(true);
    expect(retry.redemption.id).toBe("crdm-original");
    const otherSession = await command(restarted.baseUrl, {
      ...redeem, redemptionId: "crdm-other", request: { ...redeem.request, sessionId: "existing-session-b" },
    });
    expect(otherSession.ok).toBe(false);
    expect(otherSession.rejection.reason).toBe("exhausted");

    expect((await command(restarted.baseUrl, {
      kind: "channel.invite.revoke", channelId, inviteId: "cinv-recovery",
      revokedByActorId: "operator", revokedAt: Date.now(),
    })).ok).toBe(true);
    const revokedRetry = await command(restarted.baseUrl, redeem);
    expect(revokedRetry.ok).toBe(false);
    expect(revokedRetry.rejection.reason).toBe("revoked");
  }, 30_000);
});
