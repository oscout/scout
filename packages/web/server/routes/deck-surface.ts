import { homedir } from "node:os";
import { resolve } from "node:path";

import type { Hono } from "hono";
import {
  connectCodexDeckThread,
  getCodexDeckThreadSnapshot,
  getLocalAgentConfig,
  isCodexDeckThreadConnected,
  interruptCodexDeckTurn,
  startCodexDeckTurn,
  steerCodexDeckTurn,
} from "@openscout/runtime/local-agents";
import { snapshotRecentEvents, type TailEvent } from "@openscout/runtime/tail";

import { queryAgents } from "../db/agents.ts";
import type { WebAgent } from "../db/types/web.ts";
import { createScoutSession } from "../core/mobile/service.ts";
import {
  SCOUT_SURFACE_LIMITS,
  SCOUT_SURFACE_METHOD_POLICY,
  SCOUT_SURFACE_PROTOCOL_VERSION,
  isScoutSurfaceMethod,
  type CodexDeckRoute,
  type CodexDeckThreadSnapshot,
  type FleetAgentSnapshot,
  type FleetObserveSnapshot,
  type FleetTailSnapshot,
  type HostScope,
  type ScoutSurfaceErrorCode,
  type ScoutSurfaceMethod,
  type ScoutSurfaceReply,
  type ScoutSurfaceRequest,
  type SurfaceAgent,
  type SurfaceObserveEvent,
  type SurfaceTailEvent,
} from "../../client/surface-contract/scout-surface-contract.ts";

const DECK_SURFACE_PATH = "/api/surfaces/deck";
const MAXIMUM_DECK_AGENTS = 16;
const HOST_SCOPED_METHODS = new Set<ScoutSurfaceMethod>([
  "agents.list",
  "agents.observe",
  "tail.recent",
  "tail.subscribe",
]);

export type ScoutDeckSurfaceServiceOptions = {
  currentDirectory: string;
  hostName: string;
  hostId?: string;
  assetRevision?: string;
  now?: () => number;
  listAgents?: () => WebAgent[];
  recentTail?: (limit: number) => TailEvent[] | Promise<TailEvent[]>;
  codex?: {
    snapshot(agentId: string, connect: boolean): Promise<CodexDeckThreadSnapshot>;
    start(agentId: string, text: string): Promise<unknown>;
    steer(agentId: string, text: string): Promise<unknown>;
    interrupt(agentId: string): Promise<unknown>;
  };
  startCodexSession?: (source: WebAgent) => Promise<{
    agentId: string;
    conversationId: string | null;
    sessionId: string | null;
  }>;
};

export type ScoutDeckSurfaceService = {
  hostId: string;
  handle(request: ScoutSurfaceRequest): Promise<ScoutSurfaceReply>;
};

export function mountScoutDeckSurfaceRoutes(
  app: Hono,
  options: ScoutDeckSurfaceServiceOptions,
): ScoutDeckSurfaceService {
  const service = createScoutDeckSurfaceService(options);

  app.post(DECK_SURFACE_PATH, async (c) => {
    const declaredLength = Number(c.req.header("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > SCOUT_SURFACE_LIMITS.requestBytes) {
      return c.json({ error: "Scout Deck request is too large." }, 413);
    }

    const input = await c.req.json().catch(() => null);
    const request = parseDeckSurfaceRequest(input);
    if (!request) {
      return c.json({ error: "Invalid Scout Deck surface request." }, 400);
    }

    return c.json(await service.handle(request));
  });

  return service;
}

export function createScoutDeckSurfaceService(
  options: ScoutDeckSurfaceServiceOptions,
): ScoutDeckSurfaceService {
  const now = options.now ?? (() => Date.now());
  const epoch = crypto.randomUUID();
  const hostName = options.hostName.trim() || "This Mac";
  const hostId = options.hostId?.trim() || `web:${hostName.toLowerCase()}`;
  const listAgents = options.listAgents ?? (() => queryAgents(500));
  const recentTail = options.recentTail ?? ((limit) => snapshotRecentEvents(limit));
  const codex = options.codex ?? {
    snapshot: defaultCodexSnapshot,
    start: startCodexDeckTurn,
    steer: steerCodexDeckTurn,
    interrupt: interruptCodexDeckTurn,
  };
  const startCodexSession = options.startCodexSession ?? (async (source: WebAgent) => {
    const workspaceRoot = normalizedPath(source.projectRoot ?? source.cwd);
    if (!workspaceRoot) {
      throw new DeckSurfaceFailure("invalid_route", "The selected lane does not report a workspace.");
    }
    // Imported lazily: a top-level import creates a module cycle through
    // core/mobile/service.ts -> core/broker/service.ts that leaves
    // openScoutPeerSession unresolved when the web server module loads.
    const { createScoutSession } = await import("../core/mobile/service.ts");
    const handle = await createScoutSession({
      workspaceId: workspaceRoot,
      harness: "codex",
      forceNew: true,
    }, options.currentDirectory);
    return {
      agentId: handle.agent.id,
      conversationId: handle.session.conversationId,
      sessionId: handle.agent.sessionId,
    };
  });

  const cursor = (sequence: number) => ({
    epoch,
    sequence: Math.max(0, Math.trunc(sequence)),
    connectionRevision: 1,
  });

  const visibleAgents = (): WebAgent[] => rankDeckAgents(
    listAgents().filter((agent) => !agent.retiredFromFleet && !agent.staleLocalRegistration),
    options.currentDirectory,
  ).slice(0, MAXIMUM_DECK_AGENTS);

  const requireScope = (request: ScoutSurfaceRequest): HostScope => {
    const requested = "hostIds" in request ? request.hostIds : undefined;
    if (!requested || requested.length !== 1 || requested[0] !== hostId) {
      throw new DeckSurfaceFailure("invalid_route", "The requested host is not available on this Deck.");
    }
    return { hostIds: [hostId] };
  };

  const requireAgentLane = (route: CodexDeckRoute): WebAgent => {
    if (route.hostId !== hostId) {
      throw new DeckSurfaceFailure("invalid_route", "The selected lane belongs to a different host.");
    }
    const agent = listAgents().find((candidate) => candidate.id === route.agentId);
    if (!agent || agent.retiredFromFleet || agent.staleLocalRegistration) {
      throw new DeckSurfaceFailure("invalid_route", "The selected agent lane is unavailable.");
    }
    return agent;
  };

  const requireRoute = (route: CodexDeckRoute): WebAgent => {
    const agent = requireAgentLane(route);
    if (agent.harness !== "codex" || agent.transport !== "codex_app_server") {
      throw new DeckSurfaceFailure(
        "unsupported_capability",
        "The selected lane does not expose Scout's managed Codex adapter.",
      );
    }
    return agent;
  };

  const fleetAgents = (): FleetAgentSnapshot => {
    const agents = visibleAgents().map(toSurfaceAgent);
    const sequence = agents.reduce((latest, agent) => Math.max(latest, agent.updatedAt ?? 0), 0);
    return {
      hosts: [{
        hostId,
        ready: true,
        value: { cursor: cursor(sequence), agents },
      }],
    };
  };

  const fleetTail = async (limit = 200): Promise<FleetTailSnapshot> => {
    const agents = visibleAgents();
    const events = (await recentTail(Math.min(Math.max(limit, 1), 1_000)))
      .map((event) => toSurfaceTailEvent(event, agents));
    const sequence = events.reduce((latest, event) => Math.max(latest, event.at), 0);
    return {
      hosts: [{
        hostId,
        ready: true,
        value: {
          cursor: cursor(sequence),
          nextCursor: null,
          events,
        },
      }],
    };
  };

  const observeAgents = async (agentIds: readonly string[]): Promise<FleetObserveSnapshot> => {
    const agents = visibleAgents().filter((agent) => agentIds.includes(agent.id));
    const tail = await fleetTail(256);
    const events = tail.hosts[0]?.ready ? tail.hosts[0].value.events : [];
    const byAgent = new Map<string, SurfaceTailEvent[]>();
    for (const event of events) {
      if (!event.agentId) continue;
      byAgent.set(event.agentId, [...(byAgent.get(event.agentId) ?? []), event]);
    }
    const observed = agents.map((agent) => {
      const matching = byAgent.get(agent.id) ?? [];
      return {
        agentId: agent.id,
        source: matching.length > 0 ? "live" as const : "unavailable" as const,
        fidelity: "timestamped" as const,
        sessionId: agent.harnessSessionId,
        updatedAt: Math.max(agent.updatedAt ?? 0, ...matching.map((event) => event.at)),
        events: matching.slice(-64).map(toObserveEvent),
      };
    });
    const sequence = observed.reduce((latest, agent) => Math.max(latest, agent.updatedAt), 0);
    return {
      hosts: [{ hostId, ready: true, value: { cursor: cursor(sequence), agents: observed } }],
    };
  };

  return {
    hostId,
    async handle(request) {
      const deadline = appliedDeadline(request.method, request.deadlineMs);
      try {
        if (request.surface !== "deck") {
          return errorReply(request, "protocol_mismatch", "This endpoint only serves the Scout Deck.", deadline);
        }
        if (!SCOUT_SURFACE_METHOD_POLICY[request.method].surfaces.some((surface) => surface === "deck")) {
          return errorReply(request, "unsupported_capability", "This capability is unavailable on the Deck.", deadline);
        }
        if (HOST_SCOPED_METHODS.has(request.method)) requireScope(request);

        switch (request.method) {
          case "bootstrap":
            return successReply(request, {
              surface: "deck",
              assetRevision: options.assetRevision ?? "web-live",
              protocolVersion: SCOUT_SURFACE_PROTOCOL_VERSION,
              minimumSurfaceProtocolVersion: SCOUT_SURFACE_PROTOCOL_VERSION,
              minimumNativeProtocolVersion: SCOUT_SURFACE_PROTOCOL_VERSION,
              capabilities: [
                "bootstrap",
                "native.openExternalURL",
                "native.getPreferences",
                "native.setPreferences",
                "native.cancel",
                "agents.list",
                "agents.observe",
                "tail.recent",
                "native.setLaneSelection",
                "codex.session.start",
                "codex.thread.snapshot",
                "codex.thread.connect",
                "codex.turn.start",
                "codex.turn.steer",
                "codex.turn.interrupt",
              ],
              device: { platform: "web", formFactor: "tablet" },
              hosts: [{ id: hostId, name: hostName, state: "connected" }],
              selectedHostIds: [hostId],
              focusedHostId: hostId,
              connectionRevision: 1,
              activity: "visible",
            }, deadline);
          case "agents.list":
            return successReply(request, fleetAgents(), deadline);
          case "agents.observe": {
            const agentIds = readStringArray(request.params, "agentIds", SCOUT_SURFACE_LIMITS.agentIds);
            if (agentIds.length === 0) throw new DeckSurfaceFailure("invalid_params", "agentIds are required.");
            return successReply(request, await observeAgents(agentIds), deadline);
          }
          case "tail.recent": {
            const limit = readOptionalInteger(request.params, "limit") ?? 200;
            return successReply(request, await fleetTail(limit), deadline);
          }
          case "native.setLaneSelection": {
            const selection = readRecord(request.params)["selection"];
            if (selection != null) {
              const selected = readRecord(selection);
              requireAgentLane({
                hostId: readRequiredString(selected, "hostId"),
                agentId: readRequiredString(selected, "agentId"),
              });
            }
            return successReply(request, { accepted: true }, deadline);
          }
          case "native.cancel":
            return successReply(request, { accepted: true }, deadline);
          case "codex.session.start": {
            const route = readCodexRoute(request.params);
            const source = requireAgentLane(route);
            const started = await startCodexSession(source);
            return successReply(request, {
              accepted: true,
              hostId,
              sourceAgentId: source.id,
              ...started,
            }, deadline);
          }
          case "codex.thread.snapshot":
          case "codex.thread.connect": {
            const route = readCodexRoute(request.params);
            requireRoute(route);
            return successReply(request, await codex.snapshot(route.agentId, request.method === "codex.thread.connect"), deadline);
          }
          case "codex.turn.start":
          case "codex.turn.steer": {
            const route = readCodexRoute(request.params);
            requireRoute(route);
            const text = readRequiredString(readRecord(request.params), "text", SCOUT_SURFACE_LIMITS.stringBytes);
            const receipt = request.method === "codex.turn.steer"
              ? await codex.steer(route.agentId, text)
              : await codex.start(route.agentId, text);
            return successReply(request, receipt, deadline);
          }
          case "codex.turn.interrupt": {
            const route = readCodexRoute(request.params);
            requireRoute(route);
            return successReply(request, await codex.interrupt(route.agentId), deadline);
          }
          default:
            return errorReply(request, "unsupported_capability", "This method is owned by the browser or native host.", deadline);
        }
      } catch (cause) {
        if (cause instanceof DeckSurfaceFailure) {
          return errorReply(request, cause.code, cause.message, deadline);
        }
        return errorReply(
          request,
          "not_connected",
          cause instanceof Error ? cause.message : String(cause),
          deadline,
          true,
        );
      }
    },
  };
}

async function defaultCodexSnapshot(agentId: string, connect: boolean): Promise<CodexDeckThreadSnapshot> {
  const config = await getLocalAgentConfig(agentId);
  if (!config) {
    throw new DeckSurfaceFailure("invalid_route", `Agent ${agentId} is not configured on this host.`);
  }
  if (config.runtime.transport !== "codex_app_server") {
    throw new DeckSurfaceFailure(
      "unsupported_capability",
      `Agent ${agentId} uses ${config.runtime.transport}; the Deck requires codex_app_server.`,
    );
  }

  const connected = connect ? await connectCodexDeckThread(agentId) : null;
  const online = connected ? true : await isCodexDeckThreadConnected(agentId);
  const snapshot = await getCodexDeckThreadSnapshot(agentId);
  const currentTurn = snapshot?.currentTurnId
    ? snapshot.turns.find((turn) => turn.id === snapshot.currentTurnId) ?? null
    : null;
  const running = Boolean(currentTurn && !["completed", "interrupted", "error"].includes(currentTurn.status));
  const observedThreadId = snapshot?.session.providerMeta?.threadId;
  const threadId = connected?.threadId
    ?? (typeof observedThreadId === "string" ? observedThreadId : snapshot?.session.id ?? null);

  return {
    adapter: "codex_app_server",
    agentId,
    threadId,
    turnId: online && running ? currentTurn?.id ?? null : null,
    state: online ? running ? "running" : "idle" : "disconnected",
    capabilities: {
      connect: true,
      start: true,
      steer: true,
      interrupt: true,
      queue: false,
      approvals: false,
    },
    capabilityNotes: {
      queue: "The Deck sends directly to Scout's managed Codex session and does not invent a client-side queue.",
      approvals: "Approval prompts remain runtime-owned and are not actionable from Deck yet.",
    },
    snapshot,
  };
}

function parseDeckSurfaceRequest(input: unknown): ScoutSurfaceRequest | null {
  if (!isRecord(input)) return null;
  if (input["v"] !== SCOUT_SURFACE_PROTOCOL_VERSION || input["surface"] !== "deck") return null;
  if (typeof input["id"] !== "string" || input["id"].length === 0 || input["id"].length > 128) return null;
  if (typeof input["method"] !== "string" || !isScoutSurfaceMethod(input["method"])) return null;
  if (!isRecord(input["params"])) return null;
  if (JSON.stringify(input).length > SCOUT_SURFACE_LIMITS.requestBytes) return null;
  return input as ScoutSurfaceRequest;
}

function successReply(
  request: ScoutSurfaceRequest,
  result: unknown,
  appliedDeadlineMs: number,
): ScoutSurfaceReply {
  return {
    v: SCOUT_SURFACE_PROTOCOL_VERSION,
    id: request.id,
    method: request.method,
    metadata: { appliedDeadlineMs },
    result,
  } as ScoutSurfaceReply;
}

function errorReply(
  request: ScoutSurfaceRequest,
  code: ScoutSurfaceErrorCode,
  message: string,
  appliedDeadlineMs: number,
  retryable = false,
): ScoutSurfaceReply {
  return {
    v: SCOUT_SURFACE_PROTOCOL_VERSION,
    id: request.id,
    method: request.method,
    metadata: { appliedDeadlineMs },
    error: { code, message, retryable },
  };
}

function appliedDeadline(method: ScoutSurfaceMethod, requested: number | undefined): number {
  const policy = SCOUT_SURFACE_METHOD_POLICY[method];
  const value = Number.isFinite(requested) ? Math.trunc(requested!) : policy.defaultDeadlineMs;
  return Math.min(Math.max(value, 1), policy.maximumDeadlineMs);
}

function rankDeckAgents(agents: readonly WebAgent[], currentDirectory: string): WebAgent[] {
  const current = normalizedPath(currentDirectory);
  return [...agents].sort((left, right) => {
    const score = (agent: WebAgent) => {
      // A declared project root is a much stronger signal than the cwd of a
      // long-lived helper process. In particular, Scoutbot can inherit the web
      // server's cwd while still representing another workspace.
      const currentWorkspace = normalizedPath(agent.projectRoot) === current
        ? 20_000
        : normalizedPath(agent.cwd) === current
          ? 10_000
          : 0;
      const controllable = agent.harness === "codex" && agent.transport === "codex_app_server" ? 1_000 : 0;
      const attention = ["waiting", "blocked", "error", "needs_attention"].includes(agent.state ?? "") ? 500 : 0;
      const live = ["working", "running", "active", "busy"].includes(agent.state ?? "") ? 250 : 0;
      return currentWorkspace + controllable + attention + live;
    };
    return score(right) - score(left)
      || (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
      || left.name.localeCompare(right.name);
  });
}

function toSurfaceAgent(agent: WebAgent): SurfaceAgent {
  return {
    id: agent.id,
    name: agent.name,
    handle: agent.handle,
    harness: agent.harness,
    transport: agent.transport,
    model: agent.model,
    state: agent.state,
    projectRoot: agent.projectRoot ?? agent.cwd,
    conversationId: agent.conversationId,
    sessionId: agent.harnessSessionId,
    updatedAt: agent.updatedAt,
  };
}

function toSurfaceTailEvent(event: TailEvent, agents: readonly WebAgent[]): SurfaceTailEvent {
  const agent = resolveTailAgent(event, agents);
  return {
    id: event.id,
    at: event.ts,
    agentId: agent?.id ?? null,
    sessionId: event.sessionId || null,
    kind: tailKind(event.kind),
    text: event.summary,
    detail: [event.source, event.project].filter(Boolean).join(" · "),
  };
}

function resolveTailAgent(event: TailEvent, agents: readonly WebAgent[]): WebAgent | null {
  const exactSession = agents.find((agent) => agent.harnessSessionId && agent.harnessSessionId === event.sessionId);
  if (exactSession) return exactSession;
  const eventCwd = normalizedPath(event.cwd);
  return agents.find((agent) => [agent.cwd, agent.projectRoot].map(normalizedPath).includes(eventCwd)) ?? null;
}

function tailKind(kind: TailEvent["kind"]): SurfaceTailEvent["kind"] {
  if (kind === "tool" || kind === "tool-result") return "tool";
  if (kind === "assistant") return "think";
  if (kind === "user") return "message";
  if (kind === "system") return "system";
  return "note";
}

function toObserveEvent(event: SurfaceTailEvent): SurfaceObserveEvent {
  return {
    id: event.id,
    at: event.at,
    kind: event.kind === "message" ? "message" : event.kind === "tool" ? "tool" : event.kind === "think" ? "think" : "note",
    text: event.text,
    detail: event.detail,
  };
}

function normalizedPath(value: string | null | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return "";
  const expanded = trimmed === "~" ? homedir() : trimmed.startsWith("~/") ? resolve(homedir(), trimmed.slice(2)) : trimmed;
  return resolve(expanded).replace(/\/$/, "");
}

function readCodexRoute(params: unknown): CodexDeckRoute {
  const route = readRecord(readRecord(params)["route"]);
  return {
    hostId: readRequiredString(route, "hostId"),
    agentId: readRequiredString(route, "agentId"),
  };
}

function readOptionalInteger(record: unknown, key: string): number | undefined {
  const value = readRecord(record)[key];
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function readStringArray(record: unknown, key: string, maximum: number): string[] {
  const value = readRecord(record)[key];
  if (!Array.isArray(value) || value.length > maximum) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function readRequiredString(record: Record<string, unknown>, key: string, maximumBytes = 512): string {
  const value = record[key];
  if (typeof value !== "string") throw new DeckSurfaceFailure("invalid_params", `${key} is required.`);
  const trimmed = value.trim();
  if (!trimmed || new TextEncoder().encode(trimmed).length > maximumBytes) {
    throw new DeckSurfaceFailure("invalid_params", `${key} is invalid.`);
  }
  return trimmed;
}

function readRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new DeckSurfaceFailure("invalid_params", "Request parameters are invalid.");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

class DeckSurfaceFailure extends Error {
  constructor(readonly code: ScoutSurfaceErrorCode, message: string) {
    super(message);
  }
}

export const __testing = {
  rankDeckAgents,
  toSurfaceTailEvent,
};
