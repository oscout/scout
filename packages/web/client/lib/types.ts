/* ── Shared types for the Scout web UI ── */
import type { SearchFilters } from "./knowledge-search.ts";
export type Agent = {
  id: string;
  definitionId: string;
  name: string;
  handle: string | null;
  agentClass: string;
  harness: string | null;
  state: string | null;
  projectRoot: string | null;
  cwd: string | null;
  updatedAt: number | null;
  createdAt: number | null;
  transport: string | null;
  selector: string | null;
  defaultSelector: string | null;
  nodeQualifier: string | null;
  workspaceQualifier: string | null;
  wakePolicy: string | null;
  capabilities: string[];
  project: string | null;
  branch: string | null;
  role: string | null;
  model: string | null;
  reasoningEffort?: string | null;
  harnessSessionId: string | null;
  terminalSurface: TerminalSurfaceDescriptor | null;
  harnessLogPath: string | null;
  conversationId: string | null;
  authorityNodeId?: string | null;
  authorityNodeName?: string | null;
  homeNodeId: string | null;
  homeNodeName: string | null;
  ownerId: string | null;
  ownerName: string | null;
  ownerHandle: string | null;
  staleLocalRegistration: boolean;
  retiredFromFleet: boolean;
  replacedByAgentId: string | null;
  providerName?: string | null;
  providerUrl?: string | null;
  protocol?: string | null;
  skills?: string[];
  brokerActivity?: AgentBrokerActivity[];
  authorityProfile?: AgentAuthorityProfile | null;
  runtimePolicy?: AgentRuntimePolicy | null;
};

export type AgentBrokerActivity = {
  id: string;
  kind: "message" | "invocation" | "flight";
  at: number;
  state: string | null;
  summary: string;
  conversationId: string | null;
};

export type AgentAuthorityProfile = {
  roleId: string;
  readTools: string[];
  writeTools: string[];
  shell: boolean;
  codebaseWrites: boolean;
};

export type AgentRuntimePolicy = {
  approvalPolicy: string | null;
  sandbox: string | null;
  shellTool: boolean | null;
};

export type TerminalSurfaceDescriptor = {
  backend: "tmux" | "zellij" | "herdr";
  sessionName: string;
  paneId: string | null;
  socketDir: string | null;
  /** Optional registry attach argv; preferred when rendering attach commands. */
  attachCommand?: string[] | null;
};

export type ObservedHarnessTopology = {
  schemaVersion: "openscout.observed-harness-topology.v1";
  ownership: "harness_observed";
  source: string;
  observedAt: string;
  groups: ObservedHarnessGroup[];
  agents: ObservedHarnessAgent[];
  tasks: ObservedHarnessTask[];
  relationships: ObservedHarnessRelationship[];
  sourceRefs?: ObservedHarnessSourceRef[];
  limitations?: string[];
};

export type ObservedHarnessSourceRef = {
  id: string;
  kind: "file" | "directory" | "event" | "provider";
  ref: string;
  label?: string;
};

export type ObservedHarnessGroup = {
  id: string;
  kind: string;
  name?: string;
  sourceRef?: string;
  providerMeta?: Record<string, unknown>;
};

export type ObservedHarnessAgent = {
  id: string;
  name?: string;
  role?: string;
  type?: string;
  status?: string;
  externalSessionId?: string;
  cwd?: string;
  model?: string;
  sourceRef?: string;
  providerMeta?: Record<string, unknown>;
};

export type ObservedHarnessTask = {
  id: string;
  title?: string;
  state?: string;
  assigneeId?: string;
  dependencyIds?: string[];
  sourceRef?: string;
  providerMeta?: Record<string, unknown>;
};

export type ObservedHarnessRelationship = {
  id: string;
  kind: string;
  fromId: string;
  toId: string;
  sourceRef?: string;
  providerMeta?: Record<string, unknown>;
};

export type HarnessTopologyObservation = {
  id: string;
  source: string;
  observedAt: string;
  changedAt: number;
  fingerprint: string;
  summary: {
    groups: number;
    agents: number;
    tasks: number;
    relationships: number;
  };
  topology: ObservedHarnessTopology;
};

export type HarnessTopologySnapshot = {
  generatedAt: number;
  observations: HarnessTopologyObservation[];
  totals: {
    sources: number;
    groups: number;
    agents: number;
    tasks: number;
    relationships: number;
  };
};

export type AgentConfigurationRuntime = {
  id: string;
  label: string;
  description: string;
  state: "ready" | "configured" | "installed" | "missing";
  detail: string;
  binaryPath: string | null;
  loginCommand: string | null;
  capabilities: string[];
  source: "builtin" | "local";
};

export type AgentConfigurationProvider = {
  id: string;
  name: string;
  protocol: "openai-compatible";
  status: "configured" | "missing";
  baseUrl: string;
  docsUrl: string;
  envKeys: string[];
  note: string;
};

export type AgentConfigurationAgent = {
  id: string;
  name: string;
  source: "broker";
  status: string;
  harness: string | null;
  transport: string | null;
  model: string | null;
  projectRoot: string | null;
  cwd: string | null;
  capabilities: string[];
  conversationId: string | null;
};

export type LocalAgentConfigState = {
  agentId: string;
  editable: boolean;
  model: string | null;
  permissionProfile: string | null;
  systemPrompt: string;
  runtime: {
    cwd: string;
    harness: string;
    transport: string;
    sessionId: string;
    wakePolicy: string;
  };
  launchArgs: string[];
  capabilities: string[];
  applyMode: "restart" | (string & {});
  templateHint: string;
};

export type AgentConfigurationProject = {
  id: string;
  title: string;
  root: string;
  source: string;
  registrationKind: string;
  defaultHarness: string;
  projectConfigPath: string | null;
};

export type AgentConfigurationIntegration = {
  id: string;
  name: string;
  status: "enabled" | "disabled" | "running" | "error";
  detail: string;
  source: "bridge" | "broker" | "system";
};

export type AgentConfigurationState = {
  generatedAt: number;
  context: {
    currentDirectory: string;
    workspaceRoots: string[];
    hiddenProjectCount: number;
    defaultHarness: string;
    defaultTransport: string;
    defaultCapabilities: string[];
    sessionPrefix: string;
  };
  broker: {
    label: string;
    reachable: boolean;
    healthy: boolean;
    nodeId: string | null;
    agentCount: number;
    messageCount: number;
    error: string | null;
  };
  runtimes: AgentConfigurationRuntime[];
  providers: AgentConfigurationProvider[];
  agents: AgentConfigurationAgent[];
  projects: AgentConfigurationProject[];
  integrations: AgentConfigurationIntegration[];
  toolContext: {
    mcpServerCount: number;
    note: string;
  };
  gaps: string[];
};

export type Message = {
  id: string;
  conversationId: string;
  actorId?: string | null;
  actorName: string;
  body: string;
  createdAt: number;
  class: string;
  attachments?: MessageAttachment[];
  metadata?: Record<string, unknown> | null;
  /** Originating message this one replies to (e.g. the ask a turn answers). */
  replyToMessageId?: string | null;
};

export type MessageAttachment = {
  id: string;
  mediaType: string;
  fileName?: string;
  blobKey?: string;
  url?: string;
  metadata?: Record<string, unknown> | null;
};

export type ActivityItem = {
  id: string;
  kind: string;
  ts: number;
  actorName: string | null;
  title: string | null;
  summary: string | null;
  conversationId: string | null;
  workspaceRoot: string | null;
  agentId: string | null;
  agentName: string | null;
  flightId: string | null;
  invocationId: string | null;
  sessionId: string | null;
  messageId: string | null;
  recordId: string | null;
};

export type BrokerRouteAttempt = {
  id: string;
  kind: "success" | "failed_query" | "failed_delivery" | "delivery_attempt";
  status: string;
  ts: number;
  actorName: string | null;
  target: string | null;
  route: string | null;
  detail: string;
  conversationId: string | null;
  messageId: string | null;
  deliveryId: string | null;
  invocationId: string | null;
  metadata?: Record<string, unknown> | null;
};

export type BrokerDialogueItem = {
  id: string;
  ts: number;
  actorName: string | null;
  conversationId: string;
  body: string;
  class: string;
};

export type BrokerHistoryKey = "attempts" | "failedQueries" | "failedDeliveries" | "dialogue";

export type BrokerDiagnosticsSource = {
  mode: "live_broker" | "sqlite_projection";
  status: "current" | "degraded" | "unknown";
  latestMessageAt: number | null;
  projectionLatestMessageAt: number | null;
  liveMessageCount: number | null;
  projectionMessageCount: number | null;
  detail: string | null;
};

export type BrokerDiagnostics = {
  generatedAt: number;
  windowMs: number;
  source?: BrokerDiagnosticsSource;
  ledger: {
    mode: "latest";
    limit: number;
    cursor: string | null;
    cursors: Record<BrokerHistoryKey, string | null>;
    hasMore: Record<BrokerHistoryKey, boolean>;
  };
  totals: {
    successfulDispatches: number;
    failedQueries: number;
    failedDeliveries: number;
    deliveryAttempts: number;
    failedDeliveryAttempts: number;
    dialogueMessages: number;
  };
  rates: {
    messagesPerHour: number;
    failedQueriesPerHour: number;
    failedDeliveriesPerHour: number;
    failureRate: number;
  };
  attempts: BrokerRouteAttempt[];
  failedQueries: BrokerRouteAttempt[];
  failedDeliveries: BrokerRouteAttempt[];
  dialogue: BrokerDialogueItem[];
};

export type FleetActivity = ActivityItem & {
  actorId: string | null;
  agentId: string | null;
  flightId: string | null;
  invocationId: string | null;
  messageId: string | null;
  recordId: string | null;
  sessionId: string | null;
};

export type FleetAsk = {
  invocationId: string;
  flightId: string | null;
  agentId: string;
  agentName: string | null;
  conversationId: string | null;
  collaborationRecordId: string | null;
  task: string;
  status: "queued" | "working" | "needs_attention" | "completed" | "failed";
  statusLabel: string;
  acknowledgedAt: number | null;
  attention: "silent" | "badge" | "interrupt";
  agentState: "offline" | "available" | "in_flight" | "working";
  harness: string | null;
  transport: string | null;
  summary: string | null;
  startedAt: number | null;
  completedAt: number | null;
  updatedAt: number;
};

export type FleetAttentionItem = {
  kind: "work_item" | "question";
  recordId: string;
  title: string;
  summary: string | null;
  agentId: string | null;
  agentName: string | null;
  conversationId: string | null;
  state: string;
  acceptanceState: string;
  updatedAt: number;
};

export type FleetState = {
  generatedAt: number;
  totals: {
    active: number;
    recentCompleted: number;
    needsAttention: number;
    activity: number;
  };
  activeAsks: FleetAsk[];
  recentCompleted: FleetAsk[];
  needsAttention: FleetAttentionItem[];
  activity: FleetActivity[];
};

export type PairingSnapshot = {
  qrValue?: string | null;
  expiresAt?: number;
  relay?: string | null;
} | null;

export type TrustedPeer = {
  fingerprint: string;
  name: string | null;
  pairedAtLabel: string;
  lastSeenLabel: string;
};

export type PairingState = {
  status: string;
  statusLabel: string;
  statusDetail: string | null;
  isRunning: boolean;
  commandLabel: string;
  pairing: PairingSnapshot;
  lastUpdatedLabel: string | null;
  relay: string | null;
  secure: boolean;
  identityFingerprint: string | null;
  connectedPeerFingerprint: string | null;
  trustedPeerCount: number;
  trustedPeers: TrustedPeer[];
  pendingApprovals: PairingApprovalRequest[];
};

export type PairingApprovalRequest = {
  sessionId: string;
  sessionName: string;
  adapterType: string;
  turnId: string;
  blockId: string;
  version: number;
  risk: "low" | "medium" | "high";
  title: string;
  description: string;
  detail: string | null;
  actionKind: "command" | "file_change" | "tool_call" | "subagent";
  actionStatus: string;
};

export type OperatorAttentionKind = "approval" | "configuration" | "ask" | "work_item" | "question" | "session";
export type OperatorAttentionActionKind = "approve" | "deny" | "open" | "configure" | "copy" | "dismiss";

export type OperatorAttentionAction = {
  kind: OperatorAttentionActionKind;
  label: string;
  route?: Route;
  value?: string;
  recordId?: string;
  recordKind?: "work_item" | "question";
  flightId?: string;
};

export type OperatorAttentionItem = {
  id: string;
  kind: OperatorAttentionKind;
  title: string;
  summary: string | null;
  detail: string | null;
  agentId: string | null;
  agentName: string | null;
  conversationId: string | null;
  updatedAt: number;
  severity: "critical" | "warning" | "info";
  sourceLabel: string;
  approval?: PairingApprovalRequest;
  actions: OperatorAttentionAction[];
};

export type OperatorAttentionState = {
  generatedAt: number;
  totals: {
    all: number;
    approvals: number;
    configuration: number;
    collaboration: number;
  };
  items: OperatorAttentionItem[];
};

export type AgentRunState =
  | "queued"
  | "waking"
  | "running"
  | "waiting"
  | "review"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown"
  | (string & {});

export type AgentRunSource =
  | "ask"
  | "message"
  | "schedule"
  | "recipe"
  | "external_issue"
  | "manual"
  | "eval"
  | "unknown"
  | (string & {});

export type AgentRunReviewState =
  | "none"
  | "needed"
  | "blocked"
  | "approved"
  | "rejected"
  | (string & {});

export type AgentRunMetrics = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimatedUsd?: number;
  wallClockMs?: number;
  toolCallCount?: number;
  retryCount?: number;
};

export type AgentRun = {
  id: string;
  source: AgentRunSource;
  requesterId?: string;
  agentId: string;
  agentName?: string | null;
  agentRevisionId?: string;
  agentRevisionSnapshot?: Record<string, unknown> | null;
  aliasId?: string;
  workId?: string | null;
  collaborationRecordId?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
  invocationId?: string | null;
  flightIds?: string[];
  parentRunId?: string | null;
  rootRunId?: string | null;
  recipeId?: string | null;
  attempt?: number;
  idempotencyKey?: string;
  state: AgentRunState;
  reviewState?: AgentRunReviewState;
  terminalReason?: string | null;
  input?: Record<string, unknown> | null;
  output?: Record<string, unknown> | null;
  artifactIds?: string[];
  reviewTaskIds?: string[];
  traceSessionIds?: string[];
  createdAt?: number;
  startedAt?: number | null;
  updatedAt: number;
  completedAt?: number | null;
  harness?: string | null;
  model?: string | null;
  permissionProfile?: string | null;
  metrics?: AgentRunMetrics;
  metadata?: Record<string, unknown> | null;
};

export type RunItem = AgentRun;

export type RunsResponse =
  | RunItem[]
  | {
      generatedAt?: number;
      runs: RunItem[];
      totals?: Record<string, number | undefined>;
    };

export type Flight = {
  id: string;
  invocationId: string;
  messageId?: string | null;
  agentId: string;
  agentName: string | null;
  conversationId: string | null;
  collaborationRecordId: string | null;
  state: string;
  summary: string | null;
  startedAt: number | null;
  completedAt: number | null;
  sessions: FlightSessionTrace[];
  dispatchOutcome?: {
    status: string;
    reason: string | null;
    checkedAt: number | null;
  } | null;
};

export type FlightSessionTrace = {
  sessionId: string;
  endpointId?: string;
  nodeId?: string;
  harness?: string;
  transport?: string;
  strategy?: string;
  startedAt: number;
  lastAcknowledgedAt: number;
  endedAt?: number;
};

export type WorkInvocation = {
  invocationId: string;
  flightId: string | null;
  action: string;
  task: string;
  source: string | null;
  requestedHarness: string | null;
  requestedModel: string | null;
  requestedReasoningEffort: string | null;
  requestedPermissionProfile: string | null;
  targetSessionId: string | null;
  requesterId: string | null;
  requesterName: string | null;
  targetAgentId: string | null;
  targetAgentName: string | null;
  resolvedHarness: string | null;
  resolvedModel: string | null;
  resolvedReasoningEffort: string | null;
  observedHarness: string | null;
  observedModel: string | null;
  observedReasoningEffort: string | null;
  resolvedTransport: string | null;
  resolvedSessionId: string | null;
  conversationId: string | null;
  workId: string | null;
  state: string | null;
  summary: string | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
};

export type WorkItem = {
  id: string;
  title: string;
  summary: string | null;
  ownerId: string | null;
  ownerName: string | null;
  nextMoveOwnerId: string | null;
  nextMoveOwnerName: string | null;
  conversationId: string | null;
  createdAt: number;
  updatedAt: number;
  parentId: string | null;
  parentTitle: string | null;
  state: string;
  acceptanceState: string;
  priority: string | null;
  currentPhase: string;
  attention: "silent" | "badge" | "interrupt";
  activeChildWorkCount: number;
  activeFlightCount: number;
  lastMeaningfulAt: number;
  lastMeaningfulSummary: string | null;
};

/** An inbox row: agent + conversation summary merged. */
export type InboxEntry = {
  agent: Agent;
  conversationId: string;
  preview: string | null;
  previewActor: string | null;
  messageCount: number;
  lastMessageAt: number | null;
};

/** A conversation from the sessions list (any kind, not just DMs). */
export type SessionEntry = {
  id: string;
  /** Broker conversation ids coalesced into this canonical Chat. */
  equivalentConversationIds?: string[];
  kind: string;
  title: string;
  alias?: string | null;
  naturalKey?: string | null;
  participantIds: string[];
  participants?: Array<{
    actorId: string;
    kind?: string | null;
    displayName: string;
    label: string;
    scopedAlias?: string | null;
    agentId?: string | null;
    sessionId?: string | null;
    harness?: string | null;
    transport?: string | null;
    workspaceRoot?: string | null;
  }>;
  authorityNodeId?: string | null;
  authorityNodeName?: string | null;
  agentId: string | null;
  agentName: string | null;
  harness: string | null;
  /** Broker-owned session identity for a session-backed conversation. */
  sessionId?: string | null;
  harnessSessionId: string | null;
  harnessLogPath: string | null;
  currentBranch: string | null;
  preview: string | null;
  messageCount: number;
  lastMessageAt: number | null;
  workspaceRoot: string | null;
};

export type ConversationEntry = SessionEntry;

export type ObserveEvent = {
  id: string;
  t: number;
  /** Wall-clock epoch ms when known (preferred for horizon filtering and lane age labels). */
  at?: number;
  kind: "think" | "tool" | "ask" | "message" | "note" | "system" | "boot";
  text: string;
  tool?: string;
  arg?: string;
  diff?: { add: number; del: number; preview: string };
  result?: Record<string, string | number>;
  stream?: string[];
  live?: boolean;
  to?: string;
  answer?: string;
  answerT?: number;
  detail?: string;
};

export type ObserveFile = {
  path: string;
  state: "read" | "created" | "modified";
  touches: number;
  lastT: number;
};

export type ObserveUsageMeta = {
  assistantMessages?: number;
  inputTokens?: number;
  contextInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  totalTokens?: number;
  contextWindowTokens?: number;
  webSearchRequests?: number;
  webFetchRequests?: number;
  serviceTier?: string;
  speed?: string;
  planType?: string;
};

export type ObserveSessionMeta = {
  adapterType?: string;
  model?: string;
  cwd?: string;
  sessionStart?: number;
  turnCount?: number;
  externalSessionId?: string;
  threadId?: string;
  threadPath?: string;
  gitBranch?: string;
  cliVersion?: string;
  entrypoint?: string;
  originator?: string;
  source?: string;
  permissionMode?: string;
  approvalPolicy?: string;
  sandbox?: string;
  userType?: string;
  effort?: string;
  modelProvider?: string;
  timezone?: string;
};

export type ObserveMetadata = {
  session?: ObserveSessionMeta;
  usage?: ObserveUsageMeta;
  topology?: ObservedHarnessTopology;
};

/**
 * Recent-activity histogram for the home sparkline (mirrors the server
 * `ObservePulse`). Event density over a trailing window; absent when no event
 * has a resolvable wall-clock time.
 */
export type ObservePulse = {
  /** Width of each bucket in ms. */
  bucketMs: number;
  /** Right edge (exclusive) of the last bucket — the window's "now". */
  endMs: number;
  /** Event count per bucket, oldest → newest; length === bucket count. */
  counts: number[];
};

export type ObserveData = {
  events: ObserveEvent[];
  files: ObserveFile[];
  contextUsage?: number[];
  pulse?: ObservePulse;
  live?: boolean;
  metadata?: ObserveMetadata;
};

export type AgentObservePayload = {
  agentId: string;
  source: "history" | "live" | "unavailable";
  fidelity: "timestamped" | "synthetic";
  historyPath: string | null;
  sessionId: string | null;
  updatedAt: number;
  initiatingAsk?: {
    task: string;
    requesterId: string;
    requesterName: string;
    requestedAt: number;
    invocationId: string;
    flightId: string;
    conversationId: string | null;
    messageId: string | null;
  } | null;
  data: ObserveData;
};

export type TmuxPeekPayload = {
  available: boolean;
  agentId: string;
  sessionId: string | null;
  capturedAt: number;
  body: string;
  lineCount: number;
  columnCount: number;
  truncated: boolean;
  reason: string | null;
};

export type SessionCatalogEntry = {
  id: string;
  startedAt: number;
  endedAt?: number;
  cwd: string;
  harness?: string;
  transport?: string;
  model?: string | null;
  reasoningEffort?: string | null;
  provider?: string | null;
  source?: string;
  historyPath?: string;
  surfaceSessionId?: string | null;
  harnessSessionId?: string | null;
  externalSessionId?: string | null;
  threadId?: string | null;
  runtimeSessionId?: string | null;
  canObserve?: boolean;
  canTakeover?: boolean;
};

export type SessionCatalog = {
  activeSessionId: string | null;
  sessions: SessionCatalogEntry[];
};

export type SessionCatalogWithResume = SessionCatalog & {
  agentId: string;
  harness: string | null;
  resumeCommand: string | null;
  resumeCwd: string | null;
};

export type LocalAgentContextState = {
  agentId: string;
  state: "fresh" | "aging" | "stale";
  reason: string | null;
  generatedAt: number;
  activeSessionId: string | null;
  sessionStartedAt: number | null;
  sessionAgeMs: number | null;
  turnCount: number;
  currentTurnActive: boolean;
  contextWindow: {
    contextInputTokens: number | null;
    totalTokens: number | null;
    contextWindowTokens: number | null;
    usedPercent: number | null;
  } | null;
  canAutoReset: boolean;
  policy: {
    maxTurns: number;
    maxAgeMs: number;
    agingRatio: number;
  };
  model: string | null;
  harness: string;
  transport: string;
};

export type InterruptThreshold = "always" | "blocking-only" | "batched" | "never";
export type CommsChannel = "here" | "mobile" | "here+mobile";
export type CommsVerbosity = "terse" | "normal" | "detailed";
export type CommsTone = "direct" | "warm" | "formal";
export type ProvisionalAgentNamesMode = "replace" | "extend";
export type ProvisionalAgentNamePoolSource =
  | "default"
  | "user-settings-replace"
  | "user-settings-extend"
  | "env-file"
  | "user-config-file"
  | "home-json";

export type OperatorProfile = {
  name: string;
  handle: string;
  pronouns: string;
  hue: number;
  bio: string;
  timezone: string;
  workingHours: string;
  interruptThreshold: InterruptThreshold;
  batchWindow: number;
  channel: CommsChannel;
  verbosity: CommsVerbosity;
  tone: CommsTone;
  quietHours: string;
  provisionalAgentNames: string[];
  provisionalAgentNamesMode: ProvisionalAgentNamesMode;
  provisionalAgentNamesResolvedCount: number;
  provisionalAgentNamesPreview: string[];
  provisionalAgentNamesSource: ProvisionalAgentNamePoolSource;
};

/** Mesh status report from the broker. */
export type MeshIssue = {
  code:
    | "broker_unreachable"
    | "tailscale_stopped"
    | "local_only"
    | "mesh_loopback"
    | "discovery_unconfigured";
  severity: "warning" | "error";
  title: string;
  summary: string;
  action: string | null;
  actionCommand: string | null;
};

export type MeshStatus = {
  brokerUrl: string;
  health: {
    reachable: boolean;
    ok: boolean;
    nodeId: string | null;
    meshId: string | null;
    build?: {
      packageName: string;
      version: string | null;
      commit?: string | null;
      branch?: string | null;
      buildId?: string | null;
      buildNumber?: string | null;
      mode?: "dev" | "production";
    } | null;
    error: string | null;
  };
  localNode: {
    id: string;
    name: string;
    meshId?: string;
    hostName?: string;
    advertiseScope?: string;
    brokerUrl?: string;
  } | null;
  meshId: string | null;
  identity: {
    name: string | null;
    nodeId: string | null;
    meshId: string | null;
    modeLabel: string;
    discoverable: boolean;
    announceUrl: string | null;
    discoveryDetail: string;
  };
  nodes: Record<
    string,
    {
      id: string;
      name: string;
      meshId?: string;
      hostName?: string;
      advertiseScope?: string;
      brokerUrl?: string;
      registeredAt?: number;
      lastSeenAt?: number;
      /**
       * High-level host facts a node announces to the mesh. All fields optional
       * so the UI can render placeholders before the broker fills them in.
       */
      host?: {
        scoutVersion?: string;
        os?: string;
        arch?: string;
        cpuCores?: number;
        memoryGb?: number;
        storageCapacityGb?: number;
        network?: string;
      };
    }
  >;
  tailscale: {
    available: boolean;
    running: boolean;
    backendState: string | null;
    health: string[];
    onlineCount: number;
    peers: Array<{
      id: string;
      name: string;
      dnsName?: string;
      hostName?: string;
      addresses: string[];
      online: boolean;
      os?: string;
    }>;
  };
  issues: MeshIssue[];
  warnings: string[];
};

export type WorkTimelineKind =
  | "collaboration_event"
  | "flight_started"
  | "flight_completed"
  | "message";

export type WorkTimelineItem = {
  id: string;
  kind: WorkTimelineKind;
  at: number;
  actorId: string | null;
  actorName: string | null;
  title: string | null;
  summary: string | null;
  detailKind: string | null;
  flightId: string | null;
  messageId: string | null;
  conversationId: string | null;
};

export type WorkInventoryMode =
  | "isolated-git-worktree"
  | "shared-git-repo"
  | "trace-only"
  | "explicit-artifacts";

export type WorkInventorySource = "broker" | "git" | "trace" | "mixed";
export type WorkInventoryConfidence = "high" | "medium" | "low";

export type WorkMaterialKind =
  | "plan"
  | "spec"
  | "doc"
  | "code"
  | "test"
  | "config"
  | "asset"
  | "other";

export type WorkMaterialStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "untracked"
  | "observed";

export type WorkMaterialEvidence =
  | "broker"
  | "git-status"
  | "git-diff"
  | "trace-read"
  | "trace-write"
  | "trace-edit"
  | "trace-command"
  | "inferred-path";

export type WorkInventoryAgentRef = {
  id: string;
  name: string | null;
  role: "owner" | "next-move" | "runner" | "session" | "observed-helper";
  harness: string | null;
  cwd: string | null;
  projectRoot: string | null;
  sessionId: string | null;
  source: "broker" | "run" | "session" | "observe-topology";
};

export type WorkInventorySessionRef = {
  id: string;
  conversationId: string | null;
  agentId: string | null;
  agentName: string | null;
  harness: string | null;
  cwd: string | null;
  source: "conversation" | "run-trace" | "observe";
};

export type WorkMaterial = {
  id: string;
  kind: WorkMaterialKind;
  path: string;
  status: WorkMaterialStatus;
  agentId: string | null;
  sessionId: string | null;
  worktreeRoot: string | null;
  scopePath: string | null;
  baseRef: string | null;
  headRef: string | null;
  diffStat: { additions: number; deletions: number } | null;
  evidence: WorkMaterialEvidence[];
  confidence: WorkInventoryConfidence;
};

export type WorkMaterialsInventory = {
  workId: string;
  generatedAt: number;
  mode: WorkInventoryMode;
  source: WorkInventorySource;
  confidence: WorkInventoryConfidence;
  agents: WorkInventoryAgentRef[];
  sessions: WorkInventorySessionRef[];
  materials: WorkMaterial[];
  totals: {
    materials: number;
    plans: number;
    specs: number;
    docs: number;
    code: number;
    tests: number;
    config: number;
    assets: number;
    agents: number;
    sessions: number;
  };
  limitations: string[];
};

export type WorkMaterialContent = {
  workId: string;
  materialId: string;
  path: string;
  title: string;
  uri: string;
  mediaType: string;
  content: string;
  sizeBytes: number;
  truncated: boolean;
  generatedAt: number;
};

export type WorkDetail = WorkItem & {
  createdAt: number;
  updatedAt: number;
  parentId: string | null;
  parentTitle: string | null;
  childWork: WorkItem[];
  activeFlights: Flight[];
  timeline: WorkTimelineItem[];
  primaryInvocation: WorkInvocation | null;
  allFlights: Flight[];
  inventory?: WorkMaterialsInventory;
};

/* ── Mesh Ops (`GET /api/mesh-ops`) ── */

export type MeshOpsAttention = "interrupt" | "badge" | "silent";

/** The item's most recent execution attempt — flights are activity, not the grain. */
export type WebMeshOpsFlight = {
  id: string;
  state: string;
  summary: string | null;
  startedAt: number | null;
  completedAt: number | null;
};

/**
 * Mesh Ops row — a work item projected across the mesh with its venue host
 * and latest flight. Nullability mirrors WorkItem/WorkDetail.
 */
export type WebMeshOpsItem = {
  id: string;
  kind: "work" | "session";
  title: string;
  summary: string | null;
  state: string;
  acceptanceState: string;
  priority: string | null;
  labels: string[];
  ownerId: string | null;
  ownerName: string | null;
  nextMoveOwnerId: string | null;
  updatedAt: number;
  createdAt: number;
  hostNodeId: string | null;
  hostLabel: string | null;
  projectRoot: string | null;
  latestFlight: WebMeshOpsFlight | null;
  activeFlightCount: number;
  currentPhase: string | null;
  lastMeaningfulAt: number | null;
  lastMeaningfulSummary: string | null;
  attention: MeshOpsAttention;
  /** Present when the item waits on someone/something (e.g. "Held by operator"). */
  waitingOn?: { kind?: string; label: string } | null;
  /** Session rows only: the observed runtime detail behind the row. */
  session?: {
    harness: string;
    state: string;
    live: boolean;
    alias: string | null;
    agentLabel: string;
    cwd: string | null;
    startedAt: number | null;
    lastSeenAt: number;
    endedAt: number | null;
    /** Broker delivery machinery (ephemeral `session-*` agents), not a named agent. */
    relay: boolean;
  } | null;
};

/**
 * A mesh host (broker `nodes` row) with a runtime-session rollup, so the
 * board can show every known machine — including ones with no current work.
 */
export type WebMeshOpsHost = {
  nodeId: string;
  /** Short display name (host_name first label, else the node name). */
  label: string;
  hostName: string | null;
  brokerUrl: string | null;
  tailnetName: string | null;
  lastSeenAt: number | null;
  registeredAt: number | null;
  /** Sessions in the mesh-ops lookback window on this host. */
  sessionCount: number;
  liveSessionCount: number;
  lastActivityAt: number | null;
};

export type MeshOpsResponse = {
  generatedAt: string;
  items: WebMeshOpsItem[];
  hosts: WebMeshOpsHost[];
};

export type PlanDocumentSource =
  | "claude"
  | "codex"
  | "openscout"
  | "workspace"
  | "unknown";

export type PlanDocumentKind =
  | "claude_plan"
  | "codex_plan"
  | "openscout_plan"
  | "markdown_plan";

export type PlanDocumentStatus =
  | "draft"
  | "active"
  | "blocked"
  | "completed"
  | "archived"
  | "unknown";

export type PlanDocumentStepStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "blocked"
  | "unknown";

export type PlanDocumentStep = {
  id: string;
  order: number;
  text: string;
  status: PlanDocumentStepStatus;
  rawMarker: string | null;
};

export type PlanDocument = {
  id: string;
  title: string;
  summary: string | null;
  source: PlanDocumentSource;
  documentKind: PlanDocumentKind;
  status: PlanDocumentStatus;
  confidence: "native" | "explicit" | "inferred";
  path: string;
  workspacePath: string | null;
  workspaceName: string | null;
  agentId: string | null;
  agentName: string | null;
  tags: string[];
  body: string;
  rawText: string;
  steps: PlanDocumentStep[];
  createdAt: number;
  updatedAt: number;
  provenance: {
    root: string;
    rootKind: "workspace" | "home";
    relativePath: string;
  };
};

export type PlanDocumentsResponse = {
  generatedAt: number;
  roots: Array<{
    path: string;
    kind: "workspace" | "home";
    label: string;
  }>;
  documents: PlanDocument[];
  totals: {
    documents: number;
    claude: number;
    codex: number;
    openscout: number;
    workspace: number;
  };
};

export type DispatchFilter = "all" | "delivered" | "failed";
export type MessagesSort = "recent" | "name" | "unread";
export type SearchMode = "knowledge" | "indexer";
export type ProjectSet = "live" | "ephemeral" | "archived";
export type ProjectsIndexView = "agents" | "sessions";
export type ProjectStateFilter = "needs" | "live" | "idle";
export type MachineScopedRoute = {
  machineId?: string;
};

export type Route =
  | ({ view: "inbox" } & MachineScopedRoute)
  | ({
      view: "conversation";
      conversationId: string;
      composeDraft?: string;
    } & MachineScopedRoute)
  | { view: "agent-info"; conversationId: string }
  | ({
      view: "agents-v2";
      /** Path engagement — opens the full profile in the center pane. */
      agentId?: string;
      /** Index selection — inspector peek on the right without leaving the registry. */
      selectedAgentId?: string;
      sessionId?: string;
      conversationId?: string;
      tab?: AgentTab;
      projectSlug?: string;
      harness?: string;
      node?: string;
      set?: ProjectSet;
      indexView?: ProjectsIndexView;
      stateFilter?: ProjectStateFilter;
      showEphemeral?: boolean;
    } & MachineScopedRoute)
  | ({
      view: "messages";
      conversationId?: string;
    } & MachineScopedRoute)
  | ({
      view: "sessions";
      sessionId?: string;
      agentId?: string;
      flightId?: string;
      compareSessionId?: string;
    } & MachineScopedRoute)
  // `root` pre-selects a project by absolute root — used when drilling in from
  // a project surface ("Worktrees" facet) so the repos view keeps the caller's
  // scope. Deep-linkable as /repos?root=<abs>.
  | ({ view: "repos"; root?: string } & MachineScopedRoute)
  | ({ view: "harnesses" } & MachineScopedRoute)
  // A diff path is absolute + machine-local, so this is intentionally not
  // machine-scoped. Reached by drilling in / "open as page" from the Repos
  // diff panel; deep-linkable as /repo-diff?path=<abs>&layer=…
  | {
      view: "repo-diff";
      path: string;
      layers?: ("unstaged" | "staged" | "branch")[];
      files?: string[];
      sessionId?: string;
      agentId?: string;
      include?: "changed" | "all";
    }
  | { view: "search"; mode?: SearchMode; hitId?: string; filters?: SearchFilters }
  | ({ view: "mesh" } & MachineScopedRoute)
  // Mesh Ops — flagged work-item triage over the mesh; itemId deep-links a row.
  | ({ view: "mesh-ops"; itemId?: string } & MachineScopedRoute)
  | { view: "broker"; attemptId?: string; filter?: DispatchFilter }
  | {
      view: "code";
      root?: string;
      file?: string;
      project?: string;
      path?: string;
      wt?: string;
      line?: number;
      endLine?: number;
      /** Conversation that handed this file into Code, for an exact return path. */
      returnConversationId?: string;
    }
  | { view: "briefings"; briefingId?: string }
  | ({ view: "activity" } & MachineScopedRoute)
  | { view: "voice" }
  | ({ view: "work"; workId: string } & MachineScopedRoute)
  | {
      view: "settings";
      section?: SettingsSection;
      agentId?: string;
    }
  | {
      view: "ops";
      mode?: OpsMode;
      tailQuery?: string;
      planDocumentId?: string;
      flightId?: string;
      invocationId?: string;
      conversationId?: string;
      workId?: string;
      sessionId?: string;
      targetAgentId?: string;
    }
  | ({
      view: "follow";
      preferredView?: FollowPreferredView;
      flightId?: string;
      invocationId?: string;
      conversationId?: string;
      workId?: string;
      sessionId?: string;
      targetAgentId?: string;
    } & MachineScopedRoute)
	  | {
	      view: "terminal";
	      agentId?: string;
	      mode?: "observe" | "takeover";
	      terminalSessionId?: string;
	      terminalSurfaceKey?: string;
	      terminalBackend?: "pty" | "tmux" | "zellij" | "herdr";
	      terminalAgent?: "shell" | "claude" | "codex" | "pi";
	      terminalSessionName?: string;
	      terminalTabId?: string;
	      zellijSocketDir?: string;
	    };

export type AgentTab = "profile" | "config" | "observe" | "message";
export type OpsMode = "plan" | "mission" | "issues" | "agents" | "tail" | "atop" | "lanes";
export type FollowPreferredView = "tail" | "session" | "chat" | "work";
/** URL-addressable settings surface sections (SCO-082 Phase B). */
export type SettingsSection =
  | "pairing"
  | "agents"
  | "appearance"
  | "operator"
  | "comms"
  | "credentials"
  | "voice"
  | "devices"
  | "about";

export type FollowTarget = {
  flightId: string | null;
  invocationId: string | null;
  conversationId: string | null;
  workId: string | null;
  sessionId: string | null;
  targetAgentId: string | null;
};

/* ── Tail (Ops > Tail) types ── */

/**
 * Launch attribution for a tailed transcript. The runtime/harness name shown
 * in the UI is `source` ("claude", "codex", "quad", ...).
 */
export type TailAttribution = "scout-managed" | "hudson-managed" | "unattributed";

/** @deprecated Use TailAttribution for the `harness` field. */
export type TailHarness = TailAttribution;
export type TailEventKind =
  | "user"
  | "assistant"
  | "tool"
  | "tool-result"
  | "system"
  | "other";

export type TailEvent = {
  id: string;
  ts: number;
  /** Runtime harness/source name, e.g. "claude", "codex", "quad". */
  source: string;
  sessionId: string;
  pid: number;
  parentPid: number | null;
  project: string;
  cwd: string;
  /** Launch attribution; retained as `harness` for wire compatibility. */
  harness: TailHarness;
  kind: TailEventKind;
  summary: string;
  raw?: unknown;
};

export type TailDiscoveredProcess = {
  pid: number;
  ppid: number;
  command: string;
  etime: string;
  cwd: string | null;
  /** Launch attribution; retained as `harness` for wire compatibility. */
  harness: TailHarness;
  parentChain: { pid: number; command: string }[];
  /** Runtime harness/source name, e.g. "claude", "codex", "quad". */
  source: string;
};

export type TailDiscoveredTranscript = {
  source: string;
  transcriptPath: string;
  sessionId: string | null;
  /** The Claude Code session which spawned this transcript, when it is a child worker. */
  parentSessionId?: string | null;
  /** Harness-owned child worker id (for example Claude's `agent-*.jsonl` id). */
  subagentId?: string | null;
  cwd: string | null;
  project: string;
  /** Launch attribution; retained as `harness` for wire compatibility. */
  harness: TailHarness;
  /** Timestamp of the latest parseable transcript event, when available. */
  lastEventAt?: number | null;
  mtimeMs: number;
  size: number;
};

export type TailDiscoveryIssueKind = "transcript_path_collision";

export type TailDiscoveryIssue = {
  kind: TailDiscoveryIssueKind;
  sessionKey: string;
  message: string;
  transcriptPaths: string[];
};

export type TailDiscoverySnapshot = {
  generatedAt: number;
  processes: TailDiscoveredProcess[];
  transcripts?: TailDiscoveredTranscript[];
  issues?: TailDiscoveryIssue[];
  totals: {
    total: number;
    scoutManaged: number;
    hudsonManaged: number;
    unattributed: number;
    transcripts?: number;
  };
};

/* ── Broadcast (fleet ticker) types ── */

export type BroadcastTier = "info" | "warn" | "error";

export type Broadcast = {
  id: string;
  tier: BroadcastTier;
  text: string;
  agent?: string;
  project?: string;
  ts: number;
  ruleId: string;
  key: string;
};

/* ── Ops types (Plan view) ── */

export type MissionBrief = {
  title: string;
  goal: string;
  rationale: string;
  deadline: string;
  confidence: number;
  lastReproposedMinsAgo: number;
};

export type MissionNodeKind = "mission" | "phase" | "task";
export type MissionNodeState =
  | "proposed"
  | "committed"
  | "inflight"
  | "done"
  | "stuck";

export type MissionTreeNode = {
  id: string;
  kind: MissionNodeKind;
  title: string;
  why?: string;
  state: MissionNodeState;
  assignee?: string;
  confidence?: number;
  progress?: number;
  detail?: string;
  stuckMins?: number;
  children?: MissionTreeNode[];
};

export type PlanChange = {
  id: string;
  kind: "split" | "demote" | "promote" | "unassign" | "add";
  summary: string;
  why: string;
  status: "pending" | "accepted";
  minsAgo: number;
};

export type PlanRisk = {
  id: string;
  title: string;
  detail: string;
  severity: "high" | "med" | "low";
};

export type ToolTickerItem = {
  agent: string;
  tool: string;
  result: string;
};
