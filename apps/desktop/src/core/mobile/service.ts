import { basename, resolve } from "node:path";
import { statSync } from "node:fs";

import type {
  AgentDefinition,
  AgentEndpoint,
  AgentHarness,
  FlightRecord,
  MessageRecord,
} from "@openscout/protocol";
import {
  channelNaturalKeyFromMetadata,
  epochMs,
  SCOUT_RUNTIME_CATALOG,
  scoutRuntimeDefaultHarness,
  scoutRuntimeDefaultModel,
  scoutRuntimeDefaultReasoningEffort,
  scoutRuntimeDefaultsByHarness,
  scoutRuntimeEffortCatalog,
  scoutRuntimeModelCatalog,
} from "@openscout/protocol";
import { loadHarnessCatalogSnapshot } from "@openscout/runtime/harness-catalog";
import {
  collectOccupiedDefinitionIdsFromBrokerSnapshot,
  resolveProjectProvisionalAgentName,
} from "@openscout/runtime";
import {
  type ProjectInventoryEntry,
  loadResolvedRelayAgents,
} from "@openscout/runtime/setup";
import { createAgentWorkspace } from "@openscout/runtime/agent-workspace";

import { upScoutAgent } from "../agents/service.ts";
import { queryAgents, queryFleet } from "../../server/db-queries.ts";
import {
  loadScoutBrokerContext,
  readScoutBrokerHome,
  readScoutRuntimeCatalog,
  openScoutPeerSession,
  registerScoutLocalAgentBinding,
  normalizeOutgoingAttachments,
  replyToScoutMessage,
  sendScoutDirectMessage,
  sendScoutMessage,
  type OutgoingAttachmentInput,
  type ScoutBrokerConversationRecord,
  type ScoutBrokerHomeActivityRecord,
  type ScoutBrokerSnapshot,
  type ScoutDirectMessageResult,
} from "../broker/service.ts";
import { resolveOperatorName } from "@openscout/runtime/user-config";

const SCOUTBOT_AGENT_ID = "scoutbot";
const SCOUTBOT_DEFAULT_THREAD_ID = "thr-default";
const SCOUTBOT_DEFAULT_CONVERSATION_ID = "dm.operator.scoutbot.default";
const SCOUTBOT_LEGACY_CONVERSATION_ID = "dm.operator.scoutbot";

export async function getScoutMobileRuntimeCapabilities(projectRoot?: string) {
  const normalizedProjectRoot = projectRoot?.trim() ? resolve(projectRoot) : null;
  const liveCatalog = await readScoutRuntimeCatalog();
  const runtimeCatalog = liveCatalog?.catalog ?? SCOUT_RUNTIME_CATALOG;
  const defaultHarness = scoutRuntimeDefaultHarness(runtimeCatalog);
  const defaultModel = scoutRuntimeDefaultModel(defaultHarness ?? "", runtimeCatalog);
  const models = scoutRuntimeModelCatalog(runtimeCatalog).map((model) => ({
    ...model,
    harnesses: [...model.harnesses],
  }));
  return {
    schemaVersion: "openscout.runtime-capabilities.v1" as const,
    catalogVersion: runtimeCatalog.schemaVersion,
    catalogRevision: runtimeCatalog.revision,
    generatedAt: Date.now(),
    scope: projectRoot ? "global+project" as const : "global" as const,
    ...(normalizedProjectRoot ? { projectRoot: normalizedProjectRoot } : {}),
    defaults: {
      ...(defaultHarness ? { harness: defaultHarness } : {}),
      model: defaultModel,
      reasoningEffort: scoutRuntimeDefaultReasoningEffort(defaultHarness ?? "", defaultModel, runtimeCatalog),
    },
    defaultsByHarness: scoutRuntimeDefaultsByHarness(runtimeCatalog),
    harnesses: runtimeCatalog.harnesses
      .filter((entry) => entry.enabled && entry.listed !== false)
      .map((entry) => ({ id: entry.id, label: entry.label })),
    models,
    efforts: scoutRuntimeEffortCatalog(runtimeCatalog).map((effort) => ({
      ...effort,
      harnesses: [...effort.harnesses],
      ...(effort.models ? { models: [...effort.models] } : {}),
    })),
    ...(liveCatalog?.warnings.length ? { warnings: liveCatalog.warnings } : {}),
  };
}

export type ScoutMobileListFilters = {
  query?: string;
  limit?: number;
};

export type ScoutMobileWorkspaceSummary = {
  id: string;
  title: string;
  projectName: string;
  root: string;
  sourceRoot: string;
  relativePath: string;
  registrationKind: ProjectInventoryEntry["registrationKind"];
  defaultHarness: string;
  harnesses: Array<{
    harness: string;
    source: "manifest" | "marker" | "default";
    detail: string;
    readinessState: "ready" | "configured" | "installed" | "missing" | null;
    readinessDetail: string | null;
  }>;
};

export type ScoutMobileAgentSummary = {
  id: string;
  title: string;
  selector: string | null;
  defaultSelector: string | null;
  nodeId: string | null;
  nodeName: string | null;
  workspaceRoot: string | null;
  harness: string | null;
  transport: string | null;
  state: "offline" | "available" | "working";
  statusLabel: string;
  sessionId: string | null;
  lastActiveAt: number | null;
};

export type ScoutMobileSessionSummary = {
  id: string;
  kind: string;
  title: string;
  participantIds: string[];
  agentId: string | null;
  agentName: string | null;
  harness: string | null;
  currentBranch: string | null;
  preview: string | null;
  messageCount: number;
  lastMessageAt: number | null;
  workspaceRoot: string | null;
};

export type ScoutMobileHomeState = {
  workspaces: ScoutMobileWorkspaceSummary[];
  agents: ScoutMobileAgentSummary[];
  sessions: ScoutMobileSessionSummary[];
  totals: {
    workspaces: number;
    agents: number;
    sessions: number;
  };
};

export type CreateScoutSessionInput = {
  workspaceId: string;
  harness?: AgentHarness;
  agentName?: string;
  worktree?: string | null;
  profile?: string | null;
  branch?: string;
  model?: string;
  forceNew?: boolean;
  seed?: {
    instructions?: string | null;
    fromMessageId?: string | null;
    fromConversationId?: string | null;
    attachments?: OutgoingAttachmentInput[];
  } | null;
};

export type ScoutMobileSessionHandle = {
  workspace: ScoutMobileWorkspaceSummary;
  agent: ScoutMobileAgentSummary;
  session: {
    conversationId: string;
    title: string;
    existed: boolean;
  };
  messageId?: string | null;
  flightId?: string | null;
  unsupported: Array<"worktree" | "profile">;
};

export type ScoutMobileSessionSnapshot = {
  session: {
    id: string;
    name: string;
    adapterType: string;
    status: "connecting" | "active" | "idle" | "error" | "closed";
    cwd: string | null;
    model: string | null;
    providerMeta?: Record<string, unknown>;
  };
  history: {
    hasOlder: boolean;
    oldestTurnId: string | null;
    newestTurnId: string | null;
  };
  turns: Array<{
    id: string;
    status: "streaming" | "completed" | "interrupted" | "error";
    blocks: Array<{
      block: {
        id: string;
        turnId: string;
        type: "text" | "reasoning" | "action" | "file" | "error";
        status: "started" | "streaming" | "completed" | "failed";
        index: number;
        text?: string;
        mimeType?: string;
        name?: string;
        data?: string;
        url?: string;
        message?: string;
      };
      status: "streaming" | "completed";
    }>;
    startedAt: number;
    endedAt?: number;
    isUserTurn?: boolean;
    clientMessageId?: string | null;
  }>;
  currentTurnId: string | null;
};

const DEFAULT_MOBILE_RECENT_TURN_LIMIT = 24;
const DEFAULT_MOBILE_HISTORY_PAGE_LIMIT = 40;

export type SendScoutMobileMessageInput = {
  agentId: string;
  body: string;
  source?: "scout-mobile" | "scout-tui-harness";
  attachments?: OutgoingAttachmentInput[];
  clientMessageId?: string | null;
  replyToMessageId?: string | null;
  referenceMessageIds?: string[];
  harness?: AgentHarness;
};

export type ScoutMobileSendLifecycleState =
  | "queued"
  | "dispatching"
  | "acknowledged"
  | "working"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

export type ScoutMobileSendResult = {
  conversationId: string;
  messageId: string;
  flightId?: string | null;
  invocationId?: string | null;
  targetAgentId?: string | null;
  lifecycleState?: ScoutMobileSendLifecycleState | null;
  summary?: string | null;
  error?: string | null;
};

function mobileLifecycleStateForFlight(flight: { state?: string } | null | undefined): ScoutMobileSendLifecycleState | null {
  switch (flight?.state) {
    case "queued": return "queued";
    case "waking": return "dispatching";
    case "running": return "working";
    case "waiting": return "waiting";
    case "completed": return "completed";
    case "failed": return "failed";
    case "cancelled": return "cancelled";
    default: return null;
  }
}

function mobileSendResultFromDirect(result: ScoutDirectMessageResult): ScoutMobileSendResult {
  return {
    conversationId: result.conversationId,
    messageId: result.messageId,
    flightId: result.flight?.id ?? null,
    invocationId: result.flight?.invocationId ?? null,
    targetAgentId: result.flight?.targetAgentId ?? null,
    lifecycleState: mobileLifecycleStateForFlight(result.flight) ?? (result.flight ? "dispatching" : null),
    summary: result.flight?.summary ?? null,
    error: result.flight?.error ?? null,
  };
}

function normalizeTimestamp(value: number | null | undefined): number | null {
  const ms = epochMs(value);
  return ms === null ? null : Math.floor(ms / 1000);
}

function normalizeTimestampMs(value: number | null | undefined): number | null {
  return epochMs(value);
}

function requireTimestampMs(value: number | null | undefined): number {
  return normalizeTimestampMs(value) ?? 0;
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function metadataTimestampMs(metadata: Record<string, unknown> | undefined, key: string): number | null {
  return normalizeTimestampMs(metadata?.[key] as number | null | undefined);
}

function metadataBoolean(metadata: Record<string, unknown> | undefined, key: string): boolean {
  return metadata?.[key] === true;
}

function isBrokerRequesterWaitTimeoutStatusMessage(message: MessageRecord): boolean {
  if (message.class !== "status" || metadataString(message.metadata, "source") !== "broker") {
    return false;
  }
  return message.body.includes("Scout stopped waiting for a synchronous result")
    || message.body.includes("the requester stopped waiting after");
}

function isRequesterWaitTimeoutFlight(flight: FlightRecord): boolean {
  return metadataBoolean(flight.metadata, "requesterTimedOut")
    || metadataString(flight.metadata, "timeoutScope") === "requester_wait"
    || Boolean(flight.summary?.includes("Scout stopped waiting for a synchronous result"));
}

function isInactiveAgent(agent: AgentDefinition | null | undefined): boolean {
  return metadataBoolean(agent?.metadata, "retiredFromFleet")
    || metadataBoolean(agent?.metadata, "staleLocalRegistration");
}

function isInactiveEndpoint(snapshot: ScoutBrokerSnapshot, endpoint: AgentEndpoint | null | undefined): boolean {
  if (!endpoint) {
    return true;
  }
  return metadataBoolean(endpoint.metadata, "retiredFromFleet")
    || metadataBoolean(endpoint.metadata, "staleLocalRegistration")
    || isInactiveAgent(snapshot.agents[endpoint.agentId]);
}

function titleCaseToken(value: string): string {
  return value.length === 0 ? value : `${value[0]!.toUpperCase()}${value.slice(1)}`;
}

function humanizeWorkspaceName(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const base = trimmed.split("/").at(-1)?.trim() || trimmed;
  if (!base) return null;
  return base
    .split(/[-_]+/g)
    .filter((token) => token.length > 0)
    .map(titleCaseToken)
    .join(" ");
}

function normalizeQuery(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function withQueryAndLimit<T>(
  values: T[],
  filters: ScoutMobileListFilters | undefined,
  match: (value: T, query: string) => boolean,
): T[] {
  const query = normalizeQuery(filters?.query);
  const limited = query ? values.filter((value) => match(value, query)) : values;
  const limit = typeof filters?.limit === "number" && filters.limit > 0 ? Math.floor(filters.limit) : null;
  return limit ? limited.slice(0, limit) : limited;
}

function harnessReadinessMap(snapshot: Awaited<ReturnType<typeof loadHarnessCatalogSnapshot>>) {
  return new Map(snapshot.entries.map((entry) => [entry.harness, entry.readinessReport] as const));
}

async function loadMobileWorkspaceInventory(currentDirectory?: string): Promise<ScoutMobileWorkspaceSummary[]> {
  const [setup, catalog] = await Promise.all([
    loadResolvedRelayAgents({ currentDirectory }),
    loadHarnessCatalogSnapshot(),
  ]);
  const readinessByHarness = harnessReadinessMap(catalog);

  return setup.projectInventory
    .map((project) => ({
      id: project.projectRoot,
      title: project.displayName,
      projectName: project.projectName,
      root: project.projectRoot,
      sourceRoot: project.sourceRoot,
      relativePath: project.relativePath,
      registrationKind: project.registrationKind,
      defaultHarness: project.defaultHarness,
      harnesses: project.harnesses.map((harness) => {
        const readiness = readinessByHarness.get(harness.harness);
        return {
          harness: harness.harness,
          source: harness.source,
          detail: harness.detail,
          readinessState: readiness?.state ?? null,
          readinessDetail: readiness?.detail ?? null,
        };
      }),
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath) || left.title.localeCompare(right.title));
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Rebase a legacy macOS user-home path onto the account running Scout. */
export function rehomeScoutMobileWorkspacePath(requestedPath: string, currentHome: string): string | null {
  const requested = resolve(requestedPath);
  const home = resolve(currentHome);
  const requestedMatch = requested.match(/^\/Users\/[^/]+(\/.*)?$/);
  if (!requestedMatch || !/^\/Users\/[^/]+$/.test(home)) return null;
  const suffix = requestedMatch[1] ?? "";
  return resolve(home, `.${suffix || "/"}`);
}

async function resolveMobileWorkspaceRoot(rawWorkspaceId: string, currentDirectory?: string): Promise<string> {
  const requested = resolve(rawWorkspaceId);
  if (isDirectory(requested)) return requested;

  const currentHome = process.env.HOME?.trim();
  const rehomed = currentHome ? rehomeScoutMobileWorkspacePath(requested, currentHome) : null;
  if (rehomed && isDirectory(rehomed)) return rehomed;

  // Last-resort identity lookup for stale session-history paths. Only accept a
  // unique current workspace with the same leaf/name; ambiguity is safer as a
  // clear error than silently launching in the wrong repository.
  const requestedName = basename(requested).toLowerCase();
  const inventory = await loadMobileWorkspaceInventory(currentDirectory);
  const matches = inventory.filter((workspace) => (
    isDirectory(workspace.root)
    && [basename(workspace.root), workspace.projectName, workspace.title]
      .some((value) => value.toLowerCase() === requestedName)
  ));
  if (matches.length === 1) return resolve(matches[0]!.root);

  throw new Error(`Workspace is not available on this Mac: ${rawWorkspaceId}. Choose a project from the current workspace list.`);
}

function latestMessageByConversation(snapshot: ScoutBrokerSnapshot): Map<string, MessageRecord[]> {
  const buckets = new Map<string, MessageRecord[]>();
  for (const message of Object.values(snapshot.messages)) {
    if (isBrokerRequesterWaitTimeoutStatusMessage(message)) {
      continue;
    }
    const next = buckets.get(message.conversationId) ?? [];
    next.push(message);
    buckets.set(message.conversationId, next);
  }
  for (const messages of buckets.values()) {
    messages.sort((left, right) => (normalizeTimestamp(left.createdAt) ?? 0) - (normalizeTimestamp(right.createdAt) ?? 0));
  }
  return buckets;
}

function agentDisplayName(snapshot: ScoutBrokerSnapshot, agentId: string): string {
  const endpoint = endpointForAgent(snapshot, agentId);
  const workspaceTitle = humanizeWorkspaceName(endpoint?.projectRoot ?? endpoint?.cwd ?? null);
  if (workspaceTitle) {
    return workspaceTitle;
  }
  return snapshot.agents[agentId]?.displayName
    ?? snapshot.actors[agentId]?.displayName
    ?? agentId;
}

function rawConversationTitle(conversation: ScoutBrokerConversationRecord): string | null {
  const title = typeof conversation.title === "string" ? conversation.title.trim() : "";
  return title.length > 0 ? title : null;
}

function conversationIdTitle(conversationId: string): string {
  if (conversationId.startsWith("channel.")) {
    return conversationId.slice("channel.".length);
  }
  if (conversationId.startsWith("dm.operator.")) {
    return conversationId.slice("dm.operator.".length);
  }
  return conversationId;
}

function mobileConversationTitle(
  snapshot: ScoutBrokerSnapshot,
  conversation: ScoutBrokerConversationRecord,
  directAgentId: string | null = null,
): string {
  if (conversation.kind === "direct" && directAgentId) {
    return agentDisplayName(snapshot, directAgentId);
  }
  const title = rawConversationTitle(conversation) ?? conversationIdTitle(conversation.id);
  return conversation.kind === "channel" && title.startsWith("channel.")
    ? title.slice("channel.".length)
    : title;
}

function endpointsForAgent(snapshot: ScoutBrokerSnapshot, agentId: string): AgentEndpoint[] {
  const stateRank = (state: AgentEndpoint["state"]): number => {
    switch (state) {
      case "active": return 0;
      case "idle": return 1;
      case "waiting": return 2;
      case "offline": return 4;
      default: return 3;
    }
  };
  return Object.values(snapshot.endpoints)
    .filter((endpoint) => endpoint.agentId === agentId && !isInactiveEndpoint(snapshot, endpoint))
    .sort((left, right) => (
      Number(right.preferred === true) - Number(left.preferred === true)
      || stateRank(left.state) - stateRank(right.state)
      || (endpointActivityAt(right) ?? 0) - (endpointActivityAt(left) ?? 0)
      || left.id.localeCompare(right.id)
    ));
}

/**
 * The runtime an actor runs on, for feed attribution.
 *
 * Unlike `endpointForAgent`, this deliberately accepts inactive/offline
 * endpoints: a post from an hour ago still ran on whatever harness it ran on,
 * and the phone needs that to badge it. Cardless flight actors
 * ("openscout-faraday-2") never appear in the AGENT roster, so their endpoint
 * is the only place their runtime is recorded. Returns null for actors with no
 * endpoint at all (the operator, broker notices) — the caller must render
 * nothing rather than guess.
 */
function harnessForActor(snapshot: ScoutBrokerSnapshot, actorId: string): string | null {
  const live = endpointForAgent(snapshot, actorId);
  if (live?.harness) return live.harness;
  const any = Object.values(snapshot.endpoints ?? {}).find(
    (endpoint) => endpoint.agentId === actorId && endpoint.harness,
  );
  return any?.harness ?? null;
}

function endpointForAgent(snapshot: ScoutBrokerSnapshot, agentId: string): AgentEndpoint | null {
  return endpointsForAgent(snapshot, agentId)[0] ?? null;
}

function maxTimestampMs(values: Array<number | null | undefined>): number | null {
  const timestamps = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return timestamps.length > 0 ? Math.max(...timestamps) : null;
}

function endpointActivityAt(endpoint: AgentEndpoint | null): number | null {
  if (!endpoint) return null;
  return maxTimestampMs([
    metadataTimestampMs(endpoint.metadata, "lastSeenAt"),
    metadataTimestampMs(endpoint.metadata, "lastEnsuredAt"),
    metadataTimestampMs(endpoint.metadata, "lastStartedAt"),
    metadataTimestampMs(endpoint.metadata, "lastCompletedAt"),
    metadataTimestampMs(endpoint.metadata, "lastFailedAt"),
    metadataTimestampMs(endpoint.metadata, "startedAt"),
  ]);
}

function flightActivityAt(flight: FlightRecord): number | null {
  return maxTimestampMs([
    normalizeTimestampMs(flight.completedAt),
    normalizeTimestampMs(flight.startedAt),
  ]);
}

function isActiveMobileFlight(flight: FlightRecord): boolean {
  return flight.state === "running"
    || flight.state === "waiting"
    || flight.state === "queued"
    || flight.state === "waking";
}

function buildMobileAgentSummary(
  snapshot: ScoutBrokerSnapshot,
  agent: AgentDefinition,
): ScoutMobileAgentSummary {
  const endpoints = endpointsForAgent(snapshot, agent.id);
  const endpoint = endpoints[0] ?? null;
  const flights = Object.values(snapshot.flights as Record<string, FlightRecord>).filter((flight) => flight.targetAgentId === agent.id);
  const hasActiveFlight = flights.some(isActiveMobileFlight);
  const lastAuthoredMessageAt = Object.values(snapshot.messages)
    .filter((message) => message.actorId === agent.id)
    .reduce<number | null>((latest, message) => {
      const createdAt = normalizeTimestampMs(message.createdAt);
      return typeof createdAt === "number" && (!latest || createdAt > latest) ? createdAt : latest;
    }, null);
  const lastActiveAt = maxTimestampMs([
    lastAuthoredMessageAt,
    ...endpoints.map(endpointActivityAt),
    ...flights.map(flightActivityAt),
  ]);

  const state = hasActiveFlight
    ? "working"
    : endpoints.some((candidate) => candidate.state !== "offline")
      ? "available"
      : agent.wakePolicy !== "manual"
        ? "available"
        : "offline";

  return {
    id: agent.id,
    title: agent.displayName,
    selector: agent.selector ?? null,
    defaultSelector: agent.defaultSelector ?? null,
    nodeId: endpoint?.nodeId ?? agent.authorityNodeId ?? agent.homeNodeId ?? null,
    nodeName: (endpoint?.nodeId ? snapshot.nodes[endpoint.nodeId]?.name : null)
      ?? snapshot.nodes[agent.authorityNodeId]?.name
      ?? snapshot.nodes[agent.homeNodeId]?.name
      ?? null,
    workspaceRoot: endpoint?.projectRoot ?? endpoint?.cwd ?? null,
    harness: endpoint?.harness ?? null,
    transport: endpoint?.transport ?? null,
    state,
    statusLabel: state === "working" ? "Working" : state === "available" ? "Available" : "Offline",
    sessionId: endpoint?.sessionId ?? null,
    lastActiveAt,
  };
}

function buildMobileSessionSummaries(snapshot: ScoutBrokerSnapshot): ScoutMobileSessionSummary[] {
  const messagesByConversation = latestMessageByConversation(snapshot);
  const summaries: ScoutMobileSessionSummary[] = Object.values(snapshot.conversations)
    .filter((conversation) => conversation.kind === "direct")
    .flatMap((conversation) => {
      const messages = messagesByConversation.get(conversation.id) ?? [];
      const latestMessage = messages.at(-1) ?? null;
      const directAgentId = conversation.kind === "direct"
        ? conversation.participantIds.find((participantId) => participantId !== "operator") ?? null
        : null;
      const agent = directAgentId ? snapshot.agents[directAgentId] ?? null : null;
      if (!directAgentId || !agent || isInactiveAgent(agent) || messages.length === 0) {
        return [];
      }
      const endpoint = endpointForAgent(snapshot, directAgentId);
      if (!endpoint || endpoint.state === "offline") {
        return [];
      }
      return [{
        id: conversation.id,
        kind: conversation.kind,
        title: mobileConversationTitle(snapshot, conversation, directAgentId),
        participantIds: [...conversation.participantIds],
        agentId: directAgentId,
        agentName: directAgentId ? agentDisplayName(snapshot, directAgentId) : null,
        harness: endpoint?.harness ?? null,
        currentBranch:
          metadataString(endpoint?.metadata, "branch")
          ?? metadataString(endpoint?.metadata, "workspaceQualifier")
          ?? metadataString(agent?.metadata, "branch")
          ?? metadataString(agent?.metadata, "workspaceQualifier"),
        preview: latestMessage?.body ?? null,
        messageCount: messages.length,
        lastMessageAt: normalizeTimestampMs(latestMessage?.createdAt),
        workspaceRoot: endpoint?.projectRoot ?? endpoint?.cwd ?? null,
      }];
    });

  const deduped = new Map<string, ScoutMobileSessionSummary>();
  for (const summary of summaries) {
    const agent = summary.agentId ? snapshot.agents[summary.agentId] : null;
    const endpoint = summary.agentId ? endpointForAgent(snapshot, summary.agentId) : null;
    const branchQualifier =
      metadataString(endpoint?.metadata, "branch")
      ?? metadataString(endpoint?.metadata, "workspaceQualifier")
      ?? metadataString(agent?.metadata, "branch")
      ?? metadataString(agent?.metadata, "workspaceQualifier");
    const identityKey = [
      endpoint?.projectRoot?.trim().toLowerCase(),
      endpoint?.cwd?.trim().toLowerCase(),
      branchQualifier?.trim().toLowerCase(),
      endpoint?.harness?.trim().toLowerCase(),
      summary.agentName?.trim().toLowerCase(),
    ].filter((value): value is string => Boolean(value)).join("|") || summary.id;
    const existing = deduped.get(identityKey);
    if (!existing || (summary.lastMessageAt ?? 0) >= (existing.lastMessageAt ?? 0)) {
      deduped.set(identityKey, summary);
    }
  }

  return [...deduped.values()]
    .sort((left, right) => (right.lastMessageAt ?? 0) - (left.lastMessageAt ?? 0));
}

function messagesForConversation(
  snapshot: ScoutBrokerSnapshot,
  conversationId: string,
): MessageRecord[] {
  return Object.values(snapshot.messages)
    .filter((message) => !isBrokerRequesterWaitTimeoutStatusMessage(message))
    .filter((message) => message.conversationId === conversationId)
    .sort((left, right) => (normalizeTimestamp(left.createdAt) ?? 0) - (normalizeTimestamp(right.createdAt) ?? 0));
}

function pageMessagesForConversation(
  snapshot: ScoutBrokerSnapshot,
  conversationId: string,
  options: {
    beforeTurnId?: string | null;
    limit?: number | null;
  } = {},
): {
  messages: MessageRecord[];
  hasOlder: boolean;
  oldestTurnId: string | null;
  newestTurnId: string | null;
} {
  const allMessages = messagesForConversation(snapshot, conversationId);
  const normalizedLimit = Math.max(
    1,
    Math.floor(options.limit ?? (options.beforeTurnId ? DEFAULT_MOBILE_HISTORY_PAGE_LIMIT : DEFAULT_MOBILE_RECENT_TURN_LIMIT)),
  );

  if (allMessages.length === 0) {
    return {
      messages: [],
      hasOlder: false,
      oldestTurnId: null,
      newestTurnId: null,
    };
  }

  if (options.beforeTurnId) {
    const beforeIndex = allMessages.findIndex((message) => message.id === options.beforeTurnId);
    const endExclusive = beforeIndex >= 0 ? beforeIndex : allMessages.length;
    const start = Math.max(0, endExclusive - normalizedLimit);
    const messages = allMessages.slice(start, endExclusive);
    return {
      messages,
      hasOlder: start > 0,
      oldestTurnId: messages[0]?.id ?? null,
      newestTurnId: messages.at(-1)?.id ?? null,
    };
  }

  const start = Math.max(0, allMessages.length - normalizedLimit);
  const messages = allMessages.slice(start);
  return {
    messages,
    hasOlder: start > 0,
    oldestTurnId: messages[0]?.id ?? null,
    newestTurnId: messages.at(-1)?.id ?? null,
  };
}

function latestActiveFlightForAgent(
  snapshot: ScoutBrokerSnapshot,
  agentId: string | null,
): FlightRecord | null {
  if (!agentId) return null;
  return Object.values(snapshot.flights as Record<string, FlightRecord>)
    .filter((flight) => (
      flight.targetAgentId === agentId
      && (flight.state === "running" || flight.state === "waiting")
      && !isRequesterWaitTimeoutFlight(flight)
    ))
    .sort((left, right) => (normalizeTimestamp(right.startedAt) ?? 0) - (normalizeTimestamp(left.startedAt) ?? 0))[0] ?? null;
}

async function loadMobileRelayState(): Promise<{
  agents: ScoutMobileAgentSummary[];
  sessions: ScoutMobileSessionSummary[];
}> {
  const broker = await loadScoutBrokerContext();
  if (!broker) {
    return { agents: [], sessions: [] };
  }

  const snapshot = broker.snapshot;
  const agents = Object.values(snapshot.agents)
    .filter((agent) => !isInactiveAgent(agent))
    .filter((agent) => {
      const endpoints = Object.values(snapshot.endpoints)
        .filter((endpoint) => endpoint.agentId === agent.id);
      return endpoints.length === 0 || endpoints.some((endpoint) => !isInactiveEndpoint(snapshot, endpoint));
    })
    .map((agent) => buildMobileAgentSummary(snapshot, agent))
    .sort((left, right) => (right.lastActiveAt ?? 0) - (left.lastActiveAt ?? 0) || left.title.localeCompare(right.title));

  return {
    agents,
    sessions: buildMobileSessionSummaries(snapshot),
  };
}

function matchesWorkspace(workspace: ScoutMobileWorkspaceSummary, query: string): boolean {
  return [
    workspace.title,
    workspace.projectName,
    workspace.root,
    workspace.relativePath,
    workspace.defaultHarness,
  ].some((value) => value.toLowerCase().includes(query));
}

function matchesAgent(agent: ScoutMobileAgentSummary, query: string): boolean {
  return [
    agent.title,
    agent.id,
    agent.selector ?? "",
    agent.defaultSelector ?? "",
    agent.workspaceRoot ?? "",
    agent.harness ?? "",
  ].some((value) => value.toLowerCase().includes(query));
}

function matchesSession(session: ScoutMobileSessionSummary, query: string): boolean {
  return [
    session.title,
    session.id,
    session.agentName ?? "",
    session.workspaceRoot ?? "",
    session.preview ?? "",
  ].some((value) => value.toLowerCase().includes(query));
}

export async function getScoutMobileHome(input: {
  currentDirectory?: string;
  workspaceLimit?: number;
  agentLimit?: number;
  sessionLimit?: number;
} = {}): Promise<ScoutMobileHomeState> {
  const [workspaces, relay] = await Promise.all([
    loadMobileWorkspaceInventory(input.currentDirectory),
    loadMobileRelayState(),
  ]);

  const workspaceLimit = input.workspaceLimit ?? 6;
  const agentLimit = input.agentLimit ?? 6;
  const sessionLimit = input.sessionLimit ?? 6;

  return {
    workspaces: workspaces.slice(0, workspaceLimit),
    agents: relay.agents.slice(0, agentLimit),
    sessions: relay.sessions.slice(0, sessionLimit),
    totals: {
      workspaces: workspaces.length,
      agents: relay.agents.length,
      sessions: relay.sessions.length,
    },
  };
}

export async function getScoutMobileWorkspaces(
  filters: ScoutMobileListFilters = {},
  currentDirectory?: string,
): Promise<ScoutMobileWorkspaceSummary[]> {
  const workspaces = await loadMobileWorkspaceInventory(currentDirectory);
  return withQueryAndLimit(workspaces, filters, matchesWorkspace);
}

export async function getScoutMobileAgents(
  filters: ScoutMobileListFilters = {},
  currentDirectory?: string,
): Promise<ScoutMobileAgentSummary[]> {
  void currentDirectory;
  const relay = await loadMobileRelayState();
  return withQueryAndLimit(relay.agents, filters, matchesAgent);
}

export async function getScoutMobileSessions(
  filters: ScoutMobileListFilters = {},
  currentDirectory?: string,
): Promise<ScoutMobileSessionSummary[]> {
  void currentDirectory;
  const relay = await loadMobileRelayState();
  return withQueryAndLimit(relay.sessions, filters, matchesSession);
}

export async function getScoutFleet(
  options?: Parameters<typeof queryFleet>[0],
): Promise<ReturnType<typeof queryFleet>> {
  return queryFleet(options);
}

/**
 * Resolve whatever id the phone routed with onto a real broker conversation.
 * The phone may send a conversation id directly (`c.…` from the activity feed, or
 * a `dm.…` direct id) or a bare agent id (from the Agents tab). Not every agent
 * has an `operator` DM — many only have ask/consult conversations keyed `c.…` —
 * so when there's no direct hit and no `dm.operator.{agentId}`, fall back to the
 * most-recent conversation the agent actually participates in.
 */
function resolveMobileConversation(
  snapshot: ScoutBrokerSnapshot,
  rawId: string,
): ScoutBrokerConversationRecord | null {
  const direct = snapshot.conversations[rawId];
  if (direct) return direct;

  const operatorDm = snapshot.conversations[`dm.operator.${rawId}`];
  if (operatorDm) return operatorDm;

  const participating = Object.values(snapshot.conversations).filter(
    (conversation) => conversation.participantIds?.includes(rawId),
  );
  if (participating.length === 0) return null;

  const lastActivityMs = (conversationId: string): number =>
    Object.values(snapshot.messages).reduce((latest, message) => {
      if (message.conversationId !== conversationId) return latest;
      return Math.max(latest, normalizeTimestampMs(message.createdAt) ?? 0);
    }, 0);

  return participating
    .slice()
    .sort((a, b) => lastActivityMs(b.id) - lastActivityMs(a.id))[0] ?? null;
}

export async function getScoutMobileSessionSnapshot(
  conversationId: string,
  options: {
    beforeTurnId?: string | null;
    limit?: number | null;
  } = {},
  currentDirectory?: string,
): Promise<ScoutMobileSessionSnapshot> {
  void currentDirectory;
  const broker = await requireMobileRelayContext();
  const { snapshot } = broker;
  const conversation = resolveMobileConversation(snapshot, conversationId);

  // The conversation may not exist yet — the iOS app navigates to
  // dm.operator.{agentId} before any messages are sent.  Return an
  // empty session instead of throwing so the UI can render the chat
  // composer.
  if (!conversation) {
    const inferredAgentId = conversationId.startsWith("dm.operator.")
      ? conversationId.slice("dm.operator.".length)
      : null;
    const agent = inferredAgentId ? snapshot.agents[inferredAgentId] : null;
    const endpoint = inferredAgentId ? endpointForAgent(snapshot, inferredAgentId) : null;
    const agentName = agent
      ? agentDisplayName(snapshot, inferredAgentId!)
      : inferredAgentId ?? conversationId;
    return {
      session: {
        id: conversationId,
        name: agentName,
        adapterType: endpoint?.harness ?? "relay",
        status: endpoint?.state === "offline" ? "idle" : "active",
        cwd: endpoint?.projectRoot ?? endpoint?.cwd ?? null,
        model: typeof endpoint?.metadata?.model === "string" ? endpoint.metadata.model : null,
        providerMeta: {
          conversationId,
          conversationKind: "direct",
          agentId: inferredAgentId,
          workspaceRoot: endpoint?.projectRoot ?? endpoint?.cwd ?? null,
          harness: endpoint?.harness ?? null,
          selector: agent?.selector ?? null,
          defaultSelector: agent?.defaultSelector ?? null,
          project: agentName,
          currentBranch:
            metadataString(endpoint?.metadata, "branch")
            ?? metadataString(endpoint?.metadata, "workspaceQualifier")
            ?? metadataString(agent?.metadata, "branch")
            ?? metadataString(agent?.metadata, "workspaceQualifier"),
          workspaceQualifier:
            metadataString(endpoint?.metadata, "workspaceQualifier")
            ?? metadataString(agent?.metadata, "workspaceQualifier"),
        },
      },
      history: { hasOlder: false, oldestTurnId: null, newestTurnId: null },
      turns: [],
      currentTurnId: null,
    };
  }

  const directAgentId = conversation.kind === "direct"
    ? conversation.participantIds.find((participantId) => participantId !== "operator") ?? null
    : null;
  const endpoint = directAgentId ? endpointForAgent(snapshot, directAgentId) : null;
  const agent = directAgentId ? snapshot.agents[directAgentId] : null;
  const messagePage = pageMessagesForConversation(snapshot, conversation.id, options);
  const messages = messagePage.messages;
  const title = mobileConversationTitle(snapshot, conversation, directAgentId);
  const activeFlight = latestActiveFlightForAgent(snapshot, directAgentId);
  const lastAgentMessageAt = messages
    .filter((message) => message.actorId === directAgentId)
    .reduce<number | null>((latest, message) => {
      const createdAt = normalizeTimestampMs(message.createdAt);
      return typeof createdAt === "number" && (!latest || createdAt > latest) ? createdAt : latest;
    }, null);
  const shouldShowWorkingTurn = Boolean(
    activeFlight
    && ((normalizeTimestampMs(activeFlight.startedAt) ?? 0) > (lastAgentMessageAt ?? 0)),
  );

  const turns: ScoutMobileSessionSnapshot["turns"] = messages.map((message) => ({
    id: message.id,
    status: "completed",
    blocks: [{
      block: {
        id: `${message.id}:body`,
        turnId: message.id,
        type: message.class === "system" ? "reasoning" : "text",
        status: "completed",
        index: 0,
        text: message.body,
      },
      status: "completed",
    }, ...((message.attachments ?? []).map((attachment, index) => ({
      block: {
        id: `${message.id}:attachment:${attachment.id}`,
        turnId: message.id,
        type: "file" as const,
        status: "completed" as const,
        index: index + 1,
        mimeType: attachment.mediaType,
        name: attachment.fileName ?? attachment.url ?? attachment.id,
        url: attachment.url,
      },
      status: "completed" as const,
    })))],
    startedAt: normalizeTimestampMs(message.createdAt) ?? Date.now(),
    endedAt: normalizeTimestampMs(message.createdAt) ?? Date.now(),
    isUserTurn: message.actorId === "operator",
    clientMessageId: metadataString(message.metadata, "clientMessageId"),
  }));

  if (!options.beforeTurnId && shouldShowWorkingTurn && activeFlight) {
    turns.push({
      id: `flight:${activeFlight.id}`,
      status: "streaming",
      blocks: [{
        block: {
          id: `flight:${activeFlight.id}:status`,
          turnId: `flight:${activeFlight.id}`,
          type: "reasoning",
          status: "streaming",
          index: 0,
          text: activeFlight.summary?.trim() || "Working…",
        },
        status: "streaming",
      }],
      startedAt: normalizeTimestampMs(activeFlight.startedAt) ?? Date.now(),
      isUserTurn: false,
    });
  }

  return {
    session: {
      id: conversation.id,
      name: title,
      adapterType: endpoint?.harness ?? "relay",
      status: shouldShowWorkingTurn ? "active" : endpoint?.state === "offline" ? "idle" : "active",
      cwd: endpoint?.projectRoot ?? endpoint?.cwd ?? null,
      model: typeof endpoint?.metadata?.model === "string" ? endpoint.metadata.model : null,
      providerMeta: {
        conversationId: conversation.id,
        conversationKind: conversation.kind,
        agentId: directAgentId,
        workspaceRoot: endpoint?.projectRoot ?? endpoint?.cwd ?? null,
        harness: endpoint?.harness ?? null,
        selector: agent?.selector ?? null,
        defaultSelector: agent?.defaultSelector ?? null,
        project: directAgentId ? agentDisplayName(snapshot, directAgentId) : title,
        currentBranch:
          metadataString(endpoint?.metadata, "branch")
          ?? metadataString(endpoint?.metadata, "workspaceQualifier")
          ?? metadataString(agent?.metadata, "branch")
          ?? metadataString(agent?.metadata, "workspaceQualifier"),
        workspaceQualifier:
          metadataString(endpoint?.metadata, "workspaceQualifier")
          ?? metadataString(agent?.metadata, "workspaceQualifier"),
      },
    },
    history: {
      hasOlder: messagePage.hasOlder,
      oldestTurnId: messagePage.oldestTurnId,
      newestTurnId: messagePage.newestTurnId,
    },
    turns,
    currentTurnId: shouldShowWorkingTurn && activeFlight ? `flight:${activeFlight.id}` : null,
  };
}

export async function createScoutSession(
  input: CreateScoutSessionInput,
  currentDirectory?: string,
  deviceId?: string,
): Promise<ScoutMobileSessionHandle> {
  // The mobile client passes a projectRoot path as workspaceId. Valid current
  // directories stay on the hot path; missing/legacy paths take the guarded
  // inventory fallback before we construct the minimal downstream summary.
  const rawWorkspaceId = input.workspaceId?.trim();
  if (!rawWorkspaceId) {
    throw new Error(`Invalid workspaceId.`);
  }
  const workspaceRoot = await resolveMobileWorkspaceRoot(rawWorkspaceId, currentDirectory);
  const projectName = basename(workspaceRoot) || workspaceRoot;
  const workspace: ScoutMobileWorkspaceSummary = {
    id: workspaceRoot,
    title: projectName,
    projectName,
    root: workspaceRoot,
    sourceRoot: workspaceRoot,
    relativePath: workspaceRoot.replace(`${process.env.HOME ?? ""}/`, ""),
    registrationKind: "configured",
    defaultHarness: input.harness ?? "claude",
    harnesses: [],
  };

  // When forceNew is true, generate a unique agent name so it gets
  // a fresh agent ID and conversation (the broker derives conversation ID
  // deterministically from the agent ID).
  const agentName = input.forceNew
    ? await deriveNewAgentName(workspace.projectName, input.branch, input.harness)
    : workspace.projectName;

  // If worktree requested, create a git worktree so the agent works in isolation.
  let agentCwd = workspace.root;
  let worktreeCreated = false;
  if (input.worktree) {
    const worktreeResult = await createGitWorktree(workspace.root, agentName, input.branch);
    if (worktreeResult) {
      agentCwd = worktreeResult.path;
      worktreeCreated = true;
    }
  }

  // projectPath = original root (for agent config resolution)
  // cwdOverride = worktree path (agent works here instead of project root)
  const localAgent = await upScoutAgent({
    projectPath: workspace.root,
    agentName,
    harness: input.harness,
    currentDirectory: currentDirectory ?? workspace.root,
    cwdOverride: agentCwd !== workspace.root ? agentCwd : undefined,
    model: input.model,
    permissionProfile: input.profile?.trim() || undefined,
    branch: input.branch,
  });

  const broker = await loadScoutBrokerContext();
  const bindingSync = await registerScoutLocalAgentBinding({
    agentId: localAgent.agentId,
    broker,
  });
  const resolvedAgentId = bindingSync?.binding.agent.id ?? localAgent.agentId;

  const directSession = await openScoutPeerSession({
    sourceId: "operator",
    targetId: resolvedAgentId,
    currentDirectory: currentDirectory ?? workspace.root,
  });

  const snapshot = broker?.snapshot;
  const targetAgentId = directSession.targetId;
  const brokerAgent = snapshot?.agents[targetAgentId] ?? null;
  const brokerEndpoint = snapshot ? endpointForAgent(snapshot, targetAgentId) : null;
  const agentTitle = brokerAgent && snapshot
    ? agentDisplayName(snapshot, brokerAgent.id)
    : localAgent.projectName;

  const agentSummary: ScoutMobileAgentSummary = {
    id: targetAgentId,
    title: agentTitle,
    selector: brokerAgent?.selector ?? null,
    defaultSelector: brokerAgent?.defaultSelector ?? null,
    nodeId: brokerEndpoint?.nodeId ?? brokerAgent?.authorityNodeId ?? brokerAgent?.homeNodeId ?? null,
    nodeName: snapshot
      ? (brokerEndpoint?.nodeId ? snapshot.nodes[brokerEndpoint.nodeId]?.name : null)
        ?? (brokerAgent?.authorityNodeId ? snapshot.nodes[brokerAgent.authorityNodeId]?.name : null)
        ?? (brokerAgent?.homeNodeId ? snapshot.nodes[brokerAgent.homeNodeId]?.name : null)
        ?? null
      : null,
    workspaceRoot: brokerEndpoint?.projectRoot ?? brokerEndpoint?.cwd ?? workspace.root,
    harness: brokerEndpoint?.harness ?? localAgent.harness,
    transport: localAgent.transport,
    state: brokerEndpoint?.state === "offline" ? "offline" : "available",
    statusLabel: brokerEndpoint?.state === "offline" ? "Offline" : "Available",
    sessionId: localAgent.sessionId,
    lastActiveAt: null,
  };

  const seedInstructions = input.seed?.instructions?.trim() ?? "";
  const seedAttachments = input.seed?.attachments;
  const seedDelivery = seedInstructions || seedAttachments?.length
    ? await sendScoutDirectMessage({
        agentId: targetAgentId,
        body: seedInstructions,
        attachments: seedAttachments,
        currentDirectory: currentDirectory ?? workspace.root,
        executionHarness: input.harness,
        source: "scout-mobile",
        deviceId,
      })
    : null;

  return {
    workspace,
    agent: agentSummary,
    session: {
      conversationId: seedDelivery?.conversationId ?? directSession.conversation.id,
      title: agentTitle,
      existed: directSession.existed,
    },
    messageId: seedDelivery?.messageId ?? null,
    flightId: seedDelivery?.flight?.id ?? null,
    unsupported: [
      ...(input.worktree && !worktreeCreated ? ["worktree" as const] : []),
    ],
  };
}

export async function sendScoutMobileMessage(
  input: SendScoutMobileMessageInput,
  currentDirectory?: string,
  deviceId?: string,
): Promise<ScoutDirectMessageResult> {
  if (input.agentId === SCOUTBOT_AGENT_ID) {
    return sendScoutbotMobileThreadMessage(input, currentDirectory, deviceId);
  }

  return sendScoutDirectMessage({
    agentId: input.agentId,
    body: input.body,
    attachments: input.attachments,
    currentDirectory,
    clientMessageId: input.clientMessageId,
    replyToMessageId: input.replyToMessageId,
    referenceMessageIds: input.referenceMessageIds,
    executionHarness: input.harness,
    source: input.source ?? "scout-mobile",
    deviceId,
  });
}

async function sendScoutbotMobileThreadMessage(
  input: SendScoutMobileMessageInput,
  currentDirectory?: string,
  deviceId?: string,
): Promise<ScoutDirectMessageResult> {
  void currentDirectory;
  const broker = await loadScoutBrokerContext();
  if (!broker) {
    throw new Error("Scoutbot is not available.");
  }

  const conversationId = broker.snapshot.conversations[SCOUTBOT_LEGACY_CONVERSATION_ID]
    ? SCOUTBOT_LEGACY_CONVERSATION_ID
    : SCOUTBOT_DEFAULT_CONVERSATION_ID;
  const conversation = broker.snapshot.conversations[conversationId] ?? {
    id: conversationId,
    kind: "direct",
    title: conversationId === SCOUTBOT_LEGACY_CONVERSATION_ID ? "Scout" : "Scout · default",
    visibility: "private",
    shareMode: "local",
    authorityNodeId: broker.node.id,
    participantIds: ["operator", SCOUTBOT_AGENT_ID].sort(),
    metadata: {
      surface: "scoutbot",
      scoutbotThreadId: SCOUTBOT_DEFAULT_THREAD_ID,
    },
  };
  if (!broker.snapshot.conversations[conversationId]) {
    await postMobileBrokerJson(broker.baseUrl, "/v1/conversations", conversation);
  }

  const now = Date.now();
  const messageId = createMobileBrokerEntityId("msg", now);
  const transportSessionId = scoutbotTransportSessionId(broker.snapshot);
  await postMobileBrokerJson(broker.baseUrl, "/v1/messages", {
    id: messageId,
    conversationId,
    actorId: "operator",
    originNodeId: broker.node.id,
    class: "agent",
    body: input.body.trim(),
    attachments: normalizeOutgoingAttachments(input.attachments),
    replyToMessageId: input.replyToMessageId ?? undefined,
    mentions: [{ actorId: SCOUTBOT_AGENT_ID, label: "@scoutbot" }],
    audience: { notify: [SCOUTBOT_AGENT_ID], reason: "direct_message" },
    visibility: "private",
    policy: "durable",
    createdAt: now,
    metadata: {
      source: input.source ?? "scout-mobile",
      destinationKind: "scoutbot_thread",
      destinationId: SCOUTBOT_DEFAULT_THREAD_ID,
      scoutbotThreadId: SCOUTBOT_DEFAULT_THREAD_ID,
      ...(transportSessionId ? { targetSessionId: transportSessionId } : {}),
      referenceMessageIds: input.referenceMessageIds ?? [],
      clientMessageId: input.clientMessageId ?? null,
      ...(deviceId ? { deviceId } : {}),
      relayMessageId: messageId,
      returnAddress: {
        actorId: "operator",
        conversationId,
        replyToMessageId: messageId,
        ...(transportSessionId ? { sessionId: transportSessionId } : {}),
      },
    },
  });

  return {
    conversationId,
    messageId,
  };
}

function scoutbotTransportSessionId(snapshot: ScoutBrokerSnapshot): string | null {
  const endpoint = Object.values(snapshot.endpoints ?? {}).find((candidate) => (
    candidate.agentId === SCOUTBOT_AGENT_ID
      && candidate.transport === "codex_app_server"
      && !isInactiveEndpoint(snapshot, candidate)
  ));
  if (!endpoint) return null;
  return metadataString(endpoint.metadata, "threadId")
    ?? metadataString(endpoint.metadata, "externalSessionId")
    ?? endpoint.sessionId?.trim()
    ?? null;
}

async function postMobileBrokerJson<T>(
  baseUrl: string,
  path: string,
  body: unknown,
): Promise<T> {
  const response = await fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Broker ${path} failed (${response.status}): ${text || response.statusText}`);
  }
  return await response.json() as T;
}

function createMobileBrokerEntityId(prefix: string, createdAtMs: number): string {
  return `${prefix}-${createdAtMs.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Mint a collision-free provisional agent name from the curated rotation pool. */
async function deriveNewAgentName(
  projectName: string,
  branch?: string,
  harness?: string,
): Promise<string> {
  const broker = await loadScoutBrokerContext();
  const occupied = broker
    ? collectOccupiedDefinitionIdsFromBrokerSnapshot(broker.snapshot)
    : new Set<string>();
  return resolveProjectProvisionalAgentName({
    occupied,
    seedParts: [
      "mobile-new-project-agent",
      projectName,
      branch ?? "",
      harness ?? "",
    ],
  });
}

/**
 * Create an isolated git worktree for an agent session.
 *
 * Delegates to the shared runtime helper (createAgentWorkspace), which
 * materializes a `git worktree` on branch `scout/<agentName>` under
 * `<projectRoot>/.scout-worktrees/<agentName>`. Kept as a thin wrapper so
 * callers retain the historical `createGitWorktree` name and `{ path, branch }`
 * shape.
 *
 * Returns the worktree path + branch, or null if the project isn't a git repo.
 */
async function createGitWorktree(
  projectRoot: string,
  agentName: string,
  requestedBranch?: string,
): Promise<{ path: string; branch: string } | null> {
  const result = await createAgentWorkspace(projectRoot, agentName, requestedBranch);
  if (!result) return null;
  return { path: result.path, branch: result.branch };
}

async function requireMobileRelayContext() {
  const broker = await loadScoutBrokerContext();
  if (!broker) {
    throw new Error("Relay is not reachable.");
  }
  return broker;
}

// -- Activity Feed --------------------------------------------------------

export type ScoutMobileActivityFilters = {
  agentId?: string;
  actorId?: string;
  conversationId?: string;
  limit?: number;
};

export async function getScoutMobileActivity(
  filters: ScoutMobileActivityFilters = {},
): Promise<ScoutBrokerHomeActivityRecord[]> {
  // Home is an orientation surface: show the actual recent exchanges Scout
  // mediated, not the raw `/v1/activity` lifecycle firehose. Reading the broker
  // message ledger directly also avoids depending on the optional home activity
  // projection, which may legitimately be empty after a broker restart.
  const broker = await loadScoutBrokerContext();
  if (!broker) {
    const home = await readScoutBrokerHome();
    // The home projection predates harness attribution; be explicit that this
    // path carries none rather than leaking `undefined` onto the wire.
    return (home?.activity ?? [])
      .slice(0, filters.limit ?? 100)
      .map((record) => ({ ...record, harness: record.harness ?? null }));
  }

  const { snapshot } = broker;
  const selfIds = operatorActorIds();
  const mediatedKinds = new Set(["channel", "direct", "group_direct", "thread"]);
  const rows = Object.values(snapshot.messages ?? {})
    .filter((message) => {
      const conversation = snapshot.conversations?.[message.conversationId];
      if (!conversation || !mediatedKinds.has(conversation.kind)) return false;
      if (filters.agentId && message.actorId !== filters.agentId) return false;
      if (filters.actorId && message.actorId !== filters.actorId) return false;
      if (filters.conversationId && message.conversationId !== filters.conversationId) return false;
      return true;
    })
    .sort((left, right) => requireTimestampMs(right.createdAt) - requireTimestampMs(left.createdAt))
    .map((message): ScoutBrokerHomeActivityRecord => {
      const conversation = snapshot.conversations[message.conversationId]!;
      const actorName = commsActorLabel(snapshot, message.actorId, selfIds);
      const channel = conversation.kind === "channel"
        ? channelNaturalKeyFromMetadata(conversation.metadata) ?? conversation.title ?? null
        : null;
      return {
        id: message.id,
        kind: message.class === "status" || message.actorId === "system" ? "system" : "message",
        actorId: message.actorId,
        actorName,
        title: actorName,
        detail: message.body,
        conversationId: message.conversationId,
        channel,
        timestamp: requireTimestampMs(message.createdAt),
        harness: harnessForActor(snapshot, message.actorId),
      };
    });

  const limit = filters.limit && filters.limit > 0 ? Math.floor(filters.limit) : 100;
  return rows.slice(0, limit);
}

// The transitional desktop bridge does not own the web server's service-budget
// and terminal-session read models. Keep its wire surface compatible while the
// canonical packages/web server supplies the live records.
export async function getScoutMobileServiceBudgets(): Promise<{ budgets: never[] }> {
  return { budgets: [] };
}

export async function getScoutMobileTerminals(): Promise<{ terminals: never[] }> {
  return { terminals: [] };
}

// -- Comms (channels + DMs) ----------------------------------------------
//
// The phone's mesh-comms surface. Reads channels/DMs straight from the broker
// snapshot (conversations + messages + actors, all in memory) and flattens them
// for the phone — participants and authors pre-resolved to display labels so the
// client never joins against the actor table. Posting routes by conversation
// kind: channels via `sendScoutMessage`, DMs via the existing direct-message path.

const MOBILE_OPERATOR_ID = "operator";

/// Actor ids that represent "you" (the phone operator): the canonical "operator"
/// plus the configured operator name/handle. Older DMs and read cursors can be
/// authored under the configured identity (e.g. "dm.arach.hudson…" by "arach"),
/// so a single hard-coded id would mislabel the counterpart and miscount unread.
function operatorActorIds(): Set<string> {
  const ids = new Set<string>([MOBILE_OPERATOR_ID]);
  const name = resolveOperatorName().trim();
  if (name) {
    ids.add(name);
    ids.add(name.toLowerCase());
  }
  return ids;
}

export type ScoutMobileCommsConversation = {
  id: string;
  kind: "channel" | "direct" | "group" | "thread" | "system" | "unknown";
  title: string;
  participants: string[];
  topic: string | null;
  lastMessagePreview: string | null;
  lastMessageAuthor: string | null;
  lastMessageAt: number | null;
  messageCount: number;
  unreadCount: number;
};

export type ScoutMobileCommsMessage = {
  id: string;
  conversationId: string;
  actorId: string;
  authorLabel: string;
  authorKind: "person" | "agent" | "system";
  body: string;
  createdAt: number;
  replyToMessageId: string | null;
  isOperator: boolean;
  clientMessageId: string | null;
  attachments: Array<{
    id: string;
    mediaType: string;
    fileName?: string;
    blobKey?: string;
    url?: string;
  }>;
};

function commsActorLabel(
  snapshot: ScoutBrokerSnapshot,
  actorId: string,
  selfIds: Set<string>,
): string {
  if (selfIds.has(actorId)) return "You";
  return snapshot.agents[actorId]?.displayName
    ?? snapshot.actors[actorId]?.displayName
    ?? actorId;
}

function commsAuthorKind(
  snapshot: ScoutBrokerSnapshot,
  actorId: string,
  selfIds: Set<string>,
): "person" | "agent" | "system" {
  if (selfIds.has(actorId)) return "person";
  if (snapshot.agents[actorId]) return "agent";
  const kind = snapshot.actors[actorId]?.kind;
  if (kind === "person") return "person";
  if (kind === "agent") return "agent";
  return "system";
}

function commsMobileKind(kind: string): ScoutMobileCommsConversation["kind"] {
  switch (kind) {
    case "channel": return "channel";
    case "direct": return "direct";
    case "group_direct": return "group";
    case "thread": return "thread";
    case "system": return "system";
    default: return "unknown";
  }
}

export async function getScoutMobileConversations(
  filters: { kind?: string; limit?: number } = {},
): Promise<ScoutMobileCommsConversation[]> {
  const broker = await loadScoutBrokerContext();
  if (!broker) return [];
  const { snapshot } = broker;
  const selfIds = operatorActorIds();

  const byConversation = new Map<string, MessageRecord[]>();
  for (const message of Object.values(snapshot.messages ?? {})) {
    const bucket = byConversation.get(message.conversationId);
    if (bucket) bucket.push(message);
    else byConversation.set(message.conversationId, [message]);
  }

  const operatorReadAt = new Map<string, number>();
  for (const cursor of Object.values(snapshot.readCursors ?? {})) {
    if (selfIds.has(cursor.actorId)) {
      const prev = operatorReadAt.get(cursor.conversationId) ?? 0;
      operatorReadAt.set(cursor.conversationId, Math.max(prev, cursor.lastReadAt ?? 0));
    }
  }

  const includeKinds = new Set(["channel", "direct", "group_direct", "thread"]);
  const rows: ScoutMobileCommsConversation[] = [];
  for (const conv of Object.values(snapshot.conversations ?? {})) {
    if (!includeKinds.has(conv.kind)) continue;
    const mobileKind = commsMobileKind(conv.kind);
    if (filters.kind && filters.kind !== mobileKind) continue;

    const messages = (byConversation.get(conv.id) ?? []).sort((a, b) => a.createdAt - b.createdAt);
    const last = messages[messages.length - 1];
    const readAt = operatorReadAt.get(conv.id);
    const unread = readAt != null
      ? messages.filter((m) => m.createdAt > readAt && !selfIds.has(m.actorId)).length
      : 0;
    const directAgentId = conv.kind === "direct"
      ? conv.participantIds.find((participantId) => !selfIds.has(participantId)) ?? null
      : null;

    rows.push({
      id: conv.id,
      kind: mobileKind,
      title: mobileConversationTitle(snapshot, conv, directAgentId),
      participants: conv.participantIds
        .filter((p) => !selfIds.has(p))
        .map((p) => commsActorLabel(snapshot, p, selfIds)),
      topic: conv.topic ?? null,
      lastMessagePreview: last ? last.body.replace(/\s+/g, " ").trim().slice(0, 140) : null,
      lastMessageAuthor: last ? commsActorLabel(snapshot, last.actorId, selfIds) : null,
      lastMessageAt: last ? last.createdAt : null,
      messageCount: messages.length,
      unreadCount: unread,
    });
  }

  rows.sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));
  const limit = filters.limit && filters.limit > 0 ? filters.limit : 100;
  return rows.slice(0, limit);
}

export async function getScoutMobileConversationMessages(
  conversationId: string,
  limit = 200,
): Promise<ScoutMobileCommsMessage[]> {
  const broker = await loadScoutBrokerContext();
  if (!broker) return [];
  const { snapshot } = broker;
  const selfIds = operatorActorIds();

  const messages = Object.values(snapshot.messages ?? {})
    .filter((m) => m.conversationId === conversationId)
    .sort((a, b) => a.createdAt - b.createdAt);
  const trimmed = limit > 0 && messages.length > limit
    ? messages.slice(messages.length - limit)
    : messages;

  return trimmed.map((m) => ({
    id: m.id,
    conversationId: m.conversationId,
    actorId: m.actorId,
    authorLabel: commsActorLabel(snapshot, m.actorId, selfIds),
    authorKind: commsAuthorKind(snapshot, m.actorId, selfIds),
    body: m.body,
    createdAt: m.createdAt,
    replyToMessageId: m.replyToMessageId ?? null,
    isOperator: selfIds.has(m.actorId),
    clientMessageId: metadataString(m.metadata, "clientMessageId"),
    attachments: (m.attachments ?? []).map((attachment) => ({
      id: attachment.id,
      mediaType: attachment.mediaType,
      ...(attachment.fileName ? { fileName: attachment.fileName } : {}),
      ...(attachment.blobKey ? { blobKey: attachment.blobKey } : {}),
      ...(attachment.url ? { url: attachment.url } : {}),
    })),
  }));
}

export async function sendScoutMobileComms(
  input: {
    conversationId: string;
    body: string;
    attachments?: OutgoingAttachmentInput[];
    replyToMessageId?: string | null;
    clientMessageId?: string | null;
  },
  currentDirectory?: string,
  deviceId?: string,
): Promise<ScoutMobileSendResult> {
  const broker = await loadScoutBrokerContext();
  if (!broker) throw new Error("Relay is not reachable.");
  const conv = broker.snapshot.conversations?.[input.conversationId];
  if (!conv) throw new Error(`Unknown conversation: ${input.conversationId}`);
  const selfIds = operatorActorIds();

  // 1:1 DMs route through the direct-message path, addressed to the single
  // non-self participant (it resolves to this same conversation).
  if (conv.kind === "direct") {
    const targetAgentId = conv.participantIds.find((p) => !selfIds.has(p));
    if (!targetAgentId) throw new Error("Conversation has no agent participant to address.");
    const result = await sendScoutMobileMessage(
      {
        agentId: targetAgentId,
        body: input.body,
        attachments: input.attachments,
        clientMessageId: input.clientMessageId,
        replyToMessageId: input.replyToMessageId,
      },
      currentDirectory,
      deviceId,
    );
    return mobileSendResultFromDirect(result);
  }

  // Groups and threads must post to THIS conversation — collapsing to a 1:1 DM
  // with the first participant would land the message in the wrong room. This
  // broker exposes a reply primitive, so anchor to the conversation's latest
  // message (or its origin message id for an empty thread).
  if (conv.kind === "group_direct" || conv.kind === "thread") {
    const convMessages = Object.values(broker.snapshot.messages ?? {})
      .filter((m) => m.conversationId === input.conversationId)
      .sort((a, b) => a.createdAt - b.createdAt);
    const anchor = input.replyToMessageId
      ?? convMessages[convMessages.length - 1]?.id
      ?? conv.messageId;
    if (!anchor) {
      throw new Error("Cannot post to an empty group/thread without a reply anchor.");
    }
    const result = await replyToScoutMessage({
      senderId: MOBILE_OPERATOR_ID,
      body: input.body,
      attachments: input.attachments,
      conversationId: input.conversationId,
      replyToMessageId: anchor,
      clientMessageId: input.clientMessageId,
      source: "scout-mobile",
      currentDirectory,
    });
    return {
      conversationId: result.conversationId ?? input.conversationId,
      messageId: result.messageId ?? `local-${Date.now().toString(36)}`,
      flightId: null,
      invocationId: null,
      targetAgentId: null,
      lifecycleState: null,
      summary: null,
      error: null,
    };
  }

  // Channels: post as the operator to the channel name (channel.<name> → <name>).
  const channel = input.conversationId.startsWith("channel.")
    ? input.conversationId.slice("channel.".length)
    : conv.title;
  const result = await sendScoutMessage({
    senderId: MOBILE_OPERATOR_ID,
    body: input.body,
    attachments: input.attachments,
    channel,
    clientMessageId: input.clientMessageId,
    currentDirectory,
  });
  return {
    conversationId: result.conversationId ?? input.conversationId,
    messageId: result.messageId ?? `local-${Date.now().toString(36)}`,
    flightId: result.flight?.id ?? null,
    invocationId: result.flight?.invocationId ?? null,
    targetAgentId: result.flight?.targetAgentId ?? null,
    lifecycleState: mobileLifecycleStateForFlight(result.flight),
    summary: result.flight?.summary ?? null,
    error: result.flight?.error ?? null,
  };
}
