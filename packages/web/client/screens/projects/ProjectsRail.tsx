import { memo, useCallback, useMemo, useState } from "react";
import { Archive, ChevronDown, ChevronRight, Folder, FolderPlus, Pin, Search, X } from "lucide-react";
import type { Route } from "../../lib/types.ts";
import { timeAgo } from "../../lib/time.ts";
import { pathLeaf } from "../agents/model.ts";
import { AddProjectForm } from "./AddProjectForm.tsx";
import { shortHomePath } from "./project-overview-helpers.ts";
import { useProjectsInbox } from "./useProjectsInbox.ts";
import {
  isDormantProject,
  isSessionSelected,
  sessionOpenRoute,
  sessionRouteRef,
  sessionsForProject,
  type InboxProject,
  type InboxSession,
} from "./projects-inbox-model.ts";
import "./projects-inbox.css";

type Navigate = (route: Route) => void;
type ProjectSort = "recent" | "name" | "sessions";

const PROJECT_SESSION_PREVIEW_LIMIT = 4;
const PINNED_SESSIONS_STORAGE_KEY = "openscout.projects.pinnedSessions";
const ARCHIVED_SESSIONS_STORAGE_KEY = "openscout.projects.archivedSessions";

type RailProjectGroup = {
  project: InboxProject;
  sessions: InboxSession[];
  lastActivityAt: number;
};

type SessionPreviewPosition = {
  left: number;
  top: number;
};

function projectState(project: InboxProject): "needs" | "working" | "idle" {
  if (project.needs > 0) return "needs";
  if (project.working > 0 || project.liveSessionCount > 0) return "working";
  return "idle";
}

function RailLoadingRows({ rows = 6 }: { rows?: number }) {
  return (
    <div className="pi-railLoading" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <div className="pi-projectGroup pi-projectGroup--loading" key={index}>
          <div className="pi-projectGroupHead">
            <span className="pi-projectPath">
              <Folder size={13} strokeWidth={1.6} aria-hidden />
              <span className="pi-loadingLine pi-loadingLine--railProject" />
            </span>
          </div>
          <div className="pi-projectSessionList">
            <span className="pi-loadingLine pi-loadingLine--railSession" />
            <span className="pi-loadingLine pi-loadingLine--railSession" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function ProjectsRail({
  route,
  navigate,
  zeroPreview = false,
}: {
  route: Extract<Route, { view: "agents-v2" }>;
  navigate: Navigate;
  zeroPreview?: boolean;
}) {
  const { model, nowMs, loading, error } = useProjectsInbox(route);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ProjectSort>("recent");
  const [showDormant, setShowDormant] = useState(false);
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set());
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set());
  const [pinnedSessions, setPinnedSessions] = useState<Set<string>>(() => readPinnedSessions());
  const [archivedSessions, setArchivedSessions] = useState<Set<string>>(() => readArchivedSessions());
  const [addingProject, setAddingProject] = useState(false);

  const machineId = route.machineId;
  const showEphemeral = route.showEphemeral;
  const initialLoading = loading && model.projects.length === 0 && model.sessions.length === 0;

  const projectSessions = useMemo(
    () => zeroPreview ? [] : model.sessions.filter((session) => !archivedSessions.has(sessionKey(session))),
    [model.sessions, archivedSessions, zeroPreview],
  );
  const projectGroups = useMemo(
    () => zeroPreview ? [] : buildProjectGroups(model.projects, projectSessions),
    [model.projects, projectSessions, zeroPreview],
  );
  const visibleGroups = useMemo(
    () => filterAndSortProjectGroups(projectGroups, query, sort),
    [projectGroups, query, sort],
  );
  const queryActive = query.trim().length > 0;
  const activeGroups = queryActive
    ? visibleGroups
    : visibleGroups.filter((group) => !isDormantProject(group.project, nowMs));
  const dormantGroups = queryActive
    ? []
    : visibleGroups.filter((group) => isDormantProject(group.project, nowMs));
  const visiblePinnedSessions = useMemo(
    () =>
      zeroPreview
        ? []
        : sortSessionsForRail(
            projectSessions.filter((session) =>
              pinnedSessions.has(sessionKey(session)) && sessionMatchesQuery(session, query)
            ),
          ),
    [projectSessions, pinnedSessions, query, zeroPreview],
  );

  const openProject = useCallback((slug: string) => {
    setCollapsedProjects((current) => withoutValue(current, slug));
    navigate({
      view: "agents-v2",
      projectSlug: slug,
      ...(machineId ? { machineId } : {}),
      ...(showEphemeral ? { showEphemeral: true } : {}),
    });
  }, [machineId, navigate, showEphemeral]);

  const openSession = useCallback((session: InboxSession) => {
    setCollapsedProjects((current) => withoutValue(current, session.projectSlug));
    navigate(sessionOpenRoute(session, {
      view: "agents-v2",
      projectSlug: session.projectSlug,
      indexView: "sessions",
      ...(machineId ? { machineId } : {}),
      ...(showEphemeral ? { showEphemeral: true } : {}),
    }));
  }, [machineId, navigate, showEphemeral]);

  const togglePinnedSession = useCallback((session: InboxSession) => {
    const key = sessionKey(session);
    setPinnedSessions((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      writePinnedSessions(next);
      return next;
    });
  }, []);

  const archiveSession = useCallback((session: InboxSession) => {
    const key = sessionKey(session);
    setArchivedSessions((current) => {
      if (current.has(key)) return current;
      const next = new Set(current);
      next.add(key);
      writeArchivedSessions(next);
      return next;
    });
    setPinnedSessions((current) => {
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      writePinnedSessions(next);
      return next;
    });
    if (isSessionSelected(session, route)) {
      navigate({
        view: "agents-v2",
        projectSlug: session.projectSlug,
        indexView: "sessions",
        ...(machineId ? { machineId } : {}),
        ...(showEphemeral ? { showEphemeral: true } : {}),
      });
    }
  }, [machineId, navigate, route, showEphemeral]);

  return (
    <nav className="s-pi s-pi-rail" aria-label="Projects" aria-busy={loading || undefined} data-loading={loading || undefined}>
      <div className="pi-railFind" role="search">
        <Search size={13} strokeWidth={1.8} aria-hidden />
        <input
          className="pi-railFindInput"
          type="search"
          value={query}
          placeholder="Find project or session"
          aria-label="Find project or session"
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
        {query ? (
          <button type="button" className="pi-railFindClear" aria-label="Clear" onClick={() => setQuery("")}>
            <X size={12} strokeWidth={2} aria-hidden />
          </button>
        ) : null}
      </div>

      <div className="pi-railBody">
        <div className="pi-railGroup pi-railGroup--projects">
          <div className="pi-railProjectTools">
            <div className="pi-railLabel">Projects</div>
            <label className="pi-railSortWrap" title="Sort projects">
              <span className="pi-srOnly">Sort projects</span>
              <select
                className="pi-railSort"
                value={sort}
                aria-label="Sort projects"
                onChange={(event) => setSort(event.currentTarget.value as ProjectSort)}
              >
                <option value="recent">Recent</option>
                <option value="name">Name</option>
                <option value="sessions">Sessions</option>
              </select>
              <ChevronDown size={12} strokeWidth={2} aria-hidden />
            </label>
            <button
              type="button"
              className="pi-railAddBtn"
              aria-expanded={addingProject}
              aria-label="Add project"
              title="Add a project by path"
              onClick={() => setAddingProject((open) => !open)}
            >
              <FolderPlus size={13} strokeWidth={1.8} aria-hidden />
            </button>
          </div>

          {addingProject ? <AddProjectForm onClose={() => setAddingProject(false)} /> : null}

          {initialLoading ? (
            <RailLoadingRows />
          ) : error && visibleGroups.length === 0 ? (
            <div className="pi-railEmpty">Projects unavailable.</div>
          ) : (
            <>
              {visiblePinnedSessions.length > 0 ? (
                <div className="pi-pinnedSessions">
                  <div className="pi-pinnedLabel">Pinned</div>
                  <div className="pi-projectSessionList">
                    {visiblePinnedSessions.map((session) => (
                      <ProjectSessionRailRow
                        key={`pinned:${session.id}`}
                        session={session}
                        pinned
                        selected={isSessionSelected(session, route)}
                        showProject
                        nowMs={nowMs}
                        onOpenSession={openSession}
                        onTogglePinnedSession={togglePinnedSession}
                        onArchiveSession={archiveSession}
                      />
                    ))}
                  </div>
                </div>
              ) : null}

              {activeGroups.map((group) => (
                <ProjectRailGroup
                  key={group.project.slug}
                  group={group}
                  selected={route.projectSlug === group.project.slug}
                  collapsed={collapsedProjects.has(group.project.slug)}
                  expanded={expandedProjects.has(group.project.slug)}
                  pinnedSessions={pinnedSessions}
                  nowMs={nowMs}
                  route={route}
                  onOpenProject={openProject}
                  onOpenSession={openSession}
                  onToggleCollapsed={() => setCollapsedProjects((current) => toggled(current, group.project.slug))}
                  onToggleExpanded={() => setExpandedProjects((current) => toggled(current, group.project.slug))}
                  onTogglePinnedSession={togglePinnedSession}
                  onArchiveSession={archiveSession}
                />
              ))}

              {activeGroups.length === 0 && dormantGroups.length === 0 ? (
                <div className="pi-railEmpty">{query ? "No projects matched." : "No projects yet."}</div>
              ) : null}

              {dormantGroups.length > 0 ? (
                <>
                  <button
                    type="button"
                    className="pi-railDisclosure"
                    data-open={showDormant || undefined}
                    onClick={() => setShowDormant((open) => !open)}
                  >
                    <ChevronRight className="pi-railChev" size={12} strokeWidth={2} aria-hidden />
                    All projects · {dormantGroups.length} quiet
                  </button>
                  {showDormant
                    ? dormantGroups.map((group) => (
                        <ProjectRailGroup
                          key={group.project.slug}
                          group={group}
                          selected={route.projectSlug === group.project.slug}
                          collapsed={collapsedProjects.has(group.project.slug)}
                          expanded={expandedProjects.has(group.project.slug)}
                          pinnedSessions={pinnedSessions}
                          nowMs={nowMs}
                          route={route}
                          onOpenProject={openProject}
                          onOpenSession={openSession}
                          onToggleCollapsed={() => setCollapsedProjects((current) => toggled(current, group.project.slug))}
                          onToggleExpanded={() => setExpandedProjects((current) => toggled(current, group.project.slug))}
                          onTogglePinnedSession={togglePinnedSession}
                          onArchiveSession={archiveSession}
                        />
                      ))
                    : null}
                </>
              ) : null}
            </>
          )}
        </div>
      </div>

      <div className="pi-railFoot">
        <button type="button" className="pi-railFootBtn" onClick={() => navigate({ view: "search" })}>
          <Search size={13} strokeWidth={1.8} aria-hidden />
          Search agents &amp; sessions
        </button>
      </div>
    </nav>
  );
}

function ProjectRailGroup({
  group,
  selected,
  collapsed,
  expanded,
  pinnedSessions,
  nowMs,
  route,
  onOpenProject,
  onOpenSession,
  onToggleCollapsed,
  onToggleExpanded,
  onTogglePinnedSession,
  onArchiveSession,
}: {
  group: RailProjectGroup;
  selected: boolean;
  collapsed: boolean;
  expanded: boolean;
  pinnedSessions: Set<string>;
  nowMs: number;
  route: Extract<Route, { view: "agents-v2" }>;
  onOpenProject: (slug: string) => void;
  onOpenSession: (session: InboxSession) => void;
  onToggleCollapsed: () => void;
  onToggleExpanded: () => void;
  onTogglePinnedSession: (session: InboxSession) => void;
  onArchiveSession: (session: InboxSession) => void;
}) {
  const { project, sessions } = group;
  const orderedSessions = sortSessionsForRail(
    sessions.filter((session) => !pinnedSessions.has(sessionKey(session))),
  );
  const visibleSessions = collapsed
    ? []
    : expanded
      ? orderedSessions
      : orderedSessions.slice(0, PROJECT_SESSION_PREVIEW_LIMIT);
  const hiddenCount = Math.max(0, orderedSessions.length - visibleSessions.length);

  return (
    <div className="pi-projectGroup" data-selected={selected || undefined} data-state={projectState(project)} data-collapsed={collapsed || undefined}>
      <div className="pi-projectGroupHead">
        <button
          type="button"
          className="pi-projectPath"
          aria-expanded={selected ? !collapsed : undefined}
          title={projectTitle(project)}
          aria-current={selected ? "page" : undefined}
          aria-label={
            selected
              ? collapsed
                ? `Expand /${project.title}`
                : `Collapse /${project.title}`
              : `Open /${project.title}`
          }
          onClick={() => {
            if (selected) onToggleCollapsed();
            else onOpenProject(project.slug);
          }}
        >
          <Folder size={13} strokeWidth={1.6} aria-hidden />
          <span className="pi-projectPathText">/{project.title}</span>
        </button>
        <button
          type="button"
          className="pi-projectPathToggle"
          aria-expanded={!collapsed}
          aria-label={collapsed ? `Expand /${project.title}` : `Collapse /${project.title}`}
          onClick={onToggleCollapsed}
        >
          {collapsed ? <ChevronRight size={12} strokeWidth={2} /> : <ChevronDown size={12} strokeWidth={2} />}
        </button>
      </div>

      {!collapsed && visibleSessions.length > 0 ? (
        <div className="pi-projectSessionList">
          {visibleSessions.map((session) => (
            <ProjectSessionRailRow
              key={session.id}
              session={session}
              pinned={pinnedSessions.has(sessionKey(session))}
              selected={isSessionSelected(session, route)}
              showProject={false}
              nowMs={nowMs}
              onOpenSession={onOpenSession}
              onTogglePinnedSession={onTogglePinnedSession}
              onArchiveSession={onArchiveSession}
            />
          ))}
        </div>
      ) : !collapsed && sessions.length === 0 ? (
        <div className="pi-projectSessionEmpty">No sessions yet</div>
      ) : null}

      {!collapsed && hiddenCount > 0 ? (
        <button type="button" className="pi-projectShowMore" onClick={onToggleExpanded}>
          Show more
        </button>
      ) : !collapsed && expanded && orderedSessions.length > PROJECT_SESSION_PREVIEW_LIMIT ? (
        <button type="button" className="pi-projectShowMore" onClick={onToggleExpanded}>
          Show less
        </button>
      ) : null}
    </div>
  );
}

type ProjectSessionRailRowProps = {
  session: InboxSession;
  pinned: boolean;
  selected: boolean;
  showProject: boolean;
  nowMs: number;
  onOpenSession: (session: InboxSession) => void;
  onTogglePinnedSession: (session: InboxSession) => void;
  onArchiveSession: (session: InboxSession) => void;
};

function railRowPropsEqual(prev: ProjectSessionRailRowProps, next: ProjectSessionRailRowProps): boolean {
  return (
    prev.session === next.session
    && prev.pinned === next.pinned
    && prev.selected === next.selected
    && prev.showProject === next.showProject
    && prev.nowMs === next.nowMs
    && prev.onOpenSession === next.onOpenSession
    && prev.onTogglePinnedSession === next.onTogglePinnedSession
    && prev.onArchiveSession === next.onArchiveSession
  );
}

function previewPositionFor(node: HTMLElement): SessionPreviewPosition {
  const rect = node.getBoundingClientRect();
  const width = 304;
  const height = 174;
  return {
    left: Math.min(window.innerWidth - width - 12, rect.right + 10),
    top: Math.max(12, Math.min(window.innerHeight - height - 12, rect.top - 18)),
  };
}

const ProjectSessionRailRow = memo(function ProjectSessionRailRow({
  session,
  pinned,
  selected,
  showProject,
  nowMs,
  onOpenSession,
  onTogglePinnedSession,
  onArchiveSession,
}: ProjectSessionRailRowProps) {
  const [preview, setPreview] = useState<SessionPreviewPosition | null>(null);
  const title = sessionTitle(session);

  return (
    <>
      <div
        className="pi-projectSession"
        data-active={session.working || undefined}
        data-pinned={pinned || undefined}
        data-selected={selected || undefined}
        onMouseEnter={(event) => setPreview(previewPositionFor(event.currentTarget))}
        onMouseLeave={() => setPreview(null)}
        onFocusCapture={(event) => setPreview(previewPositionFor(event.currentTarget))}
        onBlurCapture={() => setPreview(null)}
      >
        <button
          type="button"
          className="pi-projectSessionMain"
          aria-label={showProject ? `${title} /${session.projectTitle}` : title}
          onClick={() => {
            setPreview(null);
            onOpenSession(session);
          }}
        >
          <span className="pi-projectSessionTitle">{title}</span>
          {showProject ? <span className="pi-projectSessionProject">/{session.projectTitle}</span> : null}
        </button>
        <button
          type="button"
          className="pi-sessionPin"
          data-pinned={pinned || undefined}
          aria-pressed={pinned}
          aria-label={pinned ? "Unpin session" : "Pin session"}
          title={pinned ? "Unpin session" : "Pin session"}
          onClick={() => onTogglePinnedSession(session)}
        >
          <Pin size={11} strokeWidth={2} aria-hidden />
        </button>
        <button
          type="button"
          className="pi-sessionArchive"
          aria-label="Archive session"
          title="Archive session"
          onClick={() => onArchiveSession(session)}
        >
          <Archive size={11} strokeWidth={2} aria-hidden />
        </button>
        <span className="pi-projectSessionWhen">{session.lastActivityAt ? timeAgo(session.lastActivityAt, nowMs) : "-"}</span>
      </div>
      {preview ? <ProjectSessionHoverCard session={session} left={preview.left} top={preview.top} nowMs={nowMs} /> : null}
    </>
  );
}, railRowPropsEqual);

function ProjectSessionHoverCard({
  session,
  left,
  top,
  nowMs,
}: {
  session: InboxSession;
  left: number;
  top: number;
  nowMs: number;
}) {
  const agent = session.agentName || null;
  const workspace = session.projectRoot ? shortHomePath(session.projectRoot) : `/${session.projectTitle}`;
  const ref = sessionRouteRef(session);

  return (
    <div className="pi-sessionHoverCard" role="tooltip" style={{ left, top }}>
      <div className="pi-sessionHoverKicker">
        <span>/{session.projectTitle}</span>
        <span>{session.lastActivityAt ? timeAgo(session.lastActivityAt, nowMs) : "-"}</span>
      </div>
      <div className="pi-sessionHoverTitle">{sessionTitle(session)}</div>
      <div className="pi-sessionHoverContext">
        {session.working ? "Live now" : "Last touched"} in {workspace}
      </div>
      <div className="pi-sessionHoverFacts">
        <span>{session.harness}</span>
        <span>{session.working ? "active" : "recent"}</span>
        {session.branch ? <span>{session.branch}</span> : null}
        {agent ? <span>{agent}</span> : null}
      </div>
      <div className="pi-sessionHoverRef">{ref ?? "No session archive yet"}</div>
    </div>
  );
}

function buildProjectGroups(projects: InboxProject[], sessions: InboxSession[]): RailProjectGroup[] {
  return projects.map((project) => {
    const projectSessions = sessionsForProject(sessions, project.slug);
    return {
      project,
      sessions: sortSessionsForRail(projectSessions),
      lastActivityAt: projectSessions[0]?.lastActivityAt ?? project.lastActivityAt,
    };
  });
}

function filterAndSortProjectGroups(groups: RailProjectGroup[], query: string, sort: ProjectSort): RailProjectGroup[] {
  const needle = query.trim().toLowerCase();
  const filtered = needle
    ? groups.filter((group) =>
        group.project.title.toLowerCase().includes(needle)
        || group.project.slug.toLowerCase().includes(needle)
        || group.sessions.some((session) => sessionMatchesQuery(session, needle))
      )
    : groups;
  return [...filtered].sort((a, b) => {
    switch (sort) {
      case "name":
        return a.project.title.localeCompare(b.project.title);
      case "sessions":
        return b.project.sessionCount - a.project.sessionCount
          || b.lastActivityAt - a.lastActivityAt
          || a.project.title.localeCompare(b.project.title);
      case "recent":
      default:
        return b.project.liveSessionCount - a.project.liveSessionCount
          || b.lastActivityAt - a.lastActivityAt
          || b.project.sessionCount - a.project.sessionCount
          || a.project.title.localeCompare(b.project.title);
    }
  });
}

function sortSessionsForRail(sessions: InboxSession[]): InboxSession[] {
  return [...sessions].sort(
    (a, b) =>
      Number(b.working) - Number(a.working)
      || sessionAddressability(b) - sessionAddressability(a)
      || b.lastActivityAt - a.lastActivityAt
      || sessionTitle(a).localeCompare(sessionTitle(b)),
  );
}

function sessionAddressability(session: InboxSession): number {
  if (sessionRouteRef(session)) return 2;
  if (session.agentId) return 1;
  return 0;
}

function sessionMatchesQuery(session: InboxSession, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return session.projectTitle.toLowerCase().includes(needle)
    || session.projectSlug.toLowerCase().includes(needle)
    || sessionTitle(session).toLowerCase().includes(needle)
    || session.agentName.toLowerCase().includes(needle)
    || session.harness.toLowerCase().includes(needle)
    || (session.branch?.toLowerCase().includes(needle) ?? false);
}

function sessionKey(session: InboxSession): string {
  return sessionRouteRef(session) ?? session.id;
}

function sessionTitle(session: InboxSession): string {
  const raw = session.work || session.sessionId || session.id;
  const leaf = raw.includes("/") ? pathLeaf(raw) : raw;
  return compactSessionLabel(leaf, session.harness);
}

function compactSessionLabel(raw: string, harness: string): string {
  const stem = raw.replace(/\.jsonl$/iu, "");
  const rollout = stem.match(/^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})/u);
  if (rollout) return `${sentenceCase(harness)} rollout ${rollout[4]}:${rollout[5]}`;
  const uuid = stem.match(/^([0-9a-f]{8})-[0-9a-f-]{27,}$/iu);
  if (uuid) return `${sentenceCase(harness)} session ${uuid[1]}`;
  return stem.length > 42 ? `${stem.slice(0, 39).trim()}...` : stem;
}

function projectTitle(project: InboxProject): string {
  return `/${project.title}`;
}

function sentenceCase(value: string): string {
  const clean = value.trim();
  if (!clean) return "Session";
  return clean.charAt(0).toUpperCase() + clean.slice(1).toLowerCase();
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function toggled(values: Set<string>, value: string): Set<string> {
  const next = new Set(values);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function withoutValue(values: Set<string>, value: string): Set<string> {
  if (!values.has(value)) return values;
  const next = new Set(values);
  next.delete(value);
  return next;
}

function readPinnedSessions(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(PINNED_SESSIONS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : []);
  } catch {
    return new Set();
  }
}

function writePinnedSessions(sessions: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PINNED_SESSIONS_STORAGE_KEY, JSON.stringify([...sessions]));
  } catch {
    // Best-effort UI preference.
  }
}

function readArchivedSessions(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(ARCHIVED_SESSIONS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : []);
  } catch {
    return new Set();
  }
}

function writeArchivedSessions(sessions: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ARCHIVED_SESSIONS_STORAGE_KEY, JSON.stringify([...sessions]));
  } catch {
    // Best-effort UI preference.
  }
}
