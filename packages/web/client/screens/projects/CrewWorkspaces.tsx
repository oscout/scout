/* Crew & Workspaces — the agent-first landing for /projects (route agents-v2,
   unscoped). Agents are the first-class actor; projects/repos are the
   substrates attached to each agent.
   Three lenses over the same rows:
   1. "Crew View (Personas)": Grids agents with their attached substrates, runtime, and persona kernel.
   2. "Workspace Lens": Inverts the rows to group by repository workspace.
   3. "Runtime Engines": Groups agents by compute engine (Claude, Codex, Grok, Kimi, Cursor, etc.).
   All lenses read projections over the shared inbox model — no separate data loops. */

import { useMemo, useState } from "react";
import { Cpu, Folder, FolderPlus, MessageSquare, Rows3, Search, SlidersHorizontal, Telescope, Users } from "lucide-react";
import { AgentAvatar } from "../../components/AgentAvatar.tsx";
import { HarnessMark } from "../../components/HarnessMark.tsx";
import { timeAgo } from "../../lib/time.ts";
import type { Agent, Route } from "../../lib/types.ts";
import { openProjectAgentProfile } from "./model.ts";
import { shortHomePath } from "./project-overview-helpers.ts";
import { AddProjectForm } from "./AddProjectForm.tsx";
import type { ProjectsInboxModel } from "./projects-inbox-model.ts";
import {
  buildCrewMembers,
  buildRuntimeLens,
  buildWorkspaceLens,
  crewHarnesses,
  crewStatusLabel,
  memberMatchesHarness,
  memberMatchesQuery,
  memberMatchesStatus,
  type CrewMember,
  type CrewStatusFilter,
  type CrewSubstrate,
  type RuntimeCrewStation,
  type RuntimeEntry,
  type WorkspaceCrewStation,
  type WorkspaceEntry,
} from "./crew-workspaces-model.ts";
import "./crew-workspaces.css";

type Navigate = (route: Route) => void;
type CrewMode = "crew" | "workspace" | "runtime";

const STATUS_FILTERS: Array<{ id: CrewStatusFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "needs", label: "Needs attention" },
  { id: "idle", label: "Idle" },
];

function harnessLabel(harness: string): string {
  return harness ? harness.charAt(0).toUpperCase() + harness.slice(1) : "Harness";
}

function openChat(navigate: Navigate, substrate: CrewSubstrate | null): void {
  if (substrate?.conversationId) {
    navigate({ view: "conversation", conversationId: substrate.conversationId });
    return;
  }
  navigate({ view: "messages" });
}

function openCode(navigate: Navigate, projectSlug: string): void {
  navigate({ view: "code", project: projectSlug });
}

function openInspect(navigate: Navigate, route: Extract<Route, { view: "agents-v2" }>, agentId: string | null): void {
  if (!agentId) return;
  navigate(openProjectAgentProfile(route, agentId));
}

function openWorkspace(
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
  const [mode, setMode] = useState<CrewMode>("crew");
  const [statusFilter, setStatusFilter] = useState<CrewStatusFilter>("all");
  const [harnessFilter, setHarnessFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [addingProject, setAddingProject] = useState(false);

  const agentsById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const members = useMemo(() => buildCrewMembers(model.threads, agentsById), [model.threads, agentsById]);
  const workspaces = useMemo(() => buildWorkspaceLens(members, model.projects), [members, model.projects]);
  const runtimes = useMemo(() => buildRuntimeLens(members), [members]);
  const harnesses = useMemo(() => crewHarnesses(members), [members]);

  const filteredMembers = useMemo(
    () =>
      members.filter(
        (member) =>
          memberMatchesStatus(member, statusFilter)
          && memberMatchesHarness(member, harnessFilter)
          && memberMatchesQuery(member, query),
      ),
    [members, statusFilter, harnessFilter, query],
  );

  const filteredWorkspaces = useMemo(
    () =>
      workspaces
        .map((workspace) => ({
          ...workspace,
          crew: workspace.crew.filter(
            (station) =>
              memberMatchesStatus(station.member, statusFilter)
              && memberMatchesHarness(station.member, harnessFilter)
              && memberMatchesQuery(station.member, query),
          ),
        }))
        .filter((workspace) => workspace.crew.length > 0 || (statusFilter === "all" && harnessFilter === "all" && !query.trim())),
    [workspaces, statusFilter, harnessFilter, query],
  );

  const filteredRuntimes = useMemo(
    () =>
      runtimes
        .map((runtime) => ({
          ...runtime,
          crew: runtime.crew.filter(
            (station) =>
              memberMatchesStatus(station.member, statusFilter)
              && memberMatchesHarness(station.member, harnessFilter)
              && memberMatchesQuery(station.member, query),
          ),
        }))
        .filter((runtime) => runtime.crew.length > 0 || (statusFilter === "all" && harnessFilter === "all" && !query.trim())),
    [runtimes, statusFilter, harnessFilter, query],
  );

  const needsCount = members.filter((member) => member.status === "needs").length;
  const activeCount = members.filter((member) => member.status === "working" || member.status === "thinking").length;

  return (
    <main className="cw-root" aria-label="Crew and workspaces">
      <div className="cw-toolbar">
        <div className="cw-modeToggle" role="group" aria-label="View mode">
          <button
            type="button"
            data-active={mode === "crew" || undefined}
            onClick={() => setMode("crew")}
            title="Personas & Agent Crew matrix"
          >
            <Users size={13} strokeWidth={1.9} aria-hidden />
            Crew (Personas)
          </button>
          <button
            type="button"
            data-active={mode === "workspace" || undefined}
            onClick={() => setMode("workspace")}
            title="Group by repository workspace"
          >
            <Rows3 size={13} strokeWidth={1.9} aria-hidden />
            Workspace lens
          </button>
          <button
            type="button"
            data-active={mode === "runtime" || undefined}
            onClick={() => setMode("runtime")}
            title="Group by runtime engine and models"
          >
            <Cpu size={13} strokeWidth={1.9} aria-hidden />
            Runtime engines
          </button>
        </div>

        <label className="cw-search" role="search">
          <Search size={13} strokeWidth={1.8} aria-hidden />
          <input
            type="search"
            value={query}
            placeholder="Find persona, runtime, workspace, or task"
            aria-label="Find persona, runtime, workspace, or task"
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
              onClick={() => setStatusFilter(filter.id)}
            >
              {filter.label}
            </button>
          ))}
        </div>

        <label className="cw-harnessSelect" title="Filter by runtime">
          <span className="pi-srOnly">Filter by runtime</span>
          <select value={harnessFilter} onChange={(event) => setHarnessFilter(event.currentTarget.value)}>
            <option value="all">All runtimes</option>
            {harnesses.map((harness) => (
              <option key={harness} value={harness}>
                {harnessLabel(harness)}
              </option>
            ))}
          </select>
        </label>

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
        <span>{members.length} personas</span>
        <span className="cw-digestSep">·</span>
        <span data-tone={activeCount > 0 ? "live" : undefined}>{activeCount} moving</span>
        {needsCount > 0 ? (
          <>
            <span className="cw-digestSep">·</span>
            <span data-tone="needs">{needsCount} needs you</span>
          </>
        ) : null}
        <span className="cw-digestSep">·</span>
        <span>{model.projects.length} workspaces</span>
        <span className="cw-digestSep">·</span>
        <span>{runtimes.length} runtimes</span>
      </div>

      {mode === "crew" ? (
        <CrewGrid members={filteredMembers} route={route} navigate={navigate} nowMs={nowMs} allEmpty={members.length === 0} />
      ) : mode === "workspace" ? (
        <WorkspaceGrid
          workspaces={filteredWorkspaces}
          route={route}
          navigate={navigate}
          nowMs={nowMs}
          allEmpty={workspaces.length === 0}
        />
      ) : (
        <RuntimeGrid
          runtimes={filteredRuntimes}
          route={route}
          navigate={navigate}
          nowMs={nowMs}
          allEmpty={runtimes.length === 0}
        />
      )}
    </main>
  );
}

function CrewGrid({
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
    return (
      <div className="cw-empty">
        {allEmpty ? "No crew members are registered yet." : "No crew members match these filters."}
      </div>
    );
  }
  return (
    <div className="cw-grid">
      {members.map((member) => (
        <AgentCard key={member.key} member={member} route={route} navigate={navigate} nowMs={nowMs} />
      ))}
    </div>
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
  const extraSubstrates = member.substrates.filter((substrate) => substrate.threadId !== primary.threadId);

  return (
    <article className="cw-card" data-status={member.status}>
      <header className="cw-cardHead">
        <AgentAvatar
          agent={{ name: member.name, harness: member.harness, state: statusToAvatarState(member.status) }}
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
            {member.kernel ? <span className="cw-kernelPill" title={member.kernel}>{member.kernel}</span> : null}
          </div>
        </div>
      </header>

      {/* 3-Coordinate Identity Strip: Persona, Runtime, and Workspace */}
      <div className="cw-coordStrip">
        <div className="cw-runtimeBadge" title={`Runtime: ${harnessLabel(member.harness)}${member.model ? ` · ${member.model}` : ""}${member.effort ? ` (${member.effort})` : ""}`}>
          <HarnessMark harness={member.harness} size={11} />
          <span>{harnessLabel(member.harness)}</span>
          {member.model ? <i>{member.model}</i> : null}
          {member.effort ? <em>{member.effort}</em> : null}
        </div>
      </div>

      <div className="cw-substrates">
        <SubstrateChip substrate={primary} route={route} navigate={navigate} primary />
        {extraSubstrates.map((substrate) => (
          <SubstrateChip key={substrate.threadId} substrate={substrate} route={route} navigate={navigate} />
        ))}
      </div>

      <div className="cw-work">
        <p title={primary.work}>{primary.work}</p>
        <time>{primary.lastActivityAt ? timeAgo(primary.lastActivityAt, nowMs) : "—"}</time>
      </div>

      <footer className="cw-cardActions">
        <button type="button" onClick={() => openChat(navigate, primary)}>
          <MessageSquare size={12} strokeWidth={1.9} aria-hidden />
          Chat
        </button>
        <button type="button" onClick={() => openCode(navigate, primary.projectSlug)}>
          <Folder size={12} strokeWidth={1.9} aria-hidden />
          Browse code
        </button>
        <button type="button" onClick={() => openInspect(navigate, route, member.agentId)}>
          <Telescope size={12} strokeWidth={1.9} aria-hidden />
          Inspect
        </button>
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
      onClick={() => openWorkspace(navigate, route, substrate.projectSlug)}
    >
      <Folder size={11} strokeWidth={1.8} aria-hidden />
      <span>{substrate.projectTitle}</span>
      {substrate.branch ? <em>git: {substrate.branch}</em> : null}
    </button>
  );
}

function WorkspaceGrid({
  workspaces,
  route,
  navigate,
  nowMs,
  allEmpty,
}: {
  workspaces: WorkspaceEntry[];
  route: Extract<Route, { view: "agents-v2" }>;
  navigate: Navigate;
  nowMs: number;
  allEmpty: boolean;
}) {
  if (workspaces.length === 0) {
    return (
      <div className="cw-empty">
        {allEmpty ? "No projects are tracked yet." : "No workspaces match these filters."}
      </div>
    );
  }
  return (
    <div className="cw-workspaceList">
      {workspaces.map((workspace) => (
        <WorkspaceRow key={workspace.slug} workspace={workspace} route={route} navigate={navigate} nowMs={nowMs} />
      ))}
    </div>
  );
}

function WorkspaceRow({
  workspace,
  route,
  navigate,
  nowMs,
}: {
  workspace: WorkspaceEntry;
  route: Extract<Route, { view: "agents-v2" }>;
  navigate: Navigate;
  nowMs: number;
}) {
  return (
    <article className="cw-workspace" data-state={workspace.needs > 0 ? "needs" : workspace.working > 0 ? "live" : undefined}>
      <button type="button" className="cw-workspaceHead" onClick={() => openWorkspace(navigate, route, workspace.slug)}>
        <span className="cw-workspaceTitle">
          <Folder size={13} strokeWidth={1.7} aria-hidden />
          /{workspace.title}
        </span>
        <span className="cw-workspaceRoot" title={workspace.root ?? undefined}>
          {workspace.root ? shortHomePath(workspace.root) : "Discovered project"}
        </span>
        <span className="cw-workspaceMeta">
          {workspace.needs > 0 ? <b data-tone="needs">{workspace.needs} needs you</b> : null}
          {workspace.working > 0 ? <b data-tone="live">{workspace.working} moving</b> : null}
          <span>{workspace.sessionCount} sessions</span>
          <time>{workspace.lastActivityAt ? timeAgo(workspace.lastActivityAt, nowMs) : "no activity"}</time>
        </span>
      </button>

      {workspace.crew.length > 0 ? (
        <div className="cw-workspaceCrew" aria-label="Crew stationed here">
          {workspace.crew.map((station) => (
            <WorkspaceCrewChip key={`${workspace.slug}:${station.member.key}`} station={station} route={route} navigate={navigate} />
          ))}
        </div>
      ) : (
        <div className="cw-workspaceCrewEmpty">No crew stationed here.</div>
      )}
    </article>
  );
}

function WorkspaceCrewChip({
  station,
  route,
  navigate,
}: {
  station: WorkspaceCrewStation;
  route: Extract<Route, { view: "agents-v2" }>;
  navigate: Navigate;
}) {
  const { member, substrate } = station;
  return (
    <button
      type="button"
      className="cw-crewChip"
      data-status={member.status}
      onClick={() => openInspect(navigate, route, member.agentId)}
      title={`${member.name} (${member.headline}) · ${substrate.work}`}
    >
      <AgentAvatar
        agent={{ name: member.name, harness: member.harness, state: statusToAvatarState(member.status) }}
        size={22}
        presence
      />
      <span className="cw-crewChipName">{member.name}</span>
      <span className="cw-crewChipStatus" data-status={member.status}>
        {crewStatusLabel(member.status)}
      </span>
      {substrate.branch ? <span className="cw-crewChipBranch">git: {substrate.branch}</span> : null}
    </button>
  );
}

function RuntimeGrid({
  runtimes,
  route,
  navigate,
  nowMs,
  allEmpty,
}: {
  runtimes: RuntimeEntry[];
  route: Extract<Route, { view: "agents-v2" }>;
  navigate: Navigate;
  nowMs: number;
  allEmpty: boolean;
}) {
  if (runtimes.length === 0) {
    return (
      <div className="cw-empty">
        {allEmpty ? "No runtime engines are active." : "No runtimes match these filters."}
      </div>
    );
  }
  return (
    <div className="cw-runtimeList">
      {runtimes.map((runtime) => (
        <RuntimeRow key={runtime.harness} runtime={runtime} route={route} navigate={navigate} nowMs={nowMs} />
      ))}
    </div>
  );
}

function RuntimeRow({
  runtime,
  route,
  navigate,
  nowMs,
}: {
  runtime: RuntimeEntry;
  route: Extract<Route, { view: "agents-v2" }>;
  navigate: Navigate;
  nowMs: number;
}) {
  return (
    <article className="cw-runtimeRow" data-state={runtime.needs > 0 ? "needs" : runtime.working > 0 ? "live" : undefined}>
      <header className="cw-runtimeHead">
        <div className="cw-runtimeTitle">
          <span className="cw-runtimeHarnessIcon">
            <HarnessMark harness={runtime.harness} size={15} />
          </span>
          <b>{runtime.title} Engine</b>
          <span className="cw-runtimeHarnessSlug">{runtime.harness}</span>
        </div>
        <div className="cw-runtimeMeta">
          {runtime.needs > 0 ? <b data-tone="needs">{runtime.needs} needs you</b> : null}
          {runtime.working > 0 ? <b data-tone="live">{runtime.working} moving</b> : null}
          <span>{runtime.agentCount} {runtime.agentCount === 1 ? "persona" : "personas"}</span>
          <span className="cw-digestSep">·</span>
          <span>{runtime.sessionCount} sessions</span>
          <time>{runtime.lastActivityAt ? timeAgo(runtime.lastActivityAt, nowMs) : "no activity"}</time>
        </div>
      </header>

      {runtime.crew.length > 0 ? (
        <div className="cw-runtimeCrew" aria-label={`Crew running on ${runtime.title}`}>
          {runtime.crew.map((station) => (
            <RuntimeCrewChip key={`${runtime.harness}:${station.member.key}`} station={station} route={route} navigate={navigate} />
          ))}
        </div>
      ) : (
        <div className="cw-runtimeCrewEmpty">No crew running on this harness.</div>
      )}
    </article>
  );
}

function RuntimeCrewChip({
  station,
  route,
  navigate,
}: {
  station: RuntimeCrewStation;
  route: Extract<Route, { view: "agents-v2" }>;
  navigate: Navigate;
}) {
  const { member, substrate } = station;
  return (
    <button
      type="button"
      className="cw-runtimeCrewChip"
      data-status={member.status}
      onClick={() => openInspect(navigate, route, member.agentId)}
      title={`${member.name} (${member.headline}) · ${substrate.projectTitle} · ${substrate.work}`}
    >
      <AgentAvatar
        agent={{ name: member.name, harness: member.harness, state: statusToAvatarState(member.status) }}
        size={24}
        presence
      />
      <div className="cw-runtimeCrewChipText">
        <div className="cw-runtimeCrewChipTop">
          <span className="cw-runtimeCrewChipName">{member.name}</span>
          <span className="cw-runtimeCrewChipStatus" data-status={member.status}>
            {crewStatusLabel(member.status)}
          </span>
        </div>
        <div className="cw-runtimeCrewChipSub">
          <span className="cw-runtimeCrewChipProject">{substrate.projectTitle}</span>
          {member.model ? <span className="cw-runtimeCrewChipModel">{member.model}</span> : null}
        </div>
      </div>
    </button>
  );
}
