import { describe, expect, test } from "bun:test";
import {
  evaluateChannelInviteRedemption,
  type ChannelInviteRecord,
} from "./channel-invites.js";
import { deriveChannelReception } from "./channel-reception.js";

// Coordinator acceptance tests: the room must retain the invited context and
// must not promise reception using evidence from a different or unknown session.
const NOW = 1_800_000_000_000;
function invitation(maxRedemptions = 2): ChannelInviteRecord {
  return {
    id: "invite-continuity", channelId: "room", scope: "channel_participation",
    tokenHash: "digest", tokenHint: "hint", createdAt: NOW - 100,
    createdByActorId: "maya", expiresAt: NOW + 1000, maxRedemptions,
    route: { authorityNodeId: "node-a", host: "127.0.0.1", baseUrl: "http://127.0.0.1", reachability: "local_only" },
    redemptions: [{ id: "redemption-a", actorId: "maya-agent", agentId: "maya-agent", sessionId: "session-a", nodeId: "node-a", redeemedAt: NOW - 50 }],
  };
}

describe("existing-session invitation continuity", () => {
  test("a second session of the same durable agent does not reuse the first context", () => {
    const outcome = evaluateChannelInviteRedemption({
      invite: invitation(), nowMs: NOW,
      request: { actorId: "maya-agent", agentId: "maya-agent", sessionId: "session-b", nodeId: "node-a" },
    });
    expect(outcome).toEqual({ ok: true, existing: null });
  });

  test("an exhausted invite cannot be redeemed by a different session through its shared agent id", () => {
    const outcome = evaluateChannelInviteRedemption({
      invite: invitation(1), nowMs: NOW,
      request: { actorId: "maya-agent", agentId: "maya-agent", sessionId: "session-b", nodeId: "node-a" },
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.rejection.reason).toBe("exhausted");
  });

  test("the original exact session can retry without consuming another slot", () => {
    const outcome = evaluateChannelInviteRedemption({
      invite: invitation(1), nowMs: NOW,
      request: { actorId: "maya-agent", agentId: "maya-agent", sessionId: "session-a", nodeId: "node-a" },
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.existing?.id).toBe("redemption-a");
  });
});

describe("reception evidence belongs to the invited session", () => {
  test("an endpoint without a channel session attachment does not establish readiness", () => {
    const result = deriveChannelReception({ nowMs: NOW,
      endpoint: { state: "active", transport: "codex_app_server", sessionId: "session-a", lastSeenAt: NOW },
    });
    expect(result.listening).toBe(false);
    expect(result.state).not.toBe("ready_to_receive");
  });

  test("a fresh endpoint for another session cannot make the invited session ready", () => {
    const result = deriveChannelReception({ nowMs: NOW, attachedSessionId: "session-a",
      endpoint: { state: "active", transport: "codex_app_server", sessionId: "session-b", lastSeenAt: NOW },
    });
    expect(result.listening).toBe(false);
    expect(result.state).not.toBe("ready_to_receive");
  });

  test("a transport with no observation timestamp is not proof of readiness", () => {
    const result = deriveChannelReception({ nowMs: NOW, attachedSessionId: "session-a",
      endpoint: { state: "active", transport: "codex_app_server", sessionId: "session-a" },
    });
    expect(result.listening).toBe(false);
    expect(result.state).not.toBe("ready_to_receive");
  });

  test("a fresh endpoint with no session identity cannot vouch for the attached session", () => {
    const result = deriveChannelReception({ nowMs: NOW, attachedSessionId: "session-a",
      endpoint: { state: "active", transport: "codex_app_server", lastSeenAt: NOW },
    });
    expect(result.listening).toBe(false);
    expect(result.state).not.toBe("ready_to_receive");
  });

  test("registration alone is not an active receive route even with a registration timestamp", () => {
    const result = deriveChannelReception({ nowMs: NOW, attachedSessionId: "session-a",
      endpoint: { state: "registered", transport: "codex_app_server", sessionId: "session-a", lastSeenAt: NOW },
    });
    expect(result.listening).toBe(false);
    expect(result.state).not.toBe("ready_to_receive");
  });
});
