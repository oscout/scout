/**
 * Canonical navigation destination catalog + surface projections.
 *
 * Identity (id, label, route, active, capability) lives here once.
 * Surface-specific concerns — tab keys, breadcrumb text, shortcut keys,
 * palette ids/subtitles, dock icons — live in the projections below.
 *
 * History: the sco-082 web-navigation worklog series was removed from the
 * tree after its PRs merged; see git history.
 */
import type { LucideIcon } from "lucide-react";
import {
  Code2,
  Compass,
  FileText,
  GitBranch,
  House,
  ScrollText,
  Search,
  Send,
  Terminal,
} from "lucide-react";
import type { CommandOption } from "@hudsonkit";
import type { SecondaryNavGroup } from "../components/SecondaryNav.tsx";
import type { Route } from "../lib/types.ts";
import { ROUTE_AREA_BY_VIEW } from "./primary-areas.ts";

/** Top-tab keys used by chrome; `system` is a dropdown, not a catalog destination. */
export type TopNavKey =
  | "home"
  | "agents"
  | "chat"
  | "sessions"
  | "system";

export type TopNavItem = {
  key: TopNavKey;
  label: string;
  route: Route;
};

/* ── Catalog ──────────────────────────────────────────────────────────── */

export type NavCapability = "ops.control" | "surface.mesh-ops";

export type NavDestinationId =
  | "home"
  | "projects"
  | "sessions"
  | "chat"
  | "search"
  | "terminals"
  | "tail"
  | "dispatch"
  | "activity"
  | "mesh"
  | "mesh-ops"
  | "mission-control"
  | "lanes"
  | "repos"
  | "code"
  | "providers"
  | "runtime"
  | "advisor"
  | "agent-config";

export type NavDestination = {
  id: NavDestinationId;
  /** Canonical product label for this destination. */
  label: string;
  /** Default route opened when navigating to this destination. */
  route: Route;
  /** Whether the current route is "on" this destination. */
  active: (route: Route) => boolean;
  /** When set, surfaces must hide this destination unless the flag is on. */
  capability?: NavCapability;
};

function isOpsMission(route: Route): boolean {
  return (
    route.view === "ops" &&
    (route.mode === undefined || route.mode === "mission" || route.mode === "issues")
  );
}

/**
 * Single source of truth for every navigable product destination.
 * Projections pick rows from this table; they do not redefine routes/active.
 */
export const NAV_DESTINATIONS: readonly NavDestination[] = [
  {
    id: "home",
    label: "Home",
    route: { view: "inbox" },
    active: (route) => route.view === "inbox",
  },
  {
    id: "projects",
    label: "Crew & Workspaces",
    route: { view: "agents-v2" },
    active: (route) =>
      route.view === "agents-v2" ||
      route.view === "agent-info",
  },
  {
    id: "sessions",
    label: "Sessions",
    route: { view: "sessions" },
    active: (route) => route.view === "sessions",
  },
  {
    id: "chat",
    label: "Messages",
    route: { view: "messages" },
    active: (route) =>
      route.view === "messages" ||
      route.view === "conversation",
  },
  {
    id: "search",
    label: "Search",
    route: { view: "search" },
    active: (route) => route.view === "search",
  },
  {
    id: "terminals",
    label: "Terminals",
    route: { view: "terminal" },
    active: (route) => route.view === "terminal",
  },
  {
    id: "tail",
    label: "Live Activity",
    route: { view: "ops", mode: "tail" },
    active: (route) => route.view === "ops" && route.mode === "tail",
  },
  {
    id: "dispatch",
    label: "Dispatch",
    route: { view: "broker" },
    active: (route) => route.view === "broker",
  },
  {
    id: "activity",
    label: "Activity Log",
    route: { view: "activity" },
    active: (route) => route.view === "activity",
  },
  {
    id: "mesh",
    label: "Network",
    route: { view: "mesh" },
    active: (route) => route.view === "mesh",
  },
  {
    id: "mesh-ops",
    label: "Mesh Ops",
    route: { view: "mesh-ops" },
    active: (route) => route.view === "mesh-ops",
    capability: "surface.mesh-ops",
  },
  {
    id: "mission-control",
    label: "Mission Control",
    route: { view: "ops", mode: "mission" },
    active: isOpsMission,
    capability: "ops.control",
  },
  {
    id: "lanes",
    label: "Agent Lanes",
    route: { view: "ops", mode: "lanes" },
    active: (route) => route.view === "ops" && route.mode === "lanes",
  },
  {
    id: "repos",
    label: "Repositories",
    route: { view: "repos" },
    // SCO-085: repo-diff is a Repos detail surface — keep Repos sub-nav active.
    active: (route) => route.view === "repos" || route.view === "repo-diff",
  },
  {
    id: "code",
    label: "Code Browser",
    route: { view: "code" },
    active: (route) => route.view === "code",
  },
  {
    id: "providers",
    label: "Agent Providers",
    route: { view: "harnesses" },
    active: (route) => route.view === "harnesses",
  },
  {
    id: "runtime",
    label: "Runtime Monitor",
    route: { view: "ops", mode: "atop" },
    active: (route) => route.view === "ops" && route.mode === "atop",
    capability: "ops.control",
  },
  {
    id: "advisor",
    label: "Host Advisor",
    route: { view: "ops", mode: "advisor" },
    active: (route) => route.view === "ops" && route.mode === "advisor",
  },
  {
    id: "agent-config",
    label: "Agent Configuration",
    route: { view: "settings", section: "agents" },
    active: (route) => route.view === "settings" && route.section === "agents",
  },
] as const;

const DESTINATION_BY_ID: ReadonlyMap<NavDestinationId, NavDestination> = new Map(
  NAV_DESTINATIONS.map((destination) => [destination.id, destination]),
);

export function getDestination(id: NavDestinationId): NavDestination {
  const destination = DESTINATION_BY_ID.get(id);
  if (!destination) {
    throw new Error(`Unknown nav destination: ${id}`);
  }
  return destination;
}

export function requireDestination(id: NavDestinationId): NavDestination {
  return getDestination(id);
}

/* ── Shared projection helpers ────────────────────────────────────────── */

function project(
  id: NavDestinationId,
  overrides?: Partial<Pick<NavDestination, "label" | "route" | "active">>,
): {
  id: NavDestinationId;
  label: string;
  route: Route;
  active: (route: Route) => boolean;
  capability?: NavCapability;
} {
  const destination = getDestination(id);
  return {
    id: destination.id,
    label: overrides?.label ?? destination.label,
    route: overrides?.route ?? destination.route,
    active: overrides?.active ?? destination.active,
    capability: destination.capability,
  };
}

/* ── Projection: top tabs ─────────────────────────────────────────────── */

type TopTabProjection = {
  destinationId: NavDestinationId;
  key: TopNavKey;
  label?: string;
};

const TOP_TAB_PROJECTION: readonly TopTabProjection[] = [
  { destinationId: "home", key: "home" },
  { destinationId: "projects", key: "agents", label: "Crew" },
  { destinationId: "sessions", key: "sessions" },
  { destinationId: "chat", key: "chat", label: "Messages" },
];

export function projectTopNavItems(): TopNavItem[] {
  return TOP_TAB_PROJECTION.map((entry) => {
    const destination = getDestination(entry.destinationId);
    return {
      key: entry.key,
      label: entry.label ?? destination.label,
      route: destination.route,
    };
  });
}

/* ── Projection: System menu ──────────────────────────────────────────── */

export type SystemMenuEntry = {
  key: string;
  label: string;
  route: Route;
  active: (route: Route) => boolean;
  destinationId: NavDestinationId;
  capability?: NavCapability;
};

type SystemMenuProjection = {
  destinationId: NavDestinationId;
  key: string;
  label?: string;
};

const CORE_SYSTEM_MENU_PROJECTION: readonly SystemMenuProjection[] = [
  { destinationId: "search", key: "search" },
  { destinationId: "terminals", key: "terminals" },
  { destinationId: "tail", key: "tail" },
  { destinationId: "dispatch", key: "dispatch" },
];

const OPS_SYSTEM_MENU_PROJECTION: readonly SystemMenuProjection[] = [
  { destinationId: "mission-control", key: "control" },
  { destinationId: "lanes", key: "lanes" },
  { destinationId: "providers", key: "providers" },
  { destinationId: "mesh", key: "mesh" },
  { destinationId: "mesh-ops", key: "mesh-ops" },
  { destinationId: "runtime", key: "runtime" },
  { destinationId: "advisor", key: "advisor" },
];

function projectSystemMenuEntry(entry: SystemMenuProjection): SystemMenuEntry {
  const projected = project(entry.destinationId, { label: entry.label });
  return {
    key: entry.key,
    label: projected.label,
    route: projected.route,
    active: projected.active,
    destinationId: projected.id,
    capability: projected.capability,
  };
}

export function projectCoreSystemMenuEntries(): SystemMenuEntry[] {
  return CORE_SYSTEM_MENU_PROJECTION.map(projectSystemMenuEntry);
}

export function projectOpsSystemMenuEntries(): SystemMenuEntry[] {
  return OPS_SYSTEM_MENU_PROJECTION.map(projectSystemMenuEntry);
}

/* ── Projection: secondary nav ────────────────────────────────────────── */

type SecondaryItemProjection = {
  destinationId: NavDestinationId;
  id: string;
  label?: string;
  route?: Route;
  active?: (route: Route) => boolean;
};

function projectSecondaryGroup(
  items: readonly SecondaryItemProjection[],
): SecondaryNavGroup {
  return {
    items: items.map((entry) => {
      const projected = project(entry.destinationId, {
        label: entry.label,
        route: entry.route,
        active: entry.active,
      });
      return {
        id: entry.id,
        label: projected.label,
        route: projected.route,
        active: projected.active,
      };
    }),
  };
}

export function projectAgentsSecondaryNav(): SecondaryNavGroup[] {
  return [
    projectSecondaryGroup([
      { destinationId: "agent-config", id: "config", label: "Agent Configuration" },
    ]),
  ];
}

/**
 * Chat secondary strip is production-dead. Route unification collapsed the
 * DM/Channels split onto a single conversation route, so there is nothing left
 * to switch between. Kept as an empty projection only for catalog integrity
 * helpers; do not reintroduce a Chat strip in chrome.
 */
export function projectChatSecondaryNav(): SecondaryNavGroup[] {
  return [];
}

/**
 * Search secondary strip is production-dead (single surface). Kept as an empty
 * projection only for catalog integrity helpers that still iterate secondary
 * surfaces; do not reintroduce a Search strip in chrome.
 * @deprecated SCO-083 — Search has no secondary strip.
 */
export function projectSearchSecondaryNav(): SecondaryNavGroup[] {
  return [];
}

/**
 * Ops cluster secondary strip — Ops-area destinations only (SCO-083).
 * Dispatch, Repos, and Code moved out of Ops (Dispatch is top-level; Repos/Code
 * are Crew workspace tools). Do not re-add them here or the sidebar active area will
 * disagree with the in-content strip.
 */
export function projectOpsSecondaryNav(): SecondaryNavGroup[] {
  return [
    projectSecondaryGroup([
      { destinationId: "lanes", id: "lanes" },
      { destinationId: "mission-control", id: "control" },
      { destinationId: "providers", id: "harnesses", label: "Agent Providers" },
      { destinationId: "mesh", id: "mesh" },
      { destinationId: "tail", id: "tail" },
      { destinationId: "runtime", id: "runtime" },
      { destinationId: "advisor", id: "advisor" },
    ]),
  ];
}

/* ── Projection: go-shortcuts ─────────────────────────────────────────── */

export type GoShortcutProjection = {
  key: string;
  label: string;
  destinationId: NavDestinationId;
  /** Override route when the shortcut intentionally differs from catalog default. */
  route?: Route;
};

/**
 * Curated g+key sequences. Keys and labels are surface-specific; destination
 * identity and default route come from the catalog.
 */
export const GO_SHORTCUT_PROJECTION: readonly GoShortcutProjection[] = [
  { key: "h", label: "Go home", destinationId: "home" },
  { key: "i", label: "Go to messages", destinationId: "chat" },
  { key: "c", label: "Go to messages", destinationId: "chat" },
  { key: "p", label: "Go to crew", destinationId: "projects" },
  { key: "s", label: "Go to sessions", destinationId: "sessions" },
  { key: "t", label: "Go to terminals", destinationId: "terminals" },
  { key: "r", label: "Go to repositories", destinationId: "repos" },
  { key: "b", label: "Go to code browser", destinationId: "code" },
  { key: "f", label: "Go to search", destinationId: "search" },
  { key: "l", label: "Go to live activity", destinationId: "tail" },
  // Default ops entry uses bare `{ view: "ops" }` (mode undefined), matching
  // the historical shortcut — not the explicit mission mode in the catalog.
  { key: "o", label: "Go to operations", destinationId: "mission-control", route: { view: "ops" } },
  { key: "d", label: "Go to dispatch", destinationId: "dispatch" },
  { key: "m", label: "Go to network", destinationId: "mesh" },
  { key: "a", label: "Go to activity log", destinationId: "activity" },
];

export type GoShortcut = {
  key: string;
  label: string;
  route: Route;
  destinationId: NavDestinationId;
};

export function projectGoShortcuts(): readonly GoShortcut[] {
  return GO_SHORTCUT_PROJECTION.map((entry) => {
    const destination = getDestination(entry.destinationId);
    return {
      key: entry.key,
      label: entry.label,
      route: entry.route ?? destination.route,
      destinationId: entry.destinationId,
    };
  });
}

/* ── Projection: jump dock ────────────────────────────────────────────── */

export type JumpDockItem = {
  id: string;
  label: string;
  icon: LucideIcon;
  route: Route;
  destinationId: NavDestinationId;
  opsGated?: boolean;
};

type JumpDockProjection = {
  destinationId: NavDestinationId;
  id: string;
  label?: string;
  icon: LucideIcon;
  route?: Route;
  /** Explicit ops gate independent of catalog capability (mission control uses both). */
  opsGated?: boolean;
};

const JUMP_DOCK_PROJECTION: readonly JumpDockProjection[] = [
  { destinationId: "sessions", id: "sessions", icon: FileText },
  { destinationId: "terminals", id: "terminals", icon: Terminal },
  { destinationId: "repos", id: "repos", icon: GitBranch },
  { destinationId: "code", id: "code", icon: Code2 },
  { destinationId: "search", id: "search", icon: Search },
  { destinationId: "tail", id: "tail", icon: ScrollText },
  // Mission control bounces to Home when the ops cluster is off — only offer
  // the jump when it actually resolves.
  {
    destinationId: "mission-control",
    id: "ops",
    label: "Operations",
    icon: Compass,
    route: { view: "ops", mode: "mission" },
    opsGated: true,
  },
  { destinationId: "home", id: "home", icon: House },
  { destinationId: "dispatch", id: "dispatch", icon: Send },
];

export function projectJumpDockItems(): JumpDockItem[] {
  return JUMP_DOCK_PROJECTION.map((entry) => {
    const destination = getDestination(entry.destinationId);
    return {
      id: entry.id,
      label: entry.label ?? destination.label,
      icon: entry.icon,
      route: entry.route ?? destination.route,
      destinationId: entry.destinationId,
      opsGated: entry.opsGated ?? destination.capability === "ops.control",
    };
  });
}

/* ── Projection: command palette (static nav subset) ──────────────────── */

export type PaletteNavCommand = {
  id: string;
  label: string;
  destinationId: NavDestinationId;
  route: Route;
  shortcut?: string;
  capability?: NavCapability;
};

type PaletteNavProjection = {
  id: string;
  label: string;
  destinationId: NavDestinationId;
  route?: Route;
  shortcut?: string;
  capability?: NavCapability;
};

/**
 * Static navigate-to-destination palette rows. Overlay actions (settings
 * drawer), Scoutbot, reload, capture, and dynamic per-agent commands stay in
 * `useScoutCommands` — they are not pure destinations.
 */
const PALETTE_NAV_PROJECTION: readonly PaletteNavProjection[] = [
  { id: "nav:home", label: "Go to Home", destinationId: "home", shortcut: "Cmd+1" },
  { id: "nav:agents", label: "Go to Crew", destinationId: "projects", shortcut: "Cmd+2" },
  { id: "nav:messages", label: "Go to Chat", destinationId: "chat", shortcut: "Cmd+3" },
  { id: "nav:sessions", label: "Open Sessions", destinationId: "sessions" },
  { id: "nav:terminals", label: "Open Terminals", destinationId: "terminals" },
  { id: "nav:search", label: "Go to Search", destinationId: "search", shortcut: "Cmd+4" },
  { id: "nav:activity", label: "Open Activity", destinationId: "activity" },
  { id: "nav:mesh", label: "Open Mesh", destinationId: "mesh" },
  { id: "nav:dispatch", label: "Open Dispatch", destinationId: "dispatch" },
  { id: "nav:repos", label: "Open Repositories", destinationId: "repos" },
  { id: "nav:code", label: "Open Code Browser", destinationId: "code" },
  { id: "nav:harnesses", label: "Open Providers", destinationId: "providers" },
  { id: "nav:ops-lanes", label: "Open Agent Lanes", destinationId: "lanes" },
  {
    id: "nav:ops",
    label: "Go to Ops",
    destinationId: "mission-control",
    route: { view: "ops" },
    shortcut: "Cmd+5",
    capability: "ops.control",
  },
  {
    id: "nav:ops-atop",
    label: "Open Runtime",
    destinationId: "runtime",
    capability: "ops.control",
  },
  {
    id: "nav:agent-config",
    label: "Open Agent Configuration",
    destinationId: "agent-config",
  },
];

export function projectPaletteNavCommands(options?: {
  opsEnabled?: boolean;
}): PaletteNavCommand[] {
  const opsEnabled = options?.opsEnabled ?? true;
  return PALETTE_NAV_PROJECTION
    .filter((entry) => {
      const capability = entry.capability ?? getDestination(entry.destinationId).capability;
      if (capability === "ops.control" && !opsEnabled) return false;
      return true;
    })
    .map((entry) => {
      const destination = getDestination(entry.destinationId);
      return {
        id: entry.id,
        label: entry.label,
        destinationId: entry.destinationId,
        route: entry.route ?? destination.route,
        shortcut: entry.shortcut,
        capability: entry.capability ?? destination.capability,
      };
    });
}

/** Build CommandOption rows for the static nav subset of the palette. */
export function paletteNavCommandOptions(
  navigate: (route: Route) => void,
  options?: { opsEnabled?: boolean },
): CommandOption[] {
  return projectPaletteNavCommands(options).map((command) => ({
    id: command.id,
    label: command.label,
    action: () => navigate(command.route),
    shortcut: command.shortcut,
  }));
}

/* ── Projection: area sub-nav (SCO-085) ───────────────────────────────── */

/**
 * Mouse entry points lost when Repos/Code left Ops and Terminals left the jump
 * dock path. Projected under the active primary area (sidebar expanded) and as
 * a shared center-pane strip (icon-rail mode). Not SideRail content.
 */
export type AreaSubNavAreaId = "projects" | "sessions";

export type AreaSubNavItem = {
  id: string;
  label: string;
  route: Route;
  active: (route: Route) => boolean;
  destinationId: NavDestinationId;
};

type AreaSubNavProjection = {
  destinationId: NavDestinationId;
  id: string;
  label?: string;
};

const AREA_SUB_NAV_PROJECTION: Record<
  AreaSubNavAreaId,
  readonly AreaSubNavProjection[]
> = {
  projects: [
    { destinationId: "projects", id: "projects" },
    { destinationId: "repos", id: "repos" },
    { destinationId: "code", id: "code" },
  ],
  sessions: [
    { destinationId: "sessions", id: "sessions" },
    { destinationId: "terminals", id: "terminals" },
  ],
};

function projectAreaSubNavItem(entry: AreaSubNavProjection): AreaSubNavItem {
  const projected = project(entry.destinationId, { label: entry.label });
  return {
    id: entry.id,
    label: projected.label,
    route: projected.route,
    active: projected.active,
    destinationId: projected.id,
  };
}

/** Sub-nav items for a primary area, or empty when the area has none. */
export function projectAreaSubNav(areaId: AreaSubNavAreaId): AreaSubNavItem[] {
  return AREA_SUB_NAV_PROJECTION[areaId].map(projectAreaSubNavItem);
}

/**
 * Resolve area sub-nav for the current route from its primary area.
 * Returns null when the area has no AREA_SUB_NAV projection.
 *
 * SCO-086: imports ROUTE_AREA_BY_VIEW directly (no real cycle with
 * primary-areas.ts; the prior "avoid circular import" comment was stale).
 */
export function areaSubNavForRoute(route: Route): {
  areaId: AreaSubNavAreaId;
  items: AreaSubNavItem[];
} | null {
  const area = ROUTE_AREA_BY_VIEW[route.view];
  if (area !== "projects" && area !== "sessions") return null;
  const areaId: AreaSubNavAreaId = area;
  return { areaId, items: projectAreaSubNav(areaId) };
}

/* ── Projection: expanded sidebar sub-nav ────────────────────────────── */

export type SidebarSubNavAreaId = AreaSubNavAreaId | "dispatch" | "ops";

type SidebarSubNavProjection = AreaSubNavProjection & {
  route?: Route;
  active?: (route: Route) => boolean;
};

const SIDEBAR_SUB_NAV_PROJECTION: Record<
  SidebarSubNavAreaId,
  readonly SidebarSubNavProjection[]
> = {
  ...AREA_SUB_NAV_PROJECTION,
  // No `chat` entry: route unification left the Chat area with a single
  // surface, so the expanded sidebar projects no sub-nav for it.
  dispatch: [
    {
      destinationId: "dispatch",
      id: "dispatch-all",
      label: "All Dispatches",
      route: { view: "broker" },
      active: (route) =>
        route.view === "broker" && (route.filter === undefined || route.filter === "all"),
    },
    {
      destinationId: "dispatch",
      id: "dispatch-delivered",
      label: "Delivered",
      route: { view: "broker", filter: "delivered" },
      active: (route) => route.view === "broker" && route.filter === "delivered",
    },
    {
      destinationId: "dispatch",
      id: "dispatch-failed",
      label: "Failed",
      route: { view: "broker", filter: "failed" },
      active: (route) => route.view === "broker" && route.filter === "failed",
    },
  ],
  ops: [
    { destinationId: "lanes", id: "lanes", label: "Lanes" },
    { destinationId: "mission-control", id: "control" },
    { destinationId: "providers", id: "harnesses", label: "Providers" },
    { destinationId: "runtime", id: "runtime", label: "Runtime" },
    { destinationId: "mesh", id: "mesh" },
    { destinationId: "tail", id: "tail" },
    { destinationId: "advisor", id: "advisor" },
  ],
};

function projectSidebarSubNavItem(entry: SidebarSubNavProjection): AreaSubNavItem {
  const projected = project(entry.destinationId, {
    label: entry.label,
    route: entry.route,
    active: entry.active,
  });
  return {
    id: entry.id,
    label: projected.label,
    route: projected.route,
    active: projected.active,
    destinationId: projected.id,
  };
}

/** Nested destinations shown only beneath the active area in the expanded sidebar. */
export function sidebarSubNavForRoute(
  route: Route,
  options?: { opsControlEnabled?: boolean },
): { areaId: SidebarSubNavAreaId; items: AreaSubNavItem[] } | null {
  const area = ROUTE_AREA_BY_VIEW[route.view];
  if (!(area in SIDEBAR_SUB_NAV_PROJECTION)) return null;
  const areaId = area as SidebarSubNavAreaId;
  const items = SIDEBAR_SUB_NAV_PROJECTION[areaId]
    .map(projectSidebarSubNavItem)
    .filter((item) => {
      const capability = getDestination(item.destinationId).capability;
      return capability !== "ops.control" || options?.opsControlEnabled !== false;
    });
  return { areaId, items };
}

/* ── Integrity helpers (tests) ────────────────────────────────────────── */

/** Every destination id referenced by any projection. */
export function allProjectedDestinationIds(): NavDestinationId[] {
  const ids = new Set<NavDestinationId>();
  for (const entry of TOP_TAB_PROJECTION) ids.add(entry.destinationId);
  for (const entry of CORE_SYSTEM_MENU_PROJECTION) ids.add(entry.destinationId);
  for (const entry of OPS_SYSTEM_MENU_PROJECTION) ids.add(entry.destinationId);
  for (const entry of GO_SHORTCUT_PROJECTION) ids.add(entry.destinationId);
  for (const entry of JUMP_DOCK_PROJECTION) ids.add(entry.destinationId);
  for (const entry of PALETTE_NAV_PROJECTION) ids.add(entry.destinationId);
  for (const areaId of Object.keys(AREA_SUB_NAV_PROJECTION) as AreaSubNavAreaId[]) {
    for (const entry of AREA_SUB_NAV_PROJECTION[areaId]) {
      ids.add(entry.destinationId);
    }
  }
  for (const areaId of Object.keys(SIDEBAR_SUB_NAV_PROJECTION) as SidebarSubNavAreaId[]) {
    for (const entry of SIDEBAR_SUB_NAV_PROJECTION[areaId]) {
      ids.add(entry.destinationId);
    }
  }
  for (const group of [
    ...projectAgentsSecondaryNav(),
    ...projectChatSecondaryNav(),
    ...projectSearchSecondaryNav(),
    ...projectOpsSecondaryNav(),
  ]) {
    for (const item of group.items) {
      // Secondary items don't carry destinationId on the public shape; resolve
      // by matching route/active against the catalog in tests instead.
      void item;
    }
  }
  // Explicit secondary destination ids for integrity checks (SCO-083: Ops strip
  // no longer includes dispatch/repos/code; Search secondary is empty).
  for (const id of [
    "agent-config",
    "chat",
    "lanes",
    "mission-control",
    "providers",
    "mesh",
    "tail",
    "runtime",
    "advisor",
  ] as const) {
    ids.add(id);
  }
  return [...ids];
}
