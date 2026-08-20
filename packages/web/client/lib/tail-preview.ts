import { compareTimestampsDesc } from "./time.ts";
import type { Agent, SessionEntry, TailEvent } from "./types.ts";

export const LIVE_TAIL_PREVIEW_LIMIT = 20;

export type TailPreviewContext = {
  sessionIds: string[];
  paths: string[];
  projects: string[];
  query: string;
};

function pathLeaf(path: string | null | undefined): string | null {
  if (!path) return null;
  const normalized = path.replace(/[\\/]+$/, "");
  if (!normalized) return null;
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? normalized;
}

export function compactSessionId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.length > 18 ? `${trimmed.slice(0, 8)}...${trimmed.slice(-6)}` : trimmed;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function isSameOrNestedPath(candidate: string | null | undefined, root: string): boolean {
  const normalizedCandidate = candidate?.trim().replace(/[\\/]+$/, "");
  const normalizedRoot = root.trim().replace(/[\\/]+$/, "");
  if (!normalizedCandidate || !normalizedRoot) return false;
  if (normalizedCandidate === normalizedRoot) return true;
  if (normalizedRoot.startsWith("~/")) {
    const homeRelativeRoot = normalizedRoot.slice(1);
    if (
      normalizedCandidate.endsWith(homeRelativeRoot) ||
      normalizedCandidate.includes(`${homeRelativeRoot}/`)
    ) {
      return true;
    }
  }
  if (normalizedCandidate.startsWith("~/")) {
    const homeRelativeCandidate = normalizedCandidate.slice(1);
    if (
      normalizedRoot.endsWith(homeRelativeCandidate) ||
      normalizedRoot.includes(`${homeRelativeCandidate}/`)
    ) {
      return true;
    }
  }
  return (
    normalizedCandidate.startsWith(`${normalizedRoot}/`) ||
    normalizedRoot.startsWith(`${normalizedCandidate}/`)
  );
}

function includesTerm(value: string | null | undefined, term: string): boolean {
  const normalizedValue = value?.trim().toLowerCase();
  const normalizedTerm = term.trim().toLowerCase();
  if (!normalizedValue || !normalizedTerm) return false;
  return normalizedValue.includes(normalizedTerm) || normalizedTerm.includes(normalizedValue);
}

function matchesProject(value: string | null | undefined, project: string): boolean {
  const normalizedValue = value?.trim().toLowerCase();
  const normalizedProject = project.trim().toLowerCase();
  if (!normalizedValue || !normalizedProject) return false;
  return normalizedValue === normalizedProject;
}

export function buildTailPreviewContext(input: {
  activeSessionId: string | null;
  agent: Agent | null;
  sessionMeta: SessionEntry | null;
}): TailPreviewContext {
  const { activeSessionId, agent, sessionMeta } = input;
  const sessionIds = uniqueStrings([
    activeSessionId,
    agent?.harnessSessionId,
  ]);
  const paths = uniqueStrings([
    agent?.cwd,
    agent?.projectRoot,
    sessionMeta?.workspaceRoot,
  ]);
  const projects = uniqueStrings([
    agent?.project,
    pathLeaf(agent?.cwd),
    pathLeaf(agent?.projectRoot),
    pathLeaf(sessionMeta?.workspaceRoot),
  ]).filter((term) => term.length > 2);
  const query = uniqueStrings([
    ...sessionIds.slice(0, 2),
    ...projects.slice(0, 2),
  ]).join("|");
  return { sessionIds, paths, projects, query };
}

export function tailEventMatchesContext(event: TailEvent, context: TailPreviewContext): boolean {
  if (context.sessionIds.some((id) => includesTerm(event.sessionId, id))) return true;
  if (context.paths.some((root) => isSameOrNestedPath(event.cwd, root))) return true;
  if (context.projects.some((project) => matchesProject(event.project, project))) return true;
  return false;
}

export function buildTailRouteQuery(context: TailPreviewContext, events: TailEvent[]): string {
  const matchingEvents = events.filter((event) => tailEventMatchesContext(event, context));
  const sessionMatchedIds = uniqueStrings(
    matchingEvents
      .filter((event) => context.sessionIds.some((id) => includesTerm(event.sessionId, id)))
      .map((event) => event.sessionId),
  );
  if (sessionMatchedIds[0]) return sessionMatchedIds[0];

  const pathMatchedIds = uniqueStrings(
    matchingEvents
      .filter((event) => context.paths.some((root) => isSameOrNestedPath(event.cwd, root)))
      .map((event) => event.sessionId),
  );
  if (pathMatchedIds[0]) return pathMatchedIds[0];

  const projectMatchedIds = uniqueStrings(
    matchingEvents
      .filter((event) => context.projects.some((project) => matchesProject(event.project, project)))
      .map((event) => event.sessionId),
  );
  if (projectMatchedIds[0]) return projectMatchedIds[0];

  if (context.paths[0]) return context.paths[0];
  if (context.sessionIds[0]) return context.sessionIds[0];
  if (context.projects[0]) return context.projects[0];
  return context.query;
}

export function mergeTailPreviewEvents(previous: TailEvent[], incoming: TailEvent[]): TailEvent[] {
  const byId = new Map<string, TailEvent>();
  for (const event of [...incoming, ...previous]) {
    byId.set(event.id, event);
  }
  return [...byId.values()]
    .sort((left, right) => compareTimestampsDesc(left.ts, right.ts))
    .slice(0, LIVE_TAIL_PREVIEW_LIMIT);
}

export function tailKindLabel(kind: TailEvent["kind"]): string {
  switch (kind) {
    case "tool-result":
      return "tool result";
    default:
      return kind;
  }
}

export function tailSummary(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= 180) return normalized;
  return `${normalized.slice(0, 177)}...`;
}
