import "../../scout/slots/ctx-panel.css";
import "./agents-rail.css";
import { useScout } from "../../scout/Provider.tsx";
import { AgentAvatar } from "../../components/AgentAvatar.tsx";
import { useAgentDirectory } from "./useAgentDirectory.ts";
import { dirProjectNeeds, dirProjectWorking } from "./model.ts";

/**
 * Agents rail — the project navigator. Search / New chat sit on top as actions,
 * then the projects list (live-first): a pip, harness-hue dots, and a working /
 * needs / count readout. Selecting a project drives the detail via the route's
 * `projectSlug`. The roster lives inside a project now, not in this lane.
 */
export function AgentsLeft() {
  const { route, navigate, openContextCapture } = useScout();
  const { projects } = useAgentDirectory();
  const selectedProjectSlug = route.view === "agents-v2" ? route.projectSlug : undefined;
  const selectedAgentId = route.view === "agents-v2" ? route.agentId : undefined;
  // The detail pane falls back to the first project when the route carries no
  // slug; mirror that here so the rail highlights whatever the content shows.
  const effectiveSlug = selectedProjectSlug ?? projects[0]?.slice.slug;

  return (
    <div className="ctx-panel s-agents-rail">
      <div className="s-agents-recent s-rail-projects">
        {projects.length === 0 ? (
          <div className="ctx-panel-empty">No projects yet</div>
        ) : (
          projects.map((project) => {
            const working = dirProjectWorking(project);
            const needs = dirProjectNeeds(project);
            const selected = project.slice.slug === effectiveSlug && !selectedAgentId;
            return (
              <button
                key={project.slice.key}
                type="button"
                className="s-rail-proj"
                data-selected={selected || undefined}
                data-live={working > 0 || undefined}
                data-needs={needs || undefined}
                title={project.slice.root ?? undefined}
                onClick={() => navigate({ view: "agents-v2", projectSlug: project.slice.slug })}
              >
                <AgentAvatar name={project.slice.title} size={22} tile presence={false} />
                <span className="s-rail-proj-name" data-idle={working === 0 || undefined}>
                  <span aria-hidden style={{ opacity: 0.4 }}>/</span>{project.slice.title}
                </span>
                {/* tail — a quiet right-aligned count (studio .railCount). Dim mono
                    for working-only projects; rendered in --accent (no pulsing
                    halo) when the project needs you. Idle shows nothing. */}
                {working > 0 ? (
                  <span
                    className="s-rail-proj-count"
                    data-needs={needs || undefined}
                    title={needs ? "needs you" : undefined}
                  >
                    {working}
                  </span>
                ) : null}
              </button>
            );
          })
        )}
      </div>

      <div className="s-agents-foot s-rail-foot-icons">
        <button type="button" className="s-rail-icon" title="Search" aria-label="Search" onClick={() => navigate({ view: "search" })}>
          <IcoSearch />
        </button>
        <button
          type="button"
          className="s-rail-icon"
          title="New chat (⌘⌥N)"
          aria-label="New chat"
          onClick={() => openContextCapture()}
        >
          <IcoPlus />
        </button>
        <button
          type="button"
          className="s-rail-icon s-rail-icon--end"
          title="Settings"
          aria-label="Settings"
          onClick={() => navigate({ view: "settings" })}
        >
          <IcoGear />
        </button>
      </div>

    </div>
  );
}

function IcoSearch() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="7" cy="7" r="4.25" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function IcoPlus() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function IcoGear() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="2.25" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M8 1.5v1.6M8 12.9v1.6M14.5 8h-1.6M3.1 8H1.5M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1M12.6 12.6l-1.1-1.1M4.5 4.5 3.4 3.4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}
