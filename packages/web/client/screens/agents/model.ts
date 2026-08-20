import { agentStateLabel, normalizeAgentState, type AgentInventoryStatus } from "../../lib/agent-state.ts";
import { formatLabel } from "../../lib/text.ts";
import {
  basename,
  canonicalProjectRoot,
  dirname,
  disambiguateProjectSlugs,
  isTemporaryProjectRoot,
  normalizeProjectRoot,
  projectIdentity,
  projectKeyFrom,
  projectSlug,
  readableProjectTitle,
  reconcileRootlessSlices,
  workspaceRootFromObservedPath,
  worktreeFamilyFromRoot,
  type ProjectIdentity,
} from "./project-identity.ts";

// Re-export the identity layer so existing `from "./model.ts"` import sites keep working.
export {
  basename,
  canonicalProjectRoot,
  dirname,
  isTemporaryProjectRoot,
  normalizeProjectRoot,
  projectIdentity,
  projectKeyFrom,
  projectSlug,
  readableProjectTitle,
  reconcileRootlessSlices,
  workspaceRootFromObservedPath,
  worktreeFamilyFromRoot,
};
export type { ProjectIdentity };
import type {
  Agent,
  FleetAsk,
  HarnessTopologySnapshot,
  Route,
  SessionEntry,
  TailDiscoveredProcess,
  TailDiscoverySnapshot,
} from "../../lib/types.ts";

export function agentLabel(
  agent: Agent,
  allAgents: Agent[],
): { name: string; qualifier: string | null } {
  const siblings = allAgents.filter((c) => c.name === agent.name);
  if (siblings.length <= 1) return { name: agent.name, qualifier: null };
  const qualifier = agent.project ?? agent.branch ?? agent.id.replace(/^.*\./, "");
  return { name: agent.name, qualifier };
}

export function countLabel(value: number, singular: string, plural = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

export function handleLabel(agent: Agent): string | null {
  return agent.handle ? `@${agent.handle.replace(/^@+/, "")}` : null;
}

export function primaryAgentSelector(agent: Agent): string | null {
  return agent.selector ?? agent.defaultSelector ?? handleLabel(agent);
}

export function directSessionMaps(sessions: SessionEntry[]): {
  conversationByAgentId: Map<string, string>;
  sessionByAgentId: Map<string, SessionEntry>;
} {
  const directSessions = [...sessions]
    .filter(
      (s): s is SessionEntry & { agentId: string } =>
        s.kind === "direct" && Boolean(s.agentId),
    )
    .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));

  const conversationByAgentId = new Map<string, string>();
  const sessionByAgentId = new Map<string, SessionEntry>();
  for (const session of directSessions) {
    const current = sessionByAgentId.get(session.agentId);
    if (!current || shouldPreferDirectSession(session, current)) {
      conversationByAgentId.set(session.agentId, session.id);
      sessionByAgentId.set(session.agentId, session);
    }
  }
  return { conversationByAgentId, sessionByAgentId };
}

export function shouldPreferDirectSession(candidate: SessionEntry & { agentId: string }, existing: SessionEntry): boolean {
  const candidateLastAt = candidate.lastMessageAt ?? 0;
  const existingLastAt = existing.lastMessageAt ?? 0;
  if (candidateLastAt !== existingLastAt) return candidateLastAt > existingLastAt;

  return candidate.id < existing.id;
}

export type { AgentInventoryStatus } from "../../lib/agent-state.ts";

export type AgentInventoryRow = {
  agent: Agent;
  status: AgentInventoryStatus;
  stateLabel: string;
  project: string;
  branch: string;
  harness: string;
  session: SessionEntry | null;
  activeTask: string | null;
  activeAskCount: number;
  lastActivityAt: number | null;
};

export type AgentsLibraryViewMode = "cards" | "tree";

export type TimeHorizonKey = "1h" | "24h" | "7d" | "all";

export const DEFAULT_TIME_HORIZON: TimeHorizonKey = "24h";
export const PROJECT_OVERVIEW_AGENT_LIMIT = 8;
export const PROJECT_OVERVIEW_SESSION_LIMIT = 3;

export const TIME_HORIZON_OPTIONS: Array<{ key: TimeHorizonKey; label: string }> = [
  { key: "1h", label: "1h" },
  { key: "24h", label: "24h" },
  { key: "7d", label: "7d" },
  { key: "all", label: "all" },
];

export type NativeSessionStatus = "active" | "idle";

export type NativeSessionRow = {
  key: string;
  refId: string;
  source: string;
  project: string;
  cwd: string | null;
  transcriptPath: string | null;
  sessionId: string | null;
  mtimeMs: number | null;
  size: number | null;
  status: NativeSessionStatus;
  process: TailDiscoveredProcess | null;
  lastActivityAt: number | null;
};

export type ProjectSlice = ProjectIdentity & {
  agents: AgentInventoryRow[];
  scoutSessions: SessionEntry[];
  nativeSessions: NativeSessionRow[];
  workflows: ProjectWorkflowRow[];
  status: AgentInventoryStatus;
  lastActivityAt: number | null;
};

export type ProjectWorkflowRow = {
  key: string;
  source: string;
  label: string;
  project: ProjectIdentity;
  status: string;
  description: string | null;
  parentSessionId: string | null;
  workerCount: number;
  taskCount: number;
  activeTaskCount: number;
  completedTaskCount: number;
  lastActivityAt: number | null;
};

export type ProjectTreeSessionKind = "native" | "scout" | "workflow";

export type ProjectTreeSessionNode = {
  key: string;
  kind: ProjectTreeSessionKind;
  status: string;
  harness: string;
  label: string;
  detail: string | null;
  subLabel?: string;
  lastActivityAt: number | null;
  route: Route | null;
};

export type ProjectTreeAgentNode = {
  key: string;
  row: AgentInventoryRow;
  sessions: ProjectTreeSessionNode[];
};

export type ProjectTree = {
  agents: ProjectTreeAgentNode[];
  unassignedSessions: ProjectTreeSessionNode[];
};

export type SessionInitiationResult = {
  ok?: boolean;
  conversationId?: string | null;
  agentId?: string | null;
  sessionId?: string | null;
  handle?: string | null;
  flightId?: string | null;
  invocationId?: string | null;
  messageId?: string | null;
};

export const AGENT_STATUS_RANK: Record<AgentInventoryStatus, number> = {
  needs_attention: 0,
  in_turn: 1,
  in_flight: 2,
  callable: 3,
  blocked: 4,
};

export function agentInventoryStatusClass(status: AgentInventoryStatus): string {
  switch (status) {
    case "in_turn":
    case "in_flight":
    case "needs_attention":
      return "working";
    case "callable":
      return "available";
    case "blocked":
      return "offline";
  }
}

export function agentInventoryStatusLabel(status: AgentInventoryStatus): string {
  switch (status) {
    case "in_turn":
      return "in turn";
    case "in_flight":
      return "in flight";
    case "needs_attention":
      return "needs attention";
    case "callable":
      return "callable";
    case "blocked":
      return "blocked";
  }
}

const NATIVE_SESSION_ACTIVE_WINDOW_MS = 60_000;

export function projectIdentityForRooted(title: string | null | undefined, root: string | null | undefined): ProjectIdentity {
  const normalizedRoot = normalizeProjectRoot(root);
  const family = worktreeFamilyFromRoot(normalizedRoot);
  return family ? projectIdentity(family.title, family.root) : projectIdentity(title, normalizedRoot);
}

export function projectIdentityForAgentRow(row: AgentInventoryRow): ProjectIdentity {
  const root = normalizeProjectRoot(row.agent.projectRoot ?? row.agent.cwd);
  const title = row.agent.project ?? row.project;
  return projectIdentityForRooted(title, root);
}

export function projectIdentityForNativeSession(row: NativeSessionRow): ProjectIdentity {
  return projectIdentityForRooted(row.project, row.cwd);
}

export function projectIdentityForScoutSession(session: SessionEntry): ProjectIdentity {
  return projectIdentityForRooted(session.agentName ?? session.title, session.workspaceRoot);
}

export function topologySourceLabel(source: string): string {
  if (source.includes("claude")) return "claude";
  if (source.includes("codex")) return "codex";
  return formatLabel(source) ?? "workflow";
}

export function stringMeta(meta: Record<string, unknown> | undefined, key: string): string | null {
  const value = meta?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function projectIdentityForWorkflow(row: ProjectWorkflowRow): ProjectIdentity {
  return projectIdentityForRooted(row.project.title, row.project.root);
}

export function normalizeSessionRef(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const leaf = basename(trimmed) ?? trimmed;
  return leaf.endsWith(".jsonl") ? leaf.slice(0, -".jsonl".length) : leaf;
}

export function addSessionRef(candidates: Set<string>, value: string | null | undefined): void {
  const raw = value?.trim();
  if (raw) candidates.add(raw.toLowerCase());
  const normalized = normalizeSessionRef(raw);
  if (normalized) candidates.add(normalized.toLowerCase());
}

export function agentSessionRefs(row: AgentInventoryRow): Set<string> {
  const refs = new Set<string>();
  addSessionRef(refs, row.agent.conversationId);
  addSessionRef(refs, row.agent.harnessSessionId);
  addSessionRef(refs, row.agent.harnessLogPath);
  addSessionRef(refs, row.session?.id);
  addSessionRef(refs, row.session?.harnessSessionId);
  addSessionRef(refs, row.session?.harnessLogPath);
  return refs;
}

export function refMatches(candidates: Set<string>, value: string | null | undefined): boolean {
  const raw = value?.trim();
  if (raw && candidates.has(raw.toLowerCase())) return true;
  const normalized = normalizeSessionRef(raw);
  return Boolean(normalized && candidates.has(normalized.toLowerCase()));
}

export function scoutSessionMatchesAgent(session: SessionEntry, row: AgentInventoryRow): boolean {
  if (session.agentId && session.agentId === row.agent.id) return true;
  const refs = agentSessionRefs(row);
  return refMatches(refs, session.id)
    || refMatches(refs, session.harnessSessionId)
    || refMatches(refs, session.harnessLogPath);
}

export function nativeProcessMatchesAgent(process: TailDiscoveredProcess | null, row: AgentInventoryRow): boolean {
  const command = process?.command?.toLowerCase();
  if (!command) return false;
  const candidates = [
    row.agent.id,
    row.agent.selector?.replace(/^@/, "").replace(/\.node:.+$/, ""),
    row.agent.defaultSelector?.replace(/^@/, "").replace(/\.node:.+$/, ""),
    row.agent.harnessSessionId,
  ].filter((value): value is string => Boolean(value && value.length >= 8));
  return candidates.some((candidate) => command.includes(candidate.toLowerCase()));
}

export function nativeSessionMatchesAgent(session: NativeSessionRow, row: AgentInventoryRow): boolean {
  const refs = agentSessionRefs(row);
  return refMatches(refs, session.refId)
    || refMatches(refs, session.sessionId)
    || refMatches(refs, session.transcriptPath)
    || nativeProcessMatchesAgent(session.process, row);
}

export function buildNativeSessionRows(
  discovery: TailDiscoverySnapshot | null,
  now: number,
): NativeSessionRow[] {
  if (!discovery) return [];

  const rows: NativeSessionRow[] = [];
  for (const transcript of discovery.transcripts ?? []) {
    const source = transcript.source || "unknown";
    const refId = normalizeSessionRef(transcript.sessionId)
      ?? normalizeSessionRef(transcript.transcriptPath);
    if (!refId) continue;

    const lastActivityAt = (transcript.lastEventAt ?? transcript.mtimeMs) || null;
    rows.push({
      key: `transcript:${transcript.transcriptPath}`,
      refId,
      source,
      project: transcript.project?.trim()
        || basename(transcript.cwd)
        || basename(transcript.transcriptPath)
        || "unknown",
      cwd: normalizeProjectRoot(transcript.cwd),
      transcriptPath: transcript.transcriptPath,
      sessionId: transcript.sessionId,
      mtimeMs: transcript.mtimeMs,
      size: transcript.size,
      status: lastActivityAt && now - lastActivityAt <= NATIVE_SESSION_ACTIVE_WINDOW_MS
        ? "active"
        : "idle",
      process: null,
      lastActivityAt,
    });
  }

  for (const process of discovery.processes ?? []) {
    const source = process.source || "unknown";

    const cwd = normalizeProjectRoot(process.cwd);
    rows.push({
      key: `process:${source}:${process.pid}`,
      refId: `pid-${process.pid}`,
      source,
      project: basename(cwd) ?? "unknown",
      cwd,
      transcriptPath: null,
      sessionId: null,
      mtimeMs: null,
      size: null,
      status: "active",
      process,
      lastActivityAt: null,
    });
  }

  return rows.sort((left, right) => {
    const statusDelta = (left.status === "active" ? 0 : 1) - (right.status === "active" ? 0 : 1);
    if (statusDelta !== 0) return statusDelta;
    return (right.lastActivityAt ?? 0) - (left.lastActivityAt ?? 0)
      || left.project.localeCompare(right.project);
  });
}

export function buildWorkflowRows(snapshot: HarnessTopologySnapshot | null): ProjectWorkflowRow[] {
  if (!snapshot) return [];
  const rows: ProjectWorkflowRow[] = [];

  for (const observation of snapshot.observations) {
    const topology = observation.topology;
    const source = topologySourceLabel(observation.source);
    const sourceRefs = new Map((topology.sourceRefs ?? []).map((ref) => [ref.id, ref.ref]));

    for (const group of topology.groups) {
      if (group.kind !== "workflow") continue;

      const runId = stringMeta(group.providerMeta, "claudeWorkflowRunId") ?? group.id;
      const tasks = topology.tasks.filter((task) =>
        stringMeta(task.providerMeta, "claudeWorkflowRunId") === runId,
      );
      const workers = topology.agents.filter((agent) =>
        stringMeta(agent.providerMeta, "claudeWorkflowRunId") === runId && agent.role !== "lead",
      );
      const activeTasks = tasks.filter((task) => task.state !== "completed");
      const completedTasks = tasks.filter((task) => task.state === "completed");
      const pathCandidates = [
        stringMeta(group.providerMeta, "workspaceRoot"),
        stringMeta(group.providerMeta, "cwd"),
        stringMeta(group.providerMeta, "transcriptDir"),
        stringMeta(group.providerMeta, "scriptPath"),
        group.sourceRef ? sourceRefs.get(group.sourceRef) : null,
        ...topology.agents.map((agent) => agent.cwd),
      ];
      const root = pathCandidates
        .map(workspaceRootFromObservedPath)
        .find((value): value is string => Boolean(value)) ?? null;
      const project = projectIdentityForRooted(basename(root) ?? group.name ?? "Workflows", root);
      const observedAt = Date.parse(topology.observedAt);
      const lastActivityAt = Math.max(
        Number.isFinite(observedAt) ? observedAt : 0,
        observation.changedAt ?? 0,
      ) || null;

      rows.push({
        key: group.id,
        source,
        label: group.name ?? runId,
        project,
        status: activeTasks.length > 0 ? "running" : tasks.length > 0 ? "completed" : "observed",
        description: stringMeta(group.providerMeta, "description"),
        parentSessionId: stringMeta(group.providerMeta, "parentSessionId"),
        workerCount: workers.length,
        taskCount: tasks.length,
        activeTaskCount: activeTasks.length,
        completedTaskCount: completedTasks.length,
        lastActivityAt,
      });
    }
  }

  return rows.sort((left, right) => {
    const activeDelta = (right.activeTaskCount > 0 ? 1 : 0) - (left.activeTaskCount > 0 ? 1 : 0);
    if (activeDelta !== 0) return activeDelta;
    return (right.lastActivityAt ?? 0) - (left.lastActivityAt ?? 0)
      || left.label.localeCompare(right.label);
  });
}

export function classPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "unknown";
}

export function harnessChipClass(harness: string): string {
  return `s-atop-chip s-atop-chip--harness s-atop-chip--harness-${classPart(harness)}`;
}

export function shortSessionId(value: string | null | undefined): string {
  if (!value) return "—";
  const compact = value.replace(/^session[_:-]?/i, "");
  return compact.length > 10 ? compact.slice(0, 8) : compact;
}

export function trimmed(value: string | null | undefined): string | undefined {
  const result = value?.trim();
  return result ? result : undefined;
}

export function newSessionPayloadForAgent(agent: Agent) {
  const projectPath = trimmed(agent.projectRoot) ?? trimmed(agent.cwd);
  return {
    target: {
      agentId: agent.id,
      ...(projectPath ? { projectPath } : {}),
    },
    execution: {
      session: "new",
      ...(trimmed(agent.harness) ? { harness: trimmed(agent.harness) } : {}),
      ...(trimmed(agent.model) ? { model: trimmed(agent.model) } : {}),
    },
  };
}

export function activeTaskFromAsks(asks: FleetAsk[]): string | null {
  if (asks.length === 0) return null;
  const statusRank: Record<FleetAsk["status"], number> = {
    working: 0,
    needs_attention: 1,
    queued: 2,
    failed: 3,
    completed: 4,
  };
  const top = [...asks].sort((a, b) => {
    const ranked = statusRank[a.status] - statusRank[b.status];
    if (ranked !== 0) return ranked;
    return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  })[0];
  return (top.summary ?? top.task ?? top.statusLabel ?? "").trim() || null;
}

export function rowForAgentInventory(
  agent: Agent,
  session: SessionEntry | null,
  activeAsks: FleetAsk[],
): AgentInventoryRow {
  const status = normalizeAgentState(agent.state, agent);
  const project = agent.project ?? basename(agent.projectRoot) ?? "Unscoped";
  const branch = agent.branch ?? "—";
  const harness = formatLabel(agent.harness) ?? formatLabel(agent.agentClass) ?? "agent";
  return {
    agent,
    status,
    stateLabel: agentStateLabel(agent.state, agent),
    project,
    branch,
    harness,
    session,
    activeTask: activeTaskFromAsks(activeAsks),
    activeAskCount: activeAsks.length,
    lastActivityAt: Math.max(
      0,
      session?.lastMessageAt ?? 0,
      agent.updatedAt ?? 0,
    ) || null,
  };
}

export function emptyProjectSlice(identity: ProjectIdentity): ProjectSlice {
  return {
    ...identity,
    agents: [],
    scoutSessions: [],
    nativeSessions: [],
    workflows: [],
    status: "callable",
    lastActivityAt: null,
  };
}

export function ensureProjectSlice(
  map: Map<string, ProjectSlice>,
  identity: ProjectIdentity,
): ProjectSlice {
  const existing = map.get(identity.key);
  if (existing) {
    if (
      identity.root
      && (!existing.root || (isTemporaryProjectRoot(existing.root) && !isTemporaryProjectRoot(identity.root)))
    ) {
      existing.root = identity.root;
    }
    return existing;
  }
  const next = emptyProjectSlice(identity);
  map.set(identity.key, next);
  return next;
}

export function updateProjectSliceSummary(project: ProjectSlice): void {
  const hasBusyAgent = project.agents.some((row) => row.status === "in_turn" || row.status === "in_flight");
  const hasActiveNativeSession = project.nativeSessions.some((row) => row.status === "active");
  const hasActiveWorkflow = project.workflows.some((row) => row.activeTaskCount > 0 || row.status === "running");
  const hasCallableAgent = project.agents.some((row) => row.status === "callable");
  project.status = hasBusyAgent || hasActiveNativeSession || hasActiveWorkflow
    ? "in_turn"
    : hasCallableAgent
      ? "callable"
      : "blocked";

  const agentActivity = project.agents.map((row) => row.lastActivityAt ?? 0);
  const scoutActivity = project.scoutSessions.map((session) => session.lastMessageAt ?? 0);
  const nativeActivity = project.nativeSessions.map((session) => session.lastActivityAt ?? 0);
  const workflowActivity = project.workflows.map((workflow) => workflow.lastActivityAt ?? 0);
  const latest = Math.max(0, ...agentActivity, ...scoutActivity, ...nativeActivity, ...workflowActivity);
  project.lastActivityAt = latest || null;
}

export function buildProjectSlices(
  agentRows: AgentInventoryRow[],
  scoutSessions: SessionEntry[],
  nativeSessions: NativeSessionRow[],
  workflows: ProjectWorkflowRow[],
): ProjectSlice[] {
  const map = new Map<string, ProjectSlice>();
  const projectKeyByAgentId = new Map<string, string>();

  for (const row of agentRows) {
    const identity = projectIdentityForAgentRow(row);
    const project = ensureProjectSlice(map, identity);
    project.agents.push(row);
    projectKeyByAgentId.set(row.agent.id, identity.key);
  }

  for (const row of nativeSessions) {
    const project = ensureProjectSlice(map, projectIdentityForNativeSession(row));
    project.nativeSessions.push(row);
  }

  for (const row of workflows) {
    const project = ensureProjectSlice(map, projectIdentityForWorkflow(row));
    project.workflows.push(row);
  }

  const seenSessionIdsByProject = new Map<string, Set<string>>();
  for (const session of scoutSessions) {
    const agentKey = session.agentId ? projectKeyByAgentId.get(session.agentId) : undefined;
    // A workspaceRoot that doesn't canonicalize to a real repo (a bare home dir,
    // a null cwd) must not mint its own project — that's the phantom "Art" tile.
    const identity = agentKey
      ? map.get(agentKey) ?? null
      : canonicalProjectRoot(session.workspaceRoot)
        ? ensureProjectSlice(map, projectIdentityForScoutSession(session))
        : null;
    if (!identity) continue;

    const project = identity;
    const seen = seenSessionIdsByProject.get(project.key) ?? new Set<string>();
    if (seen.has(session.id)) continue;
    seen.add(session.id);
    seenSessionIdsByProject.set(project.key, seen);
    project.scoutSessions.push(session);
  }

  // Fold rootless records into their rooted project; drop unattributable junk.
  reconcileRootlessSlices(map);

  for (const project of map.values()) {
    project.agents.sort((left, right) => {
      const statusDelta = AGENT_STATUS_RANK[left.status] - AGENT_STATUS_RANK[right.status];
      if (statusDelta !== 0) return statusDelta;
      return (right.lastActivityAt ?? 0) - (left.lastActivityAt ?? 0)
        || left.agent.name.localeCompare(right.agent.name);
    });
    project.scoutSessions.sort((left, right) => (right.lastMessageAt ?? 0) - (left.lastMessageAt ?? 0));
    project.nativeSessions.sort((left, right) => {
      const statusDelta = (left.status === "active" ? 0 : 1) - (right.status === "active" ? 0 : 1);
      if (statusDelta !== 0) return statusDelta;
      return (right.lastActivityAt ?? 0) - (left.lastActivityAt ?? 0);
    });
    project.workflows.sort((left, right) => {
      const activeDelta = (right.activeTaskCount > 0 ? 1 : 0) - (left.activeTaskCount > 0 ? 1 : 0);
      if (activeDelta !== 0) return activeDelta;
      return (right.lastActivityAt ?? 0) - (left.lastActivityAt ?? 0)
        || left.label.localeCompare(right.label);
    });
    updateProjectSliceSummary(project);
  }

  const slices = [...map.values()];
  // Make the URL slug injective before the slices leave the builder: clean
  // one-word slugs stay, only same-basename collisions get a hash discriminator.
  disambiguateProjectSlugs(slices);
  return slices.sort((left, right) => {
    const statusDelta = AGENT_STATUS_RANK[left.status] - AGENT_STATUS_RANK[right.status];
    if (statusDelta !== 0) return statusDelta;
    return (right.lastActivityAt ?? 0) - (left.lastActivityAt ?? 0)
      || left.title.localeCompare(right.title);
  });
}

export function scoutSessionNode(session: SessionEntry): ProjectTreeSessionNode {
  const harness = formatLabel(session.harness) ?? "scout";
  return {
    key: `scout:${session.id}`,
    kind: "scout",
    status: session.kind,
    harness,
    label: session.title || session.agentName || session.id,
    detail: session.preview ?? session.id,
    lastActivityAt: session.lastMessageAt,
    route: { view: "conversation", conversationId: session.id },
  };
}

export function nativeSessionNode(session: NativeSessionRow): ProjectTreeSessionNode {
  return {
    key: `native:${session.key}`,
    kind: "native",
    status: session.status,
    harness: session.source,
    label: shortSessionId(session.sessionId ?? session.refId),
    detail: session.transcriptPath ?? session.process?.command ?? session.cwd,
    lastActivityAt: session.lastActivityAt,
    route: session.sessionId || session.transcriptPath
      ? { view: "sessions", sessionId: session.refId }
      : null,
  };
}

export function workflowSessionNode(workflow: ProjectWorkflowRow): ProjectTreeSessionNode {
  const completed = workflow.taskCount > 0
    ? `${workflow.completedTaskCount}/${workflow.taskCount} tasks`
    : "workflow";
  const active = workflow.activeTaskCount > 0
    ? `${workflow.activeTaskCount} active`
    : completed;
  const traceDetail = workflow.parentSessionId
    ? `parent session ${shortSessionId(workflow.parentSessionId)}`
    : null;
  return {
    key: `workflow:${workflow.key}`,
    kind: "workflow",
    status: "workflow",
    harness: workflow.source,
    label: workflow.label,
    detail: workflow.description && traceDetail
      ? `${workflow.description} · ${traceDetail}`
      : workflow.description ?? (traceDetail ? `Claude workflow observed from ${traceDetail}` : `${workflow.workerCount} workers · ${active}`),
    subLabel: `${workflow.workerCount} workers · ${active}`,
    lastActivityAt: workflow.lastActivityAt,
    route: workflow.parentSessionId
      ? { view: "sessions", sessionId: workflow.parentSessionId }
      : null,
  };
}

export function compareProjectTreeAgents(left: AgentInventoryRow, right: AgentInventoryRow): number {
  return left.agent.name.localeCompare(right.agent.name)
    || left.agent.id.localeCompare(right.agent.id);
}

export function sortProjectTreeSessions(sessions: ProjectTreeSessionNode[]): ProjectTreeSessionNode[] {
  const kindRank: Record<ProjectTreeSessionKind, number> = {
    workflow: 0,
    native: 1,
    scout: 2,
  };
  return [...sessions].sort((left, right) => {
    const kindDelta = kindRank[left.kind] - kindRank[right.kind];
    if (kindDelta !== 0) return kindDelta;
    return left.harness.localeCompare(right.harness)
      || left.key.localeCompare(right.key);
  });
}

export function showProjectLevelSessionInOverview(session: ProjectTreeSessionNode): boolean {
  return session.kind === "workflow" || (session.kind === "native" && session.status === "active");
}

export function timeHorizonCutoff(horizon: TimeHorizonKey, now: number): number | null {
  switch (horizon) {
    case "1h":
      return now - 60 * 60 * 1000;
    case "24h":
      return now - 24 * 60 * 60 * 1000;
    case "7d":
      return now - 7 * 24 * 60 * 60 * 1000;
    case "all":
      return null;
  }
}

export function isWithinTimeHorizon(
  timestamp: number | null | undefined,
  horizon: TimeHorizonKey,
  now: number,
  keepActive = false,
): boolean {
  if (horizon === "all") return true;
  if (keepActive) return true;
  const cutoff = timeHorizonCutoff(horizon, now);
  return Boolean(cutoff !== null && timestamp && timestamp >= cutoff);
}

export function buildProjectTree(project: ProjectSlice): ProjectTree {
  const assignedScout = new Set<string>();
  const assignedNative = new Set<string>();

  const agents = [...project.agents].sort(compareProjectTreeAgents).map((row) => {
    const sessions: ProjectTreeSessionNode[] = [];

    for (const session of project.scoutSessions) {
      if (assignedScout.has(session.id)) continue;
      if (!scoutSessionMatchesAgent(session, row)) continue;
      assignedScout.add(session.id);
      sessions.push(scoutSessionNode(session));
    }

    for (const session of project.nativeSessions) {
      if (assignedNative.has(session.key)) continue;
      if (!nativeSessionMatchesAgent(session, row)) continue;
      assignedNative.add(session.key);
      sessions.push(nativeSessionNode(session));
    }

    return {
      key: row.agent.id,
      row,
      sessions: sortProjectTreeSessions(sessions),
    };
  });

  const unassignedSessions = sortProjectTreeSessions([
    ...project.nativeSessions
      .filter((session) => !assignedNative.has(session.key))
      .map(nativeSessionNode),
    ...project.scoutSessions
      .filter((session) => !assignedScout.has(session.id))
      .map(scoutSessionNode),
  ]);

  return { agents, unassignedSessions };
}

/* ── Directory model — projects as the primary object, shared by the left-lane
   navigator (AgentsLeft) and the detail content (AgentsLibrary). An "agent" in
   the directory is the (project · harness) rollup; the leaf is a session. ── */

export type DirProject = {
  slice: ProjectSlice;
  agents: ProjectTreeAgentNode[];
  unassigned: ProjectTreeSessionNode[];
  lastActivityAt: number;
};

export const isAgentRowWorking = (row: AgentInventoryRow) =>
  row.status === "in_turn" || row.status === "in_flight";

function dirNodeRecency(node: ProjectTreeAgentNode): number {
  let m = node.row.lastActivityAt ?? 0;
  for (const s of node.sessions) m = Math.max(m, s.lastActivityAt ?? 0);
  return m;
}

export function dirProjectWorking(p: DirProject): number {
  return p.agents.filter((n) => isAgentRowWorking(n.row)).length;
}
export function dirProjectNeeds(p: DirProject): boolean {
  return p.agents.some((n) => n.row.activeAskCount > 0);
}
export function dirProjectHarnesses(p: DirProject): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const node of p.agents) {
    const h = (node.row.harness || "agent").toLowerCase();
    if (!seen.has(h)) {
      seen.add(h);
      out.push(h);
    }
  }
  return out;
}
export function dirProjectSessionCount(p: DirProject): number {
  return (
    p.agents.reduce((n, node) => n + Math.max(node.sessions.length, 1), 0) + p.unassigned.length
  );
}

/** Build the live-first directory of projects, each with its agent tree. */
export function buildDirProjects(
  rows: AgentInventoryRow[],
  scoutSessions: SessionEntry[],
  nativeSessions: NativeSessionRow[],
): DirProject[] {
  const slices = buildProjectSlices(rows, scoutSessions, nativeSessions, []);
  const built = slices.map((slice) => {
    const tree = buildProjectTree(slice);
    let lastActivityAt = 0;
    for (const node of tree.agents) lastActivityAt = Math.max(lastActivityAt, dirNodeRecency(node));
    for (const s of tree.unassignedSessions)
      lastActivityAt = Math.max(lastActivityAt, s.lastActivityAt ?? 0);
    return { slice, agents: tree.agents, unassigned: tree.unassignedSessions, lastActivityAt };
  });
  built.sort((a, b) => {
    const an = dirProjectNeeds(a) ? 1 : 0;
    const bn = dirProjectNeeds(b) ? 1 : 0;
    if (an !== bn) return bn - an;
    const aw = dirProjectWorking(a);
    const bw = dirProjectWorking(b);
    if (aw !== bw) return bw - aw;
    return b.lastActivityAt - a.lastActivityAt;
  });
  return built;
}

export function readCollapsedProjectTreeRows(storageKey: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((value): value is string => typeof value === "string"))
      : new Set();
  } catch {
    return new Set();
  }
}

export function writeCollapsedProjectTreeRows(storageKey: string, rows: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    if (rows.size === 0) {
      window.localStorage.removeItem(storageKey);
    } else {
      window.localStorage.setItem(storageKey, JSON.stringify([...rows]));
    }
  } catch {
    // Local persistence is best-effort; the tree still works without it.
  }
}

export function agentInventoryRowMatchesQuery(row: AgentInventoryRow, query: string): boolean {
  if (!query) return true;
  const hay = [
    row.agent.name,
    row.agent.handle,
    row.agent.id,
    row.agent.selector,
    row.agent.defaultSelector,
    row.project,
    row.agent.projectRoot,
    row.branch,
    row.harness,
    row.activeTask,
    row.session?.preview,
    row.session?.id,
    row.agent.harnessSessionId,
  ].filter(Boolean).join(" ").toLowerCase();
  return hay.includes(query);
}

export function nativeSessionMatchesFilters(
  row: NativeSessionRow,
  query: string,
  harnessFilter: Set<string>,
): boolean {
  if (harnessFilter.size > 0 && !harnessFilter.has(row.source)) return false;
  if (!query) return true;
  const hay = [
    row.refId,
    row.sessionId,
    row.source,
    row.project,
    row.cwd,
    row.transcriptPath,
    row.process?.command,
  ].filter(Boolean).join(" ").toLowerCase();
  return hay.includes(query);
}

export function scoutSessionMatchesFilters(
  session: SessionEntry,
  query: string,
  harnessFilter: Set<string>,
): boolean {
  const harness = formatLabel(session.harness) ?? "scout";
  if (harnessFilter.size > 0 && !harnessFilter.has(harness)) return false;
  if (!query) return true;
  const hay = [
    session.id,
    session.kind,
    session.title,
    session.agentName,
    session.harness,
    session.harnessSessionId,
    session.currentBranch,
    session.preview,
    session.workspaceRoot,
  ].filter(Boolean).join(" ").toLowerCase();
  return hay.includes(query);
}

export function workflowMatchesFilters(
  row: ProjectWorkflowRow,
  query: string,
  harnessFilter: Set<string>,
): boolean {
  if (harnessFilter.size > 0 && !harnessFilter.has(row.source)) return false;
  if (!query) return true;
  const hay = [
    row.label,
    row.source,
    row.status,
    row.description,
    row.project.title,
    row.project.root,
  ].filter(Boolean).join(" ").toLowerCase();
  return hay.includes(query);
}

export function resolveSelectedAgent(agents: Agent[], selectedAgentId?: string): Agent | null {
  if (!selectedAgentId) return null;

  const normalized = selectedAgentId.trim().replace(/^@+/, "");
  if (!normalized) return null;

  const exact = agents.find((a) => a.id === normalized);
  if (exact) return exact;

  const segments = normalized.split(".").filter(Boolean);
  if (segments.length >= 3) return null;

  const candidates = agents.filter((agent) =>
    agent.handle === normalized ||
    agent.selector === `@${normalized}` ||
    agent.defaultSelector === `@${normalized}` ||
    agent.id.startsWith(`${normalized}.`)
  );
  const uniqueCandidates = Array.from(
    new Map(candidates.map((agent) => [agent.id, agent])).values(),
  );

  return uniqueCandidates.length === 1 ? uniqueCandidates[0]! : null;
}

export function pathLeaf(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function projectIdentityForAgent(agent: Agent): ProjectIdentity {
  const root = normalizeProjectRoot(agent.projectRoot ?? agent.cwd);
  const title = agent.project ?? basename(root);
  return projectIdentityForRooted(title, root);
}

export function treeDotColor(state: string | null): string {
  switch (normalizeAgentState(state)) {
    case "in_turn":
    case "in_flight":
      return "var(--accent)";
    case "callable":
      return "color-mix(in srgb, var(--accent) 52%, var(--dim))";
    default:
      return "var(--dim)";
  }
}
