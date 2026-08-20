import { describe, expect, test } from "bun:test";

import {
  isBrokerRunnableLocalAgentTransport,
  isDirectLocalAgentTransport,
} from "./local-agent-transports";

describe("local agent transport predicates", () => {
  test("treats Pi RPC as a direct local-agent transport", () => {
    expect(isDirectLocalAgentTransport("codex_app_server")).toBe(true);
    expect(isDirectLocalAgentTransport("claude_stream_json")).toBe(true);
    expect(isDirectLocalAgentTransport("pi_rpc")).toBe(true);
    expect(isDirectLocalAgentTransport("tmux")).toBe(false);
  });

  test("admits tmux and direct adapters as broker-runnable local agents", () => {
    expect(isBrokerRunnableLocalAgentTransport("tmux")).toBe(true);
    expect(isBrokerRunnableLocalAgentTransport("codex_app_server")).toBe(true);
    expect(isBrokerRunnableLocalAgentTransport("claude_stream_json")).toBe(true);
    expect(isBrokerRunnableLocalAgentTransport("pi_rpc")).toBe(true);
    expect(isBrokerRunnableLocalAgentTransport("pairing_bridge")).toBe(false);
    expect(isBrokerRunnableLocalAgentTransport(undefined)).toBe(false);
  });
});
