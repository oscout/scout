/* Agents & Projects — durable identities over the Projects inbox projection.

   Project-bound registrations are concrete endpoints, not separate agents.
   This model therefore emits one synthetic base agent per tracked project and
   only promotes unbound, durable definitions into the horizontal role roster.
   Sessions remain in `model.sessions`; they never become agent cards here. */

import { hasProjectBinding, isMeshRosterAgent } from "../../lib/mesh-roster.ts";
import { filterAgentsByMachineScope } from "../../lib/machine-scope.ts";
import type { Agent } from "../../lib/types.ts";
import { agentSpecialization } from "./agent-specialization.ts";
import type { InboxProject, InboxThread } from "./projects-inbox-model.ts";

export type CrewStatus = "needs" | "working" | "thinking" | "idle";
export type CrewStatusFilter = "all" | "active" | "needs" | "idle";
export type CrewMemberKind = "project" | "role";

export type CrewSubstrate = {
  threadId: string;
  projectSlug: string;
  projectTitle: string;
  projectRoot: string | null;
  branch: string | null;
  working: boolean;
  needs: boolean;
  lastActivityAt: number;
  sessionCount: number;
  work: string;
  conversationId: string | null;
};

export type CrewMember = {
  kind: CrewMemberKind;
  key: string;
  /** Concrete endpoint used only for an exact durable-role profile. */
  agentId: string | null;
  name: string;
  headline: string;
  harnesses: string[];
  model: string | null;
  effort: string | null;
  status: CrewStatus;
  needs: boolean;
  working: boolean;
  substrates: CrewSubstrate[];
  primary: CrewSubstrate | null;
  work: string;
  conversationId: string | null;
  lastActivityAt: number;
  sessionCount: number;
};

function threadRank(thread: InboxThread): number {
  if (thread.needs) return 3;
  if (thread.working) return 2;
  return 1;
}

function sortThreads(threads: InboxThread[]): InboxThread[] {
  return [...threads].sort(
    (left, right) => threadRank(right) - threadRank(left) || right.lastActivityAt - left.lastActivityAt,
  );
}

function distinct(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim().toLowerCase()).filter((value): value is string => Boolean(value)))].sort();
}

function branchSummary(values: Array<string | null | undefined>): string | null {
  const branches = [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
  if (branches.length === 0) return null;
  if (branches.length === 1) return branches[0]!;
  return `${branches.length} branches`;
}

function projectStatus(project: InboxProject): CrewStatus {
  if (project.needs > 0) return "needs";
  if (project.working > 0 || project.liveSessionCount > 0) return "working";
  return "idle";
}

function projectWorkSummary(project: InboxProject): string {
  if (project.needs > 0) {
    return `${project.needs} ${project.needs === 1 ? "item needs" : "items need"} attention`;
  }
  const active = Math.max(project.working, project.liveSessionCount);
  if (active > 0) return `${active} active work ${active === 1 ? "stream" : "streams"}`;
  return "No active work";
}

function projectMember(project: InboxProject, allThreads: InboxThread[]): CrewMember {
  const threads = sortThreads(allThreads.filter((thread) => thread.projectSlug === project.slug));
  const harnesses = distinct(threads.map((thread) => thread.harness));
  const substrate: CrewSubstrate = {
    threadId: `project:${project.slug}`,
    projectSlug: project.slug,
    projectTitle: project.title,
    projectRoot: project.root,
    branch: branchSummary(project.branches.length > 0 ? project.branches : threads.map((thread) => thread.branch)),
    working: project.working > 0 || project.liveSessionCount > 0,
    needs: project.needs > 0,
    lastActivityAt: project.lastActivityAt,
    sessionCount: project.sessionCount,
    work: projectWorkSummary(project),
    // A project card is a base identity. Never bind it to an arbitrary
    // concrete endpoint or session just because that row happened to be first.
    conversationId: null,
  };

  return {
    kind: "project",
    key: `project:${project.slug}`,
    agentId: null,
    name: project.title,
    headline: "Project agent",
    harnesses,
    model: null,
    effort: null,
    status: projectStatus(project),
    needs: substrate.needs,
    working: substrate.working,
    substrates: [substrate],
    primary: substrate,
    work: substrate.work,
    conversationId: null,
    lastActivityAt: project.lastActivityAt,
    sessionCount: project.sessionCount,
  };
}

function substrateFromThreads(projectThreads: InboxThread[]): CrewSubstrate {
  const threads = sortThreads(projectThreads);
  const primary = threads[0]!;
  return {
    threadId: primary.id,
    projectSlug: primary.projectSlug,
    projectTitle: primary.projectTitle,
    projectRoot: primary.projectRoot,
    branch: branchSummary(threads.map((thread) => thread.branch)),
    working: threads.some((thread) => thread.working),
    needs: threads.some((thread) => thread.needs),
    lastActivityAt: Math.max(...threads.map((thread) => thread.lastActivityAt)),
    sessionCount: threads.reduce((total, thread) => total + thread.sessionCount, 0),
    work: primary.work,
    conversationId: primary.conversationId,
  };
}

function roleSubstrates(threads: InboxThread[]): CrewSubstrate[] {
  const byProject = new Map<string, InboxThread[]>();
  for (const thread of threads) {
    const projectThreads = byProject.get(thread.projectSlug) ?? [];
    projectThreads.push(thread);
    byProject.set(thread.projectSlug, projectThreads);
  }
  return [...byProject.values()]
    .map(substrateFromThreads)
    .sort(
      (left, right) => Number(right.needs) - Number(left.needs)
        || Number(right.working) - Number(left.working)
        || right.lastActivityAt - left.lastActivityAt,
    );
}

function roleStatus(agents: Agent[], substrates: CrewSubstrate[]): CrewStatus {
  if (substrates.some((substrate) => substrate.needs)) return "needs";
  if (agents.some((agent) => (agent.state ?? "").toLowerCase().includes("think"))) return "thinking";
  if (
    substrates.some((substrate) => substrate.working)
    || agents.some((agent) => /work|running|in_turn/iu.test(agent.state ?? ""))
  ) {
    return "working";
  }
  return "idle";
}

function normalizedWorkspaceRoot(value: string | null | undefined): string | null {
  const trimmed = value?.trim().replace(/\/+$/u, "");
  if (!trimmed) return null;
  return trimmed.replace(/^\/(?:Users|home)\/[^/]+(?=\/)/u, "~");
}

function rootBelongsToProject(root: string, project: InboxProject): boolean {
  const candidates = [project.root, ...project.worktrees.map((worktree) => worktree.root)]
    .map(normalizedWorkspaceRoot)
    .filter((value): value is string => Boolean(value));
  return candidates.some((candidate) => root === candidate || root.startsWith(`${candidate}/`));
}

function endpointProjectScopes(
  agent: Agent,
  projects: InboxProject[],
  threads: InboxThread[],
): Set<string> {
  const scopes = new Set<string>();
  for (const thread of threads) {
    if (thread.agentId === agent.id) scopes.add(thread.projectSlug);
  }

  const roots = [agent.projectRoot, agent.cwd]
    .map(normalizedWorkspaceRoot)
    .filter((value): value is string => Boolean(value));
  for (const project of projects) {
    const projectNames = [project.slug, project.title].map((value) => value.trim().toLowerCase());
    if (agent.project && projectNames.includes(agent.project.trim().toLowerCase())) scopes.add(project.slug);
    if (agent.workspaceQualifier && projectNames.includes(agent.workspaceQualifier.trim().toLowerCase())) {
      scopes.add(project.slug);
    }
    if (roots.some((root) => rootBelongsToProject(root, project))) scopes.add(project.slug);
  }

  if (scopes.size === 0) {
    const explicit = normalizedWorkspaceRoot(agent.projectRoot ?? agent.cwd);
    if (explicit) scopes.add(`root:${explicit}`);
    else if (agent.project?.trim()) scopes.add(`project:${agent.project.trim().toLowerCase()}`);
    else if (agent.workspaceQualifier?.trim()) scopes.add(`workspace:${agent.workspaceQualifier.trim().toLowerCase()}`);
  }
  return scopes;
}

function isHorizontalRoleDefinition(
  endpoints: Agent[],
  projects: InboxProject[],
  threads: InboxThread[],
): boolean {
  const scopes = new Set<string>();
  for (const endpoint of endpoints) {
    for (const scope of endpointProjectScopes(endpoint, projects, threads)) scopes.add(scope);
  }
  if (scopes.size > 1) return true;
  // A definition with no concrete workspace evidence is itself the durable
  // horizontal identity, even before it has activity in multiple projects.
  return endpoints.some((endpoint) =>
    !hasProjectBinding(endpoint)
    && !endpoint.workspaceQualifier?.trim()
    && !endpoint.cwd?.trim(),
  );
}

function roleMembers(agents: Agent[], projects: InboxProject[], threads: InboxThread[]): CrewMember[] {
  const candidates = agents.filter(isMeshRosterAgent);
  const byDefinition = new Map<string, Agent[]>();
  for (const agent of candidates) {
    const definitionKey = agent.definitionId.trim() || agent.id;
    const endpoints = byDefinition.get(definitionKey) ?? [];
    endpoints.push(agent);
    byDefinition.set(definitionKey, endpoints);
  }

  return [...byDefinition.entries()].flatMap(([definitionId, endpoints]) => {
    if (!isHorizontalRoleDefinition(endpoints, projects, threads)) return [];
    const orderedEndpoints = [...endpoints].sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
    const lead = orderedEndpoints[0]!;
    const endpointIds = new Set(endpoints.map((agent) => agent.id));
    const associatedThreads = threads.filter((thread) => thread.agentId && endpointIds.has(thread.agentId));
    const substrates = roleSubstrates(associatedThreads);
    const primary = substrates[0] ?? null;
    const harnesses = distinct([
      ...endpoints.map((agent) => agent.harness),
      ...associatedThreads.map((thread) => thread.harness),
    ]);
    const models = distinct(endpoints.map((agent) => agent.model));
    const efforts = distinct(endpoints.map((agent) => agent.reasoningEffort));
    const status = roleStatus(endpoints, substrates);
    const lastActivityAt = Math.max(
      0,
      ...endpoints.map((agent) => agent.updatedAt ?? 0),
      ...substrates.map((substrate) => substrate.lastActivityAt),
    );
    const specialization = agentSpecialization(lead);

    return [{
      kind: "role" as const,
      key: `role:${definitionId}`,
      agentId: lead.id,
      name: lead.name,
      headline: specialization.headline,
      harnesses,
      model: models.length === 1 ? models[0]! : null,
      effort: efforts.length === 1 ? efforts[0]! : null,
      status,
      needs: status === "needs",
      working: status === "working" || status === "thinking",
      substrates,
      primary,
      work: primary?.work ?? specialization.headline,
      conversationId: primary?.conversationId ?? lead.conversationId,
      lastActivityAt,
      sessionCount: substrates.reduce((total, substrate) => total + substrate.sessionCount, 0),
    }];
  });
}

function crewRank(member: CrewMember): number {
  switch (member.status) {
    case "needs":
      return 3;
    case "working":
      return 2;
    case "thinking":
      return 1;
    case "idle":
      return 0;
  }
}

/** One base agent per project plus durable unbound role definitions. */
export function buildCrewMembers(
  projects: InboxProject[],
  threads: InboxThread[],
  agents: Agent[],
  machineId: string | null = null,
): CrewMember[] {
  const scopedAgents = filterAgentsByMachineScope(agents, machineId);
  const members = [
    ...projects.map((project) => projectMember(project, threads)),
    ...roleMembers(scopedAgents, projects, threads),
  ];
  return members.sort(
    (left, right) => crewRank(right) - crewRank(left)
      || right.lastActivityAt - left.lastActivityAt
      || left.name.localeCompare(right.name),
  );
}

export function memberMatchesStatus(member: CrewMember, filter: CrewStatusFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "active":
      return member.status === "working" || member.status === "thinking";
    case "needs":
      return member.status === "needs";
    case "idle":
      return member.status === "idle";
  }
}

export function projectMatchesStatus(project: InboxProject, filter: CrewStatusFilter): boolean {
  const status = projectStatus(project);
  switch (filter) {
    case "all":
      return true;
    case "active":
      return status === "working";
    case "needs":
      return status === "needs";
    case "idle":
      return status === "idle";
  }
}

export function memberMatchesQuery(member: CrewMember, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  if (member.name.toLowerCase().includes(needle)) return true;
  if (member.headline.toLowerCase().includes(needle)) return true;
  if (member.work.toLowerCase().includes(needle)) return true;
  return member.substrates.some(
    (substrate) => substrate.projectTitle.toLowerCase().includes(needle)
      || substrate.projectSlug.toLowerCase().includes(needle)
      || (substrate.projectRoot?.toLowerCase().includes(needle) ?? false),
  );
}

export function projectMatchesQuery(project: InboxProject, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return project.title.toLowerCase().includes(needle)
    || project.slug.toLowerCase().includes(needle)
    || (project.root?.toLowerCase().includes(needle) ?? false);
}

export function crewStatusLabel(status: CrewStatus): string {
  switch (status) {
    case "needs":
      return "Needs attention";
    case "working":
      return "Working";
    case "thinking":
      return "Thinking";
    case "idle":
      return "Idle";
  }
}
