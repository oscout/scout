import type { ScoutAgentStatus } from "../../core/agents/service.ts";

function formatUptime(startedAt: number): string {
  const now = Math.floor(Date.now() / 1000);
  const uptime = Math.max(0, now - startedAt);
  if (uptime < 60) {
    return `${uptime}s`;
  }
  if (uptime < 3600) {
    return `${Math.floor(uptime / 60)}m`;
  }
  return `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`;
}

export function renderScoutAgentStatus(agent: ScoutAgentStatus): string {
  const state = agent.isOnline ? "up" : "down";
  return [
    agent.agentId,
    `${agent.projectName} · ${state} ${formatUptime(agent.startedAt)}`,
    `session:${agent.sessionId}`,
    agent.harness,
    agent.source,
  ].join(" · ");
}

export function renderScoutAgentStatusList(agents: ScoutAgentStatus[]): string {
  if (agents.length === 0) {
    return "No local agents are configured yet.";
  }
  return agents.map(renderScoutAgentStatus).join("\n");
}

export function renderScoutUpResult(agent: ScoutAgentStatus): string {
  return [
    `Started ${agent.agentId}`,
    `Project: ${agent.projectRoot}`,
    `Session: ${agent.sessionId}`,
    `Harness: ${agent.harness}`,
  ].join("\n");
}

export function renderScoutDownResult(agent: ScoutAgentStatus | null): string {
  if (!agent) {
    return "Agent not found.";
  }
  return `Stopped ${agent.agentId}`;
}

export function renderScoutRestartResult(agents: ScoutAgentStatus[]): string {
  if (agents.length === 0) {
    return "No local agents to restart.";
  }
  return agents.map((agent) => `Restarted ${agent.agentId}`).join("\n");
}
