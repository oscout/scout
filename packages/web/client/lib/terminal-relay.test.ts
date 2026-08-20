import { describe, expect, mock, test } from "bun:test";
import type { Agent } from "./types.ts";
import type * as ReactModule from "react";

// @ts-expect-error -- the relative .js path keeps bun's runtime resolution to the real react
// module; a bare "react" specifier would be hijacked by tsconfig `paths` to the .d.ts. The cast
// restores the proper types that the path import otherwise loses.
const React = (await import("../../node_modules/react/index.js")) as typeof ReactModule;

mock.module("react", () => React);

const {
  agentTmuxTerminalSessionKey,
  relayAgentForHarness,
  resolveAgentTerminalSurface,
  resolveTerminalRelayBinding,
  resolveTerminalRelaySessionKey,
  resolveTerminalRelaySurfaceOptions,
  shouldBootstrapTakeover,
  terminalRelayUrlForAgent,
} = await import("./terminal-relay.ts");

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    name: "Agent One",
    handle: null,
    transport: "bridge",
    harness: "codex",
    harnessSessionId: null,
    cwd: "/tmp/agent-1",
    projectRoot: "/tmp/agent-1",
    ...overrides,
  } as Agent;
}

describe("terminal relay binding", () => {
  test("scopes relay URLs to the active agent", () => {
    expect(terminalRelayUrlForAgent("wss://scout.test/ws/terminal", "agent-1"))
      .toBe("wss://scout.test/ws/terminal?agentId=agent-1");
  });

  test("uses takeover session keys for bridge agents", () => {
    expect(resolveTerminalRelaySessionKey({
      agentId: "agent-1",
      agent: agent(),
      terminalSurface: null,
    })).toBe("scout-takeover-agent-1-takeover");
  });

  test("uses tmux-specific storage keys for tmux-backed agents", () => {
    const tmuxAgent = agent({
      transport: "tmux",
      harness: "claude",
      harnessSessionId: "relay-agent-1-claude",
    });
    const surface = resolveAgentTerminalSurface(tmuxAgent);

    expect(surface?.backend).toBe("tmux");
    expect(resolveTerminalRelaySessionKey({
      agentId: "agent-1",
      agent: tmuxAgent,
      terminalSurface: surface,
    })).toBe(agentTmuxTerminalSessionKey("agent-1", "relay-agent-1-claude"));
    expect(resolveTerminalRelaySessionKey({
      agentId: "agent-1",
      agent: tmuxAgent,
      terminalSurface: surface,
      mode: "observe",
    })).toBe(agentTmuxTerminalSessionKey("agent-1", "relay-agent-1-claude", "observe"));
  });

  test("uses zellij session keys for terminal-surface agents", () => {
    const zellijAgent = agent({
      transport: "claude_stream_json",
      harness: "claude",
      terminalSurface: {
        backend: "zellij",
        sessionName: "scout-zj-source-session-1",
        paneId: "terminal_0",
        socketDir: "/Users/test/.openscout/zellij-sockets",
      },
    });
    const surface = resolveAgentTerminalSurface(zellijAgent);

    expect(resolveTerminalRelaySessionKey({
      agentId: "agent-1",
      agent: zellijAgent,
      terminalSurface: surface,
    })).toBe("scout-terminal-zellij-agent-1-scout-zj-source-session-1-takeover");
  });

  test("builds relay binding with surface options and orphan TTL", () => {
    const zellijAgent = agent({
      terminalSurface: {
        backend: "zellij",
        sessionName: "scout-zj-source-session-1",
        paneId: "terminal_0",
        socketDir: "/Users/test/.openscout/zellij-sockets",
      },
    });
    const surface = resolveAgentTerminalSurface(zellijAgent);
    const binding = resolveTerminalRelayBinding({
      agentId: "agent-1",
      agent: zellijAgent,
      terminalSurface: surface,
      relayUrl: "wss://scout.test/ws/terminal",
      harness: "claude",
      cwd: "/tmp/agent-1",
      mode: "observe",
    });

    expect(binding.controlMode).toBe("observe");
    expect(binding.relayAgent).toBeUndefined();
    expect(binding.orphanTTL).toBe(1_000);
    expect(binding.surfaceOptions).toEqual({
      backend: "zellij",
      terminalSession: "scout-zj-source-session-1",
      zellijSession: "scout-zj-source-session-1",
      zellijSocketDir: "/Users/test/.openscout/zellij-sockets",
    });
  });

  test("carries the herdr session name in the field hudsonkit forwards", () => {
    // hudsonkit's session:init forwards tmux/zellij session fields only; the
    // relay reads herdrSession || tmuxSession for backend 'herdr', so the
    // herdr name rides in tmuxSession until hudsonkit learns the field.
    expect(resolveTerminalRelaySurfaceOptions({
      backend: "herdr",
      sessionName: "openscout",
      paneId: null,
      socketDir: null,
    })).toEqual({
      backend: "herdr",
      terminalSession: "openscout",
      herdrSession: "openscout",
      tmuxSession: "openscout",
    });
  });

  test("maps pi harnesses to relay agent kind", () => {
    expect(relayAgentForHarness("pi")).toBe("pi");
    expect(relayAgentForHarness("codex")).toBe("codex");
    expect(relayAgentForHarness("claude")).toBeUndefined();
  });

  test("bootstraps takeover only for non-surface agents", () => {
    expect(shouldBootstrapTakeover(agent(), "takeover")).toBe(true);
    expect(shouldBootstrapTakeover(agent({
      transport: "tmux",
      harnessSessionId: "relay-agent-1-claude",
    }), "takeover")).toBe(false);
    expect(shouldBootstrapTakeover(agent(), "observe")).toBe(false);
  });
});
