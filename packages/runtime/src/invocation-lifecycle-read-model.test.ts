import { describe, expect, test } from "bun:test";

import { readInvocationLifecycle } from "./invocation-lifecycle-read-model.js";
import { createRuntimeRegistrySnapshot } from "./registry.js";

describe("readInvocationLifecycle", () => {
  test("summarizes the invocation from its latest flight", () => {
    const snapshot = createRuntimeRegistrySnapshot({
      invocations: {
        "inv-1": {
          id: "inv-1",
          requesterId: "operator",
          requesterNodeId: "node-1",
          targetAgentId: "agent-1",
          action: "consult",
          task: "check this",
          messageId: "msg-1",
          ensureAwake: true,
          stream: false,
          timeoutMs: 60_000,
          createdAt: 1_000,
        },
      },
      flights: {
        "flight-old": {
          id: "flight-old",
          invocationId: "inv-1",
          requesterId: "operator",
          targetAgentId: "agent-1",
          state: "queued",
          startedAt: 1_050,
        },
        "flight-1": {
          id: "flight-1",
          invocationId: "inv-1",
          requesterId: "operator",
          targetAgentId: "agent-1",
          state: "running",
          startedAt: 1_100,
        },
      },
    });

    // Latest flight (flight-1) wins; the summary is a flat subset, no re-merge.
    expect(readInvocationLifecycle({ snapshot, invocationId: "inv-1" })).toEqual({
      invocationId: "inv-1",
      flightId: "flight-1",
      targetAgentId: "agent-1",
      state: "running",
      startedAt: 1_100,
    });
  });

  test("returns null for missing invocation ids", () => {
    expect(readInvocationLifecycle({
      snapshot: createRuntimeRegistrySnapshot(),
      invocationId: "missing",
    })).toBeNull();
  });
});
