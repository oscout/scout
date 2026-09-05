/* Projects · Inbox — the foundational model.

   A project is a durable place where work happens. Runtime sessions and
   harness endpoints are activity inside that place, not additional agent
   identities. The roster projection therefore excludes session-backed actors;
   each project contributes one base project agent to directory counts.

   Pure + dependency-light so the whole thing stays unit-testable. All live
   fetching + sharing lives in useProjectsInbox.ts. */

import type {
  Agent,
  FleetAsk,
  FleetState,
  Route,
  SessionEntry,
  TailDiscoverySnapshot,
  TailEvent,
} from "../../lib/types.ts";
import {
  canonicalSessionHarness,
  formatSessionRouteRef,
  parseSessionRouteRef,
} from "../../../shared/session-route-ref.ts";
import { filterAgentsByMachineScope } from "../../lib/machine-scope.ts";
import { isMeshRosterAgent, isSessionStyleAgent } from "../../lib/mesh-roster.ts";
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

/** Keep polling cheap without hiding changes to either model-relevant slice. */
export function reuseFleetIfUnchanged(
  previous: FleetState | null,
  next: FleetState,
): FleetState {
  const modelSlice = (fleet: FleetState) =>
    JSON.stringify([fleet.activeAsks, fleet.needsAttention]);
  return previous && modelSlice(previous) === modelSlice(next)
    ? previous
    : next;
}

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
  /** Exact tail/runtime source used for collision-free native session routing. */
  source?: string;
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
  /** Exact tail/runtime source used for collision-free native session routing. */
  source?: string;
  branch: string | null;
  work: string;
  group: ThreadGroup;
  needs: false;
  working: boolean;
  lastActivityAt: number;
  /** Latest observed harness assistant output; never a Scout-owned message. */
  latestReplyAt: number | null;
  latestReplyPreview: string | null;
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
  /** Removed derived-worktree slug -> surviving canonical project slug. */
  projectAliases: Record<string, string>;
};

export type BuildInboxInput = {
  agents: Agent[];
  machineId: string | null;
  sessions: SessionEntry[];
  fleet: FleetState | null;
  discovery: TailDiscoverySnapshot | null;
  recentEvents?: TailEvent[];
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
    source: node.harness,
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
  latestReply?: TailEvent | null,
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
    source: node.harness,
    branch: branchLabel(branch ? [branch] : []),
    work: humanizeWorkText(node.detail ?? node.label) || node.label,
    group: sessionGroup(node, nowMs),
    needs: false,
    working,
    lastActivityAt: node.lastActivityAt ?? nowMs,
    latestReplyAt: latestReply?.ts ?? null,
    latestReplyPreview: latestReply?.summary.trim() || null,
    sessionCount: 1,
    contextPct: null,
    conversationId: node.route?.view === "conversation" ? node.route.conversationId : null,
    sessionId: node.route?.view === "sessions" ? node.route.sessionId ?? routeId : routeId,
    route: node.route,
  };
}

function normalizedSessionRef(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const leaf = trimmed.split(/[\\/]/u).filter(Boolean).at(-1) ?? trimmed;
  return leaf.endsWith(".jsonl") ? leaf.slice(0, -".jsonl".length) : leaf;
}

function observedSessionKey(source: string, value: string | null | undefined): string | null {
  const ref = normalizedSessionRef(value);
  if (!ref) return null;
  // Harness session ids are not globally unique. Keep the same source-scoped
  // identity boundary as the runtime tail registry so one provider's reply can
  // never label or reorder another provider's session.
  const harness = canonicalSessionHarness(source) ?? source.trim().toLowerCase();
  return `${harness}\u0000${ref}`;
}

function observedMessageRole(event: TailEvent): string | null {
  if (!event.raw || typeof event.raw !== "object" || Array.isArray(event.raw)) return null;
  const payload = (event.raw as Record<string, unknown>).payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const role = (payload as Record<string, unknown>).role;
  return typeof role === "string" ? role.trim().toLowerCase() : null;
}

function isApprovalReviewerDecision(summary: string): boolean {
  const trimmed = summary.trim();
  if (!trimmed.startsWith("{")) return false;
  // Tail summaries are deliberately clipped, so recognize the stable schema
  // before attempting a full JSON parse.
  if (
    trimmed.startsWith('{"risk_level":')
    && trimmed.includes('"user_authorization":')
    && trimmed.includes('"outcome":')
    && trimmed.includes('"rationale":')
  ) {
    return true;
  }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return typeof parsed.risk_level === "string"
      && typeof parsed.user_authorization === "string"
      && typeof parsed.outcome === "string"
      && typeof parsed.rationale === "string";
  } catch {
    return false;
  }
}

/** True only for a user-facing harness reply, not developer or approval plumbing. */
export function isObservedAssistantReply(event: TailEvent): boolean {
  if (event.kind !== "assistant") return false;
  const summary = event.summary.trim();
  if (!summary || /^\[(?:assistant|message)\]$/iu.test(summary)) return false;
  const role = observedMessageRole(event);
  if (role && role !== "assistant") return false;
  return !isApprovalReviewerDecision(summary);
}

function latestAssistantEventsBySession(events: TailEvent[]): Map<string, TailEvent> {
  const latest = new Map<string, TailEvent>();
  for (const event of events) {
    if (!isObservedAssistantReply(event)) continue;
    const key = observedSessionKey(event.source, event.sessionId);
    if (!key) continue;
    const current = latest.get(key);
    if (!current || event.ts > current.ts) latest.set(key, event);
  }
  return latest;
}

function projectSessions(
  project: DirProject,
  nowMs: number,
  repliesBySession: Map<string, TailEvent>,
): InboxSession[] {
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
          repliesBySession.get(observedSessionKey(node.harness, sessionRouteId(node.route)) ?? "") ?? null,
        ),
      );
    }
  }
  for (const node of project.unassigned) {
    if (!canOpenProjectSessionNode(node)) continue;
    sessions.push(projectSession(
      project,
      node,
      nowMs,
      undefined,
      undefined,
      repliesBySession.get(observedSessionKey(node.harness, sessionRouteId(node.route)) ?? "") ?? null,
    ));
  }

  return sessions.sort((a, b) => b.lastActivityAt - a.lastActivityAt || a.agentName.localeCompare(b.agentName));
}

/**
 * Discovery and broker conversations are eventually consistent. After all
 * authoritative rows are projected, keep a session-style registration visible
 * during that gap when it already carries an openable harness session ref.
 */
function appendSessionActorFallbacks(
  projects: DirProject[],
  sessions: InboxSession[],
  nowMs: number,
  repliesBySession: Map<string, TailEvent>,
): void {
  const represented = new Set<string>();
  for (const session of sessions) {
    const key = observedSessionKey(session.source ?? session.harness, session.sessionId);
    if (key) represented.add(key);
  }

  // A correlated conversation-backed child is authoritative even though its
  // route uses a conversation id rather than the harness session ref.
  for (const project of projects) {
    for (const agentNode of project.agents) {
      if (!agentNode.sessions.some(canOpenProjectSessionNode)) continue;
      const agent = agentNode.row.agent;
      const key = observedSessionKey(agent.harness ?? agentNode.row.harness, agent.harnessSessionId);
      if (key) represented.add(key);
    }
  }

  for (const project of projects) {
    for (const agentNode of project.agents) {
      const agent = agentNode.row.agent;
      if (!isSessionStyleAgent(agent)) continue;
      const source = agent.harness?.trim() || agentNode.row.harness;
      const refId = normalizedSessionRef(agent.harnessSessionId);
      const key = observedSessionKey(source, refId);
      if (!refId || !key || represented.has(key)) continue;
      represented.add(key);
      const working = isAgentRowWorking(agentNode.row);
      const node: ProjectTreeSessionNode = {
        key: `fallback:${agent.id}`,
        kind: "native",
        status: working ? "active" : "idle",
        harness: source,
        label: agent.name,
        detail: agentNode.row.activeTask ?? agent.harnessLogPath ?? refId,
        lastActivityAt: agentNode.row.lastActivityAt ?? agent.createdAt ?? nowMs,
        route: { view: "sessions", sessionId: refId },
      };
      sessions.push(projectSession(
        project,
        node,
        nowMs,
        agent,
        agentNode.row.branch,
        repliesBySession.get(key) ?? null,
      ));
    }
  }
  sessions.sort((left, right) => right.lastActivityAt - left.lastActivityAt || left.agentName.localeCompare(right.agentName));
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
  const registryAgents = buildRegistryAgents(dirProjects, showEphemeral)
    .filter((entry) => isMeshRosterAgent(entry.leadAgent));
  const repliesBySession = latestAssistantEventsBySession(input.recentEvents ?? []);

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

  const sessions = dirProjects.flatMap((project) => projectSessions(project, nowMs, repliesBySession));
  appendSessionActorFallbacks(dirProjects, sessions, nowMs, repliesBySession);

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
      // The project is the stable base coding identity. Claude/Codex endpoints
      // and their concrete sessions must not inflate this count.
      agentCount: 1,
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

  return collapseDerivedWorktreeProjects({ projects, threads, sessions, projectAliases: {} });
}

function projectRank(project: InboxProject): number {
  if (project.needs > 0) return 2;
  if (project.working > 0) return 1;
  return 0;
}

function isDerivedWorktreeRoot(root: string | null): boolean {
  if (!root) return false;
  return /\/(?:\.codex|\.claude|\.agents?)\/worktrees\/[^/]+\//iu.test(root)
    || /\/\.worktrees\/[^/]+/iu.test(root);
}

function comparableRoot(root: string): string {
  return root
    .replace(/^\/Users\/[^/]+(?=\/)/u, "~")
    .replace(/\/+$/u, "");
}

function mergeWorktrees(projects: InboxProject[]): InboxProjectWorktree[] {
  const merged = new Map<string, InboxProjectWorktree>();
  for (const project of projects) {
    for (const worktree of project.worktrees) {
      const current = merged.get(worktree.root);
      if (!current) {
        merged.set(worktree.root, { ...worktree });
        continue;
      }
      current.branch ??= worktree.branch;
      current.working ||= worktree.working;
      current.lastActivityAt = Math.max(current.lastActivityAt, worktree.lastActivityAt);
    }
  }
  return [...merged.values()].sort((left, right) =>
    Number(right.working) - Number(left.working)
    || right.lastActivityAt - left.lastActivityAt
    || left.root.localeCompare(right.root),
  );
}

/**
 * Agent registrations rooted in ~/.codex/worktrees/... can arrive as their own
 * DirProject even when the canonical repository already owns that worktree.
 * Collapse only when ownership is explicit: the canonical project must already
 * inventory the exact derived worktree root. A matching basename is not repo
 * provenance and must never merge independent clones.
 */
function collapseDerivedWorktreeProjects(model: ProjectsInboxModel): ProjectsInboxModel {
  const alias = new Map<string, string>();
  for (const project of model.projects) {
    if (!project.root || !isDerivedWorktreeRoot(project.root)) continue;

    const explicitOwners = model.projects.filter((candidate) =>
      candidate.slug !== project.slug
      && !isDerivedWorktreeRoot(candidate.root)
      && candidate.worktrees.some((worktree) => comparableRoot(worktree.root) === comparableRoot(project.root!)),
    );
    if (explicitOwners.length === 1) {
      alias.set(project.slug, explicitOwners[0]!.slug);
    }
  }
  if (alias.size === 0) return model;

  const projectBySlug = new Map(model.projects.map((project) => [project.slug, project]));
  const remapThread = (thread: InboxThread): InboxThread => {
    const targetSlug = alias.get(thread.projectSlug);
    if (!targetSlug) return thread;
    const target = projectBySlug.get(targetSlug)!;
    return {
      ...thread,
      projectSlug: target.slug,
      projectTitle: target.title,
      projectRoot: target.root,
    };
  };
  const remapSession = (session: InboxSession): InboxSession => {
    const targetSlug = alias.get(session.projectSlug);
    if (!targetSlug) return session;
    const target = projectBySlug.get(targetSlug)!;
    return {
      ...session,
      projectSlug: target.slug,
      projectTitle: target.title,
      projectRoot: target.root,
    };
  };

  const threads = model.threads.map(remapThread);
  const sessions = model.sessions.map(remapSession);
  const sourcesBySlug = new Map<string, InboxProject[]>();
  for (const project of model.projects) {
    const targetSlug = alias.get(project.slug) ?? project.slug;
    const sources = sourcesBySlug.get(targetSlug) ?? [];
    sources.push(project);
    sourcesBySlug.set(targetSlug, sources);
  }

  const projects = [...sourcesBySlug.entries()].map(([slug, sources]): InboxProject => {
    const canonical = projectBySlug.get(slug)!;
    const projectThreads = threads.filter((thread) => thread.projectSlug === slug);
    const projectSessions = sessions.filter((session) => session.projectSlug === slug);
    const worktrees = mergeWorktrees(sources);
    return {
      ...canonical,
      agentCount: 1,
      sessionCount: projectSessions.length,
      liveSessionCount: projectSessions.filter((session) => session.working).length,
      worktreeCount: worktrees.length,
      worktrees,
      needs: projectThreads.filter((thread) => thread.needs).length,
      working: projectThreads.filter((thread) => thread.working).length,
      threadCount: projectThreads.length,
      lastActivityAt: Math.max(...sources.map((project) => project.lastActivityAt)),
      branches: [...new Set(sources.flatMap((project) => project.branches))],
    };
  });
  projects.sort(
    (left, right) => projectRank(right) - projectRank(left)
      || right.lastActivityAt - left.lastActivityAt
      || left.title.localeCompare(right.title),
  );

  const projectAliases = { ...model.projectAliases };
  for (const [derivedSlug, canonicalSlug] of alias) projectAliases[derivedSlug] = canonicalSlug;
  return { projects, threads, sessions, projectAliases };
}

/** Normalize a project root for tolerant host ↔ model matching. */
export function normalizeProjectRootPath(root: string): string {
  return root
    .replace(/^\/Users\/[^/]+(?=\/)/u, "~")
    .replace(/\/+$/u, "");
}

/** Resolve a host-supplied absolute (or home-relative) root to a project slug. */
export function resolveProjectSlugFromRoot(
  model: ProjectsInboxModel,
  root: string | null | undefined,
): string | null {
  if (!root?.trim()) return null;
  const needle = normalizeProjectRootPath(root.trim());
  for (const project of model.projects) {
    if (project.root && normalizeProjectRootPath(project.root) === needle) {
      return resolveProjectSlug(model, project.slug) ?? project.slug;
    }
    for (const worktree of project.worktrees) {
      if (normalizeProjectRootPath(worktree.root) === needle) {
        return resolveProjectSlug(model, project.slug) ?? project.slug;
      }
    }
  }
  return null;
}

/** Resolve one historical derived-worktree slug without guessing by title. */
export function resolveProjectSlug(model: ProjectsInboxModel, slug: string): string | null {
  if (model.projects.some((project) => project.slug === slug)) return slug;
  let current = slug;
  const seen = new Set<string>();
  while (Object.hasOwn(model.projectAliases, current)) {
    if (seen.has(current)) return null;
    seen.add(current);
    current = model.projectAliases[current]!;
  }
  return model.projects.some((project) => project.slug === current) ? current : null;
}

/** Keep historical folded slugs while their canonical target remains visible. */
export function retainProjectAliases(
  previous: Readonly<Record<string, string>> | undefined,
  next: Readonly<Record<string, string>>,
  projects: ReadonlyArray<{ slug: string }>,
): Record<string, string> {
  const directSlugs = new Set(projects.map((project) => project.slug));
  const retained = { ...next };
  for (const [alias, target] of Object.entries(previous ?? {})) {
    if (directSlugs.has(alias) || !directSlugs.has(target) || retained[alias]) continue;
    retained[alias] = target;
  }
  return retained;
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
  return thread.agentId ? `agent:${thread.agentId}` : `native:${threadRouteRef(thread) ?? thread.id}`;
}

export function threadRouteRef(thread: InboxThread): string | null {
  if (thread.kind !== "native" || !thread.sessionId) return null;
  return formatSessionRouteRef(thread.source ?? thread.harness, thread.sessionId);
}

export function findInboxThread(
  threads: InboxThread[],
  route: Extract<Route, { view: "agents-v2" }>,
): InboxThread | null {
  const scoped = route.projectSlug
    ? threads.filter((thread) => thread.projectSlug === route.projectSlug)
    : threads;
  if (route.selectedAgentId) {
    const agents = scoped.filter((thread) => thread.agentId === route.selectedAgentId);
    return agents.length === 1 ? agents[0]! : null;
  }
  const routeRef = route.sessionId?.trim();
  if (!routeRef) return null;
  const exact = scoped.filter((thread) => threadRouteRef(thread) === routeRef);
  if (exact.length === 1) return exact[0]!;
  const parsedRoute = parseSessionRouteRef(routeRef);
  if (exact.length > 1 || parsedRoute?.qualified) return null;
  const legacyRef = parsedRoute?.refId ?? routeRef;
  const legacy = scoped.filter((thread) => (
    thread.kind === "native" && thread.sessionId === legacyRef
  ));
  return legacy.length === 1 ? legacy[0]! : null;
}

export function isThreadSelected(
  thread: InboxThread,
  route: Extract<Route, { view: "agents-v2" }>,
  threads: InboxThread[],
): boolean {
  return findInboxThread(threads, route) === thread;
}

/** Single click — peek the thread in the right aside without leaving the inbox. */
export function threadSelectRoute(
  thread: InboxThread,
  route: Extract<Route, { view: "agents-v2" }>,
): Extract<Route, { view: "agents-v2" }> {
  if (thread.kind === "native") {
    return { ...scopeBase(route), sessionId: threadRouteRef(thread) ?? undefined };
  }
  return { ...scopeBase(route), selectedAgentId: thread.agentId ?? undefined };
}

/** Enter / open — the primary destination: the live conversation or session. */
export function threadOpenRoute(thread: InboxThread, route: Extract<Route, { view: "agents-v2" }>): Route {
  const nativeRef = threadRouteRef(thread);
  if (nativeRef) return { view: "sessions", sessionId: nativeRef };
  if (thread.conversationId) return { view: "conversation", conversationId: thread.conversationId };
  if (thread.agentId) return openProjectAgentProfile(route, thread.agentId);
  return scopeBase(route);
}

export function threadObserveRoute(
  thread: InboxThread,
  route: Extract<Route, { view: "agents-v2" }>,
): Route | null {
  const nativeRef = threadRouteRef(thread);
  if (nativeRef) return { view: "sessions", sessionId: nativeRef };
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

export function isSessionSelected(
  session: InboxSession,
  route: Extract<Route, { view: "agents-v2" }>,
  sessions: InboxSession[],
): boolean {
  return findInboxSession(sessions, route) === session;
}

export function sessionRouteRef(session: InboxSession): string | null {
  if (session.conversationId && session.route?.view === "conversation") return session.conversationId;
  if (session.sessionId) return formatSessionRouteRef(session.source ?? session.harness, session.sessionId);
  if (session.conversationId) return session.conversationId;
  return null;
}

/** Resolve a route inside its project and fail closed when a legacy bare id is ambiguous. */
export function findInboxSession(
  sessions: InboxSession[],
  route: Extract<Route, { view: "agents-v2" }>,
): InboxSession | null {
  const routeRef = route.sessionId?.trim();
  if (!routeRef) return null;
  const scoped = route.projectSlug
    ? sessions.filter((session) => session.projectSlug === route.projectSlug)
    : sessions;
  const exact = scoped.filter((session) => sessionRouteRef(session) === routeRef);
  if (exact.length === 1) return exact[0]!;
  const parsedRoute = parseSessionRouteRef(routeRef);
  if (exact.length > 1 || parsedRoute?.qualified) return null;
  const legacyRef = parsedRoute?.refId ?? routeRef;
  const legacy = scoped.filter((session) =>
    session.sessionId === legacyRef
    || session.conversationId === legacyRef
    || session.id === legacyRef
  );
  return legacy.length === 1 ? legacy[0]! : null;
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
