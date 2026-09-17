import { describe, expect, test } from "bun:test";

import {
  CHANNEL_RECEPTION_STALE_AFTER_MS,
  channelReceptionRouteKind,
  deriveChannelReception,
  type ChannelReceptionEvidence,
} from "./channel-reception.js";

const NOW = 1_700_000_000_000;

const evidence = (
  overrides: Partial<ChannelReceptionEvidence> = {},
): ChannelReceptionEvidence => ({
  nowMs: NOW,
  attachedSessionId: "sess.tesla",
  endpoint: {
    state: "idle",
    transport: "claude_stream_json",
    sessionId: "sess.tesla",
    lastSeenAt: NOW - 1_000,
  },
  ...overrides,
});

describe("channelReceptionRouteKind", () => {
  test("live session transports hold a persistent listener", () => {
    expect(channelReceptionRouteKind("claude_stream_json")).toBe("persistent");
    expect(channelReceptionRouteKind("codex_app_server")).toBe("persistent");
    expect(channelReceptionRouteKind("claude_channel")).toBe("persistent");
  });

  test("resume and exec transports only wake on delivery", () => {
    expect(channelReceptionRouteKind("claude_resume")).toBe("wake_on_delivery");
    expect(channelReceptionRouteKind("codex_exec")).toBe("wake_on_delivery");
    expect(channelReceptionRouteKind("tmux")).toBe("wake_on_delivery");
  });

  test("no transport is no route", () => {
    expect(channelReceptionRouteKind(null)).toBe("none");
  });
});

describe("deriveChannelReception", () => {
  test("a member with no attached session is waiting for an agent", () => {
    const reception = deriveChannelReception(
      evidence({ attachedSessionId: null, endpoint: null }),
    );
    expect(reception.state).toBe("waiting_for_agent");
    expect(reception.listening).toBe(false);
    expect(reception.detail).toContain("no agent session has redeemed");
  });

  test("an attached session with no endpoint is unavailable, not ready", () => {
    const reception = deriveChannelReception(evidence({ endpoint: null }));
    expect(reception.state).toBe("unavailable");
    expect(reception.listening).toBe(false);
    expect(reception.detail).toContain("no registered endpoint");
  });

  test("a live persistent route is the only case that claims listening", () => {
    const reception = deriveChannelReception(evidence());
    expect(reception.state).toBe("ready_to_receive");
    expect(reception.listening).toBe(true);
    expect(reception.routeKind).toBe("persistent");
  });

  test("a wake-on-delivery route is reachable but never listening", () => {
    const reception = deriveChannelReception(
      evidence({
        endpoint: { state: "idle", transport: "claude_resume", sessionId: "sess.tesla", lastSeenAt: NOW },
      }),
    );
    expect(reception.state).toBe("ready_to_receive");
    expect(reception.listening).toBe(false);
    expect(reception.summary).toBe("Wakes on delivery");
    expect(reception.detail).toContain("nothing is watching the channel between messages");
  });

  test("a resumed route says the invited session keeps its context", () => {
    const reception = deriveChannelReception(
      evidence({
        endpoint: { state: "idle", transport: "claude_resume", sessionId: "sess.tesla", lastSeenAt: NOW },
      }),
    );
    expect(reception.detail).toContain("resuming session sess.tesla");
    expect(reception.detail).toContain("never replaced");
    // "starts a new run" would misdescribe a resumed exact session.
    expect(reception.detail).not.toContain("new run");
  });

  test("a tmux route is described as steering, not resuming", () => {
    const reception = deriveChannelReception(
      evidence({ endpoint: { state: "idle", transport: "tmux", sessionId: "sess.tesla", lastSeenAt: NOW } }),
    );
    expect(reception.detail).toContain("steering session sess.tesla");
    expect(reception.listening).toBe(false);
  });

  test("a warming route reads as connecting", () => {
    for (const state of ["attaching", "waking"] as const) {
      const reception = deriveChannelReception(
        evidence({ endpoint: { state, transport: "codex_app_server", sessionId: "sess.tesla", lastSeenAt: NOW } }),
      );
      expect(reception.state).toBe("connecting");
      expect(reception.listening).toBe(false);
    }
  });

  test("offline and stopped routes read as disconnected", () => {
    for (const state of ["offline", "stopped"] as const) {
      const reception = deriveChannelReception(
        evidence({ endpoint: { state, transport: "claude_stream_json", sessionId: "sess.tesla", lastSeenAt: NOW } }),
      );
      expect(reception.state).toBe("disconnected");
      expect(reception.listening).toBe(false);
    }
  });

  test("unreachable and failed routes read as unavailable", () => {
    for (const state of ["unreachable", "failed"] as const) {
      const reception = deriveChannelReception(
        evidence({ endpoint: { state, transport: "claude_stream_json", sessionId: "sess.tesla", lastSeenAt: NOW } }),
      );
      expect(reception.state).toBe("unavailable");
      expect(reception.listening).toBe(false);
    }
  });

  test("a superseded endpoint keeps membership but stops receiving", () => {
    const reception = deriveChannelReception(
      evidence({ endpoint: { state: "superseded", transport: "claude_stream_json", sessionId: "sess.tesla", lastSeenAt: NOW } }),
    );
    expect(reception.state).toBe("disconnected");
    expect(reception.detail).toContain("membership stands");
  });

  test("a persistent route that has gone silent stops being vouched for", () => {
    const lastSeenAt = NOW - CHANNEL_RECEPTION_STALE_AFTER_MS - 1;
    const reception = deriveChannelReception(
      evidence({ endpoint: { state: "idle", transport: "claude_stream_json", sessionId: "sess.tesla", lastSeenAt } }),
    );
    expect(reception.state).toBe("disconnected");
    expect(reception.listening).toBe(false);
    expect(reception.evidenceAt).toBe(lastSeenAt);
  });

  test("registration without observation is not proof a persistent route is listening", () => {
    const reception = deriveChannelReception(
      evidence({ endpoint: { state: "working", transport: "codex_app_server", sessionId: "sess.tesla", lastSeenAt: null } }),
    );
    expect(reception.state).toBe("connecting");
    expect(reception.listening).toBe(false);
    expect(reception.detail).toContain("never been observed live");
    expect(reception.evidenceAt).toBeNull();
  });

  test("an unobserved wake-on-delivery route stays reachable, since it claims no listener", () => {
    const reception = deriveChannelReception(
      evidence({ endpoint: { state: "idle", transport: "codex_exec", sessionId: "sess.tesla", lastSeenAt: null } }),
    );
    expect(reception.state).toBe("ready_to_receive");
    expect(reception.listening).toBe(false);
  });

  test("an endpoint belonging to a different session is not this member's evidence", () => {
    const reception = deriveChannelReception(
      evidence({
        attachedSessionId: "sess.tesla",
        endpoint: {
          state: "working",
          transport: "claude_stream_json",
          sessionId: "sess.other",
          lastSeenAt: NOW,
        },
      }),
    );
    expect(reception.state).toBe("disconnected");
    expect(reception.listening).toBe(false);
    expect(reception.detail).toContain("sess.other");
  });

  test("a live route with no attached session cannot stand in for membership", () => {
    const reception = deriveChannelReception(
      evidence({
        attachedSessionId: null,
        endpoint: {
          state: "working",
          transport: "claude_stream_json",
          sessionId: "sess.tesla",
          lastSeenAt: NOW,
        },
      }),
    );
    // The member simply has not brought a session in. A busy route belonging to
    // them elsewhere is not this channel's route, and reporting it as
    // "unavailable" would blame a broken link for a join that never happened.
    expect(reception.state).toBe("waiting_for_agent");
    expect(reception.listening).toBe(false);
    expect(reception.detail).toContain("not redeemed an invitation");
  });

  test("every reading carries an explanation", () => {
    const states = ["idle", "attaching", "offline", "failed", "superseded"] as const;
    for (const state of states) {
      const reception = deriveChannelReception(
        evidence({ endpoint: { state, transport: "claude_stream_json", sessionId: "sess.tesla", lastSeenAt: NOW } }),
      );
      expect(reception.detail.length).toBeGreaterThan(20);
      expect(reception.summary.length).toBeGreaterThan(0);
    }
  });
});
