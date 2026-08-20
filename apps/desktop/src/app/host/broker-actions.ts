import type {
  ActorIdentity,
  AgentDefinition,
  AgentEndpoint,
  AgentHarness,
  AgentSelectorCandidate,
  ConversationDefinition,
  MessageRecord,
} from "@openscout/protocol";
import {
  epochMs,
  extractAgentSelectors,
  resolveAgentSelector,
} from "@openscout/protocol";
import {
  ensureLocalAgentBindingOnline,
  restartLocalAgent,
  SUPPORTED_LOCAL_AGENT_HARNESSES,
} from "@openscout/runtime/local-agents";
import { requestScoutBrokerJson } from "@openscout/runtime/broker-api";
import { resolveBrokerSocketPathForBaseUrl } from "@openscout/runtime/broker-process-manager";
import type { RuntimeRegistrySnapshot } from "@openscout/runtime/registry";
import {
  DEFAULT_OPERATOR_NAME,
  ensureScoutRelayAgentConfigured,
  loadResolvedRelayAgents,
  readOpenScoutSettings,
  resolveRelayAgentConfig,
  SCOUT_AGENT_ID,
} from "@openscout/runtime/setup";
import { runRuntimeBrokerService } from "./runtime-service-client.ts";

import {
  loadScoutBrokerContext,
  syncScoutBrokerBindings,
} from "../../core/broker/service.ts";
import { upScoutAgent } from "../../core/agents/service.ts";
import {
  createScoutDesktopAppInfo,
  loadScoutDesktopRelayShellPatch,
  loadScoutDesktopShellState,
  type ScoutDesktopAppInfo,
  type ScoutInterAgentAgent,
  type ScoutRelayDirectThread,
  type ScoutRelayMessage,
  type ScoutDesktopShellPatch,
  type ScoutDesktopShellState,
} from "../desktop/index.ts";

export type ScoutDesktopBrokerControlAction = "start" | "stop" | "restart";

export type ScoutDesktopRestartAgentInput = {
  agentId: string;
  previousSessionId?: string | null;
};

export type ScoutDesktopCreateAgentInput = {
  projectPath: string;
  agentName?: string | null;
  harness?: AgentHarness | null;
  model?: string | null;
};

export type ScoutDesktopCreateAgentResult = {
  agentId: string;
  shellState: ScoutDesktopShellState;
};

export type ScoutDesktopSendRelayMessageInput = {
  destinationKind: "channel" | "filter" | "direct";
  destinationId: string;
  body: string;
  harness?: AgentHarness | null;
  replyToMessageId?: string | null;
  referenceMessageIds?: string[];
  clientMessageId?: string | null;
};

export type ScoutDesktopBrokerActionOptions = {
  currentDirectory?: string;
  appInfo?: ScoutDesktopAppInfo;
  telegram?: {
    refreshConfiguration?: () => Promise<void> | void;
  };
};

type ReferencedMessageContext = {
  id: string;
  authorId: string;
  authorName: string;
  conversationId: string;
  conversationTitle: string;
  createdAt: number | null;
  body: string;
};

const SCOUT_BROKER_OPERATOR_ID = "operator";
const SCOUT_SHARED_CHANNEL_ID = "channel.shared";
const SCOUT_VOICE_CHANNEL_ID = "channel.voice";
const SCOUT_SYSTEM_CHANNEL_ID = "channel.system";

function resolveCurrentDirectory(input?: string): string {
  return input?.trim() || process.cwd();
}

function resolveAppInfo(input?: ScoutDesktopAppInfo): ScoutDesktopAppInfo {
  return input ?? createScoutDesktopAppInfo();
}

async function loadBrokerActionShellState(input: ScoutDesktopBrokerActionOptions = {}): Promise<ScoutDesktopShellState> {
  return loadScoutDesktopShellState({
    currentDirectory: resolveCurrentDirectory(input.currentDirectory),
    appInfo: resolveAppInfo(input.appInfo),
  });
}

async function loadBrokerActionRelayShellPatch(input: ScoutDesktopBrokerActionOptions = {}): Promise<ScoutDesktopShellPatch> {
  return loadScoutDesktopRelayShellPatch({
    currentDirectory: resolveCurrentDirectory(input.currentDirectory),
  });
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function relayTaskSnippet(body: string): string {
  const normalized = sanitizeRelayBody(body).replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "Working…";
  }
  if (normalized.length <= 96) {
    return normalized;
  }
  return `${normalized.slice(0, 93).trimEnd()}...`;
}

function optimisticSentReceipt(): NonNullable<ScoutRelayMessage["receipt"]> {
  return {
    state: "sent",
    label: "Sent",
    detail: null,
  };
}

function applyOptimisticWorkingToDirect(
  thread: ScoutRelayDirectThread,
  activeTask: string,
): ScoutRelayDirectThread {
  return {
    ...thread,
    state: "working",
    reachable: true,
    statusLabel: "Working",
    statusDetail: null,
    activeTask,
  };
}

function applyOptimisticWorkingToAgent(
  agent: ScoutInterAgentAgent,
  activeTask: string,
): ScoutInterAgentAgent {
  return {
    ...agent,
    state: "working",
    reachable: true,
    statusLabel: "Working",
    statusDetail: null,
  };
}

function buildOptimisticBrokerRelayMessage(input: {
  messageId: string;
  clientMessageId: string | null | undefined;
  conversationId: string;
  body: string;
  operatorId: string;
  operatorName: string;
  destinationKind: ScoutDesktopSendRelayMessageInput["destinationKind"];
  destinationId: string;
  recipients: string[];
  createdAt: number;
}): ScoutRelayMessage {
  const normalizedChannel = input.destinationKind === "channel"
    ? input.destinationId
    : input.destinationKind === "direct"
      ? null
      : "shared";
  const isVoice = input.destinationKind === "channel" && input.destinationId === "voice";
  const isSystem = input.destinationKind === "channel" && input.destinationId === "system";

  return {
    id: input.messageId,
    clientMessageId: input.clientMessageId ?? null,
    conversationId: input.conversationId,
    createdAt: input.createdAt,
    replyToMessageId: null,
    authorId: input.operatorId,
    authorName: input.operatorName,
    authorRole: null,
    body: input.body.trim(),
    timestampLabel: new Date(input.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
    dayLabel: new Date(input.createdAt).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }).toUpperCase(),
    normalizedChannel,
    recipients: input.recipients,
    isDirectConversation: input.destinationKind === "direct",
    isSystem,
    isVoice,
    messageClass: isSystem ? "system" : "agent",
    routingSummary: input.recipients.length > 0 ? `Targets ${input.recipients.join(", ")}` : null,
    provenanceSummary: "via desktop",
    provenanceDetail: null,
    isOperator: true,
    avatarLabel: input.operatorName.slice(0, 1).toUpperCase() || "A",
    avatarColor: "#64748b",
    receipt: optimisticSentReceipt(),
  };
}

function applyOptimisticRelayPatch(input: {
  patch: ScoutDesktopShellPatch;
  invokeTargets: string[];
  activeTask: string;
  messageId: string;
  clientMessageId: string | null | undefined;
  conversationId: string;
  operatorName: string;
  operatorId: string;
  destinationKind: ScoutDesktopSendRelayMessageInput["destinationKind"];
  destinationId: string;
  body: string;
  createdAt: number;
}): ScoutDesktopShellPatch {
  if (input.invokeTargets.length === 0) {
    return input.patch;
  }

  const nextDirects = input.patch.relay.directs.map((thread) => (
    input.invokeTargets.includes(thread.id)
      ? applyOptimisticWorkingToDirect(thread, input.activeTask)
      : thread
  ));

  const nextAgents = input.patch.interAgent.agents.map((agent) => (
    input.invokeTargets.includes(agent.id)
      ? applyOptimisticWorkingToAgent(agent, input.activeTask)
      : agent
  ));

  let nextMessages = input.patch.relay.messages;

  const hasPostedMessage = nextMessages.some((message) => (
    message.id === input.messageId
    || (input.clientMessageId && message.clientMessageId === input.clientMessageId)
  ));

  if (!hasPostedMessage) {
    nextMessages = [...nextMessages, buildOptimisticBrokerRelayMessage({
      messageId: input.messageId,
      clientMessageId: input.clientMessageId,
      conversationId: input.conversationId,
      body: input.body,
      operatorId: input.operatorId,
      operatorName: input.operatorName,
      destinationKind: input.destinationKind,
      destinationId: input.destinationId,
      recipients: input.invokeTargets,
      createdAt: input.createdAt,
    })].sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  }

  return {
    ...input.patch,
    interAgent: {
      ...input.patch.interAgent,
      agents: nextAgents,
    },
    relay: {
      ...input.patch.relay,
      directs: nextDirects,
      messages: nextMessages,
    },
  };
}

function normalizeTimestamp(value: unknown): number | null {
  const ms = epochMs(value);
  return ms === null ? null : Math.floor(ms / 1000);
}

function sanitizeRelayBody(body: string): string {
  return body
    .replace(/\[ask:[^\]]+\]\s*/g, "")
    .replace(/\[speak\]\s*/gi, "")
    .replace(/^(@[\w.-]+\s+)+/g, "")
    .trim();
}

function normalizeMessageReferenceIds(value: string[] | null | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return unique(value.map((entry) => String(entry).trim()).filter(Boolean));
}

function resolveOperatorDisplayName(currentDirectory: string): Promise<string> {
  return readOpenScoutSettings({ currentDirectory }).then((settings) => {
    const candidate = settings.profile.operatorName?.trim();
    return candidate || DEFAULT_OPERATOR_NAME;
  }).catch(() => DEFAULT_OPERATOR_NAME);
}

function actorDisplayName(
  snapshot: RuntimeRegistrySnapshot,
  actorId: string,
  operatorName: string,
): string {
  if (actorId === SCOUT_BROKER_OPERATOR_ID) {
    return operatorName;
  }
  const agent = snapshot.agents[actorId] as AgentDefinition | undefined;
  if (agent?.displayName) {
    return agent.displayName;
  }
  const actor = snapshot.actors[actorId] as { displayName?: string } | undefined;
  if (actor?.displayName) {
    return actor.displayName;
  }
  return actorId;
}

function directConversationId(agentId: string): string {
  return `dm.${SCOUT_BROKER_OPERATOR_ID}.${agentId}`;
}

async function postBrokerJson(baseUrl: string, pathname: string, body: unknown): Promise<void> {
  await requestScoutBrokerJson<void>(baseUrl, pathname, {
    method: "POST",
    body,
    socketPath: resolveBrokerSocketPathForBaseUrl(baseUrl),
  });
}

async function ensureOperatorActor(
  baseUrl: string,
  snapshot: RuntimeRegistrySnapshot,
  operatorName: string,
): Promise<void> {
  if (snapshot.actors[SCOUT_BROKER_OPERATOR_ID] || snapshot.agents[SCOUT_BROKER_OPERATOR_ID]) {
    return;
  }

  const actor: ActorIdentity = {
    id: SCOUT_BROKER_OPERATOR_ID,
    kind: "person",
    displayName: operatorName,
    handle: SCOUT_BROKER_OPERATOR_ID,
    labels: ["operator", "desktop"],
    metadata: { source: "scout-desktop" },
  };

  await postBrokerJson(baseUrl, "/v1/actors", actor);
  snapshot.actors[actor.id] = actor;
}

async function ensureCoreConversation(
  baseUrl: string,
  snapshot: RuntimeRegistrySnapshot,
  nodeId: string,
  conversationId: string,
): Promise<void> {
  if (snapshot.conversations[conversationId]) {
    return;
  }

  const participantIds = unique([SCOUT_BROKER_OPERATOR_ID, ...Object.keys(snapshot.agents)]).sort();
  const definition: ConversationDefinition =
    conversationId === SCOUT_SHARED_CHANNEL_ID
      ? {
          id: SCOUT_SHARED_CHANNEL_ID,
          kind: "channel",
          title: "shared-channel",
          visibility: "workspace",
          shareMode: "shared",
          authorityNodeId: nodeId,
          participantIds,
          metadata: { surface: "scout-desktop" },
        }
      : conversationId === SCOUT_VOICE_CHANNEL_ID
        ? {
            id: SCOUT_VOICE_CHANNEL_ID,
            kind: "channel",
            title: "voice",
            visibility: "workspace",
            shareMode: "local",
            authorityNodeId: nodeId,
            participantIds,
            metadata: { surface: "scout-desktop" },
          }
        : {
            id: SCOUT_SYSTEM_CHANNEL_ID,
            kind: "system",
            title: "system",
            visibility: "system",
            shareMode: "local",
            authorityNodeId: nodeId,
            participantIds: [SCOUT_BROKER_OPERATOR_ID],
            metadata: { surface: "scout-desktop" },
          };

  await postBrokerJson(baseUrl, "/v1/conversations", definition);
  snapshot.conversations[conversationId] = definition;
}

async function ensureDirectConversation(
  baseUrl: string,
  snapshot: RuntimeRegistrySnapshot,
  nodeId: string,
  agentId: string,
  operatorName: string,
): Promise<string> {
  const conversationId = directConversationId(agentId);
  const nextShareMode = snapshot.agents[agentId]?.authorityNodeId && snapshot.agents[agentId]?.authorityNodeId !== nodeId
    ? "shared"
    : "local";
  const existing = snapshot.conversations[conversationId];
  if (existing?.shareMode === nextShareMode) {
    return conversationId;
  }

  const definition: ConversationDefinition = {
    id: conversationId,
    kind: "direct",
    title: agentId === SCOUT_AGENT_ID ? "Scout" : actorDisplayName(snapshot, agentId, operatorName),
    visibility: "private",
    shareMode: nextShareMode,
    authorityNodeId: nodeId,
    participantIds: [SCOUT_BROKER_OPERATOR_ID, agentId].sort(),
    metadata: {
      surface: "scout-desktop",
      ...(agentId === SCOUT_AGENT_ID ? { role: "partner" } : {}),
    },
  };

  await postBrokerJson(baseUrl, "/v1/conversations", definition);
  snapshot.conversations[conversationId] = definition;
  return conversationId;
}

async function ensureBrokerAgentBinding(
  baseUrl: string,
  snapshot: RuntimeRegistrySnapshot,
  nodeId: string,
  agentId: string,
  currentDirectory: string,
): Promise<boolean> {
  if (snapshot.agents[agentId]) {
    return true;
  }

  const binding = await ensureLocalAgentBindingOnline(agentId, nodeId, {
    includeDiscovered: true,
    currentDirectory,
  });
  if (!binding) {
    return false;
  }

  await postBrokerJson(baseUrl, "/v1/actors", binding.actor);
  await postBrokerJson(baseUrl, "/v1/agents", binding.agent);
  await postBrokerJson(baseUrl, "/v1/endpoints", binding.endpoint);
  snapshot.actors[binding.actor.id] = binding.actor;
  snapshot.agents[binding.agent.id] = binding.agent;
  snapshot.endpoints[binding.endpoint.id] = binding.endpoint;
  return true;
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

async function parseMentionTargets(
  body: string,
  snapshot: RuntimeRegistrySnapshot,
  currentDirectory: string,
): Promise<{ actorIds: string[]; labels: Record<string, string> }> {
  const validAgents = new Set(Object.keys(snapshot.agents));
  const endpointBackedAgents = unique(
    Object.values(snapshot.endpoints as Record<string, AgentEndpoint>).map((endpoint) => endpoint.agentId),
  );
  const selectors = extractAgentSelectors(body);
  const labels: Record<string, string> = {};
  const targets = new Set<string>();

  if (selectors.length === 0) {
    return { actorIds: [], labels };
  }

  const setup = await loadResolvedRelayAgents({ currentDirectory });
  const candidateMap = new Map<string, AgentSelectorCandidate>();
  for (const agent of Object.values(snapshot.agents) as AgentDefinition[]) {
    candidateMap.set(agent.id, {
      agentId: agent.id,
      definitionId: metadataString(agent.metadata, "definitionId") || agent.id,
      nodeQualifier: metadataString(agent.metadata, "nodeQualifier"),
      workspaceQualifier: metadataString(agent.metadata, "workspaceQualifier"),
      aliases: [
        metadataString(agent.metadata, "selector"),
        metadataString(agent.metadata, "defaultSelector"),
      ].filter(Boolean) as string[],
    });
  }
  for (const agent of setup.discoveredAgents) {
    if (candidateMap.has(agent.agentId)) {
      continue;
    }
    candidateMap.set(agent.agentId, {
      agentId: agent.agentId,
      definitionId: agent.definitionId,
      nodeQualifier: agent.instance.nodeQualifier,
      workspaceQualifier: agent.instance.workspaceQualifier,
      aliases: [agent.instance.selector, agent.instance.defaultSelector],
    });
  }

  for (const selector of selectors) {
    if (selector.definitionId === "all") {
      for (const agentId of endpointBackedAgents) {
        targets.add(agentId);
        labels[agentId] = "@all";
      }
      continue;
    }

    const match = resolveAgentSelector(selector, Array.from(candidateMap.values()));
    if (match) {
      targets.add(match.agentId);
      labels[match.agentId] = selector.label;
      if (validAgents.has(match.agentId)) {
        continue;
      }

      const fallback = await resolveRelayAgentConfig(selector, { currentDirectory });
      if (fallback) {
        targets.add(fallback.agentId);
        labels[fallback.agentId] = selector.label;
      }
    }
  }

  return {
    actorIds: Array.from(targets).sort(),
    labels,
  };
}

function referencedMessageContext(
  snapshot: RuntimeRegistrySnapshot,
  messageId: string,
  operatorName: string,
): ReferencedMessageContext | null {
  const message = snapshot.messages[messageId] as MessageRecord | undefined;
  if (!message) {
    return null;
  }

  const conversation = snapshot.conversations[message.conversationId] as ConversationDefinition | undefined;
  return {
    id: message.id,
    authorId: message.actorId,
    authorName: actorDisplayName(snapshot, message.actorId, operatorName),
    conversationId: message.conversationId,
    conversationTitle: conversation?.title ?? message.conversationId,
    createdAt: normalizeTimestamp(message.createdAt),
    body: sanitizeRelayBody(message.body),
  };
}

function formatReferencedMessageContext(reference: ReferencedMessageContext): string {
  const normalizedRef = reference.id.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  const shortRef = `m:${normalizedRef.slice(-7) || normalizedRef.slice(0, 7) || "message"}`;
  const body = reference.body.length > 280
    ? `${reference.body.slice(0, 279).trimEnd()}...`
    : reference.body;
  const createdAtLabel = reference.createdAt
    ? new Date(reference.createdAt * 1000).toISOString()
    : "unknown";

  return [
    `[${shortRef}] ${reference.authorName}`,
    `Conversation: ${reference.conversationTitle} (${reference.conversationId})`,
    `At: ${createdAtLabel}`,
    `Body: ${body || "[no text]"}`,
  ].join("\n");
}

function parseRequestedHarness(value?: AgentHarness | null): AgentHarness | undefined {
  if (!value) {
    return undefined;
  }
  return SUPPORTED_LOCAL_AGENT_HARNESSES.includes(value) ? value : undefined;
}

export async function restartScoutDesktopAgent(
  input: ScoutDesktopRestartAgentInput,
  options: ScoutDesktopBrokerActionOptions = {},
): Promise<ScoutDesktopShellState> {
  const currentDirectory = resolveCurrentDirectory(options.currentDirectory);
  const operatorName = await resolveOperatorDisplayName(currentDirectory);
  const record = await restartLocalAgent(input.agentId, {
    previousSessionId: input.previousSessionId ?? null,
  });
  if (!record) {
    throw new Error(`Agent ${input.agentId} is not an editable relay agent.`);
  }

  await syncScoutBrokerBindings({
    currentDirectory,
    operatorId: SCOUT_BROKER_OPERATOR_ID,
    operatorName,
  });

  return loadBrokerActionShellState(options);
}

export async function createScoutDesktopAgent(
  input: ScoutDesktopCreateAgentInput,
  options: ScoutDesktopBrokerActionOptions = {},
): Promise<ScoutDesktopCreateAgentResult> {
  const currentDirectory = resolveCurrentDirectory(options.currentDirectory);
  const operatorName = await resolveOperatorDisplayName(currentDirectory);
  const projectPath = input.projectPath.trim();

  if (!projectPath) {
    throw new Error("Project path is required.");
  }

  const agent = await upScoutAgent({
    projectPath,
    agentName: input.agentName?.trim() || undefined,
    harness: parseRequestedHarness(input.harness),
    model: input.model?.trim() || undefined,
    currentDirectory,
  });

  await syncScoutBrokerBindings({
    currentDirectory,
    operatorId: SCOUT_BROKER_OPERATOR_ID,
    operatorName,
  });

  return {
    agentId: agent.agentId,
    shellState: await loadBrokerActionShellState(options),
  };
}

export async function controlScoutDesktopBroker(
  action: ScoutDesktopBrokerControlAction,
  options: ScoutDesktopBrokerActionOptions = {},
): Promise<ScoutDesktopShellState> {
  const currentDirectory = resolveCurrentDirectory(options.currentDirectory);
  const operatorName = await resolveOperatorDisplayName(currentDirectory);

  switch (action) {
    case "start":
      await runRuntimeBrokerService("start");
      await options.telegram?.refreshConfiguration?.();
      await syncScoutBrokerBindings({
        currentDirectory,
        operatorId: SCOUT_BROKER_OPERATOR_ID,
        operatorName,
      });
      break;
    case "stop":
      await runRuntimeBrokerService("stop");
      break;
    case "restart":
      await runRuntimeBrokerService("restart");
      await options.telegram?.refreshConfiguration?.();
      await syncScoutBrokerBindings({
        currentDirectory,
        operatorId: SCOUT_BROKER_OPERATOR_ID,
        operatorName,
      });
      break;
  }

  return loadBrokerActionShellState(options);
}

export async function sendScoutDesktopRelayMessage(
  input: ScoutDesktopSendRelayMessageInput,
  options: ScoutDesktopBrokerActionOptions = {},
): Promise<ScoutDesktopShellPatch> {
  const currentDirectory = resolveCurrentDirectory(options.currentDirectory);
  const operatorName = await resolveOperatorDisplayName(currentDirectory);

  const broker = await loadScoutBrokerContext();
  if (!broker) {
    throw new Error("Broker snapshot is unavailable.");
  }

  await ensureOperatorActor(broker.baseUrl, broker.snapshot, operatorName);
  await ensureCoreConversation(broker.baseUrl, broker.snapshot, broker.node.id, SCOUT_SHARED_CHANNEL_ID);
  await ensureCoreConversation(broker.baseUrl, broker.snapshot, broker.node.id, SCOUT_VOICE_CHANNEL_ID);
  await ensureCoreConversation(broker.baseUrl, broker.snapshot, broker.node.id, SCOUT_SYSTEM_CHANNEL_ID);

  const directTarget = input.destinationKind === "direct" ? input.destinationId : null;
  if (directTarget) {
    if (directTarget === SCOUT_AGENT_ID) {
      await ensureScoutRelayAgentConfigured({ currentDirectory });
    }
    await ensureBrokerAgentBinding(
      broker.baseUrl,
      broker.snapshot,
      broker.node.id,
      directTarget,
      currentDirectory,
    );
  }

  const mentionTargets = await parseMentionTargets(input.body, broker.snapshot, currentDirectory);
  for (const targetAgentId of mentionTargets.actorIds) {
    await ensureBrokerAgentBinding(
      broker.baseUrl,
      broker.snapshot,
      broker.node.id,
      targetAgentId,
      currentDirectory,
    );
  }

  const invokeTargets = unique([...(directTarget ? [directTarget] : []), ...mentionTargets.actorIds])
    .filter((targetAgentId) => Boolean(broker.snapshot.agents[targetAgentId]));
  const requestedHarness = parseRequestedHarness(input.harness);
  const referenceMessageIds = normalizeMessageReferenceIds(input.referenceMessageIds);
  const referencedMessages = referenceMessageIds
    .map((messageId) => referencedMessageContext(broker.snapshot, messageId, operatorName))
    .filter((entry): entry is ReferencedMessageContext => Boolean(entry));
  const effectiveReplyToMessageId = input.replyToMessageId ?? referencedMessages[0]?.id ?? undefined;

  let conversationId = SCOUT_SHARED_CHANNEL_ID;
  let visibility: "workspace" | "system" | "private" = "workspace";
  let messageClass: "agent" | "system" = "agent";

  if (input.destinationKind === "channel" && input.destinationId === "voice") {
    conversationId = SCOUT_VOICE_CHANNEL_ID;
  } else if (input.destinationKind === "channel" && input.destinationId === "system") {
    conversationId = SCOUT_SYSTEM_CHANNEL_ID;
    visibility = "system";
    messageClass = "system";
  } else if (input.destinationKind === "direct" && directTarget) {
    conversationId = await ensureDirectConversation(
      broker.baseUrl,
      broker.snapshot,
      broker.node.id,
      directTarget,
      operatorName,
    );
    visibility = "private";
  }

  const createdAt = Date.now();
  const messageId = `msg-${createdAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await postBrokerJson(broker.baseUrl, "/v1/messages", {
    id: messageId,
    conversationId,
    replyToMessageId: effectiveReplyToMessageId,
    actorId: SCOUT_BROKER_OPERATOR_ID,
    originNodeId: broker.node.id,
    class: messageClass,
    body: input.body.trim(),
    mentions: invokeTargets.map((actorId) => ({
      actorId,
      label: actorId === directTarget ? `@${actorId}` : (mentionTargets.labels[actorId] ?? `@${actorId}`),
    })),
    audience: invokeTargets.length > 0
      ? {
          notify: invokeTargets,
          reason: directTarget ? "direct_message" : "mention",
        }
      : undefined,
    visibility,
    policy: "durable",
    createdAt,
    metadata: {
      source: "scout-desktop",
      destinationKind: input.destinationKind,
      destinationId: input.destinationId,
      referenceMessageIds,
      clientMessageId: input.clientMessageId ?? null,
    },
  });

  for (const targetAgentId of invokeTargets) {
    await postBrokerJson(broker.baseUrl, "/v1/invocations", {
      id: `inv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      requesterId: SCOUT_BROKER_OPERATOR_ID,
      requesterNodeId: broker.node.id,
      targetAgentId,
      action: "consult",
      task: input.body.trim(),
      conversationId,
      messageId,
      context: referencedMessages.length > 0
        ? {
            reference_message_ids: referenceMessageIds.join(", "),
            referenced_messages: referencedMessages.map(formatReferencedMessageContext).join("\n\n"),
          }
        : undefined,
      execution: requestedHarness ? { harness: requestedHarness } : undefined,
      ensureAwake: true,
      stream: false,
      createdAt,
      metadata: {
        source: "scout-desktop",
        destinationKind: input.destinationKind,
      },
    });
  }

  const patch = await loadBrokerActionRelayShellPatch(options);
  return applyOptimisticRelayPatch({
    patch,
    invokeTargets,
    activeTask: relayTaskSnippet(input.body),
    messageId,
    clientMessageId: input.clientMessageId,
    conversationId,
    operatorName,
    operatorId: SCOUT_BROKER_OPERATOR_ID,
    destinationKind: input.destinationKind,
    destinationId: input.destinationId,
    body: input.body,
    createdAt,
  });
}
