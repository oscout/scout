import type { AgentHarness } from "./actors.js";

export type ScoutHostIntegrationRole =
  | "execution_harness"
  | "agent_host"
  | "mcp_host"
  | "terminal_host"
  | "agent_state_surface";

export type ScoutHostIntegrationId =
  | "claude-code"
  | "codex"
  | "cursor"
  | "pi"
  | "hermes"
  | "herdr";

export interface ScoutHostIntegration {
  id: ScoutHostIntegrationId;
  label: string;
  roles: readonly ScoutHostIntegrationRole[];
  /**
   * Present only when this host is also a Scout execution harness. Hosts such
   * as Hermes and Herdr are first-class integrations without being valid
   * values for `execution.harness` or `--harness`.
   */
  harness?: AgentHarness;
  homepage?: string;
  repositoryUrl?: string;
  installHint?: string;
  summary: string;
}

export const SCOUT_HOST_INTEGRATIONS: readonly ScoutHostIntegration[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    roles: ["execution_harness", "agent_host", "mcp_host"],
    harness: "claude",
    homepage: "https://claude.ai/claude-code",
    repositoryUrl: "https://github.com/arach/claude-scout",
    installHint: "/plugin marketplace add arach/claude-scout",
    summary: "Claude Code can run Scout-routed work as a harness and expose Scout through a host plugin.",
  },
  {
    id: "codex",
    label: "Codex",
    roles: ["execution_harness", "agent_host", "mcp_host"],
    harness: "codex",
    homepage: "https://github.com/openai/codex",
    repositoryUrl: "https://github.com/arach/codex-scout",
    installHint: "/plugin marketplace add arach/codex-scout",
    summary: "Codex can run Scout-routed work as a harness and expose Scout through MCP/plugin surfaces.",
  },
  {
    id: "cursor",
    label: "Cursor",
    roles: ["execution_harness", "agent_host", "mcp_host"],
    harness: "cursor",
    repositoryUrl: "https://github.com/arach/cursor-scout",
    installHint: "See https://github.com/arach/cursor-scout for the host-specific installer.",
    summary: "Cursor is an agent host and execution target when routed through its supported CLI or MCP surfaces.",
  },
  {
    id: "pi",
    label: "pi",
    roles: ["execution_harness", "agent_host"],
    harness: "pi",
    repositoryUrl: "https://github.com/arach/pi-scout",
    installHint: "pi install git:github.com/arach/pi-scout",
    summary: "pi can run Scout-routed work through its native extension model.",
  },
  {
    id: "hermes",
    label: "Hermes Agent",
    roles: ["agent_host", "mcp_host"],
    homepage: "https://hermes-agent.nousresearch.com/docs/",
    repositoryUrl: "https://github.com/arach/hermes-scout",
    installHint: "Install Hermes Scout as a Hermes plugin after Scout is healthy.",
    summary: "Hermes hosts Scout tools through its plugin and MCP system; it is not a Scout harness.",
  },
  {
    id: "herdr",
    label: "Herdr",
    roles: ["terminal_host", "agent_state_surface"],
    homepage: "https://herdr.dev/docs/",
    repositoryUrl: "https://github.com/ogulcancelik/herdr",
    installHint: "Install the Herdr integrations for the agent hosts you use, such as Claude, Codex, Hermes, or Cursor.",
    summary: "Herdr is a terminal host and agent-state surface for sessions Scout can observe or drive; it is not a Scout harness.",
  },
] as const;

export function scoutHostIntegrationById(
  id: string,
): ScoutHostIntegration | undefined {
  return SCOUT_HOST_INTEGRATIONS.find((host) => host.id === id);
}

export function scoutHostIntegrationHasRole(
  host: ScoutHostIntegration,
  role: ScoutHostIntegrationRole,
): boolean {
  return host.roles.includes(role);
}
