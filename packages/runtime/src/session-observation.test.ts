import { expect, test } from "bun:test";
import type { AgentEndpoint } from "@openscout/protocol";
import { sessionObservationMetadata } from "./session-observation.js";
import { promoteLocalEndpointProviderSession, observedRuntimeForEndpoint } from "./broker-local-endpoint-resolver.js";
import { endpointMatchesTargetSession } from "./broker-endpoint-selection.js";

test("authoritative identity removes obsolete native aliases and legacy runtime dimensions", () => {
  const endpoint: AgentEndpoint = {
    id: "endpoint", agentId: "agent", nodeId: "node", harness: "claude", transport: "tmux", state: "idle",
    sessionId: "scout-tmux", metadata: {
      externalSessionId: "native-A", nativeSessionId: "native-A", threadId: "native-A",
      sessionId: "native-A", runtimeSessionId: "scout-tmux", externalSessionAdoptedAt: 123,
      observedRuntime: { model: "fabricated" }, observedModel: "fabricated", observedReasoningEffort: "high",
    },
  };
  const repaired = promoteLocalEndpointProviderSession(endpoint, { metadata: sessionObservationMetadata(endpoint, {
    sessionId: "native-B", runtime: { harness: "claude" }, runtimeSource: "claude-session-record", evidence: {}, observedAt: 456,
  }) });
  expect(endpointMatchesTargetSession(repaired, "native-A")).toBe(false);
  expect(endpointMatchesTargetSession(repaired, "native-B")).toBe(true);
  expect(endpointMatchesTargetSession(repaired, "scout-tmux")).toBe(true);
  expect(endpointMatchesTargetSession(repaired, "endpoint")).toBe(true);
  expect(observedRuntimeForEndpoint(repaired)).toEqual({ harness: "claude", model: undefined, reasoningEffort: undefined });
});
