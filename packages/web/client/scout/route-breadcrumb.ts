/**
 * Neutral route breadcrumb labels for the slim top utility bar.
 *
 * Extracted from topNavConfig so breadcrumbs survive deletion of the top-tab
 * projection (SCO-083). Prefer this module for new call sites.
 */
import type { Route } from "../lib/types.ts";

/** Human labels for primary/detail route views used in breadcrumbs and chrome. */
export const ROUTE_VIEW_LABELS: Record<string, string> = {
  inbox: "Home",
  conversation: "Conversation",
  "agent-info": "Agent",
  "agents-v2": "Projects",
  messages: "Messages",
  sessions: "Sessions",
  terminal: "Terminals",
  repos: "Repositories",
  "repo-diff": "Diff",
  harnesses: "Agent Providers",
  search: "Search",
  activity: "Activity Log",
  briefings: "Briefings",
  mesh: "Network",
  "mesh-ops": "Mesh Ops",
  broker: "Dispatch",
  settings: "Settings",
  work: "Work",
  follow: "Follow",
  code: "Code Browser",
  ops: "Operations",
  voice: "Live Voice",
};

/**
 * Breadcrumb text for the current route, or null when the top-level primary
 * destination already conveys the location (Home, Sessions, etc.).
 *
 * Complete for primary/detail routes that benefit from a detail crumb.
 */
export function routeBreadcrumbForRoute(route: Route): string | null {
  if (route.view === "settings" && route.section === "agents") {
    return "Configuration";
  }
  switch (route.view) {
    case "conversation":
    case "agent-info":
    case "repos":
    case "repo-diff":
    case "harnesses":
    case "mesh":
    case "mesh-ops":
    case "broker":
    case "work":
    case "code":
    case "briefings":
    case "activity":
    case "follow":
    case "terminal":
    case "voice":
      return ROUTE_VIEW_LABELS[route.view] ?? route.view;
    case "ops": {
      if (route.mode === "tail") return "Live Activity";
      if (route.mode === "lanes") return "Agent Lanes";
      if (route.mode === "atop") return "Runtime Monitor";
      if (route.mode === "plan") return "Plans";
      if (route.mode === "mission" || route.mode === "issues" || route.mode === undefined) {
        return "Mission Control";
      }
      return ROUTE_VIEW_LABELS.ops ?? "Operations";
    }
    case "settings":
      return "Settings";
    case "inbox":
    case "agents-v2":
    case "sessions":
    case "messages":
    case "search":
    default:
      return null;
  }
}
