/* Projects · Inbox — the foundational model.

   A project is a place where work happens. The unit of triage is the work
   THREAD (a harness conversation/session): its title is the WORK, the agent is
   attribution — like a sender on an email. Agents are collapsed per
   (project · name) so the ~149 ID-proliferation records never masquerade as a
   fleet; the recognizable agent leads, phantom mirrors fold away. Attention is
   the only sort: your-turn › working › recent › dormant. Counts are truthful —
   we surface "3 moving · 1 waiting on you", never "149 agents".

   Pure + dependency-light so the whole thing stays unit-testable. All live
   fetching + sharing lives in useProjectsInbox.ts. */

import type {
  Agent,
  FleetAsk,
  FleetState,
  Route,
  SessionEntry,
  TailDiscoverySnapshot,
} from "../../lib/types.ts";
import { filterAgentsByMachineScope } from "../../lib/machine-scope.ts";
import {
  buildDirProjects,
  buildNativeSessionRows,
  directSessionMaps,
  isAgentRowWorking,
  rowForAgentInventory,
  type DirProject,
  type ProjectTreeSessionNode,
} from "../agents/model.ts";
import { isGroupLive } from "../agents/agents-project-model.ts";
import {
  agentPrecedence,
  buildRegistryAgents,
  harnessOf,
  humanizeWorkText,
  openProjectAgentProfile,
  registryWorkLine,
  type RegistryAgentEntry,
} from "./model.ts";

const DAY_MS = 24 * 60 * 60_000;

/** The three attention buckets the inbox groups by (plumbing like harness never groups). */
export type ThreadGroup = "needs" | "working" | "recent";

export type InboxThread = {
  /** Stable across refreshes so selection + cursor survive re-renders. */
  id: string;
  kind: "agent" | "native";
  projectSlug: string;
  projectTitle: string;
  projectRoot: string | null;
  workspaceRoot: string | null;
  // ── attribution ──
  agentId: string | null;
  agentName: string;
  harness: string;
  branch: string | null;
  // ── the work ──
  work: string;
  group: ThreadGroup;
  needs: boolean;
  working: boolean;
  lastActivityAt: number;
  sessionCount: number;
  /** Context window %, only when honestly known (needs observe — usually null here). */
  contextPct: number | null;
  // ── routing ──
  conversationId: string | null;
  sessionId: string | null;
};

export type InboxSession = {
  /** Stable across refreshes so session selection + cursor survive re-renders. */
  id: string;
  kind: "session";
  projectSlug: string;
  projectTitle: string;
  projectRoot: string | null;
  workspaceRoot: string | null;
  agentId: string | null;
  agentName: string;
  harness: string;
  branch: string | null;
  work: string;
  group: ThreadGroup;
  needs: false;
  working: boolean;
  lastActivityAt: number;
  sessionCount: 1;
  contextPct: number | null;
  conversationId: string | null;
  sessionId: string | null;
  route: Route | null;
};

export type InboxProject = {
  slug: string;
  title: string;
  root: string | null;
  agentCount: number;
  sessionCount: number;
  liveSessionCount: number;
  worktreeCount: number;
  worktrees: InboxProjectWorktree[];
  needs: number;
  working: number;
  threadCount: number;
  lastActivityAt: number;
  /** Distinct non-trunk branch names in the project — feeds the New agent modal. */
  branches: string[];
};

export type InboxProjectWorktree = {
  root: string;
  branch: string | null;
  working: boolean;
  lastActivityAt: number;
};

export type ProjectsInboxModel = {
  projects: InboxProject[];
  threads: InboxThread[];
  sessions: InboxSession[];
};

export type BuildInboxInput = {
  agents: Agent[];
  machineId: string | null;
  sessions: SessionEntry[];
  fleet: FleetState | null;
  discovery: TailDiscoverySnapshot | null;
  nowMs: number;
  showEphemeral: boolean;
};

function asksByAgentId(fleet: FleetState | null): Map<string, FleetAsk[]> {
  const map = new Map<string, FleetAsk[]>();
  for (const ask of fleet?.activeAsks ?? []) {
    const list = map.get(ask.agentId) ?? [];
    list.push(ask);
    map.set(ask.agentId, list);
  }
  return map;
}

type InboxAttention = {
  title: string;
  summary: string | null;
  conversationId: string | null;
  updatedAt: number;
};

function attentionByAgentId(fleet: FleetState | null): Map<string, InboxAttention[]> {
  const map = new Map<string, InboxAttention[]>();
  const add = (agentId: string | null, attention: InboxAttention) => {
    if (!agentId) return;
    const list = map.get(agentId) ?? [];
    list.push(attention);
    map.set(agentId, list);
  };

  for (const item of fleet?.needsAttention ?? []) {
    add(item.agentId, {
      title: item.title,
      summary: item.summary,
      conversationId: item.conversationId,
      updatedAt: item.updatedAt,
    });
  }

  // Older fleet projections included this state in activeAsks. Keep accepting
  // it without confusing ordinary queued/working asks with human attention.
  for (const ask of fleet?.activeAsks ?? []) {
    if (ask.status !== "needs_attention") continue;
    add(ask.agentId, {
      title: ask.task,
      summary: ask.summary,
      conversationId: ask.conversationId,
      updatedAt: ask.updatedAt,
    });
  }

  for (const list of map.values()) list.sort((left, right) => right.updatedAt - left.updatedAt);
  return map;
}

function titleCaseHarness(harness: string): string {
  return harness ? harness.charAt(0).toUpperCase() + harness.slice(1) : "Harness";
}

function branchLabel(branches: string[]): string | null {
  if (branches.length === 1) return branches[0] ?? null;
  if (branches.length > 1) return `${branches.length} branches`;
  return null;
}

function agentThread(
  entry: RegistryAgentEntry,
  conversationByAgentId: Map<string, string>,
  attentionByAgent: Map<string, InboxAttention[]>,
  nowMs: number,
): InboxThread {
  const group = entry.group;
  const attention = group.nodes
    .flatMap((node) => attentionByAgent.get(node.row.agent.id) ?? [])
    .sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null;
  const needs = Boolean(attention);
  const working = !needs && group.nodes.some((node) => isAgentRowWorking(node.row));
  const recent = isGroupLive(group, nowMs);
  const bucket: ThreadGroup = needs ? "needs" : working ? "working" : "recent";
  const tone = needs ? "needs" : working || recent ? "live" : "idle";
  const lead = entry.leadAgent;
  const conversationId = attention?.conversationId ?? conversationByAgentId.get(lead.id) ?? lead.conversationId ?? null;

  return {
    id: `${entry.projectSlug}:agent:${lead.id}`,
    kind: "agent",
    projectSlug: entry.projectSlug,
    projectTitle: entry.projectTitle,
    projectRoot: entry.projectRoot,
    workspaceRoot: lead.cwd ?? lead.projectRoot ?? entry.projectRoot,
    agentId: lead.id,
    agentName: group.name,
    harness: harnessOf(group.harness),
    branch: branchLabel(group.branches),
    work: attention?.summary?.trim() || attention?.title.trim() || registryWorkLine(entry, tone),
    group: bucket,
    needs,
    working,
    lastActivityAt: group.lastActivityAt,
    sessionCount: group.sessionCount,
    contextPct: null,
    conversationId,
    sessionId: null,
  };
}

function nativeSessionIdFromRoute(route: Route | null): string | null {
  return route && route.view === "sessions" && route.sessionId ? route.sessionId : null;
}

/** Unattributed native transcript that is live *right now* (no named agent owns it yet). */
function nativeThread(
  project: DirProject,
  node: ProjectTreeSessionNode,
  nowMs: number,
): InboxThread {
  const harness = harnessOf(node.harness);
  return {
    id: `${project.slice.slug}:native:${node.key}`,
    kind: "native",
    projectSlug: project.slice.slug,
    projectTitle: project.slice.title,
    projectRoot: project.slice.root,
    workspaceRoot: project.slice.root,
    agentId: null,
    agentName: `${titleCaseHarness(harness)} session`,
    harness,
    branch: null,
    work: humanizeWorkText(node.detail ?? node.label) || node.label,
    group: "working",
    needs: false,
    working: true,
    lastActivityAt: node.lastActivityAt ?? nowMs,
    sessionCount: 1,
    contextPct: null,
    conversationId: null,
    sessionId: nativeSessionIdFromRoute(node.route),
  };
}

function sessionGroup(node: ProjectTreeSessionNode, nowMs: number): ThreadGroup {
  if (node.status === "active" || node.status === "workflow") return "working";
  if (node.lastActivityAt && nowMs - node.lastActivityAt < DAY_MS) return "recent";
  return "recent";
}

function sessionRouteId(route: Route | null): string | null {
  if (!route) return null;
  if (route.view === "sessions") return route.sessionId ?? null;
  if (route.view === "conversation") return route.conversationId;
  return null;
}

function canOpenProjectSessionNode(node: ProjectTreeSessionNode): boolean {
  return Boolean(sessionRouteId(node.route));
}

function projectSession(
  project: DirProject,
  node: ProjectTreeSessionNode,
  nowMs: number,
  agent?: Agent,
  branch?: string | null,
): InboxSession {
  const harness = harnessOf(node.harness);
  const routeId = sessionRouteId(node.route);
  const working = node.status === "active" || node.status === "workflow";
  return {
    id: `${project.slice.slug}:session:${node.key}`,
    kind: "session",
    projectSlug: project.slice.slug,
    projectTitle: project.slice.title,
    projectRoot: project.slice.root,
    workspaceRoot: agent?.cwd ?? agent?.projectRoot ?? project.slice.root,
    agentId: agent?.id ?? null,
    agentName: agent?.name ?? `${titleCaseHarness(harness)} session`,
    harness,
    branch: branchLabel(branch ? [branch] : []),
    work: humanizeWorkText(node.detail ?? node.label) || node.label,
    group: sessionGroup(node, nowMs),
    needs: false,
    working,
    lastActivityAt: node.lastActivityAt ?? nowMs,
    sessionCount: 1,
    contextPct: null,
    conversationId: node.route?.view === "conversation" ? node.route.conversationId : null,
    sessionId: node.route?.view === "sessions" ? node.route.sessionId ?? routeId : routeId,
    route: node.route,
  };
}

function projectSessions(project: DirProject, nowMs: number): InboxSession[] {
  const sessions: InboxSession[] = [];
  for (const agentNode of project.agents) {
    for (const node of agentNode.sessions) {
      if (!canOpenProjectSessionNode(node)) continue;
      sessions.push(
        projectSession(
          project,
          node,
          nowMs,
          agentNode.row.agent,
          agentNode.row.branch,
        ),
      );
    }
  }
  for (const node of project.unassigned) {
    if (!canOpenProjectSessionNode(node)) continue;
    sessions.push(projectSession(project, node, nowMs));
  }
  return sessions.sort((a, b) => b.lastActivityAt - a.lastActivityAt || a.agentName.localeCompare(b.agentName));
}

function projectWorktreeInventory(project: DirProject): InboxProjectWorktree[] {
  const worktrees = new Map<string, InboxProjectWorktree>();
  const ensure = (root: string, branch: string | null, working: boolean, lastActivityAt: number): void => {
    const existing = worktrees.get(root);
    if (!existing) {
      worktrees.set(root, { root, branch, working, lastActivityAt });
      return;
    }
    if ((working || !existing.branch) && branch) existing.branch = branch;
    existing.working ||= working;
    existing.lastActivityAt = Math.max(existing.lastActivityAt, lastActivityAt);
  };
  for (const node of project.agents) {
    const root = node.row.agent.cwd ?? node.row.agent.projectRoot ?? project.slice.root;
    if (!root) continue;
    const branch = node.row.branch && node.row.branch !== "—" ? node.row.branch : null;
    ensure(root, branch, isAgentRowWorking(node.row), node.row.lastActivityAt ?? 0);
  }
  for (const session of project.slice.nativeSessions) {
    if (!session.cwd) continue;
    ensure(session.cwd, null, session.status === "active", session.lastActivityAt ?? 0);
  }
  if (worktrees.size === 0 && project.slice.root) ensure(project.slice.root, null, false, project.lastActivityAt ?? 0);
  return [...worktrees.values()].sort((left, right) =>
    Number(right.working) - Number(left.working)
    || right.lastActivityAt - left.lastActivityAt
    || left.root.localeCompare(right.root),
  );
}

function threadRank(thread: InboxThread, nowMs: number): number {
  if (thread.needs) return 3;
  if (thread.working) return 2;
  if (nowMs - thread.lastActivityAt < DAY_MS) return 1;
  return 0;
}

export function buildProjectsInboxModel(input: BuildInboxInput): ProjectsInboxModel {
  const { nowMs, showEphemeral } = input;
  const agents = filterAgentsByMachineScope(input.agents, input.machineId);
  const asks = asksByAgentId(input.fleet);
  const attention = attentionByAgentId(input.fleet);
  const { conversationByAgentId, sessionByAgentId } = directSessionMaps(input.sessions);

  const rows = agents.map((agent) =>
    rowForAgentInventory(agent, sessionByAgentId.get(agent.id) ?? null, asks.get(agent.id) ?? []),
  );
  const native = buildNativeSessionRows(input.discovery, nowMs);
  const dirProjects = buildDirProjects(rows, input.sessions, native);
  const registryAgents = buildRegistryAgents(dirProjects, showEphemeral);

  const threads: InboxThread[] = registryAgents.map((entry) =>
    agentThread(entry, conversationByAgentId, attention, nowMs),
  );

  // Fold in native transcripts that are live *now* and unattributed — a real
  // harness session no named agent has claimed yet. Idle transcripts stay out;
  // they are history, not the inbox.
  for (const project of dirProjects) {
    for (const node of project.unassigned) {
      if (node.kind !== "native" || node.status !== "active" || !node.route) continue;
      threads.push(nativeThread(project, node, nowMs));
    }
  }

  threads.sort((a, b) => threadRank(b, nowMs) - threadRank(a, nowMs) || b.lastActivityAt - a.lastActivityAt);

  const sessions = dirProjects.flatMap((project) => projectSessions(project, nowMs));

  const threadsBySlug = new Map<string, InboxThread[]>();
  for (const thread of threads) {
    const list = threadsBySlug.get(thread.projectSlug) ?? [];
    list.push(thread);
    threadsBySlug.set(thread.projectSlug, list);
  }
  const sessionsBySlug = new Map<string, InboxSession[]>();
  for (const session of sessions) {
    const list = sessionsBySlug.get(session.projectSlug) ?? [];
    list.push(session);
    sessionsBySlug.set(session.projectSlug, list);
  }
  const agentCountBySlug = new Map<string, number>();
  for (const entry of registryAgents) {
    agentCountBySlug.set(entry.projectSlug, (agentCountBySlug.get(entry.projectSlug) ?? 0) + 1);
  }

  const projects: InboxProject[] = dirProjects.map((project) => {
    const list = threadsBySlug.get(project.slice.slug) ?? [];
    const projectSessionList = sessionsBySlug.get(project.slice.slug) ?? [];
    const branches = [
      ...new Set(
        project.agents
          .map((node) => node.row.branch)
          .filter((branch): branch is string => Boolean(branch) && branch !== "—" && branch !== "main"),
      ),
    ];
    const worktrees = projectWorktreeInventory(project);
    return {
      slug: project.slice.slug,
      title: project.slice.title,
      root: project.slice.root,
      agentCount: agentCountBySlug.get(project.slice.slug) ?? 0,
      sessionCount: projectSessionList.length,
      liveSessionCount: projectSessionList.filter((session) => session.working).length,
      worktreeCount: worktrees.length,
      worktrees,
      needs: list.filter((thread) => thread.needs).length,
      working: list.filter((thread) => thread.working).length,
      threadCount: list.length,
      lastActivityAt: project.lastActivityAt,
      branches,
    };
  });
  projects.sort(
    (a, b) => projectRank(b) - projectRank(a) || b.lastActivityAt - a.lastActivityAt || a.title.localeCompare(b.title),
  );

  return { projects, threads, sessions };
}

function projectRank(project: InboxProject): number {
  if (project.needs > 0) return 2;
  if (project.working > 0) return 1;
  return 0;
}

/** A dormant project has nothing live and no activity in a day — folds behind disclosure. */
export function isDormantProject(project: InboxProject, nowMs: number): boolean {
  return (
    project.needs === 0 &&
    project.working === 0 &&
    (project.threadCount === 0 || nowMs - project.lastActivityAt > DAY_MS)
  );
}

export function threadsForProject(threads: InboxThread[], slug: string): InboxThread[] {
  return threads.filter((thread) => thread.projectSlug === slug);
}

export function sessionsForProject(sessions: InboxSession[], slug: string): InboxSession[] {
  return sessions.filter((session) => session.projectSlug === slug);
}

const GROUP_ORDER: ThreadGroup[] = ["needs", "working", "recent"];
const GROUP_LABEL: Record<ThreadGroup, string> = {
  needs: "Your turn",
  working: "In flight",
  recent: "Recent",
};

export function groupItems<T extends { group: ThreadGroup }>(
  items: T[],
): Array<{ group: ThreadGroup; label: string; items: T[] }> {
  const byGroup = new Map<ThreadGroup, T[]>();
  for (const item of items) {
    const list = byGroup.get(item.group) ?? [];
    list.push(item);
    byGroup.set(item.group, list);
  }
  return GROUP_ORDER.filter((group) => byGroup.has(group)).map((group) => ({
    group,
    label: GROUP_LABEL[group],
    items: byGroup.get(group)!,
  }));
}

export function groupThreads(threads: InboxThread[]): Array<{ group: ThreadGroup; label: string; threads: InboxThread[] }> {
  return groupItems(threads).map((group) => ({
    group: group.group,
    label: group.label,
    threads: group.items,
  }));
}

/* ── routing: threads link into existing surfaces, never new plumbing ── */

function scopeBase(route: Extract<Route, { view: "agents-v2" }>): Extract<Route, { view: "agents-v2" }> {
  return {
    view: "agents-v2",
    ...(route.projectSlug ? { projectSlug: route.projectSlug } : {}),
    ...(route.machineId ? { machineId: route.machineId } : {}),
  };
}

export function threadKey(thread: InboxThread): string {
  return thread.agentId ? `agent:${thread.agentId}` : `native:${thread.sessionId ?? thread.id}`;
}

export function isThreadSelected(thread: InboxThread, route: Extract<Route, { view: "agents-v2" }>): boolean {
  if (thread.agentId && route.selectedAgentId) return route.selectedAgentId === thread.agentId;
  if (thread.kind === "native" && thread.sessionId && route.sessionId) return route.sessionId === thread.sessionId;
  return false;
}

/** Single click — peek the thread in the right aside without leaving the inbox. */
export function threadSelectRoute(
  thread: InboxThread,
  route: Extract<Route, { view: "agents-v2" }>,
): Extract<Route, { view: "agents-v2" }> {
  if (thread.kind === "native") {
    return { ...scopeBase(route), sessionId: thread.sessionId ?? undefined };
  }
  return { ...scopeBase(route), selectedAgentId: thread.agentId ?? undefined };
}

/** Enter / open — the primary destination: the live conversation or session. */
export function threadOpenRoute(thread: InboxThread, route: Extract<Route, { view: "agents-v2" }>): Route {
  if (thread.kind === "native" && thread.sessionId) return { view: "sessions", sessionId: thread.sessionId };
  if (thread.conversationId) return { view: "conversation", conversationId: thread.conversationId };
  if (thread.agentId) return openProjectAgentProfile(route, thread.agentId);
  return scopeBase(route);
}

export function threadObserveRoute(
  thread: InboxThread,
  route: Extract<Route, { view: "agents-v2" }>,
): Route | null {
  if (thread.kind === "native" && thread.sessionId) return { view: "sessions", sessionId: thread.sessionId };
  if (thread.agentId) return { ...openProjectAgentProfile(route, thread.agentId), tab: "observe" };
  return null;
}

export function sessionSelectRoute(
  session: InboxSession,
  route: Extract<Route, { view: "agents-v2" }>,
): Extract<Route, { view: "agents-v2" }> {
  const sessionId = sessionRouteRef(session);
  if (!sessionId) return scopeBase(route);
  return {
    ...scopeBase(route),
    indexView: "sessions",
    ...(sessionId ? { sessionId } : {}),
    selectedAgentId: undefined,
  };
}

export function isSessionSelected(session: InboxSession, route: Extract<Route, { view: "agents-v2" }>): boolean {
  const sessionRef = sessionRouteRef(session);
  if (sessionRef && route.sessionId) return route.sessionId === sessionRef;
  return false;
}

export function sessionRouteRef(session: InboxSession): string | null {
  if (session.sessionId) return session.sessionId;
  if (session.conversationId) return session.conversationId;
  return null;
}

export function sessionOpenRoute(session: InboxSession, route: Extract<Route, { view: "agents-v2" }>): Route {
  const sessionId = sessionRouteRef(session);
  if (sessionId) {
    return {
      ...scopeBase(route),
      projectSlug: session.projectSlug,
      indexView: "sessions",
      sessionId,
      selectedAgentId: undefined,
    };
  }
  return {
    ...scopeBase(route),
    projectSlug: session.projectSlug,
    indexView: "sessions",
    selectedAgentId: undefined,
    sessionId: undefined,
  };
}

export { agentPrecedence };
