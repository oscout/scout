/**
 * Sidebar primary-area model (SCO-083).
 *
 * Two explicit layers:
 * 1. PRIMARY_AREAS — 8 primary navigation destinations (area id, label, icon,
 *    default route, visibility/default-route policy).
 * 2. ROUTE_AREA_BY_VIEW — exhaustive compile-time map of every Route["view"] to
 *    exactly one PrimaryAreaId. Sidebar active state is
 *    primaryAreaForRoute(route) === area.id.
 *
 * Destination predicates in nav-destinations.ts continue to drive secondary
 * nav and command/shortcut projections unchanged.
 *
 * History: the sco-083 sidebar-navigation worklog series was removed from the
 * tree after its PRs merged; see git history.
 */
import type { LucideIcon } from "lucide-react";
import {
  Compass,
  FileText,
  FolderKanban,
  House,
  MessageSquare,
  Search,
  Send,
  Settings,
} from "lucide-react";
import type { Route } from "../lib/types.ts";

export type PrimaryAreaId =
  | "home"
  | "projects"
  | "sessions"
  | "chat"
  | "dispatch"
  | "search"
  | "ops"
  | "settings";

export type PrimaryAreaSection = "navigate" | "system";

export type PrimaryArea = {
  id: PrimaryAreaId;
  label: string;
  icon: LucideIcon;
  /** Default route when the area is selected (before gate policy). */
  defaultRoute: Route;
  section: PrimaryAreaSection;
};

/**
 * Eight primary areas. Navigate section first (Home…Search), then System
 * (Ops, Settings). Icons are for the sidebar icon rail; labels match product
 * nouns.
 */
export const PRIMARY_AREAS: readonly PrimaryArea[] = [
  {
    id: "home",
    label: "Home",
    icon: House,
    defaultRoute: { view: "inbox" },
    section: "navigate",
  },
  {
    id: "chat",
    label: "Messages",
    icon: MessageSquare,
    defaultRoute: { view: "messages" },
    section: "navigate",
  },
  {
    id: "projects",
    label: "Projects",
    icon: FolderKanban,
    defaultRoute: { view: "agents-v2" },
    section: "navigate",
  },
  {
    id: "sessions",
    label: "Sessions",
    icon: FileText,
    defaultRoute: { view: "sessions" },
    section: "navigate",
  },
  {
    id: "dispatch",
    label: "Dispatch",
    icon: Send,
    defaultRoute: { view: "broker" },
    section: "navigate",
  },
  {
    id: "search",
    label: "Search",
    icon: Search,
    defaultRoute: { view: "search" },
    section: "navigate",
  },
  {
    id: "ops",
    label: "Operations",
    icon: Compass,
    // Catalog default is Mission Control; gate policy may redirect to Tail.
    defaultRoute: { view: "ops", mode: "mission" },
    section: "system",
  },
  {
    id: "settings",
    label: "Settings",
    icon: Settings,
    defaultRoute: { view: "settings", section: "appearance" },
    section: "system",
  },
] as const;

/**
 * Exhaustive view → primary area map. Proves every Route["view"] union member
 * is classified. Runtime tests assert 8 non-empty buckets and exactly 22 keys.
 *
 * Note: `follow` is a transient resolver; primaryAreaForRoute may prefer a
 * resolved target area from preferredView when present.
 */
export const ROUTE_AREA_BY_VIEW = {
  inbox: "home",
  activity: "home",
  briefings: "home",
  "agents-v2": "projects",
  "agent-info": "projects",
  repos: "projects",
  "repo-diff": "projects",
  code: "projects",
  sessions: "sessions",
  terminal: "sessions",
  messages: "chat",
  conversation: "chat",
  broker: "dispatch",
  work: "dispatch",
  follow: "dispatch",
  search: "search",
  ops: "ops",
  mesh: "ops",
  "mesh-ops": "ops",
  harnesses: "ops",
  settings: "settings",
  voice: "settings",
} as const satisfies Record<Route["view"], PrimaryAreaId>;

const AREA_BY_ID: ReadonlyMap<PrimaryAreaId, PrimaryArea> = new Map(
  PRIMARY_AREAS.map((area) => [area.id, area]),
);

export function getPrimaryArea(id: PrimaryAreaId): PrimaryArea {
  const area = AREA_BY_ID.get(id);
  if (!area) {
    throw new Error(`Unknown primary area: ${id}`);
  }
  return area;
}

/**
 * Resolve the primary area for a route. FollowScreen is a transient resolver:
 * when preferredView is set, active area follows the resolved target; otherwise
 * the view falls back to Dispatch (ROUTE_AREA_BY_VIEW.follow).
 */
export function primaryAreaForRoute(route: Route): PrimaryAreaId {
  if (route.view === "follow" && route.preferredView) {
    switch (route.preferredView) {
      case "tail":
        return "ops";
      case "session":
        return "sessions";
      case "chat":
        return "chat";
      case "work":
        return "dispatch";
      default:
        break;
    }
  }
  return ROUTE_AREA_BY_VIEW[route.view];
}

/**
 * Default route for an area, applying Ops gate policy:
 * - ops.control on → Mission Control
 * - ops.control off → Tail (ungated surface; Lanes also ungated but Tail is
 *   the historical primary ungated ops entry)
 *
 * Ops area itself stays visible either way; only context entries are gated.
 */
export function defaultRouteForArea(
  areaId: PrimaryAreaId,
  options?: { opsControlEnabled?: boolean },
): Route {
  const area = getPrimaryArea(areaId);
  if (areaId === "ops") {
    const opsControlEnabled = options?.opsControlEnabled ?? true;
    if (opsControlEnabled) {
      return { view: "ops", mode: "mission" };
    }
    return { view: "ops", mode: "tail" };
  }
  return area.defaultRoute;
}

/** Areas in the Navigate section (order stable). */
export function navigatePrimaryAreas(): readonly PrimaryArea[] {
  return PRIMARY_AREAS.filter((area) => area.section === "navigate");
}

/** Areas in the System section (order stable). */
export function systemPrimaryAreas(): readonly PrimaryArea[] {
  return PRIMARY_AREAS.filter((area) => area.section === "system");
}

/** All Route["view"] keys classified by the area map. */
export function allRouteViews(): readonly Route["view"][] {
  return Object.keys(ROUTE_AREA_BY_VIEW) as Route["view"][];
}

/** Bucket every view under its primary area (for integrity tests). */
export function routeViewsByArea(): Record<PrimaryAreaId, Route["view"][]> {
  const buckets = Object.fromEntries(
    PRIMARY_AREAS.map((area) => [area.id, [] as Route["view"][]]),
  ) as Record<PrimaryAreaId, Route["view"][]>;
  for (const [view, areaId] of Object.entries(ROUTE_AREA_BY_VIEW) as Array<
    [Route["view"], PrimaryAreaId]
  >) {
    buckets[areaId].push(view);
  }
  return buckets;
}
