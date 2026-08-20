import { describe, expect, test } from "bun:test";

import { resolveAgentRuntimeIdentity } from "./agent-runtime-identity.ts";

describe("resolveAgentRuntimeIdentity", () => {
  test("shows configured runtime identity before observe data arrives", () => {
    expect(resolveAgentRuntimeIdentity(
      { model: "MiniMax-M3", providerName: "minimax" },
      undefined,
    )).toEqual({ model: "MiniMax-M3", provider: "minimax" });
  });

  test("prefers observed runtime identity after the session starts", () => {
    expect(resolveAgentRuntimeIdentity(
      { model: "MiniMax-M3", providerName: "minimax" },
      {
        agentId: "agent-1",
        source: "live",
        fidelity: "timestamped",
        historyPath: null,
        sessionId: "session-1",
        updatedAt: 1,
        data: {
          events: [],
          files: [],
          metadata: { session: { model: "MiniMax-M3-live", modelProvider: "minimax-live" } },
        },
      },
    )).toEqual({ model: "MiniMax-M3-live", provider: "minimax-live" });
  });
});
