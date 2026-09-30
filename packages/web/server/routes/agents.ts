import type { Hono } from "hono";
import { resolve } from "node:path";
import {
  isOpaqueChannelId,
  type AgentEndpoint,
  type ConversationDefinition,
  type ScoutRuntimeCapabilityCatalog,
} from "@openscout/protocol";
import { collectOccupiedDefinitionIdsFromBrokerSnapshot, resolveProjectProvisionalAgentName } from "@openscout/runtime";
import { coalesce } from "../server-core.ts";
import { resolveTerminalSurface } from "../core/terminal-surfaces.ts";
import { cachedRepoKeysByRoot } from "../core/repo-identity.ts";
import {
  queryAgentById,
  queryAgents,
  queryConversationDefinitionById,
  type WebAgent,
} from "../db-queries.ts";
import { applyAgentAttention, type AgentAttentionEntry } from "../core/attention/agent-attention.ts";
import { compact as compactPath, isTransportSessionRef, resolveHarnessSessionId } from "../db/internal/paths.ts";
import {
  askScoutQuestion,
  loadScoutBrokerContext,
  readScoutBrokerHome,
  type OutgoingAttachmentInput,
  type ScoutBrokerContext,
  type ScoutBrokerHomeAgentRecord,
  type ScoutBrokerHomePayload,
  upsertScoutConversation,
} from "../core/broker/service.ts";
import { loadAgentObservePayload, loadAgentObserveSummaries, loadSessionRefObservePayload } from "../core/observe/service.ts";
import type { DiscoveredTranscript } from "@openscout/runtime/tail";
import { buildHarnessResumeCommand, findHarnessEntry, loadHarnessCatalogSnapshot } from "@openscout/runtime/harness-catalog";
import { currentMeshPeerNodeIds } from "@openscout/runtime/mesh-peer-filter";
import type { WebTailRuntime } from "./scoutbot.ts";
import { loadOpenScoutWebShellState, type OpenScoutWebShellState } from "../runtime-summary.ts";
import { resolveOperatorName } from "@openscout/runtime/user-config";
import { loadResolvedRelayAgents, readOpenScoutSettings } from "@openscout/runtime/setup";
import { relayAgentRuntimeDirectory } from "@openscout/runtime/support-paths";
import { readSessionCatalogSync } from "@openscout/runtime/claude-stream-json";
import { requestHarnessSessionCompaction } from "../session-compaction.ts";
import { firstMetadataString } from "../web-flights.ts";
import { parseOptionalPositiveInt } from "../http-helpers.ts";
import { expandHomePath } from "../local-paths.ts";
import { metadataTimestampMs } from "../metadata-values.ts";
import {
  agentEndpointMetadata,
  activeEndpointForAgent,
  isBrokerAgentVisibleInWeb,
  latestBrokerAgentTimestamp,
  projectNameFromRoot,
  brokerAgentCardToWebAgent,
  brokerCardAgentsForWeb,
  mergeBrokerAgentProjection,
} from "../broker-agent-projection.ts";
import { defaultCaptureTmuxPane } from "../tmux-pane-capture.ts";
import {
  AGENT_BACKGROUND_REFRESH_DELAY_MS,
  TmuxPaneCapture,
  queryAgentAttentionSnapshot,
  delay,
} from "../core/attention/operator-attention-state.ts";
import { parseTmuxPeekLineCount, parseTmuxPeekColumnCount, normalizeTmuxPeekBody } from "../tmux-peek.ts";
import { mostRecentClaudeSessionForCwd } from "../claude-sessions.ts";
import { optionalString, coerceAgentHarness } from "../request-values.ts";
import { mostRecentAgents, withNodeCoveredRoster } from "../agent-roster.ts";
import { conversationDefinitionFromDb, requireAnchorMessageInConversation } from "../conversation-records.ts";
import type { CreateOpenScoutWebServerOptions } from "../web-server-options.ts";
import type { CachedSnapshot } from "../server-core.ts";
import type { buildHudRunnerOptions } from "../hud-runner-options.ts";
import { agentArchiveBody, agentConfigPatchBody } from "../../shared/api/agents.ts";
import { sessionStartBody } from "../../shared/api/sessions.ts";
import { readJsonBody } from "../request-body.ts";

function normalizeTranscriptCwd(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? resolve(expandHomePath(trimmed)) : null;
}

function mostRecentTranscriptForHarnessCwd(
  transcripts: readonly DiscoveredTranscript[],
  harness: string | null | undefined,
  cwd: string | null | undefined,
): DiscoveredTranscript | null {
  const expectedHarness = harness?.trim().toLowerCase();
  const expectedCwd = normalizeTranscriptCwd(cwd);
  if (!expectedHarness || !expectedCwd) return null;
  return transcripts
    .filter((transcript) =>
      transcript.source.toLowerCase() === expectedHarness
      && normalizeTranscriptCwd(transcript.cwd) === expectedCwd
      && Boolean(transcript.sessionId?.trim())
    )
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0] ?? null;
}

const EXECUTION_SESSION_PREFERENCES = new Set(["new", "existing", "any", "fork"]);

function normalizeExecutionSession(
  value: unknown,
): "new" | "existing" | "any" | "fork" | undefined {
  const normalized = optionalString(value)?.trim();
  return normalized && EXECUTION_SESSION_PREFERENCES.has(normalized)
    ? (normalized as "new" | "existing" | "any" | "fork")
    : undefined;
}

function stringList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }
  return value.map((entry) => String(entry).trim()).filter(Boolean);
}

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function brokerAgentIdentityMatches(
  agent: ScoutBrokerContext["snapshot"]["agents"][string],
  value: string,
): boolean {
  return [
    agent.id,
    agent.definitionId,
    agent.handle,
    agent.selector,
    agent.defaultSelector,
  ].some((candidate) => candidate === value);
}

const AGENT_BROKER_CONTEXT_TTL_MS = 60_000;

const AGENT_BROKER_CONTEXT_COLD_BUDGET_MS = 75;

/**
 * Needs-attention index for /api/agents, cached and coalesced. A rebuild opens
 * the pairing bridge and inspects live terminal panes, so once a snapshot is
 * available callers receive it immediately while an expired snapshot refreshes
 * in the background. Failures yield an empty index so a broken source cannot
 * take /api/agents down with it. The sourcing lives in `core/attention` so the
 * mobile agents RPC can build the identical index.
 */
function queryAgentAttentionIndex(
  broker: ScoutBrokerContext | null,
  capture: TmuxPaneCapture = defaultCaptureTmuxPane,
): Promise<Map<string, AgentAttentionEntry>> {
  return queryAgentAttentionSnapshot(broker, capture).then((snapshot) => snapshot.index);
}

function createAgentBrokerContextReader(): () => Promise<ScoutBrokerContext | null> {
  let cache: { at: number; value: ScoutBrokerContext | null } | null = null;
  let inFlight: Promise<ScoutBrokerContext | null> | null = null;

  const refresh = (delayMs: number) => {
    if (inFlight) return inFlight;
    const promise = delay(delayMs)
      // Agent inventory is a roster read, not an activity-window read. Mesh
      // cards can be authoritative and routable without a local timestamp, so
      // a time-windowed snapshot can otherwise hide them from every web client.
      .then(() => loadScoutBrokerContext(undefined, { since: null }).catch(() => null))
      .then((value) => {
        cache = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        if (inFlight === promise) inFlight = null;
      });
    inFlight = promise;
    return promise;
  };

  return () => {
    if (!cache) {
      // The local SQLite roster is enough to paint the shell. A cold full
      // broker snapshot can take tens of seconds on a busy host, so keep that
      // enrichment running but stop making every first-page agent read wait
      // behind it.
      return Promise.race([
        refresh(0),
        delay(AGENT_BROKER_CONTEXT_COLD_BUDGET_MS).then(() => null),
      ]);
    }
    if (Date.now() - cache.at >= AGENT_BROKER_CONTEXT_TTL_MS && !inFlight) {
      void refresh(AGENT_BACKGROUND_REFRESH_DELAY_MS);
    }
    return Promise.resolve(cache.value);
  };
}

function localBrokerNodeId(broker: ScoutBrokerContext): string | null {
  return broker.node.id ?? null;
}

/** Match /api/mesh node filtering — only pin agents on peers the mesh view still lists. */
function pinnedMeshPeerNodeIds(broker: ScoutBrokerContext): Set<string> {
  const localNodeId = localBrokerNodeId(broker);
  if (!localNodeId) return new Set();
  return currentMeshPeerNodeIds({
    nodes: broker.snapshot.nodes ?? {},
    localNodeId,
    meshId: broker.node.meshId ?? null,
  });
}

/** Mesh peer agents must survive the /api/agents cap — otherwise remote nodes
 *  show zero in the mesh view even when the broker snapshot has them. */
function withPinnedMeshPeerAgents(
  agents: WebAgent[],
  broker: ScoutBrokerContext | null,
  limit: number | undefined,
): WebAgent[] {
  if (!broker) return mostRecentAgents(agents, limit);
  const localNodeId = localBrokerNodeId(broker);
  if (!localNodeId) return mostRecentAgents(agents, limit);

  const peerNodeIds = pinnedMeshPeerNodeIds(broker);
  // Select before projecting. Projecting a broker card walks endpoint,
  // conversation, flight, and activity collections; doing that for every
  // historical card on a peer defeated the point of pinning one machine into
  // a bounded roster.
  const representativeCardByNode = new Map<
    string,
    ScoutBrokerContext["snapshot"]["agents"][string]
  >();
  for (const agent of Object.values(broker.snapshot.agents ?? {})) {
    const homeNodeId = agent.homeNodeId;
    if (!homeNodeId || !peerNodeIds.has(homeNodeId) || !isBrokerAgentVisibleInWeb(agent)) continue;
    const existing = representativeCardByNode.get(homeNodeId);
    if (
      !existing
      || (latestBrokerAgentTimestamp(agent, null) ?? 0)
        > (latestBrokerAgentTimestamp(existing, null) ?? 0)
    ) {
      representativeCardByNode.set(homeNodeId, agent);
    }
  }
  const peerAgents = [...representativeCardByNode.values()]
    .map((agent) => brokerAgentCardToWebAgent(broker, agent))
    .filter((agent): agent is WebAgent => Boolean(agent))
    .sort((left, right) =>
      (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
      || left.name.localeCompare(right.name),
    );
  if (peerAgents.length === 0) return mostRecentAgents(agents, limit);

  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  for (const peer of peerAgents) {
    // The caller has already merged database and broker data for cards it
    // knows. Add missing peer cards without replacing that richer projection.
    if (!byId.has(peer.id)) byId.set(peer.id, peer);
  }
  const merged = [...byId.values()];
  if (limit === undefined) return merged;

  // Pin one representative per current peer, not every card on that peer.
  // The old append-after-limit behavior made `limit=20` return hundreds of
  // rows, defeating both the API contract and the intended first-paint cap.
  const representatives = peerAgents
    .map((peer) => byId.get(peer.id) ?? peer)
    .slice(0, limit);
  const included = new Set(representatives.map((agent) => agent.id));
  const limited = [...representatives];
  for (const agent of mostRecentAgents(merged, undefined)) {
    if (limited.length >= limit) break;
    if (included.add(agent.id)) limited.push(agent);
  }
  return mostRecentAgents(limited, undefined);
}

function agentListSummary(agent: WebAgent) {
  return {
    id: agent.id,
    definitionId: agent.definitionId,
    name: agent.name,
    handle: agent.handle,
    agentClass: agent.agentClass,
    harness: agent.harness,
    state: agent.state,
    pendingAsk: agent.pendingAsk,
    role: agent.role,
    projectRoot: agent.projectRoot,
    cwd: agent.cwd,
    project: agent.project,
    branch: agent.branch,
    repoKey: agent.repoKey ?? null,
    selector: agent.selector,
    defaultSelector: agent.defaultSelector,
    nodeQualifier: agent.nodeQualifier,
    workspaceQualifier: agent.workspaceQualifier,
    wakePolicy: agent.wakePolicy,
    model: agent.model,
    transport: agent.transport,
    capabilities: agent.capabilities,
    terminalSurface: agent.terminalSurface,
    harnessLogPath: agent.harnessLogPath,
    authorityNodeId: agent.authorityNodeId,
    authorityNodeName: agent.authorityNodeName,
    homeNodeId: agent.homeNodeId,
    homeNodeName: agent.homeNodeName,
    ownerId: agent.ownerId,
    ownerName: agent.ownerName,
    ownerHandle: agent.ownerHandle,
    conversationId: agent.conversationId,
    harnessSessionId: agent.harnessSessionId,
    staleLocalRegistration: agent.staleLocalRegistration,
    retiredFromFleet: agent.retiredFromFleet,
    replacedByAgentId: agent.replacedByAgentId,
    providerName: agent.providerName,
    providerUrl: agent.providerUrl,
    protocol: agent.protocol,
    skills: agent.skills,
    authorityProfile: agent.authorityProfile,
    runtimePolicy: agent.runtimePolicy,
    updatedAt: agent.updatedAt,
    createdAt: agent.createdAt,
  };
}

function withAgentRepoKeys(agents: WebAgent[]): WebAgent[] {
  const roots = agents
    .map((agent) => agent.projectRoot)
    .filter((root): root is string => Boolean(root));
  if (roots.length === 0) return agents;
  const keys = cachedRepoKeysByRoot(roots);
  return agents.map((agent) => {
    const repoKey = agent.projectRoot ? keys.get(agent.projectRoot) ?? null : null;
    return repoKey ? { ...agent, repoKey } : agent;
  });
}

const AGENT_HOME_SUMMARY_FRESH_MS = 10_000;

const AGENT_HOME_SUMMARY_MAX_STALE_MS = 60_000;

const AGENT_HOME_SUMMARY_COLD_BUDGET_MS = 75;

function createAgentBrokerHomeReader(
  load: () => Promise<ScoutBrokerHomePayload | null> = () => readScoutBrokerHome(),
): () => Promise<ScoutBrokerHomePayload | null> {
  let cached: { value: ScoutBrokerHomePayload; fetchedAt: number } | null = null;
  let refresh: Promise<ScoutBrokerHomePayload | null> | null = null;

  return async () => {
    const age = cached ? Date.now() - cached.fetchedAt : Infinity;
    if (cached && age <= AGENT_HOME_SUMMARY_FRESH_MS) return cached.value;
    if (!refresh) {
      refresh = load()
        .then((value) => {
          if (value) cached = { value, fetchedAt: Date.now() };
          return value;
        })
        .catch(() => null)
        .finally(() => {
          refresh = null;
        });
    }
    if (cached && age <= AGENT_HOME_SUMMARY_MAX_STALE_MS) return cached.value;
    const timeout = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), AGENT_HOME_SUMMARY_COLD_BUDGET_MS);
    });
    return Promise.race([refresh, timeout]);
  };
}

function brokerHomeAgentToWebAgent(agent: ScoutBrokerHomeAgentRecord): WebAgent {
  return {
    id: agent.id,
    definitionId: agent.id,
    name: agent.title,
    handle: null,
    agentClass: "general",
    harness: null,
    state: agent.state,
    projectRoot: compactPath(agent.projectRoot),
    cwd: compactPath(agent.projectRoot),
    updatedAt: agent.lastSeenAt,
    createdAt: null,
    transport: null,
    selector: null,
    defaultSelector: null,
    nodeQualifier: null,
    workspaceQualifier: null,
    wakePolicy: null,
    capabilities: [],
    project: projectNameFromRoot(agent.projectRoot),
    branch: null,
    role: agent.role,
    model: null,
    harnessSessionId: null,
    terminalSurface: null,
    harnessLogPath: null,
    conversationId: null,
    // Node identity is what tells a local card from a peer's. Clearing it here
    // is what left the Network page unable to place any remote agent (#906).
    authorityNodeId: agent.authorityNodeId ?? null,
    authorityNodeName: null,
    homeNodeId: agent.homeNodeId ?? null,
    homeNodeName: null,
    ownerId: null,
    ownerName: null,
    ownerHandle: null,
    staleLocalRegistration: false,
    retiredFromFleet: false,
    replacedByAgentId: null,
  };
}

async function queryAgentsIncludingBrokerCards(
  limit?: number,
  includeRichBrokerContext = true,
  includeAttention = false,
  capture: TmuxPaneCapture = defaultCaptureTmuxPane,
  loadBrokerContext: () => Promise<ScoutBrokerContext | null> = () =>
    loadScoutBrokerContext().catch(() => null),
  loadBrokerHome: () => Promise<ScoutBrokerHomePayload | null> = createAgentBrokerHomeReader(),
): Promise<WebAgent[]> {
  const { listArchivedLocalAgentIds } = await import("@openscout/runtime/local-agents");
  const archivedIds = new Set(await listArchivedLocalAgentIds().catch(() => [] as string[]));
  // Archived rows are filtered outside SQL, so over-fetch by their count to
  // keep a bounded response from coming back short when an archived agent is
  // among the newest database rows.
  const databaseLimit = limit === undefined ? undefined : limit + archivedIds.size;
  const agents = queryAgents(databaseLimit)
    .filter((agent) => !archivedIds.has(agent.id));
  if (!includeRichBrokerContext) {
    // Keep the frequently-polled roster off the broker's full snapshot. SQLite
    // remains authoritative for full agent metadata; compact home data supplies
    // broker-only cards and current lifecycle state without transferring message
    // history. An explicit attention read can still decorate this bounded roster.
    const home = await loadBrokerHome();
    const brokerAgents = home
      ? home.agents
          .filter((agent) => !archivedIds.has(agent.id))
          .map(brokerHomeAgentToWebAgent)
      : [];
    const brokerById = new Map(brokerAgents.map((agent) => [agent.id, agent]));
    const mergedAgents = agents.map((agent) => mergeBrokerAgentProjection(agent, brokerById.get(agent.id)));
    const existingIds = new Set(mergedAgents.map((agent) => agent.id));
    const attention = includeAttention
      ? await queryAgentAttentionIndex(null, capture)
      : new Map<string, AgentAttentionEntry>();
    const roster = withNodeCoveredRoster(applyAgentAttention([
      ...mergedAgents,
      ...brokerAgents.filter((agent) => !existingIds.has(agent.id)),
    ], attention), limit);
    return withAgentRepoKeys(roster);
  }
  const broker = await loadBrokerContext();
  // The HUD's first page is deliberately a summary read. The full attention
  // index opens the pairing bridge and can take seconds on a busy machine, so
  // only callers that explicitly request attention pay that cost.
  const attention = includeAttention
    ? await queryAgentAttentionIndex(broker, capture)
    : new Map<string, AgentAttentionEntry>();
  if (!broker) {
    return withAgentRepoKeys(mostRecentAgents(applyAgentAttention(agents, attention), limit));
  }
  const brokerAgents = brokerCardAgentsForWeb(broker)
    .filter((agent) => !archivedIds.has(agent.id));
  const brokerById = new Map(brokerAgents.map((agent) => [agent.id, agent]));
  const canonicalScoutbot = brokerById.get("scoutbot");
  const mergedAgents = agents
    .filter((agent) => !(
      canonicalScoutbot
      && agent.id !== canonicalScoutbot.id
      && agent.definitionId === canonicalScoutbot.definitionId
    ))
    .map((agent) => mergeBrokerAgentProjection(agent, brokerById.get(agent.id)));
  const existingIds = new Set(mergedAgents.map((agent) => agent.id));
  const roster = withPinnedMeshPeerAgents(applyAgentAttention([
    ...mergedAgents,
    ...brokerAgents.filter((agent) => !existingIds.has(agent.id)),
  ], attention), broker, limit);
  return withAgentRepoKeys(roster);
}

async function queryAgentIncludingBrokerCard(
  agentId: string,
  capture: TmuxPaneCapture = defaultCaptureTmuxPane,
): Promise<WebAgent | null> {
  const broker = await loadScoutBrokerContext(undefined, { since: null }).catch(() => null);
  const agent = queryAgentById(agentId);
  if (agent) {
    const attention = await queryAgentAttentionIndex(broker, capture);
    const brokerAgents = broker ? brokerCardAgentsForWeb(broker) : [];
    const canonical = agent.definitionId === "scoutbot"
      ? brokerAgents.find((candidate) => candidate.id === "scoutbot")
      : brokerAgents.find((candidate) => candidate.id === agent.id);
    return applyAgentAttention([
      mergeBrokerAgentProjection(withResolvedHarnessSessionIdentity(agent), canonical),
    ], attention)[0] ?? null;
  }
  if (!broker) {
    return null;
  }
  const brokerAgent = Object.values(broker.snapshot.agents ?? {}).find(
    (candidate) => brokerAgentIdentityMatches(candidate, agentId),
  );
  const brokerWebAgent = brokerAgent ? brokerAgentCardToWebAgent(broker, brokerAgent) : null;
  if (!brokerWebAgent) {
    return null;
  }
  const attention = await queryAgentAttentionIndex(broker, capture);
  return applyAgentAttention([withResolvedHarnessSessionIdentity(brokerWebAgent)], attention)[0] ?? null;
}

function withResolvedHarnessSessionIdentity(agent: WebAgent): WebAgent {
  if (agent.harness !== "claude") {
    return agent;
  }
  const cwd = agent.cwd ?? agent.projectRoot;
  // Managed tmux identity is projected from broker observation metadata by
  // resolveHarnessSessionIdForAgent. Read-side cwd scans cannot prove it.
  if (agent.transport === "tmux") return agent;
  const transcript = cwd ? mostRecentClaudeSessionForCwd(cwd) : null;
  if (!transcript?.sessionId) {
    return agent;
  }
  const sessionId = agent.harnessSessionId?.trim() ?? "";
  if (sessionId === transcript.sessionId) {
    return agent;
  }
  if (sessionId && !isTransportSessionRef(sessionId)) {
    return agent;
  }
  return {
    ...agent,
    harnessSessionId: transcript.sessionId,
    harnessLogPath: agent.harnessLogPath ?? transcript.transcriptPath,
  };
}

type TmuxPeekTarget = {
  sessionId: string;
  paneTarget: string;
  cwd: string | null;
};

function resolveTmuxPeekTarget(agent: ReturnType<typeof queryAgents>[number], endpoint: AgentEndpoint | null): TmuxPeekTarget | null {
  const endpointMetadata = agentEndpointMetadata(endpoint);
  const terminalSurface = agent.terminalSurface?.backend === "tmux"
    ? agent.terminalSurface
    : resolveTerminalSurface({
        transport: endpoint?.transport ?? agent.transport,
        endpointSessionId: endpoint?.sessionId ?? agent.harnessSessionId,
        metadata: endpointMetadata,
      });
  if (!terminalSurface || terminalSurface.backend !== "tmux") {
    return null;
  }
  const tmuxSession = terminalSurface.sessionName;
  const paneTarget = firstMetadataString(
    terminalSurface.paneId,
    endpoint?.pane,
    endpointMetadata.paneTarget,
    endpointMetadata.tmuxPane,
    tmuxSession,
  );

  if (!tmuxSession || !paneTarget) {
    return null;
  }

  return {
    sessionId: tmuxSession,
    paneTarget,
    cwd: endpoint?.cwd ?? endpoint?.projectRoot ?? agent.cwd ?? agent.projectRoot ?? null,
  };
}

async function anchorConversationToMessage(input: {
  conversationId: string;
  parentConversationId: string;
  anchorMessageId: string;
}): Promise<ConversationDefinition | null> {
  const existingRow = queryConversationDefinitionById(input.conversationId);
  const broker = await loadScoutBrokerContext().catch(() => null);
  const existing = existingRow
    ? conversationDefinitionFromDb(existingRow)
    : broker?.snapshot.conversations[input.conversationId] ?? null;
  if (!existing) return null;
  if (!broker) {
    throw new Error("broker unreachable");
  }
  requireAnchorMessageInConversation(broker, input.parentConversationId, input.anchorMessageId);

  const next: ConversationDefinition = {
    ...existing,
    parentConversationId: input.parentConversationId,
    messageId: input.anchorMessageId,
    metadata: {
      ...(existing.metadata ?? {}),
      anchorSource: "scout-web",
      parentConversationId: input.parentConversationId,
      anchorMessageId: input.anchorMessageId,
    },
  };
  await upsertScoutConversation(next);
  return next;
}

function buildAgentSessionCatalogPayload(input: {
  agentId: string;
  harness: string | null;
  cwd: string;
  transport?: string | null;
  terminalSurface?: WebAgent["terminalSurface"];
  activeSessionId?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  startedAt?: number | null;
  endpoint?: AgentEndpoint | null;
  nativeTranscript?: DiscoveredTranscript | null;
}) {
  const runtimeDir = relayAgentRuntimeDirectory(input.agentId);
  const catalog = readSessionCatalogSync(runtimeDir);
  const catalogActiveSession = catalog.activeSessionId
    ? catalog.sessions.find((session) => session.id === catalog.activeSessionId) ?? null
    : null;
  const endpointMetadata = agentEndpointMetadata(input.endpoint);
  const endpointSessionId = firstMetadataString(
    input.activeSessionId,
    input.endpoint?.sessionId,
    endpointMetadata.externalSessionId,
    endpointMetadata.threadId,
  );
  const terminalSurface = input.terminalSurface ?? resolveTerminalSurface({
    transport: input.transport,
    endpointSessionId: input.activeSessionId,
    metadata: endpointMetadata,
  });
  const managedTmux = input.transport === "tmux";
  const observedHarnessSession = input.harness === "claude" && !managedTmux
    ? mostRecentClaudeSessionForCwd(input.cwd)
    : null;
  const discoveredHarnessSessionId = firstMetadataString(input.nativeTranscript?.sessionId);
  const harnessNativeSessionId = managedTmux
    ? resolveHarnessSessionId("tmux", input.endpoint?.sessionId ?? input.activeSessionId ?? null, endpointMetadata)
    : firstMetadataString(endpointMetadata.externalSessionId, endpointMetadata.threadId,
      observedHarnessSession?.sessionId, discoveredHarnessSessionId);
  const runtimeSessionId = firstMetadataString(input.activeSessionId, input.endpoint?.sessionId);
  const fallbackTerminalSessionId = terminalSurface
    ? input.activeSessionId ?? terminalSurface.sessionName
    : null;
  const catalogActiveMatchesProfile = Boolean(
    catalogActiveSession
    && (!input.harness || !catalogActiveSession.harness || catalogActiveSession.harness === input.harness)
    && (!input.transport || !catalogActiveSession.transport || catalogActiveSession.transport === input.transport),
  );
  const sessionId = managedTmux
    ? harnessNativeSessionId ?? runtimeSessionId ?? fallbackTerminalSessionId
    : catalogActiveMatchesProfile
    ? harnessNativeSessionId ?? catalog.activeSessionId
    : harnessNativeSessionId ?? endpointSessionId ?? fallbackTerminalSessionId ?? catalog.activeSessionId;
  const harnessEntry = findHarnessEntry(input.harness);
  const resumeCommand = sessionId && harnessEntry && input.transport !== "tmux"
    ? buildHarnessResumeCommand(harnessEntry, sessionId, input.cwd)
    : null;
  const canResumeIntoTerminal = input.transport === "codex_exec";
  const historyPath = firstMetadataString(
    endpointMetadata.threadPath,
    endpointMetadata.resumeSessionPath,
    endpointMetadata.historyPath,
  );
  const sessionHistoryPath = managedTmux
    ? (harnessNativeSessionId && input.nativeTranscript?.sessionId === harnessNativeSessionId
      ? input.nativeTranscript.transcriptPath : null)
    : historyPath ?? observedHarnessSession?.transcriptPath ?? input.nativeTranscript?.transcriptPath ?? null;
  const provider = firstMetadataString(endpointMetadata.provider);
  const source = firstMetadataString(endpointMetadata.source) ?? "broker-endpoint";
  const startedAt = metadataTimestampMs(endpointMetadata.lastStartedAt)
    ?? metadataTimestampMs(endpointMetadata.startedAt)
    ?? input.startedAt
    ?? Date.now();
  const sessions = sessionId && (managedTmux || !catalog.sessions.some((session) => session.id === sessionId))
    ? [
        {
          id: sessionId,
          startedAt,
          cwd: input.cwd,
          ...(input.harness ? { harness: input.harness } : {}),
          ...(input.transport ? { transport: input.transport } : {}),
          ...(input.model ? { model: input.model } : {}),
          ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
          ...(provider ? { provider } : {}),
          ...(sessionHistoryPath ? { historyPath: sessionHistoryPath } : {}),
          ...(terminalSurface?.sessionName && terminalSurface.sessionName !== sessionId
            ? { surfaceSessionId: terminalSurface.sessionName }
            : {}),
          ...(harnessNativeSessionId ? { harnessSessionId: harnessNativeSessionId } : {}),
          ...((managedTmux ? harnessNativeSessionId : endpointMetadata.externalSessionId)
            ? { externalSessionId: managedTmux ? harnessNativeSessionId : endpointMetadata.externalSessionId } : {}),
          ...(!managedTmux && (endpointMetadata.threadId ?? (input.harness === "codex" ? harnessNativeSessionId : null))
            ? { threadId: endpointMetadata.threadId ?? harnessNativeSessionId }
            : {}),
          ...(runtimeSessionId && runtimeSessionId !== sessionId ? { runtimeSessionId } : {}),
          source,
          canObserve: Boolean(sessionHistoryPath) || Boolean(terminalSurface),
          // Terminal surfaces are taken over by grabbing the live pane (no
          // resume command needed). For broker protocol endpoints, a resume
          // command can still be useful copy, but it is not a live takeover.
          canTakeover: Boolean(terminalSurface) || Boolean(resumeCommand && canResumeIntoTerminal),
        },
        ...catalog.sessions.filter((session) => session.id !== sessionId),
      ]
    : catalog.sessions;
  return {
    ...catalog,
    activeSessionId: sessionId,
    sessions,
    agentId: input.agentId,
    harness: input.harness,
    resumeCommand,
    resumeCwd: input.cwd,
  };
}

function emptyAgentSessionCatalogPayload(agentId: string) {
  return {
    activeSessionId: null,
    sessions: [],
    agentId,
    harness: null,
    resumeCommand: null,
    resumeCwd: null,
  };
}

const BYOK_PROVIDER_CATALOG = [
  {
    id: "minimax",
    name: "MiniMax",
    protocol: "openai-compatible",
    baseUrl: "https://api.minimax.io/v1",
    docsUrl: "https://platform.minimax.io/docs/token-plan/other-tools",
    envKeys: ["MINIMAX_API_KEY"],
    note: "International OpenAI-compatible endpoint. China-region users may need the minimaxi.com base URL override later.",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    protocol: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    docsUrl: "https://openrouter.ai/docs/quickstart",
    envKeys: ["OPENROUTER_API_KEY"],
    note: "Routes many upstream providers behind one key; optional app attribution headers can be added when we wire requests.",
  },
  {
    id: "xai",
    name: "xAI",
    protocol: "openai-compatible",
    baseUrl: "https://api.x.ai/v1",
    docsUrl: "https://docs.x.ai/developers/model-capabilities/legacy/chat-completions",
    envKeys: ["XAI_API_KEY"],
    note: "OpenAI SDK compatible chat completions surface for Grok models.",
  },
] as const;

function isProviderConfigured(envKeys: readonly string[]): boolean {
  return envKeys.some((key) => Boolean(process.env[key]?.trim()));
}

async function buildAgentConfigurationSnapshot(currentDirectory: string) {
  const [settingsResult, setupResult, catalogResult, shellResult] = await Promise.allSettled([
    readOpenScoutSettings({ currentDirectory }),
    loadResolvedRelayAgents({ currentDirectory }),
    loadHarnessCatalogSnapshot(),
    loadOpenScoutWebShellState(),
  ]);
  const settings = settingsResult.status === "fulfilled" ? settingsResult.value : null;
  const setup = setupResult.status === "fulfilled" ? setupResult.value : null;
  const catalog = catalogResult.status === "fulfilled" ? catalogResult.value : null;
  const shell = shellResult.status === "fulfilled" ? shellResult.value.runtime : null;
  const agents = queryAgents(200);

  return {
    generatedAt: Date.now(),
    context: {
      currentDirectory,
      workspaceRoots: settings?.discovery.workspaceRoots ?? [],
      hiddenProjectCount: settings?.discovery.hiddenProjectRoots.length ?? 0,
      defaultHarness: settings?.agents.defaultHarness ?? "claude",
      defaultTransport: settings?.agents.defaultTransport ?? "tmux",
      defaultCapabilities: settings?.agents.defaultCapabilities ?? [],
      sessionPrefix: settings?.agents.sessionPrefix ?? "relay",
    },
    broker: {
      label: shell?.brokerLabel ?? "Unavailable",
      reachable: shell?.brokerReachable ?? false,
      healthy: shell?.brokerHealthy ?? false,
      nodeId: shell?.nodeId ?? null,
      agentCount: shell?.agentCount ?? agents.length,
      messageCount: shell?.messageCount ?? 0,
      error: shell?.error ?? null,
    },
    runtimes: (catalog?.entries ?? []).map((entry) => ({
      id: entry.name,
      label: entry.label,
      description: entry.description,
      state: entry.readinessReport.state,
      detail: entry.readinessReport.detail,
      binaryPath: entry.readinessReport.binaryPath,
      loginCommand: entry.readinessReport.loginCommand,
      capabilities: entry.capabilities,
      source: entry.source,
    })),
    providers: BYOK_PROVIDER_CATALOG.map((provider) => ({
      ...provider,
      status: isProviderConfigured(provider.envKeys) ? "configured" as const : "missing" as const,
      envKeys: [...provider.envKeys],
    })),
    agents: agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      source: "broker" as const,
      status: agent.state ?? "offline",
      harness: agent.harness,
      transport: agent.transport,
      model: agent.model,
      projectRoot: agent.projectRoot,
      cwd: agent.cwd,
      capabilities: agent.capabilities,
      conversationId: agent.conversationId,
    })),
    // Project pickers must search the canonical inventory, not a recent-agent
    // approximation or an arbitrary first-page cap. These rows are compact and
    // already deduplicated by canonical project root in setup.
    projects: (setup?.projectInventory ?? []).map((project) => ({
      id: project.agentId,
      title: project.displayName,
      root: project.projectRoot,
      source: project.source,
      registrationKind: project.registrationKind,
      defaultHarness: project.defaultHarness,
      projectConfigPath: project.projectConfigPath,
    })),
    integrations: [
      {
        id: "telegram",
        name: "Telegram",
        status: settings?.bridges.telegram.enabled ? "enabled" as const : "disabled" as const,
        detail: settings?.bridges.telegram.enabled
          ? `Mode ${settings.bridges.telegram.mode}; conversation ${settings.bridges.telegram.defaultConversationId}`
          : "Bridge configured in settings but currently disabled.",
        source: "bridge" as const,
      },
    ],
    toolContext: {
      mcpServerCount: 0,
      note: "MCP/tool context is not yet exposed as a first-class web catalog. Current controls live on individual agent launch args, capabilities, and harness defaults.",
    },
    gaps: [
      "First-class MCP server registry and per-agent tool loadouts",
      "Secret storage and write flows for provider credentials",
      "Broker-owned durable unblock records for all human-needed states",
      "External runtime API-server harness and session adapter",
    ],
  };
}

export type AgentRouteDeps = {
  options: Pick<CreateOpenScoutWebServerOptions, "captureTmuxPane">;
  currentDirectory: string;
  shellStateCache: CachedSnapshot<OpenScoutWebShellState>;
  readRunnerOptions: (scope: ScoutRuntimeCapabilityCatalog["scope"], projectRoot: string) => ReturnType<typeof buildHudRunnerOptions>;
  tailRuntime: WebTailRuntime;
};

export function mountAgentRoutes(app: Hono, deps: AgentRouteDeps) {
  const { currentDirectory, readRunnerOptions, options, shellStateCache, tailRuntime } = deps;

  const readAgentConfigurationSnapshot = coalesce(
    () => buildAgentConfigurationSnapshot(currentDirectory),
    30_000,
  );

  const agentBrokerContextReader = createAgentBrokerContextReader();
  const agentBrokerHomeReader = createAgentBrokerHomeReader();

  app.get("/api/agent-config/snapshot", async (c) =>
    c.json(await readAgentConfigurationSnapshot()),
  );
  app.get("/api/runner/options", async (c) => {
    const requestedScope = c.req.query("scope");
    const scope: ScoutRuntimeCapabilityCatalog["scope"] = requestedScope === "global"
      || requestedScope === "project"
      || requestedScope === "global+project"
      ? requestedScope
      : "global+project";
    return c.json(await readRunnerOptions(
      scope,
      c.req.query("projectRoot") || currentDirectory,
    ));
  });

  const agentsResponseCache = new Map<string, () => Promise<WebAgent[]>>();
  const readAgentsResponse = (limit: number, summary: boolean, attentionRequested: boolean) => {
    const key = `${limit}|${summary ? 1 : 0}|${attentionRequested ? 1 : 0}`;
    let entry = agentsResponseCache.get(key);
    if (!entry) {
      if (agentsResponseCache.size >= 32) agentsResponseCache.clear();
      entry = coalesce(
        () => queryAgentsIncludingBrokerCards(
          limit,
          !summary,
          attentionRequested,
          options.captureTmuxPane ?? defaultCaptureTmuxPane,
          agentBrokerContextReader,
          agentBrokerHomeReader,
        ),
        3_000,
      );
      agentsResponseCache.set(key, entry);
    }
    return entry();
  };
  app.get("/api/agents", async (c) => {
    const requestedLimit = parseOptionalPositiveInt(c.req.query("limit"));
    const limit = Math.min(requestedLimit ?? 100, 100);
    const summary = c.req.query("detail") === "summary";
    const attentionRequested = c.req.query("attention") === "1";
    const agents = await readAgentsResponse(limit, summary, attentionRequested);
    return c.json(summary ? agents.map(agentListSummary) : agents);
  });
  app.get("/api/agents/:id", async (c) => {
    const agent = await queryAgentIncludingBrokerCard(
      c.req.param("id"),
      options.captureTmuxPane ?? defaultCaptureTmuxPane,
    );
    return agent ? c.json(agent) : c.json({ error: "agent not found" }, 404);
  });
  app.get("/api/agents/:id/definitions", async (c) => {
    const agent = await queryAgentIncludingBrokerCard(
      c.req.param("id"),
      options.captureTmuxPane ?? defaultCaptureTmuxPane,
    );
    if (!agent) {
      return c.json({ error: "agent not found" }, 404);
    }
    const projectRoot = agent.projectRoot ?? agent.cwd;
    if (!projectRoot) {
      return c.json({ error: "agent has no project root" }, 404);
    }
    const { buildAgentDefinitions } = await import("../agent-definitions.ts");
    const result = await buildAgentDefinitions({
      projectRoot,
      agentHandle: agent.handle,
      agentName: agent.name,
      currentDirectory,
    });
    if (!result.ok) {
      return c.json({ error: result.error }, result.status as 400 | 403 | 404);
    }
    return c.json(result.payload);
  });
  // Flexible session initiation. A single payload expresses every modality —
  // start fresh in a project, start "the same agent" fresh, continue an
  // agent's existing harness session with full context, seed a new
  // conversation from a message — by setting different fields. See docs/agent
  // for the modality matrix.
  app.post("/api/sessions", async (c) => {
    const parsed = await readJsonBody(c, sessionStartBody);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;

    const targetAgentId = optionalString(body.target?.agentId)?.trim();
    const agent = targetAgentId ? queryAgentById(targetAgentId) : null;
    if (targetAgentId && !agent) {
      return c.json({ error: `agent ${targetAgentId} not found` }, 404);
    }

    // Resolve a project path: explicit wins, else inherit the agent's root.
    const projectPath =
      optionalString(body.target?.projectPath)?.trim() ||
      agent?.projectRoot?.trim() ||
      undefined;
    if (!targetAgentId && !projectPath) {
      return c.json(
        { error: "target.agentId or target.projectPath is required" },
        400,
      );
    }

    // Execution preferences fall back to the resolved agent so "same agent"
    // keeps its harness/model.
    const session = normalizeExecutionSession(body.execution?.session);
    const requestedHarness = coerceAgentHarness(body.execution?.harness);
    const agentHarness = coerceAgentHarness(agent?.harness);
    const harness = requestedHarness ?? agentHarness;
    const routeTargetAgentId = targetAgentId
      && (
        !projectPath
        || !requestedHarness
        || (agentHarness ? requestedHarness === agentHarness : false)
      )
      ? targetAgentId
      : undefined;
    const model =
      optionalString(body.execution?.model)?.trim() ||
      agent?.model?.trim() ||
      undefined;
    const reasoningEffort = optionalString(body.execution?.reasoningEffort)?.trim();
    let targetSessionId = optionalString(body.execution?.targetSessionId)?.trim();
    if (session === "existing" && !targetSessionId) {
      targetSessionId = agent?.harnessSessionId?.trim() || undefined;
    }
    if (session === "existing" && !targetSessionId) {
      return c.json(
        {
          error:
            "session 'existing' requires execution.targetSessionId or an agent with a resolvable session",
        },
        400,
      );
    }
    const forkFromSessionId =
      optionalString(body.execution?.forkFromSessionId)?.trim()
      || optionalString(body.seed?.branchFrom?.sessionId)?.trim();
    const forkFromStateId = optionalString(body.execution?.forkFromStateId)?.trim();
    if (session === "fork" && !forkFromSessionId && !forkFromStateId) {
      return c.json(
        { error: "session 'fork' requires execution.forkFromSessionId or execution.forkFromStateId" },
        400,
      );
    }

    const persistence =
      body.agent?.persistence === "one_time" ? "one_time" : "sticky";
    let agentHandle =
      optionalString(body.agent?.handle)?.trim()
      || (routeTargetAgentId ? agent?.name?.trim() : undefined);
    if (!routeTargetAgentId && !agentHandle) {
      const broker = await loadScoutBrokerContext().catch(() => null);
      const occupied = broker
        ? collectOccupiedDefinitionIdsFromBrokerSnapshot(broker.snapshot)
        : new Set<string>();
      agentHandle = resolveProjectProvisionalAgentName({
        occupied,
        seedParts: [
          "web-session-initiation",
          resolveOperatorName().trim() || "operator",
          projectPath ?? currentDirectory ?? "",
          harness ?? "",
          model ?? "",
        ],
      });
    }
    const instructions = optionalString(body.seed?.instructions)?.trim();
    const clientMessageId = optionalString(body.seed?.clientMessageId)?.trim();
    const fromMessageId = optionalString(body.seed?.fromMessageId)?.trim();
    const fromConversationId = optionalString(body.seed?.fromConversationId)?.trim();
    if ((fromMessageId && !fromConversationId) || (fromConversationId && !fromMessageId)) {
      return c.json(
        { error: "seed.fromMessageId and seed.fromConversationId must be provided together" },
        400,
      );
    }
    if (fromConversationId && !isOpaqueChannelId(fromConversationId)) {
      return c.json({ error: "seed.fromConversationId must be an opaque chat id" }, 400);
    }
    const seedAttachments = Array.isArray(body.seed?.attachments)
      ? body.seed.attachments
      : undefined;
    const branchFrom = body.seed?.branchFrom;

    const result = await askScoutQuestion({
      senderId: resolveOperatorName().trim() || "operator",
      ...(projectPath
        ? {
            target: { kind: "project_path", projectPath },
            ...(routeTargetAgentId ? { targetAgentId: routeTargetAgentId } : {}),
          }
        : { targetLabel: routeTargetAgentId!, targetAgentId: routeTargetAgentId! }),
      body: instructions && instructions.length > 0 ? instructions : "New session started.",
      ...(harness ? { executionHarness: harness } : {}),
      ...(model ? { executionModel: model } : {}),
      ...(reasoningEffort ? { executionReasoningEffort: reasoningEffort } : {}),
      ...(session ? { executionSession: session } : {}),
      ...(targetSessionId ? { executionTargetSessionId: targetSessionId } : {}),
      ...(forkFromSessionId ? { executionForkFromSessionId: forkFromSessionId } : {}),
      ...(forkFromStateId ? { executionForkFromStateId: forkFromStateId } : {}),
      ...(seedAttachments?.length ? { attachments: seedAttachments } : {}),
      projectAgent: {
        persistence,
        ...(agentHandle ? { handle: agentHandle } : {}),
      },
      currentDirectory: projectPath ?? currentDirectory,
      source: "scout-session-initiation",
      ...(clientMessageId ? { clientMessageId } : {}),
    });

    if (!result.usedBroker) {
      return c.json({ error: "broker unreachable" }, 502);
    }
    if (result.unresolvedTarget) {
      console.warn("[openscout-web] api.sessions.unresolved", JSON.stringify({
        target: result.unresolvedTarget,
        targetAgentId: routeTargetAgentId ?? null,
        requestedAgentId: targetAgentId ?? null,
        projectPath: projectPath ?? null,
        harness: harness ?? null,
        model: model ?? null,
        session,
        targetDiagnostic: result.targetDiagnostic ?? null,
      }));
      return c.json(
        {
          error: `could not start session: ${result.unresolvedTarget}`,
          targetDiagnostic: result.targetDiagnostic ?? null,
        },
        409,
      );
    }

    // Session work already launched above. Anchoring is metadata-only and must
    // never turn a successful launch into a client retry (duplicate sessions).
    let anchoredConversation: ConversationDefinition | null = null;
    let anchorError: string | null = null;
    if (result.conversationId && fromConversationId && fromMessageId) {
      try {
        anchoredConversation = await anchorConversationToMessage({
          conversationId: result.conversationId,
          parentConversationId: fromConversationId,
          anchorMessageId: fromMessageId,
        });
        if (!anchoredConversation) {
          anchorError = "could not anchor session conversation";
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        anchorError = `could not anchor session conversation: ${message}`;
      }
    }

    return c.json({
      ok: true,
      conversationId: result.conversationId ?? null,
      messageId: result.messageId ?? null,
      flightId: result.flight?.id ?? null,
      invocationId: result.flight?.invocationId ?? null,
      agentId: result.targetAgentId ?? result.flight?.targetAgentId ?? routeTargetAgentId ?? targetAgentId ?? null,
      sessionId: result.targetSessionId ?? null,
      handle: agentHandle ?? null,
      provenance:
        fromMessageId || fromConversationId || branchFrom
          ? {
              fromMessageId: fromMessageId ?? null,
              fromConversationId: fromConversationId ?? null,
              branchFrom: branchFrom ?? null,
            }
          : null,
      anchoredConversationId: anchoredConversation?.id ?? null,
      ...(anchorError ? { anchorError } : {}),
    });
  });
  app.get("/api/observe/agents", async (c) => {
    const ids = c.req.query("ids")
      ?.split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    return c.json(await loadAgentObserveSummaries(ids));
  });
  // The in-thread live-turn strip and the Observe sidecar both poll this
  // route for the same actor on ~1.2s cadences. Coalesce identical requests
  // through one short-lived build so concurrent and back-to-back polls share
  // a single computation instead of each queueing a full observe scan.
  const observeResponseCache = new Map<
    string,
    { at: number; promise: Promise<{ body: unknown; status: 200 | 404 }> }
  >();
  const OBSERVE_RESPONSE_TTL_MS = 900;
  const OBSERVE_RESPONSE_CACHE_LIMIT = 32;
  app.get("/api/agents/:id/observe", async (c) => {
    const id = c.req.param("id");
    const sessionId = c.req.query("sessionId") ?? null;
    const cacheKey = `${id}\u0000${sessionId ?? ""}`;
    const now = Date.now();
    let entry = observeResponseCache.get(cacheKey);
    if (!entry || now - entry.at > OBSERVE_RESPONSE_TTL_MS) {
      for (const [key, cached] of observeResponseCache) {
        if (now - cached.at > OBSERVE_RESPONSE_TTL_MS) observeResponseCache.delete(key);
      }
      while (observeResponseCache.size >= OBSERVE_RESPONSE_CACHE_LIMIT) {
        const oldestKey = observeResponseCache.keys().next().value;
        if (typeof oldestKey !== "string") break;
        observeResponseCache.delete(oldestKey);
      }
      entry = {
        at: now,
        promise: (async (): Promise<{ body: unknown; status: 200 | 404 }> => {
          const payload = await loadAgentObservePayload(id, { sessionId });
          if (payload) {
            return { body: payload, status: 200 };
          }
          // A conversation's counterpart can be a per-session actor rather
          // than a roster agent. Resolve it through the session-ref loader
          // instead of burning a slow scan into a 404. The session-ref
          // payload's agentId may be null; the native decoder requires a
          // string, so echo the requested id back.
          for (const ref of [sessionId, id]) {
            if (!ref?.trim()) continue;
            const fallback = await loadSessionRefObservePayload(ref);
            if (fallback) {
              return { body: { ...fallback, agentId: fallback.agentId ?? id }, status: 200 };
            }
          }
          return { body: { error: "not found" }, status: 404 };
        })(),
      };
      observeResponseCache.set(cacheKey, entry);
      const failed = entry;
      entry.promise.catch(() => {
        if (observeResponseCache.get(cacheKey) === failed) {
          observeResponseCache.delete(cacheKey);
        }
      });
    }
    const result = await entry.promise;
    return c.json(result.body as Record<string, unknown>, result.status);
  });
  app.get("/api/agents/:agentId/config", async (c) => {
    const agentId = c.req.param("agentId");
    const { getLocalAgentConfig } = await import("@openscout/runtime/local-agents");
    const config = await getLocalAgentConfig(agentId);
    return config ? c.json(config) : c.json({ error: "agent config not found" }, 404);
  });
  app.post("/api/agents/:agentId/config", async (c) => {
    const agentId = c.req.param("agentId");
    const parsed = await readJsonBody(c, agentConfigPatchBody);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const { getLocalAgentConfig, restartLocalAgent, updateLocalAgentConfig } =
      await import("@openscout/runtime/local-agents");
    const existing = await getLocalAgentConfig(agentId);
    if (!existing) {
      return c.json({ error: "agent config not found" }, 404);
    }

    const runtime = body.runtime && typeof body.runtime === "object"
      ? body.runtime as Record<string, unknown>
      : {};
    const model = hasOwn(body, "model")
      ? optionalString(body.model)?.trim() || null
      : existing.model;
    const nextConfig = await updateLocalAgentConfig(agentId, {
      runtime: {
        cwd: optionalString(runtime.cwd) ?? existing.runtime.cwd,
        harness: optionalString(runtime.harness) ?? existing.runtime.harness,
        transport: optionalString(runtime.transport) ?? existing.runtime.transport,
        sessionId: optionalString(runtime.sessionId) ?? existing.runtime.sessionId,
      },
      systemPrompt: optionalString(body.systemPrompt) ?? existing.systemPrompt,
      launchArgs: stringList(body.launchArgs, existing.launchArgs),
      model,
      capabilities: stringList(body.capabilities, existing.capabilities),
    });
    if (!nextConfig) {
      return c.json({ error: "agent config not found" }, 404);
    }

    let restarted = false;
    if (body.restart === true) {
      const restartedRecord = await restartLocalAgent(agentId);
      restarted = Boolean(restartedRecord);
    }
    shellStateCache.invalidate();
    agentsResponseCache.clear();
    const config = await getLocalAgentConfig(agentId);
    return c.json({ config: config ?? nextConfig, restarted });
  });
  app.get("/api/agents/:id/session-catalog", async (c) => {
    const agentId = c.req.param("id");
    const agents = queryAgents();
    const agent = agents.find((a) => a.id === agentId);
    if (!agent) return c.json(emptyAgentSessionCatalogPayload(agentId));
    const observePayload = await loadAgentObservePayload(agentId).catch(() => null);
    const observedModel = observePayload?.data.metadata?.session?.model?.trim() || null;
    const observedEffort = observePayload?.data.metadata?.session?.effort?.trim() || null;
    const broker = await loadScoutBrokerContext().catch(() => null);
    const endpoint = broker ? activeEndpointForAgent(broker.snapshot, agentId, {
      harness: agent.harness,
      transport: agent.transport,
      sessionId: agent.harnessSessionId,
      cwd: agent.cwd,
      projectRoot: agent.projectRoot,
    }) : null;
    const cwd = endpoint?.cwd ?? endpoint?.projectRoot ?? agent.cwd ?? agent.projectRoot ?? ".";
    const discoveredTranscripts = agent.harness
      ? (await tailRuntime.getTailDiscovery().catch(() => null))?.transcripts ?? [] : [];
    const verifiedTmuxSessionId = agent.transport === "tmux"
      ? resolveHarnessSessionId("tmux", endpoint?.sessionId ?? null, agentEndpointMetadata(endpoint)) : null;
    const nativeTranscript = agent.transport === "tmux"
      ? discoveredTranscripts.find((transcript) => transcript.harness === agent.harness
        && transcript.sessionId === verifiedTmuxSessionId) ?? null
      : agent.harness ? mostRecentTranscriptForHarnessCwd(discoveredTranscripts, agent.harness, cwd) : null;
    return c.json(
      buildAgentSessionCatalogPayload({
        agentId,
        harness: agent.harness,
        cwd,
        transport: agent.transport,
        terminalSurface: agent.terminalSurface,
        activeSessionId: endpoint?.sessionId ?? (agent.transport === "tmux"
          ? agent.terminalSurface?.sessionName ?? null : agent.harnessSessionId),
        model: observedModel ?? agent.model,
        reasoningEffort: observedEffort ?? agent.reasoningEffort,
        startedAt: agent.createdAt ?? agent.updatedAt,
        endpoint,
        nativeTranscript,
      }),
    );
  });
  app.get("/api/agents/:agentId/tmux-peek", async (c) => {
    const agentId = c.req.param("agentId");
    const agent = queryAgents(200).find((candidate) => candidate.id === agentId)
      ?? queryAgentById(agentId);
    if (!agent) return c.json({ error: "agent not found" }, 404);

    const broker = await loadScoutBrokerContext().catch(() => null);
    const endpoint = broker ? activeEndpointForAgent(broker.snapshot, agentId, {
      harness: agent.harness,
      transport: agent.transport,
      sessionId: agent.harnessSessionId,
      cwd: agent.cwd,
      projectRoot: agent.projectRoot,
    }) : null;
    const target = resolveTmuxPeekTarget(agent, endpoint);
    const capturedAt = Date.now();
    const lines = parseTmuxPeekLineCount(c.req.query("lines"));
    const columns = parseTmuxPeekColumnCount(c.req.query("cols") ?? c.req.query("columns"));
    if (!target) {
      return c.json({
        available: false,
        agentId,
        sessionId: null,
        capturedAt,
        body: "",
        lineCount: 0,
        columnCount: columns,
        truncated: false,
        reason: "No tmux-backed session is registered for this agent.",
      });
    }

    const capture = await (options.captureTmuxPane ?? defaultCaptureTmuxPane)({
      agentId,
      sessionId: target.sessionId,
      paneTarget: target.paneTarget,
      cwd: target.cwd,
      lines,
      columns,
    });
    if (!capture) {
      return c.json({
        available: false,
        agentId,
        sessionId: target.sessionId,
        capturedAt,
        body: "",
        lineCount: 0,
        columnCount: columns,
        truncated: false,
        reason: "The tmux pane is not available right now.",
      });
    }

    const normalized = normalizeTmuxPeekBody(capture.body, lines, columns);
    return c.json({
      available: true,
      agentId,
      sessionId: target.sessionId,
      capturedAt,
      body: normalized.body,
      lineCount: capture.lineCount ?? normalized.lineCount,
      columnCount: normalized.columnCount,
      truncated: capture.truncated ?? normalized.truncated,
      reason: null,
    });
  });
  app.get("/api/agents/:agentId/session/context", async (c) => {
    const agentId = c.req.param("agentId");
    const { getLocalAgentContextState } =
      await import("@openscout/runtime/local-agents");
    const context = await getLocalAgentContextState(agentId);
    if (!context) {
      return c.json({ error: "agent config not found" }, 404);
    }
    return c.json(context);
  });

  app.post("/api/session-control/compact", async (c) => {
    const body = await c.req.json().catch(() => ({})) as {
      harness?: unknown;
      sessionId?: unknown;
      transcriptPath?: unknown;
      tmuxSessionName?: unknown;
      agentId?: unknown;
    };
    const harness = typeof body.harness === "string" ? body.harness.trim() : "";
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    const transcriptPath = typeof body.transcriptPath === "string" ? body.transcriptPath.trim() : "";
    let tmuxSessionName = typeof body.tmuxSessionName === "string" ? body.tmuxSessionName.trim() : "";
    const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";

    if (!tmuxSessionName && agentId) {
      const agent = queryAgents().find((entry) => entry.id === agentId) ?? null;
      tmuxSessionName = agent?.terminalSurface?.sessionName
        ?? agent?.harnessSessionId
        ?? "";
    }
    const result = await requestHarnessSessionCompaction({
      harness,
      sessionId,
      transcriptPath,
      tmuxSessionName,
      agentId,
    });
    return c.json(result, result.ok ? 200 : 422);
  });

  app.post("/api/agents/:agentId/interrupt", async (c) => {
    const agentId = c.req.param("agentId");
    const { interruptLocalAgent } =
      await import("@openscout/runtime/local-agents");
    const result = await interruptLocalAgent(agentId);
    if (!result.ok)
      return c.json({ error: "Agent not found or not interruptible" }, 404);
    return c.json({ ok: true });
  });

  // Archive (or restore) an agent — hides it from the web directory. The flag
  // lives on the persisted relay-agent override (survives config edits + sync).
  app.post("/api/agents/:agentId/archive", async (c) => {
    const agentId = c.req.param("agentId");
    const parsed = await readJsonBody(c, agentArchiveBody);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const archived = body.archived !== false; // default: archive
    const { setLocalAgentArchived } = await import("@openscout/runtime/local-agents");
    const ok = await setLocalAgentArchived(agentId, archived);
    if (!ok) {
      return c.json({ error: "agent config not found" }, 404);
    }
    shellStateCache.invalidate();
    // The client reloads /api/agents immediately after this returns; a
    // coalesced pre-archive read must not answer that reload.
    agentsResponseCache.clear();
    return c.json({ ok: true, agentId, archived });
  });

  app.post("/api/agents/:agentId/session/reset", async (c) => {
    const agentId = c.req.param("agentId");
    const { getLocalAgentConfig, restartLocalAgent } =
      await import("@openscout/runtime/local-agents");
    const config = await getLocalAgentConfig(agentId);
    if (!config) {
      return c.json({ error: "agent config not found" }, 404);
    }

    const restarted = await restartLocalAgent(agentId);
    if (!restarted) {
      return c.json({ error: "agent not found or not restartable" }, 404);
    }

    shellStateCache.invalidate();
    const runtimeDir = relayAgentRuntimeDirectory(agentId);
    const catalog = readSessionCatalogSync(runtimeDir);
    const sessionId = catalog.activeSessionId;
    const harnessEntry = findHarnessEntry(config.runtime.harness);
    const resumeCommand = sessionId && harnessEntry
      ? buildHarnessResumeCommand(harnessEntry, sessionId, config.runtime.cwd)
      : null;

    return c.json({
      ok: true,
      agentId,
      catalog: {
        ...catalog,
        agentId,
        harness: config.runtime.harness,
        resumeCommand,
        resumeCwd: config.runtime.cwd,
      },
    });
  });
}
