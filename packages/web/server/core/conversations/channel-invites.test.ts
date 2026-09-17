import { describe, expect, test } from "bun:test";

import type { ChannelInviteRecord, ChannelInviteRoute } from "@openscout/protocol";

import {
  CHANNEL_INVITE_TOKEN_PATTERN,
  channelInviteDocumentJson,
  channelInviteReachabilityNote,
  channelInviteTokenHashEquals,
  channelInviteUrl,
  channelInviteViews,
  channelMemberReception,
  channelMemberRosterDecision,
  currentChannelMemberships,
  hashChannelInviteToken,
  mintChannelInviteToken,
  renderChannelInviteAgentInstructions,
  resolveChannelInviteRoute,
} from "./channel-invites.ts";

const NOW = 1_700_000_000_000;

const lanRoute: ChannelInviteRoute = {
  authorityNodeId: "node-local",
  host: "arts-mini.scout.local",
  baseUrl: "http://arts-mini.scout.local",
  reachability: "lan",
  caveat: "Local network only.",
};

const invite = (overrides: Partial<ChannelInviteRecord> = {}): ChannelInviteRecord => ({
  id: "inv-1",
  channelId: "chn-room",
  scope: "channel_participation",
  tokenHash: "d1ge57d1ge57",
  tokenHint: "hintab",
  createdAt: NOW - 1_000,
  createdByActorId: "operator",
  expiresAt: null,
  maxRedemptions: null,
  route: lanRoute,
  redemptions: [],
  ...overrides,
});

describe("token minting", () => {
  test("mints a URL-safe token with a matching digest and a non-secret hint", () => {
    const minted = mintChannelInviteToken();
    expect(minted.token).toMatch(CHANNEL_INVITE_TOKEN_PATTERN);
    expect(minted.tokenHash).toBe(hashChannelInviteToken(minted.token));
    expect(minted.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(minted.token.startsWith(minted.tokenHint)).toBe(true);
    // The hint must not be enough to reconstruct the token.
    expect(minted.tokenHint.length).toBeLessThan(minted.token.length / 2);
  });

  test("two mints never collide", () => {
    const tokens = new Set(Array.from({ length: 64 }, () => mintChannelInviteToken().token));
    expect(tokens.size).toBe(64);
  });

  test("hashing is stable across surrounding whitespace", () => {
    expect(hashChannelInviteToken(" abc ")).toBe(hashChannelInviteToken("abc"));
  });

  test("digest comparison rejects mismatched lengths without throwing", () => {
    expect(channelInviteTokenHashEquals("abc", "abc")).toBe(true);
    expect(channelInviteTokenHashEquals("ABC", "abc")).toBe(true);
    expect(channelInviteTokenHashEquals("abc", "abcd")).toBe(false);
    expect(channelInviteTokenHashEquals("abc", "abd")).toBe(false);
  });
});

describe("resolveChannelInviteRoute", () => {
  test("a concrete mesh base URL is the only route that earns mesh reachability", () => {
    const route = resolveChannelInviteRoute({
      authorityNodeId: "node-1",
      meshBaseUrl: "http://arts-mini.tail1234.ts.net",
      advertisedHost: "arts-mini.scout.local",
    });
    expect(route.baseUrl).toBe("http://arts-mini.tail1234.ts.net");
    expect(route.reachability).toBe("mesh");
    expect(channelInviteReachabilityNote(route).remoteUsable).toBe(true);
  });

  test("a doorway name offered as the mesh route is rejected, not promoted", () => {
    const route = resolveChannelInviteRoute({
      authorityNodeId: "node-1",
      meshBaseUrl: "http://arts-mini.scout.local",
      advertisedHost: "arts-mini.scout.local",
      webPort: 43120,
    });
    expect(route.reachability).toBe("unknown");
    expect(channelInviteReachabilityNote(route).remoteUsable).toBe(false);
  });

  test("a loopback mesh route is rejected too", () => {
    const route = resolveChannelInviteRoute({
      authorityNodeId: "node-1",
      meshBaseUrl: "http://127.0.0.1:43120",
      webPort: 43120,
    });
    expect(route.reachability).toBe("local_only");
  });

  test("a scout.local doorway name is never labelled LAN-reachable", () => {
    // These names resolve to 127.0.0.1 on every machine; treating one as a LAN
    // address is the exact mistake this feature must not make.
    for (const host of ["arts-mini.scout.local", "chat.scout.local", "scout.local"]) {
      const route = resolveChannelInviteRoute({
        authorityNodeId: "node-1",
        advertisedHost: host,
        webPort: 43120,
      });
      expect(route.reachability).toBe("unknown");
      expect(route.caveat).toContain("127.0.0.1 on every machine");
      expect(channelInviteReachabilityNote(route).remoteUsable).toBe(false);
    }
  });

  test("a real advertised hostname is LAN-scoped and says so", () => {
    const route = resolveChannelInviteRoute({
      authorityNodeId: "node-1",
      advertisedHost: "arts-mini.local",
      webPort: 43120,
    });
    expect(route.baseUrl).toBe("http://arts-mini.local:43120");
    expect(route.reachability).toBe("lan");
    expect(route.caveat).toContain("another network");
  });

  test("an explicitly configured loopback origin stays local and does not fall through", () => {
    const route = resolveChannelInviteRoute({
      authorityNodeId: "node-1",
      publicOrigin: "http://127.0.0.1:43120",
      advertisedHost: "arts-mini.local",
      webPort: 43120,
    });
    expect(route.reachability).toBe("local_only");
    expect(route.baseUrl).toBe("http://127.0.0.1:43120");
    expect(route.caveat).toContain("configured to serve on loopback");
  });

  test("a configured non-doorway origin wins over the advertised host", () => {
    const route = resolveChannelInviteRoute({
      authorityNodeId: "node-1",
      publicOrigin: "https://scout.example.com",
      advertisedHost: "arts-mini.local",
    });
    expect(route.baseUrl).toBe("https://scout.example.com");
    expect(route.reachability).toBe("lan");
    expect(route.caveat).toContain("has not verified");
  });

  test("a configured doorway origin is still only a doorway", () => {
    const route = resolveChannelInviteRoute({
      authorityNodeId: "node-1",
      publicOrigin: "http://chat.scout.local:43120",
    });
    expect(route.reachability).toBe("unknown");
    expect(route.caveat).toContain("127.0.0.1 on every machine");
  });

  test("a malformed configured origin falls through rather than inventing a route", () => {
    const route = resolveChannelInviteRoute({
      authorityNodeId: "node-1",
      publicOrigin: "not a url",
      advertisedHost: "arts-mini.local",
    });
    expect(route.baseUrl).toBe("http://arts-mini.local");
    expect(route.reachability).toBe("lan");
  });

  test("port 80 is omitted from the host", () => {
    const route = resolveChannelInviteRoute({
      authorityNodeId: "node-1",
      advertisedHost: "arts-mini.local",
      webPort: 80,
    });
    expect(route.baseUrl).toBe("http://arts-mini.local");
  });

  test("the bare portal host is reachability-unknown, never claimed as working", () => {
    const route = resolveChannelInviteRoute({
      authorityNodeId: "node-1",
      portalHost: "scout.local",
      webPort: 43120,
    });
    expect(route.reachability).toBe("unknown");
    expect(channelInviteReachabilityNote(route).remoteUsable).toBe(false);
  });

  test("with no evidence at all the route is honestly local-only", () => {
    const route = resolveChannelInviteRoute({ authorityNodeId: "node-1", webPort: 43120 });
    expect(route.reachability).toBe("local_only");
    const note = channelInviteReachabilityNote(route);
    expect(note.remoteUsable).toBe(false);
    expect(note.detail).toContain("only works from an agent running on this machine");
  });

  test("only mesh is ever reported as usable from off this network", () => {
    for (const reachability of ["lan", "local_only", "unknown"] as const) {
      const note = channelInviteReachabilityNote({ ...lanRoute, reachability });
      expect(note.remoteUsable).toBe(false);
      expect(note.detail.length).toBeGreaterThan(0);
    }
    expect(channelInviteReachabilityNote({ ...lanRoute, reachability: "mesh" }).remoteUsable)
      .toBe(true);
  });
});

describe("channelInviteUrl", () => {
  test("builds a stable URL and escapes the token", () => {
    expect(channelInviteUrl(lanRoute, "abc")).toBe("http://arts-mini.scout.local/invite/abc");
    expect(channelInviteUrl({ ...lanRoute, baseUrl: "http://x/" }, "a b")).toBe(
      "http://x/invite/a%20b",
    );
  });
});

describe("channelMemberReception", () => {
  const redeemed = invite({
    redemptions: [
      {
        id: "r1",
        actorId: "session-tesla",
        agentId: "agent-tesla",
        sessionId: "sess.tesla",
        redeemedAt: NOW - 5_000,
      },
    ],
  });

  test("the attached session comes from the redemption, not from whatever runs now", () => {
    const reception = channelMemberReception({
      actorId: "session-tesla",
      invites: [redeemed],
      endpoint: {
        state: "idle",
        transport: "claude_stream_json",
        sessionId: "sess.tesla",
        lastSeenAt: NOW,
      },
      nowMs: NOW,
    });
    expect(reception.attachedSessionId).toBe("sess.tesla");
    expect(reception.state).toBe("ready_to_receive");
    expect(reception.listening).toBe(true);
    expect(reception.redeemedAt).toBe(NOW - 5_000);
  });

  test("a live endpoint for a different session does not make the invited member ready", () => {
    const reception = channelMemberReception({
      actorId: "session-tesla",
      invites: [redeemed],
      endpoint: {
        state: "idle",
        transport: "claude_stream_json",
        sessionId: "sess.somethingelse",
        lastSeenAt: NOW,
      },
      nowMs: NOW,
    });
    expect(reception.attachedSessionId).toBe("sess.tesla");
    expect(reception.state).toBe("disconnected");
    expect(reception.listening).toBe(false);
  });

  test("a member with no redemption and no endpoint is waiting for an agent", () => {
    const reception = channelMemberReception({
      actorId: "person-maya",
      invites: [redeemed],
      endpoint: null,
      nowMs: NOW,
    });
    expect(reception.state).toBe("waiting_for_agent");
    expect(reception.attachedSessionId).toBeNull();
    expect(reception.redeemedAt).toBeNull();
  });

  test("a redeemed member whose endpoint died reads as disconnected", () => {
    const reception = channelMemberReception({
      actorId: "session-tesla",
      invites: [redeemed],
      endpoint: { state: "offline", transport: "claude_stream_json", sessionId: "sess.tesla", lastSeenAt: NOW },
      nowMs: NOW,
    });
    expect(reception.state).toBe("disconnected");
    expect(reception.listening).toBe(false);
  });

  test("a redemption is matched by agent id as well as actor id", () => {
    const reception = channelMemberReception({
      actorId: "agent-tesla",
      invites: [redeemed],
      endpoint: { state: "idle", transport: "codex_app_server", sessionId: "sess.tesla", lastSeenAt: NOW },
      nowMs: NOW,
    });
    expect(reception.attachedSessionId).toBe("sess.tesla");
  });

  test("a wake-on-delivery route is never reported as listening", () => {
    const reception = channelMemberReception({
      actorId: "session-tesla",
      invites: [redeemed],
      endpoint: { state: "idle", transport: "claude_resume", sessionId: "sess.tesla", lastSeenAt: NOW },
      nowMs: NOW,
    });
    expect(reception.listening).toBe(false);
    expect(reception.detail).toContain("nothing is watching the channel between messages");
  });
});

describe("channelInviteViews", () => {
  test("reads invitations off conversation metadata newest first with no digest", () => {
    const views = channelInviteViews(
      {
        metadata: {
          channelInvites: [
            invite(),
            invite({ id: "inv-2", createdAt: NOW, tokenHash: "deadbeef" }),
          ],
        },
      },
      NOW,
    );
    expect(views.map((view) => view.id)).toEqual(["inv-2", "inv-1"]);
    expect(JSON.stringify(views)).not.toContain("deadbeef");
  });

  test("a conversation with no invitations yields none", () => {
    expect(channelInviteViews(null, NOW)).toEqual([]);
    expect(channelInviteViews({ metadata: {} }, NOW)).toEqual([]);
  });
});

describe("the invitation document", () => {
  const documentInput = {
    channelId: "chn-room",
    channelTitle: "design-room",
    channelTopic: "Scout Chat shape",
    inviterDisplayName: "Arach",
    inviteeDisplayName: "Maya",
    invite: channelInviteViews({ metadata: { channelInvites: [invite()] } }, NOW)[0]!,
    inviteUrl: "http://arts-mini.scout.local/invite/tok_abc123",
    redeemUrl: "http://arts-mini.scout.local/api/invites/tok_abc123/redeem",
    apiBaseUrl: "http://arts-mini.scout.local",
    brokerBaseUrl: "http://127.0.0.1:43110",
  };

  test("agent instructions name the channel, the scope, and the exact redeem call", () => {
    const text = renderChannelInviteAgentInstructions(documentInput);
    expect(text).toContain("#design-room");
    expect(text).toContain("channel_participation");
    // The API endpoint, not the invitation page. Telling an agent to POST to
    // the page URL sends it to a 404 with nothing to explain it.
    expect(text).toContain("POST http://arts-mini.scout.local/api/invites/tok_abc123/redeem");
    expect(text).not.toContain("/invite/tok_abc123/redeem");
    expect(text).toContain("Scout Chat shape");
  });

  test("every rendered command is complete, with no unfilled value", () => {
    const text = renderChannelInviteAgentInstructions(documentInput);
    // A missing document input renders as the literal string "undefined" inside
    // a command an agent is told to run. Catch it here rather than in someone's
    // terminal.
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("[object Object]");
    for (const line of text.split("\n").filter((entry) => entry.startsWith("curl "))) {
      expect(line).toContain("http://arts-mini.scout.local/");
    }
  });

  test("the credential the agent must keep is shown being captured and reused", () => {
    const text = renderChannelInviteAgentInstructions(documentInput);
    // Redemption returns a scoped cookie. Without capturing it an agent is on
    // the roster and cannot read the channel or answer in it, which is the
    // failure this section exists to prevent.
    expect(text).toContain("-c scout-channel.jar");
    const participating = text.slice(text.indexOf("## Participating"));
    for (const line of participating.split("\n").filter((entry) => entry.startsWith("curl "))) {
      expect(line).toContain("-b scout-channel.jar");
    }
  });

  test("instructions never claim whoami reports a session id", () => {
    const text = renderChannelInviteAgentInstructions(documentInput);
    // `scout whoami --json` has no sessionId field; telling an agent to read
    // one yields a literal null and a redemption attached to nothing.
    expect(text).not.toContain("whoami --json | jq -r .sessionId");
    expect(text).toContain("does **not** report a session id");
    // And it must not offer redeeming without one as a fallback: that consumes
    // the invitation on an attachment that can never receive.
    expect(text).toContain("do not redeem");
  });

  test("the scoped channel contract an agent needs after joining is spelled out", () => {
    const text = renderChannelInviteAgentInstructions(documentInput);
    for (const path of [
      "/api/channels/chn-room/feed",
      "/api/channels/chn-room/messages",
      "/api/channels/chn-room/asks",
      "/api/channels/chn-room/members",
    ]) {
      expect(text).toContain(path);
    }
    expect(text).toContain("replyToMessageId");
    expect(text).toContain("targetActorId");
    // Routing is structural. A name in the body is prose.
    expect(text).toContain("Writing a name into the body addresses nobody");
  });

  test("instructions state that reading never joins and that redeeming is idempotent", () => {
    const text = renderChannelInviteAgentInstructions(documentInput);
    expect(text).toContain("`GET` on the invitation URL only describes it");
    expect(text).toContain("idempotent");
    expect(text).toContain("does not create a second identity");
  });

  test("instructions cover every failure an agent can hit", () => {
    const text = renderChannelInviteAgentInstructions(documentInput);
    for (const code of ["410", "404", "403", "400", "5xx"]) {
      expect(text).toContain(code);
    }
  });

  test("instructions refuse to imply an ordinary post is a task", () => {
    const text = renderChannelInviteAgentInstructions(documentInput);
    expect(text).toContain("An ordinary channel post is an update, not a request for work");
  });

  test("instructions state that membership is not reception", () => {
    const text = renderChannelInviteAgentInstructions(documentInput);
    expect(text).toContain("Membership is not reception");
    expect(text).toContain("will not claim you are listening");
  });

  test("instructions carry the route's reachability caveat verbatim", () => {
    const text = renderChannelInviteAgentInstructions(documentInput);
    expect(text).toContain("Local network only");
  });

  test("markdown structure survives an absent channel topic", () => {
    const text = renderChannelInviteAgentInstructions({
      ...documentInput,
      channelTopic: null,
    });
    expect(text).not.toContain("Channel topic:");
    // Headings must stay on their own line with a blank line before them, or
    // the document renders as one run-on paragraph.
    expect(text).toContain("\n\n## Redeem\n\n");
    expect(text).toContain("\n\n## What this grants\n\n");
  });

  test("a present topic keeps its own paragraph", () => {
    const text = renderChannelInviteAgentInstructions(documentInput);
    expect(text).toContain("\n\nChannel topic: Scout Chat shape\n");
  });

  test("the JSON document carries no token digest and points at the instructions", () => {
    const json = channelInviteDocumentJson(documentInput);
    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain("tokenHash");
    expect(serialized).not.toContain("d1ge57");
    expect(json.redeem.method).toBe("POST");
    expect(json.redeem.idempotent).toBe(true);
    // The API endpoint, not the page.
    expect(json.redeem.url).toBe("http://arts-mini.scout.local/api/invites/tok_abc123/redeem");
    // Session is required, and the credential the caller must keep is named.
    expect(json.redeem.required).toEqual(["actorId", "sessionId"]);
    expect(json.redeem.body.sessionId).toContain("required");
    expect(json.redeem.credential.cookie).toBe("openscout_member");
    // And the scoped surface that credential unlocks.
    expect(json.channelApi.feed).toBe(
      "http://arts-mini.scout.local/api/channels/chn-room/feed",
    );
    expect(json.channelApi.ask).toBe(
      "http://arts-mini.scout.local/api/channels/chn-room/asks",
    );
    expect(json.instructionsUrl).toBe(
      "http://arts-mini.scout.local/invite/tok_abc123/agent.md",
    );
    expect(json.reachability.remoteUsable).toBe(false);
  });
});

describe("a removed member loses the room, credential or not", () => {
  const channel = { kind: "channel", participantIds: ["person-art", "person-maya"] };

  test("the operator is not judged by a channel roster", () => {
    // The operator holds no member grant; their own credential is what
    // authorizes them, and they are not a participant of every channel.
    expect(channelMemberRosterDecision({
      grant: null,
      conversation: { kind: "channel", participantIds: [] },
      brokerReachable: true,
    })).toBeNull();
  });

  test("a member still on the roster is admitted", () => {
    expect(channelMemberRosterDecision({
      grant: { actorId: "person-maya" },
      conversation: channel,
      brokerReachable: true,
    })).toBeNull();
  });

  test("a member removed from the roster is refused even with a valid credential", () => {
    // This is the whole reason the roster is re-read: the cookie is durable by
    // design, so removal has to come from somewhere the cookie cannot vouch for.
    expect(channelMemberRosterDecision({
      grant: { actorId: "person-jun" },
      conversation: channel,
      brokerReachable: true,
    })?.status).toBe(403);
  });

  test("an unreadable roster refuses rather than assuming membership", () => {
    expect(channelMemberRosterDecision({
      grant: { actorId: "person-maya" },
      conversation: null,
      brokerReachable: false,
    })?.status).toBe(502);
  });

  test("a thread or a missing channel is not a room anyone is a member of", () => {
    expect(channelMemberRosterDecision({
      grant: { actorId: "person-maya" },
      conversation: { kind: "thread", participantIds: ["person-maya"] },
      brokerReachable: true,
    })?.status).toBe(403);
    expect(channelMemberRosterDecision({
      grant: { actorId: "person-maya" },
      conversation: null,
      brokerReachable: true,
    })?.status).toBe(403);
  });
});

describe("what a member's credential is still good for", () => {
  const CHANNEL = "chn-0123456789abcdef0123456789abcdef";
  const OTHER = "chn-fedcba9876543210fedcba9876543210";
  const grant = { actorId: "person-maya", channelIds: [CHANNEL, OTHER] };

  test("only the rooms whose roster still names them are reported", () => {
    // The grant is a capability that outlives removal on purpose. Echoing it
    // back as membership is what sent a removed teammate to "Open room" and
    // then straight back to the invitation page.
    expect(currentChannelMemberships({
      grant,
      conversations: {
        [CHANNEL]: { kind: "channel", participantIds: ["person-art", "person-maya"] },
        [OTHER]: { kind: "channel", participantIds: ["person-art"] },
      },
    })).toEqual([CHANNEL]);
  });

  test("a channel that no longer exists is not a membership", () => {
    expect(currentChannelMemberships({
      grant,
      conversations: { [CHANNEL]: { kind: "channel", participantIds: ["person-maya"] } },
    })).toEqual([CHANNEL]);
  });

  test("a thread the grant happens to name is not a room", () => {
    expect(currentChannelMemberships({
      grant: { actorId: "person-maya", channelIds: [CHANNEL] },
      conversations: { [CHANNEL]: { kind: "thread", participantIds: ["person-maya"] } },
    })).toEqual([]);
  });

  test("an unread roster reports that it could not check, not that they are in nothing", () => {
    // Empty would be a claim of removal, and the caller would sign a perfectly
    // good member out of every room because the broker blipped.
    expect(currentChannelMemberships({ grant, conversations: null })).toBeNull();
  });

  test("being re-invited to a room restores it without a new cookie", () => {
    // Removal and reinstatement both live in the roster, so the same durable
    // credential has to follow both directions.
    const removed = currentChannelMemberships({
      grant,
      conversations: { [CHANNEL]: { kind: "channel", participantIds: ["person-art"] } },
    });
    expect(removed).toEqual([]);
    expect(currentChannelMemberships({
      grant,
      conversations: {
        [CHANNEL]: { kind: "channel", participantIds: ["person-art", "person-maya"] },
      },
    })).toEqual([CHANNEL]);
  });
});
