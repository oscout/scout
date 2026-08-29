import type { Agent } from "./types.ts";

/** Ephemeral broker delivery rows — not fleet agents for mesh topology. */
export function isMeshRelaySessionAgent(agent: Pick<Agent, "id">): boolean {
  const id = agent.id.trim();
  return id.startsWith("session-") || id.startsWith("local-session-agent-");
}

/** Cardless / relay session actors — they may carry a project label but are not crew roles. */
export function isSessionStyleAgent(
  agent: Pick<Agent, "id" | "name" | "handle" | "definitionId" | "selector" | "defaultSelector">,
): boolean {
  if (isMeshRelaySessionAgent(agent)) return true;
  const handle = agent.handle?.trim().toLowerCase();
  if (handle?.startsWith("session-")) return true;
  const definitionId = agent.definitionId?.trim().toLowerCase();
  if (definitionId?.startsWith("session-")) return true;
  if (/^session\s+/i.test(agent.name.trim())) return true;
  const selector = `${agent.selector ?? ""} ${agent.defaultSelector ?? ""}`.toLowerCase();
  if (selector.includes("@session-")) return true;
  return false;
}

export function hasProjectBinding(agent: Pick<Agent, "project" | "projectRoot">): boolean {
  return Boolean(agent.project?.trim() || agent.projectRoot?.trim());
}

export function hasNamedRole(
  agent: Pick<Agent, "handle" | "role" | "definitionId">,
): boolean {
  const handle = agent.handle?.trim();
  if (handle && !handle.toLowerCase().startsWith("session-")) return true;
  if (agent.role?.trim()) return true;
  const definitionId = agent.definitionId?.trim();
  if (
    definitionId
    && !definitionId.toLowerCase().startsWith("session-")
    && !definitionId.toLowerCase().startsWith("local-session-agent-")
  ) {
    return true;
  }
  return false;
}

/** Mesh fleet map: project crew + named roles only — never harness session spam. */
export function isMeshRosterAgent(agent: Agent): boolean {
  if (agent.retiredFromFleet || agent.staleLocalRegistration) return false;
  if (agent.agentClass === "organic") return false;
  if (isSessionStyleAgent(agent)) return false;
  return hasProjectBinding(agent) || hasNamedRole(agent);
}

export function filterMeshRosterAgents(agents: Agent[]): Agent[] {
  return agents.filter(isMeshRosterAgent);
}
