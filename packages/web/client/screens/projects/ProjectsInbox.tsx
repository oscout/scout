import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { ArrowRight, ArrowUpRight, ChevronRight, ExternalLink, Folder, FolderPlus, Search } from "lucide-react";
import { AgentAvatar } from "../../components/AgentAvatar.tsx";
import { HarnessMark } from "../../components/HarnessMark.tsx";
import { api } from "../../lib/api.ts";
import {
  fetchRepoWatchSnapshot,
  getCachedRepoWatchSnapshot,
  type RepoPullRequestItem,
} from "../../scout/repo-watch/api.ts";
import type { RepoWatchProject, RepoWatchSnapshot, RepoWatchWorktree } from "../../scout/repo-watch/types.ts";
import { agentLive, reviewChurnOf } from "../../scout/repo-watch/ui.ts";
import type { ScoutRepoDiffSnapshot } from "../../scout/repo-diff/types.ts";
import { formatClockTimestamp, normalizeTimestampMs, timeAgo } from "../../lib/time.ts";
import { fetchTerminalSessions } from "../../lib/terminal-sessions.ts";
import type { ObserveData, ObserveUsageMeta, Route } from "../../lib/types.ts";
import { useScout } from "../../scout/Provider.tsx";
import { openContent } from "../../scout/slots/openContent.ts";
import { pathLeaf } from "../agents/model.ts";
import { SessionRefScreen, type SessionRefLookup } from "../sessions/SessionRefScreen.tsx";
import { AddProjectForm } from "./AddProjectForm.tsx";
import { shortHomePath } from "./project-overview-helpers.ts";
import {
  nativeTerminalDeepLink,
  resolveProjectSessionTmuxTarget,
  type ProjectSessionTmuxTarget,
} from "./project-session-terminal.ts";
import { refreshProjectsInbox, useProjectsInbox } from "./useProjectsInbox.ts";
import { onVisible, useProjectRepositoryState } from "./useProjectRepositoryState.ts";
import {
  groupItems,
  isSessionSelected,
  isThreadSelected,
  sessionOpenRoute,
  sessionSelectRoute,
  sessionsForProject,
  threadOpenRoute,
  threadSelectRoute,
  type InboxProject,
  type InboxSession,
  type InboxThread,
  type ProjectsInboxModel,
  threadsForProject,
} from "./projects-inbox-model.ts";
import "./projects-inbox.css";

type Navigate = (route: Route) => void;
type ProjectHarness = "claude" | "codex";

type ProjectPickOption = {
  slug: string;
  title: string;
  root: string | null;
  agentCount: number;
  sessionCount: number;
  lastActivityAt: number;
};

type ThreadRowProps = {
  thread: InboxThread | InboxSession;
  crossProject: boolean;
  selected: boolean;
  cursor: boolean;
  nowMs: number;
  onSelect: () => void;
  onOpen: () => void;
  rowRef: (el: HTMLButtonElement | null) => void;
  workLabel?: string;
};

function threadRowPropsEqual(prev: ThreadRowProps, next: ThreadRowProps): boolean {
  // Handlers/refs are recreated by the parent list; skip re-render when the
  // row's rendered inputs are identity-stable (paired with model structural share).
  return (
    prev.thread === next.thread
    && prev.crossProject === next.crossProject
    && prev.selected === next.selected
    && prev.cursor === next.cursor
    && prev.nowMs === next.nowMs
    && prev.workLabel === next.workLabel
  );
}

export const ThreadRow = memo(function ThreadRow({
  thread,
  crossProject,
  selected,
  cursor,
  nowMs,
  onSelect,
  onOpen,
  rowRef,
  workLabel,
}: ThreadRowProps) {
  return (
    <button
      ref={rowRef}
      type="button"
      className="pi-row"
      data-state={thread.group}
      data-selected={selected || undefined}
      data-cursor={cursor || undefined}
      onClick={onSelect}
      onDoubleClick={onOpen}
    >
      <span className="pi-rowDot" aria-hidden />
      <span className="pi-rowBody">
        <span className="pi-rowWork" title={thread.work}>
          {workLabel ?? thread.work}
        </span>
        <span className="pi-rowAttr">
          <span className="pi-rowAvatar">
            <AgentAvatar
              agent={{
                name: thread.agentName,
                harness: thread.harness,
                state: thread.working ? "in_turn" : null,
              }}
              placement="row"
              size={22}
            />
          </span>
          <span className="pi-rowAgent" title={thread.agentName}>
            {thread.agentName}
          </span>
          <span className="pi-rowHmark" aria-hidden>
            <HarnessMark harness={thread.harness} size={11} />
          </span>
          {crossProject ? (
            <span className="pi-rowChip" title={`/${thread.projectTitle}`}>
              /{thread.projectTitle}
            </span>
          ) : thread.branch ? (
            <span className="pi-rowBranch" title={thread.branch}>
              {thread.branch}
            </span>
          ) : null}
        </span>
      </span>
      <span className="pi-rowVitals">
        {thread.working ? (
          <span className="pi-rowLiveTag">live</span>
        ) : null}
        <span className="pi-rowAgo">{thread.lastActivityAt ? timeAgo(thread.lastActivityAt, nowMs) : "—"}</span>
        {thread.contextPct != null ? <span className="pi-rowCtx">{thread.contextPct}%</span> : null}
      </span>
      <span className="pi-rowOpen" aria-hidden>
        <span>Open</span>
        <ChevronRight size={14} strokeWidth={1.8} />
      </span>
    </button>
  );
}, threadRowPropsEqual);

function ProjectSurfaceState({
  title,
  detail,
  tone = "muted",
}: {
  title: string;
  detail?: string;
  tone?: "loading" | "error" | "muted";
}) {
  return (
    <div className="pi-stateBlock" data-tone={tone} role={tone === "loading" ? "status" : "note"}>
      <span className="pi-statePulse" aria-hidden />
      <span className="pi-stateTitle">{title}</span>
      {detail ? <span className="pi-stateDetail">{detail}</span> : null}
    </div>
  );
}

function ProjectRowsSkeleton({ rows = 7 }: { rows?: number }) {
  return (
    <div className="pi-loadingRows" aria-hidden="true">
      <div className="pi-sectionHead pi-sectionHead--loading">
        <span className="pi-loadingLine pi-loadingLine--label" />
        <span className="pi-loadingLine pi-loadingLine--count" />
      </div>
      {Array.from({ length: rows }, (_, index) => (
        <div className="pi-row pi-row--loading" key={index}>
          <span className="pi-rowDot" />
          <span className="pi-rowBody">
            <span className="pi-loadingLine pi-loadingLine--title" />
            <span className="pi-loadingLine pi-loadingLine--meta" />
          </span>
          <span className="pi-rowVitals">
            <span className="pi-loadingLine pi-loadingLine--time" />
          </span>
        </div>
      ))}
    </div>
  );
}

type ProjectMode = "overview" | "agents" | "sessions";

function ProjectScopeHeader({
  route,
  navigate,
  slug,
  model,
  mode,
  repoProject,
}: {
  route: Extract<Route, { view: "agents-v2" }>;
  navigate: Navigate;
  slug: string;
  model: ProjectsInboxModel;
  mode: ProjectMode;
  repoProject: RepoWatchProject | null;
}) {
  const project = model.projects.find((entry) => entry.slug === slug) ?? null;
  const projectThreads = threadsForProject(model.threads, slug);
  const agentThreads = projectThreads.filter((thread) => thread.kind === "agent");
  const title = project?.title ?? slug;
  const root = project?.root ?? null;
  const showAgentFacet = (project?.agentCount ?? agentThreads.length) > 1;
  const machineScope = route.machineId ? { machineId: route.machineId } : {};
  const baseRoute = { view: "agents-v2" as const, projectSlug: slug, ...machineScope };
  const digest = digestLine(project?.needs ?? 0, project?.working ?? 0, projectThreads.length);

  const worktreeCount = repoProject?.worktrees.length ?? project?.worktreeCount ?? 0;

  return (
    <header className="pi-projectHead">
      <div className="pi-projectHeadTop">
        <div className="pi-projectIdent">
          <h1 className="pi-projectTitle">{title}</h1>
          <div className="pi-projectMeta">
            {root ? <span title={root}>{shortHomePath(root)}</span> : null}
            <span className="pi-projectDigest">{digest}</span>
          </div>
        </div>
      </div>

      <div className="pi-projectFacets" aria-label="Project sections">
        <button
          type="button"
          className="pi-projectFacet"
          data-selected={mode === "overview" || undefined}
          onClick={() => navigate(baseRoute)}
        >
          <span>Overview</span>
        </button>
        <button
          type="button"
          className="pi-projectFacet"
          data-selected={mode === "sessions" || undefined}
          onClick={() => navigate({ ...baseRoute, indexView: "sessions" })}
        >
          <span>Sessions</span>
          <b>{project?.sessionCount ?? 0}</b>
        </button>
        {showAgentFacet ? (
          <button
            type="button"
            className="pi-projectFacet"
            data-selected={mode === "agents" || undefined}
            onClick={() => navigate({ ...baseRoute, indexView: "agents" })}
          >
            <span>Agents</span>
            <b>{project?.agentCount ?? agentThreads.length}</b>
          </button>
        ) : null}
        <button
          type="button"
          className="pi-projectFacet"
          title="Open worktrees in Repos"
          onClick={() => navigate({ view: "repos", ...(root ? { root } : {}), ...machineScope })}
        >
          <span>Worktrees</span>
          <b>{worktreeCount}</b>
          <ArrowUpRight className="pi-projectFacetOut" size={11} strokeWidth={2} aria-hidden />
        </button>
        <button
          type="button"
          className="pi-projectFacet"
          disabled={!root}
          title={root ? "Open this project's AGENTS.md" : "No project root known"}
          onClick={() => navigate({ view: "code", project: slug, path: "AGENTS.md" })}
        >
          <span>Rules</span>
          <b>{root ? "set" : "—"}</b>
          <ArrowUpRight className="pi-projectFacetOut" size={11} strokeWidth={2} aria-hidden />
        </button>
      </div>
    </header>
  );
}

function digestLine(needs: number, working: number, total: number): ReactNode {
  if (total === 0) return <span>No conversations yet.</span>;
  const parts: ReactNode[] = [];
  if (working > 0) parts.push(<b key="w">{working} moving</b>);
  if (needs > 0) parts.push(<b key="n">{needs} needs you</b>);
  parts.push(<span key="t">{total} conversation{total === 1 ? "" : "s"}</span>);
  return parts.reduce<ReactNode[]>((result, node, index) => {
    if (index > 0) result.push(<span key={`sep${index}`}> · </span>);
    result.push(node);
    return result;
  }, []);
}

function shortSessionRef(value: string): string {
  if (value.length <= 18) return value;
  const uuid = value.match(/^([0-9a-f]{8})-[0-9a-f-]{27,}$/iu);
  if (uuid) return uuid[1]!;
  return `${value.slice(0, 10)}…${value.slice(-5)}`;
}

function projectCountLabel(model: ProjectsInboxModel, zeroPreview: boolean): string {
  const count = zeroPreview ? 0 : model.projects.length;
  return `${count} tracked`;
}

function ProjectZeroComposer({
  route,
  navigate,
  projects,
}: {
  route: Extract<Route, { view: "agents-v2" }>;
  navigate: Navigate;
  projects: InboxProject[];
}) {
  const { onboarding, refreshOnboarding, reload } = useScout();
  const currentDefaultHarness = defaultHarnessOf(onboarding?.defaultHarness);
  const [draft, setDraft] = useState("");
  const [selectedSlug, setSelectedSlug] = useState("");
  const [harness, setHarness] = useState<ProjectHarness>(currentDefaultHarness);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [createdRoot, setCreatedRoot] = useState<string | null>(null);

  useEffect(() => {
    setHarness(currentDefaultHarness);
  }, [currentDefaultHarness]);

  const options = useMemo(() => buildProjectPickOptions(projects), [projects]);
  const matches = useMemo(() => filterProjectPickOptions(options, draft), [draft, options]);
  const selectedOption = useMemo(
    () => options.find((option) => option.slug === selectedSlug) ?? exactProjectOption(options, draft),
    [draft, options, selectedSlug],
  );
  const trimmedDraft = draft.trim();
  const canCreateProject = isProjectPathLike(trimmedDraft) && !exactProjectOption(options, trimmedDraft);
  const activeOption = selectedOption ?? (!canCreateProject && trimmedDraft ? matches[0] ?? null : null);
  const primaryLabel = activeOption ? "Open project" : canCreateProject ? "Create project" : "Find project";
  const canSubmit = Boolean(activeOption || canCreateProject || trimmedDraft);

  useEffect(() => {
    if (!selectedSlug) return;
    if (!options.some((option) => option.slug === selectedSlug)) setSelectedSlug("");
  }, [options, selectedSlug]);

  useEffect(() => {
    if (!createdRoot) return;
    const created = options.find((option) => projectOptionMatchesRoot(option, createdRoot));
    if (!created) return;
    setCreatedRoot(null);
    navigate(projectRoute(route, created.slug));
  }, [createdRoot, navigate, options, route]);

  const chooseProject = (option: ProjectPickOption) => {
    setSelectedSlug(option.slug);
    setDraft(option.title);
    setError(null);
    setStatus(null);
  };

  const openProject = (option: ProjectPickOption) => {
    navigate(projectRoute(route, option.slug));
  };

  const createProject = async (projectRoot: string) => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await api("/api/onboarding/project", {
        method: "POST",
        body: JSON.stringify({
          contextRoot: projectRoot,
          sourceRoots: [projectRoot],
          defaultHarness: harness,
        }),
      });
      setCreatedRoot(projectRoot);
      setStatus("Project created. Refreshing inventory.");
      setSelectedSlug("");
      setDraft("");
      refreshProjectsInbox();
      await Promise.all([refreshOnboarding(), reload()]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create project.");
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    if (activeOption) {
      openProject(activeOption);
      return;
    }
    if (canCreateProject) {
      void createProject(trimmedDraft);
      return;
    }
    if (trimmedDraft) {
      setError("No project matches that search. Paste a repo path to create one.");
      return;
    }
    setError("Choose a project or paste a repo path.");
  };

  return (
    <div className="pi-zero">
      <div className="pi-zeroHead">
        <span className="pi-zeroKicker">
          <FolderPlus size={13} strokeWidth={1.9} aria-hidden />
          Projects
        </span>
        <h2>Pick a project to start.</h2>
      </div>

      <form className="pi-zeroComposer" onSubmit={submit}>
        <div className="pi-zeroBar">
          <label className="pi-zeroSelect">
            <Search size={13} strokeWidth={1.8} aria-hidden />
            <select
              value={selectedSlug}
              aria-label="Choose project"
              onChange={(event) => {
                const option = options.find((candidate) => candidate.slug === event.currentTarget.value);
                if (option) chooseProject(option);
                else setSelectedSlug("");
              }}
            >
              <option value="">Choose project</option>
              {options.slice(0, 80).map((option) => (
                <option key={option.slug} value={option.slug}>
                  {option.title}
                </option>
              ))}
            </select>
          </label>
          <div className="pi-zeroHarness" role="group" aria-label="Default harness">
            {(["claude", "codex"] as const).map((item) => (
              <button
                key={item}
                type="button"
                data-on={harness === item || undefined}
                onClick={() => setHarness(item)}
              >
                {item === "claude" ? "Claude" : "Codex"}
              </button>
            ))}
          </div>
        </div>

        <div className="pi-zeroInputRow">
          <textarea
            value={draft}
            rows={2}
            placeholder="Find project or paste /path/to/repo"
            aria-label="Find or create project"
            onChange={(event) => {
              setDraft(event.currentTarget.value);
              setSelectedSlug("");
              setError(null);
              setStatus(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <button type="submit" className="pi-zeroSend" disabled={busy || !canSubmit} title={primaryLabel}>
            <ArrowRight size={15} strokeWidth={2} aria-hidden />
            <span>{busy ? "Working" : primaryLabel}</span>
          </button>
        </div>

        {matches.length > 0 ? (
          <div className="pi-zeroMatches" aria-label="Matching projects">
            {matches.map((option) => (
              <button
                key={option.slug}
                type="button"
                className="pi-zeroMatch"
                data-selected={selectedOption?.slug === option.slug || undefined}
                onClick={() => chooseProject(option)}
                onDoubleClick={() => openProject(option)}
              >
                <span className="pi-zeroMatchMain">
                  <span className="pi-zeroMatchTitle">/{option.title}</span>
                  <span className="pi-zeroMatchRoot" title={option.root ?? undefined}>
                    {option.root ? shortHomePath(option.root) : option.slug}
                  </span>
                </span>
                <span className="pi-zeroMatchMeta">{projectOptionMeta(option)}</span>
              </button>
            ))}
          </div>
        ) : trimmedDraft ? (
          <div className="pi-zeroEmpty">No project matches.</div>
        ) : null}

        {error ? <div className="pi-zeroError">{error}</div> : null}
        {status ? <div className="pi-zeroStatus">{status}</div> : null}
      </form>
    </div>
  );
}

function defaultHarnessOf(value: string | null | undefined): ProjectHarness {
  return value === "codex" ? "codex" : "claude";
}

function projectRoute(
  route: Extract<Route, { view: "agents-v2" }>,
  projectSlug: string,
): Extract<Route, { view: "agents-v2" }> {
  return {
    view: "agents-v2",
    projectSlug,
    ...(route.showEphemeral ? { showEphemeral: true } : {}),
    ...(route.machineId ? { machineId: route.machineId } : {}),
  };
}

function buildProjectPickOptions(projects: InboxProject[]): ProjectPickOption[] {
  return projects
    .map((project) => ({
      slug: project.slug,
      title: project.title,
      root: project.root,
      agentCount: project.agentCount,
      sessionCount: project.sessionCount,
      lastActivityAt: project.lastActivityAt,
    }))
    .sort((left, right) =>
      right.lastActivityAt - left.lastActivityAt
      || right.agentCount - left.agentCount
      || right.sessionCount - left.sessionCount
      || left.title.localeCompare(right.title),
    );
}

function filterProjectPickOptions(options: ProjectPickOption[], draft: string): ProjectPickOption[] {
  const query = normalizeProjectQuery(draft);
  if (!query) return options.slice(0, 6);
  return options
    .map((option) => ({ option, score: projectPickScore(option, query) }))
    .filter((entry): entry is { option: ProjectPickOption; score: number } => entry.score !== null)
    .sort((left, right) =>
      left.score - right.score
      || right.option.lastActivityAt - left.option.lastActivityAt
      || left.option.title.localeCompare(right.option.title),
    )
    .slice(0, 6)
    .map((entry) => entry.option);
}

function exactProjectOption(options: ProjectPickOption[], draft: string): ProjectPickOption | null {
  const query = normalizeProjectQuery(draft);
  if (!query) return null;
  return options.find((option) => {
    const root = normalizeProjectQuery(option.root ?? "");
    const rootLeaf = normalizeProjectQuery(option.root ? pathLeaf(option.root) : "");
    return normalizeProjectQuery(option.title) === query
      || normalizeProjectQuery(option.slug) === query
      || root === query
      || rootLeaf === query
      || normalizeProjectQuery(option.root ? shortHomePath(option.root) : "") === query;
  }) ?? null;
}

function projectPickScore(option: ProjectPickOption, query: string): number | null {
  const title = normalizeProjectQuery(option.title);
  const slug = normalizeProjectQuery(option.slug);
  const root = normalizeProjectQuery(option.root ?? "");
  const rootLeaf = normalizeProjectQuery(option.root ? pathLeaf(option.root) : "");
  if (title === query || slug === query || root === query || rootLeaf === query) return 0;
  if (title.startsWith(query) || slug.startsWith(query) || rootLeaf.startsWith(query)) return 1;
  if (title.includes(query) || slug.includes(query) || rootLeaf.includes(query)) return 2;
  if (root.includes(query)) return 3;
  return null;
}

function normalizeProjectQuery(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^~(?=\/)/u, "")
    .replace(/\s+/g, " ");
}

function isProjectPathLike(value: string): boolean {
  const trimmed = value.trim();
  return /^(~\/|\/|\.{1,2}\/)/u.test(trimmed) || trimmed.includes("/");
}

function projectOptionMatchesRoot(option: ProjectPickOption, value: string): boolean {
  const query = normalizeProjectQuery(value);
  if (!query) return false;
  const candidates = [
    option.root ?? "",
    option.root ? shortHomePath(option.root) : "",
    option.root ? pathLeaf(option.root) : "",
    option.slug,
    option.title,
  ].map(normalizeProjectQuery);
  return candidates.some((candidate) => candidate === query || candidate.endsWith(query));
}

function projectOptionMeta(option: ProjectPickOption): string {
  const parts = [
    plural(option.agentCount, "agent"),
    plural(option.sessionCount, "session"),
    option.lastActivityAt ? timeAgo(option.lastActivityAt) : null,
  ];
  return parts.filter(Boolean).join(" · ");
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function findSelectedSession(sessions: InboxSession[], route: Extract<Route, { view: "agents-v2" }>): InboxSession | null {
  if (!route.sessionId) return null;
  return (
    sessions.find((session) =>
      session.sessionId === route.sessionId ||
      session.conversationId === route.sessionId ||
      session.id === route.sessionId
    ) ?? null
  );
}

function isSyntheticProcessSessionRef(value: string | null | undefined): boolean {
  return /^native:process:/iu.test(value ?? "");
}

function isPathLikeWork(value: string): boolean {
  return value.startsWith("/") || value.startsWith("~/") || (value.includes("/") && /\.(jsonl?|events)$/i.test(value));
}

function sessionHeadline(work: string | null | undefined, agentName: string, sessionRef: string): string {
  const raw = work?.trim() ?? "";
  if (!raw || isPathLikeWork(raw)) return agentName;
  return raw;
}

function ProjectSessionOverview({
  session,
  sessionRef,
  threads,
  lookup,
  route,
  navigate,
  nowMs,
}: {
  session: InboxSession | null;
  sessionRef: string;
  threads: InboxThread[];
  lookup: SessionRefLookup | null;
  route: Extract<Route, { view: "agents-v2" }>;
  navigate: Navigate;
  nowMs: number;
}) {
  const [terminalTarget, setTerminalTarget] = useState<ProjectSessionTmuxTarget | null>(null);
  const agentName = session?.agentName ?? route.selectedAgentId ?? route.agentId ?? "Session";
  const harness = session?.harness ?? "session";
  const data = lookup?.kind === "observe" ? lookup.observe.data : null;
  const sessionMeta = data?.metadata?.session;
  const fallbackLastAt = session?.lastActivityAt ?? lookup?.session?.lastMessageAt ?? null;
  // These scan O(events); keep them off the render path for the 30s nowMs tick.
  const [startMs, endMs, durationLabel] = useMemo(
    () => [observedStartMs(data), observedEndMs(data, fallbackLastAt), observedDuration(data, fallbackLastAt)] as const,
    [data, fallbackLastAt],
  );
  const branch = sessionMeta?.gitBranch ?? lookup?.session?.currentBranch ?? session?.branch ?? null;
  const model = sessionMeta?.model ?? null;
  const turnCount = sessionMeta?.turnCount ?? data?.metadata?.usage?.assistantMessages ?? (lookup?.kind === "conversation" ? lookup.session.messageCount : null);
  const lastLabel = endMs ? timeAgo(endMs, nowMs) : session?.lastActivityAt ? timeAgo(session.lastActivityAt, nowMs) : "—";
  const statusLabel = session?.working ? `live · last ${lastLabel}` : lastLabel !== "—" ? `last ${lastLabel}` : "trace resolving";
  const headline = sessionHeadline(session?.work, agentName, sessionRef);
  const refLabel = shortSessionRef(sessionRef);
  const lookupSession = lookup?.session ?? null;
  const terminalAgentId = lookup?.kind === "observe"
    ? lookup.observe.agentId ?? lookupSession?.agentId ?? session?.agentId
    : lookupSession?.agentId ?? session?.agentId;
  const terminalLookupRef = lookup?.kind === "observe" ? lookup.observe.sessionId : lookupSession?.harnessSessionId;
  const metaItems = [
    agentName,
    harness,
    model,
    branch,
    startMs ? `started ${formatClockTimestamp(startMs)}` : null,
    durationLabel,
    turnCount != null ? `turn ${compactNumber(turnCount)}` : null,
    refLabel,
  ].filter((item): item is string => Boolean(item) && item !== "—");

  useEffect(() => {
    let active = true;
    setTerminalTarget(null);
    if (!terminalAgentId && !terminalLookupRef && !sessionRef) return () => { active = false; };

    void fetchTerminalSessions({ includeDiscovered: true })
      .then((terminalSessions) => {
        if (!active) return;
        setTerminalTarget(resolveProjectSessionTmuxTarget(terminalSessions, {
          agentId: terminalAgentId,
          sessionRefs: [sessionRef, terminalLookupRef, session?.sessionId],
        }));
      })
      .catch(() => {
        if (active) setTerminalTarget(null);
      });

    return () => { active = false; };
  }, [session?.sessionId, sessionRef, terminalAgentId, terminalLookupRef]);

  const openWebTerminal = () => {
    if (!terminalTarget) return;
    openContent(navigate, {
      view: "terminal",
      terminalSessionId: terminalTarget.terminalSessionId,
      terminalSurfaceKey: terminalTarget.terminalSurfaceKey,
      mode: "takeover",
    }, { returnTo: route });
  };
  // Null when the surface handle will not parse. Better no link than one the
  // native handler drops on the floor.
  const nativeDeepLink = terminalTarget ? nativeTerminalDeepLink(terminalTarget, "takeover") : null;

  return (
    <section className="pi-sessionOverview" aria-label="Session overview">
      <section className="pi-sessionMasthead" data-state={session?.working ? "working" : "recent"}>
        <div className="pi-sessionMastTop">
          <span className="pi-sessionCrumb">Sessions ▸</span>
          <h2 className="pi-sessionHeadline" title={headline}>{headline}</h2>
          <span className="pi-sessionState">
            {session?.working ? <span className="pi-sessionLiveDot" aria-hidden /> : null}
            {statusLabel}
          </span>
        </div>
        <div className="pi-sessionMeta">
          {metaItems.map((item, index) => (
            <span key={`${item}:${index}`} title={index === metaItems.length - 1 ? sessionRef : item}>
              {index === 1 ? <HarnessMark harness={harness} size={11} /> : null}
              {item}
            </span>
          ))}
        </div>
        {terminalTarget ? (
          <div className="pi-sessionTerminalActions" aria-label="tmux terminal actions">
            <span className="pi-sessionTerminalName" title={terminalTarget.sessionName}>
              tmux · {terminalTarget.sessionName}
            </span>
            <button type="button" onClick={openWebTerminal}>Open in web terminal</button>
            {nativeDeepLink ? (
              <a href={nativeDeepLink}>
                Open in native terminal
                <ExternalLink size={11} strokeWidth={1.8} aria-hidden />
              </a>
            ) : null}
          </div>
        ) : null}
      </section>

      <ProjectSessionGlance
        lookup={lookup}
        session={session}
        threads={threads}
        nowMs={nowMs}
        route={route}
        navigate={navigate}
      />
    </section>
  );
}

function SelectedSessionMain({
  session,
  sessionRef,
  threads,
  route,
  navigate,
  nowMs,
}: {
  session: InboxSession | null;
  sessionRef: string;
  threads: InboxThread[];
  route: Extract<Route, { view: "agents-v2" }>;
  navigate: Navigate;
  nowMs: number;
}) {
  const [lookup, setLookup] = useState<SessionRefLookup | null>(null);

  useEffect(() => {
    setLookup(null);
  }, [sessionRef]);

  return (
    <main className="pi-sessionDetail" aria-label="Selected session">
      <div className="pi-sessionContent">
        <ProjectSessionOverview
          session={session}
          sessionRef={sessionRef}
          threads={threads}
          lookup={lookup}
          route={route}
          navigate={navigate}
          nowMs={nowMs}
        />
        <SessionRefScreen
          sessionRef={sessionRef}
          navigate={navigate}
          showObserveRail={false}
          onLookup={setLookup}
        />
      </div>
    </main>
  );
}

type TokenBucket = {
  key: string;
  label: string;
  value: number;
};

type SessionFileSignal = {
  path: string;
  kind: ObserveData["files"][number]["state"];
  detail: string;
};

type SessionToolSignal = {
  name: string;
  count: number;
  detail: string;
};

type SessionContextSignal = {
  label: string;
  value: string;
  detail: string;
  tone?: "warn" | "good";
};

type SessionThreadSignal = {
  thread: InboxThread;
  title: string;
  channel: string;
  state: string;
  time: string;
  participants: string;
  why: string;
};

function compactNumber(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  if (Math.abs(value) < 1000) return value.toLocaleString("en-US");
  return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 })
    .format(value)
    .toLowerCase();
}

function tokenLabel(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "—";
  return `${compactNumber(value)} tok`;
}

function positiveNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function contextRatio(usage: ObserveUsageMeta | null | undefined): number | null {
  const used = positiveNumber(usage?.contextInputTokens);
  const total = positiveNumber(usage?.contextWindowTokens);
  if (used === null || total === null) return null;
  return Math.max(0, Math.min(1, used / total));
}

function tokenBuckets(usage: ObserveUsageMeta | null | undefined): TokenBucket[] {
  const rawBuckets = [
    { key: "input", label: "input", value: positiveNumber(usage?.inputTokens) ?? 0 },
    { key: "cache-read", label: "cache rd", value: positiveNumber(usage?.cacheReadInputTokens) ?? 0 },
    { key: "cache-write", label: "cache wr", value: positiveNumber(usage?.cacheCreationInputTokens) ?? 0 },
    { key: "output", label: "output", value: positiveNumber(usage?.outputTokens) ?? 0 },
    { key: "reasoning", label: "reasoning", value: positiveNumber(usage?.reasoningOutputTokens) ?? 0 },
  ].filter((bucket) => bucket.value > 0);
  const total = rawBuckets.reduce((sum, bucket) => sum + bucket.value, 0);
  const buckets = rawBuckets.filter((bucket) => bucket.key !== "reasoning" || (total > 0 && bucket.value / total >= 0.02));
  if (buckets.length > 0) return buckets;
  const fallbackTotal = positiveNumber(usage?.totalTokens);
  return fallbackTotal !== null ? [{ key: "total", label: "total", value: fallbackTotal }] : [];
}

function TokenTelemetry({
  buckets,
}: {
  buckets: TokenBucket[];
}) {
  const bucketTotal = buckets.reduce((sum, bucket) => sum + bucket.value, 0);
  if (buckets.length === 0) return null;

  return (
    <div className="pi-sessionGlanceTokens" aria-label="Token usage">
      <div className="pi-sessionGlanceTokenBars">
        {buckets.map((bucket) => (
          <span
            key={bucket.key}
            className="pi-sessionGlanceTokenSeg"
            data-kind={bucket.key}
            style={{ flexGrow: bucketTotal > 0 ? Math.max(0.035, bucket.value / bucketTotal) : 1, flexBasis: 0 } as CSSProperties}
            title={`${bucket.label}: ${tokenLabel(bucket.value)}`}
          />
        ))}
      </div>
      <div className="pi-sessionGlanceTokenLegend">
        {buckets.map((bucket) => (
          <span key={bucket.key}>
            <i data-kind={bucket.key} aria-hidden />
            {bucket.label} <b>{compactNumber(bucket.value)}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

function observedStartMs(data: ObserveData | null): number | null {
  const explicit = normalizeTimestampMs(data?.metadata?.session?.sessionStart);
  if (explicit !== null) return explicit;
  for (const event of data?.events ?? []) {
    const wall = normalizeTimestampMs(event.at);
    if (wall !== null) return wall;
  }
  return null;
}

function observedEndMs(data: ObserveData | null, fallback: number | null | undefined): number | null {
  for (let i = (data?.events.length ?? 0) - 1; i >= 0; i -= 1) {
    const wall = normalizeTimestampMs(data?.events[i]?.at);
    if (wall !== null) return wall;
  }
  const start = observedStartMs(data);
  const lastOffset = data?.events.at(-1)?.t;
  if (start !== null && typeof lastOffset === "number" && Number.isFinite(lastOffset)) {
    return start + lastOffset * 1000;
  }
  return normalizeTimestampMs(fallback);
}

function observedDuration(data: ObserveData | null, fallbackLastAt: number | null | undefined): string {
  const start = observedStartMs(data);
  const end = observedEndMs(data, fallbackLastAt);
  if (start !== null && end !== null) return formatDurationShort(Math.max(0, end - start)) || "—";
  const seconds = data?.events.at(-1)?.t;
  if (typeof seconds === "number" && Number.isFinite(seconds)) return formatDurationShort(seconds * 1000) || "—";
  return "—";
}

function formatDurationShort(durationMs: number | null | undefined): string {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) return "";
  const totalSeconds = Math.floor(durationMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 48) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

function topologyLine(data: ObserveData | null): string | null {
  const topology = data?.metadata?.topology;
  if (!topology) return null;
  const agents = topology.agents.length;
  const workers = topology.agents.filter((agent) => agent.role !== "lead").length;
  const workflows = topology.groups.filter((group) => group.kind === "workflow").length;
  const tasks = topology.tasks.length;
  const parts: string[] = [];
  if (workers > 0) parts.push(`${workers} worker${workers === 1 ? "" : "s"}`);
  else if (agents > 0) parts.push(`${agents} agent${agents === 1 ? "" : "s"}`);
  if (workflows > 0) parts.push(`${workflows} workflow${workflows === 1 ? "" : "s"}`);
  if (tasks > 0) parts.push(`${tasks} task${tasks === 1 ? "" : "s"}`);
  return parts.length ? parts.join(" · ") : null;
}

function sessionFileSignals(files: ObserveData["files"]): SessionFileSignal[] {
  return [...files]
    .sort((left, right) => {
      const stateRank = fileStateRank(right.state) - fileStateRank(left.state);
      return stateRank || right.touches - left.touches || right.lastT - left.lastT || left.path.localeCompare(right.path);
    })
    .slice(0, 5)
    .map((file) => ({
      path: file.path,
      kind: file.state,
      detail: [
        file.touches > 1 ? `${compactNumber(file.touches)} touches` : "1 touch",
        file.lastT > 0 ? `last ${formatDurationShort(file.lastT * 1000)}` : null,
      ].filter(Boolean).join(" · "),
    }));
}

function fileStateRank(state: ObserveData["files"][number]["state"]): number {
  switch (state) {
    case "created":
      return 3;
    case "modified":
      return 2;
    case "read":
      return 1;
  }
}

function sessionToolSignals(events: ObserveData["events"]): SessionToolSignal[] {
  const byTool = new Map<string, { count: number; samples: string[] }>();
  for (const event of events) {
    if (event.kind !== "tool") continue;
    const name = normalizeToolName(event.tool || event.text);
    const entry = byTool.get(name) ?? { count: 0, samples: [] };
    entry.count += 1;
    const sample = event.arg || event.detail || event.text;
    if (sample && entry.samples.length < 2) entry.samples.push(sample);
    byTool.set(name, entry);
  }
  return [...byTool.entries()]
    .sort((left, right) => right[1].count - left[1].count || left[0].localeCompare(right[0]))
    .slice(0, 5)
    .map(([name, entry]) => ({
      name,
      count: entry.count,
      detail: entry.samples.join(" · ") || `${compactNumber(entry.count)} uses`,
    }));
}

function normalizeToolName(value: string): string {
  const raw = value.trim().split(/\s+/u)[0] ?? "tool";
  return raw.replace(/[_-]+/gu, " ").toLowerCase();
}

function sessionContextSignals({
  usage,
  contextPct,
  topology,
  workspace,
  projectRoot,
  branch,
}: {
  usage: ObserveUsageMeta | null | undefined;
  contextPct: number | null;
  topology: string | null;
  workspace: string | null;
  projectRoot: string | null | undefined;
  branch: string | null;
}): SessionContextSignal[] {
  const signals: SessionContextSignal[] = [];
  if (contextPct !== null) {
    signals.push({
      label: "Context",
      value: `${contextPct}%`,
      detail: contextPct >= 80 ? "approaching limit" : "within window",
      tone: contextPct >= 80 ? "warn" : undefined,
    });
  }
  if (usage?.serviceTier || usage?.planType || usage?.speed) {
    signals.push({
      label: "Budget",
      value: usage.serviceTier ?? usage.planType ?? usage.speed ?? "usage",
      detail: [usage.planType, usage.speed].filter(Boolean).join(" · ") || "provider metadata",
    });
  }
  if (workspace && projectRoot && workspace !== projectRoot) {
    signals.push({
      label: "Worktree",
      value: shortHomePath(workspace),
      detail: "session cwd differs from project root",
      tone: "warn",
    });
  } else if (branch) {
    signals.push({
      label: "Repo",
      value: branch,
      detail: "session branch",
    });
  }
  if (topology) {
    signals.push({
      label: "Topology",
      value: topology,
      detail: "observed harness hierarchy",
    });
  }
  if (usage?.webSearchRequests || usage?.webFetchRequests) {
    signals.push({
      label: "Network",
      value: `${compactNumber((usage.webSearchRequests ?? 0) + (usage.webFetchRequests ?? 0))} req`,
      detail: [
        usage.webSearchRequests ? `${compactNumber(usage.webSearchRequests)} search` : null,
        usage.webFetchRequests ? `${compactNumber(usage.webFetchRequests)} fetch` : null,
      ].filter(Boolean).join(" · "),
    });
  }
  return signals.slice(0, 4);
}

function coordinationThreadSignals({
  session,
  threads,
  nowMs,
}: {
  session: InboxSession | null;
  threads: InboxThread[];
  nowMs: number;
}): SessionThreadSignal[] {
  return threads
    .filter((thread) => thread.kind === "agent")
    .filter((thread) => thread.agentId !== session?.agentId || thread.work !== session?.work)
    .sort((left, right) => Number(right.working) - Number(left.working) || right.lastActivityAt - left.lastActivityAt)
    .slice(0, 4)
    .map((thread) => {
      const sameBranch = Boolean(session?.branch && thread.branch === session.branch);
      const sameAgent = Boolean(session?.agentName && thread.agentName === session.agentName);
      return {
        thread,
        title: sessionHeadline(thread.work, thread.agentName, thread.id),
        channel: thread.conversationId ? shortSessionRef(thread.conversationId) : thread.agentName,
        state: thread.needs ? "needs" : thread.working ? "working" : "recent",
        time: thread.lastActivityAt ? timeAgo(thread.lastActivityAt, nowMs) : "—",
        participants: thread.agentName,
        why: sameBranch ? "same branch" : sameAgent ? "same agent" : thread.working ? "active in project" : "project thread",
      };
    });
}

function GlanceField({ label, value, title, detail }: { label: string; value: string; title?: string; detail?: string | null }) {
  return (
    <span className="pi-sessionGlanceField" title={title}>
      <span>{label}</span>
      <b>{value}</b>
      {detail ? <small>{detail}</small> : null}
    </span>
  );
}

function ProjectSessionGlance({
  lookup,
  session,
  threads,
  nowMs,
  route,
  navigate,
}: {
  lookup: SessionRefLookup | null;
  session: InboxSession | null;
  threads: InboxThread[];
  nowMs: number;
  route: Extract<Route, { view: "agents-v2" }>;
  navigate: Navigate;
}) {
  const [tokensOpen, setTokensOpen] = useState(false);
  const derived = useMemo(() => {
    const data = lookup?.kind === "observe" ? lookup.observe.data : null;
    const sessionMeta = data?.metadata?.session;
    const usage = data?.metadata?.usage;
    const events = data?.events ?? [];
    const files = data?.files ?? [];
    const turnCount = sessionMeta?.turnCount ?? usage?.assistantMessages ?? (lookup?.kind === "conversation" ? lookup.session.messageCount : null);
    const toolCount = events.filter((event) => event.kind === "tool").length;
    const createdCount = files.filter((file) => file.state === "created").length;
    const modifiedCount = files.filter((file) => file.state === "modified").length;
    const readCount = files.filter((file) => file.state === "read").length;
    const editCount = createdCount + modifiedCount;
    const context = contextRatio(usage);
    const contextPct = context !== null ? Math.round(context * 100) : null;
    const workspace = sessionMeta?.cwd ?? lookup?.session?.workspaceRoot ?? session?.projectRoot ?? null;
    const branch = sessionMeta?.gitBranch ?? lookup?.session?.currentBranch ?? session?.branch ?? null;
    const topology = topologyLine(data);
    const tokenTotal = tokenLabel(usage?.totalTokens ?? (
      typeof usage?.inputTokens === "number" || typeof usage?.outputTokens === "number"
        ? (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)
        : null
    ));
    const buckets = tokenBuckets(usage);
    const fileStateLabel = editCount > 0
      ? [
          modifiedCount > 0 ? `${compactNumber(modifiedCount)} mod` : null,
          createdCount > 0 ? `${compactNumber(createdCount)} new` : null,
        ].filter(Boolean).join(" · ")
      : readCount > 0 ? "read-only" : "no file trace";
    const fileCountLabel = files.length > 0 ? `${compactNumber(files.length)} touched` : "—";
    const fileSignals = sessionFileSignals(files);
    const toolSignals = sessionToolSignals(events);
    const contextSignals = sessionContextSignals({
      usage,
      contextPct,
      topology,
      workspace,
      projectRoot: session?.projectRoot,
      branch,
    });
    const threadSignals = coordinationThreadSignals({ session, threads, nowMs });
    return {
      turnCount,
      toolCount,
      editCount,
      fileCountLabel,
      fileStateLabel,
      workspace,
      contextPct,
      showContext: contextPct !== null,
      contextWarn: contextPct !== null && contextPct >= 80,
      tokenTotal,
      buckets,
      fileSignals,
      toolSignals,
      contextSignals,
      threadSignals,
      projectRoot: session?.projectRoot ?? null,
    };
  }, [lookup, session, threads, nowMs]);

  const {
    turnCount,
    toolCount,
    editCount,
    fileCountLabel,
    fileStateLabel,
    workspace,
    contextPct,
    showContext,
    contextWarn,
    tokenTotal,
    buckets,
    fileSignals,
    toolSignals,
    contextSignals,
    threadSignals,
    projectRoot,
  } = derived;

  return (
    <section className="pi-sessionGlance" aria-label="Session glance">
      <div className="pi-sessionVitals" aria-label="Session vitals">
        <GlanceField label="Turns" value={compactNumber(turnCount)} />
        <GlanceField label="Tools" value={compactNumber(toolCount)} />
        <GlanceField label="Edits" value={compactNumber(editCount)} />
        <GlanceField label="Files" value={fileCountLabel} detail={fileStateLabel !== "no file trace" ? fileStateLabel : null} />
        {workspace && projectRoot && workspace !== projectRoot ? (
          <GlanceField label="Worktree" value={shortHomePath(workspace)} title={workspace} />
        ) : null}
        {showContext ? (
          <span className="pi-sessionContextVital" title="Context window usage">
            <span>Ctx</span>
            <span className="pi-sessionContextBar" aria-hidden>
              <span data-warn={contextWarn || undefined} style={{ width: `${contextPct}%` }} />
            </span>
            <b data-warn={contextWarn || undefined}>{contextPct}%</b>
          </span>
        ) : null}
        {buckets.length > 0 ? (
          <button
            type="button"
            className="pi-sessionTokenToggle"
            aria-expanded={tokensOpen}
            onClick={() => setTokensOpen((open) => !open)}
          >
            <span>Tokens</span>
            <b>{tokenTotal}</b>
            <i>{tokensOpen ? "▾" : "▸"}</i>
          </button>
        ) : null}
      </div>

      {tokensOpen && buckets.length > 0 ? <TokenTelemetry buckets={buckets} /> : null}
      <SessionSignalPanel
        files={fileSignals}
        tools={toolSignals}
        context={contextSignals}
        threads={threadSignals}
        route={route}
        navigate={navigate}
      />
    </section>
  );
}

function SessionSignalPanel({
  files,
  tools,
  context,
  threads,
  route,
  navigate,
}: {
  files: SessionFileSignal[];
  tools: SessionToolSignal[];
  context: SessionContextSignal[];
  threads: SessionThreadSignal[];
  route: Extract<Route, { view: "agents-v2" }>;
  navigate: Navigate;
}) {
  return (
    <section className="pi-sessionSignals" aria-label="Session work signals">
      <div className="pi-sessionSignalCol">
        <div className="pi-sessionSignalHead">
          <span>Files</span>
          <b>{compactNumber(files.length)}</b>
        </div>
        {files.length > 0 ? (
          <div className="pi-sessionFileList">
            {files.map((file) => (
              <div key={`${file.kind}:${file.path}`} className="pi-sessionFileRow">
                <span data-kind={file.kind}>{file.kind}</span>
                <code title={file.path}>{file.path}</code>
                <small>{file.detail}</small>
              </div>
            ))}
          </div>
        ) : (
          <span className="pi-sessionSignalEmpty">No file trace yet.</span>
        )}
      </div>

      <div className="pi-sessionSignalCol">
        <div className="pi-sessionSignalHead">
          <span>Tools · Context · Topology</span>
        </div>
        {tools.length > 0 ? (
          <div className="pi-sessionToolGrid">
            {tools.map((tool) => (
              <span key={tool.name} className="pi-sessionToolPill" title={tool.detail}>
                <b>{tool.name}</b>
                <em>{compactNumber(tool.count)}</em>
              </span>
            ))}
          </div>
        ) : null}
        {context.length > 0 ? (
          <div className="pi-sessionContextList">
            {context.map((signal) => (
              <div key={`${signal.label}:${signal.value}`} className="pi-sessionContextRow">
                <span>{signal.label}</span>
                <b data-tone={signal.tone}>{signal.value}</b>
                <small>{signal.detail}</small>
              </div>
            ))}
          </div>
        ) : tools.length === 0 ? (
          <span className="pi-sessionSignalEmpty">Trace metadata is still resolving.</span>
        ) : null}
      </div>

      <div className="pi-sessionSignalCol">
        <div className="pi-sessionSignalHead">
          <span>Recent threads</span>
          <b>{compactNumber(threads.length)}</b>
        </div>
        {threads.length > 0 ? (
          <div className="pi-sessionThreadList">
            {threads.map((thread) => (
              <button
                key={thread.thread.id}
                type="button"
                className="pi-sessionThreadRow"
                onClick={() => navigate(threadSelectRoute(thread.thread, route))}
              >
                <span className="pi-sessionThreadTitle" title={thread.title}>{thread.title}</span>
                <span className="pi-sessionThreadMeta">
                  <b>{thread.channel}</b>
                  <em>{thread.state}</em>
                  <small>{thread.time}</small>
                </span>
                <span className="pi-sessionThreadWhy">{thread.participants} · {thread.why}</span>
              </button>
            ))}
          </div>
        ) : (
          <span className="pi-sessionSignalEmpty">No recent agent threads.</span>
        )}
      </div>
    </section>
  );
}

type ProjectOverviewWorktree = {
  key: string;
  root: string | null;
  branch: string | null;
  sessions: number;
  work: number;
  moving: number;
  lastActivityAt: number;
  repoWatch: RepoWatchWorktree | null;
};

function cleanBranch(value: string | null): string | null {
  if (!value || value === "—") return null;
  if (/^\d+\s+branches$/iu.test(value)) return null;
  return value;
}

function projectWorktrees(
  root: string | null,
  inventory: InboxProject["worktrees"],
  sessions: InboxSession[],
  threads: InboxThread[],
): ProjectOverviewWorktree[] {
  const map = new Map<string, ProjectOverviewWorktree>();
  const ensure = (entryRoot: string | null, branch: string | null): ProjectOverviewWorktree => {
    const normalizedRoot = entryRoot ?? root;
    const normalizedBranch = cleanBranch(branch);
    const key = normalizedRoot ?? "project";
    const existing = map.get(key);
    if (existing) {
      if (!existing.branch && normalizedBranch) existing.branch = normalizedBranch;
      return existing;
    }
    const next = {
      key,
      root: normalizedRoot,
      branch: normalizedBranch,
      sessions: 0,
      work: 0,
      moving: 0,
      lastActivityAt: 0,
      repoWatch: null,
    };
    map.set(key, next);
    return next;
  };
  for (const worktree of inventory) {
    const entry = ensure(worktree.root, worktree.branch);
    if (worktree.working) entry.moving += 1;
    entry.lastActivityAt = Math.max(entry.lastActivityAt, worktree.lastActivityAt);
  }
  const resolve = (entryRoot: string | null, branch: string | null): ProjectOverviewWorktree => {
    const normalizedRoot = entryRoot ?? root;
    const known = map.get(normalizedRoot ?? "project");
    if (known) return known;
    if (inventory.length > 0) return map.get(root ?? "") ?? map.values().next().value!;
    return ensure(entryRoot, branch);
  };
  for (const session of sessions) {
    const entry = resolve(session.workspaceRoot ?? session.projectRoot, session.branch);
    entry.sessions += 1;
    if (session.working) {
      entry.moving += 1;
      entry.branch = cleanBranch(session.branch) ?? entry.branch;
    }
    entry.lastActivityAt = Math.max(entry.lastActivityAt, session.lastActivityAt);
  }
  for (const thread of threads) {
    const entry = resolve(thread.workspaceRoot ?? thread.projectRoot, thread.branch);
    entry.work += 1;
    if (thread.working) {
      entry.moving += 1;
      entry.branch = cleanBranch(thread.branch) ?? entry.branch;
    }
    entry.lastActivityAt = Math.max(entry.lastActivityAt, thread.lastActivityAt);
  }
  if (map.size === 0) ensure(root, null);
  return [...map.values()].sort((left, right) =>
    right.moving - left.moving
    || right.lastActivityAt - left.lastActivityAt
    || (left.root ?? "").localeCompare(right.root ?? ""),
  );
}

function repoWatchWorktrees(project: RepoWatchProject): ProjectOverviewWorktree[] {
  return project.worktrees.map((worktree) => ({
    key: worktree.id,
    root: worktree.path,
    branch: worktree.branch.name,
    sessions: worktree.sessions.length,
    work: worktree.agents.length,
    moving: worktree.agents.some(agentLive) ? 1 : 0,
    lastActivityAt: worktree.lastCommitAt ?? 0,
    repoWatch: worktree,
  }));
}

function ProjectOpenPullRequests({
  pullRequests,
  loading,
  warnings,
  onRefresh,
  nowMs,
}: {
  pullRequests: RepoPullRequestItem[];
  loading: boolean;
  warnings: string[];
  onRefresh: () => void;
  nowMs: number;
}) {
  return (
    <section className="pi-projectPullRequests" aria-label="Open pull requests">
      <div className="pi-projectPullRequestsHead">
        <span>Open PRs</span>
        <b>{loading && pullRequests.length === 0 ? "…" : compactNumber(pullRequests.length)}</b>
      </div>
      {pullRequests.length > 0 ? (
        <div className="pi-projectPullRequestList">
          {pullRequests.slice(0, 6).map((pr) => {
            const updatedAt = pr.updatedAt ? Date.parse(pr.updatedAt) : Number.NaN;
            return (
              <a key={pr.id} className="pi-projectPullRequest" href={pr.url} target="_blank" rel="noreferrer">
                <span className="pi-projectPullRequestNumber">#{pr.number}</span>
                <b title={pr.title}>{pr.title}</b>
                <span className="pi-projectPullRequestBranch" title={`${pr.headRefName} → ${pr.baseRefName}`}>
                  {pr.headRefName} → {pr.baseRefName}
                </span>
                <em>{pr.isDraft ? "draft" : "open"}</em>
                <time>{Number.isFinite(updatedAt) ? timeAgo(updatedAt, nowMs) : "updated"}</time>
              </a>
            );
          })}
        </div>
      ) : (
        <div className="pi-projectPullRequestState" data-loading={loading || undefined}>
          <span>{loading ? "Checking GitHub for open pull requests…" : warnings[0] ?? "No open pull requests for this repository."}</span>
          {!loading && warnings.length > 0 ? (
            <button type="button" onClick={onRefresh}>Retry</button>
          ) : null}
        </div>
      )}
    </section>
  );
}

type ProjectDiffSummary = {
  additions: number;
  deletions: number;
  files: string[];
  layers: string[];
};

function projectDiffSummary(snapshot: ScoutRepoDiffSnapshot): ProjectDiffSummary {
  const files = new Set<string>();
  let additions = 0;
  let deletions = 0;
  const layers: string[] = [];
  for (const layer of snapshot.layers) {
    if (layer.files.length > 0) layers.push(layer.kind);
    for (const file of layer.files) {
      files.add(file.newPath ?? file.oldPath ?? "unknown");
      additions += file.additions ?? 0;
      deletions += file.deletions ?? 0;
    }
  }
  return { additions, deletions, files: [...files], layers };
}

function ProjectChurnBar({ additions, deletions }: { additions: number; deletions: number }) {
  const total = additions + deletions;
  if (total === 0) return <span className="pi-projectWorktreeChurnBar" data-empty />;
  return (
    <span className="pi-projectWorktreeChurnBar" aria-label={`${additions} additions and ${deletions} deletions`}>
      {additions > 0 ? <i data-add style={{ flexGrow: additions }} /> : null}
      {deletions > 0 ? <i data-delete style={{ flexGrow: deletions }} /> : null}
    </span>
  );
}

function ProjectOverviewMain({
  project,
  repoProject,
  repoLoading,
  repoError,
  diffSnapshots,
  diffErrors,
  diffLoading,
  pullRequests,
  pullRequestsLoading,
  pullRequestWarnings,
  onRepositoryRefresh,
  threads,
  sessions,
  route,
  navigate,
  nowMs,
}: {
  project: InboxProject | null;
  repoProject: RepoWatchProject | null;
  repoLoading: boolean;
  repoError: string | null;
  diffSnapshots: ReadonlyMap<string, ScoutRepoDiffSnapshot>;
  diffErrors: ReadonlyMap<string, string>;
  diffLoading: boolean;
  pullRequests: RepoPullRequestItem[];
  pullRequestsLoading: boolean;
  pullRequestWarnings: string[];
  onRepositoryRefresh: () => void;
  threads: InboxThread[];
  sessions: InboxSession[];
  route: Extract<Route, { view: "agents-v2" }>;
  navigate: Navigate;
  nowMs: number;
}) {
  const root = project?.root ?? sessions[0]?.projectRoot ?? threads[0]?.projectRoot ?? null;
  const workCount = threads.length;
  const sessionCount = project?.sessionCount ?? sessions.length;
  const agentCount = project?.agentCount ?? 0;
  const lastActivityAt = Math.max(
    project?.lastActivityAt ?? 0,
    sessions[0]?.lastActivityAt ?? 0,
    threads[0]?.lastActivityAt ?? 0,
  );
  const branches = project?.branches.length
    ? project.branches
    : [
        ...new Set(
          [...sessions.map((session) => session.branch), ...threads.map((thread) => thread.branch)]
            .filter((branch): branch is string => Boolean(branch) && branch !== "—" && branch !== "main"),
        ),
      ];
  const worktrees = repoProject?.worktrees.length
    ? repoWatchWorktrees(repoProject)
    : projectWorktrees(root, project?.worktrees ?? [], sessions, threads);
  const currentBranch = worktrees.find((entry) => entry.moving > 0 && entry.branch)?.branch
    ?? worktrees.find((entry) => entry.branch)?.branch
    ?? branches[0]
    ?? "main";
  const repositoryName = root ? pathLeaf(root) : project?.title ?? route.projectSlug ?? "project";
  const activeWorktreeKey = worktrees.find((entry) => entry.moving > 0)?.key
    ?? worktrees.find((entry) => entry.branch === currentBranch)?.key
    ?? worktrees[0]?.key;

  return (
    <main className="pi-projectOverview" aria-label="Project overview">
      <section className="pi-projectSnapshot" aria-label="Project snapshot">
        <div className="pi-projectRepository">
          <div className="pi-projectRepositoryHead">
            <span>Repository</span>
            <Folder size={13} strokeWidth={1.7} aria-hidden />
          </div>
          <div className="pi-projectRepositoryIdentity">
            <b>{repositoryName}</b>
            <span title={root ?? undefined}>{root ? shortHomePath(root) : route.projectSlug ?? "project"}</span>
          </div>
          <div className="pi-projectRepositoryCurrent">
            {worktrees.some((entry) => entry.moving > 0) ? <span className="pi-projectRepositoryPulse" aria-label="Active now" /> : null}
            <span>
              <small>Current branch</small>
              <b title={currentBranch}>{currentBranch}</b>
            </span>
            <time>{lastActivityAt ? timeAgo(lastActivityAt, nowMs) : "no activity"}</time>
          </div>
          {sessionCount > 0 || agentCount > 0 || workCount > 0 ? (
            <div className="pi-projectRepositoryStats" aria-label="Repository activity">
              {sessionCount > 0 ? <span><b>{compactNumber(sessionCount)}</b> sessions</span> : null}
              {agentCount > 0 ? <span><b>{compactNumber(agentCount)}</b> agents</span> : null}
              {workCount > 0 ? <span><b>{compactNumber(workCount)}</b> threads</span> : null}
            </div>
          ) : null}
        </div>

        <div className="pi-projectWorktrees">
          <div className="pi-projectWorktreesHead">
            <span>Worktree preview</span>
            <b>{compactNumber(worktrees.length)}</b>
          </div>
          <div className="pi-projectWorktreeList">
            {worktrees.slice(0, 6).map((entry) => {
              const watch = entry.repoWatch;
              const diff = entry.root ? diffSnapshots.get(entry.root) ?? null : null;
              const diffSummary = diff ? projectDiffSummary(diff) : null;
              const churn = watch ? reviewChurnOf(watch) : null;
              const additions = diffSummary?.additions ?? churn?.add ?? 0;
              const deletions = diffSummary?.deletions ?? churn?.del ?? 0;
              const changedFiles = diffSummary?.files.length
                ?? (watch ? Math.max(watch.status.changedFiles, churn?.files ?? 0) : 0);
              const stranded = Boolean(
                changedFiles > 0 || (watch && (!watch.status.clean || watch.branch.ahead > 0 || watch.branch.behind > 0)),
              );
              const branchPullRequests = pullRequests.filter((pr) => pr.headRefName === entry.branch);
              const entryLoading = Boolean(entry.root && diffLoading && !diff && !diffErrors.has(entry.root));
              const entryError = entry.root ? diffErrors.get(entry.root) ?? null : "No worktree path is available.";
              return (
                <article
                  key={entry.key}
                  className="pi-projectWorktree"
                  data-active={entry.key === activeWorktreeKey || undefined}
                  data-stranded={stranded || undefined}
                >
                  <span className="pi-projectWorktreeTop">
                    <b title={entry.branch ?? "main"}>{entry.branch ?? "main"}</b>
                  </span>
                  <em title={entry.root ?? undefined}>{entry.root ? shortHomePath(entry.root) : "workspace"}</em>
                  {diff || watch ? (
                    <div className="pi-projectWorktreeDiff" data-clean={!stranded || undefined}>
                      {stranded ? (
                        <>
                          <span className="pi-projectWorktreeChurn">
                            <b className="pi-projectWorktreeAdd">+{compactNumber(additions)}</b>
                            <b className="pi-projectWorktreeDel">−{compactNumber(deletions)}</b>
                            <ProjectChurnBar additions={additions} deletions={deletions} />
                          </span>
                          <small>{compactNumber(changedFiles)} changed</small>
                        </>
                      ) : (
                        <small>clean</small>
                      )}
                      {entry.root ? (
                        <button
                          type="button"
                          className="pi-projectWorktreeOpenDiff"
                          onClick={() => navigate({ view: "repo-diff", path: entry.root! })}
                        >
                          View diff
                        </button>
                      ) : null}
                    </div>
                  ) : (
                    <div className="pi-projectWorktreeDiff" data-pending>
                      <small>{entryLoading || repoLoading ? "Reading worktree diff…" : entryError ?? repoError ?? "No diff data returned."}</small>
                      {!entryLoading && !repoLoading ? (
                        <button type="button" className="pi-projectWorktreeOpenDiff" onClick={onRepositoryRefresh}>Retry</button>
                      ) : null}
                    </div>
                  )}
                  {diffSummary && diffSummary.files.length > 0 ? (
                    <span className="pi-projectWorktreeFiles" title={diffSummary.files.join("\n")}>
                      {diffSummary.files.slice(0, 2).map((file) => pathLeaf(file)).join(" · ")}
                      {diffSummary.files.length > 2 ? ` · +${diffSummary.files.length - 2} more` : ""}
                    </span>
                  ) : null}
                  <span className="pi-projectWorktreeMeta">
                    {watch ? (
                      <>
                        <small>{watch.branch.ahead > 0 || watch.branch.behind > 0 ? `${watch.branch.ahead}↑ ${watch.branch.behind}↓` : "synced"}</small>
                        {watch.status.staged > 0 ? <small>{compactNumber(watch.status.staged)} staged</small> : null}
                        {watch.status.unstaged > 0 ? <small>{compactNumber(watch.status.unstaged)} unstaged</small> : null}
                        {watch.status.untracked > 0 ? <small>{compactNumber(watch.status.untracked)} untracked</small> : null}
                        {watch.status.conflicts > 0 ? <small>{compactNumber(watch.status.conflicts)} conflicts</small> : null}
                        {diffSummary?.layers.map((layer) => <small key={layer}>{layer}</small>)}
                        {branchPullRequests.length > 0 ? <small>{branchPullRequests.length} PR{branchPullRequests.length === 1 ? "" : "s"}</small> : null}
                      </>
                    ) : (
                      <>
                        <small>{entry.lastActivityAt ? timeAgo(entry.lastActivityAt, nowMs) : "idle"}</small>
                        <small>{compactNumber(entry.sessions)} sessions</small>
                        <small>{compactNumber(entry.work)} threads</small>
                      </>
                    )}
                  </span>
                </article>
              );
            })}
          </div>
          {worktrees.length > 6 ? <div className="pi-projectWorktreeMore">+{worktrees.length - 6} more worktrees</div> : null}
        </div>
      </section>

      <ProjectOpenPullRequests
        pullRequests={pullRequests}
        loading={pullRequestsLoading}
        warnings={pullRequestWarnings}
        onRefresh={onRepositoryRefresh}
        nowMs={nowMs}
      />
    </main>
  );
}

const RECENT_PROJECTS_LIMIT = 8;
const ACTIVE_DIFFS_LIMIT = 6;
const REPO_WATCH_REFRESH_MS = 30_000;
const REPO_WATCH_TIMEOUT_MS = 15_000;

type ActiveDiff = {
  projectName: string;
  projectRoot: string;
  worktree: RepoWatchWorktree;
};

/** Cross-project repo-watch summary for the unscoped landing — one standard
   scan, visibility-gated, sharing the module cache with repos/code surfaces. */
function useRepoWatchSummary(): { snapshot: RepoWatchSnapshot | null; loading: boolean } {
  const [snapshot, setSnapshot] = useState<RepoWatchSnapshot | null>(() => getCachedRepoWatchSnapshot());
  const [loading, setLoading] = useState<boolean>(() => getCachedRepoWatchSnapshot() === null);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await fetchRepoWatchSnapshot("standard", false, REPO_WATCH_TIMEOUT_MS);
        if (!cancelled) {
          setSnapshot(next);
          setLoading(false);
        }
      } catch {
        if (!cancelled) setLoading(false);
      } finally {
        inFlight = false;
      }
    };
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, REPO_WATCH_REFRESH_MS);
    const offVisible = onVisible(() => void load());
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      offVisible();
    };
  }, []);

  return { snapshot, loading };
}

function collectActiveDiffs(snapshot: RepoWatchSnapshot | null): ActiveDiff[] {
  if (!snapshot) return [];
  const rows: ActiveDiff[] = [];
  for (const project of snapshot.projects) {
    for (const worktree of project.worktrees) {
      if (worktree.status.changedFiles <= 0 && worktree.branch.ahead <= 0) continue;
      rows.push({ projectName: project.name, projectRoot: project.root, worktree });
    }
  }
  return rows.sort(
    (a, b) =>
      b.worktree.status.changedFiles - a.worktree.status.changedFiles
      || (b.worktree.lastCommitAt ?? 0) - (a.worktree.lastCommitAt ?? 0)
      || a.projectName.localeCompare(b.projectName),
  );
}

function ProjectsMetaOverview({
  model,
  route,
  navigate,
  nowMs,
}: {
  model: ProjectsInboxModel;
  route: Extract<Route, { view: "agents-v2" }>;
  navigate: Navigate;
  nowMs: number;
}) {
  const [addingProject, setAddingProject] = useState(false);
  const machineScope = route.machineId ? { machineId: route.machineId } : {};
  const ephemeralScope = route.showEphemeral ? { showEphemeral: true } : {};
  const recentProjects = useMemo(
    () =>
      [...model.projects]
        .sort((a, b) => b.lastActivityAt - a.lastActivityAt || a.title.localeCompare(b.title))
        .slice(0, RECENT_PROJECTS_LIMIT),
    [model.projects],
  );
  const { snapshot: repoSnapshot, loading: repoLoading } = useRepoWatchSummary();
  const activeDiffs = useMemo(() => collectActiveDiffs(repoSnapshot).slice(0, ACTIVE_DIFFS_LIMIT), [repoSnapshot]);

  const openProject = (project: InboxProject) =>
    navigate({ view: "agents-v2", projectSlug: project.slug, ...machineScope, ...ephemeralScope });

  return (
    <main className="pi-meta" aria-label="Projects overview">
      <div className="pi-metaShortcuts">
        <button
          type="button"
          className="pi-shortcut"
          aria-expanded={addingProject}
          onClick={() => setAddingProject((open) => !open)}
        >
          <FolderPlus size={13} strokeWidth={1.8} aria-hidden />
          Add project
        </button>
        <button type="button" className="pi-shortcut" onClick={() => navigate({ view: "search" })}>
          <Search size={13} strokeWidth={1.8} aria-hidden />
          Search agents &amp; sessions
        </button>
        <button type="button" className="pi-shortcut" onClick={() => navigate({ view: "sessions", ...machineScope })}>
          Browse sessions
        </button>
      </div>
      {addingProject ? <AddProjectForm onClose={() => setAddingProject(false)} /> : null}

      <section className="pi-metaSection" aria-label="Recent projects">
        <div className="pi-sectionHead">
          <span className="pi-sectionLabel">Recent projects</span>
          <span className="pi-sectionCount">{model.projects.length}</span>
        </div>
        {recentProjects.map((project) => (
          <RecentProjectRow key={project.slug} project={project} nowMs={nowMs} onOpen={() => openProject(project)} />
        ))}
      </section>

      <section className="pi-metaSection" aria-label="Active diffs">
        <div className="pi-sectionHead">
          <span className="pi-sectionLabel">Active diffs</span>
          <span className="pi-sectionCount">{activeDiffs.length}</span>
        </div>
        {activeDiffs.length > 0 ? (
          activeDiffs.map((diff) => (
            <ActiveDiffRow key={diff.worktree.id} diff={diff} machineScope={machineScope} navigate={navigate} />
          ))
        ) : (
          <div className="pi-metaEmpty">
            {repoLoading ? "Reading repositories…" : "No uncommitted changes across your repos."}
          </div>
        )}
      </section>
    </main>
  );
}

function RecentProjectRow({
  project,
  nowMs,
  onOpen,
}: {
  project: InboxProject;
  nowMs: number;
  onOpen: () => void;
}) {
  const needs = project.needs > 0;
  const liveCount = Math.max(project.liveSessionCount, project.working);
  return (
    <button
      type="button"
      className="pi-recentRow"
      data-state={needs ? "needs" : liveCount > 0 ? "live" : undefined}
      onClick={onOpen}
    >
      <span className="pi-recentDot" aria-hidden />
      <span className="pi-recentMain">
        <span className="pi-recentTitle">/{project.title}</span>
        <span className="pi-recentRoot">{project.root ? shortHomePath(project.root) : "Discovered project"}</span>
      </span>
      <span className="pi-recentMeta">
        {needs ? <b>{project.needs} needs you</b> : null}
        {liveCount > 0 ? <span>{liveCount} live</span> : null}
        <time>{project.lastActivityAt ? timeAgo(project.lastActivityAt, nowMs) : "—"}</time>
      </span>
    </button>
  );
}

function ActiveDiffRow({
  diff,
  machineScope,
  navigate,
}: {
  diff: ActiveDiff;
  machineScope: { machineId?: string };
  navigate: Navigate;
}) {
  const churn = reviewChurnOf(diff.worktree);
  return (
    <div className="pi-diffRow">
      <button
        type="button"
        className="pi-diffMain"
        title={diff.worktree.path}
        onClick={() => navigate({ view: "repos", root: diff.projectRoot, ...machineScope })}
      >
        <span className="pi-diffProject">/{diff.projectName}</span>
        <span className="pi-diffBranch">{diff.worktree.branch.name ?? "main"}</span>
      </button>
      <span className="pi-diffChurn">
        <b className="pi-projectWorktreeAdd">+{compactNumber(churn.add)}</b>
        <b className="pi-projectWorktreeDel">−{compactNumber(churn.del)}</b>
        <small>{compactNumber(diff.worktree.status.changedFiles)} changed</small>
      </span>
      <button
        type="button"
        className="pi-projectWorktreeOpenDiff"
        onClick={() => navigate({ view: "repo-diff", path: diff.worktree.path })}
      >
        View diff
      </button>
    </div>
  );
}

function ProjectOverviewWithRepository({
  project,
  threads,
  sessions,
  route,
  navigate,
  nowMs,
}: {
  project: InboxProject | null;
  threads: InboxThread[];
  sessions: InboxSession[];
  route: Extract<Route, { view: "agents-v2" }>;
  navigate: Navigate;
  nowMs: number;
}) {
  const root = project?.root ?? sessions[0]?.projectRoot ?? threads[0]?.projectRoot ?? null;
  const knownWorktreePaths = useMemo(
    () => projectWorktrees(root, project?.worktrees ?? [], sessions, threads)
      .map((worktree) => worktree.root)
      .filter((path): path is string => Boolean(path)),
    [project?.worktrees, root, sessions, threads],
  );
  const repositoryState = useProjectRepositoryState(root, knownWorktreePaths);

  return (
    <ProjectOverviewMain
      project={project}
      repoProject={repositoryState.project}
      repoLoading={repositoryState.repoLoading}
      repoError={repositoryState.repoError}
      diffSnapshots={repositoryState.diffSnapshots}
      diffErrors={repositoryState.diffErrors}
      diffLoading={repositoryState.diffLoading}
      pullRequests={repositoryState.pullRequests}
      pullRequestsLoading={repositoryState.pullRequestsLoading}
      pullRequestWarnings={repositoryState.pullRequestWarnings}
      onRepositoryRefresh={repositoryState.refresh}
      threads={threads}
      sessions={sessions}
      route={route}
      navigate={navigate}
      nowMs={nowMs}
    />
  );
}

export function ProjectsInbox({
  route,
  navigate,
  zeroPreview = false,
}: {
  route: Extract<Route, { view: "agents-v2" }>;
  navigate: Navigate;
  zeroPreview?: boolean;
}) {
  const { model, nowMs, loading, error } = useProjectsInbox(route);
  const scoped = Boolean(route.projectSlug);
  const selectedSessionRef =
    scoped && !isSyntheticProcessSessionRef(route.sessionId) ? route.sessionId ?? null : null;
  const selectedSession = useMemo(
    () => selectedSessionRef ? findSelectedSession(model.sessions, route) : null,
    [model.sessions, route, selectedSessionRef],
  );
  const mode: ProjectMode = !scoped
    ? "overview"
    : route.indexView === "agents"
      ? "agents"
      : route.indexView === "sessions"
        ? "sessions"
        : "overview";
  const scopedProject = scoped
    ? model.projects.find((project) => project.slug === route.projectSlug) ?? null
    : null;

  const items = useMemo<Array<InboxThread | InboxSession>>(
    () => {
      if (zeroPreview) return [];
      if (!scoped) return [];
      const slug = route.projectSlug!;
      const projectThreads = threadsForProject(model.threads, slug);
      const projectSessions = sessionsForProject(model.sessions, slug);
      if (mode === "overview") return [];
      if (mode === "agents") return projectThreads.filter((thread) => thread.kind === "agent");
      if (projectSessions.length > 0) return projectSessions;
      return projectThreads;
    },
    [model.sessions, model.threads, mode, route.projectSlug, scoped, zeroPreview],
  );
  const sections = useMemo(() => groupItems(items), [items]);
  const flat = useMemo(() => sections.flatMap((section) => section.items), [sections]);
  const hasModelData = model.projects.length > 0 || model.threads.length > 0 || model.sessions.length > 0;
  const initialLoading = loading && !hasModelData;
  const waiting = loading && !zeroPreview;
  const showProjectZeroState =
    !scoped && !waiting && (zeroPreview || (model.projects.length === 0 && items.length === 0));
  // Mount meta overview with the first wave so useRepoWatchSummary can fire in
  // parallel with inbox snapshot load (do not wait for hasModelData).
  const showMeta = !scoped && !showProjectZeroState;

  const [cursor, setCursor] = useState(-1);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    if (!scoped || !route.sessionId || !isSyntheticProcessSessionRef(route.sessionId)) return;
    navigate({
      ...route,
      indexView: "sessions",
      sessionId: undefined,
      selectedAgentId: undefined,
    });
  }, [navigate, route, scoped]);

  useEffect(() => {
    setCursor(-1);
  }, [route.projectSlug]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const el = document.activeElement as HTMLElement | null;
      const typing = Boolean(el) && (el!.tagName === "INPUT" || el!.tagName === "TEXTAREA" || el!.isContentEditable);
      if (typing) return;
      const max = flat.length;
      if (!max) return;
      if (event.key === "ArrowDown" || event.key === "j") {
        event.preventDefault();
        setCursor((current) => (current < 0 ? 0 : Math.min(max - 1, current + 1)));
      } else if (event.key === "ArrowUp" || event.key === "k") {
        event.preventDefault();
        setCursor((current) => (current < 0 ? 0 : Math.max(0, current - 1)));
      } else if (event.key === "Enter") {
        const target = flat[cursor < 0 ? 0 : cursor];
        if (target) {
          event.preventDefault();
          navigate(target.kind === "session" ? sessionOpenRoute(target, route) : threadOpenRoute(target, route));
        }
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [cursor, flat, navigate, route]);

  useEffect(() => {
    if (cursor < 0) return;
    const target = flat[cursor];
    if (target) rowRefs.current.get(target.id)?.scrollIntoView({ block: "nearest" });
  }, [cursor, flat]);


  return (
    <div className="s-pi s-pi-inbox" aria-busy={loading || undefined} data-loading={loading || undefined}>
      {scoped ? (
        <ProjectScopeHeader
          route={route}
          navigate={navigate}
          slug={route.projectSlug!}
          model={model}
          mode={mode}
          repoProject={null}
        />
      ) : (
        <div className="pi-inboxHead">
          <div className="pi-inboxHeading">
            <h1 className="pi-inboxTitle">Projects</h1>
            <span className="pi-inboxDigest">{projectCountLabel(model, zeroPreview)}</span>
          </div>
        </div>
      )}

      {selectedSessionRef ? (
        <SelectedSessionMain
          session={selectedSession}
          sessionRef={selectedSessionRef}
          threads={threadsForProject(model.threads, route.projectSlug!)}
          route={route}
          navigate={navigate}
          nowMs={nowMs}
        />
      ) : scoped && mode === "overview" ? (
        <ProjectOverviewWithRepository
          project={scopedProject}
          threads={threadsForProject(model.threads, route.projectSlug!)}
          sessions={sessionsForProject(model.sessions, route.projectSlug!)}
          route={route}
          navigate={navigate}
          nowMs={nowMs}
        />
      ) : showMeta ? (
        <ProjectsMetaOverview model={model} route={route} navigate={navigate} nowMs={nowMs} />
      ) : (
        <div className="pi-threads">
          {initialLoading ? <ProjectRowsSkeleton /> : null}

          {!initialLoading && sections.map((section) => {
            let base = 0;
            for (const prior of sections) {
              if (prior.group === section.group) break;
              base += prior.items.length;
            }
            return (
              <div key={section.group}>
                <div className="pi-sectionHead" data-tone={section.group}>
                  <span className="pi-sectionLabel">{section.label}</span>
                  <span className="pi-sectionCount">{section.items.length}</span>
                </div>
                {section.items.map((thread, offset) => {
                  const index = base + offset;
                  return (
                    <ThreadRow
                      key={thread.id}
                      thread={thread}
                      crossProject={!scoped}
                      selected={thread.kind === "session" ? isSessionSelected(thread, route) : isThreadSelected(thread, route)}
                      cursor={cursor === index}
                      nowMs={nowMs}
                      onSelect={() => {
                        const destination = thread.kind === "session"
                          ? sessionSelectRoute(thread, route)
                          : threadSelectRoute(thread, route);
                        navigate(destination);
                      }}
                      onOpen={() => navigate(thread.kind === "session" ? sessionOpenRoute(thread, route) : threadOpenRoute(thread, route))}
                      rowRef={(el) => {
                        if (el) rowRefs.current.set(thread.id, el);
                        else rowRefs.current.delete(thread.id);
                      }}
                    />
                  );
                })}
              </div>
            );
          })}

          {!initialLoading && items.length === 0 ? (
            error && !hasModelData ? (
              <ProjectSurfaceState tone="error" title="Projects unavailable" detail={error} />
            ) : showProjectZeroState ? (
              <div className="pi-empty">
                <ProjectZeroComposer route={route} navigate={navigate} projects={model.projects} />
              </div>
            ) : waiting ? (
              <div className="pi-empty">Loading…</div>
            ) : (
              <ProjectSurfaceState
                title={emptyLabel(scoped, mode)}
              />
            )
          ) : null}
        </div>
      )}
    </div>
  );
}

function emptyLabel(scoped: boolean, mode: ProjectMode): string {
  if (scoped && mode === "agents") return "No visible agents in this project.";
  if (scoped) return "No sessions in this project yet.";
  return "No projects yet.";
}
