/* Projects & Agents — two honest views over one directory.

   Projects is the default: one compact row per known project. Agents shows
   durable identities only: one base coding agent per project plus unbound
   named role definitions. Runtime sessions remain in the Sessions surface. */

import { useMemo, useState } from "react";
import { Folder, FolderOpen, FolderPlus, MessageSquare, Rows3, Search, SlidersHorizontal, Telescope, Users } from "lucide-react";
import { AgentAvatar } from "../../components/AgentAvatar.tsx";
import { timeAgo } from "../../lib/time.ts";
import type { Agent, Route } from "../../lib/types.ts";
import { AddProjectForm } from "./AddProjectForm.tsx";
import {
  buildCrewMembers,
  crewStatusLabel,
  memberMatchesQuery,
  memberMatchesStatus,
  projectMatchesQuery,
  projectMatchesStatus,
  type CrewMember,
  type CrewStatusFilter,
  type CrewSubstrate,
} from "./crew-workspaces-model.ts";
import { openProjectAgentProfile } from "./model.ts";
import { shortHomePath } from "./project-overview-helpers.ts";
import type { InboxProject, InboxThread, ProjectsInboxModel } from "./projects-inbox-model.ts";
import "./crew-workspaces.css";

type Navigate = (route: Route) => void;
type DirectoryMode = "projects" | "agents";

const STATUS_FILTERS: Array<{ id: CrewStatusFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "needs", label: "Needs attention" },
  { id: "idle", label: "Idle" },
];

function openChat(navigate: Navigate, conversationId: string | null): void {
  if (conversationId) {
    navigate({ view: "conversation", conversationId });
    return;
  }
  navigate({ view: "messages" });
}

function openCode(navigate: Navigate, projectSlug: string): void {
  navigate({ view: "code", project: projectSlug });
}

function openInspect(
  navigate: Navigate,
  route: Extract<Route, { view: "agents-v2" }>,
  agentId: string,
): void {
  navigate(openProjectAgentProfile(route, agentId));
}

function openProject(
  navigate: Navigate,
  route: Extract<Route, { view: "agents-v2" }>,
  projectSlug: string,
): void {
  navigate({
    view: "agents-v2",
    projectSlug,
    ...(route.machineId ? { machineId: route.machineId } : {}),
    ...(route.showEphemeral ? { showEphemeral: true } : {}),
  });
}

export function CrewWorkspaces({
  model,
  agents,
  route,
  navigate,
  nowMs,
}: {
  model: ProjectsInboxModel;
  agents: Agent[];
  route: Extract<Route, { view: "agents-v2" }>;
  navigate: Navigate;
  nowMs: number;
}) {
  const [mode, setMode] = useState<DirectoryMode>("projects");
  const [statusFilter, setStatusFilter] = useState<CrewStatusFilter>("all");
  const [query, setQuery] = useState("");
  const [addingProject, setAddingProject] = useState(false);

  const members = useMemo(
    () => buildCrewMembers(model.projects, model.threads, agents, route.machineId ?? null),
    [agents, model.projects, model.threads, route.machineId],
  );
  const filteredMembers = useMemo(
    () => members.filter(
      (member) => memberMatchesStatus(member, statusFilter) && memberMatchesQuery(member, query),
    ),
    [members, query, statusFilter],
  );
  const filteredProjects = useMemo(
    () => model.projects.filter(
      (project) => projectMatchesStatus(project, statusFilter) && projectMatchesQuery(project, query),
    ),
    [model.projects, query, statusFilter],
  );

  const activeProjects = model.projects.filter((project) => project.working > 0 || project.liveSessionCount > 0).length;
  const needsProjects = model.projects.filter((project) => project.needs > 0).length;
  const activeAgents = members.filter((member) => member.status === "working" || member.status === "thinking").length;
  const needsAgents = members.filter((member) => member.status === "needs").length;
  const projectAgentCount = members.filter((member) => member.kind === "project").length;
  const roleAgentCount = members.filter((member) => member.kind === "role").length;

  return (
    <main className="cw-root" aria-label="Projects and agents">
      <div className="cw-toolbar">
        <div className="cw-modeToggle" role="group" aria-label="Directory view">
          <button
            type="button"
            data-active={mode === "projects" || undefined}
            aria-pressed={mode === "projects"}
            onClick={() => setMode("projects")}
            title="Browse tracked projects"
          >
            <Rows3 size={13} strokeWidth={1.9} aria-hidden />
            Projects
          </button>
          <button
            type="button"
            data-active={mode === "agents" || undefined}
            aria-pressed={mode === "agents"}
            onClick={() => setMode("agents")}
            title="Browse durable agent identities"
          >
            <Users size={13} strokeWidth={1.9} aria-hidden />
            Agents
          </button>
        </div>

        <label className="cw-search" role="search">
          <Search size={13} strokeWidth={1.8} aria-hidden />
          <input
            type="search"
            value={query}
            placeholder={mode === "projects" ? "Find project" : "Find agent or project"}
            aria-label={mode === "projects" ? "Find project" : "Find agent or project"}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </label>

        <div className="cw-filters" aria-label="Status filter">
          <SlidersHorizontal size={12} strokeWidth={1.9} aria-hidden className="cw-filtersIcon" />
          {STATUS_FILTERS.map((filter) => (
            <button
              key={filter.id}
              type="button"
              data-active={statusFilter === filter.id || undefined}
              aria-pressed={statusFilter === filter.id}
              onClick={() => setStatusFilter(filter.id)}
            >
              {filter.label}
            </button>
          ))}
        </div>

        <button
          type="button"
          className="cw-addProject"
          aria-expanded={addingProject}
          onClick={() => setAddingProject((open) => !open)}
        >
          <FolderPlus size={13} strokeWidth={1.9} aria-hidden />
          Add project
        </button>
      </div>

      {addingProject ? <AddProjectForm onClose={() => setAddingProject(false)} /> : null}

      <div className="cw-digest">
        {mode === "projects" ? (
          <>
            <span>{model.projects.length} projects</span>
            <span className="cw-digestSep">·</span>
            <span data-tone={activeProjects > 0 ? "live" : undefined}>{activeProjects} active</span>
            {needsProjects > 0 ? (
              <>
                <span className="cw-digestSep">·</span>
                <span data-tone="needs">{needsProjects} need you</span>
              </>
            ) : null}
          </>
        ) : (
          <>
            <span>{projectAgentCount} project agents</span>
            {roleAgentCount > 0 ? (
              <>
                <span className="cw-digestSep">·</span>
                <span>{roleAgentCount} role {roleAgentCount === 1 ? "agent" : "agents"}</span>
              </>
            ) : null}
            <span className="cw-digestSep">·</span>
            <span data-tone={activeAgents > 0 ? "live" : undefined}>{activeAgents} active</span>
            {needsAgents > 0 ? (
              <>
                <span className="cw-digestSep">·</span>
                <span data-tone="needs">{needsAgents} need you</span>
              </>
            ) : null}
          </>
        )}
      </div>

      {mode === "projects" ? (
        <ProjectList projects={filteredProjects} route={route} navigate={navigate} nowMs={nowMs} allEmpty={model.projects.length === 0} />
      ) : (
        <AgentDirectory members={filteredMembers} route={route} navigate={navigate} nowMs={nowMs} allEmpty={members.length === 0} />
      )}
    </main>
  );
}

/** Scoped project directory: exactly one durable coding identity. */
export function ProjectAgentDirectory({
  project,
  threads,
  route,
  navigate,
  nowMs,
}: {
  project: InboxProject;
  threads: InboxThread[];
  route: Extract<Route, { view: "agents-v2" }>;
  navigate: Navigate;
  nowMs: number;
}) {
  const member = buildCrewMembers([project], threads, [])[0]!;
  return (
    <main className="cw-root cw-root--scoped" aria-label={`${project.title} agent`}>
      <AgentSection
        title="Project agent"
        members={[member]}
        route={route}
        navigate={navigate}
        nowMs={nowMs}
      />
    </main>
  );
}

function ProjectList({
  projects,
  route,
  navigate,
  nowMs,
  allEmpty,
}: {
  projects: InboxProject[];
  route: Extract<Route, { view: "agents-v2" }>;
  navigate: Navigate;
  nowMs: number;
  allEmpty: boolean;
}) {
  if (projects.length === 0) {
    return <div className="cw-empty">{allEmpty ? "No projects are tracked yet." : "No projects match these filters."}</div>;
  }

  return (
    <div className="cw-workspaceList">
      {projects.map((project) => (
        <ProjectRow key={project.slug} project={project} route={route} navigate={navigate} nowMs={nowMs} />
      ))}
    </div>
  );
}

function ProjectRow({
  project,
  route,
  navigate,
  nowMs,
}: {
  project: InboxProject;
  route: Extract<Route, { view: "agents-v2" }>;
  navigate: Navigate;
  nowMs: number;
}) {
  const active = project.working > 0 || project.liveSessionCount > 0;
  return (
    <article className="cw-workspace" data-state={project.needs > 0 ? "needs" : active ? "live" : undefined}>
      <button type="button" className="cw-workspaceHead" onClick={() => openProject(navigate, route, project.slug)}>
        <span className="cw-workspaceTitle">
          <Folder size={13} strokeWidth={1.7} aria-hidden />
          /{project.title}
        </span>
        <span className="cw-workspaceRoot" title={project.root ?? undefined}>
          {project.root ? shortHomePath(project.root) : "Discovered project"}
        </span>
        <span className="cw-workspaceMeta">
          {project.needs > 0 ? <b data-tone="needs">Needs you</b> : null}
          {active ? <b data-tone="live">Active</b> : null}
          <span>{project.worktreeCount} {project.worktreeCount === 1 ? "worktree" : "worktrees"}</span>
          <span>{project.sessionCount} {project.sessionCount === 1 ? "session" : "sessions"}</span>
          <time>{project.lastActivityAt ? timeAgo(project.lastActivityAt, nowMs) : "no activity"}</time>
        </span>
      </button>
    </article>
  );
}

function AgentDirectory({
  members,
  route,
  navigate,
  nowMs,
  allEmpty,
}: {
  members: CrewMember[];
  route: Extract<Route, { view: "agents-v2" }>;
  navigate: Navigate;
  nowMs: number;
  allEmpty: boolean;
}) {
  if (members.length === 0) {
    return <div className="cw-empty">{allEmpty ? "No durable agents are registered yet." : "No agents match these filters."}</div>;
  }

  const roleAgents = members.filter((member) => member.kind === "role");
  const projectAgents = members.filter((member) => member.kind === "project");
  return (
    <div className="cw-agentDirectory">
      {roleAgents.length > 0 ? (
        <AgentSection title="Role agents" members={roleAgents} route={route} navigate={navigate} nowMs={nowMs} />
      ) : null}
      {projectAgents.length > 0 ? (
        <AgentSection title="Project agents" members={projectAgents} route={route} navigate={navigate} nowMs={nowMs} />
      ) : null}
    </div>
  );
}

function AgentSection({
  title,
  members,
  route,
  navigate,
  nowMs,
}: {
  title: string;
  members: CrewMember[];
  route: Extract<Route, { view: "agents-v2" }>;
  navigate: Navigate;
  nowMs: number;
}) {
  return (
    <section className="cw-agentSection" aria-label={title}>
      <div className="cw-agentSectionHead">
        <h2>{title}</h2>
        <span>{members.length}</span>
      </div>
      <div className="cw-grid">
        {members.map((member) => (
          <AgentCard key={member.key} member={member} route={route} navigate={navigate} nowMs={nowMs} />
        ))}
      </div>
    </section>
  );
}

function AgentCard({
  member,
  route,
  navigate,
  nowMs,
}: {
  member: CrewMember;
  route: Extract<Route, { view: "agents-v2" }>;
  navigate: Navigate;
  nowMs: number;
}) {
  const primary = member.primary;
  return (
    <article className="cw-card" data-status={member.status} data-kind={member.kind}>
      <header className="cw-cardHead">
        <AgentAvatar
          agent={{ name: member.name, state: statusToAvatarState(member.status) }}
          placement="hero"
          size={46}
          presence
        />
        <div className="cw-cardIdentity">
          <div className="cw-cardNameRow">
            <b title={member.name}>{member.name}</b>
            <span className="cw-statusPill" data-status={member.status}>
              {crewStatusLabel(member.status)}
            </span>
          </div>
          <div className="cw-cardSubline">
            <span className="cw-headline">{member.headline}</span>
          </div>
        </div>
      </header>

      {member.kind === "project" && primary ? (
        <div className="cw-projectContext" title={primary.projectRoot ?? undefined}>
          <Folder size={11} strokeWidth={1.8} aria-hidden />
          <span>{primary.projectRoot ? shortHomePath(primary.projectRoot) : `/${primary.projectTitle}`}</span>
          <em>{member.sessionCount} {member.sessionCount === 1 ? "session" : "sessions"}</em>
        </div>
      ) : member.substrates.length > 0 ? (
        <div className="cw-substrates">
          {member.substrates.map((substrate, index) => (
            <SubstrateChip key={substrate.threadId} substrate={substrate} route={route} navigate={navigate} primary={index === 0} />
          ))}
        </div>
      ) : null}

      <div className="cw-work">
        <p title={member.work}>{member.work}</p>
        <time>{member.lastActivityAt ? timeAgo(member.lastActivityAt, nowMs) : "—"}</time>
      </div>

      <footer className="cw-cardActions">
        {member.kind === "project" && primary ? (
          <>
            <button type="button" onClick={() => openProject(navigate, route, primary.projectSlug)}>
              <FolderOpen size={12} strokeWidth={1.9} aria-hidden />
              Open project
            </button>
            <button type="button" onClick={() => openCode(navigate, primary.projectSlug)}>
              <Folder size={12} strokeWidth={1.9} aria-hidden />
              Browse code
            </button>
          </>
        ) : (
          <>
            {member.conversationId ? (
              <button type="button" onClick={() => openChat(navigate, member.conversationId)}>
                <MessageSquare size={12} strokeWidth={1.9} aria-hidden />
                Chat
              </button>
            ) : null}
            {primary ? (
              <button type="button" onClick={() => openCode(navigate, primary.projectSlug)}>
                <Folder size={12} strokeWidth={1.9} aria-hidden />
                Browse code
              </button>
            ) : null}
            {member.agentId ? (
              <button type="button" onClick={() => openInspect(navigate, route, member.agentId!)}>
                <Telescope size={12} strokeWidth={1.9} aria-hidden />
                Inspect
              </button>
            ) : null}
          </>
        )}
      </footer>
    </article>
  );
}

function statusToAvatarState(status: CrewMember["status"]): string {
  switch (status) {
    case "needs":
      return "needs_attention";
    case "working":
      return "in_turn";
    case "thinking":
      return "thinking";
    case "idle":
      return "idle";
  }
}

function SubstrateChip({
  substrate,
  route,
  navigate,
  primary = false,
}: {
  substrate: CrewSubstrate;
  route: Extract<Route, { view: "agents-v2" }>;
  navigate: Navigate;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      className="cw-substrateChip"
      data-primary={primary || undefined}
      data-live={substrate.working || undefined}
      title={substrate.projectRoot ?? undefined}
      onClick={() => openProject(navigate, route, substrate.projectSlug)}
    >
      <Folder size={11} strokeWidth={1.8} aria-hidden />
      <span>{substrate.projectTitle}</span>
      {substrate.branch ? <em>git: {substrate.branch}</em> : null}
    </button>
  );
}
