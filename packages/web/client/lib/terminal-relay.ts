import { api } from "./api.ts";
import { routePath } from "./router.ts";
import { surfaceKey, type RegisteredTerminalTarget } from "./terminal-sessions.ts";
import type { Agent, Route, TerminalSurfaceDescriptor } from "./types.ts";

export const SCOUT_TERMINAL_INITIAL_COLS = 132;
export const SCOUT_TERMINAL_INITIAL_ROWS = 44;

export type TerminalRelayControlMode = "observe" | "takeover";

export function relayAgentForHarness(harness: string | null | undefined): "claude" | "codex" | "pi" | undefined {
  if (harness === "codex") return "codex";
  return harness === "pi" ? "pi" : undefined;
}

export function terminalRelayControlMode(mode: "observe" | "takeover" | undefined): TerminalRelayControlMode {
  return mode === "observe" ? "observe" : "takeover";
}

export function agentTmuxTerminalSessionKey(
  agentId: string,
  tmuxSession: string,
  mode: TerminalRelayControlMode = "takeover",
): string {
  return `scout-tmux-${agentId}-${tmuxSession}-${mode}`;
}

export function resolveAgentTerminalSurface(agent: Agent | null): TerminalSurfaceDescriptor | null {
  if (!agent) return null;
  if (agent.terminalSurface) return agent.terminalSurface;
  if (agent.transport === "tmux" && agent.harnessSessionId) {
    return {
      backend: "tmux",
      sessionName: agent.harnessSessionId,
      paneId: null,
      socketDir: null,
    };
  }
  return null;
}

export function terminalRelayUrlForAgent(url: string, agentId: string | undefined): string {
  if (!agentId) return url;
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("agentId", agentId);
    return parsed.toString();
  } catch {
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}agentId=${encodeURIComponent(agentId)}`;
  }
}

export function shouldBootstrapTakeover(
  agent: Agent | null,
  mode: "observe" | "takeover" | undefined,
): agent is Agent {
  return mode === "takeover" && Boolean(agent) && !resolveAgentTerminalSurface(agent);
}

export type TerminalRelaySurfaceOptions = {
  backend: TerminalSurfaceDescriptor["backend"];
  terminalSession: string;
  tmuxSession?: string;
  zellijSession?: string;
  zellijSocketDir?: string;
  herdrSession?: string;
};

export function resolveTerminalRelaySurfaceOptions(
  terminalSurface: TerminalSurfaceDescriptor | null,
): TerminalRelaySurfaceOptions | null {
  if (!terminalSurface) return null;
  return {
    backend: terminalSurface.backend,
    terminalSession: terminalSurface.sessionName,
    ...(terminalSurface.backend === "tmux" ? { tmuxSession: terminalSurface.sessionName } : {}),
    ...(terminalSurface.backend === "zellij"
      ? {
          zellijSession: terminalSurface.sessionName,
          ...(terminalSurface.socketDir ? { zellijSocketDir: terminalSurface.socketDir } : {}),
        }
      : {}),
    ...(terminalSurface.backend === "herdr"
      ? {
          herdrSession: terminalSurface.sessionName,
          // hudsonkit's session:init currently only forwards tmux/zellij session
          // fields; the relay accepts herdrSession || tmuxSession for Herdr.
          tmuxSession: terminalSurface.sessionName,
        }
      : {}),
  };
}

export function resolveTerminalRelaySessionKey(params: {
  agentId?: string;
  agent: Agent | null;
  terminalSurface: TerminalSurfaceDescriptor | null;
  registeredTarget?: RegisteredTerminalTarget | null;
  mode?: "observe" | "takeover";
}): string {
  const { agentId, agent, terminalSurface, registeredTarget } = params;
  const controlMode = terminalRelayControlMode(params.mode);
  const terminalSessionKey = terminalSurface && agent
    ? `scout-terminal-${terminalSurface.backend}-${agent.id}-${terminalSurface.sessionName}-${controlMode}`
    : registeredTarget && terminalSurface
      ? `scout-terminal-registry-${registeredTarget.session.id}-${terminalSurface.backend}-${terminalSurface.sessionName}-${controlMode}`
      : agentId
        ? `scout-takeover-${agentId}-${controlMode}`
        : `scout-takeover-${controlMode}`;

  if (terminalSurface?.backend === "tmux" && agent) {
    return agentTmuxTerminalSessionKey(agent.id, terminalSurface.sessionName, controlMode);
  }
  return terminalSessionKey;
}

export type TerminalRelayBinding = {
  relayStorageSessionKey: string;
  scopedRelayUrl: string;
  cwd?: string;
  relayAgent?: "claude" | "codex" | "pi";
  surfaceOptions: TerminalRelaySurfaceOptions | null;
  orphanTTL?: number;
  controlMode: TerminalRelayControlMode;
};

export function resolveTerminalRelayBinding(params: {
  agentId?: string;
  agent: Agent | null;
  registeredTarget?: RegisteredTerminalTarget | null;
  terminalSurface: TerminalSurfaceDescriptor | null;
  relayUrl: string;
  harness?: string | null;
  cwd?: string | null;
  mode?: "observe" | "takeover";
}): TerminalRelayBinding {
  const relayStorageSessionKey = resolveTerminalRelaySessionKey({
    agentId: params.agentId,
    agent: params.agent,
    terminalSurface: params.terminalSurface,
    registeredTarget: params.registeredTarget,
    mode: params.mode,
  });
  const controlMode = terminalRelayControlMode(params.mode);

  return {
    relayStorageSessionKey,
    scopedRelayUrl: terminalRelayUrlForAgent(params.relayUrl, params.agentId),
    cwd: params.cwd ?? undefined,
    relayAgent: relayAgentForHarness(params.harness),
    surfaceOptions: resolveTerminalRelaySurfaceOptions(params.terminalSurface),
    orphanTTL: params.terminalSurface ? 1_000 : undefined,
    controlMode,
  };
}

export type TerminalRoute = Extract<Route, { view: "terminal" }>;

export function buildTerminalRouteBase(params: {
  agentId?: string;
  registeredTarget?: RegisteredTerminalTarget | null;
}): TerminalRoute {
  if (params.registeredTarget) {
    return {
      view: "terminal",
      terminalSessionId: params.registeredTarget.session.id,
      terminalSurfaceKey: surfaceKey(params.registeredTarget.surface),
    };
  }
  if (params.agentId) {
    return { view: "terminal", agentId: params.agentId };
  }
  return { view: "terminal" };
}

export function withTerminalMode(route: TerminalRoute, mode?: "observe" | "takeover"): Route {
  return mode ? { ...route, mode } : route;
}

export function absoluteRouteUrl(route: Route): string {
  const path = routePath(route);
  if (typeof window === "undefined") return path;
  return new URL(path, window.location.href).toString();
}

export type TerminalSurfaceControlAction =
  | "interrupt"
  | "quit"
  | "stop-job"
  | "restart-resume"
  | "detach"
  | "release"
  | "force-quit"
  | "force-quit-bridge";

export type TerminalSurfaceControlResult = {
  ok: true;
  action: string;
  backend: string;
  sessionName: string;
  delivered: boolean;
  destroyed: number;
  resumeSessionId?: string | null;
  resumeTranscriptPath?: string | null;
};

export function controlTerminalSurface(
  terminalSurface: TerminalSurfaceDescriptor,
  action: TerminalSurfaceControlAction,
): Promise<TerminalSurfaceControlResult> {
  return api<TerminalSurfaceControlResult>("/api/terminal-sessions/control", {
    method: "POST",
    body: JSON.stringify({
      backend: terminalSurface.backend,
      sessionName: terminalSurface.sessionName,
      action,
    }),
  });
}

export function destroyTerminalRelaySession(sessionId: string): Promise<{ ok: true; destroyed: boolean }> {
  return api<{ ok: true; destroyed: boolean }>("/api/terminal-relay/session/destroy", {
    method: "POST",
    body: JSON.stringify({ sessionId }),
  });
}

export function clearTerminalRelayStorage(sessionKey: string): void {
  try {
    window.localStorage.removeItem(`hudson.relay.${sessionKey}`);
  } catch {
    // localStorage can be unavailable in hardened browser contexts.
  }
}
