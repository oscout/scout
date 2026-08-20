import { describe, expect, mock, test } from "bun:test";
import type * as ReactModule from "react";
import type * as ReactJsxRuntimeModule from "react/jsx-runtime";
import type * as ReactJsxDevRuntimeModule from "react/jsx-dev-runtime";
import type * as ReactDomServerModule from "react-dom/server";

// The relative .js paths keep bun's runtime resolution to the real modules; bare specifiers would
// be hijacked by tsconfig `paths` to the .d.ts files. The casts restore the types those imports lose.
// @ts-expect-error -- untyped relative .js import (see note above)
const React = (await import("../node_modules/react/index.js")) as typeof ReactModule;
// @ts-expect-error -- untyped relative .js import (see note above)
const ReactJsxRuntime = (await import("../node_modules/react/jsx-runtime.js")) as typeof ReactJsxRuntimeModule;
// @ts-expect-error -- untyped relative .js import (see note above)
const ReactJsxDevRuntime = (await import("../node_modules/react/jsx-dev-runtime.js")) as typeof ReactJsxDevRuntimeModule;
// @ts-expect-error -- untyped relative .js import (see note above)
const ReactDomServer = (await import("../node_modules/react-dom/server.node.js")) as typeof ReactDomServerModule;
const { createElement } = React;
const { renderToStaticMarkup } = ReactDomServer;

mock.module("react", () => React);
mock.module("react/jsx-runtime", () => ReactJsxRuntime);
mock.module("react/jsx-dev-runtime", () => ReactJsxDevRuntime);
mock.module("react-dom/server", () => ReactDomServer);

type TerminalRelayCapture = {
  relay?: { sendInput?: (value: string) => void; sendLine?: (value: string) => void; restart?: () => void };
  renderer?: string;
};
let terminalRelayProps: TerminalRelayCapture | null = null;
const baseRelaySendInput = mock((_value: string) => {});
const baseRelaySendLine = mock((_value: string) => {});
const baseRelayRestart = mock(() => {});

const useTerminalRelayMock = mock(() => ({
  status: "disconnected" as const,
  sessionId: null,
  error: null,
  exitCode: null,
  cwd: "~",
  setCwd: () => {},
  onData: () => () => {},
  sendInput: baseRelaySendInput,
  sendLine: baseRelaySendLine,
  resize: () => {},
  connect: () => {},
  disconnect: () => {},
  restart: baseRelayRestart,
}));

let scoutAgents: unknown[] = [];

mock.module("hudsonkit/terminal", () => ({
  useTerminalRelay: useTerminalRelayMock,
  TerminalRelay: (props: { relay?: unknown }) => {
    terminalRelayProps = props as TerminalRelayCapture;
    return createElement("div");
  },
}));

mock.module(new URL("./scout/Provider.tsx", import.meta.url).pathname, () => ({
  useScout: () => ({
    agents: scoutAgents,
  }),
}));

const { ScoutTerminal } = await import("./scout/slots/Terminal.tsx");
const { TerminalScreen } = await import("./screens/terminal/Terminal.tsx");

function installWindow(bootstrap?: {
  routes?: {
    terminalRelayPath?: string;
    terminalRelayHealthPath?: string;
  };
}) {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      __OPENSCOUT_WEB_BOOTSTRAP__: bootstrap,
      location: {
        protocol: "https:",
        host: "scout.test",
      },
    },
  });
}

describe("terminal relay config", () => {
  test("ScoutTerminal auto-connects its relay", () => {
    useTerminalRelayMock.mockClear();
    terminalRelayProps = null;
    scoutAgents = [];
    installWindow();

    renderToStaticMarkup(createElement(ScoutTerminal));

    expect(useTerminalRelayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        autoConnect: true,
        healthUrl: "https://scout.test/ws/terminal/health",
        sessionKey: "scout-terminal",
        url: "wss://scout.test/ws/terminal",
      }),
    );
  });

  test("TerminalScreen auto-connects takeover sessions", () => {
    useTerminalRelayMock.mockClear();
    terminalRelayProps = null;
    scoutAgents = [{
      id: "agent-1",
      name: "Agent One",
      handle: null,
      transport: "bridge",
      harness: "codex",
      harnessSessionId: null,
      cwd: "/tmp/agent-1",
      projectRoot: "/tmp/agent-1",
    }];
    installWindow({
      routes: {
        terminalRelayPath: "/ws/relay",
        terminalRelayHealthPath: "/api/relay-health",
      },
    });

    renderToStaticMarkup(createElement(TerminalScreen, {
      agentId: "agent-1",
      navigate: () => {},
    }));

    expect(useTerminalRelayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        autoConnect: true,
        controlMode: "takeover",
        healthUrl: "https://scout.test/api/relay-health",
        sessionKey: "scout-takeover-agent-1-takeover",
        url: "wss://scout.test/ws/relay?agentId=agent-1",
      }),
    );
  });

  test("TerminalScreen attaches tmux-backed agents to their tmux session", () => {
    useTerminalRelayMock.mockClear();
    terminalRelayProps = null;
    scoutAgents = [{
      id: "agent-1",
      name: "Agent One",
      handle: null,
      transport: "tmux",
      harness: "claude",
      harnessSessionId: "relay-agent-1-claude",
      cwd: "/tmp/agent-1",
      projectRoot: "/tmp/agent-1",
    }];
    installWindow();

    renderToStaticMarkup(createElement(TerminalScreen, {
      agentId: "agent-1",
      navigate: () => {},
    }));

    expect(useTerminalRelayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        autoConnect: true,
        backend: "tmux",
        controlMode: "takeover",
        healthUrl: "https://scout.test/ws/terminal/health",
        sessionKey: "scout-tmux-agent-1-relay-agent-1-claude-takeover",
        tmuxSession: "relay-agent-1-claude",
        url: "wss://scout.test/ws/terminal?agentId=agent-1",
      }),
    );
  });

  test("TerminalScreen attaches terminal-surface agents to zellij sessions", () => {
    useTerminalRelayMock.mockClear();
    terminalRelayProps = null;
    scoutAgents = [{
      id: "agent-1",
      name: "Agent One",
      handle: null,
      transport: "claude_stream_json",
      harness: "claude",
      harnessSessionId: "source-session-1",
      terminalSurface: {
        backend: "zellij",
        sessionName: "scout-zj-source-session-1",
        paneId: "terminal_0",
        socketDir: "/Users/test/.openscout/zellij-sockets",
      },
      cwd: "/tmp/agent-1",
      projectRoot: "/tmp/agent-1",
    }];
    installWindow();

    renderToStaticMarkup(createElement(TerminalScreen, {
      agentId: "agent-1",
      navigate: () => {},
    }));

    expect(useTerminalRelayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        autoConnect: true,
        backend: "zellij",
        controlMode: "takeover",
        healthUrl: "https://scout.test/ws/terminal/health",
        sessionKey: "scout-terminal-zellij-agent-1-scout-zj-source-session-1-takeover",
        terminalSession: "scout-zj-source-session-1",
        zellijSession: "scout-zj-source-session-1",
        zellijSocketDir: "/Users/test/.openscout/zellij-sockets",
        url: "wss://scout.test/ws/terminal?agentId=agent-1",
      }),
    );
  });

  test("TerminalScreen makes tmux observe mode read-only", () => {
    useTerminalRelayMock.mockClear();
    baseRelaySendInput.mockClear();
    baseRelaySendLine.mockClear();
    baseRelayRestart.mockClear();
    terminalRelayProps = null;
    scoutAgents = [{
      id: "agent-1",
      name: "Agent One",
      handle: null,
      transport: "tmux",
      harness: "claude",
      harnessSessionId: "relay-agent-1-claude",
      cwd: "/tmp/agent-1",
      projectRoot: "/tmp/agent-1",
    }];
    installWindow();

    renderToStaticMarkup(createElement(TerminalScreen, {
      agentId: "agent-1",
      mode: "observe",
      navigate: () => {},
    }));

    expect(useTerminalRelayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "tmux",
        controlMode: "observe",
        tmuxSession: "relay-agent-1-claude",
      }),
    );
    expect(useTerminalRelayMock.mock.calls.at(-1)?.[0]).not.toHaveProperty("sessionKey");

    const captured = terminalRelayProps as TerminalRelayCapture | null;
    expect(captured?.relay).toBeTruthy();
    expect(captured?.renderer).toBe("dom");
    const firstReadOnlyRelay = captured?.relay;
    captured?.relay?.sendInput?.("whoami");
    captured?.relay?.sendLine?.("whoami");
    captured?.relay?.restart?.();

    expect(baseRelaySendInput).not.toHaveBeenCalled();
    expect(baseRelaySendLine).not.toHaveBeenCalled();
    expect(baseRelayRestart).not.toHaveBeenCalled();

    renderToStaticMarkup(createElement(TerminalScreen, {
      agentId: "agent-1",
      mode: "observe",
      navigate: () => {},
    }));

    const secondCaptured = terminalRelayProps as TerminalRelayCapture | null;
    expect(secondCaptured?.relay?.sendInput).toBe(firstReadOnlyRelay?.sendInput);
    expect(secondCaptured?.relay?.sendLine).toBe(firstReadOnlyRelay?.sendLine);
    expect(secondCaptured?.relay?.restart).toBe(firstReadOnlyRelay?.restart);
  });

  test("SSR falls back to the default terminal relay path", () => {
    useTerminalRelayMock.mockClear();
    terminalRelayProps = null;
    scoutAgents = [];
    Reflect.deleteProperty(globalThis, "window");

    renderToStaticMarkup(createElement(ScoutTerminal));

    expect(useTerminalRelayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        healthUrl: "http://localhost:43120/ws/terminal/health",
        url: "ws://localhost:43120/ws/terminal",
      }),
    );
  });
});
