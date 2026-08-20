import type { ScoutHostSurface, ScoutSurfaceCapabilities } from "../../shared/surface-capabilities.ts";

export type { ScoutHostSurface, ScoutSurfaceCapabilities } from "../../shared/surface-capabilities.ts";

export type ScoutDesktopFeatureFlags = {
  enableAll: boolean;
  overview: boolean;
  inbox: boolean;
  relay: boolean;
  pairing: boolean;
  interAgent: boolean;
  agents: boolean;
  settings: boolean;
  logs: boolean;
  activity: boolean;
  machines: boolean;
  plans: boolean;
  sessions: boolean;
  search: boolean;
  telegram: boolean;
  voice: boolean;
  monitor: boolean;
  phonePreparation: boolean;
};

export type ScoutDesktopAppInfo = {
  productName: string;
  appVersion: string;
  isPackaged: boolean;
  platform: string;
  /** Which distribution is serving this shell (desktop host, browser web server, CLI context). */
  surface: ScoutHostSurface;
  /** What this host is allowed to do; UI should gate native / provisioning actions on these flags. */
  capabilities: ScoutSurfaceCapabilities;
  features: ScoutDesktopFeatureFlags;
};

export type ScoutDesktopLoadStep = {
  label: string;
  durationMs: number;
};

export type ScoutDesktopLoadTrace = {
  totalMs: number;
  steps: ScoutDesktopLoadStep[];
};

export type ScoutDesktopServiceStatus = "running" | "degraded" | "offline";

export type ScoutDesktopService = {
  id: "broker" | "pairing" | "helper" | "tailscale";
  title: string;
  status: ScoutDesktopServiceStatus;
  statusLabel: string;
  healthy: boolean;
  reachable: boolean;
  detail: string | null;
  lastHeartbeatLabel: string | null;
  updatedAtLabel: string | null;
  url: string | null;
  nodeId: string | null;
};

export type ScoutDesktopServicesState = {
  title: string;
  subtitle: string;
  updatedAtLabel: string | null;
  services: ScoutDesktopService[];
  performance?: ScoutDesktopLoadTrace | null;
};

export type ScoutDesktopHomeAgent = {
  id: string;
  title: string;
  role: string | null;
  summary: string | null;
  projectRoot: string | null;
  state: ScoutRelayDirectState;
  reachable: boolean;
  statusLabel: string;
  statusDetail: string | null;
  activeTask: string | null;
  timestampLabel: string | null;
};

export type ScoutDesktopHomeActivityItem = {
  id: string;
  kind: "message" | "system";
  actorId: string;
  actorName: string;
  title: string;
  detail: string | null;
  conversationId: string;
  channel: string | null;
  timestamp: number;
  timestampLabel: string;
};

export type ScoutDesktopHomeState = {
  title: string;
  subtitle: string;
  updatedAtLabel: string | null;
  agents: ScoutDesktopHomeAgent[];
  activity: ScoutDesktopHomeActivityItem[];
  recentSessions: ScoutSessionMetadata[];
  performance?: ScoutDesktopLoadTrace | null;
};

export type ScoutRelayDestinationKind = "channel" | "filter" | "direct";

export type ScoutRelayNavItem = {
  kind: ScoutRelayDestinationKind;
  id: string;
  title: string;
  subtitle: string;
  count: number;
};

export type ScoutRelayDirectState = "offline" | "available" | "working";

export type ScoutRelayDirectThread = {
  kind: "direct";
  id: string;
  title: string;
  subtitle: string;
  preview: string | null;
  timestampLabel: string | null;
  state: ScoutRelayDirectState;
  reachable: boolean;
  statusLabel: string;
  statusDetail: string | null;
  activeTask: string | null;
};

export type ScoutRelayVoiceState = {
  captureState: string;
  captureTitle: string;
  repliesEnabled: boolean;
  detail: string | null;
  isCapturing: boolean;
  speaking: boolean;
};

export type ScoutRelayMessageReceiptState = "sent" | "delivered" | "seen" | "working" | "replied";

export type ScoutRelayMessageReceipt = {
  state: ScoutRelayMessageReceiptState;
  label: string;
  detail: string | null;
};

export type ScoutRelayMessage = {
  receipt?: ScoutRelayMessageReceipt | null;
  id: string;
  clientMessageId?: string | null;
  conversationId: string;
  createdAt: number;
  replyToMessageId: string | null;
  authorId: string;
  authorName: string;
  authorRole: string | null;
  body: string;
  timestampLabel: string;
  dayLabel: string;
  normalizedChannel: string | null;
  recipients: string[];
  isDirectConversation: boolean;
  isSystem: boolean;
  isVoice: boolean;
  messageClass: string | null;
  routingSummary: string | null;
  provenanceSummary: string | null;
  provenanceDetail: string | null;
  isOperator: boolean;
  avatarLabel: string;
  avatarColor: string;
};

export type ScoutRelayState = {
  title: string;
  subtitle: string;
  transportTitle: string;
  meshTitle: string;
  syncLine: string;
  operatorId: string;
  channels: ScoutRelayNavItem[];
  views: ScoutRelayNavItem[];
  directs: ScoutRelayDirectThread[];
  messages: ScoutRelayMessage[];
  voice: ScoutRelayVoiceState;
  lastUpdatedLabel: string | null;
};

export type ScoutMessagesThreadGroup = "inbox" | "channels" | "agents" | "internal";

export type ScoutMessagesThreadKind = "relay" | "internal";

export type ScoutMessagesThread = {
  id: string;
  group: ScoutMessagesThreadGroup;
  kind: ScoutMessagesThreadKind;
  title: string;
  subtitle: string | null;
  preview: string | null;
  timestampLabel: string | null;
  count: number | null;
  state: ScoutRelayDirectState | null;
  reachable: boolean;
  relayDestinationKind: ScoutRelayDestinationKind | null;
  relayDestinationId: string | null;
  interAgentThreadId: string | null;
};

export type ScoutMessagesState = {
  title: string;
  subtitle: string;
  lastUpdatedLabel: string | null;
  threads: ScoutMessagesThread[];
};

export type ScoutInterAgentParticipant = {
  id: string;
  title: string;
  role: string | null;
};

export type ScoutInterAgentAgent = {
  id: string;
  title: string;
  subtitle: string;
  definitionId: string | null;
  selector: string | null;
  defaultSelector: string | null;
  nodeQualifier: string | null;
  workspaceQualifier: string | null;
  branch: string | null;
  profileKind: "project" | "role" | "system";
  registrationKind: "configured" | "discovered";
  source: string | null;
  agentClass: string | null;
  role: string | null;
  summary: string | null;
  harness: string | null;
  transport: string | null;
  cwd: string | null;
  projectRoot: string | null;
  sessionId: string | null;
  wakePolicy: string | null;
  capabilities: string[];
  threadCount: number;
  counterpartCount: number;
  timestampLabel: string | null;
  lastChatAt: number | null;
  lastChatLabel: string | null;
  lastCodeChangeAt: number | null;
  lastCodeChangeLabel: string | null;
  lastSessionAt: number | null;
  lastSessionLabel: string | null;
  state: ScoutRelayDirectState;
  reachable: boolean;
  statusLabel: string;
  statusDetail: string | null;
};

export type ScoutInterAgentThread = {
  id: string;
  conversationId: string | null;
  title: string;
  subtitle: string;
  preview: string | null;
  timestampLabel: string | null;
  messageCount: number;
  latestAuthorName: string | null;
  messageIds: string[];
  sourceKind: "private" | "projected";
  participants: ScoutInterAgentParticipant[];
};

export type ScoutInterAgentState = {
  title: string;
  subtitle: string;
  agents: ScoutInterAgentAgent[];
  threads: ScoutInterAgentThread[];
  lastUpdatedLabel: string | null;
};

export type ScoutSessionMetadata = {
  id: string;
  project: string;
  agent: string;
  title: string;
  messageCount: number;
  createdAt: string;
  lastModified: string;
  tokens?: number;
  model?: string;
  tags?: string[];
  preview: string;
};

export type ScoutDesktopRuntimeState = {
  helperRunning: boolean;
  helperDetail: string | null;
  brokerInstalled: boolean;
  brokerLoaded: boolean;
  brokerReachable: boolean;
  brokerHealthy: boolean;
  brokerLabel: string;
  brokerUrl: string;
  nodeId: string | null;
  agentCount: number;
  conversationCount: number;
  messageCount: number;
  flightCount: number;
  tmuxSessionCount: number;
  latestRelayLabel: string | null;
  lastHeartbeatLabel: string | null;
  updatedAtLabel: string | null;
};

export type ScoutDesktopMachineEndpointState = "running" | "idle" | "waiting" | "offline";

export type ScoutDesktopMachineEndpoint = {
  id: string;
  agentId: string;
  agentName: string;
  project: string | null;
  projectRoot: string | null;
  cwd: string | null;
  harness: string | null;
  transport: string | null;
  sessionId: string | null;
  state: ScoutDesktopMachineEndpointState;
  stateLabel: string;
  reachable: boolean;
  lastActiveLabel: string | null;
  activeTask: string | null;
};

export type ScoutDesktopMachineStatus = "online" | "degraded" | "offline";

export type ScoutDesktopMachine = {
  id: string;
  title: string;
  hostName: string | null;
  status: ScoutDesktopMachineStatus;
  statusLabel: string;
  statusDetail: string | null;
  advertiseScope: string | null;
  brokerUrl: string | null;
  capabilities: string[];
  labels: string[];
  isLocal: boolean;
  registeredAtLabel: string | null;
  lastSeenLabel: string | null;
  projectRoots: string[];
  projectCount: number;
  endpointCount: number;
  reachableEndpointCount: number;
  workingEndpointCount: number;
  idleEndpointCount: number;
  waitingEndpointCount: number;
  endpoints: ScoutDesktopMachineEndpoint[];
};

export type ScoutDesktopMachinesState = {
  title: string;
  subtitle: string;
  totalMachines: number;
  onlineCount: number;
  degradedCount: number;
  offlineCount: number;
  lastUpdatedLabel: string | null;
  machines: ScoutDesktopMachine[];
};

export type ScoutDesktopTaskStatus = "queued" | "running" | "completed" | "failed";

export type ScoutDesktopTask = {
  id: string;
  messageId: string;
  conversationId: string;
  targetAgentId: string;
  targetAgentName: string;
  project: string | null;
  projectRoot: string | null;
  title: string;
  body: string;
  status: ScoutDesktopTaskStatus;
  statusLabel: string;
  statusDetail: string | null;
  replyPreview: string | null;
  createdAt: number;
  createdAtLabel: string;
  updatedAtLabel: string | null;
  ageLabel: string | null;
};

export type ScoutDesktopReconciliationFindingSeverity = "warning" | "error";

export type ScoutDesktopReconciliationFindingKind =
  | "agent_offline"
  | "no_follow_up"
  | "stale_working"
  | "waiting_on_record";

export type ScoutDesktopReconciliationFinding = {
  id: string;
  kind: ScoutDesktopReconciliationFindingKind;
  severity: ScoutDesktopReconciliationFindingSeverity;
  title: string;
  summary: string;
  detail: string | null;
  requesterId: string | null;
  requesterName: string | null;
  targetAgentId: string | null;
  targetAgentName: string | null;
  conversationId: string | null;
  messageId: string | null;
  recordId: string | null;
  ageLabel: string | null;
  updatedAtLabel: string | null;
};

export type ScoutDesktopPlanStatus =
  | "awaiting-review"
  | "in-progress"
  | "completed"
  | "paused"
  | "draft";

export type ScoutDesktopPlan = {
  id: string;
  title: string;
  summary: string;
  status: ScoutDesktopPlanStatus;
  stepsCompleted: number;
  stepsTotal: number;
  progressPercent: number;
  tags: string[];
  agentId: string;
  agent: string;
  workspaceName: string;
  workspacePath: string;
  path: string;
  updatedAt: string;
  updatedAtLabel: string;
};

export type ScoutDesktopPlansState = {
  title: string;
  subtitle: string;
  taskCount: number;
  runningTaskCount: number;
  failedTaskCount: number;
  completedTaskCount: number;
  findingCount: number;
  warningCount: number;
  errorCount: number;
  planCount: number;
  workspaceCount: number;
  lastUpdatedLabel: string | null;
  tasks: ScoutDesktopTask[];
  findings: ScoutDesktopReconciliationFinding[];
  plans: ScoutDesktopPlan[];
};

export type ScoutPhonePreparationState = {
  favorites: string[];
  quickHits: string[];
  preparedAt: number | null;
};

export type UpdateScoutPhonePreparationInput = ScoutPhonePreparationState;

export type ScoutDesktopShellState = {
  appInfo: ScoutDesktopAppInfo;
  runtime: ScoutDesktopRuntimeState;
  machines: ScoutDesktopMachinesState;
  plans: ScoutDesktopPlansState;
  messages: ScoutMessagesState;
  sessions: ScoutSessionMetadata[];
  relay: ScoutRelayState;
  interAgent: ScoutInterAgentState;
  performance?: ScoutDesktopLoadTrace | null;
};

export type ScoutDesktopMessagesWorkspaceState = Pick<
  ScoutDesktopShellState,
  "runtime" | "messages" | "sessions" | "relay" | "interAgent"
> & {
  performance?: ScoutDesktopLoadTrace | null;
};

export type ScoutDesktopShellPatch = Pick<
  ScoutDesktopShellState,
  "runtime" | "machines" | "plans" | "messages" | "sessions" | "relay" | "interAgent"
> & {
  performance?: ScoutDesktopLoadTrace | null;
};
