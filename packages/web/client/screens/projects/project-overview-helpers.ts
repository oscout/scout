import type { RepoWatchProject, RepoWatchSnapshot, RepoWatchWorktree } from "../../scout/repo-watch/types.ts";
import type { ProjectStateFilter, LocalAgentConfigState } from "../../lib/types.ts";
import type { ProjectSessionEntry, RegistryAgentEntry } from "./model.ts";
import {
  agentPrecedence,
  displayProjectSessionPreview,
  projectSessionLastAt,
  registryWorkLine,
} from "./model.ts";

export type ProjectOverviewPayload = {
  root: string;
  title: string;
  artifacts: Array<{
    relativePath: string;
    absolutePath: string;
    kind: "instructions" | "docs" | "config" | "package";
    exists: boolean;
    excerpt: string | null;
  }>;
  package: {
    name: string | null;
    version: string | null;
    description: string | null;
  } | null;
  projectConfigPath: string | null;
  projectConfigExists: boolean;
};

function normalizeRoot(path: string): string {
  return path.replace(/\/+$/, "").replace(/^\/Users\/[^/]+/, "~");
}

function rootsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return normalizeRoot(a) === normalizeRoot(b) || a === b;
}

export function repoProjectForRoot(
  snapshot: RepoWatchSnapshot | null,
  projectRoot: string | null,
): RepoWatchProject | null {
  if (!snapshot || !projectRoot) return null;
  for (const project of snapshot.projects) {
    if (rootsMatch(project.root, projectRoot)) return project;
    if (project.worktrees.some((wt) => rootsMatch(wt.path, projectRoot))) return project;
  }
  return null;
}

export function primaryWorktree(project: RepoWatchProject | null): RepoWatchWorktree | null {
  if (!project?.worktrees.length) return null;
  return project.worktrees.find((wt) => wt.branch.isMain) ?? project.worktrees[0] ?? null;
}

export function worktreeLine(wt: RepoWatchWorktree): string {
  const branch = wt.branch.name ?? wt.name;
  const dirty = wt.status.clean
    ? "clean"
    : `${wt.status.changedFiles} changed`;
  const delta =
    wt.branch.ahead > 0 || wt.branch.behind > 0
      ? `${wt.branch.ahead}↑ ${wt.branch.behind}↓`
      : "synced";
  return `${branch} · ${dirty} · ${delta}`;
}

export function shortHomePath(path: string | null | undefined): string {
  if (!path) return "—";
  return path.replace(/^\/Users\/[^/]+/, "~");
}

export type AgentOverviewRow = {
  agentId: string;
  handle: string;
  entry: RegistryAgentEntry;
  projectRoot: string | null;
  config: LocalAgentConfigState | null;
  tone: ProjectStateFilter | "idle";
  workLine: string;
  sessions: ProjectSessionEntry[];
};

function agentNodeIds(entry: RegistryAgentEntry): Set<string> {
  return new Set(entry.group.nodes.map((node) => node.row.agent.id));
}

export function agentOverviewRows(
  entries: RegistryAgentEntry[],
  configs: Map<string, LocalAgentConfigState | null>,
  projectSessions: ProjectSessionEntry[],
  nowMs: number,
): AgentOverviewRow[] {
  return entries.map((entry) => {
    const ids = agentNodeIds(entry);
    const sessions = projectSessions
      .filter((row) => row.mappedAgent && ids.has(row.mappedAgent.agentId))
      .sort((a, b) => projectSessionLastAt(b) - projectSessionLastAt(a));
    const tone = agentPrecedence(entry, nowMs);
    return {
      agentId: entry.leadAgent.id,
      handle: entry.leadAgent.handle?.trim() || entry.group.name,
      entry,
      projectRoot: entry.projectRoot,
      config: configs.get(entry.leadAgent.id) ?? null,
      tone,
      workLine: registryWorkLine(entry, tone),
      sessions,
    };
  });
}

export function defaultAgentOverviewRow(rows: AgentOverviewRow[]): AgentOverviewRow | null {
  return (
    rows.find((row) => row.tone === "needs")
    ?? rows.find((row) => row.tone === "live")
    ?? rows[0]
    ?? null
  );
}

export function sessionLinesForRow(row: AgentOverviewRow, limit = 4): Array<{
  id: string;
  preview: string;
  when: number | null;
}> {
  return row.sessions.slice(0, limit).map((entry) => ({
    id: entry.session.refId,
    preview: displayProjectSessionPreview(entry),
    when: projectSessionLastAt(entry) || null,
  }));
}

export function permissionLabel(profile: LocalAgentConfigState["permissionProfile"]): string {
  if (typeof profile === "string" && profile) return profile;
  return "—";
}
