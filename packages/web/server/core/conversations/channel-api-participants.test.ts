import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { cookieValue, installScoutApiMiddleware } from "../../server-core.ts";
import {
  CHANNEL_MEMBER_COOKIE,
  channelMemberBearerToken,
  channelMemberCookie,
  channelMemberMayAccess,
  createChannelMemberSessionAuthority,
} from "./channel-member-session.ts";
import {
  API_PARTICIPANT_ACTOR_PREFIX,
  apiParticipantActor,
  apiParticipantActorId,
  apiParticipantDisplayName,
  isApiParticipantActor,
  readApiParticipantJoinRequest,
  renderChannelApiParticipantInstructions,
} from "./channel-api-participants.ts";
import { planChannelAsks } from "./channel-ask.ts";
import type { ChannelInvitePublicView, ChannelInviteRecord } from "@openscout/protocol";

const CHANNEL = "chn-0123456789abcdef0123456789abcdef";
const OTHER_CHANNEL = "chn-fedcba9876543210fedcba9876543210";
const SECRET = "operator-token-for-tests";
const TOKEN_HASH = "a".repeat(64);
const OTHER_TOKEN_HASH = "b".repeat(64);

describe("participant identity", () => {
  test("the server owns the id, and a caller that names one is refused", () => {
    // Dropping the field silently would be worse than refusing it: the caller
    // would go on believing it joined as the identity it sent.
    for (const field of ["actorId", "agentId", "sessionId", "endpointId", "nodeId"]) {
      const outcome = readApiParticipantJoinRequest({ [field]: "agent-kepler" });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("unreachable");
      expect(outcome.reason).toBe("identity_not_accepted");
      expect(outcome.status).toBe(400);
      expect(outcome.error).toContain(field);
    }
  });

  test("a body with only a name and an idempotency key is accepted", () => {
    const outcome = readApiParticipantJoinRequest({
      displayName: "  release-bot  ",
      participantKey: " key-1 ",
    });
    expect(outcome).toEqual({ ok: true, displayName: "release-bot", participantKey: "key-1" });
  });

  test("an oversized idempotency key is bounded rather than hashed", () => {
    const outcome = readApiParticipantJoinRequest({ participantKey: "k".repeat(201) });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.reason).toBe("participant_key_too_long");
  });

  test("the same key on the same invitation resolves to the same participant", () => {
    // This is what makes a retry after a lost response a retry rather than a
    // second join: the broker sees the actor it already redeemed for.
    const first = apiParticipantActorId({
      tokenHash: TOKEN_HASH,
      participantKey: "key-1",
      signingSecret: SECRET,
    });
    const again = apiParticipantActorId({
      tokenHash: TOKEN_HASH,
      participantKey: "key-1",
      signingSecret: SECRET,
    });
    expect(first).toBe(again);
    expect(first.startsWith(API_PARTICIPANT_ACTOR_PREFIX)).toBe(true);
  });

  test("the same key on a different invitation is a different participant", () => {
    // A key learned from one room cannot be pointed at another.
    const here = apiParticipantActorId({
      tokenHash: TOKEN_HASH,
      participantKey: "key-1",
      signingSecret: SECRET,
    });
    const elsewhere = apiParticipantActorId({
      tokenHash: OTHER_TOKEN_HASH,
      participantKey: "key-1",
      signingSecret: SECRET,
    });
    expect(here).not.toBe(elsewhere);
  });

  test("the id is not derivable by the caller, who knows the key and the digest", () => {
    // Same inputs, different secret: without the host's key there is nothing to
    // compute, which is what stops a holder of the invitation rejoining *as*
    // an existing participant.
    const ours = apiParticipantActorId({
      tokenHash: TOKEN_HASH,
      participantKey: "key-1",
      signingSecret: SECRET,
    });
    const theirs = apiParticipantActorId({
      tokenHash: TOKEN_HASH,
      participantKey: "key-1",
      signingSecret: "some-other-host-secret",
    });
    expect(ours).not.toBe(theirs);
  });

  test("with no signing secret the id is random rather than guessable", () => {
    const first = apiParticipantActorId({ tokenHash: TOKEN_HASH, participantKey: "key-1" });
    const second = apiParticipantActorId({ tokenHash: TOKEN_HASH, participantKey: "key-1" });
    expect(first).not.toBe(second);
  });

  test("with no key the id is random even when a secret is configured", () => {
    const first = apiParticipantActorId({ tokenHash: TOKEN_HASH, signingSecret: SECRET });
    const second = apiParticipantActorId({ tokenHash: TOKEN_HASH, signingSecret: SECRET });
    expect(first).not.toBe(second);
  });

  test("the broker actor carries the marker that keeps it out of invocation", () => {
    const actor = apiParticipantActor({
      actorId: "apia-abc123",
      displayName: "release-bot",
      channelId: CHANNEL,
      joinedAt: 1_800_000_000_000,
    });
    expect(actor.kind).toBe("agent");
    expect(isApiParticipantActor(actor)).toBe(true);
    expect(isApiParticipantActor({ id: "agent-kepler", metadata: {} })).toBe(false);
    expect(isApiParticipantActor(null)).toBe(false);
  });

  test("an unnamed participant still reads as something in a roster", () => {
    expect(apiParticipantDisplayName(null, "apia-abcdef0123")).toBe("API participant abcdef");
    expect(apiParticipantDisplayName("  bot  ", "apia-abcdef0123")).toBe("bot");
  });
});

describe("an API participant is never invocable", () => {
  const invites: ChannelInviteRecord[] = [];

  test("addressing one is refused by name, not queued and not launched", () => {
    const plan = planChannelAsks({
      mentionedActorIds: ["apia-abc123"],
      participantIds: ["operator", "apia-abc123"],
      invites,
      nowMs: 1_800_000_000_000,
      candidates: [{
        actorId: "apia-abc123",
        isAgent: true,
        isApiParticipant: true,
        endpoint: null,
        label: "release-bot",
      }],
    });

    // No ask at all: there is nothing to route to, so nothing is dispatched
    // and no session id is invented for the caller to execute against.
    expect(plan.asks).toEqual([]);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0]?.reason).toBe("api_participant");
    // And the reason distinguishes "will never attach" from "has not yet",
    // which is the difference between giving up and waiting.
    expect(plan.skipped[0]?.detail).toContain("poll");
  });

  test("an ordinary agent with an attached session is still routed", () => {
    const now = 1_800_000_000_000;
    const plan = planChannelAsks({
      mentionedActorIds: ["agent-kepler"],
      participantIds: ["operator", "agent-kepler"],
      invites: [{
        id: "inv-1",
        channelId: CHANNEL,
        tokenHash: TOKEN_HASH,
        tokenHint: "vx3k",
        scope: "channel",
        createdByActorId: "person-art",
        createdAt: now - 1000,
        expiresAt: null,
        maxRedemptions: null,
        route: {
          authorityNodeId: "node-1",
          host: "m1.scout.local",
          baseUrl: "http://m1.scout.local",
          reachability: "unknown",
        },
        redemptions: [{
          id: "crdm-1",
          actorId: "agent-kepler",
          agentId: "agent-kepler",
          sessionId: "sess.kepler",
          redeemedAt: now - 500,
        }],
      } as unknown as ChannelInviteRecord],
      nowMs: now,
      candidates: [{
        actorId: "agent-kepler",
        isAgent: true,
        endpoint: null,
        label: "Kepler",
      }],
    });

    expect(plan.asks).toHaveLength(1);
    expect(plan.asks[0]?.sessionId).toBe("sess.kepler");
  });
});

describe("the member credential boundary for an API participant", () => {
  function createApp() {
    const members = createChannelMemberSessionAuthority({ signingSecret: SECRET });
    const app = new Hono();
    installScoutApiMiddleware(app, "test", {
      authToken: SECRET,
      memberAccess: (request, method, path) => channelMemberMayAccess({
        grant: members.validate(cookieValue(request, CHANNEL_MEMBER_COOKIE))
          ?? members.validate(channelMemberBearerToken(request.headers.get("authorization"))),
        method,
        path,
      }),
    });
    app.post("/api/invites/:token/participate", (c) => c.json({ joined: true }));
    app.get("/api/channels/:id/poll", (c) => c.json({ channelId: c.req.param("id") }));
    app.post("/api/channels/:id/asks", (c) => c.json({ asked: true }));
    app.get("/api/agents", (c) => c.json({ agents: [] }));
    return { app, members };
  }

  test("participating needs only the invitation token, like join and redeem", async () => {
    const { app } = createApp();
    const response = await app.request("http://localhost/api/invites/some-token/participate", {
      method: "POST",
    });
    expect(response.status).toBe(200);
  });

  test("a bearer credential opens the channel it names and nothing else", async () => {
    const { app, members } = createApp();
    const { token } = members.mint({
      actorId: "apia-abc123",
      displayName: "release-bot",
      channelId: CHANNEL,
    });
    const auth = { headers: { authorization: `Bearer ${token}` } };

    expect((await app.request(`http://localhost/api/channels/${CHANNEL}/poll`, auth)).status)
      .toBe(200);
    // A different room is refused even though the credential is valid.
    expect((await app.request(`http://localhost/api/channels/${OTHER_CHANNEL}/poll`, auth)).status)
      .toBe(401);
    // And the credential reaches nothing outside the channel routes.
    expect((await app.request("http://localhost/api/agents", auth)).status).toBe(401);
  });

  test("a member bearer token is not an operator token", async () => {
    const { app, members } = createApp();
    const { token } = members.mint({
      actorId: "apia-abc123",
      displayName: "release-bot",
      channelId: CHANNEL,
    });
    // The operator's own routes stay shut: the grant is checked by signature
    // against the member key, which the operator token can never satisfy.
    const response = await app.request("http://localhost/api/agents", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(401);
  });

  test("an unsigned or forged bearer is simply not a member", async () => {
    const { app } = createApp();
    for (const value of ["Bearer not-a-real-token", "Bearer", "Basic abc"]) {
      const response = await app.request(`http://localhost/api/channels/${CHANNEL}/poll`, {
        headers: { authorization: value },
      });
      expect(response.status).toBe(401);
    }
  });

  test("a cookie still works, so a browser and an API client share one grant shape", async () => {
    const { app, members } = createApp();
    const { token } = members.mint({
      actorId: "apia-abc123",
      displayName: "release-bot",
      channelId: CHANNEL,
    });
    const response = await app.request(`http://localhost/api/channels/${CHANNEL}/poll`, {
      headers: { cookie: channelMemberCookie(token, false).split(";")[0]! },
    });
    expect(response.status).toBe(200);
  });
});

describe("the no-install document", () => {
  const invite = {
    id: "inv-1",
    scope: "channel",
    state: "active",
    tokenHint: "vx3k",
    createdByActorId: "person-art",
    createdAt: 1_800_000_000_000,
    expiresAt: 1_800_600_000_000,
    maxRedemptions: null,
    redemptionCount: 0,
    route: {
      authorityNodeId: "node-1",
      host: "m1.scout.local",
      baseUrl: "http://m1.scout.local",
      reachability: "unknown",
      caveat: "m1.scout.local resolves to 127.0.0.1 on every machine.",
    },
  } as unknown as ChannelInvitePublicView;

  const markdown = () => renderChannelApiParticipantInstructions({
    channelId: CHANNEL,
    channelTitle: "release-train",
    channelTopic: "shipping 0.3",
    inviterDisplayName: "Art",
    invite,
    apiBaseUrl: "http://m1.scout.local",
    participateUrl: `http://m1.scout.local/api/invites/tok/participate`,
  });

  test("it gives a reader with no install everything the flow needs", () => {
    const text = markdown();
    expect(text).toContain(CHANNEL);
    expect(text).toContain("/participate");
    expect(text).toContain("/poll");
    expect(text).toContain("/messages");
    expect(text).toContain("Bearer");
  });

  test("it never tells the reader to install anything", () => {
    const text = markdown().toLowerCase();
    for (const forbidden of ["npm install", "brew install", "pip install", "curl -fssl"]) {
      expect(text).not.toContain(forbidden);
    }
    // Installing a connector is named as a thing that exists and as somebody
    // else's decision, never as a step in this document.
    expect(text).toContain("decision for you and");
  });

  test("it states the limits instead of leaving them to be discovered", () => {
    const text = markdown();
    expect(text).toContain("attached: false");
    expect(text).toContain("stale");
    // The three things a polling member cannot do, said plainly.
    expect(text).toContain("Nothing reaches you between polls");
    expect(text).toContain("cannot be given tracked work");
    expect(text).toContain("not");
    expect(text).toContain("an execution record");
  });

  test("every rendered command is complete, with no unfilled placeholder", () => {
    for (const line of markdown().split("\n")) {
      if (!line.startsWith("curl ")) continue;
      expect(line).not.toContain("undefined");
      expect(line).not.toContain("${");
    }
  });
});
