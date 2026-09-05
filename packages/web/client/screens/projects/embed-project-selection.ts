import type { ScoutbotUiAction } from "../../lib/scoutbot.ts";
import type { Route } from "../../lib/types.ts";
import {
  resolveProjectSlugFromRoot,
  type ProjectsInboxModel,
} from "./projects-inbox-model.ts";

export type SelectProjectAction = Extract<ScoutbotUiAction, { type: "select-project" }>;

type AgentsRoute = Extract<Route, { view: "agents-v2" }>;

export function projectSelectionRoute(
  model: ProjectsInboxModel,
  root: string | null,
  route: AgentsRoute,
): AgentsRoute {
  const slug = root ? resolveProjectSlugFromRoot(model, root) : null;
  return {
    view: "agents-v2",
    ...(slug ? { projectSlug: slug } : {}),
    ...(route.machineId ? { machineId: route.machineId } : {}),
    ...(route.showEphemeral ? { showEphemeral: true } : {}),
  };
}

type EmbedProjectSelectionHandler = (
  action: SelectProjectAction,
  navigate: (route: Route) => void,
) => void;

let handler: EmbedProjectSelectionHandler | null = null;

export function registerEmbedProjectSelectionHandler(
  next: EmbedProjectSelectionHandler | null,
): void {
  handler = next;
}

export function applyEmbedProjectSelection(
  action: SelectProjectAction,
  navigate: (route: Route) => void,
): void {
  handler?.(action, navigate);
}
