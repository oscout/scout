import { open, readFile, readdir, stat } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import path from "node:path";

import type {
  ActorIdentity,
  AgentDefinition,
  AgentEndpoint,
  CollaborationRecord,
  ConversationDefinition,
  FlightRecord,
  MessageRecord,
} from "@openscout/protocol";
import { BUILT_IN_AGENT_DEFINITION_IDS } from "@openscout/protocol";
import {
  resolveBrokerServiceConfig,
  type BrokerServiceStatus,
} from "@openscout/runtime/broker-process-manager";
import type { RuntimeRegistrySnapshot } from "@openscout/runtime/registry";
import { loadResolvedRelayAgents } from "@openscout/runtime/setup";

import { getRuntimeBrokerServiceStatus } from "../host/runtime-service-client.ts";
import {
  loadScoutBrokerContext,
  readScoutBrokerHome,
  readScoutBrokerHealth,
  readScoutBrokerSnapshot,
  type ScoutBrokerContext,
  type ScoutBrokerHealthState,
} from "../../core/broker/service.ts";
import { createScoutVoiceState } from "../../core/voice/index.ts";
import type {
  ScoutDesktopHomeActivityItem,
  ScoutDesktopHomeState,
  ScoutDesktopLoadStep,
  ScoutDesktopMachine,
  ScoutDesktopMachineEndpoint,
  ScoutDesktopMachineEndpointState,
  ScoutDesktopMessagesWorkspaceState,
  ScoutDesktopMachinesState,
  ScoutMessagesState,
  ScoutMessagesThread,
  ScoutDesktopPlan,
  ScoutDesktopPlansState,
  ScoutDesktopReconciliationFinding,
  ScoutDesktopRuntimeState,
  ScoutDesktopService,
  ScoutDesktopServicesState,
  ScoutDesktopShellPatch,
  ScoutDesktopShellState,
  ScoutDesktopTask,
  ScoutDesktopTaskStatus,
  ScoutInterAgentAgent,
  ScoutInterAgentParticipant,
  ScoutInterAgentState,
  ScoutInterAgentThread,
  ScoutRelayDirectThread,
  ScoutRelayMessage,
  ScoutRelayNavItem,
  ScoutRelayState,
  ScoutSessionMetadata,
} from "./state.ts";
import {
  readHelperStatus,
  readProjectGitActivity,
  readTmuxSessions,
  resolveOperatorDisplayName,
  type HelperStatus,
  type TmuxSession,
} from "./shell-probes.ts";
import {
  compactHomePath,
  expandHomePath,
  formatDateTimeLabel,
  formatDayLabel,
  formatRelativeTime,
  formatTimeLabel,
  isoFromTimestamp,
  normalizeTimestamp,
  runOptionalCommand,
} from "./shell-utils.ts";

const OPERATOR_ID = "operator";
const RECENT_AGENT_ACTIVITY_WINDOW_SECONDS = 60 * 60 * 24 * 30;
const RECONCILE_OFFLINE_WAIT_SECONDS = 60 * 3;
const RECONCILE_NO_FOLLOW_UP_SECONDS = 60 * 10;
const RECONCILE_STALE_WORKING_SECONDS = 60 * 15;
const LOG_TAIL_CHUNK_BYTES = 64 * 1024;

type AgentWorkspaceRecord = {
  agentId: string;
  project: string;
  cwd: string;
};

type ParsedPlanFrontmatter = {
  attributes: Record<string, string>;
  body: string;
};

type DirectAgentActivity = {
  state: "offline" | "available" | "working";
  reachable: boolean;
  statusLabel: string;
  statusDetail: string | null;
  activeTask: string | null;
  lastMessageAt: number | null;
};

type RelayWorkspaceDerivation = {
  messagesByConversation: Map<string, MessageRecord[]>;
  directActivity: Map<string, DirectAgentActivity>;
  visibleAgentIds: Set<string>;
};

type LoadMeasurement = {
  startedAt: number;
  steps: ScoutDesktopLoadStep[];
};

function startLoadMeasurement(): LoadMeasurement {
  return {
    startedAt: performance.now(),
    steps: [],
  };
}

async function measureAsyncStep<T>(
  measurement: LoadMeasurement,
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  const result = await fn();
  measurement.steps.push({
    label,
    durationMs: Math.round(performance.now() - startedAt),
  });
  return result;
}

function measureStep<T>(
  measurement: LoadMeasurement,
  label: string,
  fn: () => T,
): T {
  const startedAt = performance.now();
  const result = fn();
  measurement.steps.push({
    label,
    durationMs: Math.round(performance.now() - startedAt),
  });
  return result;
}

function finalizeLoadMeasurement(measurement: LoadMeasurement) {
  return {
    totalMs: Math.round(performance.now() - measurement.startedAt),
    steps: measurement.steps,
  };
}

function actorDisplayName(snapshot: RuntimeRegistrySnapshot, actorId: string): string {
  if (actorId === OPERATOR_ID) {
    return resolveOperatorDisplayName();
  }
  const agent = snapshot.agents[actorId];
  if (typeof agent?.displayName === "string" && agent.displayName.trim().length > 0) {
    return agent.displayName;
  }
  const actor = snapshot.actors[actorId];
  if (typeof actor?.displayName === "string" && actor.displayName.trim().length > 0) {
    return actor.displayName;
  }
  return actorId;
}

function actorRole(snapshot: RuntimeRegistrySnapshot, actorId: string): string | null {
  const role = snapshot.agents[actorId]?.metadata?.role;
  return typeof role === "string" ? role : null;
}

function isStaleLocalAgent(agent: AgentDefinition | undefined): boolean {
  return agent?.metadata?.staleLocalRegistration === true;
}

function isStaleLocalEndpoint(snapshot: RuntimeRegistrySnapshot, endpoint: AgentEndpoint | undefined): boolean {
  if (!endpoint || endpoint.metadata?.staleLocalRegistration === true) {
    return true;
  }

  return isStaleLocalAgent(snapshot.agents[endpoint.agentId]);
}

function activeEndpoint(snapshot: RuntimeRegistrySnapshot, actorId: string): AgentEndpoint | null {
  const candidates = Object.values(snapshot.endpoints).filter((endpoint) => (
    endpoint.agentId === actorId && !isStaleLocalEndpoint(snapshot, endpoint)
  ));
  const rank = (state: string | undefined) => {
    switch (state) {
      case "active":
        return 0;
      case "idle":
        return 1;
      case "waiting":
        return 2;
      case "offline":
        return 5;
      default:
        return 4;
    }
  };

  return [...candidates].sort((left, right) => rank(left.state) - rank(right.state))[0] ?? null;
}

function inferRecipients(message: MessageRecord, conversation: ConversationDefinition | undefined): string[] {
  const fromAudience = [
    ...(message.audience?.notify ?? []),
    ...(message.audience?.invoke ?? []),
    ...(message.mentions?.map((mention) => mention.actorId) ?? []),
  ];

  if (fromAudience.length > 0) {
    return Array.from(new Set(fromAudience)).filter((recipient) => recipient !== message.actorId);
  }

  if (!conversation) {
    return [];
  }

  return conversation.participantIds.filter((participant) => participant !== message.actorId);
}

function normalizedChannel(conversation: ConversationDefinition | undefined): string | null {
  if (!conversation) return null;
  return conversation.id.startsWith("channel.")
    ? conversation.id.replace(/^channel\./, "")
    : null;
}

function sanitizeRelayBody(body: string): string {
  return body
    .replace(/\[ask:[^\]]+\]\s*/g, "")
    .replace(/\[speak\]\s*/gi, "")
    .replace(/^(@[\w.-]+\s+)+/g, "")
    .trim();
}

function spokenTextForMessage(message: MessageRecord): string | null {
  const explicitSpeech = message.speech?.text?.trim();
  if (explicitSpeech) {
    return explicitSpeech;
  }

  const taggedSpeech = message.body.match(/^\[speak\]\s*([\s\S]+)$/i)?.[1]?.trim();
  return taggedSpeech || null;
}

function isReachableEndpointState(state: string | undefined): boolean {
  return state === "active" || state === "idle" || state === "waiting";
}

function isWorkingFlightState(state: string | undefined): boolean {
  return state === "queued" || state === "waking" || state === "running" || state === "waiting";
}

function flightTimestamp(flight: FlightRecord): number {
  return normalizeTimestamp(flight.completedAt ?? flight.startedAt ?? 0);
}

function endpointLastStartedAt(endpoint: AgentEndpoint | null): number {
  if (!endpoint) {
    return 0;
  }
  return normalizeTimestamp(
    typeof endpoint.metadata?.lastStartedAt === "number"
      ? endpoint.metadata.lastStartedAt
      : 0,
  );
}

function endpointLastResolvedAt(endpoint: AgentEndpoint | null): number {
  if (!endpoint) {
    return 0;
  }

  return Math.max(
    normalizeTimestamp(
      typeof endpoint.metadata?.lastCompletedAt === "number"
        ? endpoint.metadata.lastCompletedAt
        : 0,
    ),
    normalizeTimestamp(
      typeof endpoint.metadata?.lastFailedAt === "number"
        ? endpoint.metadata.lastFailedAt
        : 0,
    ),
  );
}

function isSupersededWorkingFlight(
  flight: FlightRecord,
  endpoint: AgentEndpoint | null,
  flights: FlightRecord[],
): boolean {
  const startedAt = flightTimestamp(flight);
  const newerTerminalFlight = flights.some((candidate) => (
    candidate.targetAgentId === flight.targetAgentId
    && candidate.id !== flight.id
    && !isWorkingFlightState(candidate.state)
    && flightTimestamp(candidate) > startedAt
  ));
  if (newerTerminalFlight) {
    return true;
  }

  const endpointResolvedAt = endpointLastResolvedAt(endpoint);
  if (endpoint && endpoint.state !== "active" && endpointResolvedAt > startedAt) {
    return true;
  }

  const newerEndpointStart = endpointLastStartedAt(endpoint);
  return Boolean(endpoint && endpoint.state === "active" && newerEndpointStart > startedAt);
}

function directConversationId(agentId: string): string {
  return `dm.${OPERATOR_ID}.${agentId}`;
}

function colorForIdentity(identity: string): string {
  const palette = ["#3b82f6", "#14b8a6", "#fb923c", "#f43f5e", "#8b5cf6", "#10b981"];
  let seed = 0;
  for (const character of identity) {
    seed += character.charCodeAt(0);
  }
  return palette[seed % palette.length] ?? palette[0];
}

function buildMessagesByConversation(snapshot: RuntimeRegistrySnapshot): Map<string, MessageRecord[]> {
  const messagesByConversation = new Map<string, MessageRecord[]>();

  for (const message of Object.values(snapshot.messages)) {
    if (message.metadata?.transportOnly === "true") {
      continue;
    }

    const bucket = messagesByConversation.get(message.conversationId) ?? [];
    bucket.push(message);
    messagesByConversation.set(message.conversationId, bucket);
  }

  for (const bucket of messagesByConversation.values()) {
    bucket.sort((left, right) => normalizeTimestamp(left.createdAt) - normalizeTimestamp(right.createdAt));
  }

  return messagesByConversation;
}

function isInterAgentConversation(snapshot: RuntimeRegistrySnapshot, conversation: ConversationDefinition): boolean {
  if (conversation.kind !== "direct" && conversation.kind !== "group_direct") {
    return false;
  }
  if (conversation.participantIds.includes(OPERATOR_ID)) {
    return false;
  }
  if (conversation.participantIds.length < 2) {
    return false;
  }
  return conversation.participantIds.every((participantId) => isKnownCounterpart(snapshot, participantId));
}

function isKnownVisibleAgent(
  snapshot: RuntimeRegistrySnapshot,
  actorId: string,
  visibleAgentIds?: Set<string>,
): boolean {
  const agent = snapshot.agents[actorId];
  if (!agent || isStaleLocalAgent(agent)) {
    return false;
  }

  return !visibleAgentIds || visibleAgentIds.has(actorId);
}

function isKnownCounterpart(
  snapshot: RuntimeRegistrySnapshot,
  actorId: string,
  visibleAgentIds?: Set<string>,
): boolean {
  if (actorId === OPERATOR_ID) {
    return false;
  }

  if (isStaleLocalAgent(snapshot.agents[actorId])) {
    return false;
  }

  if (isKnownVisibleAgent(snapshot, actorId, visibleAgentIds)) {
    return true;
  }

  return Boolean(snapshot.actors[actorId]);
}

function interAgentParticipantIds(
  snapshot: RuntimeRegistrySnapshot,
  participantIds: string[],
  visibleAgentIds?: Set<string>,
): string[] {
  return Array.from(
    new Set(
      participantIds.filter((participantId) => (
        participantId !== OPERATOR_ID && isKnownCounterpart(snapshot, participantId, visibleAgentIds)
      )),
    ),
  ).sort();
}

function interAgentThreadKey(participantIds: string[]): string {
  return `inter-agent:${participantIds.join("::")}`;
}

function visibleRelayAgentIds(
  snapshot: RuntimeRegistrySnapshot,
  configuredAgentIds: Set<string>,
  messagesByConversation: Map<string, MessageRecord[]>,
  directActivity: Map<string, DirectAgentActivity>,
): Set<string> {
  const visible = new Set<string>([
    ...configuredAgentIds,
    ...Array.from(BUILT_IN_AGENT_DEFINITION_IDS),
  ]);
  const cutoff = Math.floor(Date.now() / 1000) - RECENT_AGENT_ACTIVITY_WINDOW_SECONDS;

  for (const [agentId, activity] of directActivity.entries()) {
    if (activity.reachable || activity.state === "working" || (activity.lastMessageAt ?? 0) >= cutoff) {
      visible.add(agentId);
    }
  }

  for (const endpoint of Object.values(snapshot.endpoints)) {
    if (endpoint.state && endpoint.state !== "offline") {
      visible.add(endpoint.agentId);
    }
  }

  for (const conversation of Object.values(snapshot.conversations)) {
    const messages = messagesByConversation.get(conversation.id) ?? [];
    const latestMessage = messages.at(-1);
    if (!latestMessage || normalizeTimestamp(latestMessage.createdAt) < cutoff) {
      continue;
    }

    if (isInterAgentConversation(snapshot, conversation)) {
      for (const participantId of conversation.participantIds) {
        if (snapshot.agents[participantId]) {
          visible.add(participantId);
        }
      }
      continue;
    }

    for (const message of messages) {
      if (normalizeTimestamp(message.createdAt) < cutoff || !isKnownCounterpart(snapshot, message.actorId)) {
        continue;
      }

      const recipients = inferRecipients(message, conversation)
        .filter((recipientId) => recipientId !== OPERATOR_ID && recipientId !== message.actorId)
        .filter((recipientId) => isKnownCounterpart(snapshot, recipientId));
      const participantIds = interAgentParticipantIds(snapshot, [message.actorId, ...recipients]);
      if (participantIds.length >= 2 && participantIds.length <= 3) {
        for (const participantId of participantIds) {
          if (isKnownVisibleAgent(snapshot, participantId)) {
            visible.add(participantId);
          }
        }
      }
    }
  }

  return visible;
}

function inferredConfiguredAgentIds(snapshot: RuntimeRegistrySnapshot | null): Set<string> {
  if (!snapshot) {
    return new Set();
  }

  return new Set(
    Object.values(snapshot.agents)
      .filter((agent) => (
        agent.metadata?.staleLocalRegistration !== true &&
        agent.metadata?.source === "relay-agent-registry"
      ))
      .map((agent) => agent.id),
  );
}

function inactiveDirectAgentActivity(
  agent: AgentDefinition,
  latestMessage: MessageRecord | null,
  degradedReason: string | null,
): DirectAgentActivity {
  const lastMessageAt = latestMessage ? normalizeTimestamp(latestMessage.createdAt) : null;
  const lastActivityDetail = latestMessage ? `Last activity ${formatRelativeTime(latestMessage.createdAt)}` : null;

  if (degradedReason && degradedReason.includes("tmux session missing")) {
    return {
      state: "offline",
      reachable: false,
      statusLabel: "Offline",
      statusDetail: "Relay session is not running.",
      activeTask: null,
      lastMessageAt,
    };
  }

  if (agent.wakePolicy === "on_demand") {
    return {
      state: "offline",
      reachable: false,
      statusLabel: "Sleeping",
      statusDetail: lastActivityDetail ? `${lastActivityDetail} · wakes on demand.` : "Wakes on demand.",
      activeTask: null,
      lastMessageAt,
    };
  }

  if (agent.wakePolicy === "manual") {
    return {
      state: "offline",
      reachable: false,
      statusLabel: "Offline",
      statusDetail: lastActivityDetail ?? "Start this agent manually when needed.",
      activeTask: null,
      lastMessageAt,
    };
  }

  return {
    state: "offline",
    reachable: false,
    statusLabel: "Offline",
    statusDetail: lastActivityDetail ?? "No live session right now.",
    activeTask: null,
    lastMessageAt,
  };
}

function buildDirectAgentActivity(
  snapshot: RuntimeRegistrySnapshot,
  tmuxSessions: TmuxSession[],
  messagesByConversation: Map<string, MessageRecord[]>,
): Map<string, DirectAgentActivity> {
  const tmuxSet = new Set(tmuxSessions.map((session) => session.name));
  const flights = Object.values(snapshot.flights);
  const activity = new Map<string, DirectAgentActivity>();

  for (const agent of Object.values(snapshot.agents)) {
    if (isStaleLocalAgent(agent)) {
      continue;
    }

    const endpoint = activeEndpoint(snapshot, agent.id);
    const endpointSessionId = endpoint?.sessionId
      ?? (typeof endpoint?.metadata?.tmuxSession === "string" ? endpoint.metadata.tmuxSession : null);
    const tmuxReachable = endpointSessionId ? tmuxSet.has(endpointSessionId) : false;
    const reachable = (
      endpoint?.transport === "tmux"
        ? tmuxReachable
        : Boolean(endpoint && isReachableEndpointState(endpoint.state))
    ) || tmuxSet.has(`relay-${agent.id}`);

    const latestMessage = (messagesByConversation.get(directConversationId(agent.id)) ?? []).at(-1) ?? null;
    const lastMessageAt = latestMessage ? normalizeTimestamp(latestMessage.createdAt) : null;
    const degradedReason = typeof endpoint?.metadata?.lastError === "string" ? endpoint.metadata.lastError : null;
    const activeFlight = flights
      .filter((flight) => (
        flight.targetAgentId === agent.id
        && isWorkingFlightState(flight.state)
        && !isSupersededWorkingFlight(flight, endpoint, flights)
      ))
      .sort((left, right) => (
        flightTimestamp(right) - flightTimestamp(left)
      ))[0] ?? null;

    const activeTaskSummary = sanitizeRelayBody(
      activeFlight?.summary?.trim()
        || (typeof activeFlight?.metadata?.task === "string" ? activeFlight.metadata.task : "")
        || "Working on your latest message.",
    ) || null;
    const activeTask = activeTaskSummary && /is working\.?$/i.test(activeTaskSummary)
      ? null
      : activeTaskSummary;

    if (activeFlight) {
      activity.set(agent.id, {
        state: "working",
        reachable: true,
        statusLabel: "Working",
        statusDetail: activeTask,
        activeTask,
        lastMessageAt,
      });
      continue;
    }

    if (reachable) {
      activity.set(agent.id, {
        state: "available",
        reachable: true,
        statusLabel: "Available",
        statusDetail: latestMessage ? `Last activity ${formatRelativeTime(latestMessage.createdAt)}` : "Ready for a direct message.",
        activeTask: null,
        lastMessageAt,
      });
      continue;
    }

    activity.set(agent.id, inactiveDirectAgentActivity(agent, latestMessage, degradedReason));
  }

  return activity;
}

function latestRelayLabelFromSnapshot(snapshot: RuntimeRegistrySnapshot | null): string | null {
  if (!snapshot) return null;
  const latestMessage = Object.values(snapshot.messages)
    .sort((left, right) => normalizeTimestamp(right.createdAt) - normalizeTimestamp(left.createdAt))[0];
  if (!latestMessage) return null;
  return `${actorDisplayName(snapshot, latestMessage.actorId)} · ${formatTimeLabel(latestMessage.createdAt)}`;
}

function buildServicesState(
  status: BrokerServiceStatus,
  helper: HelperStatus,
): ScoutDesktopServicesState {
  const updatedAtLabel = formatTimeLabel(Math.floor(Date.now() / 1000));
  const services: ScoutDesktopService[] = [
    {
      id: "broker",
      title: "Broker",
      status: status.reachable
        ? status.health.ok
          ? "running"
          : "degraded"
        : "offline",
      statusLabel: status.reachable
        ? status.health.ok
          ? "Running"
          : "Degraded"
        : "Offline",
      healthy: status.health.ok,
      reachable: status.reachable,
      detail: status.health.ok
        ? status.label
        : status.health.error ?? status.lastLogLine ?? status.label,
      lastHeartbeatLabel: null,
      updatedAtLabel,
      url: status.brokerUrl,
      nodeId: status.health.nodeId ?? null,
    },
    {
      id: "helper",
      title: "Helper",
      status: helper.running ? "running" : "offline",
      statusLabel: helper.running ? "Running" : "Offline",
      healthy: helper.running,
      reachable: helper.running,
      detail: helper.detail,
      lastHeartbeatLabel: helper.heartbeatLabel,
      updatedAtLabel,
      url: null,
      nodeId: null,
    },
  ];

  const runningCount = services.filter((service) => service.status === "running").length;
  return {
    title: "Services",
    subtitle: `${runningCount}/${services.length} running`,
    updatedAtLabel,
    services,
  };
}

function buildServicesStateFromHealth(
  health: ScoutBrokerHealthState,
  helper: HelperStatus,
): ScoutDesktopServicesState {
  const updatedAtLabel = formatTimeLabel(Math.floor(Date.now() / 1000));
  const services: ScoutDesktopService[] = [
    {
      id: "broker",
      title: "Broker",
      status: health.reachable
        ? health.ok
          ? "running"
          : "degraded"
        : "offline",
      statusLabel: health.reachable
        ? health.ok
          ? "Running"
          : "Degraded"
        : "Offline",
      healthy: health.ok,
      reachable: health.reachable,
      detail: health.ok
        ? "Relay responding on /health"
        : health.error ?? "Broker unavailable",
      lastHeartbeatLabel: null,
      updatedAtLabel,
      url: health.baseUrl,
      nodeId: health.nodeId,
    },
    {
      id: "helper",
      title: "Helper",
      status: helper.running ? "running" : "offline",
      statusLabel: helper.running ? "Running" : "Offline",
      healthy: helper.running,
      reachable: helper.running,
      detail: helper.detail,
      lastHeartbeatLabel: helper.heartbeatLabel,
      updatedAtLabel,
      url: null,
      nodeId: null,
    },
  ];

  const runningCount = services.filter((service) => service.status === "running").length;
  return {
    title: "Services",
    subtitle: `${runningCount}/${services.length} running`,
    updatedAtLabel,
    services,
  };
}

function mergeBrokerServiceStatusWithHealth(
  status: BrokerServiceStatus,
  health: ScoutBrokerHealthState,
): BrokerServiceStatus {
  if (!health.reachable) {
    return status;
  }

  return {
    ...status,
    brokerUrl: health.baseUrl,
    reachable: true,
    health: {
      ...status.health,
      reachable: true,
      ok: health.ok,
      checkedAt: health.checkedAt,
      transport: health.transport ?? status.health.transport,
      socketPath: health.socketPath ?? status.health.socketPath,
      socketFallbackError: health.socketFallbackError ?? status.health.socketFallbackError,
      nodeId: health.nodeId ?? status.health.nodeId,
      meshId: health.meshId ?? status.health.meshId,
      counts: health.counts ?? status.health.counts,
      error: health.error ?? status.health.error,
    },
  };
}

function buildBrokerServiceStatusFromHealth(health: ScoutBrokerHealthState): BrokerServiceStatus {
  const config = resolveBrokerServiceConfig();
  return {
    label: health.reachable
      ? (health.ok ? "Running" : "Degraded")
      : "Offline",
    mode: "dev",
    launchAgentPath: "",
    bootoutCommand: "",
    brokerUrl: health.baseUrl,
    brokerSocketPath: config.brokerSocketPath,
    supportDirectory: "",
    runtimeDirectory: config.runtimeDirectory,
    controlHome: "",
    stdoutLogPath: "",
    stderrLogPath: "",
    installed: true,
    loaded: health.reachable,
    pid: null,
    launchdState: null,
    lastExitStatus: null,
    usesLaunchAgent: false,
    reachable: health.reachable,
    health: {
      reachable: health.reachable,
      ok: health.ok,
      checkedAt: health.checkedAt,
      transport: health.transport ?? undefined,
      socketPath: health.socketPath ?? undefined,
      socketFallbackError: health.socketFallbackError ?? undefined,
      nodeId: health.nodeId ?? undefined,
      meshId: health.meshId ?? undefined,
      counts: health.counts ?? undefined,
      error: health.error ?? undefined,
    },
    lastLogLine: null,
  };
}

async function loadBrokerStatusForShell(): Promise<BrokerServiceStatus> {
  const [status, health] = await Promise.all([
    getRuntimeBrokerServiceStatus(),
    readScoutBrokerHealth(),
  ]);
  return mergeBrokerServiceStatusWithHealth(status, health);
}

async function loadBrokerStatusForFastUi(): Promise<BrokerServiceStatus> {
  const health = await readScoutBrokerHealth();
  return buildBrokerServiceStatusFromHealth(health);
}

function buildRuntimeState(
  snapshot: RuntimeRegistrySnapshot | null,
  tmuxSessions: TmuxSession[],
  latestRelayLabel: string | null,
  helper: HelperStatus,
  status: BrokerServiceStatus,
  visibleAgentCount: number,
): ScoutDesktopRuntimeState {
  return {
    helperRunning: helper.running,
    helperDetail: helper.detail,
    brokerInstalled: status.installed,
    brokerLoaded: status.loaded,
    brokerReachable: status.reachable,
    brokerHealthy: status.health.ok,
    brokerLabel: status.label,
    brokerUrl: status.brokerUrl,
    nodeId: status.health.nodeId ?? null,
    agentCount: visibleAgentCount,
    conversationCount: snapshot ? Object.keys(snapshot.conversations).length : status.health.counts?.conversations ?? 0,
    messageCount: snapshot ? Object.keys(snapshot.messages).length : status.health.counts?.messages ?? 0,
    flightCount: snapshot ? Object.keys(snapshot.flights).length : status.health.counts?.flights ?? 0,
    tmuxSessionCount: tmuxSessions.length,
    latestRelayLabel,
    lastHeartbeatLabel: helper.heartbeatLabel,
    updatedAtLabel: formatTimeLabel(Math.floor(Date.now() / 1000)),
  };
}

function buildHomeAgents(
  snapshot: RuntimeRegistrySnapshot,
  directActivity: Map<string, DirectAgentActivity>,
  visibleAgentIds: Set<string>,
): ScoutDesktopHomeState["agents"] {
  return Object.values(snapshot.agents)
    .filter((agent) => visibleAgentIds.has(agent.id))
    .map((agent) => {
      const endpoint = activeEndpoint(snapshot, agent.id);
      const activity = directActivity.get(agent.id) ?? inactiveDirectAgentActivity(agent, null, null);
      const projectRoot = endpoint?.projectRoot
        ?? endpoint?.cwd
        ?? (typeof agent.metadata?.projectRoot === "string" ? agent.metadata.projectRoot : null);
      const lastSeenAt = Math.max(
        activity.lastMessageAt ?? 0,
        normalizeTimestamp(
          typeof endpoint?.metadata?.lastCompletedAt === "number"
            ? endpoint.metadata.lastCompletedAt
            : typeof endpoint?.metadata?.lastStartedAt === "number"
              ? endpoint.metadata.lastStartedAt
              : 0,
        ),
      ) || null;

      return {
        lastSeenAt,
        id: agent.id,
        title: actorDisplayName(snapshot, agent.id),
        role: typeof agent.metadata?.role === "string" ? agent.metadata.role : null,
        summary: typeof agent.metadata?.summary === "string" ? agent.metadata.summary : null,
        projectRoot: compactHomePath(projectRoot) ?? projectRoot,
        state: activity.state,
        reachable: activity.reachable,
        statusLabel: activity.statusLabel,
        statusDetail: activity.statusDetail,
        activeTask: activity.activeTask,
        timestampLabel: lastSeenAt ? formatTimeLabel(lastSeenAt) : null,
      };
    })
    .sort((left, right) => {
      const rank = (state: typeof left.state) => {
        switch (state) {
          case "working":
            return 0;
          case "available":
            return 1;
          case "offline":
          default:
            return 2;
        }
      };

      return rank(left.state) - rank(right.state)
        || (right.lastSeenAt ?? 0) - (left.lastSeenAt ?? 0)
        || Number(right.reachable) - Number(left.reachable)
        || left.title.localeCompare(right.title);
    })
    .map(({ lastSeenAt: _lastSeenAt, ...agent }) => agent);
}

function buildHomeActivity(snapshot: RuntimeRegistrySnapshot): ScoutDesktopHomeActivityItem[] {
  return buildRelayMessages(snapshot)
    .filter((message) => !message.isVoice)
    .sort((left, right) => normalizeTimestamp(right.createdAt) - normalizeTimestamp(left.createdAt))
    .slice(0, 24)
    .map((message) => ({
      id: message.id,
      kind: message.isSystem ? "system" : "message",
      actorId: message.authorId,
      actorName: message.authorName,
      title: message.authorName,
      detail: message.body,
      conversationId: message.conversationId,
      channel: message.normalizedChannel,
      timestamp: normalizeTimestamp(message.createdAt),
      timestampLabel: message.timestampLabel,
    }));
}

function buildRelayWorkspaceDerivation(
  snapshot: RuntimeRegistrySnapshot,
  tmuxSessions: TmuxSession[],
  configuredAgentIds: Set<string>,
): RelayWorkspaceDerivation {
  const messagesByConversation = buildMessagesByConversation(snapshot);
  const directActivity = buildDirectAgentActivity(snapshot, tmuxSessions, messagesByConversation);
  const visibleAgentIds = visibleRelayAgentIds(snapshot, configuredAgentIds, messagesByConversation, directActivity);

  return {
    messagesByConversation,
    directActivity,
    visibleAgentIds,
  };
}

function machineEndpointState(
  endpoint: AgentEndpoint,
  activity: DirectAgentActivity | undefined,
): ScoutDesktopMachineEndpointState {
  if (activity?.state === "working" || endpoint.state === "active") {
    return "running";
  }
  if (endpoint.state === "idle") {
    return "idle";
  }
  if (endpoint.state === "waiting") {
    return "waiting";
  }
  return "offline";
}

function machineEndpointStateLabel(state: ScoutDesktopMachineEndpointState): string {
  switch (state) {
    case "running":
      return "Running";
    case "idle":
      return "Idle";
    case "waiting":
      return "Waiting";
    case "offline":
      return "Offline";
  }
}

function buildEmptyMachinesState(): ScoutDesktopMachinesState {
  return {
    title: "Machines",
    subtitle: "Broker unavailable",
    totalMachines: 0,
    onlineCount: 0,
    degradedCount: 0,
    offlineCount: 0,
    lastUpdatedLabel: null,
    machines: [],
  };
}

function buildMachinesState(
  snapshot: RuntimeRegistrySnapshot,
  tmuxSessions: TmuxSession[],
  localNodeId: string | null,
  shared?: RelayWorkspaceDerivation,
): ScoutDesktopMachinesState {
  const messagesByConversation = shared?.messagesByConversation ?? buildMessagesByConversation(snapshot);
  const directActivity = shared?.directActivity ?? buildDirectAgentActivity(snapshot, tmuxSessions, messagesByConversation);
  const endpoints = Object.values(snapshot.endpoints).filter((endpoint) => !isStaleLocalEndpoint(snapshot, endpoint));
  const endpointsByNode = endpoints.reduce((map, endpoint) => {
    const bucket = map.get(endpoint.nodeId) ?? [];
    bucket.push(endpoint);
    map.set(endpoint.nodeId, bucket);
    return map;
  }, new Map<string | undefined, AgentEndpoint[]>());
  const nowSeconds = Math.floor(Date.now() / 1000);
  const nodeIds = Array.from(new Set([
    ...Object.keys(snapshot.nodes),
    ...endpoints.map((endpoint) => endpoint.nodeId).filter(Boolean),
  ])) as string[];

  const machines = nodeIds
    .map((nodeId): ScoutDesktopMachine => {
      const node = snapshot.nodes[nodeId];
      const nodeEndpoints = endpointsByNode.get(nodeId) ?? [];
      const endpointItems = nodeEndpoints
        .map((endpoint): ScoutDesktopMachineEndpoint => {
          const activity = directActivity.get(endpoint.agentId);
          const projectRoot = compactHomePath(endpoint.projectRoot ?? endpoint.cwd);
          const project = typeof endpoint.metadata?.project === "string"
            ? endpoint.metadata.project
            : endpoint.projectRoot
              ? path.basename(endpoint.projectRoot)
              : endpoint.cwd
                ? path.basename(endpoint.cwd)
                : null;
          const lastActiveAt = typeof endpoint.metadata?.lastCompletedAt === "number"
            ? endpoint.metadata.lastCompletedAt
            : typeof endpoint.metadata?.lastStartedAt === "number"
              ? endpoint.metadata.lastStartedAt
              : null;
          const state = machineEndpointState(endpoint, activity);

          return {
            id: endpoint.id,
            agentId: endpoint.agentId,
            agentName: actorDisplayName(snapshot, endpoint.agentId),
            project,
            projectRoot,
            cwd: compactHomePath(endpoint.cwd),
            harness: endpoint.harness ?? null,
            transport: endpoint.transport ?? null,
            sessionId: endpoint.sessionId ?? null,
            state,
            stateLabel: machineEndpointStateLabel(state),
            reachable: Boolean(activity?.reachable),
            lastActiveLabel: lastActiveAt ? formatRelativeTime(lastActiveAt) : null,
            activeTask: activity?.state === "working" ? activity.activeTask : null,
          };
        })
        .sort((left, right) => left.agentName.localeCompare(right.agentName));

      const latestEndpointActivityAt = nodeEndpoints.reduce((latest, endpoint) => {
        const completedAt = typeof endpoint.metadata?.lastCompletedAt === "number" ? endpoint.metadata.lastCompletedAt : 0;
        const startedAt = typeof endpoint.metadata?.lastStartedAt === "number" ? endpoint.metadata.lastStartedAt : 0;
        return Math.max(latest, normalizeTimestamp(completedAt || startedAt || 0));
      }, 0);
      const lastSeenAt = normalizeTimestamp(node?.lastSeenAt ?? latestEndpointActivityAt ?? node?.registeredAt ?? 0);
      const reachableEndpointCount = endpointItems.filter((endpoint) => endpoint.reachable).length;
      const workingEndpointCount = endpointItems.filter((endpoint) => endpoint.state === "running").length;
      const idleEndpointCount = endpointItems.filter((endpoint) => endpoint.state === "idle").length;
      const waitingEndpointCount = endpointItems.filter((endpoint) => endpoint.state === "waiting").length;
      const ageSeconds = lastSeenAt ? Math.max(0, nowSeconds - lastSeenAt) : Number.POSITIVE_INFINITY;
      const status = reachableEndpointCount > 0 || ageSeconds <= 300
        ? "online"
        : nodeEndpoints.length > 0 || ageSeconds <= 3600
          ? "degraded"
          : "offline";
      const statusLabel = status === "online"
        ? "Online"
        : status === "degraded"
          ? "Degraded"
          : "Offline";
      const projectRoots = Array.from(new Set(
        endpointItems.map((endpoint) => endpoint.projectRoot).filter((value): value is string => Boolean(value)),
      ));

      return {
        id: nodeId,
        title: node?.name || node?.hostName || nodeId,
        hostName: node?.hostName ?? null,
        status,
        statusLabel,
        statusDetail: reachableEndpointCount > 0
          ? `${reachableEndpointCount} reachable endpoint${reachableEndpointCount === 1 ? "" : "s"}`
          : lastSeenAt
            ? `Last seen ${formatRelativeTime(lastSeenAt)}`
            : "No runtime endpoints are visible yet.",
        advertiseScope: typeof node?.advertiseScope === "string" ? node.advertiseScope : null,
        brokerUrl: typeof node?.brokerUrl === "string" ? node.brokerUrl : null,
        capabilities: Array.isArray(node?.capabilities) ? node.capabilities.map(String) : [],
        labels: Array.isArray(node?.labels) ? node.labels.map(String) : [],
        isLocal: localNodeId === nodeId,
        registeredAtLabel: formatDateTimeLabel(node?.registeredAt) ?? null,
        lastSeenLabel: lastSeenAt ? formatRelativeTime(lastSeenAt) : null,
        projectRoots,
        projectCount: projectRoots.length,
        endpointCount: endpointItems.length,
        reachableEndpointCount,
        workingEndpointCount,
        idleEndpointCount,
        waitingEndpointCount,
        endpoints: endpointItems,
      };
    })
    .sort((left, right) => {
      const rank = (value: ScoutDesktopMachine["status"]) => {
        switch (value) {
          case "online":
            return 0;
          case "degraded":
            return 1;
          case "offline":
            return 2;
        }
      };
      return rank(left.status) - rank(right.status)
        || right.workingEndpointCount - left.workingEndpointCount
        || left.title.localeCompare(right.title);
    });

  return {
    title: "Machines",
    subtitle: `${machines.length} nodes · ${endpoints.length} endpoints`,
    totalMachines: machines.length,
    onlineCount: machines.filter((machine) => machine.status === "online").length,
    degradedCount: machines.filter((machine) => machine.status === "degraded").length,
    offlineCount: machines.filter((machine) => machine.status === "offline").length,
    lastUpdatedLabel: machines.find((machine) => machine.lastSeenLabel)?.lastSeenLabel ?? null,
    machines,
  };
}

function isTaskLikeOperatorMessage(body: string): boolean {
  const normalized = sanitizeRelayBody(body).toLowerCase();
  if (!normalized) {
    return false;
  }
  if (normalized.length >= 24 || normalized.includes("?") || normalized.includes("\n")) {
    return true;
  }
  return /\b(can you|could you|please|review|check|update|build|fix|write|work on|look at|ask|ship|plan|test|deploy|investigate|sync|implement)\b/i.test(normalized);
}

function taskTitleFromBody(body: string): string {
  const normalized = sanitizeRelayBody(body).replace(/\s+/g, " ").trim();
  return normalized.length <= 110 ? normalized : `${normalized.slice(0, 109).trimEnd()}…`;
}

function taskSignalKey(messageId: string, targetAgentId: string): string {
  return `${messageId}::${targetAgentId}`;
}

async function readRegisteredAgentWorkspaces(currentDirectory: string): Promise<AgentWorkspaceRecord[]> {
  try {
    const setup = await loadResolvedRelayAgents({
      currentDirectory,
      ensureCurrentProjectConfig: true,
    });
    const records = [...setup.agents, ...setup.discoveredAgents]
      .map((agent) => {
        const cwd = agent.runtime.cwd?.trim() || agent.projectRoot?.trim();
        if (!cwd) {
          return null;
        }

        const resolvedCwd = path.resolve(expandHomePath(cwd));
        return {
          agentId: agent.agentId,
          project: agent.projectName.trim() || path.basename(resolvedCwd),
          cwd: resolvedCwd,
        };
      })
      .filter((entry): entry is AgentWorkspaceRecord => Boolean(entry));

    return Array.from(
      records.reduce((map, entry) => map.set(entry.cwd, entry), new Map<string, AgentWorkspaceRecord>()).values(),
    );
  } catch {
    return [];
  }
}

async function walkMarkdownFiles(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        files.push(...await walkMarkdownFiles(fullPath));
        continue;
      }
      if (entry.isFile() && fullPath.endsWith(".md")) {
        files.push(fullPath);
      }
    }
    return files;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function parsePlanFrontmatter(source: string): ParsedPlanFrontmatter {
  const normalized = source.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { attributes: {}, body: normalized.trim() };
  }
  const endOfFrontmatter = normalized.indexOf("\n---\n", 4);
  if (endOfFrontmatter === -1) {
    return { attributes: {}, body: normalized.trim() };
  }
  const rawAttributes = normalized.slice(4, endOfFrontmatter).trim();
  const body = normalized.slice(endOfFrontmatter + 5).trim();
  const attributes: Record<string, string> = {};
  for (const line of rawAttributes.split("\n")) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) {
      continue;
    }
    attributes[match[1].trim().toLowerCase()] = match[2].trim();
  }
  return { attributes, body };
}

function parsePlanStatus(value: string | undefined): ScoutDesktopPlan["status"] {
  switch (value) {
    case "awaiting-review":
    case "in-progress":
    case "completed":
    case "paused":
    case "draft":
      return value;
    default:
      return "draft";
  }
}

function extractPlanTitle(attributes: Record<string, string>, body: string, slug: string): string {
  if (attributes.title) {
    return attributes.title;
  }
  const heading = body.match(/^#\s+(.+)$/m);
  if (heading) {
    return heading[1].trim();
  }
  return slug
    .split("-")
    .filter(Boolean)
    .map((segment) => segment[0]?.toUpperCase() + segment.slice(1))
    .join(" ");
}

function extractPlanSummary(attributes: Record<string, string>, body: string): string {
  if (attributes.summary) {
    return attributes.summary;
  }
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (
      trimmed.startsWith("#") ||
      trimmed.startsWith("- ") ||
      trimmed.startsWith("* ") ||
      trimmed.startsWith(">") ||
      /^\d+\.\s/.test(trimmed)
    ) {
      continue;
    }
    return trimmed;
  }
  return "No summary yet.";
}

function countPlanChecklistItems(markdown: string): { stepsCompleted: number; stepsTotal: number } {
  let stepsCompleted = 0;
  let stepsTotal = 0;
  for (const line of markdown.split("\n")) {
    const match = line.match(/^\s*[-*]\s+\[([ xX])\]\s+/);
    if (!match) {
      continue;
    }
    stepsTotal += 1;
    if (match[1].toLowerCase() === "x") {
      stepsCompleted += 1;
    }
  }
  return { stepsCompleted, stepsTotal };
}

function parsePlanTags(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value.split(",").map((tag) => tag.trim()).filter(Boolean);
}

function resolvePlanAgentId(attributes: Record<string, string>, fallback: string): string {
  return attributes.agentid || attributes["agent-id"] || fallback;
}

async function loadWorkspacePlans(
  currentDirectory: string,
  snapshot: RuntimeRegistrySnapshot | null,
): Promise<ScoutDesktopPlan[]> {
  const workspaces = new Map<string, AgentWorkspaceRecord>();

  for (const workspace of await readRegisteredAgentWorkspaces(currentDirectory)) {
    workspaces.set(workspace.cwd, workspace);
  }

  if (snapshot) {
    for (const endpoint of Object.values(snapshot.endpoints)) {
      const cwd = endpoint.projectRoot ?? endpoint.cwd;
      if (!cwd) {
        continue;
      }
      const resolvedCwd = path.resolve(cwd);
      workspaces.set(resolvedCwd, {
        agentId: endpoint.agentId,
        project: String(endpoint.metadata?.project ?? path.basename(resolvedCwd)),
        cwd: resolvedCwd,
      });
    }
  }

  const plans = (await Promise.all(
    Array.from(workspaces.values()).map(async (workspace) => {
      const planFiles = (await Promise.all([
        walkMarkdownFiles(path.join(workspace.cwd, "plans")),
        walkMarkdownFiles(path.join(workspace.cwd, ".openscout", "plans")),
      ])).flat();

      return Promise.all(
        planFiles.map(async (filePath): Promise<ScoutDesktopPlan> => {
          const [source, fileStats] = await Promise.all([
            readFile(filePath, "utf8"),
            stat(filePath),
          ]);
          const { attributes, body } = parsePlanFrontmatter(source);
          const slug = path.basename(filePath, ".md");
          const { stepsCompleted, stepsTotal } = countPlanChecklistItems(body);
          const updatedAt = attributes.updated && !Number.isNaN(Date.parse(attributes.updated))
            ? new Date(attributes.updated).toISOString()
            : fileStats.mtime.toISOString();

          return {
            id: attributes.id || slug.toUpperCase(),
            title: extractPlanTitle(attributes, body, slug),
            summary: extractPlanSummary(attributes, body),
            status: parsePlanStatus(attributes.status),
            stepsCompleted,
            stepsTotal,
            progressPercent: stepsTotal > 0 ? Math.round((stepsCompleted / stepsTotal) * 100) : 0,
            tags: parsePlanTags(attributes.tags),
            agentId: resolvePlanAgentId(attributes, workspace.agentId),
            agent: attributes.agent || workspace.project,
            workspaceName: workspace.project,
            workspacePath: compactHomePath(workspace.cwd) ?? workspace.cwd,
            path: compactHomePath(filePath) ?? filePath,
            updatedAt,
            updatedAtLabel: formatDateTimeLabel(Math.floor(Date.parse(updatedAt) / 1000)) ?? "Unknown",
          };
        }),
      );
    }),
  )).flat().sort((left, right) => (
    Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.title.localeCompare(right.title)
  ));

  return plans;
}

function buildDesktopTasks(snapshot: RuntimeRegistrySnapshot, tmuxSessions: TmuxSession[]): ScoutDesktopTask[] {
  const conversations = snapshot.conversations;
  const messages = Object.values(snapshot.messages)
    .filter((message) => message.metadata?.transportOnly !== "true")
    .sort((left, right) => normalizeTimestamp(right.createdAt) - normalizeTimestamp(left.createdAt));
  const messagesByConversation = buildMessagesByConversation(snapshot);
  const directActivity = buildDirectAgentActivity(snapshot, tmuxSessions, messagesByConversation);
  const latestStatusByTask = new Map<string, { createdAt: number; body: string }>();
  const latestReplyByTask = new Map<string, { createdAt: number; body: string }>();

  for (const message of messages) {
    if (!message.replyToMessageId) {
      continue;
    }
    if (message.class === "status") {
      const targetAgentId = typeof message.metadata?.targetAgentId === "string" ? message.metadata.targetAgentId : null;
      if (!targetAgentId) {
        continue;
      }
      const key = taskSignalKey(message.replyToMessageId, targetAgentId);
      const current = latestStatusByTask.get(key);
      if (!current || normalizeTimestamp(current.createdAt) < normalizeTimestamp(message.createdAt)) {
        latestStatusByTask.set(key, {
          createdAt: message.createdAt,
          body: sanitizeRelayBody(message.body),
        });
      }
      continue;
    }
    if (message.actorId === OPERATOR_ID) {
      continue;
    }
    const key = taskSignalKey(message.replyToMessageId, message.actorId);
    const current = latestReplyByTask.get(key);
    if (!current || normalizeTimestamp(current.createdAt) < normalizeTimestamp(message.createdAt)) {
      latestReplyByTask.set(key, {
        createdAt: message.createdAt,
        body: sanitizeRelayBody(message.body),
      });
    }
  }

  const candidates = messages.flatMap((message) => {
    if (message.actorId !== OPERATOR_ID || !isTaskLikeOperatorMessage(message.body)) {
      return [];
    }
    const conversation = conversations[message.conversationId];
    const targets = inferRecipients(message, conversation)
      .filter((recipient) => recipient !== OPERATOR_ID)
      .filter((recipient) => Boolean(snapshot.agents[recipient]));
    return targets.map((targetAgentId) => ({ message, targetAgentId }));
  });

  const latestTaskIdByAgent = new Map<string, string>();
  for (const candidate of candidates) {
    if (!latestTaskIdByAgent.has(candidate.targetAgentId)) {
      latestTaskIdByAgent.set(candidate.targetAgentId, candidate.message.id);
    }
  }

  return candidates.map(({ message, targetAgentId }) => {
    const key = taskSignalKey(message.id, targetAgentId);
    const reply = latestReplyByTask.get(key) ?? null;
    const statusSignal = latestStatusByTask.get(key) ?? null;
    const activity = directActivity.get(targetAgentId);
    const endpoint = activeEndpoint(snapshot, targetAgentId);
    const agent = snapshot.agents[targetAgentId];
    const projectRoot = endpoint?.projectRoot
      ?? endpoint?.cwd
      ?? (typeof agent?.metadata?.projectRoot === "string" ? agent.metadata.projectRoot : null);
    const project = typeof endpoint?.metadata?.project === "string"
      ? endpoint.metadata.project
      : typeof agent?.metadata?.project === "string"
        ? agent.metadata.project
        : projectRoot
          ? path.basename(projectRoot)
          : null;
    const isLatestTaskForAgent = latestTaskIdByAgent.get(targetAgentId) === message.id;
    let status: ScoutDesktopTaskStatus = "queued";
    let statusLabel = activity?.reachable ? "Queued" : "Pending";
    let statusDetail = activity?.reachable ? "Delivered to the agent." : "Waiting for the agent to come online.";
    let updatedAt = message.createdAt;

    if (reply) {
      status = "completed";
      statusLabel = "Completed";
      statusDetail = `Answered ${formatRelativeTime(reply.createdAt)}`;
      updatedAt = reply.createdAt;
    } else if (statusSignal && /failed|timed out|error/i.test(statusSignal.body)) {
      status = "failed";
      statusLabel = "Failed";
      statusDetail = statusSignal.body;
      updatedAt = statusSignal.createdAt;
    } else if (
      (statusSignal && /working|running|waking|queued/i.test(statusSignal.body)) ||
      (activity?.state === "working" && isLatestTaskForAgent)
    ) {
      status = "running";
      statusLabel = "Running";
      statusDetail = statusSignal?.body || activity?.activeTask || "Working on the latest ask.";
      updatedAt = statusSignal?.createdAt ?? message.createdAt;
    } else if (statusSignal) {
      statusDetail = statusSignal.body;
      updatedAt = statusSignal.createdAt;
    }

    return {
      id: `task:${message.id}:${targetAgentId}`,
      messageId: message.id,
      conversationId: message.conversationId,
      targetAgentId,
      targetAgentName: actorDisplayName(snapshot, targetAgentId),
      project,
      projectRoot: compactHomePath(projectRoot) ?? projectRoot,
      title: taskTitleFromBody(message.body),
      body: sanitizeRelayBody(message.body),
      status,
      statusLabel,
      statusDetail,
      replyPreview: reply?.body ?? null,
      createdAt: message.createdAt,
      createdAtLabel: formatDateTimeLabel(message.createdAt) ?? formatTimeLabel(message.createdAt),
      updatedAtLabel: formatDateTimeLabel(updatedAt) ?? formatTimeLabel(updatedAt),
      ageLabel: formatRelativeTime(message.createdAt),
    };
  }).sort((left, right) => normalizeTimestamp(right.createdAt) - normalizeTimestamp(left.createdAt));
}

function buildReconciliationFindings(
  snapshot: RuntimeRegistrySnapshot,
  tmuxSessions: TmuxSession[],
): ScoutDesktopReconciliationFinding[] {
  const conversations = snapshot.conversations;
  const messages = Object.values(snapshot.messages)
    .filter((message) => message.metadata?.transportOnly !== "true")
    .sort((left, right) => normalizeTimestamp(right.createdAt) - normalizeTimestamp(left.createdAt));
  const messagesByConversation = buildMessagesByConversation(snapshot);
  const directActivity = buildDirectAgentActivity(snapshot, tmuxSessions, messagesByConversation);
  const latestStatusByExpectation = new Map<string, { createdAt: number; body: string }>();
  const latestReplyByExpectation = new Map<string, { createdAt: number; body: string }>();
  const findings = new Map<string, ScoutDesktopReconciliationFinding>();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const latestNonOperatorMessageByConversationAndActor = new Map<string, number>();

  for (const message of messages) {
    if (!message.replyToMessageId) {
      continue;
    }
    if (message.class === "status") {
      const targetAgentId = typeof message.metadata?.targetAgentId === "string" ? message.metadata.targetAgentId : null;
      if (!targetAgentId) {
        continue;
      }
      const key = taskSignalKey(message.replyToMessageId, targetAgentId);
      const current = latestStatusByExpectation.get(key);
      if (!current || normalizeTimestamp(current.createdAt) < normalizeTimestamp(message.createdAt)) {
        latestStatusByExpectation.set(key, {
          createdAt: message.createdAt,
          body: sanitizeRelayBody(message.body),
        });
      }
      continue;
    }
    const key = taskSignalKey(message.replyToMessageId, message.actorId);
    const current = latestReplyByExpectation.get(key);
    if (!current || normalizeTimestamp(current.createdAt) < normalizeTimestamp(message.createdAt)) {
      latestReplyByExpectation.set(key, {
        createdAt: message.createdAt,
        body: sanitizeRelayBody(message.body),
      });
    }

    const conversationActorKey = `${message.conversationId}:${message.actorId}`;
    const latestConversationReplyAt = latestNonOperatorMessageByConversationAndActor.get(conversationActorKey) ?? 0;
    if (normalizeTimestamp(message.createdAt) > latestConversationReplyAt) {
      latestNonOperatorMessageByConversationAndActor.set(conversationActorKey, normalizeTimestamp(message.createdAt));
    }
  }

  for (const message of messages) {
    if (message.class === "status" || message.class === "system" || !isTaskLikeOperatorMessage(message.body)) {
      continue;
    }
    const conversation = conversations[message.conversationId];
    const targets = inferRecipients(message, conversation)
      .filter((recipient) => recipient !== message.actorId)
      .filter((recipient) => Boolean(snapshot.agents[recipient]));

    for (const targetAgentId of targets) {
      const key = taskSignalKey(message.id, targetAgentId);
      const reply = latestReplyByExpectation.get(key) ?? null;
      if (reply) {
        continue;
      }
      const latestConversationReplyAt = latestNonOperatorMessageByConversationAndActor.get(
        `${message.conversationId}:${targetAgentId}`,
      ) ?? 0;
      if (latestConversationReplyAt > normalizeTimestamp(message.createdAt)) {
        continue;
      }
      const statusSignal = latestStatusByExpectation.get(key) ?? null;
      const activity = directActivity.get(targetAgentId);
      const createdAt = normalizeTimestamp(message.createdAt);
      const ageSeconds = Math.max(0, nowSeconds - createdAt);
      const requesterName = actorDisplayName(snapshot, message.actorId);
      const targetAgentName = actorDisplayName(snapshot, targetAgentId);
      const title = `${requesterName} is waiting on ${targetAgentName}`;
      const baseFinding = {
        requesterId: message.actorId,
        requesterName,
        targetAgentId,
        targetAgentName,
        conversationId: message.conversationId,
        messageId: message.id,
        recordId: null,
        ageLabel: formatRelativeTime(message.createdAt),
      };

      if (!activity?.reachable && ageSeconds >= RECONCILE_OFFLINE_WAIT_SECONDS) {
        findings.set(`finding:${key}:offline`, {
          id: `finding:${key}:offline`,
          kind: "agent_offline",
          severity: "error",
          title,
          summary: `${targetAgentName} has not started handling this ask.`,
          detail: `${targetAgentName} looks offline while ${requesterName} is still waiting on: ${taskTitleFromBody(message.body)}`,
          updatedAtLabel: null,
          ...baseFinding,
        });
        continue;
      }

      if (statusSignal && /working|running|waking|queued/i.test(statusSignal.body)) {
        const statusAgeSeconds = Math.max(0, nowSeconds - normalizeTimestamp(statusSignal.createdAt));
        if (statusAgeSeconds >= RECONCILE_STALE_WORKING_SECONDS) {
          findings.set(`finding:${key}:stale-working`, {
            id: `finding:${key}:stale-working`,
            kind: "stale_working",
            severity: "warning",
            title,
            summary: `${targetAgentName} said it was working, but nothing else happened.`,
            detail: statusSignal.body,
            updatedAtLabel: formatRelativeTime(statusSignal.createdAt),
            ...baseFinding,
          });
        }
        continue;
      }

      if (!statusSignal && ageSeconds >= RECONCILE_NO_FOLLOW_UP_SECONDS) {
        findings.set(`finding:${key}:no-follow-up`, {
          id: `finding:${key}:no-follow-up`,
          kind: "no_follow_up",
          severity: "warning",
          title,
          summary: `${targetAgentName} has not acknowledged or answered this ask.`,
          detail: taskTitleFromBody(message.body),
          updatedAtLabel: null,
          ...baseFinding,
        });
      }
    }
  }

  for (const record of Object.values(snapshot.collaborationRecords ?? {}) as CollaborationRecord[]) {
    const recordValue = record as unknown as Record<string, unknown>;
    const nextMoveOwnerId = typeof recordValue.nextMoveOwnerId === "string" ? recordValue.nextMoveOwnerId : null;
    const ownerId = typeof recordValue.ownerId === "string" ? recordValue.ownerId : null;
    const waitingOn = typeof recordValue.waitingOn === "object" && recordValue.waitingOn ? recordValue.waitingOn as Record<string, unknown> : null;
    const targetId = typeof waitingOn?.targetId === "string" ? waitingOn.targetId : null;
    const waitingKind = typeof waitingOn?.kind === "string" ? waitingOn.kind : null;
    const updatedAt = typeof recordValue.updatedAt === "number" ? recordValue.updatedAt : 0;
    const recordId = typeof recordValue.id === "string" ? recordValue.id : null;
    const title = typeof recordValue.title === "string" ? recordValue.title : "Open item";
    if (!recordId || !nextMoveOwnerId || waitingKind !== "actor" || !targetId) {
      continue;
    }

    const targetActivity = directActivity.get(targetId);
    const staleSeconds = Math.max(0, nowSeconds - normalizeTimestamp(updatedAt));
    if (targetActivity?.reachable || staleSeconds < RECONCILE_NO_FOLLOW_UP_SECONDS) {
      continue;
    }

    findings.set(`finding:record:${recordId}`, {
      id: `finding:record:${recordId}`,
      kind: "waiting_on_record",
      severity: "error",
      title: `${actorDisplayName(snapshot, nextMoveOwnerId)} is blocked on ${actorDisplayName(snapshot, targetId)}`,
      summary: title,
      detail: typeof waitingOn?.label === "string" ? waitingOn.label : null,
      requesterId: ownerId ?? nextMoveOwnerId,
      requesterName: actorDisplayName(snapshot, ownerId ?? nextMoveOwnerId),
      targetAgentId: targetId,
      targetAgentName: actorDisplayName(snapshot, targetId),
      conversationId: typeof recordValue.conversationId === "string" ? recordValue.conversationId : null,
      messageId: null,
      recordId,
      ageLabel: formatRelativeTime(updatedAt),
      updatedAtLabel: formatRelativeTime(updatedAt),
    });
  }

  const latestFindingByPair = new Map<string, ScoutDesktopReconciliationFinding>();
  const findingTimestamp = (finding: ScoutDesktopReconciliationFinding) => {
    if (finding.messageId) {
      return normalizeTimestamp(snapshot.messages[finding.messageId]?.createdAt ?? 0);
    }
    if (finding.recordId) {
      const record = snapshot.collaborationRecords?.[finding.recordId] as unknown as Record<string, unknown> | undefined;
      return normalizeTimestamp(typeof record?.updatedAt === "number" ? record.updatedAt : 0);
    }
    return 0;
  };
  const severityRank = (value: ScoutDesktopReconciliationFinding["severity"]) => value === "error" ? 0 : 1;

  for (const finding of findings.values()) {
    const pairKey = `${finding.requesterId ?? "none"}:${finding.targetAgentId ?? "none"}`;
    const current = latestFindingByPair.get(pairKey);
    if (!current) {
      latestFindingByPair.set(pairKey, finding);
      continue;
    }
    const currentTimestamp = findingTimestamp(current);
    const nextTimestamp = findingTimestamp(finding);
    if (
      nextTimestamp > currentTimestamp ||
      (nextTimestamp === currentTimestamp && severityRank(finding.severity) < severityRank(current.severity))
    ) {
      latestFindingByPair.set(pairKey, finding);
    }
  }

  return Array.from(latestFindingByPair.values()).sort((left, right) => {
    return severityRank(left.severity) - severityRank(right.severity)
      || findingTimestamp(right) - findingTimestamp(left)
      || left.title.localeCompare(right.title);
  });
}

async function buildPlansState(
  currentDirectory: string,
  snapshot: RuntimeRegistrySnapshot | null,
  tmuxSessions: TmuxSession[],
  options: {
    includeWorkspacePlans?: boolean;
  } = {},
): Promise<ScoutDesktopPlansState> {
  const includeWorkspacePlans = options.includeWorkspacePlans ?? true;
  const [plans, tasks, findings] = await Promise.all([
    includeWorkspacePlans ? loadWorkspacePlans(currentDirectory, snapshot) : Promise.resolve([]),
    Promise.resolve(snapshot ? buildDesktopTasks(snapshot, tmuxSessions) : []),
    Promise.resolve(snapshot ? buildReconciliationFindings(snapshot, tmuxSessions) : []),
  ]);
  const workspaceCount = new Set(plans.map((plan) => plan.workspacePath)).size;
  const runningTaskCount = tasks.filter((task) => task.status === "running").length;
  const failedTaskCount = tasks.filter((task) => task.status === "failed").length;
  const completedTaskCount = tasks.filter((task) => task.status === "completed").length;
  const warningCount = findings.filter((finding) => finding.severity === "warning").length;
  const errorCount = findings.filter((finding) => finding.severity === "error").length;
  const latestTask = tasks[0];
  const latestPlan = plans[0];
  const latestFinding = findings[0];
  const latestPlanLabel = latestPlan ? formatRelativeTime(Math.floor(Date.parse(latestPlan.updatedAt) / 1000)) : null;

  return {
    title: "Plans",
    subtitle: `${tasks.length} asks · ${findings.length} findings · ${plans.length} plans · ${workspaceCount} workspaces`,
    taskCount: tasks.length,
    runningTaskCount,
    failedTaskCount,
    completedTaskCount,
    findingCount: findings.length,
    warningCount,
    errorCount,
    planCount: plans.length,
    workspaceCount,
    lastUpdatedLabel: latestFinding?.updatedAtLabel ?? latestTask?.ageLabel ?? latestPlanLabel,
    tasks,
    findings,
    plans,
  };
}

function buildRelayMessages(snapshot: RuntimeRegistrySnapshot): ScoutRelayMessage[] {
  const messages = Object.values(snapshot.messages)
    .filter((message) => message.metadata?.transportOnly !== "true")
    .sort((left, right) => normalizeTimestamp(left.createdAt) - normalizeTimestamp(right.createdAt));

  return messages.map((message) => {
    const conversation = snapshot.conversations[message.conversationId];
    const channel = normalizedChannel(conversation);
    const recipients = inferRecipients(message, conversation);
    const endpoint = activeEndpoint(snapshot, message.actorId);
    const provenanceParts = [
      endpoint?.transport,
      endpoint?.harness,
      endpoint?.cwd ? path.basename(endpoint.cwd) : null,
    ].filter(Boolean) as string[];

    return {
      id: message.id,
      clientMessageId: typeof message.metadata?.clientMessageId === "string" ? message.metadata.clientMessageId : null,
      conversationId: message.conversationId,
      createdAt: message.createdAt,
      replyToMessageId: message.replyToMessageId ?? null,
      authorId: message.actorId,
      authorName: actorDisplayName(snapshot, message.actorId),
      authorRole: actorRole(snapshot, message.actorId),
      body: sanitizeRelayBody(message.body),
      timestampLabel: formatTimeLabel(message.createdAt),
      dayLabel: formatDayLabel(message.createdAt),
      normalizedChannel: channel,
      recipients,
      isDirectConversation: conversation?.kind === "direct" || conversation?.id.startsWith("dm.") === true,
      isSystem: message.class === "system" || channel === "system" || conversation?.kind === "system",
      isVoice: channel === "voice" || Boolean(spokenTextForMessage(message)),
      messageClass: message.class,
      routingSummary: recipients.length > 0 ? `Targets ${recipients.map((id) => actorDisplayName(snapshot, id)).join(", ")}` : null,
      provenanceSummary: provenanceParts.length > 0 ? `via ${provenanceParts.join(" · ")}` : null,
      provenanceDetail: endpoint?.projectRoot ?? endpoint?.cwd ?? null,
      isOperator: message.actorId === OPERATOR_ID,
      avatarLabel: actorDisplayName(snapshot, message.actorId).slice(0, 1).toUpperCase(),
      avatarColor: colorForIdentity(message.actorId),
      receipt: null,
    };
  });
}

function buildRelayDirects(
  snapshot: RuntimeRegistrySnapshot,
  activityByAgent: Map<string, DirectAgentActivity>,
  messagesByConversation: Map<string, MessageRecord[]>,
  visibleAgentIds: Set<string>,
): ScoutRelayDirectThread[] {
  return Object.values(snapshot.agents)
    .filter((agent) => visibleAgentIds.has(agent.id))
    .sort((left, right) => actorDisplayName(snapshot, left.id).localeCompare(actorDisplayName(snapshot, right.id)))
    .map((agent) => {
      const directMessages = messagesByConversation.get(directConversationId(agent.id)) ?? [];
      const latestMessage = directMessages.at(-1) ?? null;
      const previewMessage = [...directMessages].reverse().find((message) => (
        message.class !== "status" && message.class !== "system"
      )) ?? latestMessage;
      const subtitle = typeof agent.metadata?.role === "string"
        ? agent.metadata.role
        : typeof agent.metadata?.summary === "string"
          ? agent.metadata.summary
          : "Agent";
      const activity = activityByAgent.get(agent.id) ?? inactiveDirectAgentActivity(agent, null, null);

      return {
        kind: "direct",
        id: agent.id,
        title: actorDisplayName(snapshot, agent.id),
        subtitle,
        preview: previewMessage ? sanitizeRelayBody(previewMessage.body) : null,
        timestampLabel: latestMessage ? formatTimeLabel(latestMessage.createdAt) : null,
        state: activity.state,
        reachable: activity.reachable,
        statusLabel: activity.statusLabel,
        statusDetail: activity.statusDetail,
        activeTask: activity.activeTask,
      };
    });
}

function attachRelayReceipts(
  snapshot: RuntimeRegistrySnapshot,
  messages: ScoutRelayMessage[],
  activityByAgent: Map<string, DirectAgentActivity>,
): ScoutRelayMessage[] {
  const latestStatusByReplyTo = new Map<string, { createdAt: number; body: string; targetAgentId: string | null }>();
  const latestReplyByReplyTo = new Map<string, { createdAt: number; authorId: string }>();
  const latestOperatorDirectMessageByAgent = new Map<string, string>();

  for (const message of messages) {
    if (!message.isOperator || !message.isDirectConversation) {
      continue;
    }
    const targetAgentId = message.recipients.find((recipient) => recipient !== OPERATOR_ID);
    if (targetAgentId) {
      latestOperatorDirectMessageByAgent.set(targetAgentId, message.id);
    }
  }

  for (const message of Object.values(snapshot.messages)) {
    if (message.metadata?.transportOnly === "true" || !message.replyToMessageId) {
      continue;
    }
    if (message.class === "status") {
      const current = latestStatusByReplyTo.get(message.replyToMessageId);
      if (!current || normalizeTimestamp(current.createdAt) < normalizeTimestamp(message.createdAt)) {
        latestStatusByReplyTo.set(message.replyToMessageId, {
          createdAt: message.createdAt,
          body: sanitizeRelayBody(message.body),
          targetAgentId: typeof message.metadata?.targetAgentId === "string" ? message.metadata.targetAgentId : null,
        });
      }
      continue;
    }
    if (message.actorId === OPERATOR_ID) {
      continue;
    }
    const current = latestReplyByReplyTo.get(message.replyToMessageId);
    if (!current || normalizeTimestamp(current.createdAt) < normalizeTimestamp(message.createdAt)) {
      latestReplyByReplyTo.set(message.replyToMessageId, {
        createdAt: message.createdAt,
        authorId: message.actorId,
      });
    }
  }

  return messages.map((message) => {
    if (!message.isOperator || !message.isDirectConversation) {
      return message;
    }
    const targetAgentId = message.recipients.find((recipient) => recipient !== OPERATOR_ID);
    if (!targetAgentId) {
      return message;
    }
    const isLatestForAgent = latestOperatorDirectMessageByAgent.get(targetAgentId) === message.id;
    const reply = latestReplyByReplyTo.get(message.id);
    if (reply && reply.authorId === targetAgentId) {
      return {
        ...message,
        receipt: {
          state: "replied",
          label: "Replied",
          detail: formatRelativeTime(reply.createdAt),
        },
      };
    }
    const status = latestStatusByReplyTo.get(message.id);
    if (status && (!status.targetAgentId || status.targetAgentId === targetAgentId)) {
      return {
        ...message,
        receipt: {
          state: "seen",
          label: "Seen",
          detail: null,
        },
      };
    }
    const activity = activityByAgent.get(targetAgentId);
    if (activity?.state === "working" && isLatestForAgent) {
      return {
        ...message,
        receipt: {
          state: "working",
          label: "Working",
          detail: activity.activeTask ?? activity.statusDetail ?? null,
        },
      };
    }
    if (activity?.reachable && isLatestForAgent) {
      return {
        ...message,
        receipt: {
          state: "seen",
          label: "Seen",
          detail: null,
        },
      };
    }
    if (activity?.reachable) {
      return {
        ...message,
        receipt: {
          state: "delivered",
          label: "Delivered",
          detail: null,
        },
      };
    }
    return {
      ...message,
      receipt: {
        state: "sent",
        label: "Sent",
        detail: null,
      },
    };
  });
}

function relayMessageCount(messages: ScoutRelayMessage[], predicate: (message: ScoutRelayMessage) => boolean): number {
  return messages.filter(predicate).length;
}

function isRelaySharedConversationMessage(message: ScoutRelayMessage): boolean {
  return !message.isDirectConversation &&
    !message.isSystem &&
    !message.isVoice &&
    message.messageClass !== "status" &&
    (!message.normalizedChannel || message.normalizedChannel === "shared");
}

function isRelaySystemMessage(message: ScoutRelayMessage): boolean {
  return message.isSystem;
}

function isRelayVoiceMessage(message: ScoutRelayMessage): boolean {
  return message.isVoice;
}

function isRelayAllTrafficMessage(message: ScoutRelayMessage): boolean {
  return !message.isVoice;
}

function isRelayCoordinationMessage(message: ScoutRelayMessage): boolean {
  return !message.isVoice &&
    !message.isSystem &&
    (message.isDirectConversation || message.recipients.length > 0 || message.messageClass === "status");
}

function isRelayMentionMessage(message: ScoutRelayMessage): boolean {
  return !message.isDirectConversation &&
    !message.isSystem &&
    !message.isVoice &&
    message.messageClass !== "status" &&
    message.recipients.length > 0;
}

function buildRelayState(
  snapshot: RuntimeRegistrySnapshot,
  tmuxSessions: TmuxSession[],
  configuredAgentIds: Set<string>,
  shared?: RelayWorkspaceDerivation,
): ScoutRelayState {
  const derivation = shared ?? buildRelayWorkspaceDerivation(snapshot, tmuxSessions, configuredAgentIds);
  const { messagesByConversation, directActivity, visibleAgentIds } = derivation;
  const messages = attachRelayReceipts(snapshot, buildRelayMessages(snapshot), directActivity);
  const directs = buildRelayDirects(snapshot, directActivity, messagesByConversation, visibleAgentIds);

  const channels: ScoutRelayNavItem[] = [
    {
      kind: "channel",
      id: "shared",
      title: "# shared-channel",
      subtitle: "Broadcast updates and shared context.",
      count: relayMessageCount(messages, isRelaySharedConversationMessage),
    },
    {
      kind: "channel",
      id: "voice",
      title: "# voice",
      subtitle: "Voice-related chat, transcripts, and spoken updates.",
      count: relayMessageCount(messages, isRelayVoiceMessage),
    },
    {
      kind: "channel",
      id: "system",
      title: "# system",
      subtitle: "Infrastructure, lifecycle, and broker state events.",
      count: relayMessageCount(messages, isRelaySystemMessage),
    },
  ];

  const views: ScoutRelayNavItem[] = [
    {
      kind: "filter",
      id: "all-traffic",
      title: "All Traffic",
      subtitle: "Every non-voice message across the workspace.",
      count: relayMessageCount(messages, isRelayAllTrafficMessage),
    },
    {
      kind: "filter",
      id: "coordination",
      title: "Coordination",
      subtitle: "Targeted messages, direct threads, and task handoffs.",
      count: relayMessageCount(messages, isRelayCoordinationMessage),
    },
    {
      kind: "filter",
      id: "mentions",
      title: "Mentions",
      subtitle: "Focused view over shared-channel targeted messages.",
      count: relayMessageCount(messages, isRelayMentionMessage),
    },
  ];

  return {
    title: "Relay",
    subtitle: `${messages.length} messages · ${directs.length} agents`,
    transportTitle: "Broker-backed",
    meshTitle: "Local mesh",
    syncLine: "Live sync",
    operatorId: OPERATOR_ID,
    channels,
    views,
    directs,
    messages,
    voice: createScoutVoiceState(),
    lastUpdatedLabel: messages.at(-1)
      ? formatRelativeTime(normalizeTimestamp(snapshot.messages[messages.at(-1)?.id ?? ""]?.createdAt ?? 0))
      : null,
  };
}

function interAgentProfileKind(agent: AgentDefinition): "project" | "role" | "system" {
  if (agent.agentClass === "system") {
    return "system";
  }
  if (agent.metadata?.source === "relay-agent-registry") {
    return "project";
  }
  return "role";
}

function buildInterAgentState(
  snapshot: RuntimeRegistrySnapshot,
  tmuxSessions: TmuxSession[],
  configuredAgentIds: Set<string>,
  options?: { includeProjectGitActivity?: boolean },
  shared?: RelayWorkspaceDerivation,
): ScoutInterAgentState {
  const conversations = Object.values(snapshot.conversations);
  const derivation = shared ?? buildRelayWorkspaceDerivation(snapshot, tmuxSessions, configuredAgentIds);
  const { messagesByConversation, directActivity, visibleAgentIds } = derivation;
  const tmuxSessionCreatedAt = new Map(
    tmuxSessions.map((session) => [session.name, normalizeTimestamp(session.createdAt ?? 0)]),
  );

  type ThreadAccumulator = {
    id: string;
    conversationId: string | null;
    title: string;
    participants: ScoutInterAgentParticipant[];
    sourceKind: "private" | "projected";
    sourceConversationIds: Set<string>;
    messageIdSet: Set<string>;
    messages: MessageRecord[];
  };

  const threadMap = new Map<string, ThreadAccumulator>();

  const ensureThread = (
    participantIds: string[],
    sourceKind: "private" | "projected",
    conversationId: string | null = null,
    title?: string,
  ): ThreadAccumulator | null => {
    const normalizedParticipantIds = interAgentParticipantIds(snapshot, participantIds, visibleAgentIds);
    if (normalizedParticipantIds.length < 2) {
      return null;
    }
    const threadId = interAgentThreadKey(normalizedParticipantIds);
    const existing = threadMap.get(threadId);
    if (existing) {
      if (sourceKind === "private") {
        existing.sourceKind = "private";
        existing.conversationId = conversationId ?? existing.conversationId;
      }
      if (title && !existing.title) {
        existing.title = title;
      }
      if (conversationId) {
        existing.sourceConversationIds.add(conversationId);
      }
      return existing;
    }

    const participants = normalizedParticipantIds.map((participantId) => ({
      id: participantId,
      title: actorDisplayName(snapshot, participantId),
      role: actorRole(snapshot, participantId),
    }));
    const thread = {
      id: threadId,
      conversationId,
      title: title || participants.map((participant) => participant.title).join(" ↔ "),
      participants,
      sourceKind,
      sourceConversationIds: new Set(conversationId ? [conversationId] : []),
      messageIdSet: new Set<string>(),
      messages: [],
    };
    threadMap.set(threadId, thread);
    return thread;
  };

  const appendMessages = (thread: ThreadAccumulator | null, messages: MessageRecord[], conversationId: string) => {
    if (!thread) {
      return;
    }
    thread.sourceConversationIds.add(conversationId);
    for (const message of messages) {
      if (thread.messageIdSet.has(message.id)) {
        continue;
      }
      thread.messageIdSet.add(message.id);
      thread.messages.push(message);
    }
  };

  for (const conversation of conversations.filter((entry) => isInterAgentConversation(snapshot, entry))) {
    const thread = ensureThread(conversation.participantIds, "private", conversation.id, conversation.title);
    appendMessages(thread, messagesByConversation.get(conversation.id) ?? [], conversation.id);
  }

  for (const [conversationId, messages] of messagesByConversation.entries()) {
    const conversation = snapshot.conversations[conversationId];
    if (conversation && isInterAgentConversation(snapshot, conversation)) {
      continue;
    }
    for (const message of messages) {
      if (!isKnownCounterpart(snapshot, message.actorId, visibleAgentIds)) {
        continue;
      }
      const recipients = inferRecipients(message, conversation)
        .filter((recipientId) => recipientId !== OPERATOR_ID && recipientId !== message.actorId)
        .filter((recipientId) => isKnownCounterpart(snapshot, recipientId, visibleAgentIds));
      if (recipients.length === 0) {
        continue;
      }
      const projectedParticipantIds = interAgentParticipantIds(snapshot, [message.actorId, ...recipients], visibleAgentIds);
      if (projectedParticipantIds.length < 2 || projectedParticipantIds.length > 3) {
        continue;
      }
      if (!projectedParticipantIds.some((participantId) => isKnownVisibleAgent(snapshot, participantId, visibleAgentIds))) {
        continue;
      }
      const thread = ensureThread(projectedParticipantIds, "projected");
      appendMessages(thread, [message], conversationId);
    }
  }

  const threadsWithTimestamp = Array.from(threadMap.values())
    .map((thread) => {
      const orderedMessages = [...thread.messages].sort((left, right) => normalizeTimestamp(left.createdAt) - normalizeTimestamp(right.createdAt));
      const latestMessage = orderedMessages.at(-1) ?? null;
      const previewMessage = [...orderedMessages].reverse().find((message) => (
        message.class !== "status" && message.class !== "system"
      )) ?? latestMessage;
      return {
        id: thread.id,
        conversationId: thread.conversationId,
        title: thread.title,
        subtitle: latestMessage ? `Last from ${actorDisplayName(snapshot, latestMessage.actorId)}` : `${thread.participants.length} agents`,
        preview: previewMessage ? sanitizeRelayBody(previewMessage.body) : null,
        timestampLabel: latestMessage ? formatTimeLabel(latestMessage.createdAt) : null,
        messageCount: orderedMessages.length,
        latestAuthorName: latestMessage ? actorDisplayName(snapshot, latestMessage.actorId) : null,
        messageIds: orderedMessages.map((message) => message.id),
        sourceKind: thread.sourceKind,
        participants: thread.participants,
        latestTimestamp: normalizeTimestamp(latestMessage?.createdAt ?? 0),
      };
    })
    .sort((left, right) => right.latestTimestamp - left.latestTimestamp || left.title.localeCompare(right.title));

  const agentThreadSummary = threadsWithTimestamp.reduce((map, thread) => {
    for (const participant of thread.participants) {
      const entry = map.get(participant.id) ?? {
        threadCount: 0,
        counterpartIds: new Set<string>(),
        latestTimestamp: 0,
      };
      entry.threadCount += 1;
      entry.latestTimestamp = Math.max(entry.latestTimestamp, thread.latestTimestamp);
      for (const counterpart of thread.participants) {
        if (counterpart.id !== participant.id) {
          entry.counterpartIds.add(counterpart.id);
        }
      }
      map.set(participant.id, entry);
    }
    return map;
  }, new Map<string, { threadCount: number; counterpartIds: Set<string>; latestTimestamp: number }>());

  const agents: ScoutInterAgentAgent[] = Object.values(snapshot.agents)
    .filter((agent) => visibleAgentIds.has(agent.id))
    .map((agent) => {
      const entry = agentThreadSummary.get(agent.id) ?? {
        threadCount: 0,
        counterpartIds: new Set<string>(),
        latestTimestamp: 0,
      };
      const endpoint = activeEndpoint(snapshot, agent.id);
      const activity = directActivity.get(agent.id) ?? inactiveDirectAgentActivity(agent, null, null);
      const projectRoot = endpoint?.projectRoot
        ?? endpoint?.cwd
        ?? (typeof agent.metadata?.projectRoot === "string" ? agent.metadata.projectRoot : null);
      const endpointSessionAt = normalizeTimestamp(
        typeof endpoint?.metadata?.lastCompletedAt === "number"
          ? endpoint.metadata.lastCompletedAt
          : typeof endpoint?.metadata?.lastStartedAt === "number"
            ? endpoint.metadata.lastStartedAt
            : 0,
      );
      const endpointStartedAt = normalizeTimestamp(
        typeof endpoint?.metadata?.startedAt === "string"
          ? Number(endpoint.metadata.startedAt)
          : typeof endpoint?.metadata?.startedAt === "number"
            ? endpoint.metadata.startedAt
            : 0,
      );
      const tmuxCreatedAt = normalizeTimestamp(tmuxSessionCreatedAt.get(endpoint?.sessionId ?? `relay-${agent.id}`) ?? 0);
      const lastChatAt = Math.max(entry.latestTimestamp, activity.lastMessageAt ?? 0) || null;
      const lastSessionAt = Math.max(endpointSessionAt, endpointStartedAt, tmuxCreatedAt) || null;
      const codeActivity = options?.includeProjectGitActivity === false
        ? {
            lastCodeChangeAt: null,
            lastCodeChangeLabel: null,
          }
        : readProjectGitActivity(projectRoot);
      const counterpartCount = entry.counterpartIds.size;

      return {
        id: agent.id,
        title: actorDisplayName(snapshot, agent.id),
        subtitle: entry.threadCount === 0
          ? "No active channels yet"
          : counterpartCount === 1
            ? "1 counterpart"
            : `${counterpartCount} counterparts`,
        definitionId: typeof agent.definitionId === "string" ? agent.definitionId : null,
        selector: typeof agent.metadata?.selector === "string" ? agent.metadata.selector : null,
        defaultSelector: typeof agent.metadata?.defaultSelector === "string" ? agent.metadata.defaultSelector : null,
        nodeQualifier: typeof agent.metadata?.nodeQualifier === "string" ? agent.metadata.nodeQualifier : null,
        workspaceQualifier: typeof agent.metadata?.workspaceQualifier === "string" ? agent.metadata.workspaceQualifier : null,
        branch: typeof agent.metadata?.branch === "string" ? agent.metadata.branch : null,
        profileKind: interAgentProfileKind(agent),
        registrationKind: "configured" as const,
        source: typeof agent.metadata?.source === "string" ? agent.metadata.source : null,
        agentClass: typeof agent.agentClass === "string" ? agent.agentClass : null,
        role: typeof agent.metadata?.role === "string" ? agent.metadata.role : null,
        summary: typeof agent.metadata?.summary === "string" ? agent.metadata.summary : null,
        harness: endpoint?.harness ?? null,
        transport: endpoint?.transport ?? null,
        cwd: endpoint?.cwd ?? null,
        projectRoot,
        sessionId: endpoint?.sessionId ?? null,
        wakePolicy: typeof agent.wakePolicy === "string" ? agent.wakePolicy : null,
        capabilities: Array.isArray(agent.capabilities) ? agent.capabilities.map(String) : [],
        threadCount: entry.threadCount,
        counterpartCount,
        timestampLabel: lastChatAt ? formatTimeLabel(lastChatAt) : null,
        lastChatAt,
        lastChatLabel: lastChatAt ? formatRelativeTime(lastChatAt) : null,
        lastCodeChangeAt: codeActivity.lastCodeChangeAt,
        lastCodeChangeLabel: codeActivity.lastCodeChangeLabel,
        lastSessionAt,
        lastSessionLabel: lastSessionAt ? formatRelativeTime(lastSessionAt) : null,
        state: activity.state,
        reachable: activity.reachable,
        statusLabel: activity.statusLabel,
        statusDetail: activity.statusDetail,
      };
    })
    .sort((left, right) => right.threadCount - left.threadCount || left.title.localeCompare(right.title));

  const threads: ScoutInterAgentThread[] = threadsWithTimestamp.map(({ latestTimestamp: _latestTimestamp, ...thread }) => thread);

  return {
    title: "Inter-Agent",
    subtitle: `${threads.length} agent threads · ${agents.length} agents`,
    agents,
    threads,
    lastUpdatedLabel: threadsWithTimestamp[0] ? formatRelativeTime(threadsWithTimestamp[0].latestTimestamp) : null,
  };
}

function buildSessions(snapshot: RuntimeRegistrySnapshot): ScoutSessionMetadata[] {
  const conversations = Object.values(snapshot.conversations);
  const messagesByConversation = new Map<string, MessageRecord[]>();

  for (const message of Object.values(snapshot.messages)) {
    const bucket = messagesByConversation.get(message.conversationId) ?? [];
    bucket.push(message);
    messagesByConversation.set(message.conversationId, bucket);
  }

  return conversations.map((conversation) => {
    const messages = (messagesByConversation.get(conversation.id) ?? [])
      .sort((left, right) => normalizeTimestamp(left.createdAt) - normalizeTimestamp(right.createdAt));
    const latestMessage = messages.at(-1);
    const firstMessage = messages[0];
    const nonOperator = conversation.participantIds.find((participant) => participant !== OPERATOR_ID) ?? OPERATOR_ID;
    const title = conversation.kind === "direct"
      ? `Direct · ${actorDisplayName(snapshot, nonOperator)}`
      : conversation.title;
    const project = conversation.kind === "direct"
      ? nonOperator
      : normalizedChannel(conversation) ?? "relay";

    return {
      id: conversation.id,
      project,
      agent: actorDisplayName(snapshot, nonOperator),
      title,
      messageCount: messages.length,
      createdAt: isoFromTimestamp(firstMessage?.createdAt ?? Math.floor(Date.now() / 1000)),
      lastModified: isoFromTimestamp(latestMessage?.createdAt ?? Math.floor(Date.now() / 1000)),
      preview: latestMessage?.body ?? conversation.title,
      tags: [conversation.kind, ...(normalizedChannel(conversation) ? [normalizedChannel(conversation) as string] : [])],
      model: typeof snapshot.agents[nonOperator]?.metadata?.source === "string"
        ? snapshot.agents[nonOperator]?.metadata?.source
        : undefined,
      tokens: undefined,
    };
  }).sort((left, right) => Date.parse(right.lastModified) - Date.parse(left.lastModified));
}

function buildMessagesState(
  relay: ScoutRelayState,
  interAgent: ScoutInterAgentState,
): ScoutMessagesState {
  const inboxThreads: ScoutMessagesThread[] = relay.views.map((item) => ({
    id: `relay:${item.kind}:${item.id}`,
    group: "inbox",
    kind: "relay",
    title: item.title,
    subtitle: item.subtitle,
    preview: null,
    timestampLabel: relay.lastUpdatedLabel,
    count: item.count,
    state: null,
    reachable: true,
    relayDestinationKind: item.kind,
    relayDestinationId: item.id,
    interAgentThreadId: null,
  }));

  const channelThreads: ScoutMessagesThread[] = relay.channels.map((item) => ({
    id: `relay:${item.kind}:${item.id}`,
    group: "channels",
    kind: "relay",
    title: item.title,
    subtitle: item.subtitle,
    preview: null,
    timestampLabel: relay.lastUpdatedLabel,
    count: item.count,
    state: null,
    reachable: true,
    relayDestinationKind: item.kind,
    relayDestinationId: item.id,
    interAgentThreadId: null,
  }));

  const agentThreads: ScoutMessagesThread[] = relay.directs.map((thread) => ({
    id: `relay:direct:${thread.id}`,
    group: "agents",
    kind: "relay",
    title: thread.title,
    subtitle: thread.subtitle,
    preview: thread.preview,
    timestampLabel: thread.timestampLabel,
    count: null,
    state: thread.state,
    reachable: thread.reachable,
    relayDestinationKind: "direct",
    relayDestinationId: thread.id,
    interAgentThreadId: null,
  }));

  const internalThreads: ScoutMessagesThread[] = interAgent.threads.map((thread) => ({
    id: `internal:${thread.id}`,
    group: "internal",
    kind: "internal",
    title: thread.title,
    subtitle: thread.subtitle,
    preview: thread.preview,
    timestampLabel: thread.timestampLabel,
    count: thread.messageCount,
    state: null,
    reachable: true,
    relayDestinationKind: null,
    relayDestinationId: null,
    interAgentThreadId: thread.id,
  }));

  const threads = [
    ...inboxThreads,
    ...channelThreads,
    ...agentThreads,
    ...internalThreads,
  ];

  return {
    title: "Messages",
    subtitle: `${threads.length} threads · ${relay.messages.length} messages`,
    lastUpdatedLabel: relay.lastUpdatedLabel ?? interAgent.lastUpdatedLabel,
    threads,
  };
}

export async function composeScoutDesktopServicesState(): Promise<ScoutDesktopServicesState> {
  const measurement = startLoadMeasurement();
  const [health, helper] = await Promise.all([
    measureAsyncStep(measurement, "broker health", () => readScoutBrokerHealth()),
    measureAsyncStep(measurement, "helper status", async () => Promise.resolve(readHelperStatus())),
  ]);

  const servicesState = measureStep(measurement, "compose services", () => buildServicesStateFromHealth(health, helper));
  return {
    ...servicesState,
    performance: finalizeLoadMeasurement(measurement),
  };
}

export async function composeScoutDesktopHomeState(input: {
  currentDirectory: string;
}): Promise<ScoutDesktopHomeState> {
  const measurement = startLoadMeasurement();
  const home = await measureAsyncStep(measurement, "broker home", () => readScoutBrokerHome());
  if (home) {
    const agents = measureStep(measurement, "map home agents", () => home.agents.map((agent) => ({
      ...agent,
      projectRoot: compactHomePath(agent.projectRoot) ?? agent.projectRoot,
      timestampLabel: agent.lastSeenAt ? formatTimeLabel(agent.lastSeenAt) : null,
    })));
    const activity = measureStep(measurement, "map home activity", () => home.activity.map((item) => ({
      ...item,
      conversationId: item.conversationId ?? item.id,
      timestampLabel: formatTimeLabel(item.timestamp),
    })));
    return {
      title: "Home",
      subtitle: `${agents.length} agents · ${activity.length} recent updates`,
      updatedAtLabel: formatTimeLabel(normalizeTimestamp(home.updatedAt) ?? Math.floor(Date.now() / 1000)),
      agents,
      activity,
      recentSessions: [],
      performance: finalizeLoadMeasurement(measurement),
    };
  }

  const [broker, setup] = await Promise.all([
    measureAsyncStep(measurement, "broker context", () => loadScoutBrokerContext()),
    measureAsyncStep(measurement, "resolved agents", () => loadResolvedRelayAgents({ currentDirectory: input.currentDirectory })),
  ]);

  const snapshot = broker?.snapshot ?? null;
  if (!snapshot) {
    return {
      title: "Home",
      subtitle: "Broker unavailable",
      updatedAtLabel: formatTimeLabel(Math.floor(Date.now() / 1000)),
      agents: [],
      activity: [],
      recentSessions: [],
      performance: finalizeLoadMeasurement(measurement),
    };
  }

  const tmuxSessions = measureStep(measurement, "tmux sessions", () => readTmuxSessions());
  const messagesByConversation = measureStep(measurement, "conversation map", () => buildMessagesByConversation(snapshot));
  const directActivity = measureStep(measurement, "direct activity", () => buildDirectAgentActivity(snapshot, tmuxSessions, messagesByConversation));
  const configuredAgentIds = new Set(setup.agents.map((agent) => agent.agentId));
  const visibleAgentIds = measureStep(measurement, "visible agents", () => visibleRelayAgentIds(snapshot, configuredAgentIds, messagesByConversation, directActivity));
  const agents = measureStep(measurement, "build home agents", () => buildHomeAgents(snapshot, directActivity, visibleAgentIds).slice(0, 24));
  const activity = measureStep(measurement, "build home activity", () => buildHomeActivity(snapshot));

  return {
    title: "Home",
    subtitle: `${agents.length} agents · ${activity.length} recent updates`,
    updatedAtLabel: formatTimeLabel(Math.floor(Date.now() / 1000)),
    agents,
    activity,
    recentSessions: [],
    performance: finalizeLoadMeasurement(measurement),
  };
}

export async function composeScoutDesktopShellState(input: {
  currentDirectory: string;
  appInfo: ScoutDesktopShellState["appInfo"];
}): Promise<ScoutDesktopShellState> {
  const measurement = startLoadMeasurement();
  const [status, helper, setup] = await Promise.all([
    measureAsyncStep(measurement, "runtime status", () => loadBrokerStatusForShell()),
    measureAsyncStep(measurement, "helper status", async () => Promise.resolve(readHelperStatus())),
    measureAsyncStep(measurement, "resolved agents", () => loadResolvedRelayAgents({ currentDirectory: input.currentDirectory })),
  ]);

  const tmuxSessions = measureStep(measurement, "tmux sessions", () => readTmuxSessions());
  const broker = status.reachable
    ? await measureAsyncStep(measurement, "broker context", () => loadScoutBrokerContext(status.brokerUrl))
    : null;
  const snapshot = broker?.snapshot ?? null;
  const configuredAgentIds = new Set(setup.agents.map((agent) => agent.agentId));
  const shared = snapshot
    ? measureStep(measurement, "derive workspace", () => buildRelayWorkspaceDerivation(snapshot, tmuxSessions, configuredAgentIds))
    : null;
  const visibleAgentCount = shared
    ? shared.visibleAgentIds.size
    : setup.agents.length;
  const latestRelayLabel = measureStep(measurement, "latest relay label", () => latestRelayLabelFromSnapshot(snapshot));
  const plans = await measureAsyncStep(measurement, "plans", () => buildPlansState(input.currentDirectory, snapshot, tmuxSessions));
  const sessions = snapshot ? measureStep(measurement, "sessions", () => buildSessions(snapshot)) : [];
  const interAgent = snapshot
    ? measureStep(measurement, "inter-agent", () => buildInterAgentState(snapshot, tmuxSessions, configuredAgentIds, { includeProjectGitActivity: true }, shared ?? undefined))
    : {
        title: "Inter-Agent",
        subtitle: "Broker unavailable",
        agents: [],
        threads: [],
        lastUpdatedLabel: null,
      };
  const relay = snapshot
    ? measureStep(measurement, "relay", () => buildRelayState(snapshot, tmuxSessions, configuredAgentIds, shared ?? undefined))
    : {
        title: "Relay",
        subtitle: "Broker unavailable",
        transportTitle: "Broker-backed",
        meshTitle: "Local mesh",
        syncLine: "Disconnected",
        operatorId: OPERATOR_ID,
        channels: [],
        views: [],
        directs: [],
        messages: [],
        voice: createScoutVoiceState(),
        lastUpdatedLabel: null,
      };
  const messages = measureStep(measurement, "messages", () => buildMessagesState(relay, interAgent));
  const runtime = measureStep(measurement, "runtime", () => buildRuntimeState(snapshot, tmuxSessions, latestRelayLabel, helper, status, visibleAgentCount));
  const machines = snapshot
    ? measureStep(measurement, "machines", () => buildMachinesState(snapshot, tmuxSessions, status.health.nodeId ?? broker?.node.id ?? null, shared ?? undefined))
    : buildEmptyMachinesState();

  return {
    appInfo: input.appInfo,
    runtime,
    machines,
    plans,
    messages,
    sessions,
    interAgent,
    relay,
    performance: finalizeLoadMeasurement(measurement),
  };
}

export async function composeScoutDesktopMessagesWorkspaceState(input: {
  currentDirectory: string;
}): Promise<ScoutDesktopMessagesWorkspaceState> {
  const measurement = startLoadMeasurement();
  const [status, helper] = await Promise.all([
    measureAsyncStep(measurement, "broker health", () => loadBrokerStatusForFastUi()),
    measureAsyncStep(measurement, "helper status", async () => Promise.resolve(readHelperStatus())),
  ]);

  const tmuxSessions = measureStep(measurement, "tmux sessions", () => readTmuxSessions());
  const snapshot = status.reachable
    ? await measureAsyncStep(measurement, "broker snapshot", () => readScoutBrokerSnapshot(status.brokerUrl))
    : null;
  const configuredAgentIds = inferredConfiguredAgentIds(snapshot);
  const shared = snapshot
    ? measureStep(measurement, "derive workspace", () => buildRelayWorkspaceDerivation(snapshot, tmuxSessions, configuredAgentIds))
    : null;
  const visibleAgentCount = shared
    ? shared.visibleAgentIds.size
    : configuredAgentIds.size;
  const latestRelayLabel = measureStep(measurement, "latest relay label", () => latestRelayLabelFromSnapshot(snapshot));
  const plans = await measureAsyncStep(
    measurement,
    "plans-lite",
    () => buildPlansState(input.currentDirectory, snapshot, tmuxSessions, { includeWorkspacePlans: false }),
  );
  const interAgent = snapshot
    ? measureStep(measurement, "inter-agent", () => buildInterAgentState(snapshot, tmuxSessions, configuredAgentIds, { includeProjectGitActivity: false }, shared ?? undefined))
    : {
        title: "Inter-Agent",
        subtitle: "Broker unavailable",
        agents: [],
        threads: [],
        lastUpdatedLabel: null,
      };
  const relay = snapshot
    ? measureStep(measurement, "relay", () => buildRelayState(snapshot, tmuxSessions, configuredAgentIds, shared ?? undefined))
    : {
        title: "Relay",
        subtitle: "Broker unavailable",
        transportTitle: "Broker-backed",
        meshTitle: "Local mesh",
        syncLine: "Disconnected",
        operatorId: OPERATOR_ID,
        channels: [],
        views: [],
        directs: [],
        messages: [],
        voice: createScoutVoiceState(),
        lastUpdatedLabel: null,
      };
  const messages = measureStep(measurement, "messages", () => buildMessagesState(relay, interAgent));
  const runtime = measureStep(measurement, "runtime", () => buildRuntimeState(snapshot, tmuxSessions, latestRelayLabel, helper, status, visibleAgentCount));

  return {
    runtime,
    messages,
    sessions: [],
    relay,
    interAgent,
    performance: finalizeLoadMeasurement(measurement),
  };
}

export async function composeScoutDesktopRelayShellPatch(input: {
  currentDirectory: string;
}): Promise<ScoutDesktopShellPatch> {
  const measurement = startLoadMeasurement();
  const [status, helper] = await Promise.all([
    measureAsyncStep(measurement, "broker health", () => loadBrokerStatusForFastUi()),
    measureAsyncStep(measurement, "helper status", async () => Promise.resolve(readHelperStatus())),
  ]);

  const tmuxSessions = measureStep(measurement, "tmux sessions", () => readTmuxSessions());
  const broker = status.reachable
    ? await measureAsyncStep(measurement, "broker context", () => loadScoutBrokerContext(status.brokerUrl))
    : null;
  const snapshot = broker?.snapshot ?? null;
  const configuredAgentIds = inferredConfiguredAgentIds(snapshot);
  const shared = snapshot
    ? measureStep(measurement, "derive workspace", () => buildRelayWorkspaceDerivation(snapshot, tmuxSessions, configuredAgentIds))
    : null;
  const visibleAgentCount = shared
    ? shared.visibleAgentIds.size
    : configuredAgentIds.size;
  const latestRelayLabel = measureStep(measurement, "latest relay label", () => latestRelayLabelFromSnapshot(snapshot));
  const plans = await measureAsyncStep(
    measurement,
    "plans-lite",
    () => buildPlansState(input.currentDirectory, snapshot, tmuxSessions, { includeWorkspacePlans: false }),
  );
  const interAgent = snapshot
    ? measureStep(measurement, "inter-agent", () => buildInterAgentState(snapshot, tmuxSessions, configuredAgentIds, { includeProjectGitActivity: false }, shared ?? undefined))
    : {
        title: "Inter-Agent",
        subtitle: "Broker unavailable",
        agents: [],
        threads: [],
        lastUpdatedLabel: null,
      };
  const relay = snapshot
    ? measureStep(measurement, "relay", () => buildRelayState(snapshot, tmuxSessions, configuredAgentIds, shared ?? undefined))
    : {
        title: "Relay",
        subtitle: "Broker unavailable",
        transportTitle: "Broker-backed",
        meshTitle: "Local mesh",
        syncLine: "Disconnected",
        operatorId: OPERATOR_ID,
        channels: [],
        views: [],
        directs: [],
        messages: [],
        voice: createScoutVoiceState(),
        lastUpdatedLabel: null,
      };
  const runtime = measureStep(measurement, "runtime", () => buildRuntimeState(snapshot, tmuxSessions, latestRelayLabel, helper, status, visibleAgentCount));
  const machines = snapshot
    ? measureStep(measurement, "machines", () => buildMachinesState(snapshot, tmuxSessions, status.health.nodeId ?? broker?.node.id ?? null, shared ?? undefined))
    : buildEmptyMachinesState();
  const messages = measureStep(measurement, "messages", () => buildMessagesState(relay, interAgent));
  const sessions = snapshot ? measureStep(measurement, "sessions", () => buildSessions(snapshot)) : [];

  return {
    runtime,
    machines,
    plans,
    messages,
    sessions,
    interAgent,
    relay,
    performance: finalizeLoadMeasurement(measurement),
  };
}
