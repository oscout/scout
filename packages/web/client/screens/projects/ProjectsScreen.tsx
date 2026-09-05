import type { Route } from "../../lib/types.ts";
import { useScout } from "../../scout/Provider.tsx";
import { defineSurface } from "../../surfaces/types.ts";
import { ProjectsInbox } from "./ProjectsInbox.tsx";
import { ProjectAgentProfile } from "./ProjectAgentProfile.tsx";
import { useHostProjectSelection } from "./useHostProjectSelection.ts";
import { isProjectAgentProfileRoute } from "./model.ts";
import "./projects.css";
import "./projects-inbox.css";

export function ProjectsScreen({
  route,
  navigate,
  embedded = false,
}: {
  route: Extract<Route, { view: "agents-v2" }>;
  navigate: (route: Route) => void;
  embedded?: boolean;
}) {
  const isProfile = isProjectAgentProfileRoute(route);
  const stageKey = isProfile ? `profile:${route.agentId}` : "index";
  const zeroPreview = !isProfile && projectsZeroPreviewEnabled();

  return (
    <div className="s-av2" data-view={isProfile ? "profile" : "index"}>
      <div key={stageKey} className="av2-stagePane">
        {isProfile ? (
          <ProjectAgentProfile route={route} navigate={navigate} />
        ) : (
          <ProjectsInbox route={route} navigate={navigate} zeroPreview={zeroPreview} embedded={embedded} />
        )}
      </div>
    </div>
  );
}

export function ProjectsEmbedScreen({
  navigate,
  embedded = false,
}: {
  navigate: (route: Route) => void;
  embedded?: boolean;
}) {
  const { route } = useScout();
  const projectsRoute: Extract<Route, { view: "agents-v2" }> = route.view === "agents-v2"
    ? route
    : { view: "agents-v2" };

  useHostProjectSelection(projectsRoute, navigate);

  return (
    <div className="pi-projectsEmbedShell">
      <ProjectsScreen route={projectsRoute} navigate={navigate} embedded={embedded} />
    </div>
  );
}

export const scoutSurface = defineSurface({
  id: "projects",
  label: "Projects",
  route: { view: "agents-v2" },
  webPath: "/projects",
  screen: "ProjectsEmbedScreen",
  embed: {
    path: "/embed/projects",
    profile: "macos.projects",
    // Project/profile drill-down belongs to this document. Routes to a
    // conversation, session, terminal, or another product area belong to the
    // native shell and are forwarded through its navigation bridge.
    ownsInternalRoutes: true,
    rootClassName: "s-projects-embed",
    chrome: { showSecondaryNav: false, showPageStatusBar: false },
    hosts: { macos: true },
  },
});

function projectsZeroPreviewEnabled(): boolean {
  if (typeof window === "undefined") return false;
  const host = window.location.hostname.toLowerCase();
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") return false;
  const value = new URLSearchParams(window.location.search).get("zero")?.trim().toLowerCase();
  return value === "projects" || value === "project" || value === "1" || value === "true";
}
