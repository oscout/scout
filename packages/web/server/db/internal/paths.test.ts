import { describe, expect, test } from "bun:test";

import {
  HOME,
  isTransportSessionRef,
  localAgentHarnessLogPath,
  resolveHarnessLogPath,
  resolveHarnessSessionId,
  resolveHarnessSessionIdForAgent,
} from "./paths.ts";

describe("resolveHarnessSessionId", () => {
  test("keeps tmux attach refs on terminalSurface only", () => {
    expect(resolveHarnessSessionId("tmux", "relay-agent-1-claude", {
      tmuxSession: "relay-agent-1-claude",
    })).toBeNull();
  });

  test("returns provider thread ids for codex app server", () => {
    expect(resolveHarnessSessionId("codex_app_server", "relay-runtime-codex", {
      threadId: "019d9762-19f7-7792-8962-90d924ce7faa",
      runtimeInstanceId: "relay-runtime-codex",
    })).toBe("019d9762-19f7-7792-8962-90d924ce7faa");
  });

  test("drops relay runtime ids when no provider session is known", () => {
    expect(resolveHarnessSessionId("codex_app_server", "relay-runtime-codex", {
      runtimeInstanceId: "relay-runtime-codex",
    })).toBeNull();
  });

  test("hides idle codex thread ids from web harnessSessionId projection", () => {
    expect(resolveHarnessSessionIdForAgent(
      "codex_app_server",
      "relay-runtime-codex",
      { threadId: "019ee108-57a8-7c12-bc51-297676a9ae8d" },
      "available",
    )).toBeNull();
    expect(resolveHarnessSessionIdForAgent(
      "codex_app_server",
      "relay-runtime-codex",
      { threadId: "019ee108-57a8-7c12-bc51-297676a9ae8d" },
      "in_flight",
    )).toBe("019ee108-57a8-7c12-bc51-297676a9ae8d");
  });

  test("prefers externalSessionId for claude stream workers", () => {
    expect(resolveHarnessSessionId("claude_stream_json", "relay-agent-claude", {
      externalSessionId: "claude-sess-live",
      runtimeInstanceId: "relay-agent-claude",
    })).toBe("claude-sess-live");
  });

  test("uses pi rpc endpoint sessions as provider-native sessions", () => {
    expect(resolveHarnessSessionId("pi_rpc", "lattices-pi-codex", {
      runtimeInstanceId: "lattices-pi-codex",
    })).toBe("lattices-pi-codex");
    expect(resolveHarnessSessionId("pi_rpc", "lattices-pi-runtime", {
      externalSessionId: "lattices-native-codex",
    })).toBe("lattices-native-codex");
  });

  test("only treats codex pairing bridge thread ids as provider sessions", () => {
    expect(resolveHarnessSessionId("pairing_bridge", "pairing-claude", {
      attachedTransport: "claude_stream_json",
      threadId: "codex-thread-from-unrelated-metadata",
    })).toBeNull();
    expect(resolveHarnessSessionId("pairing_bridge", "pairing-codex", {
      attachedTransport: "codex_app_server",
      threadId: "codex-thread",
    })).toBe("codex-thread");
  });
});

describe("isTransportSessionRef", () => {
  test("detects legacy relay-prefixed runtime refs", () => {
    expect(isTransportSessionRef("relay-agent-1-claude")).toBe(true);
    expect(isTransportSessionRef("claude-sess-live")).toBe(false);
  });
});

describe("resolveHarnessLogPath", () => {
  test("maps pairing bridge attached transports to adapter log namespaces", () => {
    expect(resolveHarnessLogPath("agent-1", "pairing_bridge", "pairing-1", {
      attachedTransport: "codex_app_server",
    })).toBe(`${HOME}/.scout/pairing/codex/pairing-1/logs/stdout.log`);
    expect(resolveHarnessLogPath("agent-1", "pairing_bridge", "pairing-2", {
      attachedTransport: "claude_stream_json",
    })).toBe(`${HOME}/.scout/pairing/claude/pairing-2/logs/stdout.log`);
    expect(resolveHarnessLogPath("agent-1", "pairing_bridge", "pairing-3", {
      attachedTransport: "pi_rpc",
    })).toBe(`${HOME}/.scout/pairing/pi/pairing-3/logs/stdout.log`);
  });

  test("honors explicit pairing adapter metadata", () => {
    expect(resolveHarnessLogPath("agent-1", "pairing_bridge", "pairing-1", {
      attachedTransport: "codex_app_server",
      pairingAdapterType: "custom-adapter",
    })).toBe(`${HOME}/.scout/pairing/custom-adapter/pairing-1/logs/stdout.log`);
  });

  test("uses local agent logs for direct managed session transports", () => {
    expect(resolveHarnessLogPath("agent-codex", "codex_app_server", "runtime-codex", {}))
      .toBe(localAgentHarnessLogPath("agent-codex"));
    expect(resolveHarnessLogPath("agent-claude", "claude_stream_json", "runtime-claude", {}))
      .toBe(localAgentHarnessLogPath("agent-claude"));
    expect(resolveHarnessLogPath("agent-pi", "pi_rpc", "runtime-pi", {}))
      .toBe(localAgentHarnessLogPath("agent-pi"));
  });
});
