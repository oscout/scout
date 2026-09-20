import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { DEFAULT_CHAT_SPACE_SLUG, normalizeChatSpaceSlug } from "@openscout/protocol";

/**
 * Browser credentials for people who joined through a channel invitation.
 *
 * A teammate who redeems an invitation is not an operator. They must be able to
 * open the channel they were invited to and nothing else, which means they need
 * a credential of their own: sharing the operator's bearer token would hand a
 * guest the whole control plane, and that is precisely the outcome the
 * invitation scope exists to prevent.
 *
 * The grant is deliberately narrow. It names the actor and the exact channel
 * ids that actor joined; it carries no roles, no wildcards, and no way to widen
 * itself. Widening happens only by redeeming another invitation.
 *
 * The credential survives a web server restart, because signing a teammate out
 * whenever the host restarts their server is not a security property -- it is
 * just a way to lose the room. It survives by being *verifiable* rather than by
 * being stored: the cookie carries the grant and an HMAC over it, so a restarted
 * process can check a cookie it has never seen without keeping a durable
 * credential file anywhere.
 *
 * The signing key is derived from the host's own API token, never equal to it.
 * Two consequences are deliberate: rotating the operator token signs every
 * member out, and a member cookie can never be replayed as an operator
 * credential. With no token configured there is nothing to derive from, so the
 * authority falls back to memory only and a restart does sign members out --
 * failing closed rather than signing anything with a guessable key.
 *
 * Membership itself is not proven by this cookie. It proves who the bearer is
 * and which channels they joined; whether they are still in a channel is read
 * from the broker's roster on every request that acts on one. A removed member
 * holding a live cookie is refused by the route, not admitted by the gate.
 */

export const CHANNEL_MEMBER_COOKIE = "openscout_member";

/** Twelve hours. Long enough for a working day, short enough to expire. */
export const CHANNEL_MEMBER_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface ChannelMemberGrant {
  actorId: string;
  displayName: string;
  /** Channels this member joined. Access is checked against this list only. */
  channelIds: string[];
  expiresAt: number;
  /**
   * `"api"` for a lightweight participant that joined over HTTP with no
   * install and no session; absent for a browser member or a redeemed session.
   *
   * It narrows the grant rather than describing it. The document handed to a
   * lightweight joiner promises read, post and reply in one channel, and this
   * is what makes that promise true: without it the same grant also carried
   * `POST /asks` and `POST /invites`, so a joiner could mint further
   * invitations to the room and defeat the `maxRedemptions` of the invitation
   * that admitted it.
   *
   * Signed into the token, so a client cannot drop it to widen itself. A token
   * minted before this field existed simply has no marker and is read as a
   * session member, which is what it was.
   */
  participation?: "api";
  /**
   * The chat space this credential is bound to. Absent means the default
   * space, which is exactly what a token minted before spaces existed was
   * scoped to -- so an old token reads as a default-space member rather than
   * as a member of everywhere.
   *
   * One credential never spans two spaces. {@link
   * ChannelMemberSessionAuthority.grantChannel} refuses to widen across the
   * boundary, so joining a second space mints a second credential instead of
   * turning this one into a key for both.
   */
  spaceSlug?: string;
}

interface StoredMemberSession extends ChannelMemberGrant {
  token: string;
}

export interface ChannelMemberSessionAuthority {
  mint(input: {
    actorId: string;
    displayName: string;
    channelId: string;
    nowMs?: number;
    /** `"api"` for a lightweight HTTP participant. See `ChannelMemberGrant`. */
    participation?: "api";
    /** The space the channel lives in. Absent means the default space. */
    spaceSlug?: string | null;
  }): { token: string; grant: ChannelMemberGrant };
  validate(token: string | null | undefined, nowMs?: number): ChannelMemberGrant | null;
  /**
   * Add a channel to an existing member's grant when they redeem another
   * invitation. The grant is inside the token, so widening it mints a new token
   * and the caller must set the returned cookie.
   *
   * Returns `null` rather than widening when the new channel is in a different
   * space from the one this credential is bound to. That refusal is not a
   * failure for the caller to work around: it is how a second space becomes a
   * second credential instead of one credential that opens both. Callers fall
   * back to `mint`, and the existing grant is left exactly as it was --
   * untouched, unrevoked, and still naming only its own space.
   */
  grantChannel(
    token: string,
    channelId: string,
    options?: { nowMs?: number; spaceSlug?: string | null },
  ): { token: string; grant: ChannelMemberGrant } | null;
  revoke(token: string): void;
}

function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  // `timingSafeEqual` throws on a length mismatch, so the lengths are compared
  // first. Token length is fixed by `mint`, so this reveals nothing about a
  // valid token -- only that a wrong-length guess was wrong.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Derive the member signing key from the host's API token.
 *
 * A derivation, not the token: the HMAC label means a member cookie cannot be
 * turned back into the operator credential even if the cookie and the label are
 * both known. Rotating the API token changes the key and signs members out,
 * which is the behaviour you want from a credential that hangs off the host's.
 */
function memberSigningKey(secret: string | null | undefined): Buffer | null {
  const normalized = secret?.trim();
  if (!normalized) return null;
  return createHmac("sha256", normalized)
    .update("openscout:channel-member-session:v1")
    .digest();
}

function signMemberGrant(key: Buffer, payload: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

export function createChannelMemberSessionAuthority(
  options?: { signingSecret?: string | null },
): ChannelMemberSessionAuthority {
  const sessions = new Map<string, StoredMemberSession>();
  // Revocations have to outlive the session map, or a revoked but unexpired
  // token would simply be re-verified from its own signature and let back in.
  const revoked = new Map<string, number>();
  const key = memberSigningKey(options?.signingSecret);

  const prune = (nowMs: number) => {
    for (const [token, session] of sessions) {
      if (session.expiresAt <= nowMs) sessions.delete(token);
    }
    for (const [token, expiresAt] of revoked) {
      if (expiresAt <= nowMs) revoked.delete(token);
    }
  };

  /**
   * Build the cookie value: the grant, then a signature over it.
   *
   * The random `nonce` is what makes the token itself a secret rather than a
   * predictable encoding of public facts -- two people who know a member's
   * actor id and channel still cannot construct their cookie.
   */
  const encode = (grant: ChannelMemberGrant): string => {
    const payload = Buffer.from(
      JSON.stringify({ ...grant, nonce: randomBytes(16).toString("base64url") }),
    ).toString("base64url");
    return key ? `${payload}.${signMemberGrant(key, payload)}` : payload;
  };

  /** Read a grant back out of a token, but only if this host signed it. */
  const decode = (token: string, nowMs: number): ChannelMemberGrant | null => {
    if (!key) return null;
    const split = token.lastIndexOf(".");
    if (split <= 0) return null;
    const payload = token.slice(0, split);
    const signature = token.slice(split + 1);
    if (!constantTimeEquals(signMemberGrant(key, payload), signature)) return null;
    try {
      const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as
        Partial<ChannelMemberGrant>;
      const actorId = typeof parsed.actorId === "string" ? parsed.actorId.trim() : "";
      const expiresAt = typeof parsed.expiresAt === "number" ? parsed.expiresAt : 0;
      const channelIds = Array.isArray(parsed.channelIds)
        ? parsed.channelIds.filter((id): id is string => typeof id === "string" && Boolean(id.trim()))
        : [];
      if (!actorId || !channelIds.length || expiresAt <= nowMs) return null;
      return {
        actorId,
        displayName: typeof parsed.displayName === "string" && parsed.displayName.trim()
          ? parsed.displayName.trim()
          : actorId,
        channelIds,
        expiresAt,
        // Only the exact marker counts. Anything else is a session member,
        // which is the wider grant -- so this reads strictly and never widens
        // on a value it does not recognise.
        ...(parsed.participation === "api" ? { participation: "api" as const } : {}),
        // Read strictly for the same reason: an unrecognisable value must read
        // as the default space, never as "no space constraint".
        ...(normalizeChatSpaceSlug(parsed.spaceSlug) ? { spaceSlug: normalizeChatSpaceSlug(parsed.spaceSlug)! } : {}),
      };
    } catch {
      return null;
    }
  };

  const store = (token: string, grant: ChannelMemberGrant) => {
    sessions.set(token, { ...grant, token });
    return grant;
  };

  return {
    mint({ actorId, displayName, channelId, nowMs = Date.now(), participation, spaceSlug }) {
      prune(nowMs);
      const space = normalizeChatSpaceSlug(spaceSlug);
      const grant: ChannelMemberGrant = {
        actorId: actorId.trim(),
        displayName: displayName.trim() || actorId.trim(),
        channelIds: [channelId.trim()],
        expiresAt: nowMs + CHANNEL_MEMBER_SESSION_TTL_MS,
        ...(participation === "api" ? { participation: "api" as const } : {}),
        // The default space is written as absence, so a default-space
        // credential is byte-identical to one minted before spaces existed.
        ...(space && space !== DEFAULT_CHAT_SPACE_SLUG ? { spaceSlug: space } : {}),
      };
      const token = encode(grant);
      store(token, grant);
      return { token, grant };
    },

    validate(token, nowMs = Date.now()) {
      const candidate = token?.trim();
      if (!candidate) return null;
      if (revoked.has(candidate)) return null;

      const session = sessions.get(candidate);
      if (session) {
        if (session.expiresAt <= nowMs) {
          sessions.delete(candidate);
          return null;
        }
        // The map lookup already matched exactly; the constant-time compare is
        // here so the code does not depend on Map internals for that property.
        if (!constantTimeEquals(session.token, candidate)) return null;
        const { token: _token, ...grant } = session;
        return grant;
      }

      // Not in memory. Either this process restarted or the entry was pruned --
      // in both cases the signature is what decides, not our recollection.
      const recovered = decode(candidate, nowMs);
      if (!recovered) return null;
      return store(candidate, recovered);
    },

    grantChannel(token, channelId, options = {}) {
      const nowMs = options.nowMs ?? Date.now();
      const candidate = token.trim();
      if (revoked.has(candidate)) return null;
      const current = sessions.get(candidate)
        ? (() => {
            const session = sessions.get(candidate)!;
            if (session.expiresAt <= nowMs) return null;
            const { token: _token, ...grant } = session;
            return grant;
          })()
        : decode(candidate, nowMs);
      if (!current) return null;

      // The space check happens before anything is mutated, so a refusal
      // leaves the caller's credential exactly as it found it. Revoking first
      // and refusing second would sign a member out of the space they were
      // legitimately in as the price of declining to widen them into another.
      if (options.spaceSlug !== undefined) {
        const target = normalizeChatSpaceSlug(options.spaceSlug) ?? DEFAULT_CHAT_SPACE_SLUG;
        const held = normalizeChatSpaceSlug(current.spaceSlug) ?? DEFAULT_CHAT_SPACE_SLUG;
        if (target !== held) return null;
      }

      const next = channelId.trim();
      const channelIds = next && !current.channelIds.includes(next)
        ? [...current.channelIds, next]
        : current.channelIds;
      const grant: ChannelMemberGrant = { ...current, channelIds };
      // The grant travels inside the token, so widening it has to mint a new
      // one. The old token is revoked rather than left valid beside it.
      const minted = encode(grant);
      sessions.delete(candidate);
      revoked.set(candidate, grant.expiresAt);
      store(minted, grant);
      return { token: minted, grant };
    },

    revoke(token) {
      const candidate = token.trim();
      const session = sessions.get(candidate);
      sessions.delete(candidate);
      const decoded = session ?? decode(candidate, Date.now());
      revoked.set(candidate, decoded?.expiresAt ?? Date.now() + CHANNEL_MEMBER_SESSION_TTL_MS);
    },
  };
}

/**
 * Whether a member credential may perform this request.
 *
 * The allowlist is expressed as exact route shapes rather than a prefix match:
 * a member reaching `/api/agents` or `/api/terminal/...` must be refused even
 * though they hold a valid credential, so "everything under /api that mentions
 * a channel" is not a safe rule. Every entry below is either a read of a
 * channel the member joined, or the invitation flow itself.
 */
export function channelMemberMayAccess(input: {
  grant: ChannelMemberGrant | null;
  method: string;
  path: string;
}): boolean {
  const { grant, path } = input;
  const method = input.method.toUpperCase();

  // The invitation flow is open to anyone holding a token: a teammate has no
  // credential until they have joined. The token itself is the capability, and
  // these routes evaluate it. A bad token yields 404 from the route, not access.
  if (/^\/api\/invites\/[^/]+$/.test(path) && method === "GET") return true;
  // `participate` sits beside `redeem` and `join` because it is the third way
  // an invitation is accepted -- by an HTTP client with no session and no
  // install. Like the other two it authenticates on the token alone.
  if (/^\/api\/invites\/[^/]+\/(redeem|join|participate)$/.test(path) && method === "POST") {
    return true;
  }

  if (!grant) return false;

  // Blobs are how a message carries a file. A member who can post must be
  // able to upload and then read the bytes back on the same origin; the id
  // is unguessable and the grant is already a live membership.
  if (path === "/api/blobs" && method === "POST") return true;
  if (/^\/api\/blobs\/[^/]+$/.test(path) && method === "GET") return true;
  if (path === "/api/link-preview" && method === "GET") return true;

  // Their own identity, and the channel list that identity can see.
  if (path === "/api/member/me" && method === "GET") return true;
  if (path === "/api/chat/bootstrap" && method === "GET") return true;
  // Reading the spaces they are in. The route itself returns only the spaces
  // their channels put them in, so this admits the read without admitting the
  // directory. Creating a space is operator work and is not listed here.
  if (path === "/api/chat/spaces" && method === "GET") return true;

  // Everything else requires the member to have joined the exact channel named
  // in the path.
  const channelMatch = /^\/api\/channels\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (channelMatch) {
    const channelId = decodeURIComponent(channelMatch[1] ?? "");
    if (!grant.channelIds.includes(channelId)) return false;
    const rest = channelMatch[2] ?? "";
    // Reads of their own channel: feed, roster, the invitations already issued
    // for it. None of these expose a raw token.
    if (method === "GET") return true;
    if (method === "POST") {
      // Posting is the whole of what a lightweight participant may write.
      if (rest === "messages") return true;
      if (rest === "blobs") return true;
      // Same access as posting: a reaction is an acknowledgment in the room.
      if (rest === "reactions" || rest === "reactions/remove") return true;
      // Everything below widens the room rather than speaking in it, and a
      // lightweight participant was not granted that. Minting invitations is
      // the sharp one: a joiner able to issue more would defeat the
      // `maxRedemptions` of the invitation that admitted it. Addressing an
      // agent is the softer one -- it dispatches tracked work to somebody
      // else's session -- and the no-install document promises neither.
      if (grant.participation === "api") return false;
      // Addressing one agent, and minting an invitation so a teammate can
      // bring their own agent into the room they are already in.
      if (rest === "asks" || rest === "invites") return true;
      if (/^asks\/[^/]+\/cancel$/.test(rest)) return true;
      // Revoking, but only an invitation they created -- being able to let
      // someone in without being able to take it back is not a permission, it
      // is a trap. Whose invitation it is cannot be decided from the path, so
      // the route checks authorship against the stored record.
      return /^invites\/[^/]+\/revoke$/.test(rest);
    }
    return false;
  }

  return false;
}

/**
 * Whether a member credential may act on a channel in this space.
 *
 * {@link channelMemberMayAccess} works from the request path alone and so can
 * only check the channel id -- which is already decisive, because a channel in
 * another space has a different id and is simply not in the grant. This is the
 * second, independent check, for the sites that have actually read the
 * conversation: it refuses a credential bound to one space acting on a channel
 * in another even if that channel somehow reached its `channelIds`.
 *
 * The space is read from the *credential*, never from the request. A header
 * naming a space is a selector; it can narrow a request and it can fail one,
 * and it can never be the thing that authorises one.
 */
export function channelMemberMayAccessSpace(input: {
  grant: Pick<ChannelMemberGrant, "spaceSlug"> | null;
  channelSpaceSlug: string;
}): boolean {
  if (!input.grant) return true;
  const held = normalizeChatSpaceSlug(input.grant.spaceSlug) ?? DEFAULT_CHAT_SPACE_SLUG;
  return held === input.channelSpaceSlug;
}

/**
 * A member credential presented as a bearer token.
 *
 * A browser sends the cookie; an HTTP client with no jar sends a header, and
 * telling a no-install agent to manage a cookie file is the kind of friction
 * that ends with the credential dropped. Both carry the same grant, and both
 * are checked the same way -- by the signature, through `validate`.
 *
 * This only *extracts* the value. It is not a decision: an operator bearer
 * token reaches this function too, and fails `validate` because it was never
 * signed with the member key. The two credentials cannot be confused in either
 * direction, which is why one header can carry either.
 */
export function channelMemberBearerToken(
  authorization: string | null | undefined,
): string | null {
  const header = authorization?.trim();
  if (!header || !header.toLowerCase().startsWith("bearer ")) return null;
  return header.slice(7).trim() || null;
}

/**
 * The member cookie. `HttpOnly` and `SameSite=Strict` for the same reasons the
 * operator cookie is: a member credential is a capability, and no script or
 * cross-site form should be able to read or replay it.
 */
export function channelMemberCookie(
  token: string,
  secure: boolean,
  host?: string | null,
): string {
  const hostname = (host ?? "").split(":")[0]?.toLowerCase() ?? "";
  const domain = hostname === "scout.local" || hostname.endsWith(".scout.local")
    ? "scout.local"
    : null;
  return [
    `${CHANNEL_MEMBER_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.floor(CHANNEL_MEMBER_SESSION_TTL_MS / 1000)}`,
    ...(domain ? [`Domain=${domain}`] : []),
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}
