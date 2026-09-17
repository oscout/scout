import { describe, expect, test } from "bun:test";
import type { ChannelInviteRecord } from "@openscout/protocol";

import { channelAskDispatchNote, planChannelAsks } from "./channel-ask.ts";

const NOW = 1_800_000_000_000;

function inviteWith(redemptions: ChannelInviteRecord["redemptions"]): ChannelInviteRecord {
  return {
    id: "cinv-1",
    channelId: "chn-1",
    scope: "channel_participation",
    tokenHash: "d1ge57",
    tokenHint: "hint",
    createdAt: NOW - 10_000,
    createdByActorId: "person-art",
    expiresAt: null,
    maxRedemptions: null,
    route: {
      authorityNodeId: "node-1",
      host: "127.0.0.1",
      baseUrl: "http://127.0.0.1",
      reachability: "local_only",
    },
    redemptions,
  };
}

const KEPLER_REDEEMED = inviteWith([
  {
    id: "crdm-1",
    actorId: "agent-kepler",
    agentId: "agent-kepler",
    sessionId: "sess.kepler",
    redeemedAt: NOW - 5_000,
  },
]);

const base = {
  participantIds: ["person-art", "person-maya", "agent-kepler"],
  invites: [KEPLER_REDEEMED],
  nowMs: NOW,
};

const keplerLive = {
  actorId: "agent-kepler",
  isAgent: true,
  label: "Maya's Kepler",
  endpoint: {
    state: "idle",
    transport: "codex_app_server",
    sessionId: "sess.kepler",
    lastSeenAt: NOW - 1_000,
  },
};

describe("a channel post only becomes work when it addresses an agent", () => {
  test("a post that mentions nobody creates no tracked ask", () => {
    const plan = planChannelAsks({ ...base, mentionedActorIds: [], candidates: [keplerLive] });
    expect(plan.asks).toHaveLength(0);
    expect(plan.skipped).toHaveLength(0);
  });

  test("mentioning a person notifies them and invokes nothing", () => {
    const plan = planChannelAsks({
      ...base,
      mentionedActorIds: ["person-maya"],
      candidates: [
        { actorId: "person-maya", isAgent: false, label: "Maya", endpoint: null },
        keplerLive,
      ],
    });
    expect(plan.asks).toHaveLength(0);
    expect(plan.skipped[0]?.reason).toBe("not_an_agent");
  });

  test("addressing one agent yields exactly one tracked ask, routed to the attached session", () => {
    const plan = planChannelAsks({
      ...base,
      mentionedActorIds: ["agent-kepler"],
      candidates: [keplerLive],
    });
    expect(plan.asks).toHaveLength(1);
    expect(plan.asks[0]?.sessionId).toBe("sess.kepler");
    expect(plan.asks[0]?.reception.listening).toBe(true);
  });

  test("mentioning the same agent twice is still one ask", () => {
    const plan = planChannelAsks({
      ...base,
      mentionedActorIds: ["agent-kepler", "agent-kepler"],
      candidates: [keplerLive],
    });
    expect(plan.asks).toHaveLength(1);
  });

  test("an agent that never redeemed gets no ask, and the omission is reported", () => {
    const plan = planChannelAsks({
      ...base,
      invites: [],
      mentionedActorIds: ["agent-kepler"],
      candidates: [keplerLive],
    });
    expect(plan.asks).toHaveLength(0);
    // Silence here would be the real failure: the asker must learn nothing was
    // dispatched rather than waiting on an ask that does not exist.
    expect(plan.skipped[0]?.reason).toBe("no_attached_session");
  });

  test("an agent outside the channel is never invoked by mentioning it", () => {
    const plan = planChannelAsks({
      ...base,
      mentionedActorIds: ["agent-outsider"],
      candidates: [
        { actorId: "agent-outsider", isAgent: true, label: "Outsider", endpoint: null },
      ],
    });
    expect(plan.asks).toHaveLength(0);
    expect(plan.skipped[0]?.reason).toBe("not_a_member");
  });

  test("an ask still tracks when the agent is not reachable", () => {
    const plan = planChannelAsks({
      ...base,
      mentionedActorIds: ["agent-kepler"],
      candidates: [{
        ...keplerLive,
        endpoint: {
          state: "offline",
          transport: "codex_app_server",
          sessionId: "sess.kepler",
          lastSeenAt: NOW - 1_000,
        },
      }],
    });
    // The work is real and owed; it is the delivery claim that must stay honest.
    expect(plan.asks).toHaveLength(1);
    expect(plan.asks[0]?.reception.state).toBe("disconnected");
    expect(plan.asks[0]?.reception.listening).toBe(false);
  });

  test("an ask routes to the invited session, not to a newer one", () => {
    const plan = planChannelAsks({
      ...base,
      mentionedActorIds: ["agent-kepler"],
      candidates: [{
        ...keplerLive,
        endpoint: {
          state: "idle",
          transport: "codex_app_server",
          sessionId: "sess.kepler-restarted",
          lastSeenAt: NOW,
        },
      }],
    });
    expect(plan.asks[0]?.sessionId).toBe("sess.kepler");
    expect(plan.asks[0]?.reception.listening).toBe(false);
  });
});

describe("the dispatch note never overstates delivery", () => {
  const note = (overrides: Parameters<typeof channelAskDispatchNote>[0]) =>
    channelAskDispatchNote(overrides, "Maya's Kepler");

  test("a wake-on-delivery route explains itself instead of claiming a listener", () => {
    const text = note({
      state: "ready_to_receive",
      routeKind: "wake_on_delivery",
      listening: false,
      summary: "Wakes on delivery",
      detail: "",
      evidenceAt: NOW,
    });
    expect(text).toContain("Nothing is listening between messages");
    expect(text).not.toContain("Delivered");
  });

  test("even a live listener is only queued, never reported as delivered", () => {
    // Readiness says a message can be attempted. Acceptance and delivery come
    // from delivery records and the flight lifecycle, never from this note.
    const ready = note({
      state: "ready_to_receive",
      routeKind: "persistent",
      listening: true,
      summary: "Ready",
      detail: "",
      evidenceAt: NOW,
    });
    expect(ready).toContain("Queued");
    expect(ready.toLowerCase()).not.toContain("deliver");

    for (const state of ["waiting_for_agent", "connecting", "disconnected", "unavailable"] as const) {
      const text = note({
        state,
        routeKind: "none",
        listening: false,
        summary: "",
        detail: "",
        evidenceAt: null,
      });
      expect(text).toContain("Queued");
      expect(text).not.toContain("Delivered");
    }
  });
});
