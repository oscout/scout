import { expect, test } from "bun:test";
import { channelMemberReception } from "./channel-invites.ts";

test("a fresh generic agent endpoint does not invent attachment to this channel", () => {
  const result = channelMemberReception({
    actorId: "existing-agent", invites: [], nowMs: 1_000,
    endpoint: { state: "idle", transport: "codex_app_server", sessionId: "other-context", lastSeenAt: 999 },
  });
  expect(result.attachedSessionId).toBeNull();
  expect(result.listening).toBe(false);
  expect(result.state).toBe("waiting_for_agent");
});
