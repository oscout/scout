import {
  groupsForProject,
  isEphemeralAgent,
  isGroupLive,
  partitionGroups,
  type ProjectAgentGroup,
} from "../agents/agents-project-model.ts";
import { nativeSessionMatchesAgent, pathLeaf } from "../agents/model.ts";
import type { AgentInventoryRow, DirProject, NativeSessionRow } from "../agents/model.ts";
import type {
  Agent,
  ProjectsIndexView,
  ProjectSet,
  ProjectStateFilter,
  Route,
  SessionCatalogEntry,
  SessionEntry,
} from "../../lib/types.ts";
import { timeAgo } from "../../lib/time.ts";

const LIVE_WINDOW_MS = 30 * 60_000;

export type ProjectRegistryScope = {
  projectSlug?: string;
  harness?: string;
  node?: string;
  set?: ProjectSet;
};

export type RegistryAgentEntry = {
  group: ProjectAgentGroup;
  projectSlug: string;
  projectTitle: string;
  projectRoot: string | null;
  leadRow: AgentInventoryRow;
  leadAgent: Agent;
};

export type RegistrySessionEntry = {
  session: SessionEntry;
  agent: Agent | null;
  projectSlug: string | null;
  projectTitle: string | null;
};

export type ProjectSessionMappedAgent = {
  agentId: string;
  handle: string | null;
  name: string;
  harness: string | null;
};

export type ProjectSessionEntry = {
  session: NativeSessionRow;
  projectSlug: string;
  projectTitle: string;
  projectRoot: string | null;
  harness: string;
  mappedAgent: ProjectSessionMappedAgent | null;
};

export type ProjectSessionGroup = {
  key: string;
  label: string;
  sessions: ProjectSessionEntry[];
  activeCount: number;
};

export type BrowseProject = {
  slug: string;
  title: string;
  agentCount: number;
  sessionCount: number;
  needsCount: number;
  liveCount: number;
};

export type BrowseHarness = {
  id: string;
  label: string;
  agentCount: number;
};

export type BrowseNode = {
  id: string;
  label: string;
  agentCount: number;
};

export type BrowseSet = {
  id: ProjectSet;
  label: string;
  count: number;
};

export function harnessOf(harness: string): string {
  return harness === "pi" ? "grok" : harness.toLowerCase();
}

export function agentNodeKey(agent: Agent): string {
  return (agent.homeNodeId ?? agent.authorityNodeId ?? agent.homeNodeName ?? "local").trim();
}

export function agentNodeLabel(agent: Agent): string {
  const raw = agent.homeNodeName ?? agent.authorityNodeName ?? agent.homeNodeId ?? "local";
  return raw.replace(/\.local$/i, "").replace(/-local-openscout$/i, "");
}

export function buildRegistryAgents(projects: DirProject[], showEphemeral: boolean): RegistryAgentEntry[] {
  const entries: RegistryAgentEntry[] = [];
  for (const project of projects) {
    const groups = groupsForProject(project);
    const { primary, ephemeral } = partitionGroups(groups);
    const visible = showEphemeral ? [...primary, ...ephemeral] : primary;
    for (const group of visible) {
      const lead = group.nodes[0];
      if (!lead) continue;
      entries.push({
        group,
        projectSlug: project.slice.slug,
        projectTitle: project.slice.title,
        projectRoot: project.slice.root,
        leadRow: lead.row,
        leadAgent: lead.row.agent,
      });
    }
  }
  return entries.sort(compareRegistryAgents);
}

export function buildRegistrySessions(
  projects: DirProject[],
  sessions: SessionEntry[],
  agentsById: Map<string, Agent>,
): RegistrySessionEntry[] {
  const projectBySlug = new Map(projects.map((project) => [project.slice.slug, project]));
  const projectByAgentId = new Map<string, DirProject>();
  for (const project of projects) {
    for (const node of project.agents) {
      projectByAgentId.set(node.row.agent.id, project);
    }
  }

  return sessions
    .filter((session) => session.agentId)
    .map((session) => {
      const agent = session.agentId ? agentsById.get(session.agentId) ?? null : null;
      const project = agent ? projectByAgentId.get(agent.id) ?? null : null;
      const slug =
        project?.slice.slug
        ?? (agent?.project ? projectBySlug.get(agent.project)?.slice.slug ?? agent.project : null);
      const title = project?.slice.title ?? agent?.project ?? null;
      return { session, agent, projectSlug: slug, projectTitle: title };
    })
    .sort((a, b) => (b.session.lastMessageAt ?? 0) - (a.session.lastMessageAt ?? 0));
}

export function isNativeProjectSession(row: NativeSessionRow): boolean {
  return Boolean(row.transcriptPath || row.sessionId);
}

function mappedAgentForNativeSession(
  project: DirProject,
  session: NativeSessionRow,
): ProjectSessionMappedAgent | null {
  for (const group of groupsForProject(project)) {
    const node = group.nodes.find((candidate) => nativeSessionMatchesAgent(session, candidate.row));
    if (!node) continue;
    const agent = node.row.agent;
    return {
      agentId: agent.id,
      handle: agent.handle,
      name: agent.name,
      harness: agent.harness,
    };
  }
  return null;
}

export function buildProjectSessions(projects: DirProject[]): ProjectSessionEntry[] {
  const rows: ProjectSessionEntry[] = [];
  for (const project of projects) {
    for (const session of project.slice.nativeSessions) {
      if (!isNativeProjectSession(session)) continue;
      rows.push({
        session,
        projectSlug: project.slice.slug,
        projectTitle: project.slice.title,
        projectRoot: project.slice.root,
        harness: harnessOf(session.source),
        mappedAgent: mappedAgentForNativeSession(project, session),
      });
    }
  }
  return rows.sort((a, b) => projectSessionLastAt(b) - projectSessionLastAt(a)
    || a.projectTitle.localeCompare(b.projectTitle)
    || a.harness.localeCompare(b.harness));
}

export function projectSessionLastAt(entry: ProjectSessionEntry): number {
  return entry.session.lastActivityAt ?? entry.session.mtimeMs ?? 0;
}

export function isProjectSessionLive(entry: ProjectSessionEntry, nowMs: number): boolean {
  return entry.session.status === "active" || nowMs - projectSessionLastAt(entry) < LIVE_WINDOW_MS;
}

export function filterProjectSessions(
  entries: ProjectSessionEntry[],
  scope: ProjectRegistryScope,
  nowMs: number,
): ProjectSessionEntry[] {
  return entries.filter((entry) => {
    if (scope.projectSlug && entry.projectSlug !== scope.projectSlug) return false;
    if (scope.harness && harnessOf(entry.harness) !== harnessOf(scope.harness)) return false;
    if (scope.set === "live" && !isProjectSessionLive(entry, nowMs)) return false;
    if (scope.set === "ephemeral" || scope.set === "archived") return false;
    return true;
  });
}

export function groupProjectSessionsByHarness(entries: ProjectSessionEntry[]): ProjectSessionGroup[] {
  const groups = new Map<string, ProjectSessionEntry[]>();
  for (const entry of entries) {
    const key = harnessOf(entry.harness);
    const list = groups.get(key) ?? [];
    list.push(entry);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .map(([key, sessions]) => ({
      key,
      label: key.charAt(0).toUpperCase() + key.slice(1),
      sessions: [...sessions].sort((a, b) => projectSessionLastAt(b) - projectSessionLastAt(a)),
      activeCount: sessions.filter((entry) => entry.session.status === "active").length,
    }))
    .sort((a, b) => b.activeCount - a.activeCount
      || b.sessions.length - a.sessions.length
      || a.label.localeCompare(b.label));
}

function compareRegistryAgents(a: RegistryAgentEntry, b: RegistryAgentEntry): number {
  if (a.group.needs !== b.group.needs) return a.group.needs ? -1 : 1;
  return b.group.lastActivityAt - a.group.lastActivityAt || b.group.sessionCount - a.group.sessionCount;
}

export function agentPrecedence(
  entry: RegistryAgentEntry,
  nowMs: number,
): ProjectStateFilter | "idle" {
  if (entry.group.needs) return "needs";
  if (isGroupLive(entry.group, nowMs)) return "live";
  return "idle";
}

export function matchesScope(entry: RegistryAgentEntry, scope: ProjectRegistryScope, nowMs: number): boolean {
  if (scope.projectSlug && entry.projectSlug !== scope.projectSlug) return false;
  if (scope.harness && harnessOf(entry.group.harness) !== harnessOf(scope.harness)) return false;
  if (scope.node) {
    const nodeKey = agentNodeKey(entry.leadAgent);
    const nodeLabel = agentNodeLabel(entry.leadAgent).toLowerCase();
    const needle = scope.node.toLowerCase();
    if (nodeKey.toLowerCase() !== needle && nodeLabel !== needle) return false;
  }
  if (scope.set === "live" && !isGroupLive(entry.group, nowMs)) return false;
  if (scope.set === "ephemeral" && !entry.group.ephemeral) return false;
  if (scope.set === "archived" && !entry.leadAgent.retiredFromFleet) return false;
  return true;
}

export function matchesSessionScope(
  entry: RegistrySessionEntry,
  scope: ProjectRegistryScope,
  agentsById: Map<string, Agent>,
  nowMs: number,
): boolean {
  if (scope.projectSlug && entry.projectSlug !== scope.projectSlug) return false;
  if (scope.harness && entry.agent) {
    const harness = entry.agent.harness ?? entry.session.harness ?? "";
    if (harnessOf(harness) !== harnessOf(scope.harness)) return false;
  }
  if (scope.node && entry.agent) {
    const nodeKey = agentNodeKey(entry.agent);
    const nodeLabel = agentNodeLabel(entry.agent).toLowerCase();
    const needle = scope.node.toLowerCase();
    if (nodeKey.toLowerCase() !== needle && nodeLabel !== needle) return false;
  }
  if (scope.set === "archived") {
    return Boolean(entry.agent?.retiredFromFleet);
  }
  if (scope.set === "ephemeral" && entry.agent) {
    return isEphemeralAgent(entry.agent.name);
  }
  if (scope.set === "live" && entry.agent) {
    const lastAt = Math.max(entry.session.lastMessageAt ?? 0, entry.agent.updatedAt ?? 0);
    return nowMs - lastAt < LIVE_WINDOW_MS;
  }
  if (scope.set === "live" && !entry.agent) {
    const lastAt = entry.session.lastMessageAt ?? 0;
    return nowMs - lastAt < LIVE_WINDOW_MS;
  }
  return true;
}

export function filterRegistryAgents(
  entries: RegistryAgentEntry[],
  scope: ProjectRegistryScope,
  stateFilter: ProjectStateFilter | undefined,
  nowMs: number,
): RegistryAgentEntry[] {
  return entries.filter((entry) => {
    if (!matchesScope(entry, scope, nowMs)) return false;
    if (!stateFilter) return true;
    return agentPrecedence(entry, nowMs) === stateFilter;
  });
}

export function filterRegistrySessions(
  entries: RegistrySessionEntry[],
  scope: ProjectRegistryScope,
  agentsById: Map<string, Agent>,
  nowMs: number,
): RegistrySessionEntry[] {
  return entries.filter((entry) => matchesSessionScope(entry, scope, agentsById, nowMs));
}

export function buildBrowseProjects(projects: DirProject[], nowMs: number): BrowseProject[] {
  return projects
    .map((project) => {
      const groups = groupsForProject(project);
      const { primary } = partitionGroups(groups);
      const nativeSessions = project.slice.nativeSessions.filter(isNativeProjectSession);
      return {
        slug: project.slice.slug,
        title: project.slice.title,
        agentCount: primary.length,
        sessionCount: nativeSessions.length,
        needsCount: primary.filter((group) => group.needs).length,
        liveCount: Math.max(
          primary.filter((group) => isGroupLive(group, nowMs)).length,
          nativeSessions.filter((session) => session.status === "active").length,
        ),
      };
    })
    .sort((a, b) => b.liveCount - a.liveCount || b.needsCount - a.needsCount || a.title.localeCompare(b.title));
}

export function buildBrowseHarnesses(entries: RegistryAgentEntry[]): BrowseHarness[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const id = harnessOf(entry.group.harness);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([id, agentCount]) => ({
      id,
      label: id.charAt(0).toUpperCase() + id.slice(1),
      agentCount,
    }))
    .sort((a, b) => b.agentCount - a.agentCount || a.label.localeCompare(b.label));
}

export function buildBrowseNodes(entries: RegistryAgentEntry[]): BrowseNode[] {
  const counts = new Map<string, { label: string; count: number }>();
  for (const entry of entries) {
    const id = agentNodeKey(entry.leadAgent);
    const label = agentNodeLabel(entry.leadAgent);
    const current = counts.get(id) ?? { label, count: 0 };
    current.count += 1;
    counts.set(id, current);
  }
  return [...counts.entries()]
    .map(([id, value]) => ({ id, label: value.label, agentCount: value.count }))
    .sort((a, b) => b.agentCount - a.agentCount || a.label.localeCompare(b.label));
}

export function buildBrowseSets(entries: RegistryAgentEntry[], nowMs: number): BrowseSet[] {
  const live = entries.filter((entry) => isGroupLive(entry.group, nowMs)).length;
  const ephemeral = entries.filter((entry) => entry.group.ephemeral).length;
  const archived = entries.filter((entry) => entry.leadAgent.retiredFromFleet).length;
  return [
    { id: "live", label: "Live", count: live },
    { id: "ephemeral", label: "Ephemeral", count: ephemeral },
    { id: "archived", label: "Archived", count: archived },
  ];
}

export function projectGroupsForScope(
  projects: DirProject[],
  projectSlug: string,
  showEphemeral: boolean,
): ProjectAgentGroup[] {
  const project = projects.find((entry) => entry.slice.slug === projectSlug);
  if (!project) return [];
  const { primary, ephemeral } = partitionGroups(groupsForProject(project));
  return showEphemeral ? [...primary, ...ephemeral] : primary;
}

/** Visible registry rows for one project — used for browse fast-path and project hub. */
export function registryAgentsForProject(
  registryAgents: RegistryAgentEntry[],
  projectSlug: string,
  showEphemeral: boolean,
): RegistryAgentEntry[] {
  return registryAgents.filter(
    (entry) =>
      entry.projectSlug === projectSlug && (showEphemeral || !entry.group.ephemeral),
  );
}

export function leadRegistryAgent(entries: RegistryAgentEntry[]): RegistryAgentEntry | null {
  return entries[0] ?? null;
}

export function partitionRegistryAgents(
  entries: RegistryAgentEntry[],
  nowMs: number,
): { active: RegistryAgentEntry[]; registered: RegistryAgentEntry[] } {
  const active: RegistryAgentEntry[] = [];
  const registered: RegistryAgentEntry[] = [];
  for (const entry of entries) {
    const tone = agentPrecedence(entry, nowMs);
    const hasWork =
      Boolean(entry.leadRow.activeTask)
      || Boolean(entry.leadRow.session && sessionPreview(entry.leadRow.session) !== "Untitled session");
    if (tone !== "idle" || hasWork) active.push(entry);
    else registered.push(entry);
  }
  return { active, registered };
}

export function scopeLabel(route: Extract<Route, { view: "agents-v2" }>): string {
  if (route.set === "live") return "Set · Live";
  if (route.set === "ephemeral") return "Set · Ephemeral";
  if (route.set === "archived") return "Set · Archived";
  if (route.projectSlug) return `Project · /${route.projectSlug}`;
  if (route.harness) return `Harness · ${route.harness}`;
  if (route.node) return `Machine · ${route.node}`;
  return "All agents";
}

export function scopeMetaLabel(
  route: Extract<Route, { view: "agents-v2" }>,
  agentCount: number,
  sessionCount: number,
): string {
  if (route.projectSlug) {
    const agents = agentCount === 1 ? "1 agent" : `${agentCount} agents`;
    const sessions = sessionCount > 0 ? ` · ${sessionCount} sessions` : "";
    return `${agents}${sessions}`;
  }
  return "";
}

export function sessionPreview(session: SessionEntry): string {
  const preview = (session.preview ?? "")
    .replace(/^\[ask:[^\]]+\]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (preview) return preview;
  const title = session.title?.trim();
  return title && title !== session.agentName ? title : "Untitled session";
}

/** Strip markdown/ask noise so roster and peek lines read as plain language. */
export function humanizeWorkText(raw: string | null | undefined, maxLen = 140): string {
  if (!raw?.trim()) return "";
  let text = raw
    .replace(/^\[ask:[^\]]+\]\s*/gi, "")
    .replace(/^#+\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^[-*•]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  if (text.length > maxLen) return `${text.slice(0, maxLen - 1).trim()}…`;
  return text;
}

export function displaySessionPreview(session: SessionEntry, maxLen = 140): string {
  const raw = sessionPreview(session);
  if (raw === "Untitled session") return raw;
  return humanizeWorkText(raw, maxLen) || raw;
}

export function displayProjectSessionPreview(entry: ProjectSessionEntry): string {
  const leaf = entry.session.transcriptPath ? pathLeaf(entry.session.transcriptPath) : null;
  const mapped = entry.mappedAgent?.handle?.trim() || entry.mappedAgent?.name;
  const label = mapped ? `@${mapped.replace(/^@+/, "")}` : entry.projectTitle;
  return [label, leaf ?? entry.session.refId].filter(Boolean).join(" · ");
}

export function projectSessionMeta(entry: ProjectSessionEntry): string {
  const parts = [
    harnessOf(entry.harness),
    entry.session.status === "active" ? "active" : "idle",
    entry.session.cwd ? pathLeaf(entry.session.cwd) : null,
  ];
  return parts.filter(Boolean).join(" · ");
}

/** Best recent session story across every broker row folded into this agent group. */
export function bestSessionPreviewForEntry(entry: RegistryAgentEntry): string | null {
  const candidates: Array<{ text: string; at: number }> = [];
  const consider = (text: string | null | undefined, at: number) => {
    const clean = humanizeWorkText(text);
    if (!clean || clean === "Untitled session") return;
    candidates.push({ text: clean, at });
  };

  for (const node of entry.group.nodes) {
    if (node.row.session) {
      consider(sessionPreview(node.row.session), node.row.session.lastMessageAt ?? 0);
    }
    for (const sn of node.sessions) {
      consider(sn.detail ?? sn.label, sn.lastActivityAt ?? 0);
    }
  }
  if (candidates.length === 0) return null;
  const best = candidates.reduce((a, b) => (b.at > a.at ? b : a));
  return best.text;
}

export function registryWorkLine(
  entry: RegistryAgentEntry,
  tone: ProjectStateFilter | "idle",
): string {
  const task = entry.leadRow.activeTask ? humanizeWorkText(entry.leadRow.activeTask) : null;
  if (task) return task;

  const preview = bestSessionPreviewForEntry(entry);
  if (preview) return preview;

  if (entry.group.sessionCount > 0) {
    const when = entry.group.lastActivityAt ? timeAgo(entry.group.lastActivityAt) : null;
    return when ? `Idle · last active ${when}` : `Idle · ${entry.group.sessionCount} sessions`;
  }

  if (tone === "idle") return "No recent activity";
  return entry.leadRow.stateLabel;
}

export function registryAgentSubline(entry: RegistryAgentEntry): string {
  const harness = harnessOf(entry.group.harness);
  const branch =
    entry.group.branches.length === 1
      ? entry.group.branches[0]
      : entry.group.branches.length > 1
        ? `${entry.group.branches.length} branches`
        : null;
  return [harness, branch].filter(Boolean).join(" · ");
}

export function conversationForCatalogSession(
  catalog: SessionCatalogEntry,
  conversations: SessionEntry[],
): SessionEntry | null {
  const byId = new Map(conversations.map((c) => [c.id, c]));
  const direct = byId.get(catalog.id);
  if (direct) return direct;
  const surface = catalog.surfaceSessionId?.trim();
  if (surface) {
    for (const conversation of conversations) {
      if (conversation.harnessSessionId?.trim() === surface) return conversation;
      if (conversation.id.includes(surface) || surface.includes(conversation.id)) return conversation;
    }
  }
  return null;
}

function compactSurfaceLabel(surfaceSessionId: string): string {
  return surfaceSessionId
    .replace(/^relay-/u, "")
    .replace(/-arts-mac-mini-local-(claude|codex)$/iu, "");
}

export function peekSessionTitle(
  catalog: SessionCatalogEntry,
  conversation: SessionEntry | null,
): string {
  if (conversation) {
    const preview = displaySessionPreview(conversation, 80);
    if (preview !== "Untitled session") return preview;
    const title = conversation.title?.trim();
    if (title) {
      const clean = humanizeWorkText(title, 80);
      if (clean) return clean;
    }
  }
  const surface = catalog.surfaceSessionId?.trim();
  if (surface) return compactSurfaceLabel(surface);
  const harness = catalog.harness ?? conversation?.harness ?? null;
  const branch = conversation?.currentBranch?.trim() || (catalog.cwd ? pathLeaf(catalog.cwd) : null);
  if (harness && branch && branch !== harness) return `${harness} · ${branch}`;
  if (branch) return branch;
  if (harness) return harness;
  return shortSessionRef(catalog.id);
}

export function peekSessionMeta(
  catalog: SessionCatalogEntry,
  conversation: SessionEntry | null,
  activeSessionId: string | null,
): string {
  const live = activeSessionId === catalog.id;
  const when = live
    ? "live"
    : catalog.endedAt
      ? timeAgo(catalog.endedAt)
      : timeAgo(catalog.startedAt);
  const parts: string[] = [];
  const harness = catalog.harness ?? conversation?.harness;
  if (harness) parts.push(harness);
  if (conversation?.messageCount) parts.push(`${conversation.messageCount} msgs`);
  if (when) parts.push(when);
  return parts.join(" · ");
}

export function agentNowLine(
  entry: RegistryAgentEntry | null | undefined,
  conversations: SessionEntry[],
  activeSession: SessionCatalogEntry | null,
): string | null {
  const task = entry?.leadRow.activeTask ? humanizeWorkText(entry.leadRow.activeTask) : null;
  if (task) return task;
  if (entry) {
    const groupPreview = bestSessionPreviewForEntry(entry);
    if (groupPreview) return groupPreview;
  }
  if (activeSession) {
    const conversation = conversationForCatalogSession(activeSession, conversations);
    if (conversation) {
      const preview = displaySessionPreview(conversation, 160);
      if (preview !== "Untitled session") return preview;
    }
  }
  const latest = conversations[0];
  if (latest) {
    const preview = displaySessionPreview(latest, 160);
    if (preview !== "Untitled session") return preview;
  }
  return null;
}

export function shortSessionRef(id: string): string {
  const clean = id.replace(/^c\./, "").replace(/\.jsonl$/, "");
  return clean.length <= 12 ? clean : `${clean.slice(0, 10)}…`;
}

export function agentsV2Route(
  base: Extract<Route, { view: "agents-v2" }>,
  patch: Partial<Extract<Route, { view: "agents-v2" }>>,
): Extract<Route, { view: "agents-v2" }> {
  const next = { ...base, ...patch, view: "agents-v2" as const };
  if (patch.projectSlug !== undefined || patch.harness !== undefined || patch.node !== undefined || patch.set !== undefined) {
    if ("projectSlug" in patch && patch.projectSlug) {
      delete (next as { harness?: string }).harness;
      delete (next as { node?: string }).node;
      delete (next as { set?: ProjectSet }).set;
    } else if ("harness" in patch && patch.harness) {
      delete (next as { projectSlug?: string }).projectSlug;
      delete (next as { node?: string }).node;
      delete (next as { set?: ProjectSet }).set;
    } else if ("node" in patch && patch.node) {
      delete (next as { projectSlug?: string }).projectSlug;
      delete (next as { harness?: string }).harness;
      delete (next as { set?: ProjectSet }).set;
    } else if ("set" in patch && patch.set) {
      delete (next as { projectSlug?: string }).projectSlug;
      delete (next as { harness?: string }).harness;
      delete (next as { node?: string }).node;
    }
  }
  return next;
}

export function indexViewOf(route: Extract<Route, { view: "agents-v2" }>): ProjectsIndexView {
  if (route.projectSlug) return route.indexView ?? "sessions";
  return route.indexView ?? "agents";
}

/** Registry index without an engaged agent — preserves browse scope. */
export function registryRoute(
  route: Extract<Route, { view: "agents-v2" }>,
): Extract<Route, { view: "agents-v2" }> {
  return {
    view: "agents-v2",
    ...(route.projectSlug ? { projectSlug: route.projectSlug } : {}),
    ...(route.harness ? { harness: route.harness } : {}),
    ...(route.node ? { node: route.node } : {}),
    ...(route.set ? { set: route.set } : {}),
    ...(route.indexView ? { indexView: route.indexView } : {}),
    ...(route.stateFilter ? { stateFilter: route.stateFilter } : {}),
    ...(route.showEphemeral ? { showEphemeral: true } : {}),
    ...(route.selectedAgentId ? { selectedAgentId: route.selectedAgentId } : {}),
    ...("machineId" in route && route.machineId ? { machineId: route.machineId } : {}),
  };
}

export function isProjectAgentProfileRoute(route: Extract<Route, { view: "agents-v2" }>): boolean {
  return Boolean(route.agentId);
}

/** Select an agent in the registry index — right-rail peek, center stays put. */
export function selectProjectAgent(
  route: Extract<Route, { view: "agents-v2" }>,
  agentId: string,
): Extract<Route, { view: "agents-v2" }> {
  return {
    ...registryRoute(route),
    selectedAgentId: agentId,
    sessionId: undefined,
  };
}

export function openProjectAgentProfile(
  route: Extract<Route, { view: "agents-v2" }>,
  agentId: string,
): Extract<Route, { view: "agents-v2" }> {
  return {
    ...route,
    view: "agents-v2",
    agentId,
    selectedAgentId: undefined,
    sessionId: undefined,
    tab: undefined,
    conversationId: undefined,
  };
}

export function openProjectAgentConfig(
  route: Extract<Route, { view: "agents-v2" }>,
  agentId: string,
): Extract<Route, { view: "agents-v2" }> {
  return {
    ...openProjectAgentProfile(route, agentId),
    tab: "config",
  };
}
