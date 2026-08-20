import { describe, expect, test } from "bun:test";

import { resolveTerminalSurface } from "./terminal-surfaces.ts";

describe("terminal surface resolver", () => {
  test("resolves terminalSurface metadata from session intake payloads", () => {
    expect(resolveTerminalSurface({
      transport: "claude_stream_json",
      endpointSessionId: "source-session-1",
      metadata: {
        terminalSurface: {
          backend: "zellij",
          sessionName: "scout-zj-source-session-1",
          paneId: "terminal_0",
          socketDir: "/Users/test/.openscout/zellij-sockets",
        },
      },
    })).toEqual({
      backend: "zellij",
      sessionName: "scout-zj-source-session-1",
      paneId: "terminal_0",
      socketDir: "/Users/test/.openscout/zellij-sockets",
    });
  });

  test("keeps tmux metadata compatible with the old endpoint shape", () => {
    expect(resolveTerminalSurface({
      transport: "tmux",
      endpointSessionId: "relay-agent-1-claude",
      metadata: {},
    })).toEqual({
      backend: "tmux",
      sessionName: "relay-agent-1-claude",
      paneId: null,
      socketDir: null,
    });
  });

  test("does not infer a terminal from stale tmux metadata on worker transports", () => {
    expect(resolveTerminalSurface({
      transport: "claude_stream_json",
      endpointSessionId: "relay-agent-1-claude",
      metadata: {
        tmuxSession: "relay-agent-1-claude",
        runtimeInstanceId: "relay-agent-1-claude",
        runtimeMode: "stream_json_worker",
        interactiveTerminal: false,
      },
    })).toBeNull();
  });
});
