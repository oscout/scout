import type { ScoutId } from "./common.js";

export interface AgentEndpointDebugTransport {
  kind: "tmux";
  state: "ready" | "starting" | "missing" | "stale" | "error";
  sessionName: string;
  paneTarget?: string;
  cwd?: string;
  attachable: boolean;
  multiAttach: boolean;
  lastProbeAt: number;
  lastAttachAt?: number;
  lastDetachAt?: number;
  activeClients?: number;
  detail?: string;
}

export interface DebugTmuxAttachPlan {
  endpointId: ScoutId;
  transport: "tmux";
  sessionName: string;
  paneTarget?: string;
  command?: ["tmux", "attach-session", "-t", string];
  terminalRelay?: {
    backend: "tmux";
    tmuxSession: string;
  };
}

export function isDebugTransportAttachable(
  transport: Pick<AgentEndpointDebugTransport, "state" | "attachable"> | null | undefined,
): boolean {
  return Boolean(transport?.attachable && transport.state === "ready");
}

export function buildTmuxAttachCommand(sessionName: string): ["tmux", "attach-session", "-t", string] {
  return ["tmux", "attach-session", "-t", sessionName];
}
