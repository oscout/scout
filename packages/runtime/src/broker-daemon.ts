import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { Duplex } from "node:stream";

import { applyWSSHandler } from "@trpc/server/adapters/ws";

import { brokerRouter } from "./broker-trpc-router.js";

import {
  type ActorIdentity,
  type AgentEndpoint,
  type AgentHarness,
  type ControlCommand,
  type ConversationDefinition,
  type DeliveryIntent,
  type FlightRecord,
  type InvocationRequest,
  type MessageRecord,
  type NodeDefinition,
  type ScoutDispatchEnvelope,
  type ScoutDispatchRecord,
  mintChannelId,
  OPENSCOUT_COORDINATOR_AGENT_ID,
  SCOUT_DISPATCHER_AGENT_ID,
} from "@openscout/protocol";

import { createInMemoryControlRuntime } from "./broker.js";
import {
  publishControlEvent,
  replaceControlEventBacklog,
} from "./broker-control-events.js";
import { BrokerDeliveryStore } from "./broker-delivery-store.js";
import { FileBackedBrokerJournal, type BrokerJournalEntry } from "./broker-journal.js";
import { BrokerDurableRecordStore } from "./broker-durable-record-store.js";
import { BrokerDurableStore } from "./broker-durable-store.js";
import { BrokerReadCursorStore } from "./broker-read-cursor-store.js";
import { BrokerWorkItemStore } from "./broker-work-item-store.js";
import { BrokerDeliveryRouter } from "./broker-delivery-routing.js";
import { BrokerDeliveryAcceptanceService } from "./broker-delivery-acceptance-service.js";
import { BrokerDeliveryHttpService } from "./broker-delivery-http-service.js";
import { BrokerDurableActionHttpService } from "./broker-durable-action-http-service.js";
import { BrokerFlightLifecycleService } from "./broker-flight-lifecycle-service.js";
import { bootstrapSecretRedaction } from "./secret-redaction-bootstrap.js";
import { applyRoleLifecycleForTerminalFlight } from "./role-lifecycle.js";
import { BrokerRepoTailService } from "./broker-repo-tail-service.js";
import { BrokerRendezvousService } from "./broker-rendezvous-service.js";
import { BrokerOperatorAttentionService } from "./broker-operator-attention-service.js";
import { BrokerLocalAgentSyncService } from "./broker-local-agent-sync-service.js";
import {
  DEFAULT_CARDLESS_SESSION_IDLE_TTL_MS,
  idleCardlessSessionExpiryCandidates,
} from "./broker-cardless-session-reaper.js";
import {
  resolveAgentLabel,
  type BrokerRouteTargetInput,
} from "./scout-dispatcher.js";
import { assertNoReservedStoredAgentNames } from "./reserved-agent-audit.js";
import { buildCollaborationInvocation } from "./collaboration-invocations.js";
import { resolveOperatorName } from "./user-config.js";
import {
  resolveIrohMeshEntrypointFromEnv,
  startIrohBridgeServeFromEnv,
  type IrohBridgeService,
} from "./iroh-bridge.js";
import { createPeerDeliveryWorker, type PeerDeliveryWorker } from "./peer-delivery.js";
import {
  ensureLocalSessionEndpointOnline,
  ensureLocalAgentBindingOnline,
  isLocalAgentEndpointAlive,
  isLocalAgentEndpointAliveAsync,
  isLocalAgentSessionAlive,
  isLocalAgentSessionAliveAsync,
  invokeLocalAgentEndpoint,
  listRelayAgentTmuxSessionOwners,
  loadRegisteredLocalAgentBindings,
  shutdownLocalSessionEndpoint,
  shouldDisableGeneratedCodexEndpoint,
  sleepLocalAgentSession,
} from "./local-agents.js";
import {
  DEFAULT_RELAY_AGENT_SESSION_IDLE_TTL_MS,
  RelayAgentSessionReaper,
} from "./broker-relay-agent-reaper.js";
import { reconcileRelayAgentProcessLeases } from "./relay-agent-process-leases.js";
import { touchBrokerRuntimeHeartbeat } from "./relay-agent-watchdog.js";
import { tmuxSessionsProbe } from "./system-probes/index.js";
import {
  ensurePairingSessionForCodexThread,
  findPairingSession,
  getPairingSessionSnapshot,
  invokePairingSessionEndpoint,
  listPairingSessions,
} from "./pairing-session-agents.js";
import { normalizeCodexAppServerLaunchArgs } from "./codex-app-server.js";
import { RecoverableSQLiteProjection } from "./sqlite-projection.js";
import { ThreadEventPlane } from "./thread-events.js";
import { invokeA2AHttpEndpoint } from "./a2a-http-endpoint.js";
import { ensureOpenScoutCleanSlateSync, resolveOpenScoutSupportPaths } from "./support-paths.js";
import { expandHomePath } from "./tool-resolution.js";
import {
  requestScoutBrokerJson,
  registerActiveScoutBrokerService,
  unregisterActiveScoutBrokerService,
} from "./broker-api.js";
import { createBrokerCoreService } from "./broker-core-service.js";
import {
  buildLocalBrokerControlUrl,
  DEFAULT_BROKER_PORT,
  isLoopbackHost,
  resolveBrokerServiceConfig,
  resolveAdvertiseScope,
  resolveBrokerHost,
  resolveBrokerUrl,
} from "./broker-process-manager.js";
import {
  readMobilePairingMeshEntrypoint,
  resolveMeshRendezvousPublishConfig,
  startMeshRendezvousPublisher,
  type MeshRendezvousPublisher,
} from "./mesh-rendezvous.js";
import { clearGitBranchCache, readRelayAgentOverrides, writeRelayAgentOverrides } from "./setup.js";
import { broadcastApnsAlertToActiveMobileDevices } from "./mobile-push.js";
import {
  getHarnessTopologySnapshot,
  nudgeHarnessTopologyScan,
} from "./harness-topology/index.js";
import {
  getTailDiscovery,
  readRecentLiveEvents,
  readRecentTranscriptEvents,
} from "./tail/index.js";
import {
  getRepoWatchSnapshot,
  repoWatchHintsFromBrokerSnapshot,
  repoWatchHintsFromTailDiscovery,
} from "./repo-watch/index.js";
import { readTailscaleSelfWebHostsSync } from "./tailscale.js";
import { BrokerWebControlService } from "./broker-web-control-service.js";
import { BrokerA2AService } from "./broker-a2a-service.js";
import { BrokerCapabilityMatrixService } from "./broker-capability-matrix-service.js";
import {
  BrokerRuntimeCatalogService,
  resolveRuntimeCatalogRefreshMs,
} from "./broker-runtime-catalog-service.js";
import { isGeneratedLocalAgentMetadata } from "./broker-managed-session-helpers.js";
import { BrokerManagedSessionService } from "./broker-managed-session-service.js";
import { BrokerManagedSessionHttpService } from "./broker-managed-session-http-service.js";
import { BrokerLocalEndpointResolver } from "./broker-local-endpoint-resolver.js";
import { BrokerLocalInvocationService } from "./broker-local-invocation-service.js";
import {
  buildCardlessSessionEndpoint,
  cardlessSessionDisplayName,
  registerCardlessSession,
  resolveCardlessSessionSpawnTarget,
} from "./broker-cardless-session.js";
import {
  collectOccupiedDefinitionIdsFromBrokerSnapshot,
  resolveProjectProvisionalAgentName,
} from "./provisional-agent-names.js";
import { locateHarnessSession } from "./session-locator.js";
import { findHarnessEntry } from "./harness-catalog.js";
import { BrokerControlStreamService } from "./broker-control-stream-service.js";
import { json } from "./broker-http-helpers.js";
import { createBrokerHttpRouter } from "./broker-http-router.js";
import {
  closeServer,
  isAddressInUse,
  listenTcp,
  listenUnixSocket,
} from "./broker-server-lifecycle.js";
import { BrokerMeshBundleService } from "./broker-mesh-bundle-service.js";
import { BrokerMeshForwardingService } from "./broker-mesh-forwarding-service.js";
import { BrokerMeshDiscoveryService } from "./broker-mesh-discovery-service.js";
import { BrokerMeshHttpService } from "./broker-mesh-http-service.js";
import { fetchPeerAgents } from "./mesh-forwarding.js";
import { BrokerConversationService } from "./broker-conversation-service.js";
import { BrokerMessageService } from "./broker-message-service.js";
import { BrokerInvocationDispatchService } from "./broker-invocation-dispatch-service.js";
import { BrokerCommandService } from "./broker-command-service.js";
import { BrokerDispatchRecoveryService } from "./broker-dispatch-recovery-service.js";
import {
  brokerActorDisplayName as resolveBrokerActorDisplayName,
  brokerRouteKind,
  brokerTargetLabel,
  brokerTargetProjectRoot,
  buildBrokerReturnAddressForActor,
  isLocalScoutProductTarget,
  isOperatorDeliveryTarget,
  messageRefCandidateForRouteTarget,
  messageVisibilityForConversation,
  metadataStringValue,
  resolveBrokerMessageRef,
  scoutbotReplyProvenanceMetadata,
  titleCaseName,
} from "./broker-conversation-helpers.js";
import {
  applyInvocationStatusPatch,
  isReconciledStaleFlightActivityItem,
  isTerminalFlightState,
  staleLocalEndpointReason,
  type InvocationStatusPatch,
} from "./broker-local-invocation-helpers.js";
import {
  homeEndpointForAgent,
  isInactiveLocalAgent,
} from "./broker-endpoint-selection.js";
import { BrokerHomeService } from "./broker-home-service.js";
import { BrokerUnavailableTargetService } from "./broker-unavailable-target-service.js";
import { BrokerRouteAliasStore } from "./broker-route-alias-store.js";
import { BrokerRouteAliasError, BrokerRouteAliasService } from "./broker-route-alias-service.js";
import {
  openControlPlaneSqliteDatabase,
  type ControlPlaneSqliteTransactionalDatabase,
} from "./sqlite-adapter.js";
import {
  configureControlPlaneDatabase,
  migrateControlPlaneDatabaseSchema,
} from "./control-plane-migrations.js";
import {
  buildSignedNodeCard,
  loadOrCreateNodeIdentity,
  nodeFingerprint,
  nodeKeyId,
  resolveStableLocalNodeId,
} from "./node-identity.js";
import {
  createMeshBindController,
  readPersistedAdvertiseScope,
  type MeshBindController,
} from "./mesh-bind-controller.js";
import {
  PEER_AUTH_MAX_SKEW_MS,
  PeerNonceCache,
} from "./mesh-peer-auth.js";
import { createMeshPeerFetch } from "./mesh-peer-client.js";
import {
  TrustEndpointRateLimiter,
  TrustEnrollmentService,
} from "./mesh-trust-enrollment.js";
import {
  createMeshIngressGate,
  resolveMeshGateMode,
} from "./mesh-ingress-gate.js";
import { SQLiteControlPlaneStore } from "./sqlite-store.js";
import { loadOpenScoutRuntimeBuildIdentity } from "./build-info.js";

const PROCESS_NAME = "scout-broker";

process.title = PROCESS_NAME;

function createRuntimeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function resolveControlPlaneHome(): string {
  return process.env.OPENSCOUT_CONTROL_HOME
    ?? join(process.env.HOME ?? process.cwd(), ".openscout", "control-plane");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

const controlHome = resolveControlPlaneHome();
const dbPath = join(controlHome, "control-plane.sqlite");
const journalPath = join(controlHome, "broker-journal.jsonl");
const port = Number.parseInt(process.env.OPENSCOUT_BROKER_PORT ?? String(DEFAULT_BROKER_PORT), 10);
const supportDirectory = resolveOpenScoutSupportPaths().supportDirectory;
// §11.5: persisted bind posture wins over env so reboot restores announce.
const bootAdvertiseScope = resolveAdvertiseScope(
  process.env,
  () => readPersistedAdvertiseScope(supportDirectory),
);
// §11.3: plaintext always on loopback; non-loopback TLS is owned by the bind controller.
const host = resolveBrokerHost(bootAdvertiseScope);
let advertiseScope = bootAdvertiseScope;
let brokerUrl = resolveBrokerUrl(host, port, advertiseScope);
const brokerControlUrl = buildLocalBrokerControlUrl(host, port);
const meshId = process.env.OPENSCOUT_MESH_ID ?? "openscout";
const nodeName = process.env.OPENSCOUT_NODE_NAME ?? hostname();
const tailnetName = process.env.TAILSCALE_TAILNET ?? undefined;
const brokerSocketPath = process.env.OPENSCOUT_BROKER_SOCKET_PATH
  ?? resolveBrokerServiceConfig().brokerSocketPath;
let nodeId = process.env.OPENSCOUT_NODE_ID?.trim() ?? "";
const tailnetWebHosts = readTailscaleSelfWebHostsSync();
const nodeLocalProductAgentIds = new Set([
  SCOUT_DISPATCHER_AGENT_ID,
  OPENSCOUT_COORDINATOR_AGENT_ID,
  "scoutbot",
]);
const seedUrls = (process.env.OPENSCOUT_MESH_SEEDS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const webStartTrustedHosts = new Set(
  [
    ...(process.env.OPENSCOUT_WEB_TRUSTED_HOSTS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    ...tailnetWebHosts,
  ].map((value) => value.replace(/\.$/, "").toLowerCase()),
);
const configuredCoreAgentIds = (process.env.OPENSCOUT_CORE_AGENTS ?? "")
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);
const discoveryIntervalMs = Number.parseInt(process.env.OPENSCOUT_MESH_DISCOVERY_INTERVAL_MS ?? "60000", 10);
const parentPid = Number.parseInt(process.env.OPENSCOUT_PARENT_PID ?? "0", 10);
const localAgentSyncIntervalMs = Number.parseInt(process.env.OPENSCOUT_LOCAL_AGENT_SYNC_INTERVAL_MS ?? "5000", 10);
const cardlessSessionSweepIntervalMs = Number.parseInt(
  process.env.OPENSCOUT_CARDLESS_SESSION_SWEEP_INTERVAL_MS ?? "300000",
  10,
);
const cardlessSessionIdleTtlMs = Number.parseInt(
  process.env.OPENSCOUT_CARDLESS_SESSION_IDLE_TTL_MS ?? String(DEFAULT_CARDLESS_SESSION_IDLE_TTL_MS),
  10,
);
const relayAgentSweepIntervalMs = Number.parseInt(
  process.env.OPENSCOUT_RELAY_AGENT_SWEEP_INTERVAL_MS ?? "300000",
  10,
);
const relayAgentIdleTtlMs = Number.parseInt(
  process.env.OPENSCOUT_RELAY_AGENT_IDLE_TTL_MS ?? String(DEFAULT_RELAY_AGENT_SESSION_IDLE_TTL_MS),
  10,
);
const runtimeHeartbeatIntervalMs = 30_000;
const repoWatchServeCacheTtlMs = Number.parseInt(process.env.OPENSCOUT_REPO_WATCH_CACHE_TTL_MS ?? "1200000", 10);
const repoWatchRehydrateAfterMs = Number.parseInt(process.env.OPENSCOUT_REPO_WATCH_REHYDRATE_AFTER_MS ?? "30000", 10);
// Mesh trust cone rollout (docs/proposals/mesh-trust-cone.md §10): the ingress
// gate verifies everything but only warns until OPENSCOUT_MESH_GATE=enforce.
const meshGateMode = resolveMeshGateMode(process.env);

ensureOpenScoutCleanSlateSync();
const existingBroker = await probeExistingBroker();
if (existingBroker) {
  console.log(`[openscout-runtime] broker already running on ${existingBroker.brokerUrl}`);
  console.log(`[openscout-runtime] node ${existingBroker.nodeId} in mesh ${existingBroker.meshId ?? "unknown"}`);
  process.exit(0);
}

// Persist the default qualifier once. macOS may append a changing numeric
// suffix to os.hostname() after mDNS collisions; routing authority and agent
// ids must survive that display-hostname drift.
nodeId = resolveStableLocalNodeId({
  configuredNodeId: process.env.OPENSCOUT_NODE_ID,
  nodeName,
  meshId,
  supportDirectory,
});

const journal = new FileBackedBrokerJournal(journalPath);
await journal.load();
const initialSnapshot = journal.snapshot();
assertNoReservedStoredAgentNames(initialSnapshot.agents, { localNodeId: nodeId });

const sqliteDisabled = process.env.OPENSCOUT_DISABLE_SQLITE === "1";
const runtime = createInMemoryControlRuntime(initialSnapshot, { localNodeId: nodeId });
replaceControlEventBacklog(runtime.recentEvents(500), 500);
if (!sqliteDisabled) {
  await mkdir(dirname(dbPath), { recursive: true });
}
const projection = new RecoverableSQLiteProjection(dbPath, journal, { disabled: sqliteDisabled });
const routeAliasDatabase = sqliteDisabled
  ? null
  : openControlPlaneSqliteDatabase(dbPath, { create: true }) as ControlPlaneSqliteTransactionalDatabase;
if (routeAliasDatabase) {
  configureControlPlaneDatabase(routeAliasDatabase);
  migrateControlPlaneDatabaseSchema(routeAliasDatabase);
}
const routeAliasService = routeAliasDatabase
  ? new BrokerRouteAliasService({
      store: new BrokerRouteAliasStore(routeAliasDatabase),
      ownerRealmId: meshId,
      nodeId,
      operatorActorId: "operator",
      runtimeSnapshot: () => runtime.snapshot(),
      createId: createRuntimeId,
    })
  : undefined;

// ─── Mesh trust cone: node identity, ingress gate, enrollment ─────────────
// (docs/proposals/mesh-trust-cone.md). The long-term Ed25519 identity anchors
// everything: the gate verifies peer signatures against it, and enrollment
// publishes cards signed by it.
const nodeIdentity = loadOrCreateNodeIdentity();
const nodeIdentityKeyId = nodeKeyId(nodeIdentity.publicKey);
const nodeIdentityFingerprint = nodeFingerprint(nodeIdentity.publicKey);
const brokerBootedAt = Date.now();
const trustedPeerStore = sqliteDisabled ? null : new SQLiteControlPlaneStore(dbPath);
// Bind controller is assigned after the HTTP server stack is built; the gate
// reads forceRemoteEnforce via this ref so §11.6 can key off live listeners.
let meshBindController: MeshBindController | null = null;
const meshIngressGate = createMeshIngressGate({
  mode: meshGateMode,
  destinationKeyId: nodeIdentityKeyId,
  bootedAt: brokerBootedAt,
  lookupPeer: (keyId) => {
    const peer = trustedPeerStore?.trustedPeer(keyId);
    return peer ? { publicKey: peer.publicKey, tier: peer.tier } : undefined;
  },
  nonceClaim: trustedPeerStore
    ? {
        claim: (keyId, nonce, now) =>
          trustedPeerStore.claimPeerNonce(keyId, nonce, now, PEER_AUTH_MAX_SKEW_MS),
      }
    : new PeerNonceCache(),
  logger: { warn: (message, detail) => console.warn(message, detail) },
  forceRemoteEnforce: () => meshBindController?.hasNonLoopbackListener() ?? false,
});
const trustEnrollmentService = new TrustEnrollmentService({
  keyId: nodeIdentityKeyId,
  publicKey: nodeIdentity.publicKey,
  nodeId,
  fingerprint: nodeIdentityFingerprint,
});
const trustEndpointRateLimiter = new TrustEndpointRateLimiter();
function currentSignedNodeCard() {
  const bind = meshBindController?.getState();
  const endpoints = bind && bind.endpoints.length > 0 ? bind.endpoints : [brokerUrl];
  return buildSignedNodeCard(nodeIdentity, {
    nodeId,
    label: nodeName,
    version: loadOpenScoutRuntimeBuildIdentity().version ?? "dev",
    capabilities: currentLocalNode().capabilities ?? [],
    endpoints,
    ...(bind?.tlsSpkiFingerprint
      ? { tls: { spkiFingerprint: bind.tlsSpkiFingerprint } }
      : {}),
  });
}
function effectiveGateMode() {
  return meshBindController?.hasNonLoopbackListener() ? "enforce" as const : meshGateMode;
}

/**
 * This daemon's own signed peer client for broker→broker sends (mesh trust
 * cone §5). Peers enrolled in trusted_peers — joined to snapshot nodes by
 * broker URL — are pinned to their enrolled key ID: a missing, unreachable,
 * or mismatched card refuses the send instead of falling back to unsigned.
 * Peers with no enrolled key ID keep the legacy rollout fallback. The shared
 * `meshPeerFetch` singleton stays unwired (the store is keyed by key ID, not
 * base URL, so the join only exists here in the daemon).
 */
function trustedPeerForBrokerBaseUrl(baseUrl: string) {
  const normalized = baseUrl.replace(/\/$/, "");
  const node = Object.values(runtime.snapshot().nodes).find(
    (candidate) => candidate.brokerUrl?.replace(/\/$/, "") === normalized,
  );
  if (!node || !trustedPeerStore) {
    return undefined;
  }
  return trustedPeerStore.listTrustedPeers().find((peer) => peer.nodeId === node.id);
}

const daemonMeshPeerFetch = createMeshPeerFetch({
  loadIdentity: () => nodeIdentity,
  expectedPeerKeyId: (baseUrl) => trustedPeerForBrokerBaseUrl(baseUrl)?.keyId,
  expectedPeerTlsPin: (baseUrl) => trustedPeerForBrokerBaseUrl(baseUrl)?.tlsSpkiFingerprint,
});

const threadEvents = new ThreadEventPlane({
  nodeId,
  runtime,
  projection,
});
const durableStore = new BrokerDurableStore({
  journal,
  projection,
  threadEvents,
});
const runDurableWrite = durableStore.runWrite;
const commitDurableEntries = durableStore.commitEntries;
const applyProjectedEntries = durableStore.applyProjectedEntries;
const meshBundleService = new BrokerMeshBundleService({
  nodeId,
  runtime,
  commitEntries: commitDurableEntries,
});
const applyMeshBundleDurably = meshBundleService.applyBundle;
const activeInvocationTasks = new Map<string, Promise<void>>();
const knownInvocations = new Map<string, InvocationRequest>(Object.entries(initialSnapshot.invocations));
const meshHttpService = new BrokerMeshHttpService({
  nodeId,
  runtime,
  runDurableWrite,
  applyMeshBundle: applyMeshBundleDurably,
  commitEntries: commitDurableEntries,
  applyProjectedEntries,
  rememberInvocation: (invocation) => {
    knownInvocations.set(invocation.id, invocation);
  },
  runDispatchJob: (job, invocation) => invocationDispatchService.runDispatchJob(job, invocation),
  warn: (message, detail) => console.warn(message, detail),
});
const meshForwardingService = new BrokerMeshForwardingService({
  nodeId,
  runtime,
  currentLocalNode,
  invocationFor: (invocationId) => knownInvocations.get(invocationId),
  endpointForAgent: (agentId) => homeEndpointForAgent(runtime.snapshot(), agentId),
  projectRootForTarget: brokerTargetProjectRoot,
  peerFetch: daemonMeshPeerFetch,
});
const controlStreams = new BrokerControlStreamService({
  enqueueEvent: (event) => projection.enqueueEvent(event),
  findDeliveryById: (deliveryId) => journal.listDeliveries({ limit: 1000 }).find((delivery) => delivery.id === deliveryId),
  listDeliveries: (options) => projection.listDeliveries(options),
  messageById: (messageId) => runtime.message(messageId),
  invocationById: (invocationId) => knownInvocations.get(invocationId),
});
const operatorActorId = "operator";
const durableRecords = new BrokerDurableRecordStore({
  runtime,
  durableStore,
  knownInvocations,
});
const upsertNodeDurably = durableRecords.upsertNode;
const upsertActorDurably = durableRecords.upsertActor;
const upsertAgentDurably = durableRecords.upsertAgent;
const upsertEndpointDurably = durableRecords.upsertEndpoint;
const deleteEndpointDurably = durableRecords.deleteEndpoint;
const upsertConversationDurably = durableRecords.upsertConversation;
const upsertBindingDurably = durableRecords.upsertBinding;
const recordCollaborationDurably = durableRecords.recordCollaboration;
const appendCollaborationEventDurably = durableRecords.appendCollaborationEvent;
const recordMessageDurably = durableRecords.recordMessage;
const recordInvocationDurably = durableRecords.recordInvocation;
const recordInvocationDispatchJobDurably = durableRecords.recordInvocationDispatchJob;
const conversationService = new BrokerConversationService({
  nodeId,
  operatorActorId,
  dispatcherAgentId: SCOUT_DISPATCHER_AGENT_ID,
  runtime,
  operatorDisplayName: operatorActorDisplayName,
  createChannelId: () => mintChannelId(randomUUID),
  upsertActor: upsertActorDurably,
  upsertConversation: upsertConversationDurably,
});
const meshDiscoveryService = new BrokerMeshDiscoveryService({
  nodeId,
  brokerUrl,
  defaultPort: port,
  meshId,
  seedUrls,
  nodeLocalProductAgentIds,
  runtime,
  upsertNode: upsertNodeDurably,
  upsertAgent: upsertAgentDurably,
  notifyPeerOnline: (peerNodeId) => peerDelivery.notifyPeerOnline(peerNodeId),
  fetchPeerAgents: (peerBrokerUrl) => fetchPeerAgents(peerBrokerUrl, daemonMeshPeerFetch),
  log: (message) => console.log(message),
});
const deliveryStore = new BrokerDeliveryStore({
  journal,
  durableStore,
  nodeId,
  createEventId: () => createRuntimeId("evt"),
  publishEvent: (event) => controlStreams.streamEvent(event),
});
const recordDeliveryDurably = deliveryStore.recordDelivery;
const recordDeliveryAttemptDurably = deliveryStore.recordDeliveryAttempt;
const heartbeatDurableActionDurably = deliveryStore.heartbeatDurableAction;
const updateDeliveryStatusDurably = deliveryStore.updateDeliveryStatus;
const claimDeliveryDurably = deliveryStore.claimDelivery;
const readCursorStore = new BrokerReadCursorStore({
  runtime,
  projection,
  durableStore,
  operatorActorId,
  nodeId,
  ensureActor: ensureBrokerActorForDelivery,
  updateDeliveryStatus: updateDeliveryStatusDurably,
});
const listReadCursorsForConversation = readCursorStore.listForConversation;
const resolveReadCursor = readCursorStore.resolve;
const recordReadCursorDurably = readCursorStore.record;
const acknowledgeDeliveriesForReadCursor = readCursorStore.acknowledgeDeliveries;
const deliveryHttpService = new BrokerDeliveryHttpService({
  listInboxItems: (options) => controlStreams.listInboxItems(options),
  inboxItemForDelivery: (delivery) => controlStreams.inboxItemForDelivery(delivery),
  claimDelivery: claimDeliveryDurably,
  updateDeliveryStatus: updateDeliveryStatusDurably,
  listDeliveries: (options) => journal.listDeliveries(options),
  listDeliveryAttempts: (deliveryId) => journal.listDeliveryAttempts(deliveryId),
  recordDeliveryAttempt: recordDeliveryAttemptDurably,
});
const durableActionHttpService = new BrokerDurableActionHttpService({
  runDurableWrite,
  commitEntries: commitDurableEntries,
  heartbeatDurableAction: heartbeatDurableActionDurably,
  getDurableAction: (actionId) => journal.getDurableAction(actionId),
});
const workItemStore = new BrokerWorkItemStore({
  runtime,
  durableStore,
  createId: createRuntimeId,
});
const recordDeliveryWorkItemIfNeeded = workItemStore.recordDeliveryWorkItemIfNeeded;
const deliveryWorkItemResolutionForTell = workItemStore.deliveryWorkItemResolutionForTell;
const promoteInvocationFlightToWork = workItemStore.promoteInvocationFlightToWork;
const deliveryRouter = new BrokerDeliveryRouter({
  runtimeSnapshot: () => runtime.snapshot(),
  nodeId,
  isInactiveLocalAgent,
  log: (message) => console.log(message),
  warn: (message) => console.warn(message),
  routeAliasService,
  wakeExactHarnessSession: async (input) => {
    const located = locateHarnessSession({
      nativeSessionId: input.nativeSessionId,
      harness: input.harness,
      projectPath: input.projectPath,
    });
    if (!located.ok) {
      return {
        ok: false,
        reason: located.reason,
        detail: located.detail,
        ...(located.remediation ? { remediation: located.remediation } : {}),
      };
    }

    const session = located.session;
    const harnessEntry = findHarnessEntry(session.harness);
    if (!harnessEntry?.resume) {
      return {
        ok: false,
        reason: "session_not_resumable",
        detail: `harness "${session.harness}" does not advertise a resume command`,
        remediation: `bring a ${session.harness} worker online first, or use a resumable harness`,
      };
    }

    let spawn: ReturnType<typeof resolveCardlessSessionSpawnTarget>;
    try {
      spawn = resolveCardlessSessionSpawnTarget(session.harness);
    } catch (error) {
      return {
        ok: false,
        reason: "session_not_resumable",
        detail: error instanceof Error ? error.message : String(error),
      };
    }

    const cwd = session.cwd || input.projectPath?.trim();
    if (!cwd) {
      return {
        ok: false,
        reason: "session_not_resumable",
        detail: `session ${session.nativeSessionId} has no cwd; pass --project`,
        remediation: `scout ask --to session:${session.harness}:${session.nativeSessionId} --project <cwd>`,
      };
    }

    // Stable scout session marker for this native id so re-asks hit the same endpoint.
    const scoutSessionId = `flat-${session.harness}-${session.nativeSessionId}`;
    const existing = Object.values(runtime.snapshot().endpoints).find((endpoint) => {
      if (endpoint.nodeId !== nodeId) return false;
      const aliases = [
        endpoint.sessionId,
        endpoint.metadata?.externalSessionId,
        endpoint.metadata?.threadId,
        endpoint.metadata?.nativeSessionId,
      ].map((value) => (typeof value === "string" ? value.trim() : ""));
      return aliases.includes(session.nativeSessionId) || endpoint.agentId === scoutSessionId;
    });
    if (existing && existing.state !== "offline" && existing.state !== "failed" && existing.state !== "stopped") {
      return { ok: true };
    }

    try {
      await registerCardlessSession({
        upsertActor: upsertActorDurably,
        upsertEndpoint: persistEndpoint,
      }, {
        sessionId: scoutSessionId,
        handle: scoutSessionId,
        transport: spawn.transport,
        harness: spawn.harness,
        cwd,
        projectRoot: cwd,
        nodeId,
        externalSessionId: session.nativeSessionId,
        nativeSessionId: session.nativeSessionId,
        flatDispatch: true,
        displayName: `${basename(cwd)}:${session.nativeSessionId.slice(0, 8)}`,
      });
      console.log(
        `[openscout-runtime] flat-dispatch wake ${session.harness}:${session.nativeSessionId} via ${spawn.transport} cwd=${cwd}`,
      );
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        reason: "session_wake_failed",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  },
  resolveRemoteRouteAlias: async (target, caller) => {
    const selector = target.scope?.nodeId?.trim();
    if (!selector) return null;
    const matches = Object.values(runtime.snapshot().nodes).filter((candidate) =>
      candidate.id === selector || candidate.name === selector || candidate.hostName === selector
    );
    if (matches.length !== 1) {
      throw new BrokerRouteAliasError(
        "ambiguous_alias_scope",
        `host ${selector} is ${matches.length ? "ambiguous" : "unknown"}; use an exact node id`,
        { candidates: matches.map((candidate) => candidate.id) },
      );
    }
    const authority = matches[0]!;
    if (authority.id === nodeId) return null;
    if (authority.meshId !== meshId || !authority.brokerUrl) {
      throw new BrokerRouteAliasError(
        authority.meshId !== meshId ? "not_authorized" : "alias_target_unavailable",
        authority.meshId !== meshId
          ? "alias authority is outside the local owner realm"
          : `authoritative broker ${authority.id} is not reachable`,
      );
    }
    let response: Response;
    const requestInit = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openscout-mesh-id": meshId,
        "x-openscout-forwarded-node-id": nodeId,
      },
      body: JSON.stringify({ alias: target.alias, bindingId: target.bindingId, scope: target.scope, caller }),
      signal: AbortSignal.timeout(30_000),
    };
    try {
      // Signed via the mesh peer client. Alias resolution is served to peers
      // at the remote tier (/v1/mesh/aliases/resolve, §4); pre-trust-cone
      // peers lack that route, so fall back to the legacy local path on 404.
      response = await daemonMeshPeerFetch(authority.brokerUrl, "/v1/mesh/aliases/resolve", requestInit);
      if (response.status === 404) {
        response = await daemonMeshPeerFetch(authority.brokerUrl, "/v1/aliases/resolve", requestInit);
      }
    } catch (error) {
      throw new BrokerRouteAliasError(
        "alias_target_unavailable",
        `failed to reach authoritative broker ${authority.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const result = await response.json().catch(() => ({})) as import("@openscout/protocol").RouteAliasResolveResult & {
      error?: import("@openscout/protocol").RouteAliasDiagnosticCode;
      detail?: string;
    };
    if (!response.ok || !result.resolved || !result.binding || !result.proof) {
      throw new BrokerRouteAliasError(
        result.diagnostic?.code ?? result.error ?? "unknown_alias",
        result.diagnostic?.detail ?? result.detail ?? `alias ${target.alias} did not resolve at ${authority.id}`,
      );
    }
    const targetAgent = runtime.snapshot().agents[result.binding.target.agentId];
    if (!targetAgent) {
      throw new BrokerRouteAliasError(
        "alias_target_unavailable",
        `alias ${target.alias} resolved at ${authority.id}, but canonical agent ${result.binding.target.agentId} is not visible in this mesh snapshot`,
      );
    }
    return {
      resolution: { kind: "resolved", agent: targetAgent },
      proof: result.proof,
      binding: result.binding,
    };
  },
});
const resolveBrokerDeliveryTargetWithImplicitProjectAgent =
  deliveryRouter.resolveWithImplicitProjectAgent.bind(deliveryRouter);
const resolveInvocationTarget = deliveryRouter.resolveInvocationTarget.bind(deliveryRouter);
const webControl = new BrokerWebControlService({
  brokerControlUrl,
  tailnetWebHosts,
  trustedHosts: webStartTrustedHosts,
  env: process.env,
  log: (message, detail) => {
    if (detail === undefined) {
      console.log(message);
    } else {
      console.log(message, detail);
    }
  },
  warn: (message) => console.warn(message),
  error: (message, detail) => {
    if (detail === undefined) {
      console.error(message);
    } else {
      console.error(message, detail);
    }
  },
});
const a2aService = new BrokerA2AService({
  nodeId,
  brokerUrl,
  runtime,
  knownInvocations,
  activeInvocationTasks,
  createId: createRuntimeId,
  acceptInvocation: acceptInvocationDurably,
  dispatchInvocation: dispatchAcceptedInvocation,
  recordFlight: recordFlightDurably,
  loadRegisteredLocalAgentBindings,
  sleep,
  error: (message, detail) => {
    if (detail === undefined) {
      console.error(message);
    } else {
      console.error(message, detail);
    }
  },
});
const capabilityMatrixService = new BrokerCapabilityMatrixService({
  nodeId,
  env: process.env,
});
const readBrokerCapabilityMatrixSnapshot = capabilityMatrixService.read.bind(capabilityMatrixService);
const runtimeCatalogService = new BrokerRuntimeCatalogService({ env: process.env });
const readBrokerRuntimeCatalogSnapshot = runtimeCatalogService.read.bind(runtimeCatalogService);
const runtimeCatalogRefreshMs = resolveRuntimeCatalogRefreshMs(process.env);
if (runtimeCatalogRefreshMs > 0) {
  setInterval(() => {
    void runtimeCatalogService.read({ force: true });
  }, runtimeCatalogRefreshMs).unref();
}
void runtimeCatalogService.read();
let shuttingDown = false;
const sseKeepAliveIntervalMs = Number.parseInt(process.env.OPENSCOUT_SSE_KEEPALIVE_MS ?? "15000", 10);
let meshRendezvousPublisher: MeshRendezvousPublisher | null = null;
let parentWatcher: ReturnType<typeof setInterval> | null = null;

type LegacyRelayMessage = {
  id: string;
  ts: number;
  from: string;
  type: "MSG" | "SYS";
  body: string;
  tags?: string[];
  to?: string[];
  channel?: string;
};

runtime.subscribe((event) => {
  controlStreams.streamEvent(event);
  publishControlEvent(event);
});

if (sseKeepAliveIntervalMs > 0) {
  setInterval(() => {
    controlStreams.streamKeepAlive();
  }, sseKeepAliveIntervalMs).unref();
}

let irohBridgeService: IrohBridgeService | undefined;
let localIrohEntrypoint = resolveIrohMeshEntrypointFromEnv();
if (!localIrohEntrypoint) {
  try {
    irohBridgeService = await startIrohBridgeServeFromEnv({ brokerUrl });
    localIrohEntrypoint = irohBridgeService?.entrypoint;
    if (irohBridgeService) {
      irohBridgeService.child.on("exit", (code, signal) => {
        if (!shuttingDown) {
          console.warn(`[openscout-runtime] Iroh bridge exited (${code ?? signal ?? "unknown"}); HTTP/Tailscale forwarding remains available`);
        }
      });
    }
  } catch (error) {
    console.warn(`[openscout-runtime] Iroh bridge unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const localNode: NodeDefinition = {
  id: nodeId,
  meshId,
  name: nodeName,
  hostName: hostname(),
  advertiseScope,
  brokerUrl,
  webUrl: webControl.url(),
  ...(localIrohEntrypoint ? { meshEntrypoints: [localIrohEntrypoint] } : {}),
  tailnetName,
  capabilities: ["broker", "mesh", "local_runtime"],
  registeredAt: Date.now(),
  lastSeenAt: Date.now(),
};

function currentHostInfo() {
  const supportPaths = resolveOpenScoutSupportPaths();
  const webUrl = webControl.url();
  const webPort = webControl.port();
  const now = Date.now();
  return {
    schemaVersion: 1,
    source: "openscout-runtime",
    updatedAtMs: now,
    nodeId,
    meshId,
    nodeName,
    hostName: hostname(),
    advertiseScope,
    tailnetName,
    brokerUrl,
    webUrl,
    brokerSocketPath,
    supportDirectory: supportPaths.supportDirectory,
    runtimeDirectory: supportPaths.runtimeDirectory,
    ports: {
      broker: port,
      web: webPort,
    },
    services: {
      broker: {
        url: brokerUrl,
        host,
        port,
        socketPath: brokerSocketPath,
      },
      web: {
        url: webUrl,
        host: "127.0.0.1",
        port: webPort,
      },
    },
  };
}

async function writeHostInfo(): Promise<void> {
  const hostInfoPath = resolveOpenScoutSupportPaths().hostInfoPath;
  await mkdir(dirname(hostInfoPath), { recursive: true });
  const temporaryPath = `${hostInfoPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(currentHostInfo(), null, 2)}\n`, "utf8");
  await rename(temporaryPath, hostInfoPath);
}

const systemActor: ActorIdentity = {
  id: "system",
  kind: "system",
  displayName: "System",
  handle: "system",
  labels: ["runtime"],
  metadata: {
    source: "broker",
  },
};

async function migrateUnqualifiedRelayAgentKeys(): Promise<void> {
  const canonical = await readRelayAgentOverrides();
  await writeRelayAgentOverrides(canonical);
}

async function readRelayAgentRegistrySignature(): Promise<string | null> {
  try {
    const registryPath = resolveOpenScoutSupportPaths().relayAgentsRegistryPath;
    const info = await stat(registryPath);
    const contents = await readFile(registryPath);
    const hash = createHash("sha256").update(contents).digest("base64url");
    return `${info.mtimeMs}:${info.size}:${hash}`;
  } catch (error) {
    if (
      error
      && typeof error === "object"
      && "code" in error
      && (error as { code?: string }).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

async function syncRegisteredLocalAgentsIfChanged(reason: string): Promise<void> {
  await localAgentSyncService.syncIfChanged(reason);
}

async function bootstrapRegisteredLocalAgents(): Promise<void> {
  await localAgentSyncService.bootstrap();
}

function currentLocalNode(): NodeDefinition {
  return runtime.node(nodeId) ?? localNode;
}

function currentRendezvousNode(): NodeDefinition {
  const node = currentLocalNode();
  const mobilePairingEntrypoint = readMobilePairingMeshEntrypoint();
  if (!mobilePairingEntrypoint) {
    return node;
  }

  return {
    ...node,
    meshEntrypoints: [
      ...(node.meshEntrypoints ?? []).filter((entrypoint) => entrypoint.kind !== "mobile_pairing"),
      mobilePairingEntrypoint,
    ],
    lastSeenAt: Date.now(),
  };
}

async function recordScoutDispatchDurably(
  envelope: ScoutDispatchEnvelope,
  options: {
    invocationId?: string;
    conversationId?: string;
    requesterId?: string;
  } = {},
): Promise<{
  record: ScoutDispatchRecord;
  message: MessageRecord | null;
  entries: BrokerJournalEntry[];
}> {
  const record: ScoutDispatchRecord = {
    id: createRuntimeId("scout-dispatch"),
    invocationId: options.invocationId,
    conversationId: options.conversationId,
    requesterId: options.requesterId,
    ...envelope,
  };

  const dispatchEntries: BrokerJournalEntry[] = [
    { kind: "scout.dispatch.record", dispatch: record },
  ];

  let syntheticMessage: MessageRecord | null = null;
  if (options.conversationId) {
    syntheticMessage = {
      id: createRuntimeId("msg-scout"),
      conversationId: options.conversationId,
      actorId: SCOUT_DISPATCHER_AGENT_ID,
      originNodeId: nodeId,
      class: "system",
      body: record.detail,
      visibility: "workspace",
      policy: "best_effort",
      createdAt: record.dispatchedAt,
      metadata: {
        scoutDispatch: record,
      },
    };
  }

  return runDurableWrite(async () => {
    const appended = await commitDurableEntries(dispatchEntries, async () => {});
    if (!syntheticMessage) {
      return { record, message: null, entries: appended };
    }

    const deliveries = runtime.planMessage(syntheticMessage, { localOnly: true });
    const messageEntries = await commitDurableEntries(
      [
        { kind: "message.record", message: syntheticMessage },
        { kind: "deliveries.record", deliveries },
      ],
      async () => {
        await runtime.commitMessage(syntheticMessage!, deliveries);
      },
    );
    return { record, message: syntheticMessage, entries: [...appended, ...messageEntries] };
  });
}

const flightLifecycleService = new BrokerFlightLifecycleService({
  runtime,
  journal,
  durableStore,
  invocationFor: (invocationId) => knownInvocations.get(invocationId),
  updateDeliveryStatus: updateDeliveryStatusDurably,
  promoteInvocationFlightToWork,
  maybeForwardFlightToAuthority: (flight) => meshForwardingService.maybeForwardFlightToAuthority(flight),
  isInvocationActive: (invocationId) => localInvocationService.hasActiveInvocation(invocationId),
  onTerminalFlight: async ({ flight, invocation }) => {
    // Role lifecycle (orchestrator post_ask_summary, etc.). Best-effort; never
    // fail the flight record path. Uses a short-lived SQLite connection so we
    // don't hold the projection store lock.
    if (sqliteDisabled) return;
    try {
      const { Database } = await import("bun:sqlite");
      const db = new Database(dbPath);
      try {
        db.exec("PRAGMA busy_timeout = 2500;");
        const result = applyRoleLifecycleForTerminalFlight(db as never, {
          flight,
          invocation,
        });
        if (result.written > 0) {
          console.log(
            `[openscout-runtime] role lifecycle flight ${flight.id}: wrote ${result.written} mission log entr${result.written === 1 ? "y" : "ies"}`,
          );
        }
        if (result.errors.length > 0) {
          console.warn(
            `[openscout-runtime] role lifecycle flight ${flight.id} errors:`,
            result.errors.join("; "),
          );
        }
      } finally {
        db.close();
      }
    } catch (error) {
      console.warn(
        `[openscout-runtime] role lifecycle flight ${flight.id} failed:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  },
  warn: (message, detail) => {
    if (detail === undefined) {
      console.warn(message);
    } else {
      console.warn(message, detail);
    }
  },
});

async function recordFlightDurably(flight: FlightRecord): Promise<void> {
  await flightLifecycleService.recordFlight(flight);
}

async function reconcileStaleLocalDeliveries(): Promise<void> {
  await flightLifecycleService.reconcileStaleLocalDeliveries();
}

async function persistFlight(flight: FlightRecord): Promise<void> {
  await recordFlightDurably(flight);
}

// Phase 3 write collapse: status changes are expressed as patches against the
// invocation's current flight rather than hand-built whole FlightRecords, and
// still funnel through recordFlightDurably so the lifecycle hooks fire.
async function transitionInvocation(
  invocationId: string,
  patch: InvocationStatusPatch,
): Promise<FlightRecord> {
  const current = runtime.flightForInvocation(invocationId);
  if (!current) {
    // Dispatch persists the initial flight before launching local execution,
    // so a missing flight here is an invariant breach, not a normal state.
    throw new Error(`cannot transition invocation ${invocationId}: no flight recorded`);
  }
  const next = applyInvocationStatusPatch(current, patch);
  await recordFlightDurably(next);
  return next;
}

async function persistEndpoint(endpoint: AgentEndpoint): Promise<void> {
  await upsertEndpointDurably(endpoint);
  if (endpoint.state === "idle" || endpoint.state === "active") {
    dispatchRecoveryService.recoverQueuedFlights({
      reason: "endpoint_online",
      agentId: endpoint.agentId,
    }).catch((error) => {
      console.error("[openscout-runtime] queued dispatch recovery failed:", error);
    });
  }
}

async function sweepIdleCardlessSessions(): Promise<void> {
  const configuredTtlMs = Number.isFinite(cardlessSessionIdleTtlMs)
    ? cardlessSessionIdleTtlMs
    : DEFAULT_CARDLESS_SESSION_IDLE_TTL_MS;
  const initialCandidates = idleCardlessSessionExpiryCandidates(runtime.snapshot(), {
    nodeId,
    idleTtlMs: configuredTtlMs,
  });
  let reaped = 0;

  for (const initialCandidate of initialCandidates) {
    // Re-evaluate immediately before shutdown so a newly assigned flight or work
    // item wins the race against the periodic reaper.
    const candidate = idleCardlessSessionExpiryCandidates(runtime.snapshot(), {
      nodeId,
      idleTtlMs: configuredTtlMs,
    }).find((endpoint) => endpoint.id === initialCandidate.id);
    if (!candidate) continue;

    try {
      await shutdownLocalSessionEndpoint(candidate);
    } catch (error) {
      console.warn(`[openscout-runtime] failed to stop expired cardless session ${candidate.agentId}:`, error);
      continue;
    }

    const retiredAt = Date.now();
    await persistEndpoint({
      ...candidate,
      state: "stopped",
      metadata: {
        ...(candidate.metadata ?? {}),
        cardlessSessionExpired: true,
        staleLocalRegistration: true,
        retiredAt,
        lastError: `idle cardless session expired after ${configuredTtlMs}ms`,
        lastFailedAt: retiredAt,
      },
    });
    reaped += 1;
  }

  if (reaped > 0) {
    console.log(`[openscout-runtime] retired ${reaped} idle cardless session${reaped === 1 ? "" : "s"}`);
  }
}

// Relay agents live in detached tmux sessions parented to launchd, so nothing
// reaps them for free. The reaper puts idle relays back to sleep (the wake
// path recreates them on demand) and its startup pass collects orphans left
// behind by previous runs.
const relayAgentReaper = new RelayAgentSessionReaper({
  snapshot: () => runtime.snapshot(),
  listTmuxSessions: async () => {
    const probe = await tmuxSessionsProbe.for({}).fresh({ maxAgeMs: 5_000 });
    return (probe.value ?? []).map((session) => ({
      name: session.name,
      attached: session.attached,
      createdAtMs: session.createdAt ? session.createdAt * 1_000 : null,
      activityAtMs: session.activityAt ? session.activityAt * 1_000 : null,
    }));
  },
  listSessionOwners: () => listRelayAgentTmuxSessionOwners(),
  killSession: (sessionName) => sleepLocalAgentSession(sessionName),
  reconcileLeases: ({ liveSessionNames, owners }) => {
    reconcileRelayAgentProcessLeases({ liveSessionNames, owners });
  },
  idleTtlMs: Number.isFinite(relayAgentIdleTtlMs) && relayAgentIdleTtlMs > 0
    ? relayAgentIdleTtlMs
    : DEFAULT_RELAY_AGENT_SESSION_IDLE_TTL_MS,
  log: (message) => console.log(message),
  warn: (message) => console.warn(message),
});

const managedSessionService = new BrokerManagedSessionService({
  nodeId,
  runtime,
  createId: createRuntimeId,
  isInactiveLocalAgent,
  upsertAgent: upsertAgentDurably,
  persistEndpoint,
  findPairingSession,
  getPairingSessionSnapshot,
  ensurePairingSessionForCodexThread,
  shutdownLocalSessionEndpoint,
  log: (message) => console.log(message),
});

const managedSessionHttpService = new BrokerManagedSessionHttpService({
  nodeId,
  runtimeSnapshot: () => runtime.snapshot(),
  processCwd: () => process.cwd(),
  listPairingSessions,
  attachManagedPairingSession: (input) => managedSessionService.attachManagedPairingSession(input),
  detachManagedPairingSession: (input) => managedSessionService.detachManagedPairingSession(input),
  attachManagedLocalSession: (input) => managedSessionService.attachManagedLocalSession(input),
  detachManagedLocalSession: (input) => managedSessionService.detachManagedLocalSession(input),
  ensureLocalSessionEndpointOnline,
  persistEndpoint,
});

const localEndpointResolver = new BrokerLocalEndpointResolver({
  nodeId,
  runtime,
  isLocalAgentEndpointAlive,
  isLocalAgentEndpointAliveAsync,
  ensureLocalSessionEndpointOnline,
  ensureLocalAgentBindingOnline,
  createIsolatedAgentEndpoint: createIsolatedAgentEndpointForInvocation,
  upsertActor: upsertActorDurably,
  upsertAgent: upsertAgentDurably,
  persistEndpoint,
});

const messageService = new BrokerMessageService({
  nodeId,
  systemActorId: systemActor.id,
  runtime,
  mesh: meshForwardingService,
  createId: createRuntimeId,
  recordMessage: recordMessageDurably,
  applyProjectedEntries,
  reconcileStaleLocalDeliveries,
  persistFlight,
  activeLocalEndpointForAgent: (agentId) => localEndpointResolver.activeLocalEndpointForAgent(agentId),
});

const localInvocationService = new BrokerLocalInvocationService({
  nodeId,
  runtime,
  endpointResolver: localEndpointResolver,
  activeInvocationTasks,
  createId: createRuntimeId,
  transitionInvocation,
  persistEndpoint,
  postInvocationStatusMessage,
  postConversationMessage,
  existingBrokerReplyForInvocation,
  completeInvocationForBrokerReply,
  messageVisibilityForConversation,
  scoutbotReplyProvenanceMetadata,
  invokePairingSessionEndpoint,
  invokeA2AHttpEndpoint,
  invokeLocalAgentEndpoint,
  error: (message, detail) => console.error(message, detail),
  warn: (message) => console.warn(message),
});

const localAgentSyncService = new BrokerLocalAgentSyncService({
  nodeId,
  configuredCoreAgentIds,
  runtime,
  registrySignature: readRelayAgentRegistrySignature,
  migrateRelayAgentKeys: migrateUnqualifiedRelayAgentKeys,
  readRelayAgentOverrides,
  loadRegisteredLocalAgentBindings,
  clearGitBranchCache,
  isGeneratedLocalAgentMetadata,
  isLocalAgentEndpointAlive,
  isLocalAgentEndpointAliveAsync,
  isLocalAgentSessionAlive,
  isLocalAgentSessionAliveAsync,
  shouldDisableGeneratedCodexEndpoint,
  upsertActor: upsertActorDurably,
  upsertAgent: upsertAgentDurably,
  persistEndpoint,
  retireLegacyPairingSessionAgents: () => managedSessionService.retireLegacyPairingSessionAgents(),
  reconcileManagedPairingEndpoints: () => managedSessionService.reconcileManagedPairingEndpoints(),
  reconcileStaleWorkingFlights,
  reconcileStaleLocalDeliveries,
  log: (message) => console.log(message),
});

projection.warm();
await upsertNodeDurably(localNode);
await upsertActorDurably(systemActor);

function operatorActorDisplayName(): string {
  return resolveOperatorName().trim() || operatorActorId;
}

function brokerActorDisplayName(snapshot: ReturnType<typeof runtime.snapshot>, actorId: string): string {
  return resolveBrokerActorDisplayName(snapshot, actorId, {
    operatorActorId,
    operatorDisplayName: operatorActorDisplayName(),
  });
}

async function createCardlessProjectSessionForDelivery(input: {
  projectPath: string;
  execution?: InvocationRequest["execution"];
  projectAgent?: { handle?: string };
  requesterId: string;
  createdAt: number;
}) {
  void input.requesterId;
  void input.createdAt;
  const projectRoot = resolve(expandHomePath(input.projectPath));
  const requestedHarness = input.execution?.harness;
  const { harness, transport } = resolveCardlessSessionSpawnTarget(requestedHarness, {
    claudeTransport: process.env.OPENSCOUT_CLAUDE_CARDLESS_TRANSPORT,
  });
  const reasoningEffort = input.execution?.reasoningEffort?.trim();
  if (reasoningEffort && (harness === "grok-acp" || harness === "kimi")) {
    const profile = harness === "grok-acp" ? "grok" : "kimi";
    throw new Error(
      `${profile} runtime profile does not support reasoning effort through its ACP transport`,
    );
  }
  const launchArgs = launchArgsForCardlessSession(harness, input.execution);
  const sessionId = createRuntimeId("session");
  const projectName = basename(projectRoot) || projectRoot;
  const snapshot = runtime.snapshot();
  const projectSessionIndex = Object.values(snapshot.endpoints).filter((endpoint) => {
    const endpointProjectRoot = endpoint.projectRoot
      ?? (typeof endpoint.metadata?.projectRoot === "string" ? endpoint.metadata.projectRoot : undefined)
      ?? endpoint.cwd;
    return endpoint.metadata?.cardless === true
      && endpoint.harness === harness
      && Boolean(endpointProjectRoot)
      && resolve(expandHomePath(endpointProjectRoot!)) === projectRoot;
  }).length;
  const occupied = collectOccupiedDefinitionIdsFromBrokerSnapshot(snapshot);
  const requestedHandle = input.projectAgent?.handle?.trim();
  const provisionalName = resolveProjectProvisionalAgentName({
    explicitName: requestedHandle,
    occupied,
    seedParts: [
      "cardless-project-session",
      input.requesterId,
      projectRoot,
      harness,
      projectSessionIndex,
    ],
  });
  const registered = await registerCardlessSession({
    upsertActor: upsertActorDurably,
    upsertEndpoint: persistEndpoint,
  }, {
    sessionId,
    handle: provisionalName,
    transport,
    harness,
    cwd: projectRoot,
    projectRoot,
    nodeId,
    ...(input.execution?.model?.trim() ? { model: input.execution.model.trim() } : {}),
    ...(input.execution?.reasoningEffort?.trim() ? { reasoningEffort: input.execution.reasoningEffort.trim() } : {}),
    ...(input.execution?.placement ? { placement: input.execution.placement } : {}),
    ...(launchArgs.length > 0 ? { launchArgs } : {}),
  });
  const endpoint = runtime.snapshot().endpoints[registered.endpointId];
  if (!endpoint) {
    throw new Error(`cardless session endpoint ${registered.endpointId} was not registered`);
  }
  return {
    kind: "resolved_session" as const,
    session: {
      sessionId: registered.sessionId,
      actorId: registered.actorId,
      endpoint,
      label: cardlessSessionDisplayName({ handle: provisionalName, projectName }),
      nodeId: endpoint.nodeId,
    },
  };
}

function launchArgsForCardlessSession(
  harness: AgentHarness,
  execution: InvocationRequest["execution"] | undefined,
): string[] {
  const model = execution?.model?.trim();
  const reasoningEffort = execution?.reasoningEffort?.trim();
  if (harness === "codex") {
    return normalizeCodexAppServerLaunchArgs([
      ...(model ? ["--model", model] : []),
      ...(reasoningEffort ? ["--reasoning-effort", reasoningEffort] : []),
    ]);
  }
  if (harness === "claude") {
    return [
      ...(model ? ["--model", model] : []),
      ...(reasoningEffort ? ["--effort", reasoningEffort] : []),
    ];
  }
  if (harness === "grok") {
    return [
      ...(model ? ["--model", model] : []),
      ...(reasoningEffort ? ["--reasoning-effort", reasoningEffort] : []),
    ];
  }
  return [];
}

async function createIsolatedAgentEndpointForInvocation(
  invocation: InvocationRequest,
): Promise<AgentEndpoint | null> {
  const agent = runtime.agent(invocation.targetAgentId);
  // Session-kind targets have no AgentDefinition. They already own an
  // isolated endpoint, so the resolver may continue with that endpoint.
  if (!agent) return null;

  const requestedHarness = invocation.execution?.harness;
  const candidateEndpoints = runtime.endpointsForAgent(agent.id, {
    nodeId,
    ...(requestedHarness ? { harness: requestedHarness } : {}),
  });
  const baseEndpoint = candidateEndpoints[0]
    ?? runtime.endpointsForAgent(agent.id, { nodeId })[0]
    ?? null;
  const projectRoot = brokerTargetProjectRoot(agent, baseEndpoint);
  if (!projectRoot) {
    throw new Error(
      `isolated_runtime_unavailable: ${brokerTargetLabel(agent)} has no project root from which to spawn an isolated session`,
    );
  }

  const { harness, transport } = resolveCardlessSessionSpawnTarget(
    requestedHarness ?? baseEndpoint?.harness,
    { claudeTransport: process.env.OPENSCOUT_CLAUDE_CARDLESS_TRANSPORT },
  );
  const sessionId = createRuntimeId("session");
  const launchArgs = launchArgsForCardlessSession(harness, invocation.execution);
  const definitionId = agent.definitionId || agent.id;
  const isolatedAgentName = `${definitionId}-isolated-${sessionId.slice(-8)}`;
  const sessionEndpoint = buildCardlessSessionEndpoint({
    sessionId,
    handle: isolatedAgentName,
    displayName: `${agent.displayName} (isolated)`,
    transport,
    harness,
    cwd: projectRoot,
    projectRoot,
    nodeId,
    ...(invocation.execution?.model?.trim() ? { model: invocation.execution.model.trim() } : {}),
    ...(invocation.execution?.reasoningEffort?.trim()
      ? { reasoningEffort: invocation.execution.reasoningEffort.trim() }
      : {}),
    ...(invocation.execution?.placement ? { placement: invocation.execution.placement } : {}),
    ...(launchArgs.length > 0 ? { launchArgs } : {}),
    viaCard: definitionId,
  });
  return {
    ...sessionEndpoint,
    id: `endpoint.${agent.id}.${sessionId}.${nodeId}.${transport}`,
    agentId: agent.id,
    metadata: {
      ...(sessionEndpoint.metadata ?? {}),
      source: "scout-isolated-agent-session",
      cardless: false,
      isolatedExecution: true,
      definitionId,
      agentName: isolatedAgentName,
      runtimeInstanceId: sessionId,
      ...(invocation.executionResolution
        ? { executionResolution: invocation.executionResolution }
        : {}),
    },
  };
}

async function ensureBrokerActorForDelivery(actorId: string): Promise<void> {
  await conversationService.ensureActorForDelivery(actorId);
}

async function ensureBrokerDeliveryConversation(input: {
  requesterId: string;
  targetAgentId?: string;
  channel?: string;
}): Promise<ConversationDefinition> {
  return await conversationService.ensureDeliveryConversation(input);
}

async function reconcileStaleWorkingFlights(): Promise<void> {
  await flightLifecycleService.reconcileStaleWorkingFlights();
}

async function syncRegisteredLocalAgents(): Promise<void> {
  await localAgentSyncService.sync();
}

async function postConversationMessage(
  message: MessageRecord,
): Promise<{
  ok: true;
  message: MessageRecord;
  deliveries: DeliveryIntent[];
  forwarded?: true;
  authorityNodeId?: string;
  duplicate?: boolean;
}> {
  return await messageService.postConversationMessage(message);
}

async function postInvocationStatusMessage(
  invocation: InvocationRequest,
  flight: {
    id?: string;
    summary?: string;
    error?: string;
  },
): Promise<void> {
  await messageService.postInvocationStatusMessage(invocation, flight);
}

function existingBrokerReplyForInvocation(
  invocation: InvocationRequest,
  agentId: string,
  sinceMs: number,
): MessageRecord | null {
  return messageService.existingBrokerReplyForInvocation(invocation, agentId, sinceMs);
}

async function completeInvocationForBrokerReply(
  invocation: InvocationRequest,
  reply: MessageRecord,
): Promise<boolean> {
  return await messageService.completeInvocationForBrokerReply(invocation, reply);
}

function onlineConversationNotifyTargets(
  conversation: ConversationDefinition,
  requesterId: string,
): string[] {
  return messageService.onlineConversationNotifyTargets(conversation, requesterId);
}

async function probeExistingBroker() {
  try {
    const [health, node] = await Promise.all([
      requestScoutBrokerJson<{
        ok?: boolean;
        nodeId?: string;
        meshId?: string;
      }>(brokerUrl, "/health", { socketPath: brokerSocketPath }),
      requestScoutBrokerJson<NodeDefinition>(brokerUrl, "/v1/node", { socketPath: brokerSocketPath }),
    ]);

    if (!health.ok || !node.id) {
      return null;
    }

    return {
      nodeId: node.id,
      meshId: node.meshId ?? health.meshId,
      brokerUrl: node.brokerUrl ?? brokerUrl,
    };
  } catch {
    return null;
  }
}

async function handleCommand(command: ControlCommand): Promise<unknown> {
  return await commandService.execute(command);
}

async function handleInvocationRequest(
  payload: InvocationRequest & BrokerRouteTargetInput,
) {
  return await invocationDispatchService.handleInvocationRequest(payload);
}

async function acceptInvocationDurably(invocation: InvocationRequest): Promise<FlightRecord> {
  const { flight } = await invocationDispatchService.acceptInvocation(invocation);
  return flight;
}

async function dispatchAcceptedInvocation(invocation: InvocationRequest): Promise<void> {
  const job = journal.getInvocationDispatchJobForInvocation(invocation.id);
  if (job) {
    await invocationDispatchService.runDispatchJob(job, invocation);
    return;
  }
  await invocationDispatchService.dispatchAcceptedInvocation(invocation);
}

async function failAcceptedInvocation(invocation: InvocationRequest, detail: string): Promise<void> {
  await invocationDispatchService.failAcceptedInvocation(invocation, detail);
}

const peerDelivery: PeerDeliveryWorker = createPeerDeliveryWorker({
  journal,
  snapshot: () => runtime.peek(),
  localNode: currentLocalNode,
  localNodeId: nodeId,
  nodeFor: (id) => runtime.node(id),
  agentFor: (id) => runtime.agent(id),
  invocationFor: (id) => knownInvocations.get(id),
  recordDelivery: recordDeliveryDurably,
  updateDeliveryStatus: updateDeliveryStatusDurably,
  recordDeliveryAttempt: recordDeliveryAttemptDurably,
  recordFlight: recordFlightDurably,
  failInvocation: failAcceptedInvocation,
  emit: (event) => controlStreams.streamEvent(event),
  peerFetch: daemonMeshPeerFetch,
});

const invocationDispatchService = new BrokerInvocationDispatchService({
  nodeId,
  runtime,
  createId: createRuntimeId,
  syncRegisteredLocalAgentsIfChanged,
  resolveInvocationTarget,
  recordScoutDispatch: recordScoutDispatchDurably,
  recordInvocation: recordInvocationDurably,
  recordInvocationDispatchJob: recordInvocationDispatchJobDurably,
  applyProjectedEntries,
  recordFlight: recordFlightDurably,
  postInvocationStatusMessage,
  describeRemoteAuthorityIssue: (agent, authorityNode) =>
    meshForwardingService.describeRemoteAuthorityIssue(agent, authorityNode),
  describeUnavailableInvocationTarget: (snapshot, agent, targetSessionId) =>
    unavailableTargetService.describe(snapshot, agent, targetSessionId),
  buildUnavailableDispatchEnvelope: (askedLabel, unavailable) =>
    unavailableTargetService.buildEnvelope(askedLabel, unavailable),
  enqueuePeerInvocation: async (invocation, authorityNode) => {
    await peerDelivery.enqueue(invocation, authorityNode);
  },
  launchLocalInvocation: (invocation) => localInvocationService.launch(invocation),
  log: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message, detail) => console.error(message, detail),
});

const dispatchRecoveryService = new BrokerDispatchRecoveryService({
  runtimeSnapshot: () => runtime.snapshot(),
  dispatchJobs: () => journal.listInvocationDispatchJobs({ limit: 5000 }),
  invocationFor: (invocationId) => knownInvocations.get(invocationId),
  isInvocationActive: (invocationId) => localInvocationService.hasActiveInvocation(invocationId),
  runDispatchJob: (job, invocation) => invocationDispatchService.runDispatchJob(job, invocation),
  dispatchAcceptedInvocation: (invocation) => invocationDispatchService.dispatchAcceptedInvocation(invocation),
  log: (message) => console.log(message),
  warn: (message) => console.warn(message),
});

const commandService = new BrokerCommandService({
  runtime,
  mesh: meshForwardingService,
  upsertNode: upsertNodeDurably,
  upsertActor: upsertActorDurably,
  upsertAgent: upsertAgentDurably,
  persistEndpoint,
  upsertConversation: upsertConversationDurably,
  upsertBinding: upsertBindingDurably,
  recordCollaboration: recordCollaborationDurably,
  appendCollaborationEvent: appendCollaborationEventDurably,
  recordMessage: recordMessageDurably,
  applyProjectedEntries,
  reconcileStaleLocalDeliveries,
  acceptAndDispatchInvocation: (invocation, options) =>
    invocationDispatchService.acceptAndDispatch(invocation, options),
  log: (message) => console.log(message),
});

const operatorAttentionService = new BrokerOperatorAttentionService({
  nodeId,
  systemActorId: systemActor.id,
  operatorActorId,
  createId: createRuntimeId,
  ensureBrokerActorForDelivery,
  ensureBrokerDeliveryConversation,
  conversationById: (conversationId) => runtime.conversation(conversationId),
  messageVisibilityForConversation,
  postConversationMessage,
  broadcastApnsAlertToActiveMobileDevices,
  warn: (message) => console.warn(message),
});

const unavailableTargetService = new BrokerUnavailableTargetService({
  nodeId,
  describeRemoteAuthorityIssue: (agent, authorityNode) =>
    meshForwardingService.describeRemoteAuthorityIssue(agent, authorityNode),
});

const deliveryAcceptanceService = new BrokerDeliveryAcceptanceService({
  nodeId,
  operatorActorId,
  runtimeSnapshot: () => runtime.snapshot(),
  createId: createRuntimeId,
  syncRegisteredLocalAgentsIfChanged,
  metadataStringValue,
  messageRefCandidateForRouteTarget,
  resolveBrokerMessageRef,
  ensureBrokerActorForDelivery,
  ensureBrokerDeliveryConversation,
  brokerRouteKind,
  messageVisibilityForConversation,
  brokerActorDisplayName,
  brokerTargetLabel,
  homeEndpointForAgent,
  titleCaseName,
  buildBrokerReturnAddressForActor,
  isOperatorDeliveryTarget,
  isLocalScoutProductTarget,
  onlineConversationNotifyTargets,
  resolveBrokerDeliveryTargetWithImplicitProjectAgent,
  createCardlessProjectSession: createCardlessProjectSessionForDelivery,
  recordScoutDispatch: recordScoutDispatchDurably,
  describeUnavailableDeliveryTarget: (snapshot, agent, targetSessionId) =>
    unavailableTargetService.describe(snapshot, agent, targetSessionId),
  buildUnavailableDispatchEnvelope: (askedLabel, unavailable) =>
    unavailableTargetService.buildEnvelope(askedLabel, unavailable),
  recordDeliveryWorkItemIfNeeded,
  deliveryWorkItemResolutionForTell,
  postConversationMessage,
  acceptInvocation: acceptInvocationDurably,
  dispatchAcceptedInvocation,
  queueOperatorDeliveryIssue: (input) => operatorAttentionService.queueDeliveryIssue(input),
  queueOperatorSignal: (input) => operatorAttentionService.queueOperatorSignal(input),
  warn: (message, detail) => console.warn(message, detail),
});

const homeService = new BrokerHomeService({
  runtimeSnapshot: () => runtime.snapshot(),
  listActivityItems: (options) => projection.listActivityItems(options),
  actorDisplayName: brokerActorDisplayName,
  operatorActorId,
});

const brokerService = createBrokerCoreService({
  baseUrl: brokerUrl,
  nodeId,
  meshId,
  localNode,
  runtime,
  projection,
  journal,
  threadEvents,
  isReconciledStaleFlightActivityItem,
  readChildServices: () => webControl.readChildServiceSnapshots(),
  readProjectionStatus: () => projection.statusSnapshot(),
  readHome: () => homeService.read(),
  readCapabilities: readBrokerCapabilityMatrixSnapshot,
  readRuntimeCatalog: readBrokerRuntimeCatalogSnapshot,
  executeCommand: handleCommand,
  postConversationMessage,
  deliver: (payload, options) => deliveryAcceptanceService.accept(payload, options),
  invokeAgent: handleInvocationRequest,
});

const brokerRepoTailService = new BrokerRepoTailService({
  readBrokerSnapshot: () => brokerService.readSnapshot(),
  getRepoWatchSnapshot,
  repoWatchHintsFromBrokerSnapshot,
  repoWatchHintsFromTailDiscovery,
  getTailDiscovery,
  readRecentLiveEvents,
  readRecentTranscriptEvents,
  repoWatchServeCacheTtlMs,
  repoWatchRehydrateAfterMs,
  warn: (message) => console.warn(message),
});

registerActiveScoutBrokerService(brokerService);

const rendezvousService = new BrokerRendezvousService();

const routeRequest = createBrokerHttpRouter({
  host,
  port,
  nodeId,
  meshId,
  operatorActorId,
  runtime,
  journal,
  knownInvocations,
  brokerService,
  webControl,
  readHostInfo: currentHostInfo,
  a2aService,
  brokerRepoTailService,
  getHarnessTopologySnapshot,
  getTailDiscovery,
  nudgeHarnessTopologyScan,
  deliveryHttpService,
  durableActionHttpService,
  controlStreams,
  managedSessionHttpService,
  meshDiscoveryService,
  meshHttpService,
  threadEvents,
  handleCommand,
  handleInvocationRequest,
  deleteEndpoint: deleteEndpointDurably,
  recordFlight: recordFlightDurably,
  listReadCursorsForConversation,
  resolveReadCursor,
  recordReadCursor: recordReadCursorDurably,
  acknowledgeDeliveriesForReadCursor,
  deliveryAcceptanceService,
  rendezvousService,
  routeAliasService,
  meshTrust: {
    enrollment: trustEnrollmentService,
    rateLimiter: trustEndpointRateLimiter,
    nodeCard: currentSignedNodeCard,
    gateMode: effectiveGateMode,
    persistGrant: (grant) => {
      if (!trustedPeerStore) {
        return false;
      }
      trustedPeerStore.upsertTrustedPeer(grant);
      return true;
    },
    peers: trustedPeerStore,
  },
  meshBind: {
    applyScope: async (scope) => {
      if (!meshBindController) {
        throw new Error("mesh bind controller is not ready");
      }
      return meshBindController.applyScope(scope);
    },
    getState: () => meshBindController?.getState() ?? {
      scope: advertiseScope,
      port,
      tlsAddresses: [],
      endpoints: [brokerUrl],
      brokerUrl,
      tlsSpkiFingerprint: null,
      mdnsAdvertising: false,
      hasNonLoopbackListener: false,
    },
  },
  forwardRouteAliasRequest: async ({ nodeSelector, path, method, body }) => {
    const matches = Object.values(runtime.snapshot().nodes).filter((candidate) =>
      candidate.id === nodeSelector || candidate.name === nodeSelector || candidate.hostName === nodeSelector
    );
    if (matches.length !== 1) {
      return {
        status: 400,
        body: {
          error: "ambiguous_alias_scope",
          detail: `host ${nodeSelector} is ${matches.length ? "ambiguous" : "unknown"}; use an exact node id`,
          candidates: matches.map((candidate) => candidate.id),
        },
      };
    }
    const authority = matches[0]!;
    if (authority.id === nodeId) return null;
    if (authority.meshId !== meshId) {
      return { status: 403, body: { error: "not_authorized", detail: "alias authority is outside the local owner realm" } };
    }
    if (!authority.brokerUrl) {
      return { status: 503, body: { error: "alias_target_unavailable", detail: `authoritative broker ${authority.id} is not reachable` } };
    }
    try {
      // Signed via the mesh peer client. Alias resolution is served to peers
      // at the remote tier (/v1/mesh/aliases/resolve, §4); other forwarded
      // paths (alias mutations, /v1/deliver) stay local-tier by design and
      // are unreachable to remote peers in enforce mode. Pre-trust-cone
      // peers lack the mesh route — fall back to the original path on 404.
      const peerPath = path === "/v1/aliases/resolve" ? "/v1/mesh/aliases/resolve" : path;
      const requestInit = {
        method,
        headers: {
          "content-type": "application/json",
          "x-openscout-mesh-id": meshId,
          "x-openscout-forwarded-node-id": nodeId,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      };
      let forwarded = await daemonMeshPeerFetch(authority.brokerUrl, peerPath, requestInit);
      if (forwarded.status === 404 && peerPath !== path) {
        forwarded = await daemonMeshPeerFetch(authority.brokerUrl, path, requestInit);
      }
      return {
        status: forwarded.status,
        body: await forwarded.json().catch(() => ({
          error: "alias_target_unavailable",
          detail: `authoritative broker ${authority.id} returned a non-JSON response`,
        })),
      };
    } catch (error) {
      return {
        status: 503,
        body: {
          error: "alias_target_unavailable",
          detail: `failed to forward alias request to ${authority.id}: ${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }
  },
  openRolesDb: openRolesControlPlaneDb,
});

let rolesControlPlaneDb: import("bun:sqlite").Database | null = null;
function openRolesControlPlaneDb() {
  if (sqliteDisabled) return null;
  try {
    if (!rolesControlPlaneDb) {
      const require = createRequire(import.meta.url);
      const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
      rolesControlPlaneDb = new Database(dbPath);
      rolesControlPlaneDb.exec("PRAGMA busy_timeout = 2500;");
      rolesControlPlaneDb.exec("PRAGMA journal_mode = WAL;");
    }
    return rolesControlPlaneDb as never;
  } catch {
    return null;
  }
}

function createBrokerHttpServer(): ReturnType<typeof createServer> {
  return createServer((request, response) => {
    // Mesh trust cone ingress gate: classifies the transport, and for remote
    // peers verifies the signed request before the router sees it (default
    // verify-warn: logs and allows). Local transports pass through untouched.
    meshIngressGate
      .gateHttpRequest(request, response, (gatedRequest) =>
        routeRequest(gatedRequest, response).catch((error) => {
          json(response, 500, {
            error: "internal_error",
            detail: error instanceof Error ? error.message : String(error),
          });
        }))
      .catch((error) => {
        json(response, 500, {
          error: "internal_error",
          detail: error instanceof Error ? error.message : String(error),
        });
      });
  });
}

const server = createBrokerHttpServer();
const socketServer = createBrokerHttpServer();
server.on("close", () => {
  unregisterActiveScoutBrokerService(brokerService);
});

// ─── tRPC over WebSocket — broker firehose endpoints ───────────────────────
// Mounted at /trpc. Tail and topology firehoses live here. Future endpoints
// (agent activity, control events) get added to broker-trpc-router.ts and
// consumers pick up the new procedures via end-to-end type inference.
//
// See docs/tail-firehose.md.

const wsRequire = createRequire(import.meta.url);
const { WebSocketServer } = wsRequire("ws") as typeof import("ws");

const trpcWss = new WebSocketServer({ noServer: true });

function handleBrokerUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): void {
  const url = new URL(request.url || "/", `http://${host}:${port}`);
  if (url.pathname === "/trpc") {
    // The WS upgrade bypasses the HTTP router, so the mesh gate runs here at
    // the server edge; on enforce-mode deny the gate answers and destroys the
    // socket itself.
    if (!meshIngressGate.gateUpgrade(request, socket)) {
      return;
    }
    trpcWss.handleUpgrade(request, socket, head, (ws) => {
      trpcWss.emit("connection", ws, request);
    });
    return;
  }
  socket.destroy();
}

server.on("upgrade", handleBrokerUpgrade);
socketServer.on("upgrade", handleBrokerUpgrade);

const trpcHandler = applyWSSHandler({
  wss: trpcWss,
  router: brokerRouter,
  createContext: () => ({}),
});

// Arm credential redaction (varlock .env.schema + declared credential env
// vars) and patch console.* before the broker emits any output. Best-effort:
// never throws, and the broker must boot even if varlock cannot load.
const secretRedaction = await bootstrapSecretRedaction({ patchConsole: true });
console.log(`[openscout-runtime] secret redaction armed (${secretRedaction.registered} value(s)${
  secretRedaction.schemaPath ? `, schema ${secretRedaction.schemaPath}` : ", no .env.schema found"
})`);

try {
  // Arm credential redaction (varlock .env.schema + declared credential env
  // vars) and patch console.* before the broker emits any output. Best-effort:
  // never throws, and the broker must boot even if varlock cannot load.
  const secretRedaction = await bootstrapSecretRedaction({ patchConsole: true });
  console.log(`[openscout-runtime] secret redaction armed (${secretRedaction.registered} value(s)${
    secretRedaction.schemaPath ? `, schema ${secretRedaction.schemaPath}` : ", no .env.schema found"
  })`);

  // §11.3: plaintext always on loopback; mesh TLS listeners are added by the
  // bind controller (never a 0.0.0.0 plaintext default).
  await listenTcp(server, { host: isLoopbackHost(host) || host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host, port });
  await listenUnixSocket(socketServer, brokerSocketPath);

  function handleBrokerHttp(
    request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse,
  ): void {
    meshIngressGate
      .gateHttpRequest(request, response, (gatedRequest) =>
        routeRequest(gatedRequest, response).catch((error) => {
          json(response, 500, {
            error: "internal_error",
            detail: error instanceof Error ? error.message : String(error),
          });
        }))
      .catch((error) => {
        json(response, 500, {
          error: "internal_error",
          detail: error instanceof Error ? error.message : String(error),
        });
      });
  }

  meshBindController = createMeshBindController({
    port,
    keyId: nodeIdentityKeyId,
    handleHttp: handleBrokerHttp,
    handleUpgrade: handleBrokerUpgrade,
    loopbackBrokerUrl: brokerControlUrl,
    supportDirectory,
    logger: console,
    onStateChange: async (state) => {
      advertiseScope = state.scope;
      brokerUrl = state.brokerUrl;
      const nextNode = {
        ...currentLocalNode(),
        advertiseScope: state.scope,
        brokerUrl: state.brokerUrl,
        lastSeenAt: Date.now(),
      };
      Object.assign(localNode, nextNode);
      await upsertNodeDurably(nextNode).catch((error) => {
        console.warn("[openscout-runtime] mesh bind: failed to update node registry:", error);
      });
      await writeHostInfo().catch((error) => {
        console.warn("[openscout-runtime] mesh bind: failed to write .host-info:", error);
      });
    },
  });
  await meshBindController.start(bootAdvertiseScope);
  // Refresh mutable advertise/url from the controller's actual state.
  {
    const state = meshBindController.getState();
    advertiseScope = state.scope;
    brokerUrl = state.brokerUrl;
    Object.assign(localNode, {
      advertiseScope: state.scope,
      brokerUrl: state.brokerUrl,
      lastSeenAt: Date.now(),
    });
    await upsertNodeDurably(localNode).catch(() => undefined);
  }

  await writeHostInfo().catch((error) => {
    console.warn("[openscout-runtime] failed to write .host-info:", error);
  });
  peerDelivery.start();
  const meshRendezvousConfig = resolveMeshRendezvousPublishConfig();
  if (meshRendezvousConfig) {
    meshRendezvousPublisher = startMeshRendezvousPublisher(currentRendezvousNode, {
      config: meshRendezvousConfig,
      logger: console,
    });
  }
  console.log(`[openscout-runtime] broker listening on 127.0.0.1:${port} (scope: ${advertiseScope}, url: ${brokerUrl})`);
  console.log(`[openscout-runtime] broker local socket ${brokerSocketPath}`);
  const bindState = meshBindController.getState();
  if (bindState.tlsAddresses.length > 0) {
    console.log(`[openscout-runtime] mesh TLS on ${bindState.tlsAddresses.map((a) => `https://${a}:${port}`).join(", ")}`);
  } else if (advertiseScope === "mesh") {
    console.warn(`[openscout-runtime] WARNING: mesh scope active but no non-loopback IPv4 (LAN/Tailscale) for TLS — peers cannot reach this broker until an interface is available.`);
  }
  console.log(`[openscout-runtime] node ${nodeId} in mesh ${meshId}`);
  console.log(`[openscout-runtime] mesh trust: keyId ${nodeIdentityKeyId} fingerprint ${nodeIdentityFingerprint} (gate: ${effectiveGateMode()})`);
  console.log(`[openscout-runtime] journal ${journalPath}`);
  console.log(`[openscout-runtime] sqlite ${sqliteDisabled ? "disabled" : dbPath}`);
} catch (error) {
  unregisterActiveScoutBrokerService(brokerService);
  await Promise.all([closeServer(socketServer), closeServer(server)]).catch(() => undefined);
  if (isAddressInUse(error)) {
    const existing = await probeExistingBroker();
    if (existing) {
      console.log(`[openscout-runtime] broker already running on ${brokerUrl}`);
      console.log(`[openscout-runtime] node ${existing.nodeId} in mesh ${existing.meshId ?? "unknown"}`);
      process.exit(0);
    }

    console.error(`[openscout-runtime] port ${port} is already in use by another process on ${host}`);
    process.exit(1);
  }

  throw error;
}

setTimeout(() => {
  bootstrapRegisteredLocalAgents()
    .then(() => dispatchRecoveryService.recoverQueuedFlights({ reason: "startup" }))
    .catch((error) => {
      console.error("[openscout-runtime] local agent bootstrap or dispatch recovery failed:", error);
    });
  reconcileStaleWorkingFlights().catch((error) => {
    console.error("[openscout-runtime] stale flight reconciliation failed:", error);
  });
  reconcileStaleLocalDeliveries().catch((error) => {
    console.error("[openscout-runtime] stale delivery reconciliation failed:", error);
  });
  sweepIdleCardlessSessions().catch((error) => {
    console.error("[openscout-runtime] initial cardless session sweep failed:", error);
  });
  relayAgentReaper.sweep("startup").catch((error) => {
    console.error("[openscout-runtime] startup relay-agent sweep failed:", error);
  });
  routeAliasService?.sweepExpired();
}, 0).unref();

// Heartbeat for relay-agent watchdogs: relays self-terminate once this file's
// mtime goes stale, so a dead runtime cannot leave live relay processes behind.
try {
  touchBrokerRuntimeHeartbeat();
} catch (error) {
  console.warn("[openscout-runtime] unable to write runtime heartbeat:", error);
}
setInterval(() => {
  try {
    touchBrokerRuntimeHeartbeat();
  } catch (error) {
    console.warn("[openscout-runtime] unable to refresh runtime heartbeat:", error);
  }
}, runtimeHeartbeatIntervalMs).unref();

meshDiscoveryService.discoverPeers().catch((error) => {
  console.error("[openscout-runtime] initial mesh discovery failed:", error);
});

if (Number.isFinite(discoveryIntervalMs) && discoveryIntervalMs > 0) {
  setInterval(() => {
    meshDiscoveryService.discoverPeers().catch((error) => {
      console.error("[openscout-runtime] periodic mesh discovery failed:", error);
    });
  }, discoveryIntervalMs).unref();
}

if (Number.isFinite(localAgentSyncIntervalMs) && localAgentSyncIntervalMs > 0) {
  setInterval(() => {
    syncRegisteredLocalAgentsIfChanged("periodic").catch((error) => {
      console.error("[openscout-runtime] periodic local agent sync failed:", error);
    });
  }, localAgentSyncIntervalMs).unref();
}

if (Number.isFinite(cardlessSessionSweepIntervalMs) && cardlessSessionSweepIntervalMs > 0) {
  setInterval(() => {
    sweepIdleCardlessSessions().catch((error) => {
      console.error("[openscout-runtime] periodic cardless session sweep failed:", error);
    });
  }, Math.max(60_000, cardlessSessionSweepIntervalMs)).unref();
}

if (Number.isFinite(relayAgentSweepIntervalMs) && relayAgentSweepIntervalMs > 0) {
  setInterval(() => {
    relayAgentReaper.sweep("periodic").catch((error) => {
      console.error("[openscout-runtime] periodic relay-agent sweep failed:", error);
    });
  }, Math.max(60_000, relayAgentSweepIntervalMs)).unref();
}

if (routeAliasService) {
  setInterval(() => {
    routeAliasService.sweepExpired();
  }, 60_000).unref();
}

async function shutdownBroker(exitCode = 0): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  if (parentWatcher) {
    clearInterval(parentWatcher);
    parentWatcher = null;
  }
  await webControl.stop();
  peerDelivery.stop();
  meshRendezvousPublisher?.stop();
  await meshBindController?.stop().catch(() => undefined);
  irohBridgeService?.stop();
  controlStreams.closeAll();
  trpcHandler.broadcastReconnectNotification();
  projection.close();
  trustedPeerStore?.close();
  routeAliasDatabase?.close?.();
  await Promise.all([closeServer(socketServer), closeServer(server)]);
  await unlink(brokerSocketPath).catch(() => undefined);
  await unlink(resolveOpenScoutSupportPaths().hostInfoPath).catch(() => undefined);
  process.exit(exitCode);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    shutdownBroker(0).catch((error) => {
      console.error("[openscout-runtime] shutdown failed:", error);
      process.exit(1);
    });
  });
}

if (Number.isFinite(parentPid) && parentPid > 0 && parentPid !== process.pid) {
  parentWatcher = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      console.log(`[openscout-runtime] parent ${parentPid} is gone, exiting broker`);
      shutdownBroker(0).catch((error) => {
        console.error("[openscout-runtime] shutdown failed:", error);
        process.exit(1);
      });
    }
  }, 2_000);
  parentWatcher.unref();
}
