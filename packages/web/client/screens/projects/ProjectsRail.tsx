import { useCallback, useMemo, useState } from "react";
import { ChevronDown, Folder, FolderPlus, Search, X } from "lucide-react";
import type { Route } from "../../lib/types.ts";
import { timeAgo } from "../../lib/time.ts";
import { AddProjectForm } from "./AddProjectForm.tsx";
import { shortHomePath } from "./project-overview-helpers.ts";
import { useProjectsInbox } from "./useProjectsInbox.ts";
import { resolveProjectSlug, type InboxProject } from "./projects-inbox-model.ts";
import "./projects-inbox.css";

type Navigate = (route: Route) => void;
type ProjectSort = "recent" | "name";

function projectState(project: InboxProject): "needs" | "working" | "idle" {
  if (project.needs > 0) return "needs";
  if (project.working > 0 || project.liveSessionCount > 0) return "working";
  return "idle";
}

function projectSearchText(project: InboxProject): string {
  return [project.title, project.slug, project.root ?? ""].join(" ").toLowerCase();
}

export function filterAndSortProjects(
  projects: InboxProject[],
  query: string,
  sort: ProjectSort,
): InboxProject[] {
  const needle = query.trim().toLowerCase();
  const filtered = needle
    ? projects.filter((project) => projectSearchText(project).includes(needle))
    : projects;

  return [...filtered].sort((left, right) => {
    if (sort === "name") return left.title.localeCompare(right.title);
    return right.lastActivityAt - left.lastActivityAt || left.title.localeCompare(right.title);
  });
}

function RailLoadingRows({ rows = 7 }: { rows?: number }) {
  return (
    <div className="pi-railLoading" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <div className="pi-projectGroup pi-projectGroup--loading" key={index}>
          <div className="pi-projectGroupHead pi-projectGroupHead--flat">
            <span className="pi-projectPath pi-projectPath--flat">
              <Folder size={13} strokeWidth={1.6} aria-hidden />
              <span className="pi-projectPathStack">
                <span className="pi-loadingLine pi-loadingLine--railProject" />
                <span className="pi-loadingLine pi-loadingLine--railRoot" />
              </span>
            </span>
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
  const [addingProject, setAddingProject] = useState(false);

  const projects = useMemo(
    () => filterAndSortProjects(zeroPreview ? [] : model.projects, query, sort),
    [model.projects, query, sort, zeroPreview],
  );
  const selectedProjectSlug = route.projectSlug
    ? resolveProjectSlug(model, route.projectSlug) ?? route.projectSlug
    : undefined;
  const initialLoading = loading && model.projects.length === 0 && !zeroPreview;

  const openProject = useCallback((slug: string) => {
    navigate({
      view: "agents-v2",
      projectSlug: slug,
      ...(route.machineId ? { machineId: route.machineId } : {}),
      ...(route.showEphemeral ? { showEphemeral: true } : {}),
    });
  }, [navigate, route.machineId, route.showEphemeral]);

  return (
    <nav className="s-pi s-pi-rail" aria-label="Projects" aria-busy={loading || undefined} data-loading={loading || undefined}>
      <div className="pi-railFind" role="search">
        <Search size={13} strokeWidth={1.8} aria-hidden />
        <input
          className="pi-railFindInput"
          type="search"
          value={query}
          placeholder="Find project"
          aria-label="Find project"
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
          ) : error && projects.length === 0 ? (
            <div className="pi-railEmpty">Projects unavailable.</div>
          ) : projects.length === 0 ? (
            <div className="pi-railEmpty">{query ? "No projects matched." : "No projects yet."}</div>
          ) : (
            <div className="pi-projectIndex">
              {projects.map((project) => (
                <ProjectRailRow
                  key={project.slug}
                  project={project}
                  selected={selectedProjectSlug === project.slug}
                  nowMs={nowMs}
                  onOpen={openProject}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="pi-railFoot">
        <button type="button" className="pi-railFootBtn" onClick={() => navigate({ view: "search" })}>
          <Search size={13} strokeWidth={1.8} aria-hidden />
          Search all Scout
        </button>
      </div>
    </nav>
  );
}

function ProjectRailRow({
  project,
  selected,
  nowMs,
  onOpen,
}: {
  project: InboxProject;
  selected: boolean;
  nowMs: number;
  onOpen: (slug: string) => void;
}) {
  const state = projectState(project);
  const activity = project.lastActivityAt ? timeAgo(project.lastActivityAt, nowMs) : "No activity";
  return (
    <div className="pi-projectGroup pi-projectGroup--flat" data-selected={selected || undefined} data-state={state}>
      <div className="pi-projectGroupHead pi-projectGroupHead--flat">
        <button
          type="button"
          className="pi-projectPath pi-projectPath--flat"
          title={project.root ?? project.title}
          aria-current={selected ? "page" : undefined}
          aria-label={`Open /${project.title}`}
          onClick={() => onOpen(project.slug)}
        >
          <Folder size={13} strokeWidth={1.6} aria-hidden />
          <span className="pi-projectPathStack">
            <span className="pi-projectPathText">/{project.title}</span>
            <span className="pi-projectPathMeta">
              <span>{project.root ? shortHomePath(project.root) : "Discovered project"}</span>
              <span aria-hidden>·</span>
              <span>{project.worktreeCount} {project.worktreeCount === 1 ? "worktree" : "worktrees"}</span>
              <span aria-hidden>·</span>
              <time>{activity}</time>
            </span>
          </span>
          {state !== "idle" ? (
            <span className="pi-projectState" data-state={state}>
              {state === "needs" ? "Needs you" : "Active"}
            </span>
          ) : null}
        </button>
      </div>
    </div>
  );
}
