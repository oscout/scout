import { describe, expect, test } from "bun:test";

import {
  CHANNEL_INVITE_SCOPE,
  CHANNEL_INVITES_METADATA_KEY,
  channelInvitePublicView,
  channelInviteState,
  evaluateChannelInviteRedemption,
  findChannelInviteByTokenHash,
  readChannelInvites,
  type ChannelInviteRecord,
  type ChannelInviteRedemption,
} from "./channel-invites.js";

const NOW = 1_700_000_000_000;

const redemption = (
  overrides: Partial<ChannelInviteRedemption> = {},
): ChannelInviteRedemption => ({
  id: "inv-red-1",
  actorId: "session-tesla",
  agentId: "agent-tesla",
  sessionId: "sess.tesla",
  redeemedAt: NOW - 1_000,
  ...overrides,
});

const invite = (overrides: Partial<ChannelInviteRecord> = {}): ChannelInviteRecord => ({
  id: "inv-1",
  channelId: "chn-room",
  scope: CHANNEL_INVITE_SCOPE,
  tokenHash: "ABCDEF",
  tokenHint: "abcd",
  createdAt: NOW - 10_000,
  createdByActorId: "operator",
  expiresAt: null,
  maxRedemptions: null,
  route: {
    authorityNodeId: "node-1",
    host: "arts-mini.scout.local",
    baseUrl: "http://arts-mini.scout.local",
    reachability: "lan",
  },
  redemptions: [],
  ...overrides,
});

describe("channelInviteState", () => {
  test("an open invitation is active", () => {
    expect(channelInviteState(invite(), NOW)).toBe("active");
  });

  test("expiry is inclusive of the boundary", () => {
    expect(channelInviteState(invite({ expiresAt: NOW }), NOW)).toBe("expired");
    expect(channelInviteState(invite({ expiresAt: NOW + 1 }), NOW)).toBe("active");
  });

  test("revocation outranks an unexpired window", () => {
    expect(channelInviteState(invite({ revokedAt: NOW - 5 }), NOW)).toBe("revoked");
  });

  test("a single-use invitation is exhausted once redeemed", () => {
    const record = invite({ maxRedemptions: 1, redemptions: [redemption()] });
    expect(channelInviteState(record, NOW)).toBe("exhausted");
  });
});

describe("evaluateChannelInviteRedemption", () => {
  test("accepts a first redemption on an active invitation", () => {
    const outcome = evaluateChannelInviteRedemption({
      invite: invite(),
      request: { actorId: "session-tesla", sessionId: "sess.tesla" },
      nowMs: NOW,
    });
    expect(outcome).toEqual({ ok: true, existing: null });
  });

  test("a retry reuses the original redemption without consuming a slot", () => {
    const original = redemption();
    const outcome = evaluateChannelInviteRedemption({
      invite: invite({ maxRedemptions: 1, redemptions: [original] }),
      request: { actorId: "session-tesla", sessionId: "sess.tesla" },
      nowMs: NOW,
    });
    expect(outcome).toEqual({ ok: true, existing: original });
  });

  test("a retry from the same session under a renamed actor still matches", () => {
    const original = redemption({ actorId: "session-old" });
    const outcome = evaluateChannelInviteRedemption({
      invite: invite({ maxRedemptions: 1, redemptions: [original] }),
      request: { actorId: "session-new", sessionId: "sess.tesla" },
      nowMs: NOW,
    });
    expect(outcome).toEqual({ ok: true, existing: original });
  });

  test("revocation revokes even a previously redeemed identity", () => {
    const outcome = evaluateChannelInviteRedemption({
      invite: invite({ revokedAt: NOW - 1, redemptions: [redemption()] }),
      request: { actorId: "session-tesla", sessionId: "sess.tesla" },
      nowMs: NOW,
    });
    expect(outcome).toEqual({
      ok: false,
      rejection: { reason: "revoked", message: "This invitation was revoked." },
    });
  });

  test("a new identity cannot use an exhausted invitation", () => {
    const outcome = evaluateChannelInviteRedemption({
      invite: invite({ maxRedemptions: 1, redemptions: [redemption()] }),
      request: { actorId: "session-curie", sessionId: "sess.curie" },
      nowMs: NOW,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.rejection.reason).toBe("exhausted");
  });

  test("an expired invitation is refused", () => {
    const outcome = evaluateChannelInviteRedemption({
      invite: invite({ expiresAt: NOW - 1 }),
      request: { actorId: "session-curie" },
      nowMs: NOW,
    });
    expect(outcome.ok === false && outcome.rejection.reason).toBe("expired");
  });

  test("a redemption aimed at another channel is refused", () => {
    const outcome = evaluateChannelInviteRedemption({
      invite: invite(),
      request: { actorId: "session-curie", channelId: "chn-other" },
      nowMs: NOW,
    });
    expect(outcome.ok === false && outcome.rejection.reason).toBe("channel_mismatch");
  });

  test("a broader requested scope is refused", () => {
    const outcome = evaluateChannelInviteRedemption({
      invite: invite(),
      request: { actorId: "session-curie", scope: "project_write" },
      nowMs: NOW,
    });
    expect(outcome.ok === false && outcome.rejection.reason).toBe("scope_mismatch");
  });

  test("an anonymous redemption is refused", () => {
    const outcome = evaluateChannelInviteRedemption({
      invite: invite(),
      request: { actorId: "  " },
      nowMs: NOW,
    });
    expect(outcome.ok === false && outcome.rejection.reason).toBe("missing_identity");
  });
});

describe("token storage", () => {
  test("invitations round-trip through conversation metadata", () => {
    const record = invite();
    const invites = readChannelInvites({ [CHANNEL_INVITES_METADATA_KEY]: [record] });
    expect(invites).toEqual([record]);
  });

  test("malformed metadata yields no invitations rather than throwing", () => {
    expect(readChannelInvites(undefined)).toEqual([]);
    expect(readChannelInvites({ [CHANNEL_INVITES_METADATA_KEY]: "nope" })).toEqual([]);
    expect(readChannelInvites({ [CHANNEL_INVITES_METADATA_KEY]: [{ id: "x" }] })).toEqual([]);
  });

  test("token lookup is case-insensitive on the digest", () => {
    const record = invite();
    expect(findChannelInviteByTokenHash([record], "abcdef")).toBe(record);
    expect(findChannelInviteByTokenHash([record], "beef")).toBeNull();
    expect(findChannelInviteByTokenHash([record], "   ")).toBeNull();
  });

  test("the public view never carries the token digest", () => {
    const view = channelInvitePublicView(invite(), NOW);
    expect(JSON.stringify(view)).not.toContain("ABCDEF");
    expect(view.tokenHint).toBe("abcd");
    expect(view.state).toBe("active");
    expect(view.redemptionCount).toBe(0);
    expect(view.createdByActorId).toBe(invite().createdByActorId);
  });
});
