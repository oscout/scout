import type { ObserveCache } from "../../lib/observe.ts";
import type {
  Agent,
  TailDiscoveredTranscript,
  TailDiscoverySnapshot,
  TailEvent,
  TailEventKind,
} from "../../lib/types.ts";
import type {
  FleetAgentSnapshot,
  FleetObserveSnapshot,
  FleetTailSnapshot,
  SurfaceAgent,
  SurfaceBootstrap,
  SurfaceTailEvent,
} from "../../surface-contract/scout-surface-contract.ts";

export type NativeLaneSnapshot = {
  agents: Agent[];
  discovery: TailDiscoverySnapshot;
  tailEvents: TailEvent[];
  observeCache: ObserveCache;
  agentReady: boolean;
  tailReady: boolean;
};

export function emptyNativeLaneSnapshot(): NativeLaneSnapshot {
  return {
    agents: [],
    discovery: emptyDiscovery(),
    tailEvents: [],
    observeCache: {},
    agentReady: false,
    tailReady: false,
  };
}

function emptyDiscovery(): TailDiscoverySnapshot {
  return {
    generatedAt: Date.now(),
    processes: [],
    transcripts: [],
    totals: {
      total: 0,
      scoutManaged: 0,
      hudsonManaged: 0,
      unattributed: 0,
      transcripts: 0,
    },
  };
}

export function buildNativeLaneSnapshot(
  agentSnapshot: FleetAgentSnapshot | null,
  tailSnapshot: FleetTailSnapshot | null,
  observeSnapshot: FleetObserveSnapshot | null,
  bootstrap: Partial<SurfaceBootstrap>,
): NativeLaneSnapshot {
  const hostNames = new Map((bootstrap.hosts ?? []).map((host) => [host.id, host.name]));
  const agents: Agent[] = [];
  const transcripts: TailDiscoveredTranscript[] = [];
  const tailEvents: TailEvent[] = [];
  const observeCache: ObserveCache = {};
  const seenTranscriptIds = new Set<string>();
  const surfaceAgents = new Map<string, SurfaceAgent>();
  const tailedAgentKeys = new Set<string>();

  for (const outcome of agentSnapshot?.hosts ?? []) {
    if (!outcome.ready) continue;
    for (const surfaceAgent of outcome.value.agents) {
      surfaceAgents.set(`${outcome.hostId}\0${surfaceAgent.id}`, surfaceAgent);
    }
  }

  for (const outcome of tailSnapshot?.hosts ?? []) {
    if (!outcome.ready) continue;
    const hostName = hostNames.get(outcome.hostId) ?? "Mac";
    for (const event of outcome.value.events) {
      const surfaceAgent = event.agentId
        ? surfaceAgents.get(`${outcome.hostId}\0${event.agentId}`)
        : undefined;
      if (event.agentId) {
        tailedAgentKeys.add(`${outcome.hostId}\0${event.agentId}`);
      }
      const sessionId = fleetSessionId(
        outcome.hostId,
        event.sessionId ?? event.agentId ?? event.id,
      );
      tailEvents.push(mapTailEvent(outcome.hostId, hostName, event, sessionId, surfaceAgent));
      if (!seenTranscriptIds.has(sessionId)) {
        seenTranscriptIds.add(sessionId);
        transcripts.push({
          source: "scout",
          transcriptPath: `scout-surface://${outcome.hostId}/${encodeURIComponent(sessionId)}`,
          sessionId,
          cwd: null,
          project: hostName,
          harness: "scout-managed",
          lastEventAt: event.at,
          mtimeMs: event.at,
          size: 0,
        });
      }
    }
  }

  // The agent registry enriches lanes that have actual tail evidence; it must
  // never manufacture lane activity of its own. Mobile presence timestamps are
  // endpoint heartbeats, not proof that an agent changed within the lane
  // horizon. Feeding every registry row into the canonical model would make the
  // whole fleet look recently active.
  for (const outcome of agentSnapshot?.hosts ?? []) {
    if (!outcome.ready) continue;
    const hostName = hostNames.get(outcome.hostId) ?? "Mac";
    for (const surfaceAgent of outcome.value.agents) {
      if (!tailedAgentKeys.has(`${outcome.hostId}\0${surfaceAgent.id}`)) continue;
      agents.push(mapAgent(outcome.hostId, hostName, surfaceAgent));
    }
  }

  for (const outcome of observeSnapshot?.hosts ?? []) {
    if (!outcome.ready) continue;
    for (const observed of outcome.value.agents) {
      const firstAt = observed.events[0]?.at ?? observed.updatedAt;
      observeCache[fleetAgentId(outcome.hostId, observed.agentId)] = {
        source: observed.source,
        fidelity: observed.fidelity,
        historyPath: null,
        sessionId: observed.sessionId
          ? fleetSessionId(outcome.hostId, observed.sessionId)
          : null,
        updatedAt: observed.updatedAt,
        data: {
          events: observed.events.map((event) => ({
            id: `${outcome.hostId}::${event.id}`,
            t: Math.max(0, event.at - firstAt),
            at: event.at,
            kind: event.kind,
            text: event.text,
            tool: event.tool,
            detail: event.detail,
            live: observed.source === "live",
          })),
          files: [],
          live: observed.source === "live",
        },
      };
    }
  }

  for (const transcript of transcripts) {
    const latest = tailEvents
      .filter((event) => event.sessionId === transcript.sessionId)
      .reduce((value, event) => Math.max(value, event.ts), 0);
    if (latest > 0) {
      transcript.lastEventAt = latest;
      transcript.mtimeMs = latest;
    }
  }

  const discovery: TailDiscoverySnapshot = {
    generatedAt: Date.now(),
    processes: [],
    transcripts,
    totals: {
      total: transcripts.length,
      scoutManaged: transcripts.length,
      hudsonManaged: 0,
      unattributed: 0,
      transcripts: transcripts.length,
    },
  };

  return {
    agents,
    discovery,
    tailEvents,
    observeCache,
    agentReady: agentSnapshot !== null,
    tailReady: tailSnapshot !== null,
  };
}

function mapAgent(hostId: string, hostName: string, agent: SurfaceAgent): Agent {
  const sessionId = nativeLaneSessionId(hostId, agent);
  const conversationId = agent.conversationId
    ? fleetSessionId(hostId, agent.conversationId)
    : null;
  return {
    id: fleetAgentId(hostId, agent.id),
    definitionId: agent.id,
    name: agent.name,
    handle: agent.handle,
    agentClass: "agent",
    harness: agent.harness,
    state: agent.state,
    projectRoot: agent.projectRoot,
    cwd: agent.projectRoot,
    updatedAt: agent.updatedAt,
    createdAt: null,
    transport: "mobile-bridge",
    selector: null,
    defaultSelector: null,
    nodeQualifier: hostId,
    workspaceQualifier: null,
    wakePolicy: null,
    capabilities: [],
    project: hostName,
    branch: null,
    role: null,
    model: agent.model,
    harnessSessionId: sessionId,
    terminalSurface: null,
    harnessLogPath: null,
    conversationId,
    authorityNodeId: hostId,
    authorityNodeName: hostName,
    homeNodeId: hostId,
    homeNodeName: hostName,
    ownerId: null,
    ownerName: null,
    ownerHandle: null,
    staleLocalRegistration: false,
    retiredFromFleet: false,
    replacedByAgentId: null,
    providerName: agent.harness,
  };
}

/**
 * Mobile AgentSummary.sessionId is a display label shared by agents in the same
 * project, not a routable conversation identity. Use the real conversation
 * when one exists; otherwise give the local lane adapter a host-scoped identity
 * derived from the agent itself so unrelated agents never claim one transcript.
 */
function nativeLaneSessionId(hostId: string, agent: SurfaceAgent): string {
  return fleetSessionId(hostId, agent.conversationId ?? `native-agent:${agent.id}`);
}

function mapTailEvent(
  hostId: string,
  hostName: string,
  event: SurfaceTailEvent,
  sessionId: string,
  agent?: SurfaceAgent,
): TailEvent {
  return {
    id: `${hostId}::${event.id}`,
    ts: event.at,
    source: agent?.harness ?? "scout",
    sessionId,
    pid: 0,
    parentPid: null,
    project: agent?.projectRoot ?? hostName,
    cwd: agent?.projectRoot ?? "",
    harness: "scout-managed",
    kind: mapTailKind(event.kind),
    summary: event.text,
  };
}

function mapTailKind(kind: string): TailEventKind {
  switch (kind) {
    case "user":
    case "assistant":
    case "tool":
    case "system":
    case "other":
      return kind;
    case "toolResult":
    case "tool-result":
      return "tool-result";
    default:
      return "other";
  }
}

function fleetAgentId(hostId: string, agentId: string): string {
  return `${hostId}::agent::${agentId}`;
}

function fleetSessionId(hostId: string, sessionId: string): string {
  return `${hostId}::session::${sessionId}`;
}
