import { createReadStream, existsSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";

import { Hono, type Context } from "hono";
import {
  channelNaturalKeyFromMetadata,
  directChannelNaturalKey,
  epochMs,
  extractAgentSelectors,
  flightSessionTrace,
  isScoutRuntimeHarnessEnabled,
  parseScoutRuntimeCatalog,
  isOpaqueChannelId,
  reconcileTerminalWorkspace,
  resolveAgentIdentity,
  SCOUT_LAUNCHABLE_HARNESSES,
  SCOUT_RUNTIME_CATALOG,
  SCOUT_ROLE_CATALOG,
  scoutRuntimeDefaultHarness,
  scoutRuntimeDefaultModel,
  scoutRuntimeDefaultReasoningEffort,
  scoutRuntimeDefaultsByHarness,
  scoutRuntimeEffortCatalog,
  scoutRuntimeModelCatalog,
  type AgentEndpoint,
  type AgentHarness,
  type CollaborationEvent,
  type CollaborationKind,
  type ConversationDefinition,
  type ConversationKind,
  type ScoutRuntimeCapabilityCatalog,
  type ScoutOwnedRuntimeCatalog,
  type TerminalWorkspaceRecord,
  type TerminalWorkspaceRecordInput,
  type TerminalWorkspaceResolution,
  type WorkItemRecord,
} from "@openscout/protocol";
import {
  collectOccupiedDefinitionIdsFromBrokerSnapshot,
  resolveProjectProvisionalAgentName,
} from "@openscout/runtime";
import {
  webAppendMissionLog,
  webAssignRole,
  webListMissionLog,
  webListRoleAssignments,
  webRevokeRole,
} from "./db/assigned-roles.ts";

import {
  controlScoutWebPairingService,
  decideScoutWebPairingApproval,
  getScoutWebPairingState,
  getScoutWebPairingSessionSnapshots,
  refreshScoutWebPairingState,
  removeScoutPairingTrustedPeer,
  type ScoutPairingControlAction,
  type ScoutPairingState,
} from "./pairing.ts";
import {
  createPendingPairRequestStore,
  PairRequestCapacityError,
  pairRequesterDisplay,
  pairRequestStatePath,
  parseScoutPairClient,
  SCOUT_PAIR_CLIENT_HEADER,
  SCOUT_PAIR_RELAY_HEADER,
} from "./pairing-pair-requests.ts";
import { startScoutPairLanBeacon } from "./pairing-lan-beacon.ts";
import {
  coalesce,
  createCachedSnapshot,
  installScoutApiMiddleware,
  isLoopbackScoutAddress,
  isSameMacScoutRequest,
  isScoutWebRequestAllowedFromPeer,
  relayEventStream,
  registerScoutWebAssets,
  resolveScoutRequestPeerAddress,
  resolveScoutWebLanAccessScope,
  type ScoutWebAssetMode,
  type ScoutWebLanAccessScope,
} from "./server-core.ts";
import {
  endpointMetadataRecord,
  selectPreferredAgentEndpoint,
  type EndpointPreference,
} from "./core/agent-endpoints.ts";
import { resolveTerminalSurface } from "./core/terminal-surfaces.ts";
import { cachedRepoKeysByRoot } from "./core/repo-identity.ts";
import {
  queryDiscoveredTerminalSessions,
  reconcileTerminalSessionInventory,
  terminalSurfaceKey,
} from "./terminal-session-discovery.ts";
import {
  deleteTerminalWorkspace,
  queryTerminalWorkspace,
  queryTerminalWorkspaces,
  upsertTerminalWorkspace,
} from "./db/terminal-workspaces.ts";
import {
  describeTerminalHosts,
  isKnownTerminalHost,
  preferredTerminalHost,
  relayCarriedTerminalBackend,
  resolveTerminalHostAdapter,
  terminalHostAdapter,
  terminalHostSupportsControl,
} from "./terminal-hosts/index.ts";
import {
  getImageBlob,
  ImageBlobError,
  putImageBlob,
} from "./image-blob-store.ts";
import {
  queryAgentById,
  queryAgents,
  queryActivity,
  queryBrokerDiagnostics,
  queryConversationDefinitionById,
  queryFleet,
  queryFlightRecordById,
  queryFlights,
  queryRecentMessages,
  queryWorkItems,
  queryWorkItemById,
  querySessions,
  querySessionById,
  queryFollowTarget,
  queryHeartrate,
  queryRuns,
  queryTerminalSessions,
  type WebAgent,
  type WebFlight,
} from "./db-queries.ts";
import {
  brokerDiagnosticsNeedsFullSnapshot,
  markBrokerDiagnosticsLiveUnavailable,
  mergeBrokerDiagnosticsWithLiveSnapshot,
  type BrokerDiagnosticsSnapshot,
} from "./db/broker-live.ts";
import { queryAgentIdsByEndpointSessionId } from "./db/agents.ts";
import { queryOperatorAttentionRows } from "./db/fleet.ts";
import {
  queryMeshOpsActiveFlightCount,
  queryMeshOpsHosts,
  queryMeshOpsItems,
  queryMeshOpsSessions,
  queryMeshOpsWorkRecord,
} from "./db/mesh-ops.ts";
import {
  applyAgentAttention,
  buildAgentAttentionIndex,
  type AgentAttentionEntry,
} from "./core/attention/agent-attention.ts";
import {
  collectTmuxHostAttention,
  type TmuxHostAttentionItem,
} from "./core/attention/tmux-host-attention.ts";
import {
  configuredOperatorActorIds,
} from "./db/internal/conversation-ids.ts";
import {
  compact as compactPath,
  isTransportSessionRef,
  resolveHarnessSessionId,
  resolveHarnessSessionIdForAgent,
} from "./db/internal/paths.ts";
import {
  appendScoutCollaborationEvent,
  askScoutQuestion,
  loadScoutBrokerContext,
  loadScoutReadCursors,
  markScoutConversationRead,
  openScoutDirectSession,
  readScoutBrokerHome,
  readScoutBrokerHealth,
  readScoutConversationProjection,
  readScoutBrokerMessages,
  readScoutBrokerNodeId,
  readScoutBrokerSnapshot,
  resolveScoutBrokerUrl,
  type OutgoingAttachmentInput,
  type ScoutBrokerContext,
  type ScoutBrokerHomeAgentRecord,
  type ScoutBrokerHomePayload,
  sendScoutConversationMessage,
  sendScoutConversationSteer,
  sendScoutDirectMessage,
  sendScoutMessage,
  upsertScoutCollaborationRecord,
  upsertScoutConversation,
  upsertScoutFlight,
} from "./core/broker/service.ts";
import { scoutBrokerPaths } from "./core/broker/paths.ts";
import {
  getScoutConversationById,
  getScoutConversationMessages,
  getScoutConversations,
  provisionalScoutConversations,
} from "./core/conversations/service.ts";
import {
  loadAgentObservePayload,
  loadAgentObserveSummaries,
  loadSessionRefObservePayload,
} from "./core/observe/service.ts";
import {
  getTailDiscovery,
  refreshTailDiscovery,
  readRecentTranscriptEvents,
  snapshotRecentEvents,
  type DiscoverySnapshot,
  type DiscoveredTranscript,
  type TailDiscoveryScope,
  type TailEvent,
} from "@openscout/runtime/tail";
import {
  resolveOpenScoutKnowledgePaths,
  SQLiteKnowledgeStore,
  type KnowledgeCollectionKind,
  type KnowledgeFacets,
  type KnowledgeSourceRef,
} from "@openscout/runtime/knowledge";
import {
  projectSessionsAttention,
  sessionApprovalAttentionId,
  type RepoDiffSnapshotOptions,
  type ScoutRepoDiffSnapshot,
  type SessionAttentionItem,
} from "@openscout/runtime";
import { buildHarnessResumeCommand, findHarnessEntry, loadHarnessCatalogSnapshot } from "@openscout/runtime/harness-catalog";
import { currentMeshPeerNodeIds } from "@openscout/runtime/mesh-peer-filter";
import {
  loadRevealObservePayload,
  observedRevealPathSet,
  sessionTouchedResponse,
} from "./observe-payload.ts";
import {
  mountRepoDiffRoutes,
  type RepoPullRequestLoadOptions,
  type RepoPullRequestSnapshot,
} from "./routes/repo-diff.ts";
import {
  createScoutbotWebServices,
  mountScoutbotRoutes,
  type WebTailRuntime,
} from "./routes/scoutbot.ts";
import { mountScoutVoiceRoutes } from "./routes/voice.ts";
import { mountScoutDeckSurfaceRoutes } from "./routes/deck-surface.ts";
import {
  snapshotRecentBroadcasts,
  subscribeBroadcast,
} from "./core/broadcast/service.ts";
import {
  announceMeshVisibility,
  controlTailscale,
  joinMesh,
  leaveMesh,
  loadMeshStatus,
  type TailscaleControlAction,
} from "./core/mesh/service.ts";
import {
  loadOpenScoutWebShellState,
  type OpenScoutWebShellState,
} from "./runtime-summary.ts";
import type { ScoutbotCodexAssistantInvoker } from "./scoutbot-assistant.ts";
import {
  SCOUTBOT_AGENT_ID,
  SCOUTBOT_DEFAULT_THREAD_ID,
} from "./scoutbot/role.ts";
import { importProviderDashboardUsage, loadServiceBudgets } from "./service-budgets.ts";
import {
  buildWorkMaterialsInventory,
  readWorkMaterialContent,
  readWorkMaterialRaw,
} from "./work-materials.ts";
import { indexPlanDocuments } from "./plan-documents.ts";
import {
  defaultHeuristicsResponse,
  globalHeuristicsFile,
  projectHeuristicsFile,
  startGlobalHeuristicsWatcher,
  writeGlobalHeuristicsFile,
  writeProjectHeuristicsFile,
} from "./material-heuristics.ts";
import {
  captureTmuxPane,
  execSystemFile,
  gitBuildInfoProbe,
  readAllProcessCommandRows,
  readAllProcessRows,
  readHerdrTopology,
  readProcessCwd as readProcessCwdProbe,
  readProcessRowsForTty,
  readTmuxPaneDetail,
  type GitBuildInfo,
} from "@openscout/runtime/system-probes";
import {
  collectTrustedRoots,
  mediaTypeFor,
  readFilePreview,
  resolveTrustedPath,
} from "./file-preview.ts";
import {
  createSignedScoutServicesRestartUrl,
  parseScoutServicesRestartTarget,
} from "./scout-services-deeplink.ts";
import {
  loadUserConfig,
  loadUserConfigFresh,
  saveUserConfig,
  resolveOperatorName,
} from "@openscout/runtime/user-config";
import {
  applyProvisionalAgentNamesFromBody,
  provisionalAgentNamesApiFields,
} from "@openscout/runtime/provisional-agent-names";
import {
  localConfigHome,
  localConfigPath,
} from "@openscout/runtime/local-config";
import {
  loadResolvedRelayAgents,
  readOpenScoutSettings,
  writeOpenScoutSettings,
} from "@openscout/runtime/setup";
import {
  addOpenScoutWorkspaceRoot,
  ensureOpenScoutOnboardingCompletion,
  ensureOpenScoutOnboardingLocalConfig,
  loadOpenScoutOnboardingState,
  restartOpenScoutOnboarding,
  runOpenScoutOnboardingSetup,
  saveOpenScoutOnboardingIdentity,
  saveOpenScoutOnboardingProject,
  skipOpenScoutOnboarding,
} from "@openscout/runtime/onboarding";
import { relayAgentRuntimeDirectory, resolveOpenScoutSupportPaths } from "@openscout/runtime/support-paths";
import { readSessionCatalogSync } from "@openscout/runtime/claude-stream-json";
import { requestHarnessSessionCompaction } from "./session-compaction.ts";
import {
  pairingDeepLinks,
  SCOUT_PAIRING_DEEP_LINK_PATH,
  SCOUT_PAIRING_DEEP_LINK_SCHEME,
} from "../shared/pairing-link.js";
import {
  resolveOpenScoutWebRoutes,
  serializeOpenScoutWebBootstrap,
} from "../shared/runtime-config.js";
import {
  DEFAULT_MESSAGE_PAGE_LIMIT,
  MessageCursorError,
  clampMessagePageLimit,
  encodeMessageHistoryCursor,
  parseMessageHistoryCursor,
} from "../shared/message-pagination.ts";
import { parseSessionRouteRef, sessionHarnessMatches } from "../shared/session-route-ref.ts";

function parseConversationKinds(value: string | undefined): ConversationKind[] | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed
    .split(",")
    .map((kind) => kind.trim())
    .filter((kind): kind is ConversationKind => (
      kind === "direct"
      || kind === "channel"
      || kind === "group_direct"
      || kind === "thread"
      || kind === "system"
    ));
}

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
      .filter((candidate): candidate is string => typeof candidate === "string")
      .map((candidate) => candidate.trim())
      .filter(Boolean)
    : [];
}

function isHttpsWebRequest(c: Context, publicOrigin: string | undefined): boolean {
  const forwardedProto = c.req.header("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim()
    .toLowerCase();
  if (forwardedProto === "https") return true;

  try {
    if (new URL(c.req.url).protocol === "https:") return true;
  } catch {
    // Fall through to the configured public origin.
  }

  if (!publicOrigin) return false;
  try {
    return new URL(publicOrigin).protocol === "https:";
  } catch {
    return publicOrigin.trim().toLowerCase().startsWith("https://");
  }
}

function installHttpsEdgeSecurityHeaders(app: Hono, publicOrigin: string | undefined): void {
  app.use("*", async (c, next) => {
    await next();
    if (!isHttpsWebRequest(c, publicOrigin)) return;
    c.header("Content-Security-Policy", "upgrade-insecure-requests; block-all-mixed-content");
  });
}

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

export type { ScoutWebAssetMode } from "./server-core.ts";

export type TerminalRunRequest = {
  command: string;
  cwd?: string | null;
  agentId?: string | null;
};

export type TerminalRelayDestroyRequest = {
  sessionId?: string;
};

export type TerminalSurfaceControlRequest = {
  backend?: string;
  sessionName?: string;
  action?: string;
};

export type TmuxPanePeekRequest = {
  agentId: string;
  sessionId: string;
  paneTarget: string;
  cwd: string | null;
  lines: number;
  columns: number;
};

export type TmuxPanePeekCapture = {
  body: string;
  lineCount?: number;
  truncated?: boolean;
};

export type CreateOpenScoutWebServerOptions = {
  currentDirectory: string;
  shellStateCacheTtlMs?: number;
  assetMode: ScoutWebAssetMode;
  viteDevUrl?: string;
  staticRoot?: string;
  webPort?: number;
  publicOrigin?: string;
  portalHost?: string;
  advertisedHost?: string;
  trustedHosts?: string[];
  trustedOrigins?: string[];
  /** Required credential for privileged /api routes. Production hosts must set it. */
  authToken?: string;
  /** Socket peer resolver. Injectable for tests; Bun connection info is used in production. */
  resolvePeerAddress?: (c: Context) => string | undefined;
  /** Network exposure policy. Defaults to OPENSCOUT_WEB_LAN_SCOPE. */
  lanAccessScope?: ScoutWebLanAccessScope;
  runTerminalCommand?: (request: TerminalRunRequest) => Promise<void>;
  destroyTerminalRelaySession?: (sessionId: string) => Promise<boolean>;
  destroyTerminalRelaySurface?: (backend: "tmux" | "zellij" | "herdr", sessionName: string) => Promise<number>;
  terminalRelayHealthcheck?: () => Promise<boolean>;
  revealPath?: (targetPath: string) => Promise<void> | void;
  captureTmuxPane?: (request: TmuxPanePeekRequest) => Promise<TmuxPanePeekCapture | null> | TmuxPanePeekCapture | null;
  scoutbotAssistant?: {
    invokeCodex?: ScoutbotCodexAssistantInvoker;
  };
  scoutbot?: {
    enabled?: boolean;
    brokerBaseUrl?: string;
  };
  /** Run process-wide discovery/watch services. Embedded and test hosts can
   * disable these to avoid owning UDP beacons and filesystem watchers. */
  backgroundServices?: boolean;
  // Injectable for tests; defaults to the runtime native diff producer.
  repoDiffSnapshot?: (options: RepoDiffSnapshotOptions) => Promise<ScoutRepoDiffSnapshot>;
  repoPullRequests?: (options: RepoPullRequestLoadOptions) => Promise<RepoPullRequestSnapshot>;
  tailRuntime?: Partial<WebTailRuntime>;
};

function pairingQrValueWithWebPort(
  qrValue: string | null | undefined,
  webPort: number | undefined,
): string | undefined {
  const payload = typeof qrValue === "string" ? qrValue.trim() : "";
  if (!payload) return undefined;
  const normalizedWebPort = normalizePairingWebPort(webPort);
  if (normalizedWebPort === null) return qrValue ?? undefined;

  try {
    const parsed = JSON.parse(payload);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return qrValue ?? undefined;
    }
    return JSON.stringify({ ...parsed, webPort: normalizedWebPort });
  } catch {
    return qrValue ?? undefined;
  }
}

function normalizePairingWebPort(value: number | undefined): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65_535
    ? value
    : null;
}



export type OpenScoutWebServer = {
  app: Hono;
  warmupCaches: () => Promise<void>;
  stop: () => Promise<void>;
};

type OperatorAttentionItem = {
  id: string;
  kind: "approval" | "configuration" | "ask" | "work_item" | "question" | "session";
  title: string;
  summary: string | null;
  detail: string | null;
  agentId: string | null;
  agentName: string | null;
  conversationId: string | null;
  updatedAt: number;
  severity: "critical" | "warning" | "info";
  sourceLabel: string;
  approval?: ScoutPairingState["pendingApprovals"][number];
  actions: Array<{
    kind: "approve" | "deny" | "open" | "configure" | "copy" | "dismiss";
    label: string;
    route?: { view: string; [key: string]: string | undefined };
    value?: string;
    recordId?: string;
    recordKind?: CollaborationKind;
    flightId?: string;
  }>;
};

type OpenScoutBuildInfo = {
  version: string | null;
  branch: string | null;
  commit: string | null;
  dirty: boolean | null;
  mode: "dev" | "production";
  server: {
    engine: "bun" | "node";
    engineVersion: string;
    nodeVersion: string;
    platform: NodeJS.Platform;
    arch: string;
  };
};

function parseOptionalPositiveInt(
  value: string | undefined,
  fallback?: number,
): number | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseOptionalFiniteNumber(value: string | null | undefined): number | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const KNOWLEDGE_SEARCH_FACET_PARAMS = [
  "harness",
  "project",
  "source",
  "sessionId",
  "documentKind",
  "recordKind",
  "recordTag",
  "toolName",
  "touchedPath",
  "state",
] as const;

const KNOWLEDGE_SEARCH_SOURCE_KINDS = new Set<KnowledgeCollectionKind>([
  "sessions",
  "skills",
  "mcp",
  "codebase",
  "context_pack",
  "mixed",
]);

function addKnowledgeFacetValue(facets: KnowledgeFacets, key: string, rawValue: string): void {
  const value = rawValue.trim();
  if (!key.trim() || !value || value === "all") return;
  const existing = facets[key];
  if (!existing) {
    facets[key] = value;
    return;
  }
  const next = Array.isArray(existing) ? existing : [existing];
  if (!next.includes(value)) facets[key] = [...next, value];
}

type SessionKnowledgeIndexOutcome = {
  ok: boolean;
  busy?: boolean;
  result?: unknown;
  status?: unknown;
  error?: string;
};

type SessionKnowledgeIndexInput = {
  days?: number;
  hours?: number;
  limit: number;
  force: boolean;
  harness?: string | string[];
};

// Session indexing runs in a child process: it parses hundreds of MB of
// transcripts and performs heavy SQLite/FTS writes, which froze every web
// request when it ran on the server's event loop (a worker thread still
// shares the process heap and took the server down under a full rebuild).
// Concurrent callers with identical parameters share the in-flight run
// instead of stacking writers; different parameters get 409 from the route.
const SESSION_KNOWLEDGE_INDEX_TIMEOUT_MS = 15 * 60 * 1000;

let activeSessionKnowledgeIndex: {
  input: SessionKnowledgeIndexInput;
  promise: Promise<SessionKnowledgeIndexOutcome>;
} | null = null;

function normalizeHarnessList(value: string | string[] | undefined): string[] {
  if (value == null) return [];
  const raw = Array.isArray(value) ? value : [value];
  return [...new Set(raw.map((entry) => entry.trim().toLowerCase()).filter(Boolean))].sort();
}

function sameSessionKnowledgeIndexInput(a: SessionKnowledgeIndexInput, b: SessionKnowledgeIndexInput): boolean {
  return a.days === b.days
    && a.hours === b.hours
    && a.limit === b.limit
    && a.force === b.force
    && normalizeHarnessList(a.harness).join("\0") === normalizeHarnessList(b.harness).join("\0");
}

function startSessionKnowledgeIndex(input: SessionKnowledgeIndexInput): Promise<SessionKnowledgeIndexOutcome> {
  if (activeSessionKnowledgeIndex) {
    return sameSessionKnowledgeIndexInput(activeSessionKnowledgeIndex.input, input)
      ? activeSessionKnowledgeIndex.promise
      : Promise.resolve({ ok: false, busy: true, error: "session knowledge index already running" });
  }
  const promise = (async () => {
    try {
      // Dev serves this file's TS source; packaged builds bundle the child as
      // a sibling .mjs (see build:server). Prefer whichever exists.
      const childTs = new URL("./knowledge-index-child.ts", import.meta.url);
      const childMjs = new URL("./knowledge-index-child.mjs", import.meta.url);
      const scriptPath = fileURLToPath(existsSync(childTs) ? childTs : childMjs);
      const child = Bun.spawn([process.execPath, scriptPath, JSON.stringify(input)], {
        stdout: "pipe",
        stderr: "inherit",
        env: process.env,
      });
      const timeout = setTimeout(() => child.kill(), SESSION_KNOWLEDGE_INDEX_TIMEOUT_MS);
      const stdout = await new Response(child.stdout).text();
      const exitCode = await child.exited;
      clearTimeout(timeout);
      const lastLine = stdout.trim().split("\n").filter(Boolean).at(-1);
      if (lastLine) {
        try {
          return JSON.parse(lastLine) as SessionKnowledgeIndexOutcome;
        } catch {
          // fall through to the generic failure below
        }
      }
      return {
        ok: false,
        error: `knowledge index child exited ${exitCode} without a result`,
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      activeSessionKnowledgeIndex = null;
    }
  })();
  activeSessionKnowledgeIndex = { input, promise };
  return promise;
}

function parseKnowledgeSearchParams(rawUrl: string): {
  facets?: KnowledgeFacets;
  collections?: string[];
  sourceKinds?: KnowledgeCollectionKind[];
  sourceUpdatedAfterMs?: number;
  sourceUpdatedBeforeMs?: number;
} {
  const url = new URL(rawUrl, "http://localhost");
  const facets: KnowledgeFacets = {};

  for (const key of KNOWLEDGE_SEARCH_FACET_PARAMS) {
    for (const value of url.searchParams.getAll(key)) {
      addKnowledgeFacetValue(facets, key, value);
    }
  }
  for (const [key, value] of url.searchParams.entries()) {
    if (key.startsWith("facet:")) addKnowledgeFacetValue(facets, key.slice("facet:".length), value);
    if (key.startsWith("facet.")) addKnowledgeFacetValue(facets, key.slice("facet.".length), value);
  }

  const collections = [
    ...url.searchParams.getAll("collection"),
    ...url.searchParams.getAll("collectionId"),
  ].map((value) => value.trim()).filter(Boolean);
  const sourceKinds = url.searchParams.getAll("sourceKind")
    .map((value) => value.trim())
    .filter((value): value is KnowledgeCollectionKind =>
      KNOWLEDGE_SEARCH_SOURCE_KINDS.has(value as KnowledgeCollectionKind)
    );

  return {
    facets: Object.keys(facets).length > 0 ? facets : undefined,
    collections: collections.length > 0 ? collections : undefined,
    sourceKinds: sourceKinds.length > 0 ? sourceKinds : undefined,
    sourceUpdatedAfterMs: parseOptionalFiniteNumber(url.searchParams.get("updatedAfterMs")),
    sourceUpdatedBeforeMs: parseOptionalFiniteNumber(url.searchParams.get("updatedBeforeMs")),
  };
}

type ServerTimingMetric = {
  name: string;
  dur?: number;
  desc?: string;
};

const MAX_SERVER_TIMING_HEADER_LENGTH = 2048;
const TRUNCATED_SERVER_TIMING_HEADER = 'server-timing-truncated;desc="oversize"';

function serverTimingToken(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9!#$%&'*+.^_`|~-]+/g, "-") || "metric";
}

function serverTimingDescription(value: string): string {
  return value.replace(/["\\]/g, "");
}

function formatServerTiming(metrics: ServerTimingMetric[]): string {
  return metrics
    .filter((metric) => metric.name.trim())
    .map((metric) => {
      const parts = [serverTimingToken(metric.name)];
      if (metric.dur !== undefined && Number.isFinite(metric.dur)) {
        parts.push(`dur=${Math.max(0, metric.dur).toFixed(1)}`);
      }
      if (metric.desc?.trim()) {
        parts.push(`desc="${serverTimingDescription(metric.desc.trim())}"`);
      }
      return parts.join(";");
    })
    .join(", ");
}

function boundedServerTimingHeader(value: string): string {
  const trimmed = value.replace(/[\r\n]+/g, " ").trim();
  return trimmed.length <= MAX_SERVER_TIMING_HEADER_LENGTH
    ? trimmed
    : TRUNCATED_SERVER_TIMING_HEADER;
}

function appendServerTimingHeader(
  upstream: string | null,
  metrics: ServerTimingMetric[],
): string {
  const local = formatServerTiming(metrics);
  return boundedServerTimingHeader([
    upstream ? boundedServerTimingHeader(upstream) : null,
    local || null,
  ].filter(Boolean).join(", "));
}

type TailRecentPayload = {
  generatedAt: number;
  limit: number;
  cursor: string | null;
  events: TailEvent[];
};

const TAIL_DISCOVERY_SCOPES = new Set<TailDiscoveryScope>(["hot", "shallow", "deep"]);

function parseTailDiscoveryScope(value: string | undefined): TailDiscoveryScope | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  return TAIL_DISCOVERY_SCOPES.has(normalized as TailDiscoveryScope)
    ? (normalized as TailDiscoveryScope)
    : undefined;
}

function tailDiscoveryProcessKey(source: string, cwd: string | null | undefined): string | null {
  const cleanCwd = cwd?.trim();
  return cleanCwd ? `${source}\u0000${cleanCwd}` : null;
}

function limitTailDiscoverySnapshot(
  snapshot: DiscoverySnapshot,
  limit: number | undefined,
): DiscoverySnapshot {
  if (!limit || limit <= 0) return snapshot;
  const transcripts = snapshot.transcripts.slice(0, limit);
  const transcriptProcessKeys = new Set(
    transcripts
      .map((transcript) => tailDiscoveryProcessKey(transcript.source, transcript.cwd))
      .filter((key): key is string => Boolean(key)),
  );
  const processIds = new Set<string>();
  const processes: DiscoverySnapshot["processes"] = [];
  for (const process of snapshot.processes) {
    const key = tailDiscoveryProcessKey(process.source, process.cwd);
    if (!key || !transcriptProcessKeys.has(key)) continue;
    const processId = `${process.source}\u0000${process.pid}`;
    if (processIds.has(processId)) continue;
    processIds.add(processId);
    processes.push(process);
    if (processes.length >= limit) break;
  }
  for (const process of snapshot.processes) {
    if (processes.length >= limit) break;
    const processId = `${process.source}\u0000${process.pid}`;
    if (processIds.has(processId)) continue;
    processIds.add(processId);
    processes.push(process);
  }
  return {
    ...snapshot,
    processes,
    transcripts,
  };
}

function rawFilePathFromRoute(requestUrl: string): string | null {
  const pathname = new URL(requestUrl).pathname;
  const prefix = "/api/file/raw";
  if (!pathname.startsWith(`${prefix}/`)) {
    return null;
  }
  try {
    return decodeURIComponent(pathname.slice(prefix.length));
  } catch {
    return null;
  }
}

function serveRawFile(
  c: Context,
  currentDirectory: string,
  requestedPath: string | null | undefined,
): Response {
  if (!requestedPath) {
    return c.json({ error: "missing path" }, 400);
  }
  const roots = collectTrustedRoots({ currentDirectory });
  const resolved = resolveTrustedPath({ requestedPath, roots });
  if (!resolved.ok) {
    return c.json({ error: resolved.error }, resolved.status as 400 | 403 | 404);
  }
  try {
    if (!statSync(resolved.realPath).isFile()) {
      return c.json({ error: "path is not a file" }, 415);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "could not read file";
    return c.json({ error: message }, 500);
  }
  return new Response(Bun.file(resolved.realPath), {
    headers: {
      "content-type": mediaTypeFor(resolved.realPath),
      "cache-control": "private, max-age=60",
    },
  });
}

type BrokerJsonCache<T> = {
  data: T | null;
  inFlight: Promise<void> | null;
  lastError: string | null;
  serverTiming: string | null;
  refreshedAt: number | null;
};

function createBrokerJsonCache<T>(): BrokerJsonCache<T> {
  return {
    data: null,
    inFlight: null,
    lastError: null,
    serverTiming: null,
    refreshedAt: null,
  };
}

function headerSafe(value: string): string {
  return value.replace(/[\r\n]+/g, " ").slice(0, 180);
}

function scheduleBrokerJsonRefresh<T>(
  cache: BrokerJsonCache<T>,
  url: URL,
  label: string,
): Promise<void> {
  if (cache.inFlight) return cache.inFlight;
  const fetchStart = performance.now();
  cache.inFlight = (async () => {
    let upstreamTiming: string | null = null;
    const metrics: ServerTimingMetric[] = [];
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      upstreamTiming = res.headers.get("server-timing");
      metrics.push({ name: "web-broker-fetch", dur: performance.now() - fetchStart });
      if (!res.ok) {
        throw new Error(`${label} unavailable (${res.status})`);
      }
      const parseStart = performance.now();
      const data = await res.json() as T;
      metrics.push({ name: "web-json", dur: performance.now() - parseStart });
      cache.data = data;
      cache.lastError = null;
      cache.refreshedAt = Date.now();
      cache.serverTiming = appendServerTimingHeader(upstreamTiming, metrics);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      cache.lastError = message;
      metrics.push({
        name: "web-broker-fetch",
        dur: performance.now() - fetchStart,
        desc: "error",
      });
      cache.serverTiming = appendServerTimingHeader(upstreamTiming, metrics);
    } finally {
      cache.inFlight = null;
    }
  })();
  return cache.inFlight;
}

function cachedBrokerJsonState<T>(cache: BrokerJsonCache<T>): string {
  if (cache.data) {
    if (cache.lastError) return cache.inFlight ? "stale-retrying" : "stale";
    return cache.inFlight ? "hit-refreshing" : "hit";
  }
  if (cache.lastError) return cache.inFlight ? "empty-retrying" : "empty-error";
  return cache.inFlight ? "empty-refreshing" : "empty";
}

async function serveCachedBrokerJson<T>(
  c: Context,
  cache: BrokerJsonCache<T>,
  url: URL,
  label: string,
  options: { forceRefresh?: boolean; transform?: (data: T) => T } = {},
): Promise<Response> {
  const start = performance.now();
  if (options.forceRefresh) {
    if (cache.inFlight) {
      await cache.inFlight;
    }
    await scheduleBrokerJsonRefresh(cache, url, label);
  } else {
    const refresh = scheduleBrokerJsonRefresh(cache, url, label);
    if (cache.data === null) {
      await refresh;
    }
  }
  const state = cachedBrokerJsonState(cache);
  c.header("Cache-Control", "no-store");
  c.header("X-OpenScout-Tail-State", state);
  if (cache.lastError) {
    c.header("X-OpenScout-Tail-Warning", headerSafe(cache.lastError));
  }
  c.header("Server-Timing", appendServerTimingHeader(cache.serverTiming, [{
    name: "web-tail-cache",
    dur: performance.now() - start,
    desc: state,
  }]));
  if (cache.data === null) {
    return c.json({
      error: `${label} unavailable`,
      ...(cache.lastError ? { detail: cache.lastError } : {}),
    }, 502);
  }
  const data = options.transform ? options.transform(cache.data) : cache.data;
  return c.json(data);
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }
  return undefined;
}

type HarnessTranscriptSourceRef = Extract<KnowledgeSourceRef, { kind: "harness_transcript" }>;

type JsonlPreviewRecord = {
  index: number;
  raw: string;
  type?: string;
  role?: string;
  kind?: string;
  summary: string;
  renderedText: string;
  parsed: boolean;
  matched?: boolean;
  matchCount?: number;
  matchTerms?: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "string" && field.trim() ? field.trim() : undefined;
}

function trimPreviewLine(value: string, max = 260): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 3))}...`;
}

function previewQueryTerms(query: string | undefined): string[] {
  const seen = new Set<string>();
  return (query ?? "")
    .split(/[^A-Za-z0-9_./-]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length > 1)
    .filter((term) => {
      const key = term.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 12);
}

function matchStats(text: string, terms: string[]): { count: number; terms: string[] } {
  if (!text || terms.length === 0) return { count: 0, terms: [] };
  const lower = text.toLowerCase();
  let count = 0;
  const matchedTerms: string[] = [];
  for (const term of terms) {
    const needle = term.toLowerCase();
    let index = lower.indexOf(needle);
    let matched = false;
    while (index >= 0) {
      count++;
      matched = true;
      index = lower.indexOf(needle, index + needle.length);
    }
    if (matched) matchedTerms.push(term);
  }
  return { count, terms: matchedTerms };
}

function extractPreviewText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const joined = value
      .map((entry) => extractPreviewText(entry))
      .filter((entry): entry is string => Boolean(entry))
      .join(" ");
    return joined || null;
  }
  if (!isRecord(value)) return null;
  for (const key of [
    "text",
    "message",
    "content",
    "input",
    "arguments",
    "args",
    "output",
    "result",
    "prompt",
    "command",
    "lastPrompt",
    "aiTitle",
    "summary",
  ]) {
    const extracted = extractPreviewText(value[key]);
    if (extracted) return extracted;
  }
  return null;
}

function summarizeJsonlRecord(raw: string, index: number, terms: string[]): JsonlPreviewRecord {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const payload = isRecord(parsed) ? parsed.payload : null;
    const message = isRecord(parsed) ? parsed.message : null;
    const candidate = payload ?? message ?? parsed;
    const type = stringField(parsed, "type") ?? stringField(candidate, "type");
    const role = stringField(parsed, "role") ?? stringField(candidate, "role") ?? stringField(message, "role");
    const kind = stringField(parsed, "kind") ?? stringField(candidate, "kind") ?? type ?? role;
    const renderedText = extractPreviewText(candidate) ?? extractPreviewText(parsed) ?? raw;
    const summary = trimPreviewLine(renderedText);
    const stats = matchStats(`${summary}\n${renderedText}\n${raw}`, terms);
    return {
      index,
      raw,
      ...(type ? { type } : {}),
      ...(role ? { role } : {}),
      ...(kind ? { kind } : {}),
      summary,
      renderedText,
      parsed: true,
      matched: stats.count > 0,
      matchCount: stats.count,
      matchTerms: stats.terms,
    };
  } catch {
    const stats = matchStats(raw, terms);
    return {
      index,
      raw,
      kind: "unparseable",
      summary: trimPreviewLine(raw),
      renderedText: raw,
      parsed: false,
      matched: stats.count > 0,
      matchCount: stats.count,
      matchTerms: stats.terms,
    };
  }
}

function isInsideRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function resolveKnowledgePreviewPath(
  sourceRef: HarnessTranscriptSourceRef,
  currentDirectory: string,
): string | null {
  const paths = resolveOpenScoutKnowledgePaths();
  const controlHome = dirname(paths.knowledgeRoot);
  const portable = sourceRef.path;
  const relPath = portable.relPath?.trim();
  if (!relPath) return null;

  if (portable.root === "ABSOLUTE") {
    const absolute = resolve(relPath);
    const trustedRoots = [homedir(), currentDirectory, controlHome].map((root) => resolve(root));
    return trustedRoots.some((root) => isInsideRoot(root, absolute)) ? absolute : null;
  }

  const root = portable.root === "HOME"
    ? homedir()
    : portable.root === "OPENSCOUT_CONTROL_HOME"
      ? controlHome
      : portable.root === "OPENSCOUT_SUPPORT_DIRECTORY"
        ? dirname(controlHome)
        : portable.root === "PROJECT_ROOT"
          ? currentDirectory
          : null;
  if (!root) return null;
  const resolved = resolve(root, relPath);
  return isInsideRoot(resolve(root), resolved) ? resolved : null;
}

async function readKnowledgeJsonlPreview(input: {
  sourceRef: HarnessTranscriptSourceRef;
  currentDirectory: string;
  contextRecords?: number;
  maxRecords?: number;
  query?: string;
}) {
  const resolvedPath = resolveKnowledgePreviewPath(input.sourceRef, input.currentDirectory);
  if (!resolvedPath) {
    throw new Error("source path is outside trusted preview roots");
  }
  const stats = statSync(resolvedPath);
  if (!stats.isFile()) {
    throw new Error("source path is not a file");
  }

  const requested = input.sourceRef.recordRange;
  const requestedStart = Array.isArray(requested) && Number.isFinite(requested[0])
    ? Math.max(0, Math.floor(requested[0]))
    : 0;
  const requestedEnd = Array.isArray(requested) && Number.isFinite(requested[1])
    ? Math.max(requestedStart, Math.floor(requested[1]))
    : requestedStart + 24;
  const contextRecords = Math.min(20, Math.max(0, Math.floor(input.contextRecords ?? 4)));
  const maxRecords = Math.min(120, Math.max(1, Math.floor(input.maxRecords ?? 80)));
  const start = Math.max(0, requestedStart - contextRecords);
  const desiredEnd = requestedEnd + contextRecords;
  const end = Math.min(desiredEnd, start + maxRecords - 1);
  const terms = previewQueryTerms(input.query);

  const records: JsonlPreviewRecord[] = [];
  let index = 0;
  let truncatedAfter = false;
  const reader = createInterface({
    input: createReadStream(resolvedPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of reader) {
    if (index > end) {
      truncatedAfter = true;
      reader.close();
      break;
    }
    if (index >= start) {
      records.push(summarizeJsonlRecord(line, index, terms));
    }
    index++;
  }

  const first = records[0]?.index ?? start;
  const last = records.at(-1)?.index ?? first;
  return {
    path: resolvedPath,
    sourcePath: input.sourceRef.path,
    harness: input.sourceRef.harness,
    sessionId: input.sourceRef.sessionId,
    requestedRange: requested,
    previewRange: [first, last] as [number, number],
    records,
    recordsRead: records.length,
    truncatedBefore: start > 0,
    truncatedAfter,
    query: input.query,
    queryTerms: terms,
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

const LEGACY_SCOUTBOT_CONVERSATION_IDS = new Set([
  "dm.operator.scoutbot",
  "dm.operator.scoutbot.default",
]);

function isLegacyScoutbotConversationId(value: string): boolean {
  return LEGACY_SCOUTBOT_CONVERSATION_IDS.has(value.trim());
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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

const KNOWN_AGENT_HARNESSES = new Set<string>([
  "codex",
  "claude",
  "flue",
  "cursor",
  "native",
  "worker",
  "bridge",
  "http",
  "pi",
]);

function coerceAgentHarness(value: unknown): AgentHarness | undefined {
  const normalized = optionalString(value)?.trim();
  return normalized && KNOWN_AGENT_HARNESSES.has(normalized)
    ? (normalized as AgentHarness)
    : undefined;
}

function recordInput(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
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

function firstMetadataString(...values: Array<unknown>): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

/**
 * Reconcile saved workspaces against the live host inventory.
 *
 * Both inputs are gathered once and shared across every workspace: probing the
 * hosts per workspace would multiply shell-outs by the size of the library for
 * an answer that is identical each time.
 *
 * The node id goes in with them because the sessions are THIS machine's
 * observations: a session discovered here carries no node in its handle, and
 * only this node's cells may be proven live by it. Without the id a cell scoped
 * to any node at all would bind to a same-named local session — which is how
 * two machines' workspaces both reported one session Running. The id is a
 * node-only broker read — identity is all this needs, never the registry
 * snapshot — and a broker that is down means the id is unknown, which
 * reconciliation reads as "cannot prove it" rather than "matches anything".
 */
async function resolveTerminalWorkspaces(
  workspaces: readonly TerminalWorkspaceRecord[],
): Promise<TerminalWorkspaceResolution[]> {
  if (workspaces.length === 0) return [];
  const [sessions, hosts, localNodeId] = await Promise.all([
    queryDiscoveredTerminalSessions({ limit: 500 }),
    describeTerminalHosts(),
    readScoutBrokerNodeId(),
  ]);
  // Derived from the one probe above; a second resolve would probe every host
  // again for an answer this list already holds.
  const preferred = preferredTerminalHost(hosts);
  const registered = queryTerminalSessions({ limit: 500 });
  const hostStates = hosts.map((host) => ({
    id: host.id,
    installed: host.availability.installed,
    canCreate: host.capabilities.create,
  }));
  return workspaces.map((workspace) => reconcileTerminalWorkspace(workspace, {
    sessions: [...registered, ...sessions],
    hosts: hostStates,
    defaultHostId: preferred?.id ?? null,
    localNodeId,
  }));
}

/** Any host with a registered adapter, not a hardcoded pair. */
function parseTerminalSessionBackend(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized && isKnownTerminalHost(normalized) ? normalized : undefined;
}

function parseTerminalSessionLimit(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(1000, Math.floor(parsed)) : 100;
}

function parseTerminalSessionDiscoveryFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "backend";
}

function parseTerminalSurfaceControlAction(value: string | undefined): "interrupt" | "quit" | "stop-job" | "restart-resume" | "detach" | "release" | "force-quit" | "force-quit-bridge" | undefined {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "interrupt"
    || normalized === "quit"
    || normalized === "stop-job"
    || normalized === "restart-resume"
    || normalized === "detach"
    || normalized === "release"
    || normalized === "force-quit"
    || normalized === "force-quit-bridge"
  ) {
    return normalized;
  }
  return undefined;
}

type TmuxPaneProcess = {
  pid: number;
  ppid: number;
  pgid: number;
  comm: string;
};

type ProcessCommandRow = TmuxPaneProcess & {
  command: string;
};

type RelayRuntimeState = {
  agentId?: string;
  projectRoot?: string;
  sessionId?: string;
  promptFile?: string;
  launchScript?: string;
};

function parseProcessNumber(value: string | undefined): number | null {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function tmuxPaneDetail(sessionName: string): Promise<{ panePid: number; paneTty: string; paneCurrentPath: string | null } | null> {
  return await readTmuxPaneDetail(sessionName);
}

async function processRowsForTty(tty: string): Promise<TmuxPaneProcess[]> {
  return await readProcessRowsForTty(tty);
}

async function allProcessRows(): Promise<TmuxPaneProcess[]> {
  return await readAllProcessRows();
}

async function allProcessCommandRows(): Promise<ProcessCommandRow[]> {
  return await readAllProcessCommandRows();
}

async function processRowsForTmuxPane(detail: { panePid: number; paneTty: string }): Promise<TmuxPaneProcess[]> {
  const byPid = new Map<number, TmuxPaneProcess>();
  // Keep tty-derived parentage first: macOS can report long-running tmux pane
  // children as reparented elsewhere, while the tty scan still exposes the
  // pane-to-Claude relationship we need to find no-tty shell jobs.
  for (const row of await processRowsForTty(detail.paneTty)) {
    byPid.set(row.pid, row);
  }
  for (const row of await allProcessRows()) {
    if (!byPid.has(row.pid)) byPid.set(row.pid, row);
  }
  return [...byPid.values()];
}

function descendantsOf(rootPid: number, rows: TmuxPaneProcess[]): Set<number> {
  const descendants = new Set<number>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (row.ppid !== rootPid && !descendants.has(row.ppid)) continue;
      if (descendants.has(row.pid)) continue;
      descendants.add(row.pid);
      changed = true;
    }
  }
  return descendants;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killProcesses(pids: number[], signal: NodeJS.Signals): number {
  let killed = 0;
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
      killed += 1;
    } catch {
      // The process may already be gone.
    }
  }
  return killed;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:+=@%-]+$/u.test(value)) {
    return value;
  }
  return `'${value.replace(/'/gu, `'\''`)}'`;
}

async function readProcessCwd(pid: number): Promise<string | null> {
  return await readProcessCwdProbe(pid);
}

function claudeProjectDirForCwd(cwd: string): string {
  return join(homedir(), ".claude", "projects", cwd.replace(/\//gu, "-"));
}

function mostRecentClaudeSessionForCwd(cwd: string): { sessionId: string; transcriptPath: string } | null {
  const dir = claudeProjectDirForCwd(cwd);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  let best: { sessionId: string; transcriptPath: string; mtimeMs: number } | null = null;
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    const transcriptPath = join(dir, entry);
    try {
      const mtimeMs = statSync(transcriptPath).mtimeMs;
      if (!best || mtimeMs > best.mtimeMs) {
        best = {
          sessionId: entry.slice(0, -".jsonl".length),
          transcriptPath,
          mtimeMs,
        };
      }
    } catch {
      // Ignore stale entries that disappeared while scanning.
    }
  }
  return best ? { sessionId: best.sessionId, transcriptPath: best.transcriptPath } : null;
}

function readRelayRuntimeStateForTmuxSession(sessionName: string): RelayRuntimeState | null {
  const agentsDir = resolveOpenScoutSupportPaths().relayAgentsDirectory;
  let entries: string[];
  try {
    entries = readdirSync(agentsDir);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const statePath = join(agentsDir, entry, "state.json");
    try {
      const parsed = JSON.parse(readFileSync(statePath, "utf8")) as RelayRuntimeState;
      if (parsed.sessionId === sessionName) return parsed;
    } catch {
      // Ignore malformed or partially-written runtime state files.
    }
  }
  return null;
}

function resumeScriptFromLaunchScript(launchScript: string, sessionId: string): string {
  const resumePrefix = `exec claude --resume ${shellQuote(sessionId)} `;
  const rewritten = launchScript.replace(/(^|\n)(\s*)claude\s+/u, `$1$2${resumePrefix}`);
  return rewritten === launchScript
    ? `${launchScript}\n# OpenScout resume fallback\n${resumePrefix}\n`
    : rewritten;
}

async function forceQuitRelayAgentProcessTree(agentId: string): Promise<boolean> {
  const rows = await allProcessCommandRows();
  const claudeRoots = rows.filter((row) =>
    /(^|\/)claude(\s|$)/u.test(row.command) && row.command.includes(agentId)
  );
  const targetPids = new Set<number>();
  for (const root of claudeRoots) {
    targetPids.add(root.pid);
    const descendants = descendantsOf(root.pid, rows);
    const targetGroups = new Set<number>([root.pgid]);
    for (const row of rows) {
      if (descendants.has(row.pid)) {
        targetPids.add(row.pid);
        targetGroups.add(row.pgid);
      }
    }
    for (const row of rows) {
      if (targetGroups.has(row.pgid)) targetPids.add(row.pid);
    }
  }
  return terminateProcessesWithEscalation([...targetPids]);
}

async function restartClaudeWithResumeInTmuxSurface(sessionName: string): Promise<{ ok: boolean; sessionId: string | null; transcriptPath: string | null }> {
  const runtimeState = readRelayRuntimeStateForTmuxSession(sessionName);
  const detail = await tmuxPaneDetail(sessionName);
  const surface = detail ? await claudeRowsInTmuxSurface(sessionName) : null;
  const liveClaudeCwd = surface?.claudeRows[0]?.pid
    ? await readProcessCwd(surface.claudeRows[0].pid)
    : null;
  const cwd = runtimeState?.projectRoot
    ?? liveClaudeCwd
    ?? detail?.paneCurrentPath
    ?? null;
  if (!cwd) return { ok: false, sessionId: null, transcriptPath: null };
  const transcript = mostRecentClaudeSessionForCwd(cwd);
  if (!transcript) return { ok: false, sessionId: null, transcriptPath: null };

  const launchScriptPath = runtimeState?.launchScript;
  const launchScript = launchScriptPath && existsSync(launchScriptPath)
    ? readFileSync(launchScriptPath, "utf8")
    : `#!/bin/bash
set -uo pipefail
cd ${shellQuote(cwd)}
exec claude --resume ${shellQuote(transcript.sessionId)}
`;
  const resumeScript = resumeScriptFromLaunchScript(launchScript, transcript.sessionId);

  try {
    if (runtimeState?.agentId) {
      await forceQuitRelayAgentProcessTree(runtimeState.agentId);
    } else if (detail) {
      await forceQuitClaudeInTmuxSurface(sessionName);
    }
    const command = `bash -lc ${shellQuote(resumeScript)}`;
    if (detail) {
      await execSystemFile("tmux", [
        "respawn-pane",
        "-k",
        "-t",
        sessionName,
        "-c",
        cwd,
        command,
      ], { timeoutMs: 5_000 });
    } else {
      await execSystemFile("tmux", [
        "new-session",
        "-d",
        "-s",
        sessionName,
        "-c",
        cwd,
        command,
      ], { timeoutMs: 5_000 });
    }
    return { ok: true, sessionId: transcript.sessionId, transcriptPath: transcript.transcriptPath };
  } catch {
    return { ok: false, sessionId: transcript.sessionId, transcriptPath: transcript.transcriptPath };
  }
}

function terminateProcessesWithEscalation(pids: number[]): boolean {
  const targetPids = [...new Set(pids)]
    .filter((pid) => Number.isFinite(pid) && pid > 0)
    .sort((left, right) => right - left);
  if (targetPids.length === 0) return false;
  killProcesses(targetPids, "SIGTERM");
  const stillAlive = targetPids.filter(processExists);
  if (stillAlive.length > 0) {
    setTimeout(() => {
      killProcesses(stillAlive.filter(processExists), "SIGKILL");
    }, 750);
  }
  return true;
}

async function claudeRowsInTmuxSurface(sessionName: string): Promise<{
  detail: { panePid: number; paneTty: string };
  rows: TmuxPaneProcess[];
  panePgid: number;
  claudeRows: TmuxPaneProcess[];
} | null> {
  const detail = await tmuxPaneDetail(sessionName);
  if (!detail) return null;
  const rows = await processRowsForTmuxPane(detail);
  const descendantPids = descendantsOf(detail.panePid, rows);
  const panePgid = rows.find((row) => row.pid === detail.panePid)?.pgid ?? detail.panePid;
  const claudeRows = rows.filter((row) =>
    descendantPids.has(row.pid) && /(^|\/)claude$/u.test(row.comm)
  );
  return { detail, rows, panePgid, claudeRows };
}

async function stopClaudeActiveJobInTmuxSurface(sessionName: string): Promise<boolean> {
  const surface = await claudeRowsInTmuxSurface(sessionName);
  if (!surface) return false;
  const targetPids = new Set<number>();
  for (const claudeRow of surface.claudeRows) {
    const claudeDescendants = descendantsOf(claudeRow.pid, surface.rows);
    const jobGroups = new Set(
      surface.rows
        .filter((row) =>
          claudeDescendants.has(row.pid)
          && row.pgid !== surface.panePgid
          && row.pgid !== claudeRow.pgid
        )
        .map((row) => row.pgid),
    );
    for (const row of surface.rows) {
      if (claudeDescendants.has(row.pid) && jobGroups.has(row.pgid)) {
        targetPids.add(row.pid);
      }
    }
  }
  return terminateProcessesWithEscalation([...targetPids]);
}

async function forceQuitClaudeInTmuxSurface(sessionName: string): Promise<boolean> {
  const surface = await claudeRowsInTmuxSurface(sessionName);
  if (!surface) return false;
  const targetPids = [...new Set(surface.claudeRows.flatMap((row) =>
    surface.rows
      .filter((candidate) => candidate.pid === row.pid || descendantsOf(row.pid, surface.rows).has(candidate.pid))
      .map((candidate) => candidate.pid)
  ))].sort((left, right) => right - left);
  return terminateProcessesWithEscalation(targetPids);
}

async function controlTmuxSurface(sessionName: string, action: "interrupt" | "quit" | "stop-job" | "restart-resume" | "detach" | "force-quit"): Promise<boolean> {
  try {
    if (action === "interrupt") {
      await execSystemFile("tmux", ["send-keys", "-t", sessionName, "C-c"], { timeoutMs: 2_000 });
      return true;
    }
    if (action === "quit") {
      await execSystemFile("tmux", ["send-keys", "-t", sessionName, "C-d"], { timeoutMs: 2_000 });
      return true;
    }
    if (action === "stop-job") {
      return await stopClaudeActiveJobInTmuxSurface(sessionName);
    }
    if (action === "restart-resume") {
      return (await restartClaudeWithResumeInTmuxSurface(sessionName)).ok;
    }
    if (action === "force-quit") {
      return await forceQuitClaudeInTmuxSurface(sessionName);
    }
    await execSystemFile("tmux", ["detach-client", "-s", sessionName], { timeoutMs: 2_000 });
    return true;
  } catch {
    return false;
  }
}

function metadataTimestampMs(value: unknown): number | undefined {
  return epochMs(value) ?? undefined;
}

function agentEndpointMetadata(endpoint: AgentEndpoint | null | undefined): Record<string, unknown> {
  return endpointMetadataRecord(endpoint);
}

function activeEndpointForAgent(
  snapshot: { endpoints?: Record<string, AgentEndpoint> },
  agentId: string,
  preference?: EndpointPreference,
): AgentEndpoint | null {
  return selectPreferredAgentEndpoint(snapshot, agentId, preference);
}

const ACTIVE_BROKER_FLIGHT_STATES = new Set(["queued", "waking", "running", "waiting"]);

function metadataStringValue(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  return firstMetadataString(metadata?.[key]);
}

function metadataBooleanValue(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): boolean {
  return metadata?.[key] === true;
}

function metadataStringArrayValue(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): string[] {
  const value = metadata?.[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => String(entry).trim()).filter(Boolean);
}

function metadataRecordValue(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): Record<string, unknown> | null {
  const value = metadata?.[key];
  return recordInput(value);
}

function metadataRecordArrayValue(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): Record<string, unknown>[] {
  const value = metadata?.[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(recordInput).filter((entry): entry is Record<string, unknown> => Boolean(entry));
}

function isBrokerAgentVisibleInWeb(agent: ScoutBrokerContext["snapshot"]["agents"][string]): boolean {
  const metadata = recordInput(agent.metadata);
  return metadataBooleanValue(metadata, "brokerRegistered")
    && !metadataBooleanValue(metadata, "staleLocalRegistration")
    && !metadataBooleanValue(metadata, "retiredFromFleet");
}

function latestBrokerAgentTimestamp(
  agent: ScoutBrokerContext["snapshot"]["agents"][string],
  endpoint: AgentEndpoint | null,
): number | null {
  const agentMetadata = recordInput(agent.metadata);
  const endpointMetadata = agentEndpointMetadata(endpoint);
  const timestamps = [
    agentMetadata?.createdAt,
    agentMetadata?.registeredAt,
    agentMetadata?.updatedAt,
    endpointMetadata.lastSeenAt,
    endpointMetadata.lastEnsuredAt,
    endpointMetadata.startedAt,
    endpointMetadata.lastStartedAt,
    endpointMetadata.lastCompletedAt,
    endpointMetadata.lastFailedAt,
  ].map(metadataTimestampMs).filter((value): value is number => value !== undefined);
  return timestamps.length > 0 ? Math.max(...timestamps) : null;
}

function brokerAgentFlightPhase(
  broker: ScoutBrokerContext,
  agentId: string,
): "in_turn" | "in_flight" | null {
  let phase: "in_turn" | "in_flight" | null = null;
  for (const flight of Object.values(broker.snapshot.flights ?? {})) {
    if (flight.targetAgentId !== agentId || !ACTIVE_BROKER_FLIGHT_STATES.has(flight.state)) {
      continue;
    }
    if (flight.state === "running") {
      return "in_turn";
    }
    phase = "in_flight";
  }
  return phase;
}

function brokerFlightToWebFlight(
  broker: ScoutBrokerContext,
  flight: NonNullable<ScoutBrokerContext["snapshot"]["flights"]>[string],
): WebFlight {
  const invocation = broker.snapshot.invocations?.[flight.invocationId];
  const metadata = recordInput(flight.metadata);
  const returnAddress = metadataRecordValue(metadata, "returnAddress");
  const agent = broker.snapshot.agents?.[flight.targetAgentId];
  const actor = broker.snapshot.actors?.[flight.targetAgentId];
  return {
    id: flight.id,
    invocationId: flight.invocationId,
    ...(invocation?.messageId ? { messageId: invocation.messageId } : {}),
    agentId: flight.targetAgentId,
    agentName: agent?.displayName ?? actor?.displayName ?? null,
    conversationId:
      invocation?.conversationId
      ?? firstMetadataString(metadata?.conversationId, returnAddress?.conversationId),
    collaborationRecordId:
      invocation?.collaborationRecordId
      ?? firstMetadataString(metadata?.collaborationRecordId),
    state: flight.state,
    summary: flight.summary ?? null,
    startedAt: epochMs(flight.startedAt) ?? epochMs(invocation?.createdAt),
    completedAt: epochMs(flight.completedAt),
    sessions: flightSessionTrace(flight),
  };
}

function queryBrokerFlightsForWeb(
  broker: ScoutBrokerContext,
  opts: {
    flightId?: string;
    agentId?: string;
    conversationId?: string;
    collaborationRecordId?: string;
    activeOnly?: boolean;
  },
): WebFlight[] {
  return Object.values(broker.snapshot.flights ?? {})
    .map((flight) => brokerFlightToWebFlight(broker, flight))
    .filter((flight) => opts.flightId ? flight.id === opts.flightId : true)
    .filter((flight) => opts.agentId ? flight.agentId === opts.agentId : true)
    .filter((flight) => opts.conversationId ? flight.conversationId === opts.conversationId : true)
    .filter((flight) => opts.collaborationRecordId ? flight.collaborationRecordId === opts.collaborationRecordId : true)
    .filter((flight) => opts.activeOnly ? ACTIVE_BROKER_FLIGHT_STATES.has(flight.state) : true)
    .sort((left, right) => (
      (right.startedAt ?? right.completedAt ?? 0) - (left.startedAt ?? left.completedAt ?? 0)
      || left.id.localeCompare(right.id)
    ))
    .slice(0, 100);
}

function summarizeBrokerAgentState(
  agent: ScoutBrokerContext["snapshot"]["agents"][string],
  endpoint: AgentEndpoint | null,
  flightPhase: "in_turn" | "in_flight" | null,
): string {
  if (flightPhase === "in_turn") {
    return "working";
  }
  if (flightPhase === "in_flight") {
    return "in_flight";
  }
  void agent;
  void endpoint;
  return "available";
}

function brokerNodeName(
  broker: ScoutBrokerContext,
  nodeId: string | null | undefined,
): string | null {
  if (!nodeId) {
    return null;
  }
  return broker.snapshot.nodes?.[nodeId]?.name ?? null;
}

function brokerActorDisplay(
  broker: ScoutBrokerContext,
  actorId: string | null | undefined,
): { name: string | null; handle: string | null } {
  const actor = actorId ? broker.snapshot.actors?.[actorId] : null;
  return {
    name: actor?.displayName ?? null,
    handle: actor?.handle ?? null,
  };
}

function projectNameFromRoot(path: string | null): string | null {
  const normalized = path?.trim();
  return normalized ? basename(normalized) : null;
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

function brokerAgentCapabilitiesForWeb(
  agent: ScoutBrokerContext["snapshot"]["agents"][string],
  metadata: Record<string, unknown> | null,
): string[] {
  const explicit = Array.isArray(agent.capabilities)
    ? agent.capabilities.map((capability) => String(capability).trim()).filter(Boolean)
    : [];
  if (explicit.length > 0) {
    return explicit;
  }
  const metadataCapabilities = metadataStringArrayValue(metadata, "capabilities");
  return metadataCapabilities.length > 0 ? metadataCapabilities : ["chat", "invoke"];
}

function brokerAgentCardMetadata(
  metadata: Record<string, unknown> | null,
): Record<string, unknown> | null {
  return metadataRecordValue(metadata, "a2aAgentCard")
    ?? metadataRecordValue(metadata, "agentCard");
}

function brokerAgentProvider(
  metadata: Record<string, unknown> | null,
  card: Record<string, unknown> | null,
): { name: string | null; url: string | null } {
  const provider = metadataRecordValue(card, "provider")
    ?? metadataRecordValue(metadata, "provider");
  return {
    name: firstMetadataString(
      metadataStringValue(provider, "organization"),
      metadataStringValue(provider, "name"),
      metadataStringValue(metadata, "providerName"),
    ),
    url: firstMetadataString(
      metadataStringValue(provider, "url"),
      metadataStringValue(metadata, "providerUrl"),
    ),
  };
}

function brokerAgentProtocol(
  metadata: Record<string, unknown> | null,
  endpointMetadata: Record<string, unknown>,
): string | null {
  const supportedInterfaces = metadataRecordArrayValue(metadata, "supportedInterfaces")
    .concat(metadataRecordArrayValue(endpointMetadata, "supportedInterfaces"));
  const protocol = firstMetadataString(
    ...supportedInterfaces.map((entry) => metadataStringValue(entry, "protocol")),
    metadataStringValue(metadata, "protocol"),
    metadataStringValue(endpointMetadata, "protocol"),
  );
  if (protocol?.toLowerCase() === "a2a" || metadataStringValue(metadata, "a2aExecutionUrl")) {
    return "A2A";
  }
  return protocol;
}

function brokerAgentSkillNames(
  metadata: Record<string, unknown> | null,
  card: Record<string, unknown> | null,
): string[] {
  const skills = metadataRecordArrayValue(card, "skills")
    .concat(metadataRecordArrayValue(metadata, "skills"));
  return Array.from(new Set(
    skills
      .map((skill) => firstMetadataString(
        metadataStringValue(skill, "name"),
        metadataStringValue(skill, "id"),
      ))
      .filter((skill): skill is string => Boolean(skill)),
  ));
}

function brokerAgentAuthorityProfile(
  metadata: Record<string, unknown> | null,
): WebAgent["authorityProfile"] {
  const roleConfig = metadataRecordValue(metadata, "roleConfig");
  const grants = metadataRecordValue(roleConfig, "grants");
  const roleId = metadataStringValue(roleConfig, "roleId");
  if (!roleId || !grants) return null;
  return {
    roleId,
    readTools: metadataStringArrayValue(grants, "read"),
    writeTools: metadataStringArrayValue(grants, "write"),
    shell: grants.shell === true,
    codebaseWrites: grants.codebaseWrites === true,
  };
}

function brokerAgentRuntimePolicy(
  endpointMetadata: Record<string, unknown>,
): WebAgent["runtimePolicy"] {
  const approvalPolicy = metadataStringValue(endpointMetadata, "approvalPolicy");
  const sandbox = metadataStringValue(endpointMetadata, "sandbox");
  const shellTool = typeof endpointMetadata.shellTool === "boolean"
    ? endpointMetadata.shellTool
    : null;
  return approvalPolicy || sandbox || shellTool !== null
    ? { approvalPolicy, sandbox, shellTool }
    : null;
}

function brokerAgentActivity(
  broker: ScoutBrokerContext,
  agentId: string,
): NonNullable<WebAgent["brokerActivity"]> {
  const activity: NonNullable<WebAgent["brokerActivity"]> = [];
  for (const message of Object.values(broker.snapshot.messages ?? {})) {
    if (message.actorId !== agentId) continue;
    const at = epochMs(message.createdAt);
    if (!at) continue;
    activity.push({
      id: message.id,
      kind: "message",
      at,
      state: null,
      summary: message.body.trim() || "Message sent",
      conversationId: message.conversationId ?? null,
    });
  }
  for (const invocation of Object.values(broker.snapshot.invocations ?? {})) {
    if (invocation.targetAgentId !== agentId) continue;
    const at = epochMs(invocation.createdAt);
    if (!at) continue;
    activity.push({
      id: invocation.id,
      kind: "invocation",
      at,
      state: null,
      summary: invocation.task?.trim() || invocation.action || "Invocation received",
      conversationId: invocation.conversationId ?? null,
    });
  }
  for (const flight of Object.values(broker.snapshot.flights ?? {})) {
    if (flight.targetAgentId !== agentId) continue;
    const invocation = broker.snapshot.invocations?.[flight.invocationId];
    const at = epochMs(flight.completedAt)
      ?? epochMs(flight.startedAt)
      ?? epochMs(invocation?.createdAt);
    if (!at) continue;
    activity.push({
      id: flight.id,
      kind: "flight",
      at,
      state: flight.state,
      summary: flight.summary?.trim() || invocation?.task?.trim() || `Flight ${flight.state}`,
      conversationId: invocation?.conversationId ?? null,
    });
  }
  return activity
    .sort((left, right) => left.at - right.at || left.id.localeCompare(right.id))
    .slice(-80);
}

function brokerDirectConversationIdForAgent(
  broker: ScoutBrokerContext,
  agentId: string,
): string | null {
  const naturalKey = directChannelNaturalKey(["operator", agentId]);
  const conversation = Object.values(broker.snapshot.conversations ?? {}).find(
    (candidate) => channelNaturalKeyFromMetadata(candidate.metadata) === naturalKey,
  );
  return conversation?.id ?? null;
}

function brokerAgentCardToWebAgent(
  broker: ScoutBrokerContext,
  agent: ScoutBrokerContext["snapshot"]["agents"][string],
): WebAgent | null {
  if (!isBrokerAgentVisibleInWeb(agent)) {
    return null;
  }

  const endpoint = activeEndpointForAgent(broker.snapshot, agent.id);
  const agentMetadata = recordInput(agent.metadata);
  const endpointMetadata = agentEndpointMetadata(endpoint);
  const cardMetadata = brokerAgentCardMetadata(agentMetadata);
  const provider = brokerAgentProvider(agentMetadata, cardMetadata);
  const protocol = brokerAgentProtocol(agentMetadata, endpointMetadata);
  const skills = brokerAgentSkillNames(agentMetadata, cardMetadata);
  const projectRoot = firstMetadataString(
    endpoint?.projectRoot,
    metadataStringValue(endpointMetadata, "projectRoot"),
    metadataStringValue(agentMetadata, "projectRoot"),
  );
  const cwd = firstMetadataString(
    endpoint?.cwd,
    metadataStringValue(endpointMetadata, "currentDirectory"),
    metadataStringValue(endpointMetadata, "cwd"),
    metadataStringValue(agentMetadata, "currentDirectory"),
    metadataStringValue(agentMetadata, "cwd"),
    projectRoot,
  );
  const owner = brokerActorDisplay(broker, agent.ownerId);
  const brokerActivity = brokerAgentActivity(broker, agent.id);
  const createdAt = metadataTimestampMs(agentMetadata?.createdAt)
    ?? metadataTimestampMs(agentMetadata?.registeredAt)
    ?? null;
  const updatedAt = Math.max(
    latestBrokerAgentTimestamp(agent, endpoint) ?? 0,
    brokerActivity.at(-1)?.at ?? 0,
    createdAt ?? 0,
  ) || null;

  return {
    id: agent.id,
    definitionId: agent.definitionId,
    name: agent.displayName,
    handle: agent.handle ?? null,
    agentClass: agent.agentClass,
    harness: endpoint?.harness ?? metadataStringValue(agentMetadata, "harness"),
    state: summarizeBrokerAgentState(agent, endpoint, brokerAgentFlightPhase(broker, agent.id)),
    projectRoot: compactPath(projectRoot),
    cwd: compactPath(cwd),
    updatedAt,
    createdAt,
    transport: endpoint?.transport ?? metadataStringValue(agentMetadata, "transport"),
    selector: agent.selector ?? metadataStringValue(agentMetadata, "selector"),
    defaultSelector: agent.defaultSelector ?? metadataStringValue(agentMetadata, "defaultSelector"),
    nodeQualifier: agent.nodeQualifier ?? metadataStringValue(agentMetadata, "nodeQualifier"),
    workspaceQualifier: agent.workspaceQualifier ?? metadataStringValue(agentMetadata, "workspaceQualifier"),
    wakePolicy: agent.wakePolicy,
    capabilities: brokerAgentCapabilitiesForWeb(agent, agentMetadata),
    project: metadataStringValue(agentMetadata, "project") ?? projectNameFromRoot(projectRoot),
    branch: metadataStringValue(agentMetadata, "branch") ?? metadataStringValue(endpointMetadata, "branch"),
    role: metadataStringValue(agentMetadata, "role"),
    model: metadataStringValue(endpointMetadata, "model") ?? metadataStringValue(agentMetadata, "model"),
    modelProvider: metadataStringValue(endpointMetadata, "provider") ?? metadataStringValue(agentMetadata, "provider"),
    harnessSessionId: resolveHarnessSessionIdForAgent(
      endpoint?.transport ?? metadataStringValue(agentMetadata, "transport"),
      endpoint?.sessionId ?? null,
      {
        ...agentMetadata,
        ...endpointMetadata,
      },
      summarizeBrokerAgentState(agent, endpoint, brokerAgentFlightPhase(broker, agent.id)),
    ),
    terminalSurface: resolveTerminalSurface({
      transport: endpoint?.transport ?? metadataStringValue(agentMetadata, "transport"),
      endpointSessionId: endpoint?.sessionId ?? null,
      metadata: {
        ...agentMetadata,
        ...endpointMetadata,
      },
    }),
    harnessLogPath: null,
    conversationId: brokerDirectConversationIdForAgent(broker, agent.id),
    authorityNodeId: agent.authorityNodeId ?? null,
    authorityNodeName: brokerNodeName(broker, agent.authorityNodeId),
    homeNodeId: agent.homeNodeId ?? null,
    homeNodeName: brokerNodeName(broker, agent.homeNodeId),
    ownerId: agent.ownerId ?? null,
    ownerName: owner.name,
    ownerHandle: owner.handle,
    staleLocalRegistration: metadataBooleanValue(agentMetadata, "staleLocalRegistration"),
    retiredFromFleet: metadataBooleanValue(agentMetadata, "retiredFromFleet"),
    replacedByAgentId: metadataStringValue(agentMetadata, "replacedByAgentId"),
    providerName: provider.name,
    providerUrl: provider.url,
    protocol,
    skills,
    brokerActivity,
    authorityProfile: brokerAgentAuthorityProfile(agentMetadata),
    runtimePolicy: brokerAgentRuntimePolicy(endpointMetadata),
  };
}

function brokerCardAgentsForWeb(broker: ScoutBrokerContext): WebAgent[] {
  return Object.values(broker.snapshot.agents ?? {})
    .map((agent) => brokerAgentCardToWebAgent(broker, agent))
    .filter((agent): agent is WebAgent => Boolean(agent))
    .sort((left, right) =>
      (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
      || left.name.localeCompare(right.name),
    );
}

const AGENT_ATTENTION_TTL_MS = 10_000;
const AGENT_BACKGROUND_REFRESH_DELAY_MS = 500;
const AGENT_BROKER_CONTEXT_TTL_MS = 60_000;
const AGENT_BROKER_CONTEXT_COLD_BUDGET_MS = 75;
type TmuxPaneCapture = NonNullable<CreateOpenScoutWebServerOptions["captureTmuxPane"]>;
type AgentAttentionSnapshot = {
  index: Map<string, AgentAttentionEntry>;
  hostItems: TmuxHostAttentionItem[];
};

let agentAttentionCache: {
  at: number;
  capture: TmuxPaneCapture;
  snapshot: AgentAttentionSnapshot;
} | null = null;
let agentAttentionInFlight: {
  capture: TmuxPaneCapture;
  promise: Promise<AgentAttentionSnapshot>;
} | null = null;

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

function queryAgentAttentionSnapshot(
  broker: ScoutBrokerContext | null,
  capture: TmuxPaneCapture = defaultCaptureTmuxPane,
): Promise<AgentAttentionSnapshot> {
  const cached = agentAttentionCache;
  if (cached && cached.capture === capture) {
    if (Date.now() - cached.at >= AGENT_ATTENTION_TTL_MS && !agentAttentionInFlight) {
      const promise = delay(AGENT_BACKGROUND_REFRESH_DELAY_MS)
        .then(() => buildAgentAttentionIndexSnapshot(broker, capture))
        .finally(() => {
          if (agentAttentionInFlight?.promise === promise) {
            agentAttentionInFlight = null;
          }
        });
      agentAttentionInFlight = { capture, promise };
    }
    return Promise.resolve(cached.snapshot);
  }
  if (agentAttentionInFlight?.capture === capture) {
    return agentAttentionInFlight.promise;
  }
  const promise = buildAgentAttentionIndexSnapshot(broker, capture).finally(() => {
    if (agentAttentionInFlight?.promise === promise) {
      agentAttentionInFlight = null;
    }
  });
  agentAttentionInFlight = { capture, promise };
  return promise;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

async function buildAgentAttentionIndexSnapshot(
  broker: ScoutBrokerContext | null,
  capture: TmuxPaneCapture,
): Promise<AgentAttentionSnapshot> {
  try {
    const pairingSnapshots = await getScoutWebPairingSessionSnapshots().catch(() => []);
    const sessionItems = pairingSnapshots.length > 0 ? projectSessionsAttention(pairingSnapshots) : [];
    let agentIdBySessionId = new Map<string, string>();
    try {
      agentIdBySessionId = queryAgentIdsByEndpointSessionId();
    } catch {
      // A direct host-attention row already owns its agent id; a temporarily
      // unavailable read model must not suppress that independent signal.
    }
    // The broker snapshot is the live authority on which agent currently
    // holds a session — it overrides any stale endpoint row in the db.
    for (const agent of Object.values(broker?.snapshot.agents ?? {})) {
      const sessionId = broker
        ? activeEndpointForAgent(broker.snapshot, agent.id)?.sessionId?.trim()
        : null;
      if (sessionId) {
        agentIdBySessionId.set(sessionId, agent.id);
      }
    }

    // Host attention only needs the current tmux surface metadata. Resolving
    // Claude transcript identities here synchronously scans transcript
    // directories for every historical roster row before the 24-candidate
    // host-attention cap is applied, which can block the web event loop for
    // minutes on a long-lived installation.
    const databaseAgents = queryAgents();
    const brokerAgents = broker ? brokerCardAgentsForWeb(broker) : [];
    const candidatesById = new Map(databaseAgents.map((agent) => [agent.id, agent]));
    for (const agent of brokerAgents) {
      candidatesById.set(agent.id, mergeBrokerAgentProjection(candidatesById.get(agent.id) ?? agent, agent));
    }
    const hostItems = await collectTmuxHostAttention(
      [...candidatesById.values()],
      async (agent, paneTarget) => {
        const terminal = agent.terminalSurface;
        if (!terminal) return null;
        const result = await capture({
          agentId: agent.id,
          sessionId: terminal.sessionName,
          paneTarget,
          cwd: agent.cwd ?? agent.projectRoot,
          lines: 80,
          columns: 240,
        });
        return result?.body ?? null;
      },
    );
    const snapshot = {
      hostItems,
      index: buildAgentAttentionIndex({
        sessionItems,
        agentIdBySessionId,
        collaborationRows: (() => {
          try {
            return queryOperatorAttentionRows();
          } catch {
            return [];
          }
        })(),
        hostRows: hostItems,
      }),
    };
    agentAttentionCache = { at: Date.now(), capture, snapshot };
    return snapshot;
  } catch (error) {
    // Attention is a decoration on the agent list, never a reason to 500 it.
    console.warn("[openscout-web] attention snapshot failed", error);
    const cached = agentAttentionCache;
    if (cached?.capture === capture) return cached.snapshot;
    return {
      index: new Map<string, AgentAttentionEntry>(),
      hostItems: [],
    };
  }
}

function mostRecentAgents(agents: WebAgent[], limit: number | undefined): WebAgent[] {
  if (limit === undefined) return agents;
  return [...agents]
    .sort((left, right) =>
      (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
      || left.name.localeCompare(right.name),
    )
    .slice(0, limit);
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
    authorityNodeId: null,
    authorityNodeName: null,
    homeNodeId: null,
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
    const roster = mostRecentAgents(applyAgentAttention([
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

function mergeBrokerAgentProjection(local: WebAgent, broker: WebAgent | undefined): WebAgent {
  if (!broker) return local;
  return {
    ...broker,
    ...local,
    // Broker flights own work lifecycle. A local endpoint can remain `active`
    // for the lifetime of an attached harness session, so its projected
    // `working` value must not outlive the completed flight in list views.
    state: broker.state,
    updatedAt: Math.max(local.updatedAt ?? 0, broker.updatedAt ?? 0) || null,
    role: local.role ?? broker.role,
    brokerActivity: broker.brokerActivity,
    authorityProfile: broker.authorityProfile,
    runtimePolicy: broker.runtimePolicy,
  };
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

const TMUX_PEEK_DEFAULT_LINES = 44;
const TMUX_PEEK_MIN_LINES = 10;
const TMUX_PEEK_MAX_LINES = 80;
const TMUX_PEEK_DEFAULT_COLUMNS = 132;
const TMUX_PEEK_MIN_COLUMNS = 60;
const TMUX_PEEK_MAX_COLUMNS = 200;
const TMUX_PEEK_CAPTURE_MIN_LINES = 60;
const TMUX_PEEK_MAX_BYTES = 48 * 1024;

type TmuxPeekTarget = {
  sessionId: string;
  paneTarget: string;
  cwd: string | null;
};

function parseBoundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = value ? Number.parseInt(value, 10) : NaN;
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, parsed));
}

function parseTmuxPeekLineCount(value: string | undefined): number {
  return parseBoundedInteger(
    value,
    TMUX_PEEK_DEFAULT_LINES,
    TMUX_PEEK_MIN_LINES,
    TMUX_PEEK_MAX_LINES,
  );
}

function parseTmuxPeekColumnCount(value: string | undefined): number {
  return parseBoundedInteger(
    value,
    TMUX_PEEK_DEFAULT_COLUMNS,
    TMUX_PEEK_MIN_COLUMNS,
    TMUX_PEEK_MAX_COLUMNS,
  );
}

function stripTerminalControlSequences(value: string): string {
  return value.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function normalizeTmuxPeekLine(line: string, columns: number): string {
  const chars = Array.from(line);
  const clipped = chars.length > columns ? chars.slice(0, columns).join("") : line;
  const clippedLength = Array.from(clipped).length;
  return `${clipped}${" ".repeat(Math.max(0, columns - clippedLength))}`;
}

function normalizeTmuxPeekBody(body: string, lines: number, columns: number): {
  body: string;
  lineCount: number;
  columnCount: number;
  truncated: boolean;
} {
  const cleaned = stripTerminalControlSequences(body)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  const split = cleaned.endsWith("\n") ? cleaned.slice(0, -1).split("\n") : cleaned.split("\n");
  const sourceRows = split.length === 1 && split[0] === "" ? [] : split;
  const visible = sourceRows.length > lines ? sourceRows.slice(-lines) : sourceRows;
  const rows = [...visible];
  while (rows.length < lines) {
    rows.unshift("");
  }
  return {
    body: rows.map((line) => normalizeTmuxPeekLine(line, columns)).join("\n"),
    lineCount: rows.length,
    columnCount: columns,
    truncated: sourceRows.length > lines,
  };
}

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

async function defaultCaptureTmuxPane(request: TmuxPanePeekRequest): Promise<TmuxPanePeekCapture | null> {
  const body = await captureTmuxPane(request.paneTarget, {
    start: `-${Math.max(request.lines, TMUX_PEEK_CAPTURE_MIN_LINES)}`,
    end: "-",
    joinWrapped: true,
    maxBytes: TMUX_PEEK_MAX_BYTES,
  });
  return body === null ? null : { body };
}

function inferDirectTargetAgentId(
  conversationId: string | undefined,
  session: {
    kind: string;
    agentId?: string | null;
    participantIds: string[];
  } | null,
  senderId: string,
): string | null {
  if (session?.kind === "direct") {
    const operatorCandidates = new Set([
      senderId.trim(),
      "operator",
      process.env.OPENSCOUT_OPERATOR_NAME?.trim(),
      ...configuredOperatorActorIds(),
    ].filter((candidate): candidate is string => Boolean(candidate)));
    if (session.agentId) {
      const participants = session.participantIds.filter(
        (participantId) => participantId.trim().length > 0,
      );
      if (
        participants.length === 0 ||
        participants.some((participantId) => operatorCandidates.has(participantId))
      ) {
        return session.agentId;
      }
      return null;
    }

    const participants = session.participantIds.filter(
      (participantId) => participantId.trim().length > 0,
    );
    if (participants.length === 2) {
      if (!participants.some((participantId) => operatorCandidates.has(participantId))) {
        return null;
      }
      const nonOperatorParticipants = participants.filter(
        (participantId) => !operatorCandidates.has(participantId),
      );
      if (nonOperatorParticipants.length === 1) {
        return nonOperatorParticipants[0] ?? null;
      }

      const localSessionParticipant =
        nonOperatorParticipants.find((participantId) =>
          participantId.startsWith("local-session-agent-"),
        ) ??
        participants.find((participantId) =>
          participantId.startsWith("local-session-agent-"),
        );
      if (localSessionParticipant) {
        return localSessionParticipant;
      }

      return participants[0] ?? null;
    }
  }

  return null;
}

function inferDirectSenderId(
  _session: { kind: string; participantIds: string[] } | null,
  _fallbackSenderId: string,
  _directTargetAgentId: string | null,
): string {
  // Web-originated sends must use the canonical operator actor id so direct
  // chat membership stays stable while the chat id itself remains opaque.
  return "operator";
}

function sessionIncludesOperatorParticipant(session: { participantIds: string[] } | null): boolean {
  if (!session) return false;
  const operatorIds = new Set([
    "operator",
    process.env.OPENSCOUT_OPERATOR_NAME?.trim(),
    ...configuredOperatorActorIds(),
  ].filter((value): value is string => Boolean(value)));
  return session.participantIds.some((participantId) => operatorIds.has(participantId));
}

function defaultSendModeForConversationSession(input: {
  session: { kind: string; participantIds: string[] } | null;
  hasExplicitTarget: boolean;
  hasActiveRun: boolean;
}): "invoke" | "steer" | "message" {
  const isOperatorDirect =
    input.session?.kind === "direct" && sessionIncludesOperatorParticipant(input.session);
  if (!isOperatorDirect && !input.hasExplicitTarget) {
    return "message";
  }
  return input.hasActiveRun ? "steer" : "invoke";
}

type ChatMessagePlacement =
  | { kind: "root" }
  | { kind: "inline_reply"; replyToMessageId: string }
  | {
      kind: "thread_reply";
      parentConversationId: string;
      anchorMessageId: string;
      replyToMessageId?: string;
    };

function resolveChatMessagePlacement(
  chatId: string,
  replyToMessageId?: string,
): ChatMessagePlacement {
  const conversation = queryConversationDefinitionById(chatId);
  if (conversation?.parentConversationId && conversation.messageId) {
    return {
      kind: "thread_reply",
      parentConversationId: conversation.parentConversationId,
      anchorMessageId: conversation.messageId,
      ...(replyToMessageId ? { replyToMessageId } : {}),
    };
  }
  return replyToMessageId
    ? { kind: "inline_reply", replyToMessageId }
    : { kind: "root" };
}

function semanticSessionForChat(
  chatId: string,
  session: { kind: string; participantIds: string[] },
): { kind: string; participantIds: string[] } {
  // A direct Chat may be visually anchored beneath another message while
  // retaining its own direct-work semantics. Only a generic thread Chat needs
  // to inherit the parent Chat's delivery mode.
  if (session.kind !== "thread") return session;
  const definition = queryConversationDefinitionById(chatId);
  if (!definition?.parentConversationId) return session;
  return querySessionById(definition.parentConversationId) ?? session;
}

function steerContextByTargetAgentId(
  runs: ReturnType<typeof queryRuns>,
): Record<string, { runId: string; flightId?: string }> | undefined {
  const entries = new Map<string, { runId: string; flightId?: string }>();
  for (const run of runs) {
    if (entries.has(run.agentId)) continue;
    const flightId = run.flightIds?.[0];
    entries.set(run.agentId, {
      runId: run.id,
      ...(flightId ? { flightId } : {}),
    });
  }
  return entries.size > 0 ? Object.fromEntries(entries) : undefined;
}

function resolveSendSelectorTargetAgentIds(
  selectors: ReturnType<typeof extractAgentSelectors>,
  participantIds: string[],
): string[] {
  if (selectors.length === 0) return [];
  const participantIdSet = new Set(participantIds);
  const candidates = queryAgents()
    .filter((agent) => participantIdSet.has(agent.id))
    .map((agent) => ({
      agentId: agent.id,
      definitionId: agent.definitionId,
      nodeQualifier: agent.nodeQualifier ?? undefined,
      workspaceQualifier: agent.workspaceQualifier ?? undefined,
      harness: agent.harness ?? undefined,
      model: agent.model ?? undefined,
      aliases: [agent.selector, agent.defaultSelector, agent.handle, agent.name]
        .filter((alias): alias is string => Boolean(alias?.trim())),
    }));
  return [...new Set(
    selectors
      .map((selector) => resolveAgentIdentity(selector, candidates)?.agentId)
      .filter((agentId): agentId is string => Boolean(agentId)),
  )];
}

function anchoredThreadNaturalKey(parentConversationId: string, anchorMessageId: string): string {
  return `thread:${encodeURIComponent(parentConversationId)}:${encodeURIComponent(anchorMessageId)}`;
}

function deterministicThreadConversationId(parentConversationId: string, anchorMessageId: string): string {
  const digest = createHash("sha256")
    .update(`${parentConversationId}\u0000${anchorMessageId}`)
    .digest("hex")
    .slice(0, 32);
  return `chn-${digest}`;
}

function conversationDefinitionFromDb(
  row: NonNullable<ReturnType<typeof queryConversationDefinitionById>>,
): ConversationDefinition {
  return {
    id: row.id,
    kind: row.kind as ConversationDefinition["kind"],
    title: row.title,
    visibility: row.visibility as ConversationDefinition["visibility"],
    shareMode: row.shareMode as ConversationDefinition["shareMode"],
    authorityNodeId: row.authorityNodeId,
    participantIds: [...row.participantIds],
    ...(row.topic ? { topic: row.topic } : {}),
    ...(row.parentConversationId ? { parentConversationId: row.parentConversationId } : {}),
    ...(row.messageId ? { messageId: row.messageId } : {}),
    ...(row.metadata ? { metadata: row.metadata } : {}),
  };
}

function findAnchoredChildConversation(
  conversations: Record<string, ConversationDefinition>,
  parentConversationId: string,
  anchorMessageId: string,
): ConversationDefinition | null {
  return Object.values(conversations).find((conversation) =>
    conversation.parentConversationId === parentConversationId
    && conversation.messageId === anchorMessageId
  ) ?? null;
}

function requireAnchorMessageInConversation(
  broker: ScoutBrokerContext,
  parentConversationId: string,
  anchorMessageId: string,
): void {
  const anchor = broker.snapshot.messages[anchorMessageId];
  if (!anchor) {
    throw new Error(`Message ${anchorMessageId} is not available.`);
  }
  if (anchor.conversationId !== parentConversationId) {
    throw new Error(`Message ${anchorMessageId} is not in conversation ${parentConversationId}.`);
  }
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

async function createAnchoredThreadConversation(input: {
  parentConversationId: string;
  anchorMessageId: string;
  title?: string | null;
}): Promise<{ conversation: ConversationDefinition; existed: boolean }> {
  const broker = await loadScoutBrokerContext();
  if (!broker) {
    throw new Error("broker unreachable");
  }

  const parentRow = queryConversationDefinitionById(input.parentConversationId);
  const parent = parentRow
    ? conversationDefinitionFromDb(parentRow)
    : broker.snapshot.conversations[input.parentConversationId] ?? null;
  if (!parent) {
    throw new Error(`Conversation ${input.parentConversationId} is not available.`);
  }
  if (parent.parentConversationId) {
    throw new Error("Nested threads are not supported.");
  }
  requireAnchorMessageInConversation(broker, input.parentConversationId, input.anchorMessageId);

  const existing = findAnchoredChildConversation(
    broker.snapshot.conversations,
    input.parentConversationId,
    input.anchorMessageId,
  );
  if (existing) {
    return { conversation: existing, existed: true };
  }

  const naturalKey = anchoredThreadNaturalKey(input.parentConversationId, input.anchorMessageId);
  const deterministicId = deterministicThreadConversationId(input.parentConversationId, input.anchorMessageId);
  const deterministicExisting = broker.snapshot.conversations[deterministicId];
  if (deterministicExisting) {
    return { conversation: deterministicExisting, existed: true };
  }

  const title = input.title?.trim()
    || `Thread · ${parent.title}`;
  const conversation: ConversationDefinition = {
    id: deterministicId,
    kind: "thread",
    title,
    visibility: parent.visibility,
    shareMode: parent.shareMode,
    authorityNodeId: parent.authorityNodeId,
    participantIds: [...parent.participantIds],
    parentConversationId: input.parentConversationId,
    messageId: input.anchorMessageId,
    metadata: {
      naturalKey,
      source: "scout-web",
      parentConversationId: input.parentConversationId,
      anchorMessageId: input.anchorMessageId,
    },
  };
  await upsertScoutConversation(conversation);
  return { conversation, existed: false };
}

function inferChannelName(
  _conversationId: string | undefined,
  _session: { kind: string } | null,
): string | null {
  return null;
}

function resolveConversationRouting(
  conversationId: string | undefined,
  sessionOverride?: {
    kind: string;
    agentId?: string | null;
    participantIds: string[];
  } | null,
): {
  directAgentId: string | null;
  channel: string | null;
  conversationId: string | null;
  senderId: string;
} {
  const fallbackSenderId = "operator";
  const session = sessionOverride
    ?? (conversationId ? querySessionById(conversationId) : null);
  const senderId = inferDirectSenderId(
    session,
    fallbackSenderId,
    null,
  );
  if (session && conversationId) {
    const channel = inferChannelName(conversationId, session);
    if (channel) {
      return {
        directAgentId: null,
        channel,
        conversationId: null,
        senderId,
      };
    }
    return {
      directAgentId: null,
      channel: null,
      conversationId,
      senderId,
    };
  }
  const directAgentId = inferDirectTargetAgentId(
    conversationId,
    session,
    fallbackSenderId,
  );
  const channel = directAgentId
    ? null
    : inferChannelName(conversationId, session);
  return { directAgentId, channel, conversationId: null, senderId };
}

function resolveConversationAskRouting(conversationId: string | undefined): {
  directAgentId: string | null;
  senderId: string;
} {
  const fallbackSenderId = "operator";
  const session = conversationId ? querySessionById(conversationId) : null;
  const directAgentId = inferDirectTargetAgentId(
    conversationId,
    session,
    fallbackSenderId,
  );
  const senderId = inferDirectSenderId(
    session,
    fallbackSenderId,
    directAgentId,
  );
  return { directAgentId, senderId };
}

function conversationKindAfterMemberMutation(
  kind: ConversationDefinition["kind"],
  participantIds: string[],
): ConversationDefinition["kind"] {
  if (kind === "direct" && participantIds.length > 2) {
    return "group_direct";
  }
  if (kind === "group_direct" && participantIds.length <= 2) {
    return "direct";
  }
  return kind;
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
  const observedHarnessSession = input.harness === "claude"
    ? mostRecentClaudeSessionForCwd(input.cwd)
    : null;
  const discoveredHarnessSessionId = firstMetadataString(input.nativeTranscript?.sessionId);
  const harnessNativeSessionId = firstMetadataString(
    endpointMetadata.externalSessionId,
    endpointMetadata.threadId,
    observedHarnessSession?.sessionId,
    discoveredHarnessSessionId,
  );
  const runtimeSessionId = firstMetadataString(input.activeSessionId, input.endpoint?.sessionId);
  const terminalSurface = input.terminalSurface ?? resolveTerminalSurface({
    transport: input.transport,
    endpointSessionId: input.activeSessionId,
    metadata: endpointMetadata,
  });
  const fallbackTerminalSessionId = terminalSurface
    ? input.activeSessionId ?? terminalSurface.sessionName
    : null;
  const catalogActiveMatchesProfile = Boolean(
    catalogActiveSession
    && (!input.harness || !catalogActiveSession.harness || catalogActiveSession.harness === input.harness)
    && (!input.transport || !catalogActiveSession.transport || catalogActiveSession.transport === input.transport),
  );
  const sessionId = catalogActiveMatchesProfile
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
  const sessionHistoryPath = historyPath ?? observedHarnessSession?.transcriptPath ?? input.nativeTranscript?.transcriptPath ?? null;
  const provider = firstMetadataString(endpointMetadata.provider);
  const source = firstMetadataString(endpointMetadata.source) ?? "broker-endpoint";
  const startedAt = metadataTimestampMs(endpointMetadata.lastStartedAt)
    ?? metadataTimestampMs(endpointMetadata.startedAt)
    ?? input.startedAt
    ?? Date.now();
  const sessions = sessionId && !catalog.sessions.some((session) => session.id === sessionId)
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
          ...(endpointMetadata.externalSessionId ? { externalSessionId: endpointMetadata.externalSessionId } : {}),
          ...(endpointMetadata.threadId ?? (input.harness === "codex" ? harnessNativeSessionId : null)
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
        ...catalog.sessions,
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

function resolveBundledStaticClientRoot(
  moduleUrl: string | URL = import.meta.url,
): string {
  return resolve(dirname(fileURLToPath(moduleUrl.toString())), "client");
}

function normalizeRequestHost(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .split(":")[0]
    ?.replace(/^\[/, "")
    .replace(/\]$/, "")
    .toLowerCase() ?? "";
}

function expandHomePath(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

function resolveExplorablePath(
  targetPath: string,
  basePath: string | null | undefined,
  currentDirectory: string,
): string {
  const expandedTarget = expandHomePath(targetPath.trim());
  const expandedBase = basePath?.trim()
    ? expandHomePath(basePath.trim())
    : currentDirectory;
  return resolve(expandedBase, expandedTarget);
}

function realpathIfExists(targetPath: string): string | null {
  try {
    return realpathSync(targetPath);
  } catch {
    return null;
  }
}

function resolveObservedPath(
  targetPath: string,
  cwd: string | null | undefined,
): string | null {
  const expanded = expandHomePath(targetPath.trim());
  if (!expanded) {
    return null;
  }
  if (isAbsolute(expanded)) {
    return resolve(expanded);
  }
  if (!cwd?.trim()) {
    return null;
  }
  return resolve(expandHomePath(cwd.trim()), expanded);
}


async function defaultRevealLocalPath(targetPath: string): Promise<void> {
  if (!existsSync(targetPath)) {
    throw new Error("Path does not exist.");
  }

  const stats = statSync(targetPath);
  const directory = stats.isDirectory() ? targetPath : dirname(targetPath);
  if (process.platform === "darwin") {
    await execSystemFile("open", stats.isDirectory() ? [targetPath] : ["-R", targetPath], { timeoutMs: 1_500 });
    return;
  }
  if (process.platform === "win32") {
    await execSystemFile("explorer.exe", stats.isDirectory() ? [targetPath] : [`/select,${targetPath}`], { timeoutMs: 1_500 });
    return;
  }

  await execSystemFile("xdg-open", [directory], { timeoutMs: 1_500 });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function severityRank(severity: OperatorAttentionItem["severity"]): number {
  switch (severity) {
    case "critical":
      return 0;
    case "warning":
      return 1;
    default:
      return 2;
  }
}

function compactAttentionSummary(value: string | null | undefined, max = 220): string | null {
  const compacted = (value ?? "").replace(/\s+/g, " ").trim();
  if (!compacted) {
    return null;
  }
  return compacted.length > max ? `${compacted.slice(0, max - 1)}...` : compacted;
}


type BrokerDispatchReviewAttempt = ReturnType<typeof queryBrokerDiagnostics>["attempts"][number];

function normalizeBrokerFingerprintPart(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 220);
}

function brokerReviewMetadata(attempt: BrokerDispatchReviewAttempt): Record<string, unknown> {
  return recordInput(attempt.metadata) ?? {};
}

function brokerReviewRawDeliveryMetadata(attempt: BrokerDispatchReviewAttempt): Record<string, unknown> | null {
  const metadata = brokerReviewMetadata(attempt);
  const raw = recordInput(metadata.raw);
  const delivery = recordInput(raw?.delivery);
  return recordInput(delivery?.metadata);
}

function brokerAttemptReviewFingerprint(attempt: BrokerDispatchReviewAttempt): string {
  const metadata = brokerReviewMetadata(attempt);
  const messageId = attempt.messageId ?? metadataStringValue(metadata, "messageId");
  const target = attempt.target ?? metadataStringValue(metadata, "targetId");
  const transport = attempt.route ?? metadataStringValue(metadata, "transport");
  if (attempt.kind === "failed_delivery" && messageId && target && transport) {
    return ["failed_delivery", messageId, target, transport].join("|");
  }

  return [
    attempt.kind,
    messageId ?? attempt.deliveryId ?? attempt.invocationId ?? attempt.id,
    target,
    transport,
    metadataStringValue(metadata, "failureReason")
      ?? metadataStringValue(metadata, "reconciledReason")
      ?? metadataStringValue(metadata, "reason")
      ?? metadataStringValue(metadata, "error")
      ?? attempt.detail,
  ]
    .filter((value): value is string => Boolean(value && value.trim()))
    .map(normalizeBrokerFingerprintPart)
    .join("|");
}

function brokerAttemptReviewRootCauseFingerprint(attempt: BrokerDispatchReviewAttempt): string {
  const metadata = brokerReviewMetadata(attempt);
  const deliveryMetadata = brokerReviewRawDeliveryMetadata(attempt);
  return [
    attempt.kind,
    attempt.target ?? metadataStringValue(metadata, "targetId"),
    attempt.route ?? metadataStringValue(metadata, "transport"),
    metadataStringValue(metadata, "failureReason")
      ?? metadataStringValue(metadata, "reconciledReason")
      ?? metadataStringValue(metadata, "error")
      ?? metadataStringValue(deliveryMetadata, "failureReason")
      ?? metadataStringValue(deliveryMetadata, "reconciledReason")
      ?? metadataStringValue(deliveryMetadata, "error")
      ?? attempt.status,
    metadataStringValue(metadata, "failureDetail")
      ?? metadataStringValue(deliveryMetadata, "failureDetail")
      ?? metadataStringValue(metadata, "reason")
      ?? attempt.detail,
  ]
    .filter((value): value is string => Boolean(value && value.trim()))
    .map((value) => normalizeBrokerFingerprintPart(value).toLowerCase())
    .join("|");
}

function brokerAttemptReviewContextText(input: {
  attempt: BrokerDispatchReviewAttempt;
  related: BrokerDispatchReviewAttempt[];
  windowMs: number;
}): string {
  const fingerprint = brokerAttemptReviewFingerprint(input.attempt);
  const rootCauseFingerprint = brokerAttemptReviewRootCauseFingerprint(input.attempt);
  const context = {
    generatedAt: new Date().toISOString(),
    windowMs: input.windowMs,
    dedupeFingerprint: fingerprint,
    rootCauseFingerprint,
    attempt: input.attempt,
    relatedAttempts: input.related,
  };
  return [
    "OpenScout dispatch failure context",
    "",
    `id: ${input.attempt.id}`,
    `kind: ${input.attempt.kind}`,
    `status: ${input.attempt.status}`,
    `time: ${new Date(input.attempt.ts).toISOString()}`,
    `target: ${input.attempt.target ?? "none"}`,
    `transport/route: ${input.attempt.route ?? "none"}`,
    `messageId: ${input.attempt.messageId ?? "none"}`,
    `deliveryId: ${input.attempt.deliveryId ?? "none"}`,
    `invocationId: ${input.attempt.invocationId ?? "none"}`,
    `conversationId: ${input.attempt.conversationId ?? "none"}`,
    `detail: ${input.attempt.detail}`,
    `dedupeFingerprint: ${fingerprint}`,
    `rootCauseFingerprint: ${rootCauseFingerprint}`,
    "",
    "Full JSON:",
    JSON.stringify(context, null, 2),
  ].join("\n");
}

function brokerDispatchReviewPrompt(input: {
  attempt: BrokerDispatchReviewAttempt;
  related: BrokerDispatchReviewAttempt[];
  windowMs: number;
}): string {
  return [
    "Review this from first principles, then inspect the relevant implementation.",
    "",
    "Topic: OpenScout failed dispatch / failed delivery",
    "Workspace: /Users/art/dev/openscout",
    "",
    "User goal:",
    "- Diagnose this failed dispatch from the Dispatch screen.",
    "- Identify the root cause and the narrowest fix.",
    "- Explain how to avoid readdressing the same failure cluster in the recurring triage loop.",
    "",
    "Observed failed dispatch context:",
    "```text",
    brokerAttemptReviewContextText(input),
    "```",
    "",
    "Please answer:",
    "1. What is the likely root cause? Distinguish symptom from cause.",
    "2. Is this a duplicate of an already-known failure cluster? Use the dedupe fingerprint and related rows.",
    "3. What code change, config fix, or operational action should resolve it?",
    "4. What checks would prove the fix?",
    "",
    "Response contract:",
    "- Keep the message short: one sentence for cause and next move, then an `Evidence` list.",
    "- Make the Evidence list most of the response. Prefer precise pointers to Scout data and messages",
    "  (`messageId`, `deliveryId`, `conversationId`, `invocationId`, or attempt id), stack/log source plus",
    "  timestamp or range, and implementation `file:line` or the exact verification command.",
    "- Do not paste the supplied JSON or long log excerpts back. Quote at most one short line when a pointer alone is ambiguous.",
    "- If a claim has no supporting pointer, label it as an inference or missing evidence.",
    "",
    "Do not edit files unless the user explicitly asks in a follow-up.",
  ].join("\n");
}

function buildScoutEntityId(prefix: string, createdAtMs: number): string {
  return `${prefix}-${createdAtMs.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function dismissCollaborationAction(recordKind: CollaborationKind, recordId: string): OperatorAttentionItem["actions"][number] {
  return {
    kind: "dismiss",
    label: "Dismiss",
    recordKind,
    recordId,
  };
}

async function dismissCollaborationAttention(input: {
  recordKind: CollaborationKind;
  recordId: string;
  itemUpdatedAt: number;
}): Promise<void> {
  const at = Date.now();
  const event: CollaborationEvent = {
    id: buildScoutEntityId("evt", at),
    recordId: input.recordId,
    recordKind: input.recordKind,
    kind: "dismissed",
    actorId: "operator",
    at,
    summary: "Dismissed from operator queue.",
    metadata: {
      source: "openscout-web",
      itemUpdatedAt: input.itemUpdatedAt,
    },
  };
  await appendScoutCollaborationEvent(event);
}

type MeshOpsActuation = "hold" | "release" | "accept" | "clear";
type MeshOpsRecordActuation = Exclude<MeshOpsActuation, "clear">;

/**
 * Build the record mutation + audit event for a Mesh Ops actuation. The
 * caller posts both through the broker (canonical writer): the record via
 * collaboration.upsert, the event via collaboration.event.append (which also
 * fires the SSE collaboration.event.appended).
 *
 *  - hold:    any active state → waiting, waitingOn = "Held by operator",
 *             next move to the operator.
 *  - release: → open (or working while flights are still active), waitingOn
 *             cleared, next move back to the owner.
 *  - accept:  only from review → done + acceptanceState accepted.
 *
 * Clear is an attention dismissal, not a record mutation, and is handled
 * separately by the route so stale dismiss intent can never accept review.
 */
function buildMeshOpsActuation(
  record: WorkItemRecord,
  action: MeshOpsRecordActuation,
  at: number,
): { record: WorkItemRecord; event: CollaborationEvent } {
  const operatorId = "operator";
  const baseEvent = {
    id: buildScoutEntityId("evt", at),
    recordId: record.id,
    recordKind: "work_item" as const,
    actorId: operatorId,
    at,
    metadata: {
      source: "openscout-web",
      surface: "mesh-ops",
    },
  };

  if (action === "hold") {
    return {
      record: {
        ...record,
        state: "waiting",
        waitingOn: { kind: "condition", label: "Held by operator" },
        nextMoveOwnerId: operatorId,
        updatedAt: at,
      },
      event: {
        ...baseEvent,
        kind: "waiting",
        summary: "Held by operator.",
      },
    };
  }

  if (action === "release") {
    const hasActiveFlights = queryMeshOpsActiveFlightCount(record.id) > 0;
    return {
      record: {
        ...record,
        state: hasActiveFlights ? "working" : "open",
        waitingOn: undefined,
        nextMoveOwnerId: record.ownerId ?? record.createdById,
        updatedAt: at,
      },
      event: {
        ...baseEvent,
        kind: "progressed",
        summary: "Released by operator.",
      },
    };
  }

  // Clear is handled as an attention dismissal before this builder. The only
  // remaining terminal transition is the explicit accept intent.
  return {
    record: {
      ...record,
      state: "done",
      acceptanceState: "accepted",
      completedAt: record.completedAt ?? at,
      updatedAt: at,
    },
    event: {
      ...baseEvent,
      kind: "accepted",
      summary: "Accepted by operator.",
    },
  };
}

async function dismissFlightAttention(input: {
  flightId: string;
  itemUpdatedAt: number;
}): Promise<void> {
  let flight = null;
  try {
    flight = queryFlightRecordById(input.flightId);
  } catch {
    // The live broker can be ahead of the read-only SQLite projection. Fall
    // through to the canonical broker snapshot instead of making a freshly
    // failed flight impossible to acknowledge.
  }
  if (!flight) {
    const broker = await loadScoutBrokerContext().catch(() => null);
    flight = broker?.snapshot.flights?.[input.flightId] ?? null;
  }
  if (!flight) {
    throw new Error("flight not found");
  }
  await upsertScoutFlight({
    ...flight,
    metadata: {
      ...(flight.metadata ?? {}),
      operatorAttentionDismissedAt: Date.now(),
      operatorAttentionItemUpdatedAt: input.itemUpdatedAt,
      operatorAttentionDismissedBy: "operator",
    },
  });
}

async function dismissConversationFailureAttention(input: {
  conversationId: string;
  messageId: string;
  itemUpdatedAt: number;
}): Promise<void> {
  const broker = await loadScoutBrokerContext().catch(() => null);
  const conversation = broker?.snapshot.conversations?.[input.conversationId];
  if (!conversation) {
    throw new Error("conversation not found");
  }
  await upsertScoutConversation({
    ...conversation,
    metadata: {
      ...(conversation.metadata ?? {}),
      operatorAttentionDismissedMessageId: input.messageId,
      operatorAttentionDismissedAt: Date.now(),
      operatorAttentionItemUpdatedAt: input.itemUpdatedAt,
      operatorAttentionDismissedBy: "operator",
    },
  });
}

let cachedWebPackageVersion: string | null | undefined;

function readWebPackageVersion(): string | null {
  if (cachedWebPackageVersion !== undefined) {
    return cachedWebPackageVersion;
  }
  try {
    const packagePath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: unknown };
    cachedWebPackageVersion = typeof parsed.version === "string" && parsed.version.trim()
      ? parsed.version.trim()
      : null;
  } catch {
    cachedWebPackageVersion = null;
  }
  return cachedWebPackageVersion;
}

function openScoutBuildInfoFromGit(value: GitBuildInfo | null): OpenScoutBuildInfo {
  const bunVersion = process.versions.bun;
  return {
    version: readWebPackageVersion(),
    branch: value?.branch ?? value?.bootBranch ?? null,
    commit: value?.commit ?? null,
    dirty: value?.dirty ?? null,
    mode: process.env.NODE_ENV === "production" ? "production" : "dev",
    server: {
      engine: bunVersion ? "bun" : "node",
      engineVersion: bunVersion ?? process.versions.node,
      nodeVersion: process.versions.node,
      platform: process.platform,
      arch: process.arch,
    },
  };
}

function loadOpenScoutBuildInfo(currentDirectory: string): OpenScoutBuildInfo {
  return openScoutBuildInfoFromGit(gitBuildInfoProbe.for(currentDirectory).read().value);
}

async function warmOpenScoutBuildInfo(currentDirectory: string): Promise<OpenScoutBuildInfo> {
  const snapshot = await gitBuildInfoProbe.for(currentDirectory).fresh({ maxAgeMs: 60_000 });
  return openScoutBuildInfoFromGit(snapshot.value);
}

async function refreshOpenScoutBuildInfo(currentDirectory: string): Promise<OpenScoutBuildInfo> {
  const probe = gitBuildInfoProbe.for(currentDirectory);
  probe.invalidate("operator requested build refresh");
  const snapshot = await probe.fresh({ maxAgeMs: 0 });
  return openScoutBuildInfoFromGit(snapshot.value);
}

async function resolveOpenScoutBuildInfo(currentDirectory: string, refresh: boolean): Promise<OpenScoutBuildInfo> {
  if (refresh) return refreshOpenScoutBuildInfo(currentDirectory);
  const cached = gitBuildInfoProbe.for(currentDirectory).read();
  if (cached.value) return openScoutBuildInfoFromGit(cached.value);
  return warmOpenScoutBuildInfo(currentDirectory);
}


function permissionSetupHint(detail: string): OperatorAttentionItem | null {
  const normalized = detail.toLowerCase();
  const mentionsPermission = /permission|approval|allow|blocked/.test(normalized);
  const mentionsScoutMcpReply =
    /\bmcp__?scout__messages_reply\b/.test(normalized) ||
    /\bmcp\b.*\bmessages_reply\b/.test(normalized);
  const mentionsScoutMcpAsk =
    /\bmcp__?scout__ask\b/.test(normalized) ||
    /\bmcp\b.*\bscout ask\b/.test(normalized);
  const mentionsScoutMcpTool = mentionsScoutMcpReply || mentionsScoutMcpAsk;
  const mentionsScoutTool = /scout ask|allowedtools|allowlist/.test(normalized) || mentionsScoutMcpTool;
  if (!mentionsPermission || !mentionsScoutTool) {
    return null;
  }

  const replyTool = mentionsScoutMcpReply;
  const command = mentionsScoutMcpTool
    ? `/allow ${replyTool ? "mcp__scout__messages_reply" : "mcp__scout__ask"}`
    : `{ "allowedTools": ["Bash(scout:*)"] }`;
  const title = mentionsScoutMcpTool
    ? "Claude needs Scout MCP permission"
    : "Claude needs Scout CLI permission";
  const remediationDetail = mentionsScoutMcpTool
    ? "This is a Claude-session permission. Copy the /allow line, paste it into the blocked Claude session, then retry the Scout request."
    : "This is a Claude-session permission. Copy the allowed-tools snippet into the blocked Claude session or project settings, then retry the Scout request.";

  return {
    id: `config:${mentionsScoutMcpTool ? `mcp-scout-${replyTool ? "messages-reply" : "ask"}` : "scout-ask-cli"}`,
    kind: "configuration",
    title,
    summary: compactAttentionSummary(detail),
    detail: remediationDetail,
    agentId: null,
    agentName: null,
    conversationId: null,
    updatedAt: Date.now(),
    severity: "critical",
    sourceLabel: "Claude permissions",
    actions: [
      {
        kind: "copy",
        label: "Copy Claude fix",
        value: command,
      },
    ],
  };
}

function dedupeAttentionItems(items: OperatorAttentionItem[]): OperatorAttentionItem[] {
  const byId = new Map<string, OperatorAttentionItem>();
  for (const item of items) {
    const existing = byId.get(item.id);
    if (!existing || item.updatedAt > existing.updatedAt) {
      byId.set(item.id, item);
    }
  }
  return [...byId.values()].sort((left, right) => {
    const bySeverity = severityRank(left.severity) - severityRank(right.severity);
    if (bySeverity !== 0) {
      return bySeverity;
    }
    return right.updatedAt - left.updatedAt;
  });
}

function operatorAttentionFromSessionItem(item: SessionAttentionItem): OperatorAttentionItem {
  const route = {
    view: "follow",
    sessionId: item.sessionId,
    preferredView: "session",
  };
  const approvalActions = item.kind === "approval" && item.approval
    ? [
        { kind: "approve" as const, label: "Approve" },
        { kind: "deny" as const, label: "Deny" },
      ]
    : [];
  const openAction = {
    kind: "open" as const,
    label: "Open session",
    route,
  };

  return {
    id: item.id,
    kind: item.kind === "approval"
      ? "approval"
      : item.kind === "question"
        ? "question"
        : "session",
    title: item.title,
    summary: item.summary,
    detail: item.detail,
    agentId: null,
    agentName: item.sessionName,
    conversationId: null,
    updatedAt: item.updatedAt,
    severity: item.severity,
    sourceLabel: item.sourceLabel,
    ...(item.approval ? { approval: item.approval } : {}),
    actions: [
      ...approvalActions,
      openAction,
    ],
  };
}

async function buildOperatorAttentionState(
  currentDirectory: string,
  capture: TmuxPaneCapture = defaultCaptureTmuxPane,
) {
  const [pairing, pairingSnapshots, fleet, brokerDiagnostics, scoutBroker] = await Promise.all([
    loadPairingState(currentDirectory, false).catch(() => null),
    getScoutWebPairingSessionSnapshots().catch(() => []),
    Promise.resolve(queryFleet({ limit: 24, activityLimit: 120 })),
    Promise.resolve(queryBrokerDiagnostics({ limit: 160, windowMs: 24 * 60 * 60_000 })),
    loadScoutBrokerContext().catch(() => null),
  ]);
  const hostAttention = await queryAgentAttentionSnapshot(scoutBroker, capture);

  const items: OperatorAttentionItem[] = [];
  const pendingApprovalIds = new Set<string>();

  for (const approval of pairing?.pendingApprovals ?? []) {
    const approvalId = sessionApprovalAttentionId(
      approval.sessionId,
      approval.turnId,
      approval.blockId,
      approval.version,
    );
    pendingApprovalIds.add(approvalId);
    items.push({
      id: approvalId,
      kind: "approval",
      title: approval.title,
      summary: approval.description,
      detail: approval.detail,
      agentId: null,
      agentName: approval.sessionName,
      conversationId: null,
      updatedAt: Date.now(),
      severity: approval.risk === "high" ? "critical" : "warning",
      sourceLabel: `${approval.adapterType} approval`,
      approval,
      actions: [
        { kind: "approve", label: "Approve" },
        { kind: "deny", label: "Deny" },
        {
          kind: "open",
          label: "Open session",
          route: {
            view: "follow",
            sessionId: approval.sessionId,
            preferredView: "session",
          },
        },
      ],
    });
  }

  for (const sessionItem of projectSessionsAttention(pairingSnapshots, { pendingApprovalIds })) {
    items.push(operatorAttentionFromSessionItem(sessionItem));
  }

  for (const hostItem of hostAttention.hostItems) {
    items.push({
      id: hostItem.id,
      kind: "session",
      title: hostItem.title,
      summary: hostItem.summary,
      detail: hostItem.detail,
      agentId: hostItem.agentId,
      agentName: hostItem.agentName,
      conversationId: null,
      updatedAt: hostItem.updatedAt,
      severity: "warning",
      sourceLabel: hostItem.sourceLabel,
      actions: [{
        kind: "open",
        label: "Open terminal",
        route: {
          view: "terminal",
          agentId: hostItem.agentId,
          mode: "takeover",
        },
      }],
    });
  }

  for (const work of fleet.needsAttention) {
    const route = work.conversationId
      ? { view: "conversation", conversationId: work.conversationId }
      : work.kind === "work_item" && work.recordId
        ? {
            view: "follow",
            workId: work.recordId,
            preferredView: "chat",
            ...(work.agentId ? { targetAgentId: work.agentId } : {}),
          }
        : work.agentId
          ? { view: "agents-v2", agentId: work.agentId, tab: "message" }
          : undefined;
    items.push({
      id: `${work.kind}:${work.recordId}`,
      kind: work.kind,
      title: work.title,
      summary: work.summary,
      detail: work.acceptanceState !== "none"
        ? work.acceptanceState.replace(/_/g, " ")
        : work.state.replace(/_/g, " "),
      agentId: work.agentId,
      agentName: work.agentName,
      conversationId: work.conversationId,
      updatedAt: work.updatedAt,
      severity: work.state === "waiting" ? "warning" : "info",
      sourceLabel: "Work item",
      actions: [
        ...(route ? [{ kind: "open" as const, label: "Open", route }] : []),
        dismissCollaborationAction(work.kind, work.recordId),
      ],
    });
  }

  for (const ask of fleet.recentCompleted.filter((item) => item.status === "failed" && item.attention !== "silent")) {
    const noteworthy = ask.attention === "badge";
    const noteworthyTitle = ask.statusLabel === "Stopped" ? "Ask stopped" : "Ask interrupted";
    items.push({
      id: `ask:${ask.invocationId}`,
      kind: "ask",
      title: noteworthy ? noteworthyTitle : "Ask failed",
      summary: compactAttentionSummary(ask.summary ?? ask.task),
      detail: ask.task,
      agentId: ask.agentId,
      agentName: ask.agentName,
      conversationId: ask.conversationId,
      updatedAt: ask.updatedAt,
      severity: noteworthy ? "warning" : "critical",
      sourceLabel: noteworthy ? "Ask notice" : "Ask delivery",
      actions: [
        ...(ask.conversationId
          ? [{ kind: "open" as const, label: "Open thread", route: { view: "conversation", conversationId: ask.conversationId } }]
          : [{ kind: "open" as const, label: "Open agent", route: { view: "agents-v2", agentId: ask.agentId } }]),
        ...(ask.flightId ? [{ kind: "dismiss" as const, label: "Dismiss", flightId: ask.flightId }] : []),
      ],
    });
  }

  for (const failure of [...brokerDiagnostics.failedDeliveries, ...brokerDiagnostics.failedQueries]) {
    const hint = permissionSetupHint(failure.detail);
    if (!hint) {
      continue;
    }
    items.push({
      ...hint,
      id: `${hint.id}:${failure.id}`,
      agentName: failure.target,
      conversationId: failure.conversationId,
      updatedAt: failure.ts,
      actions: [
        ...hint.actions,
        ...(failure.conversationId
          ? [{
              kind: "open" as const,
              label: "Open thread",
              route: { view: "conversation", conversationId: failure.conversationId },
            }]
          : []),
      ],
    });
  }

  for (const message of brokerDiagnostics.dialogue) {
    if (message.actorName !== "Openscout") {
      continue;
    }
    const hint = permissionSetupHint(message.body);
    if (!hint) {
      continue;
    }
    items.push({
      ...hint,
      id: `${hint.id}:${message.conversationId}`,
      agentName: message.actorName,
      conversationId: message.conversationId,
      updatedAt: message.ts,
      actions: [
        ...hint.actions,
        {
          kind: "open" as const,
          label: "Open thread",
          route: { view: "conversation", conversationId: message.conversationId },
        },
      ],
    });
  }

  const deduped = dedupeAttentionItems(items);
  return {
    generatedAt: Date.now(),
    totals: {
      all: deduped.length,
      approvals: deduped.filter((item) => item.kind === "approval").length,
      configuration: deduped.filter((item) => item.kind === "configuration").length,
      collaboration: deduped.filter((item) =>
        item.kind === "ask"
        || item.kind === "work_item"
        || item.kind === "question"
        || item.kind === "session"
      ).length,
    },
    items: deduped,
  };
}


function renderScoutLocalPortal(input: {
  requestUrl: string;
  portalHost: string;
  nodeHost: string;
}): string {
  const url = new URL(input.requestUrl);
  const port = url.port ? `:${url.port}` : "";
  const nodeUrl = `${url.protocol}//${input.nodeHost}${port}/`;
  const nodeHost = escapeHtml(input.nodeHost);
  const portalHost = escapeHtml(input.portalHost);
  const escapedNodeUrl = escapeHtml(nodeUrl);
  // Quiet ledger doorway (design study: design/portal-studies/scout-local-quiet-ledger.html).
  // One identity cluster, one live wavefront instrument, one ledger line per
  // node, one trust line. No accent hue: ink plus stepped warm greys only.
  // Keep this page self-contained (inline CSS/JS only) — it is served before
  // the SPA shell and must not depend on client assets.
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Scout Local</title>
    <style>
      :root {
        color-scheme: light dark;
        --bg: #0a0a09;
        --ink: #f1ece1;
        --ink-2: #a49d90;
        --ink-3: #6f6960;
        --edge: #23221f;
        --edge-2: #3d3a34;
        --hover: color-mix(in srgb, var(--ink) 3.5%, transparent);
        --t0: #2e2b27;
        --t1: #474339;
        --t2: #6b6558;
        --t3: #968e7f;
        --t4: #d5cdbd;
        --sans: "Inter Tight", Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
      }
      @media (prefers-color-scheme: light) {
        :root {
          color-scheme: light;
          --bg: #f3f1ea;
          --ink: #171914;
          --ink-2: #5f5d52;
          --ink-3: #6b685c;
          --edge: #dcd9cb;
          --edge-2: #b9b5a4;
          --t0: #d2cec2;
          --t1: #a6a08d;
          --t2: #757061;
          --t3: #49463d;
          --t4: #1f211b;
        }
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        align-content: center;
        justify-items: stretch;
        padding: 40px 32px;
        background: var(--bg);
        color: var(--ink);
        font-family: var(--sans);
        -webkit-font-smoothing: antialiased;
      }
      main { width: 100%; max-width: 720px; min-width: 0; margin-inline: auto; }
      @keyframes settle {
        from { opacity: 0; transform: translateY(10px); }
      }
      .rise { animation: settle 640ms cubic-bezier(0.16, 1, 0.3, 1) both; }
      .rise-2 { animation-delay: 90ms; }
      .rise-3 { animation-delay: 170ms; }
      @media (prefers-reduced-motion: reduce) {
        .rise { animation: none; }
      }
      .hero {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 32px 48px;
        align-items: center;
        margin-bottom: 48px;
      }
      .brand {
        display: flex;
        align-items: center;
        gap: 9px;
        margin-bottom: 26px;
      }
      .sigil { display: block; color: var(--ink-2); }
      .host {
        font-family: var(--mono);
        font-size: 12px;
        letter-spacing: 0.02em;
        color: var(--ink-2);
      }
      h1 {
        margin: 0 0 14px;
        font-size: clamp(36px, 4.6vw, 46px);
        font-weight: 560;
        letter-spacing: -0.03em;
        line-height: 1.05;
      }
      .lede {
        margin: 0;
        max-width: 44ch;
        font-size: 15px;
        line-height: 1.6;
        color: var(--ink-2);
      }
      .field {
        display: block;
        position: relative;
        color: inherit;
        text-decoration: none;
        cursor: pointer;
        touch-action: manipulation;
        user-select: none;
        -webkit-mask-image: radial-gradient(ellipse 70% 72% at 50% 50%, #000 55%, transparent 100%);
        mask-image: radial-gradient(ellipse 70% 72% at 50% 50%, #000 55%, transparent 100%);
      }
      .field:focus-visible {
        outline: 1px solid var(--ink-2);
        outline-offset: 6px;
      }
      .field__layer {
        margin: 0;
        font-family: var(--mono);
        font-size: 10px;
        line-height: 1.1;
        white-space: pre;
        letter-spacing: 0;
      }
      .field__layer + .field__layer { position: absolute; inset: 0; }
      .field__layer[data-t="0"] { color: var(--t0); }
      .field__layer[data-t="1"] { color: var(--t1); }
      .field__layer[data-t="2"] { color: var(--t2); }
      .field__layer[data-t="3"] { color: var(--t3); }
      .field__layer[data-t="4"] { color: var(--t4); }
      .node {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 20px;
        padding: 18px 6px;
        border-top: 1px solid var(--edge);
        border-bottom: 1px solid var(--edge);
        text-decoration: none;
        color: inherit;
        transition: background-color 140ms ease;
      }
      .node:hover { background: var(--hover); }
      .node:focus-visible {
        outline: 1px solid var(--ink-2);
        outline-offset: 3px;
      }
      .node__id { display: grid; gap: 4px; min-width: 0; }
      .node__host {
        font-family: var(--mono);
        font-size: 14px;
        letter-spacing: -0.01em;
        color: var(--ink);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .node__sub { font-size: 12px; color: var(--ink-3); }
      .node__open {
        flex: none;
        font-family: var(--mono);
        font-size: 11px;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: var(--ink-3);
        transition: color 140ms ease;
      }
      .node:hover .node__open,
      .node:focus-visible .node__open { color: var(--ink); }
      .trust {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px 14px;
        margin-top: 20px;
        padding-inline: 6px;
        font-family: var(--mono);
        font-size: 11px;
        letter-spacing: 0.03em;
        color: var(--ink-3);
      }
      .trust a {
        color: var(--ink-2);
        text-decoration: none;
        border-bottom: 1px solid transparent;
        transition: color 140ms ease, border-color 140ms ease;
      }
      .trust a:hover,
      .trust a:focus-visible { color: var(--ink); border-bottom-color: var(--edge-2); }
      .trust .sep { color: var(--edge-2); }
      .trust .note { margin-left: auto; }
      @media (max-width: 680px) {
        .hero { grid-template-columns: minmax(0, 1fr); gap: 28px; margin-bottom: 36px; }
        .field { justify-self: start; }
        h1 { font-size: 32px; }
        .trust .note { margin-left: 0; flex-basis: 100%; }
      }
    </style>
  </head>
  <body>
    <main>
      <div class="hero rise">
        <div>
          <div class="brand">
            <span class="sigil" aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 32 32" fill="none">
                <polygon points="16,4.8 26.2,10.7 26.2,21.9 16,27.8 5.8,21.9 5.8,10.7" stroke="currentColor" stroke-width="1.55" stroke-linejoin="round" fill="currentColor" fill-opacity="0.06"/>
                <path d="M16 4.8v23M5.8 10.7 16 16.6 26.2 10.7" stroke="currentColor" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round" opacity="0.42"/>
                <polygon points="16,11 21.1,14 21.1,19.6 16,22.6 10.9,19.6 10.9,14" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round" fill="currentColor" fill-opacity="0.14" opacity="0.9"/>
              </svg>
            </span>
            <span class="host">${portalHost}</span>
          </div>
          <h1>Scout local</h1>
          <p class="lede">Registered machines on this local Scout mesh. Open a node to inspect agents, sessions, activity, and settings.</p>
        </div>
        <a class="field" href="${escapedNodeUrl}" aria-label="Open ${nodeHost}" title="Open ${nodeHost}">
          <pre class="field__layer" data-t="0" aria-hidden="true"></pre>
          <pre class="field__layer" data-t="1" aria-hidden="true"></pre>
          <pre class="field__layer" data-t="2" aria-hidden="true"></pre>
          <pre class="field__layer" data-t="3" aria-hidden="true"></pre>
          <pre class="field__layer" data-t="4" aria-hidden="true"></pre>
        </a>
      </div>
      <a class="node rise rise-2" href="${escapedNodeUrl}">
        <span class="node__id">
          <span class="node__host">${nodeHost}</span>
          <span class="node__sub">Local web node</span>
        </span>
        <span class="node__open">Open</span>
      </a>
      <div class="trust rise rise-3">
        <a href="https://openscout.app/docs" target="_blank" rel="noopener noreferrer">Docs</a>
        <span class="sep" aria-hidden="true">/</span>
        <a href="https://github.com/oscout/scout" target="_blank" rel="noopener noreferrer">GitHub</a>
        <span class="note">served by this machine’s Scout broker</span>
      </div>
    </main>
    <script>
      // Instrument field — pointer-aware wavefronts. Rings emanate on a
      // 6.5s period with a 17s angular phase wobble; one density value
      // drives a 2-step glyph dither and a 5-step tone ramp. The epicenter
      // eases toward the pointer (capped, so it leans rather than jumps),
      // pointer movement sheds decaying ripples, and without a pointer the
      // epicenter wanders a slow lissajous — never a fixed circle. Block
      // glyphs are avoided: they tile seamlessly and collapse into bars.
      // Reduced motion gets the still frame; ?t=<s> pins a phase for
      // review, ?px=0..1&py=0..1 pins a synthetic pointer.
      (function () {
        var W = 42, H = 21;
        var CX = (W - 1) / 2, CY = (H - 1) / 2;
        var ASPECT = 0.545;
        var GLYPH = ["·", "░"];
        var GCUT = [0.12, 0.45];
        var TCUT = [0.24, 0.42, 0.6, 0.8];
        var TONES = 5;
        var TAU = Math.PI * 2;
        var STILL_T = 2.6;
        var LEAN = 0.34;
        var RIPPLE_LIFE = 1.6;

        var field = document.querySelector(".field");
        var layers = [].slice.call(document.querySelectorAll(".field__layer"));
        if (!field || layers.length !== TONES) return;

        var N = W * H;
        var G = new Float32Array(N);
        for (var y = 0; y < H; y++) {
          for (var x = 0; x < W; x++) {
            var n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
            G[y * W + x] = (n - Math.floor(n)) * 2 - 1;
          }
        }

        var STRIDE = W + 1;
        var bufs = [];
        for (var b = 0; b < TONES; b++) {
          var buf = new Array(H * STRIDE);
          for (var j = 0; j < buf.length; j++) buf[j] = " ";
          for (var r = 0; r < H; r++) buf[r * STRIDE + W] = "\\n";
          bufs.push(buf);
        }

        var ox = 0, oy = 0;
        var tx = 0, ty = 0;
        var pointerT = -1e9;
        var ripples = [];
        var lastRippleT = -1e9, lastRippleX = 0, lastRippleY = 0;
        var start = -1;

        function fieldClock() {
          return STILL_T + (start < 0 ? 0 : (performance.now() - start) / 1000);
        }

        function onPointerMove(e) {
          var rect = field.getBoundingClientRect();
          if (rect.width < 1 || rect.height < 1) return;
          var px = ((e.clientX - rect.left) / rect.width) * W - CX;
          var py = ((e.clientY - rect.top) / rect.height) * H - CY;
          tx = Math.max(-CX, Math.min(CX, px)) * LEAN;
          ty = Math.max(-CY, Math.min(CY, py)) * LEAN;
          pointerT = fieldClock();
          var moved = Math.abs(px - lastRippleX) + Math.abs(py - lastRippleY);
          if (pointerT - lastRippleT > 0.14 && (moved > 2.5 || pointerT - lastRippleT > 0.6)) {
            ripples.push({
              x: Math.max(-CX, Math.min(CX, px)),
              y: Math.max(-CY, Math.min(CY, py)),
              t0: pointerT,
              amp: 0.5,
            });
            if (ripples.length > 4) ripples.shift();
            lastRippleT = pointerT;
            lastRippleX = px;
            lastRippleY = py;
          }
        }

        function render(t) {
          if (t - pointerT > 2.5) {
            tx = Math.sin(t * 0.19) * CX * 0.22;
            ty = Math.cos(t * 0.14) * CY * 0.22;
          }
          ox += (tx - ox) * 0.07;
          oy += (ty - oy) * 0.07;
          var cx = CX + ox, cy = CY + oy;

          var p1 = (t * TAU) / 6.5;
          var p2 = (t * TAU) / 17;
          for (var y = 0; y < H; y++) {
            var o = y * STRIDE;
            for (var x = 0; x < W; x++) {
              var i = y * W + x;
              var ax = ((x - cx) * ASPECT) / CY;
              var ay = (y - cy) / CY;
              var r = Math.sqrt(ax * ax + ay * ay);
              var a = Math.atan2(ay, ax);
              var e = Math.exp(-Math.pow(r / 0.9, 3.2));
              var u = r * 11 - p1 + 0.35 * Math.sin(a * 2 + p2);
              var c = 0.5 + 0.5 * Math.cos(u);
              var rings = c * c * c * Math.sqrt(c);
              var d = e * (0.16 + 0.78 * rings) + G[i] * 0.03;
              for (var k = 0; k < ripples.length; k++) {
                var rp = ripples[k];
                var age = t - rp.t0;
                if (age < 0 || age > RIPPLE_LIFE) continue;
                var rx = ((x - (CX + rp.x)) * ASPECT) / CY;
                var ry = (y - (CY + rp.y)) / CY;
                var rd = Math.sqrt(rx * rx + ry * ry);
                var wave = Math.cos(rd * 9 - age * 8);
                if (wave > 0) d += wave * Math.exp(-rd * 1.9) * Math.exp(-age * 2.2) * rp.amp;
              }

              var glyph = d >= GCUT[1] ? GLYPH[1] : d >= GCUT[0] ? GLYPH[0] : " ";
              var tone =
                d >= TCUT[3] ? 4 : d >= TCUT[2] ? 3 : d >= TCUT[1] ? 2 : d >= TCUT[0] ? 1 : 0;

              for (var m = 0; m < TONES; m++) bufs[m][o + x] = m === tone ? glyph : " ";
            }
          }
          for (var s = 0; s < TONES; s++) layers[s].textContent = bufs[s].join("");
        }

        var reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
        var raf = 0, last = -1;
        var STEP = 1000 / 24;

        function loop(ts) {
          raf = requestAnimationFrame(loop);
          if (start < 0) start = ts;
          if (last >= 0 && ts - last < STEP) return;
          last = ts;
          render(STILL_T + (ts - start) / 1000);
        }
        function stop() {
          if (raf) { cancelAnimationFrame(raf); raf = 0; }
        }
        function play() {
          if (reduce.matches || document.hidden || raf) return;
          last = -1;
          raf = requestAnimationFrame(loop);
        }

        render(STILL_T);

        var search = window.location.search;
        var pinned = /[?&]t=(-?[\\d.]+)/.exec(search);
        var pinP = /[?&]px=([\\d.]+)/.exec(search);
        var pinQ = /[?&]py=([\\d.]+)/.exec(search);
        if (pinned) {
          var pt = parseFloat(pinned[1]);
          if (pinP) {
            var fx = parseFloat(pinP[1]) * W - CX;
            var fy = (pinQ ? parseFloat(pinQ[1]) : 0.5) * H - CY;
            ox = tx = Math.max(-CX, Math.min(CX, fx)) * LEAN;
            oy = ty = Math.max(-CY, Math.min(CY, fy)) * LEAN;
            ripples.push({ x: fx, y: fy, t0: pt - 0.4, amp: 0.5 });
          }
          render(pt);
        } else {
          if (!reduce.matches) {
            window.addEventListener("pointermove", onPointerMove, { passive: true });
          }
          play();
          document.addEventListener("visibilitychange", function () {
            if (document.hidden) stop(); else play();
          });
          if (reduce.addEventListener) reduce.addEventListener("change", onMotionPreferenceChange);
          else if (reduce.addListener) reduce.addListener(onMotionPreferenceChange);
        }

        function onMotionPreferenceChange() {
          stop();
          if (reduce.matches) render(STILL_T);
          else {
            window.addEventListener("pointermove", onPointerMove, { passive: true });
            play();
          }
        }
      })();
    </script>
  </body>
</html>`;
}

function resolveSourceStaticClientRoot(
  moduleUrl: string | URL = import.meta.url,
): string {
  return resolve(dirname(fileURLToPath(moduleUrl.toString())), "../dist/client");
}

function resolveStaticRoot(staticRoot: string | undefined): string {
  const configured = staticRoot?.trim();
  if (configured) {
    return configured;
  }

  const bundled = resolveBundledStaticClientRoot(import.meta.url);
  if (existsSync(resolve(bundled, "index.html"))) {
    return bundled;
  }

  return resolveSourceStaticClientRoot(import.meta.url);
}

async function loadPairingState(
  currentDirectory: string,
  refresh: boolean,
): Promise<ScoutPairingState> {
  return refresh
    ? refreshScoutWebPairingState(currentDirectory)
    : getScoutWebPairingState(currentDirectory);
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

type HudRunnerHarnessOption = {
  id: string;
  name: string | null;
  label: string;
  description: string | null;
  state: string | null;
  ready: boolean | null;
  detail: string | null;
};

type HudRunnerModelOption = {
  id: string;
  label: string;
  harnesses: string[];
  source: string;
  family?: string;
  version?: string;
};

type HudRunnerEffortOption = {
  id: string;
  label: string;
  description: string;
  harnesses: string[];
};

type HudRunnerProjectOption = {
  id: string;
  title: string;
  root: string;
  source: string | null;
  registrationKind: string | null;
  defaultHarness: string | null;
};

type HudRunnerAgentOption = {
  id: string;
  name: string;
  handle: string | null;
  status: string | null;
  harness: string | null;
  model: string | null;
  projectRoot: string | null;
  cwd: string | null;
  harnessSessionId: string | null;
};

const HUD_PROJECT_MARKERS = [
  ".git",
  ".openscout/project.json",
  "AGENTS.md",
  "package.json",
  "Package.swift",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
] as const;

async function loadBrokerRuntimeCatalog(): Promise<{
  catalog: ScoutOwnedRuntimeCatalog;
  warnings: string[];
} | null> {
  try {
    const response = await fetch(new URL("/v1/runtime-catalog", resolveScoutBrokerUrl()), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return null;
    const value = await response.json() as { catalog?: unknown; warnings?: unknown };
    const parsed = parseScoutRuntimeCatalog(value.catalog);
    if (!parsed.ok) return null;
    return {
      catalog: parsed.catalog,
      warnings: Array.isArray(value.warnings)
        ? value.warnings.filter((entry): entry is string => typeof entry === "string")
        : [],
    };
  } catch {
    return null;
  }
}

function defaultHudRunnerModel(
  harness: string | null | undefined,
  models: HudRunnerModelOption[],
  catalog: ScoutOwnedRuntimeCatalog,
): string | null {
  const catalogDefault = scoutRuntimeDefaultModel(harness ?? "", catalog);
  if (catalogDefault && models.some((model) => (
    model.id === catalogDefault && model.harnesses.includes(harness ?? "")
  ))) return catalogDefault;
  return models.find((model) => model.harnesses.includes(harness ?? ""))?.id ?? null;
}

function normalizeHudRunnerRoot(root: string): string {
  return resolve(expandHomePath(root.trim()));
}

function isLikelyHudProjectRoot(root: string): boolean {
  const normalized = normalizeHudRunnerRoot(root);
  try {
    if (!statSync(normalized).isDirectory()) return false;
  } catch {
    return false;
  }
  return HUD_PROJECT_MARKERS.some((marker) => existsSync(join(normalized, marker)));
}

function currentDirectoryProjectOption(
  currentDirectory: string,
  defaultHarness: string,
): HudRunnerProjectOption | null {
  const trimmed = currentDirectory.trim();
  if (!trimmed || !isLikelyHudProjectRoot(trimmed)) return null;
  const root = normalizeHudRunnerRoot(trimmed);
  return {
    id: `current:${root}`,
    title: basename(root) || root,
    root,
    source: "currentDirectory",
    registrationKind: "current",
    defaultHarness,
  };
}

function dedupeHudRunnerProjects(projects: HudRunnerProjectOption[]): HudRunnerProjectOption[] {
  const seen = new Set<string>();
  const result: HudRunnerProjectOption[] = [];
  for (const project of projects) {
    const root = normalizeHudRunnerRoot(project.root);
    if (!seen.add(root)) continue;
    result.push({ ...project, root });
  }
  return result;
}

async function buildHudRunnerOptions(
  currentDirectory: string,
  input: {
    scope?: ScoutRuntimeCapabilityCatalog["scope"];
    projectRoot?: string;
  } = {},
) {
  // This endpoint sits on the global-hotkey path, so it deliberately avoids
  // the workspace scan performed by the full agent-configuration snapshot.
  const [settingsResult, runtimeCatalogResult] = await Promise.allSettled([
    readOpenScoutSettings({ currentDirectory }),
    loadBrokerRuntimeCatalog(),
  ]);
  const settings = settingsResult.status === "fulfilled" ? settingsResult.value : null;
  const liveRuntimeCatalog = runtimeCatalogResult.status === "fulfilled" ? runtimeCatalogResult.value : null;
  const runtimeCatalog = liveRuntimeCatalog?.catalog ?? SCOUT_RUNTIME_CATALOG;
  const allAgents = queryAgents(50);
  const scope = input.scope ?? "global+project";
  const scopedProjectRoot = normalizeHudRunnerRoot(input.projectRoot ?? currentDirectory);
  const projectAgents = allAgents.filter((agent) => {
    const root = agent.projectRoot ?? agent.cwd;
    return Boolean(root) && normalizeHudRunnerRoot(root!) === scopedProjectRoot;
  });
  const configuredDefaultHarness = settings?.agents.defaultHarness?.trim() ?? "";
  const defaultHarness = isScoutRuntimeHarnessEnabled(configuredDefaultHarness, runtimeCatalog)
    ? configuredDefaultHarness
    : scoutRuntimeDefaultHarness(runtimeCatalog) ?? "claude";

  const harnessesById = new Map<string, HudRunnerHarnessOption>();
  for (const entry of runtimeCatalog.harnesses) {
    // Hidden transports remain valid for exact launches and resume, but they
    // are not a second operator-facing choice in the HUD composer.
    if (!entry.enabled || entry.listed === false) continue;
    harnessesById.set(entry.id, {
      id: entry.id,
      name: entry.id,
      label: entry.label,
      description: null,
      // Full harness readiness executes local health checks and can take
      // several seconds across the installed fleet. New task only needs the
      // broker-owned launch catalog; launch remains the final authority.
      state: null,
      ready: null,
      detail: null,
    });
  }

  const projectOptions: HudRunnerProjectOption[] = allAgents
    .map((agent) => agent.projectRoot ?? agent.cwd)
    .filter((root): root is string => typeof root === "string" && root.trim().length > 0)
    .map((root) => {
      const normalizedRoot = normalizeHudRunnerRoot(root);
      return {
        id: `agent:${normalizedRoot}`,
        title: basename(normalizedRoot) || normalizedRoot,
        root: normalizedRoot,
        source: "agent",
        registrationKind: null,
        defaultHarness,
      };
    });
  const currentProject = currentDirectoryProjectOption(currentDirectory, defaultHarness);
  if (currentProject) projectOptions.unshift(currentProject);
  const projects = dedupeHudRunnerProjects(projectOptions);
  const defaultDirectory = projects[0]?.root ?? normalizeHudRunnerRoot(currentDirectory);
  const models = scoutRuntimeModelCatalog(runtimeCatalog);
  const harnesses = Array.from(harnessesById.values());
  const defaultModel = defaultHudRunnerModel(defaultHarness, models, runtimeCatalog);

  return {
    schemaVersion: "openscout.runtime-capabilities.v1" as const,
    catalogVersion: runtimeCatalog.schemaVersion,
    catalogRevision: runtimeCatalog.revision,
    generatedAt: Date.now(),
    scope,
    ...(scope !== "global" ? { projectRoot: scopedProjectRoot } : {}),
    defaults: {
      runner: "scout",
      directory: defaultDirectory,
      harness: defaultHarness,
      model: defaultModel,
      reasoningEffort: scoutRuntimeDefaultReasoningEffort(
        defaultHarness,
        defaultModel,
        runtimeCatalog,
      ) ?? "",
      persistence: "sticky",
    },
    defaultsByHarness: scoutRuntimeDefaultsByHarness(runtimeCatalog),
    runners: [{
      id: "scout",
      label: "Scout",
      description: "Start a broker-owned Scout session",
      supports: harnesses.map((harness) => harness.id),
    }],
    harnesses,
    models,
    efforts: scoutRuntimeEffortCatalog(runtimeCatalog).map((effort) => ({
      ...effort,
      harnesses: [...effort.harnesses],
      ...(effort.models ? { models: [...effort.models] } : {}),
    })),
    projects,
    ...(liveRuntimeCatalog?.warnings.length ? { warnings: liveRuntimeCatalog.warnings } : {}),
    agents: (scope === "global" ? allAgents : projectAgents).map((agent): HudRunnerAgentOption => ({
      id: agent.id,
      name: agent.name,
      handle: agent.handle,
      status: agent.state,
      harness: agent.harness,
      model: agent.model,
      projectRoot: agent.projectRoot ? normalizeHudRunnerRoot(agent.projectRoot) : null,
      cwd: agent.cwd ? normalizeHudRunnerRoot(agent.cwd) : null,
      harnessSessionId: agent.harnessSessionId,
    })),
  };
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

async function readLocalHarnessTopologySnapshot(options: { claudeSessionId?: string | null } = {}) {
  try {
    const { HarnessTopologyObserver } = await import("@openscout/runtime/harness-topology");
    const observer = new HarnessTopologyObserver({
      cwd: process.env.OPENSCOUT_SETUP_CWD || process.cwd(),
      claudeSessionId: options.claudeSessionId ?? null,
      includeUnmatchedClaudeSubagents: !options.claudeSessionId,
      includeUnmatchedClaudeWorkflows: !options.claudeSessionId,
    });
    return await observer.getSnapshot(true);
  } catch {
    return null;
  }
}

function readOpenScoutHostInfoFile(): unknown | null {
  try {
    return JSON.parse(readFileSync(resolveOpenScoutSupportPaths().hostInfoPath, "utf8"));
  } catch {
    return null;
  }
}

function fallbackOpenScoutHostInfo(
  options: CreateOpenScoutWebServerOptions,
  currentDirectory: string,
) {
  const webUrl = options.publicOrigin
    ?? (options.webPort ? `http://127.0.0.1:${options.webPort}` : undefined);
  return {
    schemaVersion: 1,
    source: "openscout-web",
    updatedAtMs: Date.now(),
    currentDirectory,
    brokerUrl: resolveScoutBrokerUrl(),
    ...(webUrl ? { webUrl } : {}),
    ...(options.webPort ? { ports: { web: options.webPort } } : {}),
    advertisedHost: options.advertisedHost,
    portalHost: options.portalHost,
    publicOrigin: options.publicOrigin,
  };
}

export async function createOpenScoutWebServer(
  options: CreateOpenScoutWebServerOptions,
): Promise<OpenScoutWebServer> {
  const shellTtl = options.shellStateCacheTtlMs ?? 15_000;
  const currentDirectory = options.currentDirectory;
  const lanAccessScope = options.lanAccessScope ?? resolveScoutWebLanAccessScope(process.env);

  // Approval-gated LAN pairing: a phone tapping an idle Mac registers a request
  // here; the Mac approves it before pair mode starts and the payload is served.
  // Shared per-Mac, not per-process: the pairing identity is shared by every
  // local instance, so the requests made against it have to be too. See
  // pairing-pair-requests.ts.
  const pendingPairRequests = createPendingPairRequestStore({
    statePath: pairRequestStatePath(localConfigHome()),
  });
  // Always-on discovery beacon so idle Macs still appear in the iOS "On your
  // network" list. Stands down only when the controller has its own LAN advert.
  const lanPairBeacon = options.backgroundServices === false
    ? null
    : startScoutPairLanBeacon(async () => {
        try {
          return (await loadPairingState(currentDirectory, false)).lanDiscoveryAdvertised;
        } catch {
          return false;
        }
      }, { webPort: options.webPort });
  const routes = resolveOpenScoutWebRoutes(process.env);
  if (options.backgroundServices !== false) {
    startGlobalHeuristicsWatcher();
  }
  const app = new Hono();
  app.use("*", async (c, next) => {
    const peerAddress = (options.resolvePeerAddress ?? resolveScoutRequestPeerAddress)(c);
    if (!isScoutWebRequestAllowedFromPeer(c.req.raw, peerAddress, lanAccessScope)) {
      return c.text("Not Found", 404);
    }
    await next();
  });
  installHttpsEdgeSecurityHeaders(app, options.publicOrigin);
  const shellStateCache = createCachedSnapshot<OpenScoutWebShellState>(
    loadOpenScoutWebShellState,
    shellTtl,
  );
  const readAgentConfigurationSnapshot = coalesce(
    () => buildAgentConfigurationSnapshot(currentDirectory),
    30_000,
  );
  const runnerOptionsReaders = new Map<
    string,
    () => Promise<Awaited<ReturnType<typeof buildHudRunnerOptions>>>
  >();
  const readRunnerOptions = (
    scope: ScoutRuntimeCapabilityCatalog["scope"],
    projectRoot: string,
  ) => {
    const key = `${scope}\0${projectRoot}`;
    let read = runnerOptionsReaders.get(key);
    if (!read) {
      if (runnerOptionsReaders.size >= 32) runnerOptionsReaders.clear();
      read = coalesce(
        () => buildHudRunnerOptions(currentDirectory, { scope, projectRoot }),
        30_000,
      );
      runnerOptionsReaders.set(key, read);
    }
    return read();
  };
  const agentBrokerContextReader = createAgentBrokerContextReader();
  const agentBrokerHomeReader = createAgentBrokerHomeReader();
  const dispatchBrokerSnapshotCache = createCachedSnapshot<BrokerDiagnosticsSnapshot | null>(async () => {
    const baseUrl = resolveScoutBrokerUrl();
    const signal = AbortSignal.timeout(2_000);
    const [messages, health, home] = await Promise.all([
      readScoutBrokerMessages({ baseUrl, limit: 500, signal }),
      readScoutBrokerHealth(baseUrl, { signal }),
      readScoutBrokerHome(baseUrl, { signal }),
    ]);
    if (!messages) return null;
    return {
      actors: Object.fromEntries(
        (home?.agents ?? []).map((agent) => [agent.id, { displayName: agent.title }]),
      ),
      messages: Object.fromEntries(messages.map((message) => [message.id, message])),
      totalMessageCount: health.counts?.messages ?? null,
      projectionStatus: health.projection?.state ?? null,
    };
  }, 0);
  const dispatchFullBrokerSnapshotCache = createCachedSnapshot(
    () => readScoutBrokerSnapshot(
      resolveScoutBrokerUrl(),
      { signal: AbortSignal.timeout(5_000) },
    ),
    0,
  );
  // Local fallback for /api/topology/snapshot when the broker cannot answer.
  // The observer walks every harness home on disk with force=true, so the
  // fallback holds one 30s snapshot instead of constructing a fresh observer
  // and rescanning per request. `?force=1` refreshes it through `get({force})`.
  const localTopologySnapshotCache = createCachedSnapshot(
    () => readLocalHarnessTopologySnapshot(),
    30_000,
  );
  const tailRuntime: WebTailRuntime = {
    getTailDiscovery,
    refreshTailDiscovery,
    readRecentTranscriptEvents,
    snapshotRecentEvents,
    ...options.tailRuntime,
  };
  const scoutbot = await createScoutbotWebServices({
    currentDirectory,
    tailRuntime,
    loadOperatorAttention: (directory) => buildOperatorAttentionState(
      directory,
      options.captureTmuxPane ?? defaultCaptureTmuxPane,
    ),
    loadBuildInfo: loadOpenScoutBuildInfo,
    invokeCodex: options.scoutbotAssistant?.invokeCodex,
    scoutbot: options.scoutbot,
  });
  const resolveSessionRequestConversationId = async (conversationId: string): Promise<string | null> => {
    if (isOpaqueChannelId(conversationId)) return conversationId;
    const scoutbotRunner = scoutbot.runner ?? await scoutbot.waitForRunner();
    if (!isLegacyScoutbotConversationId(conversationId) || !scoutbotRunner) return null;
    try {
      const threadList = await scoutbotRunner.getThreads();
      const thread = threadList.threads.find((candidate) => candidate.threadId === threadList.defaultThreadId)
        ?? threadList.threads.find((candidate) => candidate.threadId === SCOUTBOT_DEFAULT_THREAD_ID)
        ?? threadList.threads[0];
      const canonicalConversationId = thread?.conversationId?.trim();
      return isOpaqueChannelId(canonicalConversationId) ? canonicalConversationId : null;
    } catch {
      return null;
    }
  };
  const tailDiscoveryCaches = new Map<string, BrokerJsonCache<DiscoverySnapshot>>();
  const tailRecentCaches = new Map<string, BrokerJsonCache<TailRecentPayload>>();

  installScoutApiMiddleware(app, "openscout-web api", {
    trustedHosts: options.trustedHosts,
    trustedOrigins: options.trustedOrigins,
    authToken: options.authToken,
    resolvePeerAddress: options.resolvePeerAddress,
  });

  mountScoutDeckSurfaceRoutes(app, {
    currentDirectory,
    hostName: options.advertisedHost?.trim() || "This Mac",
  });

  mountRepoDiffRoutes(app, {
    currentDirectory,
    repoDiffSnapshot: options.repoDiffSnapshot,
    repoPullRequests: options.repoPullRequests,
  });

  mountScoutbotRoutes(app, scoutbot, { currentDirectory });

  app.get(routes.bootstrapScriptPath, (c) =>
    new Response(serializeOpenScoutWebBootstrap(process.env), {
      headers: {
        "cache-control": "no-store",
        "content-type": "application/javascript; charset=utf-8",
      },
    }),
  );
  app.get("/.host-info", (c) => {
    c.header("cache-control", "no-store");
    return c.json(readOpenScoutHostInfoFile() ?? fallbackOpenScoutHostInfo(options, currentDirectory));
  });
  app.get(routes.healthPath, (c) =>
    c.json({
      ok: true,
      surface: "openscout-web",
      currentDirectory,
      brokerUrl: resolveScoutBrokerUrl(),
      advertisedHost: options.advertisedHost,
      portalHost: options.portalHost,
      publicOrigin: options.publicOrigin,
    }),
  );
  app.get("/api/build", async (c) => {
    return c.json(await resolveOpenScoutBuildInfo(currentDirectory, c.req.query("refresh") === "1"));
  });

  app.get("/api/knowledge/status", (c) => {
    const store = new SQLiteKnowledgeStore(undefined, undefined, { readonly: true });
    try {
      return c.json(store.status());
    } finally {
      store.close();
    }
  });

  app.get("/api/knowledge/search", (c) => {
    const q = c.req.query("q") ?? "";
    const limit = parseOptionalPositiveInt(c.req.query("limit"), 30) ?? 30;
    const primitives = parseKnowledgeSearchParams(c.req.url);
    const store = new SQLiteKnowledgeStore(undefined, undefined, { readonly: true });
    try {
      return c.json({
        q,
        hits: store.searchLexical({
          q,
          sourceKinds: primitives.sourceKinds ?? ["sessions"],
          collections: primitives.collections,
          facets: primitives.facets,
          sourceUpdatedAfterMs: primitives.sourceUpdatedAfterMs,
          sourceUpdatedBeforeMs: primitives.sourceUpdatedBeforeMs,
          limit,
          mode: "lexical",
        }),
        status: store.status(),
      });
    } finally {
      store.close();
    }
  });

  app.get("/api/knowledge/search-primitives", (c) => {
    const keys = new URL(c.req.url, "http://localhost").searchParams.getAll("key");
    const limit = parseOptionalPositiveInt(c.req.query("limit"), 200) ?? 200;
    const store = new SQLiteKnowledgeStore(undefined, undefined, { readonly: true });
    try {
      return c.json({
        facets: store.listFacetValues(keys, limit),
        params: {
          facets: KNOWLEDGE_SEARCH_FACET_PARAMS,
          genericFacetPrefixes: ["facet:", "facet."],
          ranges: ["updatedAfterMs", "updatedBeforeMs"],
          collections: ["collection", "collectionId"],
          sourceKinds: [...KNOWLEDGE_SEARCH_SOURCE_KINDS],
        },
        status: store.status(),
      });
    } finally {
      store.close();
    }
  });

  app.post("/api/knowledge/source-preview", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      sourceRef?: unknown;
      contextRecords?: unknown;
      maxRecords?: unknown;
      q?: unknown;
    };
    const sourceRef = body.sourceRef;
    if (!isRecord(sourceRef) || sourceRef.kind !== "harness_transcript") {
      return c.json({ error: "sourceRef must be a harness transcript ref" }, 400);
    }
    try {
      return c.json(await readKnowledgeJsonlPreview({
        sourceRef: sourceRef as HarnessTranscriptSourceRef,
        currentDirectory,
        contextRecords: typeof body.contextRecords === "number" ? body.contextRecords : undefined,
        maxRecords: typeof body.maxRecords === "number" ? body.maxRecords : undefined,
        query: typeof body.q === "string" ? body.q : undefined,
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.includes("trusted preview roots") ? 403 : 500;
      return c.json({ error: message }, status as 403 | 500);
    }
  });

  app.post("/api/knowledge/sessions/index", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      days?: unknown;
      hours?: unknown;
      limit?: unknown;
      force?: unknown;
      harness?: unknown;
    };
    const hours = typeof body.hours === "number" && Number.isFinite(body.hours) && body.hours > 0
      ? body.hours
      : undefined;
    const days = hours == null
      && typeof body.days === "number"
      && Number.isFinite(body.days)
      ? body.days
      : hours == null
        ? 3
        : undefined;
    const limit = typeof body.limit === "number" && Number.isFinite(body.limit)
      ? body.limit
      : 220;
    const force = body.force === true;
    let harness: string | string[] | undefined;
    if (typeof body.harness === "string" && body.harness.trim()) {
      harness = body.harness.trim();
    } else if (Array.isArray(body.harness)) {
      const list = body.harness
        .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        .map((entry) => entry.trim());
      if (list.length > 0) harness = list;
    }
    const outcome = await startSessionKnowledgeIndex({ days, hours, limit, force, harness });
    if (outcome.busy) {
      return c.json({ error: outcome.error ?? "session knowledge index already running" }, 409);
    }
    if (!outcome.ok) {
      return c.json({ error: outcome.error ?? "session indexing failed" }, 500);
    }
    return c.json({ result: outcome.result, status: outcome.status });
  });

  app.get("/api/ui/scenes", async (c) => {
    const settings = await readOpenScoutSettings({ currentDirectory }).catch(() => null);
    return c.json(settings?.ui ?? { scenes: [], activeSceneIdBySurface: {} });
  });

  app.put("/api/ui/scenes", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      scenes?: unknown;
      activeSceneIdBySurface?: unknown;
    };
    try {
      const updated = await writeOpenScoutSettings({
        ui: {
          scenes: Array.isArray(body.scenes) ? (body.scenes as never) : [],
          activeSceneIdBySurface: typeof body.activeSceneIdBySurface === "object" && body.activeSceneIdBySurface
            ? (body.activeSceneIdBySurface as never)
            : {},
        },
      }, { currentDirectory });
      return c.json(updated.ui);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[ui/scenes]", message);
      return c.json({ error: message }, 500);
    }
  });
  app.get("/api/file/roots", (c) => {
    const roots = collectTrustedRoots({ currentDirectory });
    return c.json({ roots });
  });

  app.get("/api/projects/overview", async (c) => {
    const projectRoot = c.req.query("root")?.trim();
    if (!projectRoot) {
      return c.json({ error: "missing root" }, 400);
    }
    const { buildProjectOverview } = await import("./project-overview.ts");
    const result = await buildProjectOverview({
      projectRoot,
      currentDirectory,
    });
    if (!result.ok) {
      return c.json({ error: result.error }, result.status as 400 | 403 | 404);
    }
    return c.json(result.payload);
  });

  // One-off project registration: appends to discovery.workspaceRoots
  // (never replaces — that's the onboarding writer's job), then re-scans
  // and reports which projects actually appeared under the new root.
  app.post("/api/projects/add", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { root?: string };
    const requested = body.root?.trim();
    if (!requested) {
      return c.json({ error: "root is required" }, 400);
    }
    const root = resolve(expandHomePath(requested));
    if (!existsSync(root)) {
      return c.json({ error: `That folder doesn't exist: ${root}` }, 400);
    }
    if (!statSync(root).isDirectory()) {
      return c.json({ error: `Not a folder: ${root}` }, 400);
    }

    try {
      const { alreadyRegistered } = await addOpenScoutWorkspaceRoot({ root, currentDirectory });
      const setup = await loadResolvedRelayAgents({ currentDirectory });
      const registered = setup.projectInventory
        .filter((project) => project.projectRoot === root || project.projectRoot.startsWith(`${root}/`))
        .map((project) => ({
          id: project.agentId,
          title: project.displayName,
          root: project.projectRoot,
          source: project.source,
          registrationKind: project.registrationKind,
          defaultHarness: project.defaultHarness,
          projectConfigPath: project.projectConfigPath,
        }));
      return c.json({
        ok: true,
        root,
        alreadyRegistered,
        projects: registered,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[projects/add]", message);
      return c.json({ error: message }, 500);
    }
  });

  // Deep-link authority for /code/<project>/<path>: resolves a slug against
  // the canonical project inventory. Repo-watch only registers checkouts with
  // live agent activity, so a quiet-but-known checkout must resolve here.
  app.get("/api/code/resolve-project", async (c) => {
    const slug = c.req.query("slug")?.trim();
    if (!slug) {
      return c.json({ error: "slug is required" }, 400);
    }
    try {
      const { matchCodeProjectBySlug } = await import("./code-project-resolve.ts");
      const setup = await loadResolvedRelayAgents({ currentDirectory });
      const candidates = setup.projectInventory
        .map((project) => ({ displayName: project.displayName, projectRoot: project.projectRoot }))
        .filter((project) => existsSync(project.projectRoot));
      const match = matchCodeProjectBySlug(candidates, slug);
      if (!match) {
        return c.json({
          error: `Project "${slug}" is not in Scout's project inventory (${candidates.length} registered).`,
        }, 404);
      }
      return c.json({ ok: true, projectName: match.displayName, root: match.projectRoot });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[code/resolve-project]", message);
      return c.json({ error: `Could not resolve project "${slug}": ${message}` }, 500);
    }
  });

  app.get("/api/file/preview", (c) => {
    const requestedPath = c.req.query("path");
    if (!requestedPath) {
      return c.json({ error: "missing path" }, 400);
    }
    const result = readFilePreview({ requestedPath, currentDirectory });
    if (!result.ok) {
      return c.json({ error: result.error }, result.status as 400 | 403 | 404 | 415 | 500);
    }
    return c.json(result.content);
  });

  app.get("/api/file/raw/*", (c) =>
    serveRawFile(c, currentDirectory, rawFilePathFromRoute(c.req.url)),
  );

  app.get("/api/file/raw", (c) =>
    serveRawFile(c, currentDirectory, c.req.query("path")),
  );

  app.post("/api/file/reveal", async (c) => {
    const body = await c.req.json<{ path?: unknown }>().catch(() => null);
    const requestedPath = typeof body?.path === "string" ? body.path : "";
    if (!requestedPath.trim()) {
      return c.json({ error: "missing path" }, 400);
    }
    const roots = collectTrustedRoots({ currentDirectory });
    const resolved = resolveTrustedPath({ requestedPath, roots });
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, resolved.status as 400 | 403 | 404);
    }
    try {
      await (options.revealPath ?? defaultRevealLocalPath)(resolved.realPath);
      return c.json({ ok: true, path: resolved.realPath });
    } catch (error) {
      const message = error instanceof Error ? error.message : "failed to reveal path";
      return c.json({ error: message }, 500);
    }
  });

  app.post("/api/local-path/reveal", async (c) => {
    const body = await c.req.json<{
      path?: unknown;
      basePath?: unknown;
      agentId?: unknown;
      sessionId?: unknown;
    }>().catch(() => null);
    const rawPath = typeof body?.path === "string" ? body.path.trim() : "";
    if (!rawPath) {
      return c.json({ error: "missing path" }, 400);
    }
    const agentId = typeof body?.agentId === "string" ? body.agentId.trim() : "";
    const sessionId = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
    if (!agentId && !sessionId) {
      return c.json({ error: "agentId or sessionId is required" }, 400);
    }

    const observePayload = await loadRevealObservePayload({ agentId, sessionId });
    if (!observePayload) {
      return c.json({ error: "observe payload not found" }, 404);
    }

    const basePath = typeof body?.basePath === "string" ? body.basePath : null;
    const targetPath = resolveExplorablePath(rawPath, basePath, currentDirectory);
    const realTargetPath = realpathIfExists(targetPath);
    if (!realTargetPath) {
      return c.json({ error: "path not found" }, 404);
    }
    if (!observedRevealPathSet(observePayload).has(realTargetPath)) {
      return c.json({ error: "path is not part of the observed session" }, 403);
    }

    try {
      await (options.revealPath ?? defaultRevealLocalPath)(realTargetPath);
      return c.json({ ok: true, path: realTargetPath });
    } catch (error) {
      const message = error instanceof Error ? error.message : "failed to reveal path";
      return c.json({ error: message }, 500);
    }
  });
  app.use("/", async (c, next) => {
    const portalHost = options.portalHost?.trim().toLowerCase();
    const nodeHost = options.advertisedHost?.trim().toLowerCase();
    const requestHost = normalizeRequestHost(c.req.header("host"));
    if (portalHost && nodeHost && requestHost === portalHost && portalHost !== nodeHost) {
      return new Response(
        renderScoutLocalPortal({
          requestUrl: c.req.url,
          portalHost,
          nodeHost,
        }),
        {
          headers: {
            "cache-control": "no-store",
            "content-type": "text/html; charset=utf-8",
          },
        },
      );
    }
    return next();
  });
  app.get(routes.terminalRelayHealthPath, async (c) => {
    const ok = await (options.terminalRelayHealthcheck?.() ?? Promise.resolve(false));
    return c.json(
      {
        ok,
        surface: "openscout-terminal-relay",
      },
      ok ? 200 : 503,
    );
  });
  app.get("/api/pairing-state", async (c) =>
    c.json(await loadPairingState(currentDirectory, false)),
  );
  app.get("/api/pairing-state/refresh", async (c) =>
    c.json(await loadPairingState(currentDirectory, true)),
  );
  const pickPairingLocation = (
    state: ScoutPairingState,
    route: string | null,
  ): string | null => {
    const links = pairingDeepLinks(pairingQrValueWithWebPort(state.pairing?.qrValue, options.webPort));
    return route === "lan"
      ? links.lan ?? links.default
      : route === "ts" || route === "tsn" || route === "tailnet"
        ? links.tailnet ?? links.default
        : links.default;
  };
  // GET /pair is the phone's LAN knock. It is not operator login: the Mac
  // identifies the connecting app, then allow/deny. Do not put this behind
  // the web session cookie.
  app.get(`/${SCOUT_PAIRING_DEEP_LINK_PATH}`, async (c) => {
    c.header("cache-control", "no-store");
    const route = c.req.query("route")?.trim().toLowerCase() ?? null;
    const token = c.req.query("token")?.trim() || null;
    const wantsJson = (c.req.header("accept") ?? "").includes("application/json");
    const peerAddress = (options.resolvePeerAddress ?? resolveScoutRequestPeerAddress)(c);
    const xff = c.req.header("x-forwarded-for");
    const forwardedIp = (xff ? xff.split(",").at(-1)?.trim() : null)
      || c.req.header("x-real-ip")?.trim()
      || null;
    const loopbackPeer = Boolean(peerAddress && isLoopbackScoutAddress(peerAddress));
    const sameMacRequest = isSameMacScoutRequest(c.req.raw, peerAddress);
    const relayedLanRequest = Boolean(
      loopbackPeer
      && c.req.header(SCOUT_PAIR_RELAY_HEADER) === "1",
    );
    const directLanRequest = Boolean(peerAddress && !isLoopbackScoutAddress(peerAddress));
    // A local reverse proxy is still carrying the browser's identity. The
    // shared same-Mac classifier accepts this Mac's own interface addresses,
    // while remote, malformed, or multi-hop forwarding stays approval-gated.
    const proxiedLanRequest = Boolean(
      loopbackPeer
      && !relayedLanRequest
      && !sameMacRequest,
    );
    const unidentifiedPairingIngress = !peerAddress;
    const requiresApproval = relayedLanRequest
      || directLanRequest
      || proxiedLanRequest
      || unidentifiedPairingIngress;
    const requesterApp = parseScoutPairClient(
      c.req.header(SCOUT_PAIR_CLIENT_HEADER),
      c.req.header("user-agent"),
    );

    // `/pair` is unauthenticated and polled frequently. Use the coalesced
    // reader so LAN traffic cannot force filesystem/process discovery work on
    // every request; the phone already tolerates this short refresh window.
    const state = await loadPairingState(currentDirectory, false);
    const location = pickPairingLocation(state, route);

    // A polling token is a bearer credential for one operator decision. Check
    // that decision before considering the live payload, and make the approved
    // check + one-time consumption one atomic store transition.
    if (token) {
      const request = pendingPairRequests.get(token);
      if (!request) {
        return wantsJson
          ? c.json({ status: "expired", token }, 410)
          : c.text("Pairing request expired.", 410);
      }
      if (request.status === "denied") {
        return wantsJson
          ? c.json({ status: "denied", token }, 403)
          : c.text("Pairing request was denied.", 403);
      }
      if (location && request.status === "approved") {
        if (!pendingPairRequests.fulfill(token, "approved")) {
          // A consume that cannot win the shared CAS fails closed without
          // deleting the request. Keep an approved device polling; if a peer
          // won with a denial or delivery, reflect that terminal state instead.
          const current = pendingPairRequests.get(token);
          if (current?.status === "approved" || current?.status === "pending") {
            return c.json({ status: current.status, token, pollAfterMs: 1200 }, 202);
          }
          if (current?.status === "denied") {
            return wantsJson
              ? c.json({ status: "denied", token }, 403)
              : c.text("Pairing request was denied.", 403);
          }
          return wantsJson
            ? c.json({ status: "expired", token }, 410)
            : c.text("Pairing request expired.", 410);
        }
        return c.redirect(location, 302);
      }
      // pending, or approved but the relay payload isn't up yet — keep polling.
      // Touch so an actively-polling device doesn't age out mid-approval.
      pendingPairRequests.touch(token);
      return c.json({ status: request.status, token, pollAfterMs: 1200 }, 202);
    }

    // Same-Mac browser flows may still use the existing live-payload fast path.
    // A direct LAN peer or the narrow relay ingress always needs an approved
    // token, even while some other pairing session is already live.
    if (location && !requiresApproval) {
      return c.redirect(location, 302);
    }

    // First contact from an unpaired device — register an approval request.
    const requesterIp = unidentifiedPairingIngress
      ? null
      : relayedLanRequest || proxiedLanRequest
        ? forwardedIp
        : directLanRequest
          ? peerAddress ?? null
          : forwardedIp;
    if (requiresApproval && !requesterIp) {
      return wantsJson
        ? c.json({ status: "unavailable" }, 503)
        : c.text("Unable to identify pairing requester.", 503);
    }

    let request: ReturnType<typeof pendingPairRequests.create>;
    try {
      request = pendingPairRequests.create({
        requesterIp,
        requesterLabel: c.req.header("x-scout-device-name")?.trim() || null,
        requesterApp,
        route,
      });
    } catch (error) {
      if (!(error instanceof PairRequestCapacityError)) throw error;
      c.header("retry-after", String(Math.ceil(error.retryAfterMs / 1000)));
      return wantsJson
        ? c.json({ status: "busy", retryAfterMs: error.retryAfterMs }, 429)
        : c.text("Too many pairing requests. Try again shortly.", 429);
    }
    if (request.status === "denied") {
      return wantsJson
        ? c.json({ status: "denied", token: request.token }, 403)
        : c.text("Pairing request was denied.", 403);
    }
    return wantsJson
      ? c.json({ status: request.status, token: request.token, pollAfterMs: 1200 }, 202)
      : c.text(
          `${SCOUT_PAIRING_DEEP_LINK_SCHEME}://${SCOUT_PAIRING_DEEP_LINK_PATH} pairing requires approval on the Mac.`,
          202,
        );
  });
  app.get("/api/notifications", (c) => {
    const rawType = c.req.query("type") ?? "";
    const requestedTypes = new Set(
      rawType
        .split(",")
        .map((type) => type.trim())
        .filter(Boolean),
    );
    const includePairingRequests =
      requestedTypes.size === 0 || requestedTypes.has("pairing_request");
    const notifications = includePairingRequests
      ? pendingPairRequests.list()
        .filter((request) => request.status === "pending")
        .map((request) => ({
          id: `pairing_request:${request.token}`,
          type: "pairing_request",
          title: `${pairRequesterDisplay(request)} wants to pair`,
          body: `On your network${request.requesterIp ? ` · ${request.requesterIp}` : ""}.`,
          createdAt: request.createdAt,
          updatedAt: request.updatedAt,
          expiresAt: request.expiresAt,
          data: { request },
        }))
      : [];
    return c.json({ notifications });
  });
  app.get("/api/pairing/requests", (c) =>
    c.json({ requests: pendingPairRequests.list() }),
  );
  app.post("/api/pairing/requests/:token/decide", async (c) => {
    const token = c.req.param("token");
    const body = (await c.req.json().catch(() => ({}))) as { decision?: string };
    const decision =
      body.decision === "approve" ? "approve"
      : body.decision === "deny" ? "deny"
      : null;
    if (!decision) {
      return c.json({ error: "decision must be 'approve' or 'deny'" }, 400);
    }
    const req = pendingPairRequests.decide(token, decision);
    if (!req) {
      return c.json({ error: "unknown or expired pairing request" }, 404);
    }
    if (decision === "approve") {
      // Bring pair mode up so the payload is ready for the device's next poll.
      // The runtime spins up asynchronously; the device keeps polling /pair.
      try {
        await controlScoutWebPairingService("start", currentDirectory);
      } catch (error) {
        console.error(
          "[openscout-web pairing] failed to start pair mode on approval:",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    shellStateCache.invalidate();
    return c.json({ request: req });
  });
  app.get("/api/operator-attention", async (c) =>
    c.json(await buildOperatorAttentionState(
      currentDirectory,
      options.captureTmuxPane ?? defaultCaptureTmuxPane,
    )),
  );
  app.post("/api/operator-attention/approvals/decide", async (c) => {
    const body = (await c.req.json()) as {
      sessionId?: string;
      turnId?: string;
      blockId?: string;
      version?: number;
      decision?: "approve" | "deny";
      reason?: string | null;
    };
    if (!body.sessionId || !body.turnId || !body.blockId || typeof body.version !== "number") {
      return c.json({ error: "sessionId, turnId, blockId, and version are required" }, 400);
    }
    if (body.decision !== "approve" && body.decision !== "deny") {
      return c.json({ error: "decision must be approve or deny" }, 400);
    }
    await decideScoutWebPairingApproval(
      {
        sessionId: body.sessionId,
        turnId: body.turnId,
        blockId: body.blockId,
        version: body.version,
        decision: body.decision,
        reason: body.reason ?? null,
      },
      currentDirectory,
    );
    shellStateCache.invalidate();
    return c.json(await buildOperatorAttentionState(
      currentDirectory,
      options.captureTmuxPane ?? defaultCaptureTmuxPane,
    ));
  });
  app.post("/api/operator-attention/dismiss", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      recordKind?: unknown;
      recordId?: unknown;
      flightId?: unknown;
      conversationId?: unknown;
      messageId?: unknown;
      itemUpdatedAt?: unknown;
    };
    const recordKind = body.recordKind === "work_item" || body.recordKind === "question"
      ? body.recordKind
      : null;
    const recordId = typeof body.recordId === "string" ? body.recordId.trim() : "";
    const flightId = typeof body.flightId === "string" ? body.flightId.trim() : "";
    const conversationId = typeof body.conversationId === "string" ? body.conversationId.trim() : "";
    const messageId = typeof body.messageId === "string" ? body.messageId.trim() : "";
    const itemUpdatedAt = typeof body.itemUpdatedAt === "number" && Number.isFinite(body.itemUpdatedAt)
      ? body.itemUpdatedAt
      : 0;
    if (
      itemUpdatedAt <= 0
      || (!flightId && (!recordKind || !recordId) && (!conversationId || !messageId))
    ) {
      return c.json({
        error: "recordKind and recordId, flightId, or conversationId and messageId, plus itemUpdatedAt are required",
      }, 400);
    }
    if (flightId) {
      await dismissFlightAttention({ flightId, itemUpdatedAt });
    }
    if (conversationId && messageId) {
      await dismissConversationFailureAttention({ conversationId, messageId, itemUpdatedAt });
    } else if (!flightId && recordKind && recordId) {
      await dismissCollaborationAttention({ recordKind, recordId, itemUpdatedAt });
    }
    return c.json(await buildOperatorAttentionState(
      currentDirectory,
      options.captureTmuxPane ?? defaultCaptureTmuxPane,
    ));
  });
  app.post("/api/pairing/control", async (c) => {
    const { action } = (await c.req.json()) as {
      action: ScoutPairingControlAction;
    };
    const result = await controlScoutWebPairingService(
      action,
      currentDirectory,
    );
    shellStateCache.invalidate();
    return c.json(result);
  });
  app.delete("/api/pairing/peers/:fingerprint", async (c) => {
    const fingerprint = c.req.param("fingerprint");
    const removed = removeScoutPairingTrustedPeer(fingerprint);
    if (!removed) {
      return c.json({ error: "Peer not found" }, 404);
    }
    return c.json({ ok: true });
  });

  app.get("/api/shell-state", async (c) => c.json(await shellStateCache.get()));
  app.get("/api/shell-state/refresh", async (c) =>
    c.json(await shellStateCache.refresh()),
  );

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
  // The roster SQL behind /api/agents costs about a second of synchronous
  // event-loop block per read, and several surfaces poll it. A short coalesce
  // per distinct (limit, detail, attention) shape means a polling burst pays
  // for one read; the key space is bounded (limit is clamped to 100) and
  // capped besides. The DB layer stays untouched — this is route-level only.
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
  // What each terminal host can do, and whether it is installed here. Clients
  // read this to decide which actions to render, so a host that cannot do
  // something never gets a button that 400s.
  app.get("/api/terminal-hosts", async (c) => {
    const hosts = await describeTerminalHosts();
    const preferred = preferredTerminalHost(hosts);
    return c.json({
      ok: true,
      count: hosts.length,
      preferredHostId: preferred?.id ?? null,
      hosts,
    });
  });

  // A herdr session's workspace/tab/pane topology, projected read-only. Herdr
  // owns the layout; this exists so clients can REPRESENT a session faithfully
  // without Scout becoming a second layout manager. A stopped session projects
  // as running:false, an ordinary state rather than an error.
  app.get("/api/terminal-hosts/herdr/sessions/:name/topology", async (c) => {
    if (!terminalHostAdapter("herdr")) return c.json({ error: "unknown terminal host" }, 404);
    const name = c.req.param("name")?.trim();
    if (!name) return c.json({ error: "session name is required" }, 400);
    const topology = await readHerdrTopology(name);
    return c.json({ ok: true, topology });
  });

  // Handoff into the native herdr client: focus a pane/agent THERE. This is
  // deliberately not a TerminalSurfaceControlAction — focusing is a herdr
  // client action, not a Scout control verb over the surface.
  app.post("/api/terminal-hosts/herdr/sessions/:name/focus", async (c) => {
    if (!terminalHostAdapter("herdr")) return c.json({ error: "unknown terminal host" }, 404);
    const name = c.req.param("name")?.trim();
    if (!name) return c.json({ error: "session name is required" }, 400);
    const body = await c.req.json<{ target?: string }>().catch(() => null);
    const target = body?.target?.trim();
    if (!target) return c.json({ error: "target is required" }, 400);
    try {
      await execSystemFile("herdr", ["--session", name, "agent", "focus", target], { timeoutMs: 2_000 });
      return c.json({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "focus failed";
      return c.json({ ok: false, error: message }, 502);
    }
  });

  // Durable workspaces. The record is the web client's source of truth: it
  // seeds its deck from these routes and writes changes back, instead of
  // keeping a private store that cannot follow an operator to another device or
  // be reasoned about by the broker. macOS and iOS have not adopted it yet —
  // macOS still reads its own UserDefaults — so this is one client over a
  // shared object today, with the others to follow.
  app.get("/api/terminal-workspaces", async (c) => {
    const workspaces = queryTerminalWorkspaces({ limit: parseTerminalSessionLimit(c.req.query("limit")) });
    const resolutions = await resolveTerminalWorkspaces(workspaces);
    return c.json({ ok: true, count: workspaces.length, workspaces, resolutions });
  });

  app.get("/api/terminal-workspaces/:workspaceId", async (c) => {
    const workspace = queryTerminalWorkspace(c.req.param("workspaceId"));
    if (!workspace) return c.json({ error: "workspace not found" }, 404);
    const [resolution] = await resolveTerminalWorkspaces([workspace]);
    return c.json({ ok: true, workspace, resolution });
  });

  app.put("/api/terminal-workspaces/:workspaceId", async (c) => {
    const body = await c.req.json<TerminalWorkspaceRecordInput>().catch(() => null);
    const name = body?.name?.trim();
    if (!body || !name) return c.json({ error: "name is required" }, 400);
    const workspace = upsertTerminalWorkspace({
      ...body,
      id: c.req.param("workspaceId"),
      name,
    });
    return c.json({ ok: true, workspace });
  });

  app.post("/api/terminal-workspaces", async (c) => {
    const body = await c.req.json<TerminalWorkspaceRecordInput>().catch(() => null);
    const name = body?.name?.trim();
    if (!body || !name) return c.json({ error: "name is required" }, 400);
    return c.json({ ok: true, workspace: upsertTerminalWorkspace({ ...body, name }) }, 201);
  });

  // Re-materialize one saved cell. The only path that creates a host session
  // from stored intent, and it refuses unless reconciliation says the cell is
  // actually revivable — an operator is never told a tile came back when the
  // host was never asked.
  app.post("/api/terminal-workspaces/:workspaceId/cells/:cellId/revive", async (c) => {
    const workspace = queryTerminalWorkspace(c.req.param("workspaceId"));
    if (!workspace) return c.json({ error: "workspace not found" }, 404);
    const [resolution] = await resolveTerminalWorkspaces([workspace]);
    const cell = resolution?.cells.find((candidate) => candidate.cellId === c.req.param("cellId"));
    if (!cell) return c.json({ error: "cell not found" }, 404);
    if (cell.status === "live") return c.json({ ok: true, revived: false, status: cell.status, detail: cell.detail });
    if (cell.status !== "revivable" || !cell.revive) {
      return c.json({ error: cell.detail, status: cell.status, capability: "create" }, 409);
    }

    const adapter = terminalHostAdapter(cell.revive.hostId);
    if (!adapter?.create) {
      return c.json({ error: `${cell.revive.hostId} cannot be started by Scout`, capability: "create" }, 501);
    }
    // Probe for real before shelling out. Reconciliation reads a cached
    // availability that deliberately holds a recent success through a
    // momentary failure, and acting on that memory is how a revive turns into
    // an unhandled spawn error instead of a 409.
    const availability = await adapter.probe();
    if (!availability.installed) {
      return c.json({
        error: availability.reason ?? `${adapter.label} is not installed here`,
        status: "unavailable",
        capability: "create",
      }, 409);
    }
    const created = await adapter.create({
      sessionName: cell.revive.sessionName,
      cwd: cell.revive.cwd,
      resumeCommand: cell.revive.resumeCommand,
    });
    // A session that came back WITHOUT the harness the cell asked for is not
    // "live" in the sense the operator means, so it does not get to say so.
    // `started` is a distinct outcome with its own detail; the alternative is
    // reporting a resumed agent when what is actually there is a bare shell.
    const resumedHarness = created.resumed !== false;
    return c.json({
      ok: created.created,
      revived: created.created,
      status: created.created ? (resumedHarness ? "live" : "started") : cell.status,
      resumed: created.resumed ?? null,
      sessionName: cell.revive.sessionName,
      ...(created.reason
        ? { detail: created.reason }
        : created.created && !resumedHarness
          ? { detail: `Started ${cell.revive.hostId} session ${cell.revive.sessionName}, but Scout could not replay the harness command there.` }
          : {}),
    }, created.created ? 200 : 502);
  });

  app.delete("/api/terminal-workspaces/:workspaceId", (c) => {
    const deleted = deleteTerminalWorkspace(c.req.param("workspaceId"));
    return c.json({ ok: true, deleted });
  });

  // Create a session on a host. The one primitive behind both "start something
  // new" for a host the relay cannot render and the workspace revive path.
  // Guarded by the declared capability, so a host that does not create sessions
  // answers 501 instead of pretending.
  app.post("/api/terminal-hosts/:hostId/sessions", async (c) => {
    const adapter = terminalHostAdapter(c.req.param("hostId"));
    if (!adapter) return c.json({ error: "unknown terminal host" }, 404);
    if (!adapter.capabilities.create || !adapter.create) {
      return c.json({ error: `${adapter.label} sessions cannot be started by Scout`, capability: "create" }, 501);
    }
    const body = await c.req.json<{ sessionName?: string; cwd?: string | null }>().catch(() => null);
    const sessionName = body?.sessionName?.trim();
    if (!sessionName) return c.json({ error: "sessionName is required" }, 400);
    const availability = await adapter.probe();
    if (!availability.installed) {
      return c.json({ error: availability.reason ?? `${adapter.label} is not installed here` }, 409);
    }
    const created = await adapter.create({ sessionName, cwd: body?.cwd ?? null });
    return c.json(
      { ok: created.created, created: created.created, hostId: adapter.id, sessionName, ...(created.reason ? { detail: created.reason } : {}) },
      created.created ? 201 : 502,
    );
  });

  app.get("/api/terminal-sessions", async (c) => {
    const backend = parseTerminalSessionBackend(c.req.query("backend"));
    if (c.req.query("backend") && !backend) {
      return c.json({ error: "backend must be a registered terminal host" }, 400);
    }
    const limit = parseTerminalSessionLimit(c.req.query("limit"));
    const sessions = queryTerminalSessions({
      ...(c.req.query("harness") ? { harness: c.req.query("harness") } : {}),
      ...(c.req.query("sourceSessionId") ? { sourceSessionId: c.req.query("sourceSessionId") } : {}),
      ...(backend ? { backend } : {}),
      limit,
    });
    const includeDiscovered = parseTerminalSessionDiscoveryFlag(c.req.query("includeDiscovered"));
    const discovered = includeDiscovered
      ? await queryDiscoveredTerminalSessions({
          ...(backend ? { backend } : {}),
          // Read the full host inventory so a registered surface can inherit
          // authoritative activity even when it is already at the result cap.
          limit: 1000,
        })
      : [];
    const visibleSessions = includeDiscovered
      ? reconcileTerminalSessionInventory(sessions, discovered, limit)
      : sessions;
    return c.json({
      ok: true,
      count: visibleSessions.length,
      sessions: visibleSessions,
    });
  });
  app.get("/api/terminal-sessions/peek", async (c) => {
    const backend = parseTerminalSessionBackend(c.req.query("backend"));
    const sessionName = firstMetadataString(c.req.query("sessionName"));
    const capturedAt = Date.now();
    const lines = parseTmuxPeekLineCount(c.req.query("lines"));
    const columns = parseTmuxPeekColumnCount(c.req.query("cols") ?? c.req.query("columns"));

    if (!backend) {
      return c.json({ error: "backend must be a registered terminal host" }, 400);
    }
    if (!sessionName) {
      return c.json({ error: "sessionName is required" }, 400);
    }
    const previewHost = terminalHostAdapter(backend);
    if (!previewHost?.capabilities.capture) {
      return c.json({
        available: false,
        agentId: "terminal",
        sessionId: sessionName,
        capturedAt,
        body: "",
        lineCount: lines,
        columnCount: columns,
        truncated: false,
        reason: `${previewHost?.label ?? backend} does not report screen contents.`,
      });
    }
    if (backend !== "tmux") {
      // tmux keeps the dedicated capture path (line/column normalization, the
      // injectable capture hook the tests drive); other hosts go through the
      // adapter's own capture verb. `paneId` lets multi-pane hosts (herdr)
      // capture one pane instead of the session default.
      const paneId = firstMetadataString(c.req.query("paneId"));
      const body = await previewHost.capture?.({ sessionName, ...(paneId ? { paneId } : {}), lines });
      // normalizeTmuxPeekBody returns {body, lineCount, columnCount, truncated}
      // — spread the shape, don't nest it under `body` as one object.
      const normalized = body ? normalizeTmuxPeekBody(body, lines, columns) : null;
      return c.json({
        available: Boolean(body),
        agentId: "terminal",
        sessionId: sessionName,
        capturedAt,
        body: normalized?.body ?? "",
        lineCount: normalized?.lineCount ?? lines,
        columnCount: normalized?.columnCount ?? columns,
        truncated: normalized?.truncated ?? false,
        ...(body ? {} : { reason: `The ${previewHost.label} session is not available right now.` }),
      });
    }

    const capture = await (options.captureTmuxPane ?? defaultCaptureTmuxPane)({
      agentId: "terminal",
      sessionId: sessionName,
      paneTarget: sessionName,
      cwd: null,
      lines,
      columns,
    });
    if (!capture) {
      return c.json({
        available: false,
        agentId: "terminal",
        sessionId: sessionName,
        capturedAt,
        body: "",
        lineCount: lines,
        columnCount: columns,
        truncated: false,
        reason: "The tmux pane is not available right now.",
      });
    }

    const normalized = normalizeTmuxPeekBody(capture.body, lines, columns);
    return c.json({
      available: true,
      agentId: "terminal",
      sessionId: sessionName,
      capturedAt,
      body: normalized.body,
      lineCount: capture.lineCount ?? normalized.lineCount,
      columnCount: normalized.columnCount,
      truncated: capture.truncated ?? normalized.truncated,
      reason: null,
    });
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
    const { buildAgentDefinitions } = await import("./agent-definitions.ts");
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
    const body = (await c.req.json().catch(() => ({}))) as {
      target?: { agentId?: string; projectPath?: string };
      execution?: {
        harness?: string;
        model?: string;
        reasoningEffort?: string;
        session?: string;
        targetSessionId?: string;
        forkFromSessionId?: string;
        forkFromStateId?: string;
      };
      agent?: {
        persistence?: string;
        handle?: string;
      };
      seed?: {
        instructions?: string;
        clientMessageId?: string;
        fromMessageId?: string;
        fromConversationId?: string;
        attachments?: OutgoingAttachmentInput[];
        branchFrom?: { sessionId?: string; messageId?: string };
      };
    };

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
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
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
    const nativeTranscript = agent.harness
      ? mostRecentTranscriptForHarnessCwd(
          (await tailRuntime.getTailDiscovery().catch(() => null))?.transcripts ?? [],
          agent.harness,
          cwd,
        )
      : null;
    return c.json(
      buildAgentSessionCatalogPayload({
        agentId,
        harness: agent.harness,
        cwd,
        transport: agent.transport,
        terminalSurface: agent.terminalSurface,
        activeSessionId: endpoint?.sessionId ?? agent.harnessSessionId,
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
  app.get("/api/activity", (c) => c.json(queryActivity()));
  app.get("/api/topology/snapshot", async (c) => {
    const sessionId = c.req.query("sessionId")?.trim() || null;
    if (sessionId) {
      // Session-scoped reads stay uncached: each session id is its own scan.
      const localSnapshot = await readLocalHarnessTopologySnapshot({ claudeSessionId: sessionId });
      if (localSnapshot) return c.json(localSnapshot);
    }

    const force = c.req.query("force") === "1";
    const url = new URL(scoutBrokerPaths.v1.topologySnapshot, resolveScoutBrokerUrl());
    if (force) {
      url.searchParams.set("force", "1");
    }
    const localFallback = () => localTopologySnapshotCache.get({ force }).catch(() => null);
    try {
      // A broker mid-rebuild can sit on this for a long time; an unbounded
      // fetch left the route hanging with it. Past the deadline the local
      // observer answers instead.
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) {
        const brokerSnapshot = await res.json();
        if (brokerSnapshot?.totals?.sources > 0) {
          // The broker answered with substance — never rescan locally on top.
          return c.json(brokerSnapshot);
        }
        const localSnapshot = await localFallback();
        return c.json(localSnapshot?.totals.sources ? localSnapshot : brokerSnapshot);
      }
    } catch {
      /* Fall through to the local read-only observer. */
    }
    const localSnapshot = await localFallback();
    if (localSnapshot) return c.json(localSnapshot);
    return c.json({ error: "broker topology unavailable" }, 502);
  });
  app.get("/api/broker", async (c) => {
    const cursor = c.req.query("cursor") ?? null;
    const diagnostics = queryBrokerDiagnostics({
      limit: parseOptionalPositiveInt(c.req.query("limit"), 120),
      windowMs: parseOptionalPositiveInt(c.req.query("windowMs")),
      cursor,
      scopeRowsToWindow: c.req.query("scopeRowsToWindow") === "1"
        || c.req.query("scopeRowsToWindow") === "true",
    });
    let broker = await dispatchBrokerSnapshotCache.get().catch(() => null);
    if (broker && brokerDiagnosticsNeedsFullSnapshot(diagnostics, broker)) {
      const completeSnapshot = await dispatchFullBrokerSnapshotCache.get().catch(() => null);
      broker = completeSnapshot
        ? {
            actors: completeSnapshot.actors,
            messages: completeSnapshot.messages,
            totalMessageCount: broker.totalMessageCount,
            projectionStatus: broker.projectionStatus,
            messageCoverageIncomplete: false,
          }
        : { ...broker, messageCoverageIncomplete: true };
    }
    const brokerHealth = broker
      ? null
      : await readScoutBrokerHealth(resolveScoutBrokerUrl(), {
          signal: AbortSignal.timeout(1_000),
        });
    return c.json(
      broker
        ? mergeBrokerDiagnosticsWithLiveSnapshot(diagnostics, broker, cursor)
        : markBrokerDiagnosticsLiveUnavailable(diagnostics, {
            brokerReachable: brokerHealth?.reachable === true && brokerHealth.ok,
          }),
    );
  });
  app.post("/api/broker/dispatch-review", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      attemptId?: string;
      attempt?: BrokerDispatchReviewAttempt;
    };
    const attemptId = optionalString(body.attemptId)?.trim()
      || optionalString(body.attempt?.id)?.trim();
    const windowMs = 30 * 60_000;
    const diagnostics = queryBrokerDiagnostics({
      limit: 240,
      windowMs,
      scopeRowsToWindow: true,
    });
    const candidates = [
      ...diagnostics.failedDeliveries,
      ...diagnostics.failedQueries,
      ...diagnostics.attempts,
    ];
    // Dispatch renders one message-oriented row by folding its delivery state
    // into the message. That synthesized row id may not exist in the raw
    // diagnostics candidates, so prefer canonical broker data when available
    // and otherwise review the exact snapshot the operator inspected.
    const attempt = (attemptId
      ? candidates.find((entry) => entry.id === attemptId)
      : undefined) ?? body.attempt;
    if (!attempt?.id) {
      return c.json({ error: "attemptId or attempt is required" }, 400);
    }
    if (attempt.kind !== "failed_delivery" && attempt.kind !== "failed_query" && attempt.status !== "failed") {
      return c.json({ error: "dispatch review requires a failed dispatch row" }, 400);
    }

    const dedupeFingerprint = brokerAttemptReviewFingerprint(attempt);
    const rootCauseFingerprint = brokerAttemptReviewRootCauseFingerprint(attempt);
    const related = candidates
      .filter((entry) => entry.id !== attempt.id)
      .filter((entry) =>
        brokerAttemptReviewFingerprint(entry) === dedupeFingerprint
        || brokerAttemptReviewRootCauseFingerprint(entry) === rootCauseFingerprint
        || Boolean(attempt.messageId && entry.messageId === attempt.messageId)
        || Boolean(attempt.conversationId && entry.conversationId === attempt.conversationId)
        || (
          Boolean(attempt.target && entry.target === attempt.target)
          && Boolean(attempt.route && entry.route === attempt.route)
          && entry.kind === attempt.kind
        )
      )
      .slice(0, 12);
    const requestMetadata = {
      source: "scout-dispatch-review",
      dispatchAttemptId: attempt.id,
      ...(attempt.deliveryId ? { deliveryId: attempt.deliveryId } : {}),
      ...(attempt.messageId ? { messageId: attempt.messageId } : {}),
      ...(attempt.conversationId ? { conversationId: attempt.conversationId } : {}),
      ...(attempt.target ? { targetId: attempt.target } : {}),
      ...(attempt.route ? { transport: attempt.route } : {}),
      dedupeFingerprint,
      rootCauseFingerprint,
    };

    const result = await askScoutQuestion({
      senderId: resolveOperatorName().trim() || "operator",
      target: { kind: "project_path", projectPath: currentDirectory },
      body: brokerDispatchReviewPrompt({ attempt, related, windowMs }),
      executionHarness: "codex",
      projectAgent: {
        persistence: "one_time",
      },
      currentDirectory,
      source: "scout-dispatch-review",
      messageMetadata: requestMetadata,
      invocationMetadata: requestMetadata,
    });

    if (!result.usedBroker) {
      return c.json({ error: "broker unreachable" }, 502);
    }
    if (result.unresolvedTarget) {
      return c.json(
        {
          error: `could not route dispatch review to ${result.unresolvedTarget}`,
          targetDiagnostic: result.targetDiagnostic ?? null,
        },
        409,
      );
    }

    return c.json({
      ok: true,
      conversationId: result.conversationId ?? null,
      messageId: result.messageId ?? null,
      flightId: result.flight?.id ?? null,
      targetAgentId: result.flight?.targetAgentId ?? result.targetAgentId ?? null,
      targetLabel: result.targetLabel ?? null,
      dedupeFingerprint,
      rootCauseFingerprint,
    });
  });
  app.get("/api/heartrate", (c) => c.json(queryHeartrate()));
  app.get("/api/service-budgets", async (c) => {
    const refresh = c.req.query("refresh");
    return c.json(await loadServiceBudgets(refresh === "1" || refresh === "true"));
  });
  app.post("/api/service-budgets/dashboard-import", async (c) => {
    const body = await c.req.json<{ provider?: unknown; text?: unknown }>().catch(() => null);
    try {
      const gauge = importProviderDashboardUsage({
        provider: body?.provider,
        text: body?.text,
      });
      return c.json({ ok: true, gauge });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Dashboard import failed." }, 400);
    }
  });
  // /api/fleet is polled from dozens of client sites at 10-15s intervals, and
  // every poll re-ran the same SQL assembly. A short coalesce window means one
  // assembly serves the burst. The result varies with the query params, so each
  // distinct param set gets its own window; the param space is a handful of
  // fixed client call sites, with a cap so hand-crafted queries cannot grow the
  // map without bound.
  const fleetResponseCache = new Map<string, () => Promise<ReturnType<typeof queryFleet>>>();
  const readFleetResponse = (opts: {
    limit?: number;
    activityLimit?: number;
    activityLookbackMs?: number;
  }) => {
    const key = `${opts.limit ?? ""}|${opts.activityLimit ?? ""}|${opts.activityLookbackMs ?? ""}`;
    let entry = fleetResponseCache.get(key);
    if (!entry) {
      if (fleetResponseCache.size >= 32) fleetResponseCache.clear();
      entry = coalesce(async () => queryFleet(opts), 1_500);
      fleetResponseCache.set(key, entry);
    }
    return entry();
  };
  app.get("/api/fleet", async (c) =>
    c.json(
      await readFleetResponse({
        limit: parseOptionalPositiveInt(c.req.query("limit")),
        activityLimit: parseOptionalPositiveInt(c.req.query("activityLimit")),
        activityLookbackMs: parseOptionalPositiveInt(c.req.query("activityLookbackMs")),
      }),
    ),
  );
  app.get("/api/messages", async (c) => {
    const cId = c.req.query("chatId")
      || c.req.query("cId")
      || c.req.query("conversationId")
      || undefined;
    if (cId && !isOpaqueChannelId(cId)) {
      return c.json({ error: "chatId must be an opaque chat id" }, 400);
    }
    // Clamp once, before choosing a source: the broker projection and the
    // SQLite fallback must never disagree about how big a page is.
    const limit = clampMessagePageLimit(
      parseOptionalPositiveInt(c.req.query("limit"), DEFAULT_MESSAGE_PAGE_LIMIT),
      DEFAULT_MESSAGE_PAGE_LIMIT,
    );
    const beforeMessageId = c.req.query("beforeMessageId")?.trim() || undefined;
    let messages;
    try {
      // Cursor shape is the route's business — a malformed cursor is a 400
      // whichever source would have answered. Whether the cursor still resolves
      // is the source's business, and the source throws the same error type.
      parseMessageHistoryCursor(beforeMessageId);
      const brokerContext = cId
        ? await loadScoutBrokerContext(undefined, {
            scope: "conversations",
            waitForInitial: false,
            initialRefreshDelayMs: 750,
          }).catch(() => null)
        : null;
      const brokerMessages = cId
        ? await getScoutConversationMessages(cId, limit, beforeMessageId, brokerContext)
        : null;
      if (cId && brokerMessages && brokerMessages.length > 0 && brokerMessages.length < limit) {
        // The broker snapshot is a rolling window: a short page means the
        // window starts mid-transcript, not that the transcript starts there.
        // An aged conversation re-minted live by new traffic would otherwise
        // serve only the new tail while SQLite still holds the history, so
        // extend the page below the window from the durable projection.
        const oldest = brokerMessages[0];
        const seen = new Set(brokerMessages.map((message) => message.id));
        const older = queryRecentMessages(limit - brokerMessages.length, {
          conversationId: cId,
          beforeMessageId: encodeMessageHistoryCursor({
            createdAt: oldest.createdAt,
            id: oldest.id,
          }),
        }).filter((message) => !seen.has(message.id));
        // Projection pages are newest-first; flip them under the broker's
        // ascending page so the merge reads as one transcript.
        messages = [...older.reverse(), ...brokerMessages];
      } else {
        messages = brokerMessages ?? queryRecentMessages(
          limit,
          { conversationId: cId, beforeMessageId },
        );
      }
    } catch (cause) {
      // An unreadable cursor is a client error, not the end of the transcript.
      // Answering [] here is what strands history behind a deleted anchor.
      if (cause instanceof MessageCursorError) {
        return c.json({ error: cause.message, reason: cause.reason }, 400);
      }
      throw cause;
    }
    return c.json(messages.map((message) => ({
      ...message,
      chatId: message.conversationId,
      cId: message.conversationId,
    })));
  });
  const rawHeuristicsFromRequest = async (c: Context): Promise<string> => {
    const body = await c.req.json().catch(() => null) as unknown;
    if (body && typeof body === "object" && !Array.isArray(body) && typeof (body as { raw?: unknown }).raw === "string") {
      return (body as { raw: string }).raw;
    }
    return `${JSON.stringify(body ?? {}, null, 2)}\n`;
  };
  app.get("/api/heuristics/defaults", (c) => c.json(defaultHeuristicsResponse()));
  app.get("/api/heuristics/global", (c) => {
    const result = globalHeuristicsFile();
    return "config" in result ? c.json(result) : c.json(result, 400);
  });
  app.put("/api/heuristics/global", async (c) => {
    const result = writeGlobalHeuristicsFile(await rawHeuristicsFromRequest(c));
    return "config" in result ? c.json(result) : c.json(result, 400);
  });
  app.get("/api/heuristics/project", (c) => {
    const workspaceRoot = c.req.query("workspaceRoot");
    if (!workspaceRoot) {
      return c.json({ error: "workspaceRoot is required" }, 400);
    }
    const result = projectHeuristicsFile(workspaceRoot);
    return "config" in result ? c.json(result) : c.json(result, 400);
  });
  app.put("/api/heuristics/project", async (c) => {
    const workspaceRoot = c.req.query("workspaceRoot");
    if (!workspaceRoot) {
      return c.json({ error: "workspaceRoot is required" }, 400);
    }
    const result = writeProjectHeuristicsFile(workspaceRoot, await rawHeuristicsFromRequest(c));
    return "config" in result ? c.json(result) : c.json(result, 400);
  });
  app.get("/api/plan-documents", async (c) => {
    const agents = queryAgents();
    return c.json(await indexPlanDocuments({
      currentDirectory,
      workspaces: agents.map((agent) => ({
        agentId: agent.id,
        agentName: agent.name,
        cwd: agent.cwd,
        project: agent.project,
        projectRoot: agent.projectRoot,
      })),
    }));
  });
  const handleListWork = (c: Context) => {
    const agentId = c.req.query("agentId");
    const conversationId = c.req.query("conversationId");
    const activeOnly = c.req.query("active") !== "false";
    const rawLimit = Number(c.req.query("limit"));
    const limit = Number.isFinite(rawLimit)
      ? Math.min(250, Math.max(1, Math.floor(rawLimit)))
      : undefined;
    return c.json(
      queryWorkItems({
        agentId: agentId || undefined,
        conversationId: conversationId || undefined,
        activeOnly,
        limit,
      }),
    );
  };
  const handleWorkDetail = async (c: Context) => {
    const workId = c.req.param("id");
    if (!workId) {
      return c.json({ error: "id is required" }, 400);
    }
    const detail = queryWorkItemById(workId);
    if (!detail) {
      return c.json({ error: "not found" }, 404);
    }
    const inventory = await buildWorkMaterialsInventory(detail);
    return c.json({ ...detail, inventory });
  };
  const handleWorkInventory = async (c: Context) => {
    const workId = c.req.param("id");
    if (!workId) {
      return c.json({ error: "id is required" }, 400);
    }
    const detail = queryWorkItemById(workId);
    if (!detail) {
      return c.json({ error: "not found" }, 404);
    }
    return c.json(await buildWorkMaterialsInventory(detail));
  };
  const handleWorkMaterialContent = async (c: Context) => {
    const workId = c.req.param("id");
    const materialId = c.req.query("materialId");
    if (!workId) {
      return c.json({ error: "id is required" }, 400);
    }
    if (!materialId) {
      return c.json({ error: "materialId is required" }, 400);
    }
    const detail = queryWorkItemById(workId);
    if (!detail) {
      return c.json({ error: "not found" }, 404);
    }
    const result = await readWorkMaterialContent(detail, materialId);
    if (!result.ok) {
      return c.json({ error: result.error }, result.status as 400 | 403 | 404 | 410 | 415);
    }
    return c.json(result.content);
  };
  const handleWorkMaterialRaw = async (c: Context) => {
    const workId = c.req.param("id");
    const materialId = c.req.query("materialId");
    if (!workId) {
      return c.json({ error: "id is required" }, 400);
    }
    if (!materialId) {
      return c.json({ error: "materialId is required" }, 400);
    }
    const detail = queryWorkItemById(workId);
    if (!detail) {
      return c.json({ error: "not found" }, 404);
    }
    const result = await readWorkMaterialRaw(detail, materialId);
    if (!result.ok) {
      return c.json({ error: result.error }, result.status as 400 | 403 | 404 | 410 | 415);
    }
    return new Response(Bun.file(result.realPath), {
      headers: {
        "content-type": result.mediaType,
        "cache-control": "private, max-age=60",
      },
    });
  };
  app.get("/api/work", handleListWork);
  app.get("/api/tasks", handleListWork);
  app.get("/api/work/:id", handleWorkDetail);
  app.get("/api/work/:id/inventory", handleWorkInventory);
  app.get("/api/work/:id/material", handleWorkMaterialContent);
  app.get("/api/work/:id/material/raw", handleWorkMaterialRaw);
  app.get("/api/tasks/:id", handleWorkDetail);

  // Mesh Ops — attention-ordered work items across hosts (local broker only),
  // plus observed runtime sessions inside the seven-day lookback as scan rows.
  app.get("/api/mesh-ops", (c) => {
    const machineId = c.req.query("machineId");
    const rawLimit = Number(c.req.query("limit"));
    const limit = Number.isFinite(rawLimit)
      ? Math.min(250, Math.max(1, Math.floor(rawLimit)))
      : undefined;
    return c.json({
      generatedAt: new Date().toISOString(),
      items: [
        ...queryMeshOpsItems({ machineId: machineId || undefined, limit }),
        ...queryMeshOpsSessions({ machineId: machineId || undefined }),
      ],
      hosts: queryMeshOpsHosts(),
    });
  });
  const handleMeshOpsActuation = (action: MeshOpsActuation) => async (c: Context) => {
    const id = c.req.param("id");
    if (!id) {
      return c.json({ error: "id is required" }, 400);
    }
    const record = queryMeshOpsWorkRecord(id);
    if (!record) {
      return c.json({ error: "not found" }, 404);
    }
    if (action === "hold" && record.state !== "open" && record.state !== "working") {
      return c.json({ error: `cannot hold a work item in ${record.state}` }, 409);
    }
    if (
      action === "release"
      && (
        record.state !== "waiting"
        || record.nextMoveOwnerId !== "operator"
        || record.waitingOn?.label !== "Held by operator"
      )
    ) {
      return c.json({ error: "only an operator-held work item can be released" }, 409);
    }
    if (action === "accept" && record.state !== "review") {
      return c.json({ error: `cannot accept a work item in ${record.state}` }, 409);
    }
    if (action === "clear" && record.state === "review") {
      return c.json({ error: "a review item must be explicitly accepted" }, 409);
    }
    try {
      if (action === "clear") {
        await dismissCollaborationAttention({
          recordKind: "work_item",
          recordId: record.id,
          itemUpdatedAt: record.updatedAt,
        });
        return c.json({ ok: true, action: "dismissed", record });
      }
      const actuation = buildMeshOpsActuation(record, action, Date.now());
      await upsertScoutCollaborationRecord(actuation.record);
      await appendScoutCollaborationEvent(actuation.event);
      return c.json({
        ok: true,
        action,
        record: actuation.record,
      });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 502);
    }
  };
  app.post("/api/mesh-ops/items/:id/hold", handleMeshOpsActuation("hold"));
  app.post("/api/mesh-ops/items/:id/release", handleMeshOpsActuation("release"));
  app.post("/api/mesh-ops/items/:id/accept", handleMeshOpsActuation("accept"));
  app.post("/api/mesh-ops/items/:id/clear", handleMeshOpsActuation("clear"));

  // Assigned roles + mission log — proxy to broker (canonical writer).
  app.get("/api/roles/catalog", (c) => c.json({ roles: SCOUT_ROLE_CATALOG }));
  app.get("/api/roles/assignments", async (c) => {
    try {
      const assignments = await webListRoleAssignments({
        agentId: c.req.query("agentId") || undefined,
        missionId: c.req.query("missionId") || undefined,
        roleId: c.req.query("roleId") || undefined,
        activeOnly: c.req.query("activeOnly") !== "0" && c.req.query("activeOnly") !== "false",
        includeStanding: c.req.query("includeStanding") !== "0",
        limit: parseOptionalPositiveInt(c.req.query("limit")),
      });
      return c.json({ assignments });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });
  app.post("/api/roles/assignments", async (c) => {
    try {
      const body = await c.req.json() as {
        roleId?: string;
        agentId?: string;
        scope?: { kind?: string; missionId?: string; projectRoot?: string };
        assignedById?: string;
        enforceSingleOrchestrator?: boolean;
        metadata?: Record<string, unknown>;
      };
      if (!body.roleId?.trim() || !body.agentId?.trim()) {
        return c.json({ error: "roleId and agentId are required" }, 400);
      }
      const kind = (body.scope?.kind ?? "agent").trim();
      let scope: { kind: "mission"; missionId: string } | { kind: "agent" } | { kind: "project"; projectRoot: string };
      if (kind === "mission") {
        if (!body.scope?.missionId?.trim()) {
          return c.json({ error: "scope.missionId is required for mission scope" }, 400);
        }
        scope = { kind: "mission", missionId: body.scope.missionId.trim() };
      } else if (kind === "project") {
        if (!body.scope?.projectRoot?.trim()) {
          return c.json({ error: "scope.projectRoot is required for project scope" }, 400);
        }
        scope = { kind: "project", projectRoot: body.scope.projectRoot.trim() };
      } else if (kind === "agent") {
        scope = { kind: "agent" };
      } else {
        return c.json({ error: `unknown scope.kind: ${kind}` }, 400);
      }
      const assignment = await webAssignRole({
        roleId: body.roleId.trim(),
        agentId: body.agentId.trim(),
        scope,
        assignedById: body.assignedById?.trim() || "operator",
        enforceSingleOrchestrator: body.enforceSingleOrchestrator,
        metadata: body.metadata,
      });
      return c.json({ assignment }, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = /unknown role|already has orchestrator|required|unknown scope/i.test(message) ? 400 : 500;
      return c.json({ error: message }, status);
    }
  });
  app.post("/api/roles/assignments/:id/revoke", async (c) => {
    try {
      const id = c.req.param("id");
      if (!id) return c.json({ error: "id is required" }, 400);
      const body = await c.req.json().catch(() => ({})) as { revokedById?: string };
      const assignment = await webRevokeRole({
        assignmentId: id,
        revokedById: body.revokedById?.trim() || "operator",
      });
      return c.json({ assignment });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = /unknown role assignment/i.test(message) ? 404 : 500;
      return c.json({ error: message }, status);
    }
  });
  app.get("/api/missions/:missionId/log", async (c) => {
    try {
      const missionId = c.req.param("missionId");
      if (!missionId) return c.json({ error: "missionId is required" }, 400);
      const afterSeq = parseOptionalPositiveInt(c.req.query("afterSeq"));
      const entries = await webListMissionLog({
        missionId,
        limit: parseOptionalPositiveInt(c.req.query("limit")),
        afterSeq: afterSeq ?? undefined,
      });
      return c.json({ missionId, entries });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });
  app.post("/api/missions/:missionId/log", async (c) => {
    try {
      const missionId = c.req.param("missionId");
      if (!missionId) return c.json({ error: "missionId is required" }, 400);
      const body = await c.req.json() as {
        actorId?: string;
        kind?: string;
        intent?: string;
        status?: string;
        checkpoint?: string;
        nodeId?: string;
        note?: string;
        blockers?: Array<{ label: string; ownerId?: string }>;
        refs?: Record<string, string>;
        projectRoot?: string;
      };
      if (!body.actorId?.trim() || !body.kind || !body.intent?.trim() || !body.status?.trim()) {
        return c.json({ error: "actorId, kind, intent, and status are required" }, 400);
      }
      // Client bypassPermission is intentionally ignored; projectRoot is
      // required for project-scoped orchestrator permission matching.
      const entry = await webAppendMissionLog(
        {
          missionId,
          actorId: body.actorId.trim(),
          kind: body.kind as import("@openscout/protocol").ScoutMissionLogKind,
          intent: body.intent,
          status: body.status,
          checkpoint: body.checkpoint,
          nodeId: body.nodeId,
          note: body.note,
          blockers: body.blockers,
          refs: body.refs,
        },
        { projectRoot: body.projectRoot?.trim() || undefined },
      );
      return c.json({ entry }, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = /not an assigned|invalid mission log|unknown/i.test(message) ? 400 : 500;
      return c.json({ error: message }, status);
    }
  });
  app.get("/api/runs", (c) => {
    const agentId = c.req.query("agentId");
    const conversationId = c.req.query("conversationId");
    const collaborationRecordId = c.req.query("collaborationRecordId");
    const workId = c.req.query("workId");
    const state = c.req.query("state");
    const source = c.req.query("source");
    const active = parseOptionalBoolean(c.req.query("active"));
    const limit = parseOptionalPositiveInt(c.req.query("limit"));
    return c.json(
      queryRuns({
        agentId: agentId || undefined,
        conversationId: conversationId || undefined,
        collaborationRecordId: collaborationRecordId || undefined,
        workId: workId || undefined,
        state: state || undefined,
        source: source || undefined,
        active,
        limit,
      }),
    );
  });
  app.get("/api/flights", async (c) => {
    const flightId = c.req.query("flightId");
    const agentId = c.req.query("agentId");
    const conversationId = c.req.query("conversationId");
    const collaborationRecordId = c.req.query("collaborationRecordId");
    const activeOnly = c.req.query("active") !== "false";
    if (conversationId && !isOpaqueChannelId(conversationId)) {
      return c.json({ error: "chatId must be an opaque chat id" }, 400);
    }
    const query = {
      flightId: flightId || undefined,
      agentId: agentId || undefined,
      conversationId: conversationId || undefined,
      collaborationRecordId: collaborationRecordId || undefined,
      activeOnly,
    };
    const flights = queryFlights(query);
    if (flights.length > 0) {
      return c.json(flights);
    }
    const broker = await loadScoutBrokerContext(undefined, {
      scope: "conversations",
      waitForInitial: false,
      initialRefreshDelayMs: 750,
    }).catch(() => null);
    return c.json(broker ? queryBrokerFlightsForWeb(broker, query) : flights);
  });
  app.get("/api/follow", (c) => {
    const conversationId = c.req.query("conversationId") || undefined;
    if (conversationId && !isOpaqueChannelId(conversationId)) {
      return c.json({ error: "chatId must be an opaque chat id" }, 400);
    }
    return c.json(
      queryFollowTarget({
        flightId: c.req.query("flightId") || undefined,
        invocationId: c.req.query("invocationId") || undefined,
        conversationId,
        workId: c.req.query("workId") || undefined,
        sessionId: c.req.query("sessionId") || undefined,
        targetAgentId: c.req.query("targetAgentId") || undefined,
      }),
    );
  });
  const readCommsList = async (
    c: Context,
    options: { preferMaterialized?: boolean } = {},
  ) => {
    const rawLimit = Number(c.req.query("limit"));
    const rawKinds = c.req.query("kinds")?.trim();
    const filters = {
      query: c.req.query("query") || undefined,
      limit: Number.isFinite(rawLimit) ? Math.min(250, Math.max(1, Math.floor(rawLimit))) : undefined,
      kinds: parseConversationKinds(rawKinds),
      machineId: c.req.query("machineId") || undefined,
    };
    // `/api/comms` is a bounded list/enrichment read. Keep it on the durable,
    // indexed projection even after rich broker state has warmed; selected
    // conversations load their complete detail through `/api/session/:id`.
    const preferredProjection = options.preferMaterialized && !filters.machineId
      ? await readScoutConversationProjection(160)
      : undefined;
    if (preferredProjection?.items.some((item) => item.entityKind === "scout_conversation")) {
      return {
        items: provisionalScoutConversations(preferredProjection, filters),
        listReady: true,
      };
    }

    const broker = await loadScoutBrokerContext(
      undefined,
      filters.machineId
        ? {}
        : {
            scope: "conversations",
            waitForInitial: false,
            initialRefreshDelayMs: 750,
          },
    ).catch(() => null);
    if (broker) {
      // A concrete broker snapshot makes an empty result authoritative for this
      // request. Search/machine/kind filters, hidden system records, and bounded
      // history can all legitimately produce zero visible rows even when the
      // canonical store itself is nonempty.
      const items = await getScoutConversations(filters, broker);
      return { items, listReady: true };
    }

    if (!filters.machineId) {
      // The broker owns the records, while its SQLite projection gives the web
      // process a durable, already-indexed cold-start view. A non-empty
      // projection is safe to paint immediately.
      const launchProjection = preferredProjection === undefined
        ? await readScoutConversationProjection(Math.min(160, filters.limit ?? 160))
        : preferredProjection;
      // The shared projection also contains observed harness sessions. Those
      // rows are intentionally not web chats, so an observed-only top page is
      // not evidence that this endpoint has a usable Scout list (a busy fleet
      // can push older Scout rows below the shared 160-row launch window).
      if (launchProjection?.items.some((item) => item.entityKind === "scout_conversation")) {
        return {
          items: provisionalScoutConversations(launchProjection, filters),
          listReady: true,
        };
      }

      // Compatibility fallback for a broker that has not produced the shared
      // SCO-102 projection yet. This path is intentionally secondary: it has
      // less complete semantics and is retired once the shared view is proven.
      const projected = querySessions(250);
      if (projected.length > 0) {
        const query = filters.query?.trim().toLocaleLowerCase() ?? "";
        const kinds = filters.kinds ? new Set<string>(filters.kinds) : null;
        const items = projected
          .filter((item) => !kinds || kinds.has(item.kind))
          .filter((item) => !query || [
            item.title,
            item.alias,
            item.agentName,
            item.preview,
          ].some((value) => value?.toLocaleLowerCase().includes(query)))
          .slice(0, filters.limit ?? projected.length);
        return { items, listReady: true };
      }
    }

    // With no readable broker context, an empty array is not a valid recovery
    // fallback. Only expose a genuinely empty store after broker startup and
    // canonical counts independently agree. SQLite is not a prerequisite: the
    // conversation source is the broker registry, and its projection may be
    // intentionally disabled.
    const health = await readScoutBrokerHealth(resolveScoutBrokerUrl(), {
      signal: AbortSignal.timeout(2_000),
    });
    const listReady = health.reachable
      && health.ok
      && health.startup?.state === "ready"
      && health.startup.mutationsAdmitted === true
      && health.counts?.conversations === 0
      && health.counts.messages === 0;
    return { items: [], listReady };
  };

  const unavailableConversationList = (c: Context) => c.json({
    error: "conversation_list_restoring",
    detail: "Scout has not confirmed an empty conversation store. Existing conversations are still restoring.",
    retryable: true,
  }, 503);

  app.get("/api/comms", async (c) => {
    const { items, listReady } = await readCommsList(c, { preferMaterialized: true });
    if (!listReady) {
      return unavailableConversationList(c);
    }
    return c.json(items.map((item) => ({
      ...item,
      chatId: item.id,
      cId: item.id,
    })));
  });

  app.get("/api/conversations", async (c) => {
    const { items, listReady } = await readCommsList(c);
    return listReady
      ? c.json(items)
      : unavailableConversationList(c);
  });

  app.post("/api/conversations/direct", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      agentId?: unknown;
      targetAgentId?: unknown;
      targetLabel?: unknown;
      projectPath?: unknown;
      cwd?: unknown;
    };
    const agentId =
      optionalString(body.agentId)?.trim()
      ?? optionalString(body.targetAgentId)?.trim();
    if (!agentId) {
      return c.json({ error: "agentId is required" }, 400);
    }

    try {
      const agent = queryAgentById(agentId);
      const rawProjectPath =
        optionalString(body.projectPath)?.trim()
        ?? optionalString(body.cwd)?.trim()
        ?? agent?.projectRoot?.trim()
        ?? agent?.cwd?.trim();
      const agentDirectory = rawProjectPath
        ? resolveExplorablePath(rawProjectPath, null, currentDirectory)
        : currentDirectory;
      const result = await openScoutDirectSession({
        agentId,
        currentDirectory: agentDirectory,
        operatorName: resolveOperatorName().trim() || undefined,
        targetName: optionalString(body.targetLabel)?.trim(),
      });
      const conversationId = result.conversation.id;
      return c.json({
        ok: true,
        id: conversationId,
        chatId: conversationId,
        cId: conversationId,
        conversationId,
        agentId: result.agent?.id ?? agentId,
        existed: result.existed,
        session: querySessionById(conversationId),
        conversation: result.conversation,
      });
    } catch (cause) {
      return c.json(
        { error: cause instanceof Error ? cause.message : String(cause) },
        502,
      );
    }
  });

  app.post("/api/conversations/:id/threads", async (c) => {
    const parentConversationId = c.req.param("id");
    if (!isOpaqueChannelId(parentConversationId)) {
      return c.json({ error: "chatId must be an opaque chat id" }, 400);
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      messageId?: unknown;
      anchorMessageId?: unknown;
      title?: unknown;
    };
    const anchorMessageId =
      optionalString(body.messageId)?.trim()
      ?? optionalString(body.anchorMessageId)?.trim();
    if (!anchorMessageId) {
      return c.json({ error: "messageId is required" }, 400);
    }

    try {
      const result = await createAnchoredThreadConversation({
        parentConversationId,
        anchorMessageId,
        title: optionalString(body.title),
      });
      const conversationId = result.conversation.id;
      return c.json({
        ok: true,
        id: conversationId,
        chatId: conversationId,
        cId: conversationId,
        conversationId,
        parentConversationId,
        anchorMessageId,
        existed: result.existed,
        conversation: result.conversation,
        session: querySessionById(conversationId),
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const status = /not supported|not in conversation|not available|required/i.test(message) ? 400 : 502;
      return c.json({ error: message }, status as 400 | 502);
    }
  });

  app.get("/api/conversations/:id/read-cursors", async (c) => {
    const conversationId = c.req.param("id");
    if (!isOpaqueChannelId(conversationId)) {
      return c.json({ error: "chatId must be an opaque chat id" }, 400);
    }
    try {
      return c.json(await loadScoutReadCursors({
        conversationId,
      }));
    } catch (cause) {
      return c.json(
        { error: cause instanceof Error ? cause.message : String(cause) },
        502,
      );
    }
  });

  app.post("/api/conversations/:id/read-cursor", async (c) => {
    const conversationId = c.req.param("id");
    if (!isOpaqueChannelId(conversationId)) {
      return c.json({ error: "chatId must be an opaque chat id" }, 400);
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      actorId?: string;
      lastReadMessageId?: string;
      lastReadSeq?: number;
      lastReadAt?: number;
      metadata?: Record<string, unknown>;
    };
    try {
      return c.json(await markScoutConversationRead({
        conversationId,
        actorId: body.actorId?.trim() || "operator",
        lastReadMessageId: body.lastReadMessageId,
        lastReadSeq: body.lastReadSeq,
        lastReadAt: body.lastReadAt,
        metadata: {
          source: "scout-web",
          ...(body.metadata ?? {}),
        },
      }));
    } catch (cause) {
      return c.json(
        { error: cause instanceof Error ? cause.message : String(cause) },
        502,
      );
    }
  });

  const writeConversationMembers = async (
    conversationId: string,
    mutate: (current: string[]) => string[],
  ) => {
    const currentSession = querySessionById(conversationId);
    const canonicalConversationId = currentSession?.id ?? conversationId;
    const existing = queryConversationDefinitionById(canonicalConversationId);
    if (!existing) return null;
    const nextParticipants = mutate(existing.participantIds);
    const nextKind = conversationKindAfterMemberMutation(
      existing.kind as ConversationDefinition["kind"],
      nextParticipants,
    );
    await upsertScoutConversation({
      id: existing.id,
      kind: nextKind,
      title: existing.title,
      visibility: existing.visibility as ConversationDefinition["visibility"],
      shareMode: existing.shareMode as ConversationDefinition["shareMode"],
      authorityNodeId: existing.authorityNodeId,
      participantIds: nextParticipants,
      ...(existing.topic ? { topic: existing.topic } : {}),
      ...(existing.parentConversationId
        ? { parentConversationId: existing.parentConversationId }
        : {}),
      ...(existing.messageId ? { messageId: existing.messageId } : {}),
      ...(existing.metadata ? { metadata: existing.metadata } : {}),
    });
    return {
      kind: nextKind,
      participantIds: nextParticipants,
      session: querySessionById(existing.id),
    };
  };

  app.post("/api/conversations/:id/members", async (c) => {
    const conversationId = c.req.param("id");
    if (!isOpaqueChannelId(conversationId)) {
      return c.json({ error: "chatId must be an opaque chat id" }, 400);
    }
    const body = (await c.req.json().catch(() => null)) as
      | { actorId?: string }
      | null;
    const actorId = body?.actorId?.trim();
    if (!actorId) return c.json({ error: "actorId is required" }, 400);
    const next = await writeConversationMembers(conversationId, (current) =>
      Array.from(new Set([...current, actorId])).sort(),
    );
    if (!next) return c.json({ error: "conversation not found" }, 404);
    return c.json({ ok: true, ...next });
  });

  app.delete("/api/conversations/:id/members/:actorId", async (c) => {
    const conversationId = c.req.param("id");
    if (!isOpaqueChannelId(conversationId)) {
      return c.json({ error: "chatId must be an opaque chat id" }, 400);
    }
    const actorId = c.req.param("actorId");
    const next = await writeConversationMembers(conversationId, (current) =>
      current.filter((id) => id !== actorId),
    );
    if (!next) return c.json({ error: "conversation not found" }, 404);
    return c.json({ ok: true, ...next });
  });

  app.get("/api/sessions", (c) => c.json(querySessions()));
  app.get("/api/session-ref/:id", async (c) => {
    const refId = c.req.param("id");
    const conversation = isOpaqueChannelId(refId) ? querySessionById(refId) : null;
    if (conversation) {
      return c.json({
        kind: "conversation",
        refId,
        conversationId: conversation.id,
        session: conversation,
      });
    }

    const payload = await loadSessionRefObservePayload(refId);
    if (payload) {
      // A raw observed transcript has no writable Scout owner. Avoid building
      // the full session list for this common read-only path; on large pilot
      // databases that projection can dominate the time to open a tiny file.
      const parsedRef = payload.agentId ? parseSessionRouteRef(refId) : null;
      const harnessSession = parsedRef
        ? querySessions(200).find((session) =>
            sessionHarnessMatches(parsedRef.harness, session.harness)
            && parseSessionRouteRef(session.harnessSessionId)?.refId === parsedRef.refId
          )
        : null;
      return c.json({
        kind: "observe",
        refId,
        // A provider id can collide with an explicit broker actor/handle ref.
        // Only expose a writable Scout conversation when both projections
        // resolve to the same owner; observe-only remains safe otherwise.
        session: harnessSession?.agentId === payload.agentId ? harnessSession : null,
        observe: payload,
      });
    }
    return c.json({ error: "not found" }, 404);
  });
  app.get("/api/session-ref/:id/touched", async (c) => {
    const refId = c.req.param("id");
    const payload = await loadSessionRefObservePayload(refId);
    if (!payload) {
      return c.json({ error: "not found" }, 404);
    }
    return c.json(sessionTouchedResponse(payload, refId));
  });
  app.get("/api/session/:id", async (c) => {
    const chatId = c.req.param("id");
    const resolvedChatId = await resolveSessionRequestConversationId(chatId);
    if (!resolvedChatId) {
      return c.json({ error: "chatId must be an opaque chat id" }, 400);
    }
    const session = querySessionById(resolvedChatId);
    const broker = session
      ? await loadScoutBrokerContext(undefined, {
          scope: "conversations",
          waitForInitial: false,
          initialRefreshDelayMs: 750,
        }).catch(() => null)
      : undefined;
    const conversation = broker === null
      ? null
      : broker
        ? (await getScoutConversations(
            { conversationId: resolvedChatId, limit: 1 },
            broker,
          ))[0] ?? null
        : await getScoutConversationById(resolvedChatId);
    if (session && conversation) {
      // SQLite contributes harness-local fields, but the broker owns Chat
      // identity, transcript recency, equivalent ids, and turn lifecycle.
      return c.json({ ...session, ...conversation });
    }
    if (session) {
      return c.json(session);
    }
    return conversation ? c.json(conversation) : c.json({ error: "not found" }, 404);
  });
  app.get("/api/mesh", async (c) => {
    try {
      return c.json(await loadMeshStatus());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });
  app.post("/api/mesh/announce", async (c) => {
    try {
      return c.json(await announceMeshVisibility());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });
  app.post("/api/mesh/join", async (c) => {
    try {
      return c.json(await joinMesh());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });
  app.post("/api/mesh/leave", async (c) => {
    try {
      return c.json(await leaveMesh());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });
  app.post("/api/mesh/tailscale", async (c) => {
    try {
      const { action } = (await c.req.json()) as {
        action: TailscaleControlAction;
      };
      return c.json(await controlTailscale(action));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  app.post("/api/mesh/tailnet-probe", async (c) => {
    try {
      const { ip } = (await c.req.json()) as { ip: string };
      // Only allow Tailscale CGNAT range (100.64.0.0/10)
      const parts = ip.split(".");
      const oct1 = Number(parts[0]);
      const oct2 = Number(parts[1]);
      if (parts.length !== 4 || oct1 !== 100 || oct2 < 64 || oct2 > 127) {
        return c.json({ error: "IP is not in the Tailscale address range" }, 403);
      }

      const brokerUrl = `http://${ip}:43110`;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 8000);
      try {
        const [homeRes, nodeRes] = await Promise.all([
          fetch(`${brokerUrl}/v1/home`, { signal: ac.signal }),
          fetch(`${brokerUrl}/v1/node`, { signal: ac.signal }),
        ]);
        clearTimeout(timer);
        const home = homeRes.ok ? await homeRes.json() : null;
        const node = nodeRes.ok ? await nodeRes.json() : null;
        return c.json({ reachable: true, home, node });
      } catch (fetchErr) {
        clearTimeout(timer);
        const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
        return c.json({ reachable: false, error: msg });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  app.get("/api/user", (c) => {
    const config = loadUserConfig();
    return c.json({
      name: resolveOperatorName(),
      handle: config.handle ?? "",
      pronouns: config.pronouns ?? "",
      hue: config.hue ?? 195,
      monogram: config.monogram ?? "",
      avatar: config.avatar ?? "",
      bio: config.bio ?? "",
      timezone: config.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      workingHours: config.workingHours ?? "08:00 – 18:00",
      interruptThreshold: config.interruptThreshold ?? "blocking-only",
      batchWindow: config.batchWindow ?? 15,
      channel: config.channel ?? "here+mobile",
      verbosity: config.verbosity ?? "terse",
      tone: config.tone ?? "direct",
      quietHours: config.quietHours ?? "22:00 – 07:00",
      ...provisionalAgentNamesApiFields(config),
    });
  });

  app.get("/api/onboarding/state", async (c) => {
    return c.json(await ensureOpenScoutOnboardingCompletion({ currentDirectory }));
  });

  app.post("/api/onboarding/restart", async (c) => {
    return c.json(await restartOpenScoutOnboarding({ currentDirectory }));
  });

  app.delete("/api/onboarding/state", (c) => {
    try {
      rmSync(localConfigPath(), { force: true });
    } catch {
      /* already absent */
    }
    return c.json({ ok: true, localConfigPath: localConfigPath() });
  });

  app.post("/api/onboarding/skip", async (c) => {
    return c.json(await skipOpenScoutOnboarding({ currentDirectory }));
  });

  app.post("/api/onboarding/setup", async (c) => {
    const state = await loadOpenScoutOnboardingState({ currentDirectory });
    const contextRoot = state.contextRoot || state.projectRoot || state.currentDirectory;
    try {
      const result = await runOpenScoutOnboardingSetup({
        currentDirectory: contextRoot,
        contextRoot,
        sourceRoots: state.sourceRoots,
        defaultHarness: state.defaultHarness,
      });
      return c.json({
        ok: true,
        projectConfigPath: result.setup.currentProjectConfigPath,
        brokerReachable: result.broker.reachable,
        brokerWarning: result.brokerWarning,
        hasReadyRuntime: result.state.hasReadyRuntime,
        state: result.state,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[onboarding/setup]", message);
      return c.json({ error: message }, 500);
    }
  });

  app.post("/api/onboarding/project", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      contextRoot?: string;
      sourceRoots?: string[];
      defaultHarness?: "claude" | "codex";
    };
    const contextRoot = body.contextRoot?.trim();
    if (!contextRoot) {
      return c.json({ error: "contextRoot is required" }, 400);
    }
    const sourceRoots = (body.sourceRoots ?? [])
      .map((entry) => entry?.trim())
      .filter((entry): entry is string => Boolean(entry && entry.length > 0));
    const harness = body.defaultHarness === "codex" ? "codex" : "claude";

    // Reject folders that do not exist before we save — otherwise a typo'd
    // root gets silently `mkdir -p`'d by downstream setup.
    for (const candidate of [contextRoot, ...sourceRoots]) {
      const expanded = resolve(expandHomePath(candidate));
      if (!existsSync(expanded)) {
        return c.json({ error: `That folder doesn't exist: ${expanded}` }, 400);
      }
    }

    try {
      await saveOpenScoutOnboardingProject({
        currentDirectory,
        contextRoot,
        sourceRoots,
        defaultHarness: harness,
      });

      const result = await runOpenScoutOnboardingSetup({
        currentDirectory: contextRoot,
        contextRoot,
        sourceRoots,
        defaultHarness: harness,
      });
      return c.json({
        ok: true,
        projectConfigPath: result.setup.currentProjectConfigPath,
        brokerReachable: result.broker.reachable,
        brokerWarning: result.brokerWarning,
        hasReadyRuntime: result.state.hasReadyRuntime,
        state: result.state,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[onboarding/project]", message);
      return c.json({ error: message }, 500);
    }
  });

  app.post("/api/onboarding/init", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      host?: string;
      ports?: { broker?: number; web?: number; pairing?: number };
    };
    const state = await ensureOpenScoutOnboardingLocalConfig({
      currentDirectory,
      host: body.host,
      ports: body.ports,
    });
    return c.json({
      ok: true,
      localConfig: state.localConfig,
      localConfigPath: state.localConfigPath,
      state,
    });
  });

  app.post("/api/user", async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    // Fresh read: this is a read-modify-write, and a memoized copy here would
    // overwrite whatever another process (CLI, broker) saved since the memo.
    const config = loadUserConfigFresh();

    const stringFields = [
      "name", "handle", "pronouns", "monogram", "avatar", "bio", "timezone",
      "workingHours", "interruptThreshold", "channel",
      "verbosity", "tone", "quietHours",
    ] as const;
    for (const key of stringFields) {
      if (key in body) {
        const val = body[key];
        if (typeof val === "string" && val.trim()) {
          (config as Record<string, unknown>)[key] = val.trim();
        } else {
          delete (config as Record<string, unknown>)[key];
        }
      }
    }
    if ("hue" in body && typeof body.hue === "number") {
      config.hue = body.hue;
    }
    if ("batchWindow" in body && typeof body.batchWindow === "number") {
      config.batchWindow = body.batchWindow;
    }

    applyProvisionalAgentNamesFromBody(config, body);

    saveUserConfig(config);
    if (typeof body.name === "string" && body.name.trim()) {
      await saveOpenScoutOnboardingIdentity({
        currentDirectory,
        name: body.name.trim(),
      });
    }
    return c.json({
      name: resolveOperatorName(),
      handle: config.handle ?? "",
      pronouns: config.pronouns ?? "",
      hue: config.hue ?? 195,
      monogram: config.monogram ?? "",
      avatar: config.avatar ?? "",
      bio: config.bio ?? "",
      timezone: config.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      workingHours: config.workingHours ?? "08:00 – 18:00",
      interruptThreshold: config.interruptThreshold ?? "blocking-only",
      batchWindow: config.batchWindow ?? 15,
      channel: config.channel ?? "here+mobile",
      verbosity: config.verbosity ?? "terse",
      tone: config.tone ?? "direct",
      quietHours: config.quietHours ?? "22:00 – 07:00",
      ...provisionalAgentNamesApiFields(config),
    });
  });

  app.post(routes.terminalRunPath, async (c) => {
    const body = await c.req.json<TerminalRunRequest>();
    const command = body.command?.trim();
    if (!command) return c.json({ error: "missing command" }, 400);
    if (!options.runTerminalCommand) {
      return c.json({ error: "terminal relay is unavailable" }, 503);
    }
    try {
      await options.runTerminalCommand({
        command,
        cwd: body.cwd?.trim() || null,
        agentId: body.agentId?.trim() || null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "failed to queue command";
      return c.json({ error: message }, 503);
    }
    return c.json({ ok: true });
  });

  app.post("/api/terminal-relay/session/destroy", async (c) => {
    const body = await c.req.json<TerminalRelayDestroyRequest>().catch((): Partial<TerminalRelayDestroyRequest> => ({}));
    const sessionId = body.sessionId?.trim();
    if (!sessionId) return c.json({ error: "missing sessionId" }, 400);
    if (!options.destroyTerminalRelaySession) {
      return c.json({ error: "terminal relay is unavailable" }, 503);
    }
    try {
      const destroyed = await options.destroyTerminalRelaySession(sessionId);
      return c.json({ ok: true, destroyed });
    } catch (error) {
      const message = error instanceof Error ? error.message : "failed to destroy terminal session";
      return c.json({ error: message }, 503);
    }
  });

  app.post("/api/terminal-sessions/control", async (c) => {
    const body = await c.req.json<TerminalSurfaceControlRequest>().catch((): Partial<TerminalSurfaceControlRequest> => ({}));
    const backend = parseTerminalSessionBackend(body.backend);
    const sessionName = body.sessionName?.trim();
    const action = parseTerminalSurfaceControlAction(body.action);

    if (!backend) return c.json({ error: "backend must be a registered terminal host" }, 400);
    if (!sessionName) return c.json({ error: "sessionName is required" }, 400);
    if (!action) return c.json({ error: "action must be interrupt, quit, stop-job, restart-resume, detach, release, force-quit, or force-quit-bridge" }, 400);

    // Capability, not backend. A host that cannot perform a verb says so with
    // the capability that is missing, and the UI is expected to have read
    // /api/terminal-hosts and not offered the action in the first place.
    const support = terminalHostSupportsControl(backend, action);
    if (!support.supported) {
      return c.json({
        error: `${backend} does not support ${action}`,
        backend,
        action,
        capability: "control",
      }, 501);
    }

    let delivered = false;
    let resumeResult: { ok: boolean; sessionId: string | null; transcriptPath: string | null } | null = null;
    if (support.via === "harness") {
      // Harness-aware verbs walk a process tree and read a Claude transcript;
      // they are Scout features layered over one host, not host features.
      if (action === "restart-resume") {
        resumeResult = await restartClaudeWithResumeInTmuxSurface(sessionName);
        delivered = resumeResult.ok;
      } else if (action !== "force-quit-bridge" && action !== "release") {
        delivered = await controlTmuxSurface(sessionName, action);
      }
    } else if (action !== "force-quit-bridge") {
      const adapter = resolveTerminalHostAdapter(backend);
      const result = await adapter.control?.(action, { sessionName });
      delivered = result?.delivered ?? false;
    }

    let destroyed = 0;
    if (action === "detach" || action === "release" || action === "force-quit" || action === "force-quit-bridge" || action === "restart-resume") {
      // Only hosts the relay can carry have a bridge to tear down. That is the
      // `relayAttach` capability plus what this vendored relay build accepts,
      // asked as one question instead of spelled out as a backend list here.
      const relayBackend = relayCarriedTerminalBackend(backend);
      if (options.destroyTerminalRelaySurface && relayBackend) {
        destroyed = await options.destroyTerminalRelaySurface(relayBackend, sessionName);
      }
      const detachSupport = terminalHostSupportsControl(backend, "detach");
      if (action !== "restart-resume" && action !== "detach" && action !== "release" && detachSupport.supported) {
        await resolveTerminalHostAdapter(backend).control?.("detach", { sessionName });
      }
    }

    return c.json({
      ok: true,
      action,
      backend,
      sessionName,
      delivered,
      destroyed,
      resumeSessionId: resumeResult?.sessionId ?? null,
      resumeTranscriptPath: resumeResult?.transcriptPath ?? null,
    });
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
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
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

  app.get("/api/scoutbot/threads", async (c) => {
    const scoutbotRunner = scoutbot.runner ?? await scoutbot.waitForRunner();
    if (!scoutbotRunner) {
      return c.json({ error: "scoutbot runner is not enabled" }, 503);
    }
    try {
      return c.json(await scoutbotRunner.getThreads());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message }, /broker unreachable/i.test(message) ? 502 : 500);
    }
  });

  // Ephemeral image attachments. Bytes are uploaded here, stored in a cache
  // dir with a TTL, and handed back as an absolute URL that any consumer (the
  // browser, the Mac app, or an agent) can fetch. Nothing lands in the DB.
  app.post("/api/blobs", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      data?: string;
      mediaType?: string;
      fileName?: string;
    } | null;
    if (!body?.data || !body.mediaType) {
      return c.json({ error: "data and mediaType are required" }, 400);
    }
    try {
      const stored = await putImageBlob({
        data: body.data,
        mediaType: body.mediaType,
        fileName: body.fileName,
      });
      const origin = options.publicOrigin?.trim() || new URL(c.req.url).origin;
      return c.json({
        id: stored.id,
        url: `${origin.replace(/\/$/, "")}/api/blobs/${stored.id}`,
        mediaType: stored.mediaType,
        fileName: stored.fileName,
        size: stored.size,
      });
    } catch (error) {
      if (error instanceof ImageBlobError) {
        return c.json({ error: error.message }, error.status as 400);
      }
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message }, 500);
    }
  });

  app.get("/api/blobs/:id", (c) => {
    const entry = getImageBlob(c.req.param("id"));
    if (!entry) {
      return c.json({ error: "not found" }, 404);
    }
    const headers: Record<string, string> = {
      "content-type": entry.mediaType,
      "cache-control": "private, max-age=3600",
      "content-length": String(entry.size),
    };
    if (entry.fileName) {
      headers["content-disposition"] =
        `inline; filename="${entry.fileName.replace(/"/g, "")}"`;
    }
    return new Response(Bun.file(entry.path), { headers });
  });

  type ChatMessageDispatchInput = {
    chatId: string;
    body: string;
    clientMessageId?: string;
    attachments?: OutgoingAttachmentInput[];
    replyToMessageId?: string;
    /** Compatibility-only overrides accepted by the transitional /api/send route. */
    requestedSendMode?: string;
    targetParticipantIds?: string[];
    execution?: {
      harness?: unknown;
      model?: unknown;
    };
  };
  type ChatMessageDispatchOutcome =
    | { ok: true; result: Record<string, unknown> }
    | { ok: false; status: 404 | 502; error: string };

  const dispatchOperatorChatMessage = async (
    input: ChatMessageDispatchInput,
  ): Promise<ChatMessageDispatchOutcome> => {
    // Conversation reads already fall back to the live broker snapshot while
    // the SQLite projection catches up. Sends must resolve through the same
    // source or a newly-created broker Chat can render but reject its composer.
    const projectedSession = querySessionById(input.chatId);
    const broker = await loadScoutBrokerContext();
    const liveConversation = broker?.snapshot.conversations[input.chatId] ?? null;
    let routeSession = liveConversation ?? projectedSession ?? null;
    if (broker && liveConversation?.kind === "channel") {
      const naturalKey = channelNaturalKeyFromMetadata(liveConversation.metadata);
      const siblingConversations = naturalKey
        ? Object.values(broker.snapshot.conversations).filter((conversation) =>
            conversation.kind === liveConversation.kind
            && channelNaturalKeyFromMetadata(conversation.metadata) === naturalKey
          )
        : [liveConversation];
      const participantIds = [...new Set(
        siblingConversations.flatMap((conversation) => conversation.participantIds),
      )].sort();
      if (participantIds.join("\u0000") !== [...liveConversation.participantIds].sort().join("\u0000")) {
        const reconciledConversation = { ...liveConversation, participantIds };
        await upsertScoutConversation(reconciledConversation, broker.baseUrl);
        broker.snapshot.conversations[input.chatId] = reconciledConversation;
        routeSession = reconciledConversation;
      }
    }
    if (!routeSession) {
      return { ok: false, status: 404, error: "chat not found" };
    }

    const semanticSession = semanticSessionForChat(input.chatId, routeSession);
    const { conversationId: routedConversationId, senderId } =
      resolveConversationRouting(input.chatId, routeSession);
    if (!routedConversationId) {
      return { ok: false, status: 404, error: "chat not found" };
    }

    const isOperatorDirectConversation =
      semanticSession.kind === "direct" && sessionIncludesOperatorParticipant(semanticSession);
    const isSharedChat =
      routeSession.kind === "channel"
      || routeSession.kind === "group_direct"
      || (routeSession.kind === "thread" && !isOperatorDirectConversation);
    const scopedTargetParticipantIds = Array.isArray(input.targetParticipantIds)
      ? [...new Set(
          input.targetParticipantIds
            .filter((targetId): targetId is string => typeof targetId === "string")
            .map((targetId) => targetId.trim())
            .filter(Boolean),
        )]
      : undefined;
    const requestedSendMode = input.requestedSendMode?.trim();
    const selectors = extractAgentSelectors(input.body);
    const selectorTargetAgentIds = resolveSendSelectorTargetAgentIds(
      selectors,
      routeSession.participantIds,
    );
    const hasExplicitTarget =
      Boolean(scopedTargetParticipantIds?.length)
      || selectors.length > 0;
    const shouldInspectActiveRuns =
      requestedSendMode?.toLowerCase() === "steer"
      || (!requestedSendMode && (isOperatorDirectConversation || hasExplicitTarget));
    const activeRuns = shouldInspectActiveRuns
      ? queryRuns({
          conversationId: routedConversationId,
          active: true,
          limit: 100,
        })
      : [];
    const resolvedTargetIds = new Set([
      ...(scopedTargetParticipantIds ?? []),
      ...selectorTargetAgentIds,
    ]);
    const matchedActiveRuns = hasExplicitTarget
      ? activeRuns.filter((run) => resolvedTargetIds.has(run.agentId))
      : activeRuns;
    const hasActiveRun = matchedActiveRuns.length > 0;
    const steerContext = steerContextByTargetAgentId(matchedActiveRuns);
    const sendMode = (requestedSendMode
      || defaultSendModeForConversationSession({
        session: semanticSession,
        hasExplicitTarget,
        hasActiveRun,
      })).toLowerCase();
    const shouldCommentOnly =
      sendMode === "comment"
      || sendMode === "message"
      || (sendMode === "tell" && !isOperatorDirectConversation);
    const executionHarness = coerceAgentHarness(input.execution?.harness);
    const executionModel = optionalString(input.execution?.model)?.trim();
    const requestedExecution = executionHarness || executionModel
      ? {
          ...(executionHarness ? { harness: executionHarness } : {}),
          ...(executionModel ? { model: executionModel } : {}),
        }
      : undefined;
    const result = shouldCommentOnly
      ? await sendScoutConversationMessage({
          conversationId: routedConversationId,
          senderId,
          body: input.body,
          attachments: input.attachments,
          replyToMessageId: input.replyToMessageId,
          clientMessageId: input.clientMessageId,
          // Shared Chat membership is broker-owned. A passive post creates
          // durable visibility deliveries without creating requested work.
          notifyParticipantAgents: isSharedChat,
          currentDirectory,
          source: "scout-web",
        })
      // A send into an existing Chat never leaves that Chat. The former
      // invoke shortcut through sendScoutDirectMessage let the broker derive
      // a (requester ↔ target) conversation and forced execution.session
      // "new", so an in-place reply could mint a sibling Chat and a fresh
      // harness session. The steer path posts into this conversation and its
      // invocations continue the participant's live session; pair-derived
      // delivery remains only for sends that arrive with no Chat at all.
      : await sendScoutConversationSteer({
          conversationId: routedConversationId,
          senderId,
          body: input.body,
          attachments: input.attachments,
          replyToMessageId: input.replyToMessageId,
          clientMessageId: input.clientMessageId,
          ...(scopedTargetParticipantIds?.length
            ? { targetParticipantIds: scopedTargetParticipantIds }
            : {}),
          intent: sendMode === "tell"
            ? "tell"
            : sendMode === "invoke"
              ? "invoke"
              : "steer",
          ...(sendMode === "steer" && steerContext
            ? { steerContextByTargetAgentId: steerContext }
            : {}),
          ...(requestedExecution ? { execution: requestedExecution } : {}),
          currentDirectory,
          source: "scout-web",
        });
    if (!result.usedBroker) {
      return { ok: false, status: 502, error: "broker unreachable" };
    }
    const flights = result.flights?.length
      ? result.flights
      : result.flight
        ? [result.flight]
        : [];
    return {
      ok: true,
      result: {
        ...result,
        conversationId: routedConversationId,
        chatId: routedConversationId,
        runIds: flights.map((flight) => `run:flight:${flight.id}`),
      },
    };
  };

  // The web composer speaks in Chat terms only.  Delivery policy, requested
  // work, and thread placement are server-owned consequences of that Chat and
  // an optional reply anchor; callers do not send routing modes or recipient
  // lists.  `/api/send` remains below as the compatibility surface for older
  // clients and automation.
  app.post("/api/chats/:chatId/messages", async (c) => {
    const chatId = c.req.param("chatId");
    if (!isOpaqueChannelId(chatId)) {
      return c.json({ error: "chatId must be an opaque chat id" }, 400);
    }

    const requestBody = (await c.req.json().catch(() => ({}))) as {
      body?: unknown;
      attachments?: unknown;
      replyToMessageId?: unknown;
      clientMessageId?: unknown;
    };
    const body = optionalString(requestBody.body) ?? "";
    if (requestBody.attachments !== undefined && !Array.isArray(requestBody.attachments)) {
      return c.json({ error: "attachments must be an array" }, 400);
    }
    const attachments = requestBody.attachments as OutgoingAttachmentInput[] | undefined;
    if (!body.trim() && !attachments?.length) {
      return c.json({ error: "body or attachments are required" }, 400);
    }
    const hasReplyAnchor = requestBody.replyToMessageId !== undefined
      && requestBody.replyToMessageId !== null;
    const replyToMessageId = hasReplyAnchor
      ? optionalString(requestBody.replyToMessageId)?.trim()
      : undefined;
    if (hasReplyAnchor && !replyToMessageId) {
      return c.json({ error: "replyToMessageId must be a non-empty string" }, 400);
    }
    const hasClientMessageId = requestBody.clientMessageId !== undefined
      && requestBody.clientMessageId !== null;
    const clientMessageId = hasClientMessageId
      ? optionalString(requestBody.clientMessageId)?.trim()
      : undefined;
    if (hasClientMessageId && !clientMessageId) {
      return c.json({ error: "clientMessageId must be a non-empty string" }, 400);
    }

    const outcome = await dispatchOperatorChatMessage({
      chatId,
      body: body.trim(),
      ...(clientMessageId ? { clientMessageId } : {}),
      ...(attachments?.length ? { attachments } : {}),
      ...(replyToMessageId ? { replyToMessageId } : {}),
    });
    if (!outcome.ok) {
      return c.json({ error: outcome.error }, outcome.status);
    }

    return c.json({
      ...outcome.result,
      placement: resolveChatMessagePlacement(chatId, replyToMessageId),
    });
  });

  app.post("/api/send", async (c) => {
    const { body, chatId, cId, conversationId, threadId, attachments, intent, mode, targetParticipantIds, replyToMessageId, execution } = (await c.req.json()) as {
      body: string;
      chatId?: string;
      cId?: string;
      conversationId?: string;
      threadId?: string;
      attachments?: OutgoingAttachmentInput[];
      intent?: string;
      mode?: string;
      targetParticipantIds?: string[];
      replyToMessageId?: unknown;
      execution?: {
        harness?: unknown;
        model?: unknown;
      };
    };
    const messageBody = body?.trim() ?? "";
    if (!messageBody && !attachments?.length) {
      return c.json({ error: "body or attachments are required" }, 400);
    }
    const hasReplyToMessageId = replyToMessageId !== undefined && replyToMessageId !== null;
    const routedReplyToMessageId = hasReplyToMessageId ? optionalString(replyToMessageId)?.trim() : undefined;
    if (hasReplyToMessageId && !routedReplyToMessageId) {
      return c.json({ error: "replyToMessageId must be a non-empty string" }, 400);
    }

    const routeCId = optionalString(chatId) ?? optionalString(cId) ?? optionalString(conversationId);
    if (routeCId && !isOpaqueChannelId(routeCId)) {
      return c.json({ error: "chatId must be an opaque chat id" }, 400);
    }
    if (routeCId) {
      const outcome = await dispatchOperatorChatMessage({
        chatId: routeCId,
        body: messageBody,
        attachments,
        replyToMessageId: routedReplyToMessageId,
        requestedSendMode: optionalString(intent)?.trim() || optionalString(mode)?.trim(),
        targetParticipantIds,
        execution,
      });
      if (!outcome.ok) {
        return c.json({ error: outcome.error }, outcome.status);
      }
      return c.json(outcome.result);
    }

    const scoutbotRunner = scoutbot.runner;
    if (scoutbotRunner) {
      try {
        const result = await scoutbotRunner.postOperatorMessage({
          body: messageBody,
          threadId,
          attachments,
          replyToMessageId: routedReplyToMessageId,
        });
        if (!result.usedBroker) {
          return c.json({ error: "broker unreachable" }, 502);
        }
        return c.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return c.json({ error: message }, /unknown scoutbot thread/i.test(message) ? 404 : 500);
      }
    }

    const { directAgentId, channel, senderId } = resolveConversationRouting(undefined);

    if (directAgentId) {
      if (directAgentId === SCOUTBOT_AGENT_ID && scoutbotRunner) {
        try {
          const result = await scoutbotRunner.postOperatorMessage({
            body: messageBody,
            threadId,
            attachments,
            replyToMessageId: routedReplyToMessageId,
          });
          if (!result.usedBroker) {
            return c.json({ error: "broker unreachable" }, 502);
          }
          return c.json(result);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return c.json({ error: message }, /unknown scoutbot thread/i.test(message) ? 404 : 500);
        }
      }

      const result = await sendScoutDirectMessage({
        agentId: directAgentId,
        body: messageBody,
        attachments,
        replyToMessageId: routedReplyToMessageId,
        currentDirectory,
        source: "scout-web",
      });
      return c.json({
        ...result,
        chatId: result.conversationId,
        runIds: result.flight ? [`run:flight:${result.flight.id}`] : [],
      });
    }

    const result = await sendScoutMessage({
      senderId,
      body: messageBody,
      ...(channel ? { channel } : {}),
      attachments,
      currentDirectory,
    });

    if (!result.usedBroker) {
      return c.json({ error: "broker unreachable" }, 502);
    }

    return c.json({
      ...result,
      ...(result.conversationId ? { chatId: result.conversationId } : {}),
      runIds: result.flight ? [`run:flight:${result.flight.id}`] : [],
    });
  });

  app.post("/api/ask", async (c) => {
    const requestBody = (await c.req.json().catch(() => ({}))) as {
      body?: unknown;
      chatId?: string;
      cId?: string;
      conversationId?: string;
      targetAgentId?: unknown;
      targetLabel?: unknown;
      metadata?: unknown;
      attachments?: unknown;
      execution?: {
        harness?: unknown;
        model?: unknown;
        reasoningEffort?: unknown;
      };
    };
    const message = optionalString(requestBody.body)?.trim();
    if (!message) {
      return c.json({ error: "body is required" }, 400);
    }

    const explicitTargetAgentId = optionalString(requestBody.targetAgentId)?.trim();
    const explicitTargetLabel = optionalString(requestBody.targetLabel)?.trim();
    const routeConversationId =
      optionalString(requestBody.chatId)
      ?? optionalString(requestBody.cId)
      ?? optionalString(requestBody.conversationId);
    if (routeConversationId && !isOpaqueChannelId(routeConversationId)) {
      return c.json({ error: "chatId must be an opaque chat id" }, 400);
    }
    if (routeConversationId && !explicitTargetAgentId && !querySessionById(routeConversationId)) {
      return c.json({ error: "chat not found" }, 404);
    }

    const routed = explicitTargetAgentId
      ? {
          directAgentId: explicitTargetAgentId,
          senderId: resolveOperatorName().trim() || "operator",
        }
      : resolveConversationAskRouting(
          routeConversationId,
        );
    const agent = routed.directAgentId ? queryAgentById(routed.directAgentId) : null;
    if (!routed.directAgentId) {
      return c.json(
        {
          error:
            "ask is only available in a direct conversation with one agent",
        },
        400,
      );
    }
    const executionHarness =
      coerceAgentHarness(requestBody.execution?.harness) ??
      coerceAgentHarness(agent?.harness);
    const executionModel =
      optionalString(requestBody.execution?.model)?.trim() ||
      agent?.model?.trim() ||
      undefined;
    const executionReasoningEffort = optionalString(requestBody.execution?.reasoningEffort)?.trim();
    if (requestBody.attachments !== undefined && !Array.isArray(requestBody.attachments)) {
      return c.json({ error: "attachments must be an array" }, 400);
    }
    const attachments = requestBody.attachments as OutgoingAttachmentInput[] | undefined;
    const requestMetadata = recordInput(requestBody.metadata);
    const source = metadataStringValue(requestMetadata, "source") ?? "scout-web";

    const result = await askScoutQuestion({
      senderId: routed.senderId,
      targetLabel: explicitTargetLabel || routed.directAgentId,
      targetAgentId: routed.directAgentId,
      body: message,
      ...(executionHarness ? { executionHarness } : {}),
      ...(executionModel ? { executionModel } : {}),
      ...(executionReasoningEffort ? { executionReasoningEffort } : {}),
      ...(attachments?.length ? { attachments } : {}),
      source,
      ...(requestMetadata ? {
        messageMetadata: requestMetadata,
        invocationMetadata: requestMetadata,
      } : {}),
      currentDirectory,
    });

    if (!result.usedBroker) {
      return c.json({ error: "broker unreachable" }, 502);
    }
    if (result.unresolvedTarget) {
      return c.json(
        {
          error: `could not route ask to ${result.unresolvedTarget}`,
          targetDiagnostic: result.targetDiagnostic ?? null,
        },
        409,
      );
    }

    return c.json(result);
  });

  mountScoutVoiceRoutes(app, {
    resolveOpenAIApiKey: scoutbot.resolveOpenAIApiKey,
    readRealtimeVoiceEnabled: async () => (
      await readOpenScoutSettings({ currentDirectory })
    ).voice.realtimeEnabled,
    writeRealtimeVoiceEnabled: async (enabled) => (
      await writeOpenScoutSettings({ voice: { realtimeEnabled: enabled } }, { currentDirectory })
    ).voice.realtimeEnabled,
    realtimeVoiceEnvironment: process.env,
  });

  // Dev-only: serve generated Scoutbot FX fixtures for /dev/scoutbot-fx lab.
  // Fixtures are produced by packages/web/scripts/generate-scoutbot-fx-fixtures.mjs
  // and live in packages/web/dev/scoutbot-fx-fixtures/ (gitignored).
  if (process.env.NODE_ENV !== "production") {
    const fixturesRoot = join(process.cwd(), "dev", "scoutbot-fx-fixtures");

    app.get("/api/dev/scoutbot-fx/fixtures", (c) => {
      if (!existsSync(fixturesRoot)) {
        return c.json({ fixtures: [], generatedAt: null, available: false });
      }
      const manifestPath = join(fixturesRoot, "manifest.json");
      if (!existsSync(manifestPath)) {
        return c.json({ fixtures: [], generatedAt: null, available: true, note: "manifest missing — re-run the generator script" });
      }
      try {
        const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as {
          generatedAt?: string;
          fixtures?: unknown;
        };
        return c.json({
          available: true,
          generatedAt: parsed.generatedAt ?? null,
          fixtures: Array.isArray(parsed.fixtures) ? parsed.fixtures : [],
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "manifest read failed";
        return c.json({ error: message }, 500);
      }
    });

    app.get("/api/dev/scoutbot-fx/audio/:name", (c) => {
      const raw = c.req.param("name");
      // Disallow anything that could escape the fixtures dir.
      if (!raw || raw.includes("/") || raw.includes("\\") || raw.includes("..")) {
        return c.json({ error: "invalid fixture name" }, 400);
      }
      if (!/^[a-zA-Z0-9._-]+\.wav$/.test(raw)) {
        return c.json({ error: "invalid fixture name" }, 400);
      }
      const filePath = join(fixturesRoot, raw);
      if (!existsSync(filePath)) {
        return c.json({ error: "fixture not found" }, 404);
      }
      const body = readFileSync(filePath);
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": "audio/wav",
          "content-length": String(body.length),
          "cache-control": "no-store",
        },
      });
    });
  }

  app.get("/api/events", async (c) => {
    const brokerUrl = resolveScoutBrokerUrl();
    try {
      return await relayEventStream(`${brokerUrl}/v1/events/stream`, {
        signal: c.req.raw.signal,
      });
    } catch {
      return c.text("Broker unreachable", 502);
    }
  });

  app.get("/api/tail/discover", async (c) => {
    const url = new URL(scoutBrokerPaths.v1.tailDiscover, resolveScoutBrokerUrl());
    const forceRefresh = c.req.query("force") === "true" || c.req.query("force") === "1";
    const scope = parseTailDiscoveryScope(c.req.query("scope"));
    const limitParam = parseOptionalPositiveInt(c.req.query("limit"));
    if (forceRefresh) {
      url.searchParams.set("force", "1");
    }
    if (scope) {
      url.searchParams.set("scope", scope);
    }
    if (limitParam !== undefined) {
      url.searchParams.set("limit", String(limitParam));
    }
    const cacheKey = `scope=${scope ?? "default"};limit=${limitParam ?? "all"}`;
    let cache = tailDiscoveryCaches.get(cacheKey);
    if (!cache) {
      cache = createBrokerJsonCache<DiscoverySnapshot>();
      tailDiscoveryCaches.set(cacheKey, cache);
    }
    return serveCachedBrokerJson(
      c,
      cache,
      url,
      "broker tail discovery",
      {
        forceRefresh,
        transform: (data) => limitTailDiscoverySnapshot(data, limitParam),
      },
    );
  });

  app.get("/api/repo-watch", async (c) => {
    const url = new URL(scoutBrokerPaths.v1.repoWatchSnapshot, resolveScoutBrokerUrl());
    for (const key of ["force", "includeTail", "includeDiff", "includeLastCommit", "native"]) {
      const value = c.req.query(key);
      if (value === "1" || value === "true") url.searchParams.set(key, "1");
    }
    for (const key of ["maxRoots", "maxWorktrees", "maxFilesPerWorktree", "scanBudgetMs"]) {
      const value = parseOptionalPositiveInt(c.req.query(key));
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    try {
      const res = await fetch(url, { signal: c.req.raw.signal });
      if (!res.ok) {
        return c.json({ error: `broker repo-watch unavailable (${res.status})` }, 502);
      }
      return c.json(await res.json());
    } catch {
      return c.json({ error: "broker repo-watch unavailable" }, 502);
    }
  });

  app.post("/api/scout-services/restart-link", async (c) => {
    let target = parseScoutServicesRestartTarget(c.req.query("target"));
    if (!target) {
      try {
        const body = await c.req.json<{ target?: string }>();
        target = parseScoutServicesRestartTarget(body.target);
      } catch {
        // Body is optional; query-string target is enough.
      }
    }

    if (!target) {
      return c.json({ error: "unsupported Scout Services restart target" }, 400);
    }

    return c.json(createSignedScoutServicesRestartUrl(target));
  });

  app.get("/api/tail/recent", async (c) => {
    const limitParam = parseOptionalPositiveInt(c.req.query("limit"), 500) ?? 500;
    const includeTranscripts = c.req.query("transcripts") === "true" || c.req.query("transcripts") === "1";
    const mode = c.req.query("mode") === "assistant-replies" ? "assistant-replies" : null;
    const requestedWindowMs = parseOptionalPositiveInt(c.req.query("windowMs"));
    const windowMs = requestedWindowMs === undefined
      ? undefined
      : Math.min(requestedWindowMs, 24 * 60 * 60 * 1_000);
    const url = new URL(scoutBrokerPaths.v1.tailRecent, resolveScoutBrokerUrl());
    url.searchParams.set("limit", String(limitParam));
    if (includeTranscripts) {
      url.searchParams.set("transcripts", "true");
    }
    if (mode) {
      url.searchParams.set("mode", mode);
    }
    if (windowMs !== undefined) {
      url.searchParams.set("windowMs", String(windowMs));
    }
    const cacheKey = `limit=${limitParam};transcripts=${includeTranscripts ? "1" : "0"};mode=${mode ?? "all"};window=${windowMs ?? "all"}`;
    let cache = tailRecentCaches.get(cacheKey);
    if (!cache) {
      cache = createBrokerJsonCache<TailRecentPayload>();
      tailRecentCaches.set(cacheKey, cache);
    }
    return serveCachedBrokerJson(
      c,
      cache,
      url,
      "broker tail",
    );
  });

  // /api/tail/stream removed — clients now subscribe to broker tail.events
  // directly via tRPC over WebSocket. See packages/web/client/lib/tail-events.ts.

  app.get("/api/broadcast/recent", (c) => {
    const limitParam = parseOptionalPositiveInt(c.req.query("limit"), 50) ?? 50;
    return c.json({ broadcasts: snapshotRecentBroadcasts(limitParam) });
  });

  app.get("/api/broadcast/stream", (c) => {
    const encoder = new TextEncoder();
    const signal = c.req.raw.signal;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        const safeEnqueue = (chunk: Uint8Array) => {
          if (closed) return;
          try {
            controller.enqueue(chunk);
          } catch {
            closed = true;
          }
        };

        const recent = snapshotRecentBroadcasts(50);
        for (const broadcast of recent) {
          safeEnqueue(encoder.encode(`data: ${JSON.stringify(broadcast)}\n\n`));
        }
        safeEnqueue(
          encoder.encode(`event: ready\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`),
        );

        const unsubscribe = subscribeBroadcast((broadcast) => {
          safeEnqueue(encoder.encode(`data: ${JSON.stringify(broadcast)}\n\n`));
        });

        const heartbeat = setInterval(() => {
          safeEnqueue(encoder.encode(`: keep-alive ${Date.now()}\n\n`));
        }, 15_000);

        const close = () => {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          unsubscribe();
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        };

        signal.addEventListener("abort", close, { once: true });
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  });

  app.all("/api/*", (c) => c.json({ error: `unknown api route: ${c.req.path}` }, 404));

  await registerScoutWebAssets(app, {
    assetMode: options.assetMode,
    staticRoot: resolveStaticRoot(options.staticRoot),
    viteDevUrl: options.viteDevUrl,
    defaultViteUrl: "http://127.0.0.1:43122",
  });

  const warmupCaches = () =>
    Promise.allSettled([
      warmOpenScoutBuildInfo(currentDirectory),
    ]).then((results) => {
      for (const result of results) {
        if (result.status === "rejected") {
          const message =
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason);
          console.error(
            "[openscout-web api] initial cache warmup failed:",
            message,
          );
        }
      }
    });

  const stop = async () => {
    lanPairBeacon?.stop();
    pendingPairRequests.dispose();
    await scoutbot.stopRunner();
  };

  return { app, warmupCaches, stop };
}
