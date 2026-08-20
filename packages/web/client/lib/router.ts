import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { isOpsEnabled } from "./feature-flags.ts";
import {
  parseScopeRouteFromUrl,
  preserveLocationSearch,
} from "../scope/paths.ts";
import { scopeRoutePath } from "../scope/presentation.ts";
import { normalizeRoute } from "./synthetic-agent-routing.ts";
import { isTerminalSurfaceId } from "@openscout/protocol";
import { canonicalTerminalSurfaceId, surfaceKeyFromParts, surfacePartsFromKey } from "./terminal-sessions.ts";
import {
  parseSearchFiltersFromUrl,
  searchFiltersAreActive,
  serializeSearchFiltersToParams,
} from "./knowledge-search.ts";
import type {
  AgentTab,
  DispatchFilter,
  FollowPreferredView,
  OpsMode,
  ProjectSet,
  ProjectsIndexView,
  ProjectStateFilter,
  Route,
  SearchMode,
  SettingsSection,
} from "./types.ts";

/* ── URL ↔ Route mapping ── */

const APP_URL_BASE = typeof window !== "undefined" ? window.location.href : "http://scout.local/";

/** Accepts full URLs or path-only hrefs; resolves against the active document. */
function resolveAppUrl(hrefOrPath: string | URL): URL {
  const value = hrefOrPath.toString();
  return new URL(value, APP_URL_BASE);
}

function parseAgentTab(value: string | null): AgentTab | undefined {
  switch (value) {
    case "profile":
    case "config":
    case "definitions":
      return value === "definitions" ? "config" : value;
    case "observe":
    case "message":
      return value;
    default:
      return undefined;
  }
}

function hashMessageId(hash: string): string | null {
  const raw = hash.trim().replace(/^#/, "");
  if (!raw.startsWith("msg-")) return null;
  const id = raw.slice("msg-".length).trim();
  if (!id) return null;
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
}

function parseOpsMode(value: string | undefined): OpsMode | undefined {
  switch (value) {
    case "control":
    case "mission":
    // Command/Conductor views retired — fold legacy URLs into Control.
    case "command":
    case "warroom":
    case "conduct":
    case "conductor":
      return "mission";
    case "plan":
      return "plan";
    case "issues":
    case "errors":
    case "warnings":
      return "issues";
    case "agents":
    case "tail":
    case "atop":
    case "lanes":
      return value;
    default:
      return undefined;
  }
}

function parseDispatchFilter(value: string | null): DispatchFilter | undefined {
  return value === "delivered" || value === "failed" || value === "all" ? value : undefined;
}

function parseSearchMode(value: string | undefined): SearchMode | undefined {
  return value === "indexer" || value === "knowledge" ? value : undefined;
}

function parseSettingsSection(value: string | undefined): SettingsSection | undefined {
  switch (value) {
    case "pairing":
    case "agents":
    case "appearance":
    case "operator":
    case "comms":
    case "credentials":
    case "voice":
    case "devices":
    case "about":
      return value;
    // Alias for the communications section label used in chrome.
    case "communications":
      return "comms";
    default:
      return undefined;
  }
}

function parseFollowPreferredView(value: string | null): FollowPreferredView | undefined {
  switch (value) {
    case "tail":
    case "session":
    case "chat":
    case "work":
      return value;
    default:
      return undefined;
  }
}

function parseTerminalMode(value: string | null): "observe" | "takeover" | undefined {
  const normalized = value?.trim().replace(/\.+$/u, "");
  return normalized === "observe" || normalized === "takeover" ? normalized : undefined;
}

function parseTerminalBackend(value: string | null): "pty" | "tmux" | "zellij" | "herdr" | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized === "pty" || normalized === "tmux" || normalized === "zellij" || normalized === "herdr"
    ? normalized
    : undefined;
}

function parseTerminalAgent(value: string | null): "shell" | "claude" | "codex" | "pi" | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized === "shell" || normalized === "claude" || normalized === "codex" || normalized === "pi"
    ? normalized
    : undefined;
}

function parseDiffInclude(value: string | null): "changed" | "all" | undefined {
  return value === "all" || value === "touched" ? "all" : value === "changed" ? "changed" : undefined;
}

function parsePositiveLine(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function opsModePath(mode: OpsMode): string {
  switch (mode) {
    case "mission":
      return "control";
    default:
      return mode;
  }
}

function isOpsEnabledForUrl(url: URL): boolean {
  if (url.searchParams.has("no-ops")) {
    return false;
  }
  if (typeof window === "undefined") {
    return true;
  }
  return isOpsEnabled();
}

// Tail (ops?mode=tail) is part of the core retrieval set (System dropdown,
// `g,l` go-shortcut), so it stays reachable even when the broader Ops cluster
// (ops.control) is gated off. Other Ops modes still follow the ops gate.
function isTailCoreSurface(mode: string | undefined): boolean {
  return mode === "tail";
}

// Lanes is shared with the native app and chrome-free embeds, so direct links are
// not gated with the broader Ops cluster.
function isLanesCoreSurface(mode: string | undefined): boolean {
  return mode === "lanes";
}

function isUngatedOpsSurface(mode: string | undefined): boolean {
  return isTailCoreSurface(mode) || isLanesCoreSurface(mode);
}

const MACHINE_SCOPE_PARAM = "machineId";
const MACHINE_SCOPED_VIEWS = new Set<Route["view"]>([
  "inbox",
  "conversation",
  "agents-v2",
  "messages",
  "sessions",
  "repos",
  "harnesses",
  "mesh",
  "mesh-ops",
  "activity",
  "work",
  "follow",
]);

function parseMachineId(url: URL): string | undefined {
  return url.searchParams.get(MACHINE_SCOPE_PARAM)?.trim() || undefined;
}

function withMachineScope<T extends Route>(route: T, machineId: string | undefined): T {
  if (!machineId || !MACHINE_SCOPED_VIEWS.has(route.view)) return route;
  return { ...route, machineId } as T;
}

export function routeSupportsMachineScope(route: Pick<Route, "view">): boolean {
  return MACHINE_SCOPED_VIEWS.has(route.view);
}

export function routeMachineId(route: Route): string | null {
  return "machineId" in route && route.machineId ? route.machineId : null;
}

export function setRouteMachineScope(route: Route, machineId: string | null): Route {
  if (!routeSupportsMachineScope(route)) return route;
  const scoped = { ...route } as Route & { machineId?: string };
  const value = machineId?.trim();
  if (value) {
    scoped.machineId = value;
  } else {
    delete scoped.machineId;
  }
  return scoped;
}

export function clearRouteMachineScope(route: Route): Route {
  if (!routeSupportsMachineScope(route)) return route;
  return { ...route, machineId: "" } as Route;
}

function resolveNavigatedMachineScope(nextRoute: Route, currentRoute: Route): Route {
  if (!routeSupportsMachineScope(nextRoute)) return nextRoute;
  if ("machineId" in nextRoute) {
    return setRouteMachineScope(nextRoute, nextRoute.machineId ?? null);
  }
  return setRouteMachineScope(nextRoute, routeMachineId(currentRoute));
}

function appendMachineScope(params: URLSearchParams, route: Route): void {
  if ("machineId" in route && route.machineId) {
    params.set(MACHINE_SCOPE_PARAM, route.machineId);
  }
}

function searchSuffix(params: URLSearchParams): string {
  const search = params.toString();
  return search ? `?${search}` : "";
}

function pathWithMachineScope(path: string, route: Route): string {
  const params = new URLSearchParams();
  appendMachineScope(params, route);
  return `${path}${searchSuffix(params)}`;
}

function routeScopeKey(route: Route): string {
  return "machineId" in route && route.machineId ? `:machine:${route.machineId}` : "";
}

export function routeFromUrl(urlLike: string | URL): Route {
  const url = resolveAppUrl(urlLike);
  const parts = url.pathname.replace(/^\/+/, "").split("/").filter(Boolean);
  const machineId = parseMachineId(url);
  const scoped = <T extends Route>(route: T): T => withMachineScope(route, machineId);
  const scopeRoute = parseScopeRouteFromUrl(parts, url, scoped);
  if (scopeRoute) return scopeRoute;
  const messageHashId = hashMessageId(url.hash);
  const agentTab = parseAgentTab(url.searchParams.get("tab"))
    ?? (messageHashId ? "message" : undefined);
  const agentProjectSlug = url.searchParams.get("project")?.trim() || undefined;
  const sessionAgentId = url.searchParams.get("agentId")?.trim() || undefined;
  if (parts[0] === "agent" && parts[1]) {
    return { view: "agent-info", conversationId: decodeURIComponent(parts[1]) };
  }
  const agentsV2Project = url.searchParams.get("project")?.trim() || undefined;
  const agentsV2Harness = url.searchParams.get("harness")?.trim() || undefined;
  const agentsV2Node = url.searchParams.get("node")?.trim() || undefined;
  const agentsV2SetRaw = url.searchParams.get("set")?.trim();
  const agentsV2Set: ProjectSet | undefined =
    agentsV2SetRaw === "live" || agentsV2SetRaw === "ephemeral" || agentsV2SetRaw === "archived"
      ? (agentsV2SetRaw as ProjectSet)
      : undefined;
  const agentsV2IndexRaw = url.searchParams.get("view")?.trim();
  const agentsV2IndexView: ProjectsIndexView | undefined =
    agentsV2IndexRaw === "sessions" || agentsV2IndexRaw === "agents"
      ? (agentsV2IndexRaw as ProjectsIndexView)
      : undefined;
  const agentsV2StateRaw = url.searchParams.get("state")?.trim();
  const agentsV2StateFilter: ProjectStateFilter | undefined =
    agentsV2StateRaw === "needs" || agentsV2StateRaw === "live" || agentsV2StateRaw === "idle"
      ? (agentsV2StateRaw as ProjectStateFilter)
      : undefined;
  const agentsV2ShowEphemeral = url.searchParams.get("ephemeral") === "1";
  const agentsV2SessionParam = url.searchParams.get("session")?.trim() || undefined;
  const agentsV2Select = url.searchParams.get("select")?.trim() || undefined;
  const agentsV2Common = {
    ...(agentsV2Harness ? { harness: agentsV2Harness } : {}),
    ...(agentsV2Node ? { node: agentsV2Node } : {}),
    ...(agentsV2Set ? { set: agentsV2Set } : {}),
    ...(agentsV2IndexView ? { indexView: agentsV2IndexView } : {}),
    ...(agentsV2StateFilter ? { stateFilter: agentsV2StateFilter } : {}),
    ...(agentsV2ShowEphemeral ? { showEphemeral: true } : {}),
  };
  if (parts[0] === "projects") {
    const projectSlug = parts[1] ? decodeURIComponent(parts[1]) : undefined;
    if (!projectSlug) {
      return scoped({
        view: "agents-v2",
        ...(agentsV2Select ? { selectedAgentId: agentsV2Select } : {}),
        ...agentsV2Common,
      });
    }
    if (parts[2] === "agents") {
      const agentId = parts[3] ? decodeURIComponent(parts[3]) : undefined;
      if (agentId) {
        if (parts[4] === "c" && parts[5]) {
          return scoped({
            view: "agents-v2",
            projectSlug,
            agentId,
            conversationId: decodeURIComponent(parts[5]),
            tab: agentTab ?? "message",
            ...agentsV2Common,
          });
        }
        const sessionId = parts[4] === "sessions" && parts[5]
          ? decodeURIComponent(parts[5])
          : agentsV2SessionParam;
        return scoped({
          view: "agents-v2",
          projectSlug,
          agentId,
          ...(sessionId ? { sessionId } : {}),
          ...(agentTab ? { tab: agentTab } : {}),
          ...agentsV2Common,
        });
      }
      return scoped({
        view: "agents-v2",
        projectSlug,
        indexView: "agents",
        ...(agentsV2Select ? { selectedAgentId: agentsV2Select } : {}),
        ...agentsV2Common,
      });
    }
    if (parts[2] === "sessions") {
      return scoped({
        view: "agents-v2",
        projectSlug,
        indexView: "sessions",
        ...(parts[3] ? { sessionId: decodeURIComponent(parts[3]) } : {}),
        ...(agentsV2Select ? { selectedAgentId: agentsV2Select } : {}),
        ...agentsV2Common,
      });
    }
    return scoped({
      view: "agents-v2",
      projectSlug,
      ...(agentsV2Select ? { selectedAgentId: agentsV2Select } : {}),
      ...agentsV2Common,
    });
  }
  if (parts[0] === "agents-v2" && parts[1] === "sessions" && parts[2]) {
    return scoped({
      view: "agents-v2",
      sessionId: decodeURIComponent(parts[2]),
      ...(agentsV2Select ? { selectedAgentId: agentsV2Select } : {}),
      ...(agentsV2Project ? { projectSlug: agentsV2Project } : {}),
      ...agentsV2Common,
    });
  }
  if (parts[0] === "agents-v2" && parts[1]) {
    const agentId = decodeURIComponent(parts[1]);
    return scoped({
      view: "agents-v2",
      agentId,
      ...(agentTab ? { tab: agentTab } : {}),
      ...(agentsV2SessionParam ? { sessionId: agentsV2SessionParam } : {}),
      ...(agentsV2Project ? { projectSlug: agentsV2Project } : {}),
      ...agentsV2Common,
    });
  }
  if (parts[0] === "agents-v2") {
    return scoped({
      view: "agents-v2",
      ...(agentsV2Select ? { selectedAgentId: agentsV2Select } : {}),
      ...(agentsV2Project ? { projectSlug: agentsV2Project } : {}),
      ...agentsV2Common,
    });
  }
  if (parts[0] === "agents" && parts[1]) {
    const agentId = decodeURIComponent(parts[1]);
    const sessionId = parts[2] === "sessions" && parts[3]
      ? decodeURIComponent(parts[3])
      : agentsV2SessionParam;
    if (parts[2] === "c" && parts[3]) {
      return scoped({
        view: "agents-v2",
        agentId,
        conversationId: decodeURIComponent(parts[3]),
        tab: agentTab ?? "message",
        ...agentsV2Common,
      });
    }
    return scoped({
      view: "agents-v2",
      agentId,
      ...(sessionId ? { sessionId } : {}),
      ...(agentTab ? { tab: agentTab } : {}),
      ...agentsV2Common,
    });
  }
  if (parts[0] === "agents") {
    return scoped({
      view: "agents-v2",
      ...(agentsV2Select ? { selectedAgentId: agentsV2Select } : {}),
      ...(agentsV2Project ? { projectSlug: agentsV2Project } : {}),
      ...agentsV2Common,
    });
  }
  // Legacy /agents.deprecated/* → agents-v2 (canonical /projects / /agents/:id).
  if (parts[0] === "agents.deprecated" && parts[1] && parts[2] === "sessions" && parts[3]) {
    return scoped({
      view: "sessions",
      agentId: decodeURIComponent(parts[1]),
      sessionId: decodeURIComponent(parts[3]),
    });
  }
  if (parts[0] === "agents.deprecated" && parts[1] && parts[2] === "c" && parts[3]) {
    return scoped({
      view: "agents-v2",
      agentId: decodeURIComponent(parts[1]),
      conversationId: decodeURIComponent(parts[3]),
      tab: agentTab ?? "message",
    });
  }
  if (parts[0] === "agents.deprecated" && parts[1]) {
    const agentId = decodeURIComponent(parts[1]);
    return scoped({
      view: "agents-v2",
      agentId,
      ...(agentTab ? { tab: agentTab } : {}),
      ...(!agentTab && agentProjectSlug ? { projectSlug: agentProjectSlug } : {}),
    });
  }
  if (parts[0] === "agents.deprecated") {
    return scoped({
      view: "agents-v2",
      ...(agentProjectSlug ? { projectSlug: agentProjectSlug } : {}),
    });
  }
  // Legacy /fleet → Home (inbox).
  if (parts[0] === "fleet") return scoped({ view: "inbox" });
  // /c/{conversationId} always opens the conversation surface directly.
  if (parts[0] === "c" && parts[1]) {
    return scoped({
      view: "conversation",
      conversationId: decodeURIComponent(parts[1]),
    });
  }
  if (parts[0] === "flights" && parts[1] && parts[2] === "observe") {
    const sessionId = url.searchParams.get("session")?.trim() || undefined;
    const compareSessionId = url.searchParams.get("compare")?.trim() || undefined;
    return scoped({
      view: "sessions",
      flightId: decodeURIComponent(parts[1]),
      ...(sessionId ? { sessionId } : {}),
      ...(compareSessionId ? { compareSessionId } : {}),
    });
  }
  if (parts[0] === "sessions" && parts[1]) {
    return scoped({
      view: "sessions",
      sessionId: decodeURIComponent(parts[1]),
      ...(sessionAgentId ? { agentId: sessionAgentId } : {}),
    });
  }
  // Legacy /conversations → Chat messages index.
  if (parts[0] === "conversations") return scoped({ view: "messages" });
  if (parts[0] === "messages") {
    const base: Extract<Route, { view: "messages" }> = {
      view: "messages",
      ...(parts[1] ? { conversationId: decodeURIComponent(parts[1]) } : {}),
    };
    return scoped(base);
  }
  if (parts[0] === "sessions") {
    return scoped({
      view: "sessions",
      ...(sessionAgentId ? { agentId: sessionAgentId } : {}),
    });
  }
  if (parts[0] === "repos") {
    const root = url.searchParams.get("root")?.trim() || undefined;
    return scoped({ view: "repos", ...(root ? { root } : {}) });
  }
  if (parts[0] === "providers" || parts[0] === "harnesses") {
    return scoped({ view: "harnesses" });
  }
  if (parts[0] === "repo-diff") {
    const path = url.searchParams.get("path")?.trim();
    if (path) {
      const layers = url.searchParams
        .getAll("layer")
        .filter(
          (v): v is "unstaged" | "staged" | "branch" =>
            v === "unstaged" || v === "staged" || v === "branch",
        );
      const files = url.searchParams.getAll("file").map((v) => v.trim()).filter(Boolean);
      const sessionId = url.searchParams.get("sessionId")?.trim() || undefined;
      const agentId = url.searchParams.get("agentId")?.trim() || undefined;
      const include = parseDiffInclude(url.searchParams.get("include"));
      return {
        view: "repo-diff",
        path,
        ...(layers.length > 0 ? { layers } : {}),
        ...(files.length > 0 ? { files } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(agentId ? { agentId } : {}),
        ...(include ? { include } : {}),
      };
    }
    // No path → fall through to the default route below.
  }
  if (parts[0] === "search") {
    const mode = parseSearchMode(parts[1]);
    const hitId = url.searchParams.get("hit")?.trim() || undefined;
    const filters = parseSearchFiltersFromUrl(url.searchParams);
    return {
      view: "search",
      ...(mode && mode !== "knowledge" ? { mode } : {}),
      ...(hitId ? { hitId } : {}),
      ...(searchFiltersAreActive(filters) ? { filters } : {}),
    };
  }
  // Legacy /channels deep links alias onto the unified conversation route.
  if (parts[0] === "channels" && parts[1]) {
    return scoped({ view: "messages", conversationId: decodeURIComponent(parts[1]) });
  }
  if (parts[0] === "channels") return scoped({ view: "messages" });
  if (parts[0] === "mesh") return scoped({ view: "mesh" });
  if (parts[0] === "mesh-ops") {
    return scoped({
      view: "mesh-ops",
      ...(parts[1] ? { itemId: decodeURIComponent(parts[1]) } : {}),
    });
  }
  if (parts[0] === "dispatch" || parts[0] === "broker") {
    const attemptId = url.searchParams.get("attempt")?.trim() || undefined;
    const filter = parseDispatchFilter(url.searchParams.get("filter"));
    return {
      view: "broker",
      ...(attemptId ? { attemptId } : {}),
      ...(filter && filter !== "all" ? { filter } : {}),
    };
  }
  if (parts[0] === "code") {
    const wt = url.searchParams.get("wt")?.trim() || undefined;
    const returnConversationId = url.searchParams.get("fromConversation")?.trim() || undefined;
    const line = parsePositiveLine(url.searchParams.get("line"));
    const rawEndLine = parsePositiveLine(url.searchParams.get("endLine"));
    const endLine = line && rawEndLine && rawEndLine >= line ? rawEndLine : undefined;
    if (parts[1]) {
      const project = decodeURIComponent(parts[1]);
      const path = parts.length > 2 ? parts.slice(2).map(decodeURIComponent).join("/") : undefined;
      return {
        view: "code",
        project,
        ...(path ? { path } : {}),
        ...(wt ? { wt } : {}),
        ...(line ? { line } : {}),
        ...(endLine ? { endLine } : {}),
        ...(returnConversationId ? { returnConversationId } : {}),
      };
    }
    const root = url.searchParams.get("root")?.trim() || undefined;
    const file = url.searchParams.get("file")?.trim() || undefined;
    return {
      view: "code",
      ...(root ? { root } : {}),
      ...(file ? { file } : {}),
      ...(wt ? { wt } : {}),
      ...(line ? { line } : {}),
      ...(endLine ? { endLine } : {}),
      ...(returnConversationId ? { returnConversationId } : {}),
    };
  }
  if (parts[0] === "briefings" && parts[1]) {
    return { view: "briefings", briefingId: decodeURIComponent(parts[1]) };
  }
  if (parts[0] === "briefings") return { view: "briefings" };
  if (parts[0] === "activity") return scoped({ view: "activity" });
  if (parts[0] === "voice") return { view: "voice" };
  if (parts[0] === "work" && parts[1]) {
    return scoped({ view: "work", workId: decodeURIComponent(parts[1]) });
  }
  if (parts[0] === "follow") {
    const preferredView = parseFollowPreferredView(url.searchParams.get("view"));
    const route: Extract<Route, { view: "follow" }> = {
      view: "follow",
      ...(preferredView ? { preferredView } : {}),
    };
    const kind = parts[1];
    const id = parts[2] ? decodeURIComponent(parts[2]) : "";
    if (kind === "flight" && id) route.flightId = id;
    if (kind === "invocation" && id) route.invocationId = id;
    if (kind === "conversation" && id) route.conversationId = id;
    if (kind === "work" && id) route.workId = id;
    if (kind === "session" && id) route.sessionId = id;
    if (kind === "agent" && id) route.targetAgentId = id;
    const flightId = url.searchParams.get("flightId");
    const invocationId = url.searchParams.get("invocationId");
    const conversationId = url.searchParams.get("conversationId");
    const workId = url.searchParams.get("workId");
    const sessionId = url.searchParams.get("sessionId");
    const targetAgentId = url.searchParams.get("targetAgentId");
    if (flightId) route.flightId = flightId;
    if (invocationId) route.invocationId = invocationId;
    if (conversationId) route.conversationId = conversationId;
    if (workId) route.workId = workId;
    if (sessionId) route.sessionId = sessionId;
    if (targetAgentId) route.targetAgentId = targetAgentId;
    return scoped(route);
  }
  if (parts[0] === "settings") {
    if (parts[1] === "agents") {
      return {
        view: "settings",
        section: "agents",
        ...(parts[2] ? { agentId: decodeURIComponent(parts[2]) } : {}),
      };
    }
    const section = parseSettingsSection(parts[1]);
    return {
      view: "settings",
      ...(section ? { section } : {}),
    };
  }
  if (parts[0] === "terminal") {
    const mode = parseTerminalMode(url.searchParams.get("mode"));
    const terminalSessionId = url.searchParams.get("session")?.trim() || undefined;
    const terminalSurfaceKey = canonicalTerminalSurfaceId(url.searchParams.get("surface")) ?? undefined;
    if (parts[1] === "new") {
      const terminalBackend = parseTerminalBackend(url.searchParams.get("backend")) ?? "pty";
      const terminalAgent = parseTerminalAgent(url.searchParams.get("agent")) ?? "shell";
      const terminalSessionName = url.searchParams.get("name")?.trim() || undefined;
      const terminalTabId = url.searchParams.get("tab")?.trim() || undefined;
      const zellijSocketDir = url.searchParams.get("socketDir")?.trim() || undefined;
      return {
        view: "terminal",
        terminalBackend,
        terminalAgent,
        ...(terminalSessionName ? { terminalSessionName } : {}),
        ...(terminalTabId ? { terminalTabId } : {}),
        ...(zellijSocketDir ? { zellijSocketDir } : {}),
      };
    }
    // `/terminal/s/<surfaceId>` carries an opaque handle; the older
    // `/terminal/<backend>/<name>` form still parses, through the same
    // constructor, so existing deep links keep resolving.
    const pathSurfaceKey = parts[1] === "s" && parts[2]
      ? (isTerminalSurfaceId(decodeURIComponent(parts.slice(2).join("/")))
        ? decodeURIComponent(parts.slice(2).join("/"))
        : null)
      : surfaceKeyFromParts(
        parts[1] ? decodeURIComponent(parts[1]) : undefined,
        parts[2] ? decodeURIComponent(parts.slice(2).join("/")) : undefined,
      );
    if (pathSurfaceKey) {
      return {
        view: "terminal",
        terminalSurfaceKey: pathSurfaceKey,
        ...(terminalSessionId ? { terminalSessionId } : {}),
        ...(mode ? { mode } : {}),
      };
    }
    return {
      view: "terminal",
      ...(parts[1] ? { agentId: decodeURIComponent(parts[1]) } : {}),
      ...(mode ? { mode } : {}),
      ...(!parts[1] && terminalSessionId ? { terminalSessionId } : {}),
      ...(!parts[1] && terminalSurfaceKey ? { terminalSurfaceKey } : {}),
    };
  }
  if (parts[0] === "ops") {
    const mode = parseOpsMode(parts[1]) ?? "mission";
    if (!isUngatedOpsSurface(mode) && !isOpsEnabledForUrl(url)) {
      return scoped({ view: "inbox" });
    }
    const tailQuery = mode === "tail" ? url.searchParams.get("q")?.trim() : "";
    const planDocumentId = mode === "plan" ? url.searchParams.get("plan")?.trim() : "";
    const flightId = url.searchParams.get("flightId")?.trim();
    const invocationId = url.searchParams.get("invocationId")?.trim();
    const conversationId = url.searchParams.get("conversationId")?.trim();
    const workId = url.searchParams.get("workId")?.trim();
    const sessionId = url.searchParams.get("sessionId")?.trim();
    const targetAgentId = url.searchParams.get("targetAgentId")?.trim()
      ?? url.searchParams.get("agentId")?.trim();
    return {
      view: "ops",
      mode,
      ...(tailQuery ? { tailQuery } : {}),
      ...(planDocumentId ? { planDocumentId } : {}),
      ...(flightId ? { flightId } : {}),
      ...(invocationId ? { invocationId } : {}),
      ...(conversationId ? { conversationId } : {}),
      ...(workId ? { workId } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(targetAgentId ? { targetAgentId } : {}),
    };
  }
  return scoped({ view: "inbox" });
}

export function routePath(r: Route, pathname?: string): string {
  const scopePath = r.view === "sessions" && r.flightId
    ? null
    : scopeRoutePath(r, pathname);
  if (scopePath) return scopePath;

  switch (r.view) {
    case "inbox":
      return pathWithMachineScope("/", r);
    case "conversation": {
      const params = new URLSearchParams();
      appendMachineScope(params, r);
      return `/c/${encodeURIComponent(r.conversationId)}${searchSuffix(params)}`;
    }
    case "agent-info":
      return `/agent/${encodeURIComponent(r.conversationId)}`;
    case "agents-v2": {
      const params = new URLSearchParams();
      if (r.harness) params.set("harness", r.harness);
      if (r.node) params.set("node", r.node);
      if (r.set) params.set("set", r.set);
      if (!r.projectSlug && r.indexView && r.indexView !== "agents") params.set("view", r.indexView);
      if (r.stateFilter) params.set("state", r.stateFilter);
      if (r.showEphemeral) params.set("ephemeral", "1");
      if (r.selectedAgentId && !r.agentId && !r.sessionId) params.set("select", r.selectedAgentId);
      const defaultTab = r.conversationId ? "message" : "profile";
      if (r.agentId && r.tab && r.tab !== defaultTab) params.set("tab", r.tab);
      appendMachineScope(params, r);
      const projectPath = r.projectSlug ? `/projects/${encodeURIComponent(r.projectSlug)}` : null;
      const path = projectPath
        ? r.agentId
          ? r.conversationId
            ? `${projectPath}/agents/${encodeURIComponent(r.agentId)}/c/${encodeURIComponent(r.conversationId)}`
            : r.sessionId
            ? `${projectPath}/agents/${encodeURIComponent(r.agentId)}/sessions/${encodeURIComponent(r.sessionId)}`
            : `${projectPath}/agents/${encodeURIComponent(r.agentId)}`
          : r.sessionId
            ? `${projectPath}/sessions/${encodeURIComponent(r.sessionId)}`
            : r.indexView === "sessions"
              ? `${projectPath}/sessions`
              : r.indexView === "agents"
                ? `${projectPath}/agents`
                : projectPath
        : r.agentId
          ? r.conversationId
            ? `/agents/${encodeURIComponent(r.agentId)}/c/${encodeURIComponent(r.conversationId)}`
            : r.sessionId
            ? `/agents/${encodeURIComponent(r.agentId)}/sessions/${encodeURIComponent(r.sessionId)}`
            : `/agents/${encodeURIComponent(r.agentId)}`
          : r.sessionId
            ? `/sessions/${encodeURIComponent(r.sessionId)}`
            : "/projects";
      return `${path}${searchSuffix(params)}`;
    }
    case "messages": {
      const params = new URLSearchParams();
      appendMachineScope(params, r);
      const base = r.conversationId
        ? `/messages/${encodeURIComponent(r.conversationId)}`
        : "/messages";
      return `${base}${searchSuffix(params)}`;
    }
    case "sessions": {
      const params = new URLSearchParams();
      if (r.agentId) params.set("agentId", r.agentId);
      if (r.flightId) {
        if (r.sessionId) params.set("session", r.sessionId);
        if (r.compareSessionId) params.set("compare", r.compareSessionId);
        appendMachineScope(params, r);
        return `/flights/${encodeURIComponent(r.flightId)}/observe${searchSuffix(params)}`;
      }
      appendMachineScope(params, r);
      const path = r.sessionId
        ? `/sessions/${encodeURIComponent(r.sessionId)}`
        : "/sessions";
      return `${path}${searchSuffix(params)}`;
    }
    case "repos": {
      const params = new URLSearchParams();
      if (r.root) params.set("root", r.root);
      appendMachineScope(params, r);
      return `/repos${searchSuffix(params)}`;
    }
    case "harnesses":
      return pathWithMachineScope("/providers", r);
    case "repo-diff": {
      const params = new URLSearchParams();
      params.set("path", r.path);
      for (const layer of r.layers ?? []) params.append("layer", layer);
      for (const file of r.files ?? []) params.append("file", file);
      if (r.sessionId) params.set("sessionId", r.sessionId);
      if (r.agentId) params.set("agentId", r.agentId);
      if (r.include) params.set("include", r.include);
      return `/repo-diff${searchSuffix(params)}`;
    }
    case "search": {
      const base = r.mode === "indexer" ? "/search/indexer" : "/search";
      const params = r.filters
        ? serializeSearchFiltersToParams(r.filters, { hitId: r.hitId ?? null })
        : new URLSearchParams();
      if (!r.filters && r.hitId) params.set("hit", r.hitId);
      return `${base}${searchSuffix(params)}`;
    }
    case "mesh":
      return pathWithMachineScope("/mesh", r);
    case "mesh-ops":
      return pathWithMachineScope(
        r.itemId ? `/mesh-ops/${encodeURIComponent(r.itemId)}` : "/mesh-ops",
        r,
      );
    case "broker": {
      const params = new URLSearchParams();
      if (r.attemptId) params.set("attempt", r.attemptId);
      if (r.filter && r.filter !== "all") params.set("filter", r.filter);
      return `/dispatch${searchSuffix(params)}`;
    }
    case "code": {
      const params = new URLSearchParams();
      if (r.wt) params.set("wt", r.wt);
      if (r.line) params.set("line", String(r.line));
      if (r.line && r.endLine && r.endLine >= r.line) params.set("endLine", String(r.endLine));
      if (r.project) {
        if (r.returnConversationId) params.set("fromConversation", r.returnConversationId);
        const segments = [encodeURIComponent(r.project)];
        if (r.path) segments.push(...r.path.split("/").map(encodeURIComponent));
        const base = `/code/${segments.join("/")}`;
        return `${base}${searchSuffix(params)}`;
      }
      if (r.root) params.set("root", r.root);
      if (r.file) params.set("file", r.file);
      if (r.returnConversationId) params.set("fromConversation", r.returnConversationId);
      const search = params.toString();
      return search ? `/code?${search}` : "/code";
    }
    case "briefings":
      return r.briefingId
        ? `/briefings/${encodeURIComponent(r.briefingId)}`
        : "/briefings";
    case "activity":
      return pathWithMachineScope("/activity", r);
    case "voice":
      return "/voice";
    case "work":
      return pathWithMachineScope(`/work/${encodeURIComponent(r.workId)}`, r);
    case "settings":
      if (r.section === "agents") {
        return r.agentId
          ? `/settings/agents/${encodeURIComponent(r.agentId)}`
          : "/settings/agents";
      }
      if (!r.section) return "/settings";
      if (r.section === "pairing") return "/settings/pairing";
      if (r.section === "comms") return "/settings/comms";
      return `/settings/${r.section}`;
    case "ops":
      if (!r.mode) return "/ops";
      if (r.mode === "tail" || r.mode === "plan") {
        const params = new URLSearchParams();
        if (r.mode === "tail" && r.tailQuery) params.set("q", r.tailQuery);
        if (r.mode === "plan" && r.planDocumentId) params.set("plan", r.planDocumentId);
        if (r.flightId) params.set("flightId", r.flightId);
        if (r.invocationId) params.set("invocationId", r.invocationId);
        if (r.conversationId) params.set("conversationId", r.conversationId);
        if (r.workId) params.set("workId", r.workId);
        if (r.sessionId) params.set("sessionId", r.sessionId);
        if (r.targetAgentId) params.set("targetAgentId", r.targetAgentId);
        return `/ops/${opsModePath(r.mode)}${searchSuffix(params)}`;
      }
      return `/ops/${opsModePath(r.mode)}`;
    case "follow": {
      const params = new URLSearchParams();
      if (r.preferredView) params.set("view", r.preferredView);
      if (r.flightId) params.set("flightId", r.flightId);
      if (r.invocationId) params.set("invocationId", r.invocationId);
      if (r.conversationId) params.set("conversationId", r.conversationId);
      if (r.workId) params.set("workId", r.workId);
      if (r.sessionId) params.set("sessionId", r.sessionId);
      if (r.targetAgentId) params.set("targetAgentId", r.targetAgentId);
      if (r.machineId) params.set(MACHINE_SCOPE_PARAM, r.machineId);
      const search = params.toString();
      return `/follow${search ? `?${search}` : ""}`;
    }
    case "terminal":
      if (r.agentId) {
        const params = new URLSearchParams();
        if (r.mode) params.set("mode", r.mode);
        return `/terminal/${encodeURIComponent(r.agentId)}${searchSuffix(params)}`;
      }
      {
        const params = new URLSearchParams();
        if (r.terminalBackend) {
          if (r.terminalBackend !== "pty") params.set("backend", r.terminalBackend);
          if (r.terminalAgent && r.terminalAgent !== "shell") params.set("agent", r.terminalAgent);
          if (r.terminalSessionName) params.set("name", r.terminalSessionName);
          if (r.terminalTabId) params.set("tab", r.terminalTabId);
          if (r.zellijSocketDir) params.set("socketDir", r.zellijSocketDir);
          return `/terminal/new${searchSuffix(params)}`;
        }
        if (r.mode) params.set("mode", r.mode);
        const surfaceParts = surfacePartsFromKey(r.terminalSurfaceKey);
        if (surfaceParts) {
          return `/terminal/${encodeURIComponent(surfaceParts.backend)}/${encodeURIComponent(surfaceParts.sessionName)}${searchSuffix(params)}`;
        }
        // Pane- or node-scoped surfaces have no readable two-segment form.
        if (isTerminalSurfaceId(r.terminalSurfaceKey)) {
          return `/terminal/s/${encodeURIComponent(r.terminalSurfaceKey!)}${searchSuffix(params)}`;
        }
        if (r.terminalSessionId) params.set("session", r.terminalSessionId);
        if (r.terminalSurfaceKey) params.set("surface", r.terminalSurfaceKey);
        return `/terminal${searchSuffix(params)}`;
      }
  }
}

/** Scroll-memory key for a route; exported for tests. Sole owner: useRouter's scrollMap. */
export function routeKey(r: Route): string {
  const scope = routeScopeKey(r);
  switch (r.view) {
    case "conversation":
      return `conv:${r.conversationId}${scope}`;
    case "agent-info":
      return `agent-info:${r.conversationId}`;
    case "settings":
      return `settings:${r.section ?? "pairing"}:${r.agentId ?? ""}`;
    case "agents-v2":
      return [
        "agents-v2",
        r.projectSlug ?? "",
        r.harness ?? "",
        r.node ?? "",
        r.set ?? "",
        r.indexView ?? "agents",
        r.stateFilter ?? "",
        r.showEphemeral ? "eph" : "",
        r.agentId ?? "",
        r.sessionId ?? "",
        scope,
      ].join(":");
    case "sessions":
      return r.flightId
        ? `flight-observe:${r.flightId}:${r.sessionId ?? ""}:${r.compareSessionId ?? ""}${scope}`
        : r.sessionId ? `session:${r.agentId ?? ""}:${r.sessionId}${scope}` : `sessions${scope}`;
    case "messages":
      return r.conversationId ? `messages:${r.conversationId}${scope}` : `messages${scope}`;
    case "work":
      return `work:${r.workId}${scope}`;
    case "ops":
      return `ops:${r.mode ?? "plan"}:${r.tailQuery ?? ""}:${r.planDocumentId ?? ""}:${r.flightId ?? ""}:${r.invocationId ?? ""}:${r.workId ?? ""}:${r.conversationId ?? ""}:${r.sessionId ?? ""}:${r.targetAgentId ?? ""}`;
    case "search":
      return `search:${r.mode ?? "knowledge"}:${r.hitId ?? ""}`;
    case "broker":
      return `broker:${r.attemptId ?? ""}`;
    case "follow":
      return `follow:${r.flightId ?? r.invocationId ?? r.conversationId ?? r.workId ?? r.sessionId ?? r.targetAgentId ?? ""}:${r.preferredView ?? ""}${scope}`;
    case "terminal":
      return `terminal:${r.agentId ?? ""}:${r.terminalSessionId ?? ""}:${r.terminalSurfaceKey ?? ""}:${r.terminalBackend ?? ""}:${r.terminalAgent ?? ""}:${r.terminalSessionName ?? ""}:${r.terminalTabId ?? ""}:${r.mode ?? "detail"}`;
    case "repo-diff":
      return `repo-diff:${r.path}`;
    default:
      return `${r.view}${scope}`;
  }
}

/* ── Router hook ── */

function routeFromLocation(pathname: string, searchStr: string): Route {
  return normalizeRoute(routeFromUrl(`${pathname}${searchStr}`));
}

/* ── Browser location store ── */

export type BrowserLocationState = {
  pathname: string;
  searchStr: string;
  /** Location hash without the leading "#". */
  hash: string;
  /** history.state for the active entry. */
  state: unknown;
};

function locationHashSuffix(hash: string): string {
  return hash ? `#${hash}` : "";
}

function isStandaloneEmbedPath(pathname: string): boolean {
  return pathname.startsWith("/embed/") || pathname === "/ops/lanes/embed";
}

function readBrowserLocation(): BrowserLocationState {
  if (typeof window === "undefined") {
    const url = new URL(APP_URL_BASE);
    return {
      pathname: url.pathname,
      searchStr: url.search,
      hash: url.hash.replace(/^#/, ""),
      state: null,
    };
  }
  return {
    pathname: window.location.pathname,
    searchStr: window.location.search,
    hash: window.location.hash.replace(/^#/, ""),
    state: window.history.state,
  };
}

function isSameBrowserLocation(a: BrowserLocationState, b: BrowserLocationState): boolean {
  return a.pathname === b.pathname
    && a.searchStr === b.searchStr
    && a.hash === b.hash
    && Object.is(a.state, b.state);
}

/** Platform hooks the location store needs; injectable so tests can drive it headlessly. */
export type BrowserLocationEnv = {
  read: () => BrowserLocationState;
  push: (href: string, state: unknown) => void;
  replace: (href: string, state: unknown) => void;
  /** Observe browser-driven location changes (popstate / hashchange). */
  observe: (onChange: () => void) => () => void;
};

export type BrowserLocationStore = {
  getSnapshot: () => BrowserLocationState;
  subscribe: (listener: () => void) => () => void;
  navigateTo: (href: string, options?: { replace?: boolean; state?: unknown }) => void;
};

/**
 * Single reactive owner of the browser location. Internal push/replace
 * operations publish synchronously; popstate/hashchange are observed through
 * the env. Subscribers read an immutable snapshot via useSyncExternalStore.
 */
export function createBrowserLocationStore(env: BrowserLocationEnv): BrowserLocationStore {
  let snapshot = env.read();
  const listeners = new Set<() => void>();
  let stopObserving: (() => void) | null = null;

  const syncFromEnv = () => {
    const next = env.read();
    if (isSameBrowserLocation(snapshot, next)) return;
    snapshot = next;
    for (const listener of listeners) listener();
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (!stopObserving) stopObserving = env.observe(syncFromEnv);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    navigateTo(href, options = {}) {
      const state = options.state === undefined ? snapshot.state : options.state;
      if (options.replace) {
        env.replace(href, state);
      } else {
        env.push(href, state);
      }
      syncFromEnv();
    },
  };
}

function windowLocationEnv(): BrowserLocationEnv {
  if (typeof window === "undefined") {
    return {
      read: readBrowserLocation,
      push: () => {},
      replace: () => {},
      observe: () => () => {},
    };
  }
  return {
    read: readBrowserLocation,
    push: (href, state) => window.history.pushState(state, "", href),
    replace: (href, state) => window.history.replaceState(state, "", href),
    observe: (onChange) => {
      window.addEventListener("popstate", onChange);
      window.addEventListener("hashchange", onChange);
      return () => {
        window.removeEventListener("popstate", onChange);
        window.removeEventListener("hashchange", onChange);
      };
    },
  };
}

const browserLocationStore = createBrowserLocationStore(windowLocationEnv());

/** Reactive browser location for any component (shell or scope namespace). */
export function useBrowserLocation(): BrowserLocationState {
  return useSyncExternalStore(
    browserLocationStore.subscribe,
    browserLocationStore.getSnapshot,
    browserLocationStore.getSnapshot,
  );
}

function navigateBrowser(href: string, options: { replace?: boolean; state?: unknown } = {}): void {
  browserLocationStore.navigateTo(href, options);
}

type BrowserNavigationAPI = {
  readonly canGoBack: boolean;
  back: () => unknown;
};

function browserNavigationAPI(): BrowserNavigationAPI | null {
  if (typeof window === "undefined") return null;
  return (window as Window & { navigation?: BrowserNavigationAPI }).navigation ?? null;
}

/** Whether the browser has a previous entry for the current tab. */
export function canNavigateBrowserBack(): boolean {
  if (typeof window === "undefined") return false;
  const navigation = browserNavigationAPI();
  return navigation ? navigation.canGoBack : window.history.length > 1;
}

/**
 * Use the browser's real session history so toolbar/mouse Back and Scout's Back
 * control all resolve the same route stack.
 */
export function navigateBrowserBack(): void {
  if (!canNavigateBrowserBack()) return;
  const navigation = browserNavigationAPI();
  if (navigation) {
    void navigation.back();
    return;
  }
  window.history.back();
}

/* ── URL policy: search params, hash, history entry state ── */

/** Typed history-entry payload owned by the Scout router. */
export type ScoutHistoryState = {
  /** Origin route for BackToPicker (set by navigate with `returnTo`). */
  returnTo?: Route;
  /**
   * When true, the previous history entry is the recorded origin of this
   * navigation, so BackToPicker may prefer `history.back()`.
   */
  returnUseHistory?: boolean;
  /**
   * Marks a /settings/* entry pushed by openSettings, so closeSettings may
   * prefer `history.back()` and restore wherever the user came from.
   */
  settingsEntry?: boolean;
  [key: string]: unknown;
};

export type NavigateOptions = {
  /** Replace the current history entry instead of pushing a new one. */
  replace?: boolean;
  /**
   * Hash for the destination (with or without "#"). Hashes clear by default on
   * navigation — pass one explicitly to retain or set it.
   */
  hash?: string | null;
  /** history.state for the destination entry; defaults to the current entry's. */
  state?: unknown;
  /**
   * Origin route stored on the destination history entry for BackToPicker.
   * Replaces the former sessionStorage nav-return side channel.
   */
  returnTo?: Route;
  /**
   * Carry whitelisted global search params (feature flags) onto the
   * destination. Default true; route-local params never carry either way.
   */
  preserveSearch?: boolean;
};

export function readReturnToFromState(state: unknown): Route | null {
  if (!state || typeof state !== "object") return null;
  const returnTo = (state as ScoutHistoryState).returnTo;
  if (!returnTo || typeof returnTo !== "object") return null;
  if (typeof (returnTo as Route).view !== "string") return null;
  return returnTo as Route;
}

export function shouldUseHistoryBack(state: unknown): boolean {
  if (!state || typeof state !== "object") return false;
  return (state as ScoutHistoryState).returnUseHistory === true;
}

export function isSettingsHistoryEntry(state: unknown): boolean {
  if (!state || typeof state !== "object") return false;
  return (state as ScoutHistoryState).settingsEntry === true;
}

/**
 * Entry-scoped keys (returnTo/returnUseHistory/settingsEntry) describe how the
 * user ARRIVED at an entry; they must never be inherited by the next entry a
 * plain navigate pushes, or BackToPicker/closeSettings would act on a stale
 * origin. Strip them unless this navigate call sets them explicitly.
 */
function stripEntryScopedState(state: unknown): unknown {
  if (!state || typeof state !== "object") return state;
  const {
    returnTo: _returnTo,
    returnUseHistory: _returnUseHistory,
    settingsEntry: _settingsEntry,
    ...rest
  } = state as ScoutHistoryState;
  return rest;
}

/** Exported for tests. */
export function buildNavigateState(
  currentState: unknown,
  options: NavigateOptions,
): unknown {
  if (options.returnTo !== undefined) {
    const base =
      options.state !== undefined
        ? options.state
        : stripEntryScopedState(currentState);
    const merged: ScoutHistoryState =
      base && typeof base === "object" ? { ...(base as ScoutHistoryState) } : {};
    merged.returnTo = options.returnTo;
    // history.back() only lands on the recorded origin when this navigation
    // pushed a fresh entry on top of it; a replace keeps the current entry, so
    // the predecessor is whatever was there before — BackToPicker must fall
    // back to navigating to returnTo instead.
    merged.returnUseHistory = options.replace !== true;
    return merged;
  }
  if (options.state !== undefined) return options.state;
  // replace keeps the same history entry, so entry-scoped state (returnTo,
  // settingsEntry) stays accurate and is preserved; only a pushed entry is a
  // new arrival that must not inherit its predecessor's origin.
  if (options.replace) return currentState;
  return stripEntryScopedState(currentState);
}

function normalizeHashOption(hash: string | null | undefined): string {
  return hash ? hash.replace(/^#/, "") : "";
}

/**
 * Pure navigation planner: applies the machine-scope propagation rules and the
 * search/hash policy to produce the destination href. The hash defaults to
 * cleared; only whitelisted global params survive from the current search
 * (route serialization owns route-local params; machineId rides the Route).
 */
export function planNavigation(
  current: Pick<BrowserLocationState, "pathname" | "searchStr">,
  requestedRoute: Route,
  options: NavigateOptions = {},
): { route: Route; href: string } {
  const currentRoute = routeFromLocation(current.pathname, current.searchStr);
  const nextRoute = resolveNavigatedMachineScope(requestedRoute, currentRoute);
  const preservedSearch = options.preserveSearch === false ? "" : current.searchStr;
  const canonicalPath = preserveLocationSearch(routePath(nextRoute, current.pathname), preservedSearch);
  const hash = normalizeHashOption(options.hash);
  return { route: nextRoute, href: `${canonicalPath}${hash ? `#${hash}` : ""}` };
}

export type LocationUpdate = {
  /** Set a key to a value, or null to remove it. Applied over the current search. */
  searchPatch?: Record<string, string | null>;
  /** Set the hash (with or without "#"); null clears it; undefined leaves it. */
  hash?: string | null;
  /** Default true — URL UI-state patches replace rather than push. */
  replace?: boolean;
  /** history.state for the entry; defaults to the current entry's. */
  state?: unknown;
};

/** Pure href computation for updateLocation; exported for tests. */
export function applyLocationUpdate(
  current: Pick<BrowserLocationState, "pathname" | "searchStr" | "hash">,
  update: LocationUpdate,
): string {
  const params = new URLSearchParams(current.searchStr);
  for (const [key, value] of Object.entries(update.searchPatch ?? {})) {
    if (value === null) params.delete(key);
    else params.set(key, value);
  }
  const search = params.toString();
  const hash = update.hash === undefined ? current.hash : normalizeHashOption(update.hash);
  return `${current.pathname}${search ? `?${search}` : ""}${hash ? `#${hash}` : ""}`;
}

/**
 * Narrow escape hatch for URL UI state that is not a product Route (lane-sheet
 * section hashes, dev-only query cleanup, scope layout toggles). Publishes
 * through the same location store as navigate(). Product navigation must use
 * navigate(); the terminal embed keeps its own isolated local router.
 */
export function updateLocation(update: LocationUpdate): void {
  const current = browserLocationStore.getSnapshot();
  const href = applyLocationUpdate(current, update);
  const currentHref = `${current.pathname}${current.searchStr}${locationHashSuffix(current.hash)}`;
  if (href === currentHref) return;
  navigateBrowser(href, { replace: update.replace ?? true, state: update.state });
}

/**
 * Canonical href for a location, or null when already canonical. Handles the
 * legacy /scout → /scope rewrite and trailing-slash/alias normalization that
 * used to race with the TanStack beforeLoad redirect; the replace here is now
 * the only canonicalizer. The current hash is retained (same logical location);
 * only whitelisted global search params carry over.
 */
export function canonicalHrefForRoute(pathname: string, searchStr: string, hash: string): string | null {
  if (isStandaloneEmbedPath(pathname)) return null;
  const routeUrl = `${pathname}${searchStr}`;
  const raw = routeFromUrl(routeUrl);
  const normalized = normalizeRoute(raw);
  const canonicalPath = preserveLocationSearch(routePath(normalized, pathname), searchStr);
  const shouldCanonicalize =
    routeKey(raw) !== routeKey(normalized)
    || normalized.view === "agents-v2"
    || routeUrl !== canonicalPath;
  if (!shouldCanonicalize || routeUrl === canonicalPath) return null;
  return `${canonicalPath}${locationHashSuffix(hash)}`;
}

export function useRouter() {
  const { pathname, searchStr, hash } = useBrowserLocation();
  const routeUrl = `${pathname}${searchStr}`;
  const route = useMemo(() => routeFromLocation(pathname, searchStr), [pathname, searchStr]);
  const scrollMap = useRef<Record<string, number>>({});
  const prevRouteUrl = useRef(routeUrl);

  useEffect(() => {
    const canonicalHref = canonicalHrefForRoute(pathname, searchStr, hash);
    if (canonicalHref) {
      navigateBrowser(canonicalHref, { replace: true });
    }
  }, [pathname, searchStr, hash]);

  useEffect(() => {
    if (prevRouteUrl.current === routeUrl) return;
    const r = routeFromLocation(pathname, searchStr);
    requestAnimationFrame(() => {
      window.scrollTo(0, scrollMap.current[routeKey(r)] ?? 0);
    });
    prevRouteUrl.current = routeUrl;
  }, [routeUrl, pathname, searchStr]);

  const navigate = useCallback((r: Route, options: NavigateOptions = {}) => {
    const requestedRoute: Route = normalizeRoute(
      r.view === "ops" && !isOpsEnabled() && !isUngatedOpsSurface(r.mode)
        ? { view: "inbox" }
        : r,
    );
    const currentRoute = routeFromLocation(pathname, searchStr);
    const { route: nextRoute, href } = planNavigation({ pathname, searchStr }, requestedRoute, options);
    scrollMap.current[routeKey(currentRoute)] = window.scrollY;
    const currentState = browserLocationStore.getSnapshot().state;
    const state = buildNavigateState(currentState, options);
    navigateBrowser(href, { replace: options.replace, state });
    requestAnimationFrame(() => {
      window.scrollTo(0, scrollMap.current[routeKey(nextRoute)] ?? 0);
    });
  }, [pathname, searchStr]);

  const navigateBack = useCallback(() => navigateBrowserBack(), []);
  const canNavigateBack = canNavigateBrowserBack();

  return { route, navigate, navigateBack, canNavigateBack };
}
