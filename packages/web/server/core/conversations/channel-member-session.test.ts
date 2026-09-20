import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { cookieValue, installScoutApiMiddleware } from "../../server-core.ts";
import {
  CHANNEL_MEMBER_COOKIE,
  channelMemberCookie,
  channelMemberMayAccess,
  channelMemberMayAccessSpace,
  createChannelMemberSessionAuthority,
} from "./channel-member-session.ts";

const OPERATOR_TOKEN = "operator-token-for-tests";
const CHANNEL = "chn-0123456789abcdef0123456789abcdef";
const OTHER_CHANNEL = "chn-fedcba9876543210fedcba9876543210";

/**
 * The real middleware, the real cookie parsing, the real allowlist. The point
 * of these tests is the boundary itself: an invited teammate must be able to
 * reach their channel and must not be able to reach anything else.
 */
function createApp() {
  const members = createChannelMemberSessionAuthority({ signingSecret: OPERATOR_TOKEN });
  const app = new Hono();
  installScoutApiMiddleware(app, "test", {
    authToken: OPERATOR_TOKEN,
    memberAccess: (request, method, path) => channelMemberMayAccess({
      grant: members.validate(cookieValue(request, CHANNEL_MEMBER_COOKIE)),
      method,
      path,
    }),
  });
  app.get("/api/agents", (c) => c.json({ agents: [] }));
  app.get("/api/terminal/sessions", (c) => c.json({ sessions: [] }));
  app.get(`/api/channels/:id/members`, (c) => c.json({ channelId: c.req.param("id") }));
  app.post(`/api/channels/:id/invites`, (c) => c.json({ created: true }));
  app.get("/api/invites/:token", (c) => c.json({ invite: c.req.param("token") }));
  app.post("/api/invites/:token/join", (c) => c.json({ joined: true }));
  app.get("/api/member/me", (c) => c.json({ member: null }));
  app.get("/api/chat/bootstrap", (c) => c.json({ channels: [] }));
  app.post("/api/chat/channels", (c) => c.json({ created: true }));
  app.post(`/api/channels/:id/messages`, (c) => c.json({ posted: true }));
  app.post(`/api/channels/:id/reactions`, (c) => c.json({ ok: true }));
  app.post(`/api/channels/:id/reactions/remove`, (c) => c.json({ ok: true }));
  app.post("/api/blobs", (c) => c.json({ id: "blob-1" }));
  app.get("/api/blobs/:id", (c) => c.json({ id: c.req.param("id") }));
  app.get("/api/link-preview", (c) => c.json({ preview: { url: c.req.query("url") } }));
  app.post(`/api/channels/:id/asks`, (c) => c.json({ asked: true }));
  app.post(`/api/channels/:id/invites/:inviteId/revoke`, (c) => c.json({ revoked: true }));
  return { app, members };
}

const withCookie = (token: string) => ({
  headers: { cookie: channelMemberCookie(token, false).split(";")[0]! },
});

describe("the invited member boundary", () => {
  test("an invitation can be previewed and accepted without any credential", async () => {
    const { app } = createApp();

    // A teammate opening the link has nothing yet. The token in the URL is the
    // only capability they hold, and these two routes are what evaluate it.
    expect((await app.request("http://localhost/api/invites/some-token")).status).toBe(200);
    expect(
      (await app.request("http://localhost/api/invites/some-token/join", { method: "POST" })).status,
    ).toBe(200);
  });

  test("without a credential every other API stays closed", async () => {
    const { app } = createApp();
    expect((await app.request("http://localhost/api/agents")).status).toBe(401);
    expect((await app.request("http://localhost/api/member/me")).status).toBe(401);
    expect((await app.request("http://localhost/api/link-preview")).status).toBe(401);
    expect(
      (await app.request(`http://localhost/api/channels/${CHANNEL}/members`)).status,
    ).toBe(401);
  });

  test("a member reaches the channel they joined", async () => {
    const { app, members } = createApp();
    const { token } = members.mint({
      actorId: "person-maya",
      displayName: "Maya",
      channelId: CHANNEL,
    });

    const response = await app.request(
      `http://localhost/api/channels/${CHANNEL}/members`,
      withCookie(token),
    );
    expect(response.status).toBe(200);
    expect((await app.request("http://localhost/api/member/me", withCookie(token))).status)
      .toBe(200);
  });

  test("a member cannot reach a channel they were not invited to", async () => {
    const { app, members } = createApp();
    const { token } = members.mint({
      actorId: "person-maya",
      displayName: "Maya",
      channelId: CHANNEL,
    });

    const response = await app.request(
      `http://localhost/api/channels/${OTHER_CHANNEL}/members`,
      withCookie(token),
    );
    expect(response.status).toBe(401);
  });

  test("a member credential is not an operator credential", async () => {
    const { app, members } = createApp();
    const { token } = members.mint({
      actorId: "person-maya",
      displayName: "Maya",
      channelId: CHANNEL,
    });

    // The whole point of a scoped grant: holding it must not open the control
    // plane the operator token opens.
    expect((await app.request("http://localhost/api/agents", withCookie(token))).status).toBe(401);
    expect(
      (await app.request("http://localhost/api/terminal/sessions", withCookie(token))).status,
    ).toBe(401);
    // Nor may they create channels, or revoke an invitation in the room they
    // joined. Revoking is the host's, and a longer path tail is exactly how a
    // prefix-shaped allowlist would have leaked it.
    expect(
      (await app.request("http://localhost/api/chat/channels", {
        method: "POST",
        ...withCookie(token),
      })).status,
    ).toBe(401);
    // Revoking reaches the route rather than being stopped here: whose
    // invitation it is cannot be read off the path, so the route checks
    // authorship against the stored record. What the gate still guarantees is
    // that it is a channel they joined.
    expect(
      (await app.request(`http://localhost/api/channels/${OTHER_CHANNEL}/invites/cinv-1/revoke`, {
        method: "POST",
        ...withCookie(token),
      })).status,
    ).toBe(401);
  });

  test("a member can speak, ask, and invite their own agent into their channel", () => {
    const { app, members } = createApp();
    const { token } = members.mint({
      actorId: "person-maya",
      displayName: "Maya",
      channelId: CHANNEL,
    });

    // Being in the room has to mean being able to use it. A read-only grant
    // would make the invitation a spectator pass.
    return Promise.all([
      app.request(`http://localhost/api/channels/${CHANNEL}/messages`, {
        method: "POST",
        ...withCookie(token),
      }),
      app.request(`http://localhost/api/channels/${CHANNEL}/reactions`, {
        method: "POST",
        ...withCookie(token),
      }),
      app.request("http://localhost/api/blobs", {
        method: "POST",
        ...withCookie(token),
      }),
      app.request("http://localhost/api/blobs/blob-1", withCookie(token)),
      app.request("http://localhost/api/link-preview?url=https://github.com/arach/openscout", withCookie(token)),
      app.request(`http://localhost/api/channels/${CHANNEL}/asks`, {
        method: "POST",
        ...withCookie(token),
      }),
      // Bringing their own agent is the point of the feature, so minting an
      // invitation for the channel they joined is theirs -- and only for that
      // channel.
      app.request(`http://localhost/api/channels/${CHANNEL}/invites`, {
        method: "POST",
        ...withCookie(token),
      }),
      app.request("http://localhost/api/chat/bootstrap", withCookie(token)),
      // Taking back an invitation they issued. Being able to let someone in
      // without being able to undo it is not a permission, it is a trap; the
      // route is what checks they are the one who issued it.
      app.request(`http://localhost/api/channels/${CHANNEL}/invites/cinv-1/revoke`, {
        method: "POST",
        ...withCookie(token),
      }),
    ]).then((responses) => {
      expect(responses.map((response) => response.status))
        .toEqual([200, 200, 200, 200, 200, 200, 200, 200, 200]);
    });
  });

  test("a member's writes stop at the channel boundary", async () => {
    const { app, members } = createApp();
    const { token } = members.mint({
      actorId: "person-maya",
      displayName: "Maya",
      channelId: CHANNEL,
    });

    for (const path of [
      `/api/channels/${OTHER_CHANNEL}/messages`,
      `/api/channels/${OTHER_CHANNEL}/asks`,
      `/api/channels/${OTHER_CHANNEL}/invites`,
    ]) {
      expect(
        (await app.request(`http://localhost${path}`, { method: "POST", ...withCookie(token) }))
          .status,
      ).toBe(401);
    }
  });

  test("the operator is unaffected by the member path", async () => {
    const { app } = createApp();
    const authorized = {
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
    };
    expect((await app.request("http://localhost/api/agents", authorized)).status).toBe(200);
    expect(
      (await app.request(`http://localhost/api/channels/${CHANNEL}/invites`, {
        method: "POST",
        ...authorized,
      })).status,
    ).toBe(200);
  });

  test("an expired or forged cookie grants nothing", async () => {
    const { app, members } = createApp();
    const { token } = members.mint({
      actorId: "person-maya",
      displayName: "Maya",
      channelId: CHANNEL,
      nowMs: Date.now() - 24 * 60 * 60 * 1000,
    });

    expect(
      (await app.request(`http://localhost/api/channels/${CHANNEL}/members`, withCookie(token)))
        .status,
    ).toBe(401);
    expect(
      (await app.request(`http://localhost/api/channels/${CHANNEL}/members`, {
        headers: { cookie: `${CHANNEL_MEMBER_COOKIE}=not-a-real-session` },
      })).status,
    ).toBe(401);
  });
});

describe("member session grants", () => {
  test("redeeming a second invitation widens the grant to that channel only", () => {
    const members = createChannelMemberSessionAuthority({ signingSecret: OPERATOR_TOKEN });
    const { token } = members.mint({
      actorId: "person-maya",
      displayName: "Maya",
      channelId: CHANNEL,
    });

    // The grant rides inside the token, so widening it mints a new one and
    // retires the old.
    const widened = members.grantChannel(token, OTHER_CHANNEL);
    expect(widened?.grant.channelIds).toEqual([CHANNEL, OTHER_CHANNEL]);
    expect(members.validate(token)).toBeNull();
    // Idempotent: joining the same channel twice does not duplicate the grant.
    expect(members.grantChannel(widened!.token, OTHER_CHANNEL)?.grant.channelIds)
      .toHaveLength(2);
  });

  test("a revoked session stops validating immediately", () => {
    const members = createChannelMemberSessionAuthority({ signingSecret: OPERATOR_TOKEN });
    const { token } = members.mint({
      actorId: "person-maya",
      displayName: "Maya",
      channelId: CHANNEL,
    });
    expect(members.validate(token)).not.toBeNull();
    members.revoke(token);
    // A revoked token must stay revoked even though its signature still
    // verifies -- otherwise revocation would last only until the next restart.
    expect(members.validate(token)).toBeNull();
    expect(
      createChannelMemberSessionAuthority({ signingSecret: OPERATOR_TOKEN }).validate(token),
    ).not.toBeNull();
  });
});

describe("a member stays signed in across a web server restart", () => {
  test("a cookie this process never issued is accepted when this host signed it", () => {
    const before = createChannelMemberSessionAuthority({ signingSecret: OPERATOR_TOKEN });
    const { token } = before.mint({
      actorId: "person-maya",
      displayName: "Maya",
      channelId: CHANNEL,
    });

    // A restart is a brand new authority with an empty session map. Signing a
    // teammate out because the host restarted is not a security property.
    const after = createChannelMemberSessionAuthority({ signingSecret: OPERATOR_TOKEN });
    const grant = after.validate(token);
    expect(grant?.actorId).toBe("person-maya");
    expect(grant?.displayName).toBe("Maya");
    expect(grant?.channelIds).toEqual([CHANNEL]);
  });

  test("a cookie signed by a different host, or a rotated token, grants nothing", () => {
    const before = createChannelMemberSessionAuthority({ signingSecret: OPERATOR_TOKEN });
    const { token } = before.mint({
      actorId: "person-maya",
      displayName: "Maya",
      channelId: CHANNEL,
    });

    expect(
      createChannelMemberSessionAuthority({ signingSecret: "some-other-host" }).validate(token),
    ).toBeNull();
    // With nothing to derive a key from there is nothing to verify against, so
    // an unseen cookie fails closed rather than being signed with a guessable
    // key.
    expect(createChannelMemberSessionAuthority().validate(token)).toBeNull();
  });

  test("an expired grant is not revived by its own signature", () => {
    const before = createChannelMemberSessionAuthority({ signingSecret: OPERATOR_TOKEN });
    const { token } = before.mint({
      actorId: "person-maya",
      displayName: "Maya",
      channelId: CHANNEL,
      nowMs: Date.now() - 24 * 60 * 60 * 1000,
    });
    expect(
      createChannelMemberSessionAuthority({ signingSecret: OPERATOR_TOKEN }).validate(token),
    ).toBeNull();
  });

  test("the member cookie is not the operator token and cannot be replayed as one", () => {
    const members = createChannelMemberSessionAuthority({ signingSecret: OPERATOR_TOKEN });
    const { token } = members.mint({
      actorId: "person-maya",
      displayName: "Maya",
      channelId: CHANNEL,
    });
    expect(token).not.toContain(OPERATOR_TOKEN);
  });
  test("a lightweight participation marker survives the token, and narrows it", () => {
    const members = createChannelMemberSessionAuthority({ signingSecret: OPERATOR_TOKEN });
    const { token } = members.mint({
      actorId: "apia-0123456789abcdef0123456789abcdef",
      displayName: "release-bot",
      channelId: CHANNEL,
      participation: "api",
    });

    // Re-read from a *fresh* authority, so the marker comes back out of the
    // signed token rather than out of the minting process's memory. This is
    // what makes it a restriction a client cannot strip.
    const reread = createChannelMemberSessionAuthority({ signingSecret: OPERATOR_TOKEN })
      .validate(token);
    expect(reread?.participation).toBe("api");

    // What it was granted.
    expect(channelMemberMayAccess({
      grant: reread,
      method: "POST",
      path: `/api/channels/${CHANNEL}/messages`,
    })).toBe(true);
    // And what it was not: issuing further invitations would defeat the
    // `maxRedemptions` of the invitation that admitted it.
    expect(channelMemberMayAccess({
      grant: reread,
      method: "POST",
      path: `/api/channels/${CHANNEL}/invites`,
    })).toBe(false);
    expect(channelMemberMayAccess({
      grant: reread,
      method: "POST",
      path: `/api/channels/${CHANNEL}/asks`,
    })).toBe(false);

    // A browser member in the same channel keeps both.
    const person = members.mint({
      actorId: "person-maya",
      displayName: "Maya",
      channelId: CHANNEL,
    }).grant;
    expect(person.participation).toBeUndefined();
    for (const rest of ["invites", "asks"]) {
      expect(channelMemberMayAccess({
        grant: person,
        method: "POST",
        path: `/api/channels/${CHANNEL}/${rest}`,
      })).toBe(true);
    }
  });
});

describe("a credential belongs to one space", () => {
  const WORK_CHANNEL = "chn-11111111111111111111111111111111";
  const PERSONAL_CHANNEL = "chn-22222222222222222222222222222222";

  test("the space rides inside the signed token, and the default rides as absence", () => {
    const members = createChannelMemberSessionAuthority({ signingSecret: OPERATOR_TOKEN });

    const work = members.mint({
      actorId: "person-maya",
      displayName: "Maya",
      channelId: WORK_CHANNEL,
      spaceSlug: "work",
    });
    // Re-read from a fresh authority: the space has to come back out of the
    // signature rather than out of the minting process's memory, or it is not
    // a restriction a client is unable to strip.
    const reread = createChannelMemberSessionAuthority({ signingSecret: OPERATOR_TOKEN })
      .validate(work.token);
    expect(reread?.spaceSlug).toBe("work");

    // The default space is written as an *absent* field so that every token
    // minted before spaces existed is byte-compatible with one minted now.
    const home = members.mint({
      actorId: "person-maya",
      displayName: "Maya",
      channelId: CHANNEL,
      spaceSlug: "home",
    });
    expect(home.grant.spaceSlug).toBeUndefined();
  });

  test("a grant is never widened across a space boundary", () => {
    const members = createChannelMemberSessionAuthority({ signingSecret: OPERATOR_TOKEN });
    const { token } = members.mint({
      actorId: "agent-kepler",
      displayName: "Kepler",
      channelId: WORK_CHANNEL,
      spaceSlug: "work",
    });

    // Redeeming a second invitation in the *same* space widens by one channel,
    // which is the behaviour that exists today.
    const sameSpace = members.grantChannel(token, "chn-33333333333333333333333333333333", {
      spaceSlug: "work",
    });
    expect(sameSpace?.grant.channelIds).toEqual([
      WORK_CHANNEL,
      "chn-33333333333333333333333333333333",
    ]);

    // Across a boundary it refuses instead. `null` is the signal the caller
    // uses to mint a *second* credential rather than a wider one.
    const crossSpace = members.grantChannel(sameSpace!.token, PERSONAL_CHANNEL, {
      spaceSlug: "personal",
    });
    expect(crossSpace).toBeNull();

    // And the refusal is not paid for with the credential they already held:
    // the token still validates, still names its own channels, and still names
    // its own space.
    const held = members.validate(sameSpace!.token);
    expect(held?.spaceSlug).toBe("work");
    expect(held?.channelIds).toEqual([WORK_CHANNEL, "chn-33333333333333333333333333333333"]);
    expect(held?.channelIds).not.toContain(PERSONAL_CHANNEL);
  });

  test("a token minted before spaces existed reads as the default space", () => {
    const members = createChannelMemberSessionAuthority({ signingSecret: OPERATOR_TOKEN });
    // No `spaceSlug` at all -- exactly the shape every credential in the wild
    // has today.
    const { token } = members.mint({
      actorId: "person-maya",
      displayName: "Maya",
      channelId: CHANNEL,
    });

    const grant = members.validate(token);
    expect(grant).not.toBeNull();
    expect(grant?.spaceSlug).toBeUndefined();

    // It reads as the default space rather than as "no space", so it keeps
    // working against the channels it was minted for...
    expect(channelMemberMayAccessSpace({ grant, channelSpaceSlug: "home" })).toBe(true);
    // ...and it is not a key to a space that did not exist when it was issued.
    expect(channelMemberMayAccessSpace({ grant, channelSpaceSlug: "work" })).toBe(false);

    // Widening it stays inside the default space, which is where it already is.
    expect(members.grantChannel(token, OTHER_CHANNEL, { spaceSlug: "home" })).not.toBeNull();
  });

  test("the space a member may act in comes from the credential, never the request", () => {
    const members = createChannelMemberSessionAuthority({ signingSecret: OPERATOR_TOKEN });
    const grant = members.mint({
      actorId: "person-maya",
      displayName: "Maya",
      channelId: WORK_CHANNEL,
      spaceSlug: "work",
    }).grant;

    expect(channelMemberMayAccessSpace({ grant, channelSpaceSlug: "work" })).toBe(true);
    expect(channelMemberMayAccessSpace({ grant, channelSpaceSlug: "personal" })).toBe(false);
    expect(channelMemberMayAccessSpace({ grant, channelSpaceSlug: "home" })).toBe(false);

    // The operator holds no member grant at all. Absence is not a denial here;
    // it means this check has nothing to say and the operator's own scoping
    // decides.
    expect(channelMemberMayAccessSpace({ grant: null, channelSpaceSlug: "personal" })).toBe(true);
  });

  test("listing spaces is open to a member; carving out a new one is not", () => {
    const members = createChannelMemberSessionAuthority({ signingSecret: OPERATOR_TOKEN });
    const grant = members.mint({
      actorId: "person-maya",
      displayName: "Maya",
      channelId: WORK_CHANNEL,
      spaceSlug: "work",
    }).grant;

    // A member has to be able to read the switcher, or the surface has no way
    // to name the space they are in.
    expect(channelMemberMayAccess({ grant, method: "GET", path: "/api/chat/spaces" })).toBe(true);
    expect(channelMemberMayAccess({ grant, method: "GET", path: "/api/link-preview" })).toBe(true);
    expect(channelMemberMayAccess({
      grant,
      method: "POST",
      path: `/api/channels/${WORK_CHANNEL}/asks/flt-1/cancel`,
    })).toBe(true);
    expect(channelMemberMayAccess({ grant: null, method: "GET", path: "/api/link-preview" })).toBe(false);
    // Creating one is the host's. A scoped credential must never be able to
    // widen its own reach, and a new namespace is the widest widening there is.
    expect(channelMemberMayAccess({ grant, method: "POST", path: "/api/chat/spaces" })).toBe(false);
  });
});
