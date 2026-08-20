import type { MetadataMap, ScoutId } from "./common.js";
import type { FlightRecord, InvocationRequest } from "./invocations.js";
import type { ScoutAgentCard } from "./scout-agent-card.js";

export const A2A_PROTOCOL_VERSION = "1.0";
export const A2A_JSON_RPC_CONTENT_TYPE = "application/json";
export const A2A_HTTP_JSON_CONTENT_TYPE = "application/a2a+json";

export const A2A_JSON_RPC_METHODS = {
  sendMessage: "SendMessage",
  sendStreamingMessage: "SendStreamingMessage",
  getTask: "GetTask",
  listTasks: "ListTasks",
  cancelTask: "CancelTask",
  subscribeToTask: "SubscribeToTask",
  createTaskPushNotificationConfig: "CreateTaskPushNotificationConfig",
  getTaskPushNotificationConfig: "GetTaskPushNotificationConfig",
  listTaskPushNotificationConfigs: "ListTaskPushNotificationConfigs",
  deleteTaskPushNotificationConfig: "DeleteTaskPushNotificationConfig",
  getExtendedAgentCard: "GetExtendedAgentCard",
} as const;

export const A2A_LEGACY_JSON_RPC_METHODS = {
  sendMessage: "message/send",
  sendStreamingMessage: "message/stream",
  getTask: "tasks/get",
  listTasks: "tasks/list",
  cancelTask: "tasks/cancel",
  subscribeToTask: "tasks/subscribe",
  getExtendedAgentCard: "agent/getAuthenticatedExtendedCard",
} as const;

export type A2AJsonRpcMethod =
  typeof A2A_JSON_RPC_METHODS[keyof typeof A2A_JSON_RPC_METHODS]
  | typeof A2A_LEGACY_JSON_RPC_METHODS[keyof typeof A2A_LEGACY_JSON_RPC_METHODS];

export type A2ARole = "ROLE_USER" | "ROLE_AGENT";

export type A2ATaskState =
  | "TASK_STATE_SUBMITTED"
  | "TASK_STATE_WORKING"
  | "TASK_STATE_INPUT_REQUIRED"
  | "TASK_STATE_AUTH_REQUIRED"
  | "TASK_STATE_COMPLETED"
  | "TASK_STATE_FAILED"
  | "TASK_STATE_CANCELED"
  | "TASK_STATE_REJECTED"
  | "TASK_STATE_UNKNOWN";

export type A2APart =
  | {
      text: string;
      metadata?: MetadataMap;
    }
  | {
      file: {
        name?: string;
        mimeType?: string;
        bytes?: string;
        uri?: string;
      };
      metadata?: MetadataMap;
    }
  | {
      data: unknown;
      metadata?: MetadataMap;
    };

export interface A2AMessage {
  role: A2ARole;
  parts: A2APart[];
  messageId: ScoutId;
  taskId?: ScoutId;
  contextId?: ScoutId;
  extensions?: string[];
  metadata?: MetadataMap;
}

export interface A2AArtifact {
  artifactId: ScoutId;
  name?: string;
  description?: string;
  parts: A2APart[];
  metadata?: MetadataMap;
}

export interface A2ATaskStatus {
  state: A2ATaskState;
  message?: A2AMessage;
  timestamp?: string;
}

export interface A2ATask {
  id: ScoutId;
  contextId: ScoutId;
  status: A2ATaskStatus;
  artifacts?: A2AArtifact[];
  history?: A2AMessage[];
  metadata?: MetadataMap;
}

export interface A2ATaskStatusUpdateEvent {
  taskId: ScoutId;
  contextId: ScoutId;
  status: A2ATaskStatus;
  final?: boolean;
  metadata?: MetadataMap;
}

export interface A2ATaskArtifactUpdateEvent {
  taskId: ScoutId;
  contextId: ScoutId;
  artifact: A2AArtifact;
  append?: boolean;
  lastChunk?: boolean;
  metadata?: MetadataMap;
}

export type A2AStreamResponse =
  | { task: A2ATask }
  | { message: A2AMessage }
  | { statusUpdate: A2ATaskStatusUpdateEvent }
  | { artifactUpdate: A2ATaskArtifactUpdateEvent };

export interface A2AAgentProvider {
  organization: string;
  url?: string;
}

export interface A2AAgentCapabilities {
  streaming?: boolean;
  pushNotifications?: boolean;
  stateTransitionHistory?: boolean;
  extendedAgentCard?: boolean;
  extensions?: Array<{
    uri: string;
    description?: string;
    required?: boolean;
    params?: MetadataMap;
  }>;
}

export interface A2AAgentSkill {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
}

export interface A2AAgentInterface {
  url: string;
  transport?: string;
  protocolBinding: string;
  protocolVersion?: string;
  tenant?: string;
}

export interface A2AAgentCard {
  protocolVersion: string;
  name: string;
  description: string;
  url: string;
  preferredTransport?: string;
  provider?: A2AAgentProvider;
  version?: string;
  documentationUrl?: string;
  capabilities: A2AAgentCapabilities;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: A2AAgentSkill[];
  supportedInterfaces?: A2AAgentInterface[];
  securitySchemes?: Record<string, unknown>;
  security?: Array<Record<string, string[]>>;
  iconUrl?: string;
  signatures?: unknown[];
  metadata?: MetadataMap;
}

export interface A2AJsonRpcRequest<TParams = unknown> {
  jsonrpc: "2.0";
  id: string | number | null;
  method: A2AJsonRpcMethod | string;
  params?: TParams;
}

export interface A2AJsonRpcResponse<TResult = unknown> {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: TResult;
  error?: A2AJsonRpcError;
}

export interface A2AJsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface A2ASendMessageParams {
  message: A2AMessage;
  configuration?: {
    acceptedOutputModes?: string[];
    historyLength?: number;
    blocking?: boolean;
    pushNotificationConfig?: unknown;
  };
  metadata?: MetadataMap;
}

export interface A2ATaskIdParams {
  id?: string;
  taskId?: string;
  metadata?: MetadataMap;
}

export interface A2AListTasksParams {
  contextId?: string;
  limit?: number;
  pageSize?: number;
  pageToken?: string;
  state?: A2ATaskState | string;
  metadata?: MetadataMap;
}

export interface A2AListTasksResult {
  tasks: A2ATask[];
  pageSize: number;
  nextPageToken?: string;
  totalSize?: number;
}

export function a2aTaskStateFromFlightState(state: FlightRecord["state"]): A2ATaskState {
  switch (state) {
    case "queued":
    case "waking":
      return "TASK_STATE_SUBMITTED";
    case "running":
      return "TASK_STATE_WORKING";
    case "waiting":
      return "TASK_STATE_INPUT_REQUIRED";
    case "completed":
      return "TASK_STATE_COMPLETED";
    case "failed":
      return "TASK_STATE_FAILED";
    case "cancelled":
      return "TASK_STATE_CANCELED";
    default: {
      const exhaustive: never = state;
      void exhaustive;
      return "TASK_STATE_UNKNOWN";
    }
  }
}

export function isA2ATerminalTaskState(state: A2ATaskState): boolean {
  return state === "TASK_STATE_COMPLETED"
    || state === "TASK_STATE_FAILED"
    || state === "TASK_STATE_CANCELED"
    || state === "TASK_STATE_REJECTED";
}

export function a2aTextPart(text: string, metadata?: MetadataMap): A2APart {
  return metadata && Object.keys(metadata).length > 0 ? { text, metadata } : { text };
}

export function a2aTextMessage(input: {
  role: A2ARole;
  text: string;
  messageId: string;
  contextId?: string;
  taskId?: string;
  metadata?: MetadataMap;
}): A2AMessage {
  return {
    role: input.role,
    parts: [a2aTextPart(input.text)],
    messageId: input.messageId,
    ...(input.contextId ? { contextId: input.contextId } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.metadata && Object.keys(input.metadata).length > 0 ? { metadata: input.metadata } : {}),
  };
}

export function a2aTextFromParts(parts: unknown): string {
  if (!Array.isArray(parts)) {
    return "";
  }
  return parts
    .map((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) {
        return "";
      }
      const record = part as Record<string, unknown>;
      return typeof record.text === "string" ? record.text.trim() : "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

export function a2aTextFromMessage(message: unknown): string {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return "";
  }
  return a2aTextFromParts((message as { parts?: unknown }).parts);
}

export function a2aContextIdForInvocation(invocation: InvocationRequest, fallback = "openscout"): string {
  return invocation.conversationId
    ?? (typeof invocation.metadata?.a2aContextId === "string" ? invocation.metadata.a2aContextId : undefined)
    ?? fallback;
}

export function a2aTaskFromFlight(
  flight: FlightRecord,
  invocation?: InvocationRequest,
  options: {
    contextId?: string;
    includeHistory?: boolean;
    timestamp?: string;
  } = {},
): A2ATask {
  const contextId = options.contextId ?? (invocation ? a2aContextIdForInvocation(invocation, flight.id) : flight.id);
  const state = a2aTaskStateFromFlightState(flight.state);
  const timestamp = options.timestamp ?? new Date(flight.completedAt ?? Date.now()).toISOString();
  const statusText = flight.error ?? flight.summary;
  const statusMessage = statusText
    ? a2aTextMessage({
        role: "ROLE_AGENT",
        text: statusText,
        messageId: `${flight.id}:status`,
        taskId: flight.id,
        contextId,
      })
    : undefined;
  const output = typeof flight.output === "string" && flight.output.trim() ? flight.output.trim() : "";
  const artifacts = output
    ? [{
        artifactId: `${flight.id}:output`,
        name: "OpenScout output",
        parts: [a2aTextPart(output)],
      }]
    : undefined;
  const history: A2AMessage[] = [];
  if (options.includeHistory && invocation?.task) {
    history.push(a2aTextMessage({
      role: "ROLE_USER",
      text: invocation.task,
      messageId: invocation.messageId ?? `${invocation.id}:message`,
      contextId,
      taskId: flight.id,
    }));
    if (output) {
      history.push(a2aTextMessage({
        role: "ROLE_AGENT",
        text: output,
        messageId: `${flight.id}:reply`,
        contextId,
        taskId: flight.id,
      }));
    }
  }

  return {
    id: flight.id,
    contextId,
    status: {
      state,
      ...(statusMessage ? { message: statusMessage } : {}),
      timestamp,
    },
    ...(artifacts ? { artifacts } : {}),
    ...(history.length > 0 ? { history } : {}),
    metadata: {
      scoutInvocationId: flight.invocationId,
      scoutRequesterId: flight.requesterId,
      scoutTargetAgentId: flight.targetAgentId,
      ...(flight.metadata ?? {}),
    },
  };
}

function a2aSkillId(input: string, fallback: string): string {
  const normalized = input
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

export function a2aAgentCardFromScoutCard(
  card: ScoutAgentCard,
  options: {
    url: string;
    protocolVersion?: string;
    protocolBinding?: string;
    transport?: string;
    capabilities?: Partial<A2AAgentCapabilities>;
  },
): A2AAgentCard {
  const inputModes = card.defaultInputModes?.length ? card.defaultInputModes : ["text/plain"];
  const outputModes = card.defaultOutputModes?.length ? card.defaultOutputModes : ["text/plain"];
  const skills = (card.skills?.length ? card.skills : [{
    id: "chat",
    name: "Chat",
    description: `Route messages and invocations to ${card.displayName}.`,
    tags: ["openscout", card.harness],
  }]).map((skill, index) => ({
    id: skill.id?.trim() || a2aSkillId(skill.name, `skill-${index + 1}`),
    name: skill.name,
    description: skill.description ?? skill.name,
    ...(skill.tags?.length ? { tags: skill.tags } : {}),
    ...(skill.examples?.length ? { examples: skill.examples } : {}),
    inputModes,
    outputModes,
  }));

  return {
    protocolVersion: options.protocolVersion ?? A2A_PROTOCOL_VERSION,
    name: card.displayName,
    description: card.description ?? `OpenScout route for ${card.displayName}.`,
    url: options.url,
    preferredTransport: options.transport ?? "JSONRPC",
    ...(card.provider?.organization ? {
      provider: {
        organization: card.provider.organization,
        ...(card.provider.url ? { url: card.provider.url } : {}),
      },
    } : {}),
    ...(card.version ? { version: card.version } : {}),
    ...(card.documentationUrl ? { documentationUrl: card.documentationUrl } : {}),
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: true,
      extendedAgentCard: true,
      ...options.capabilities,
    },
    defaultInputModes: inputModes,
    defaultOutputModes: outputModes,
    skills,
    supportedInterfaces: [
      {
        url: options.url,
        protocolBinding: options.protocolBinding ?? "JSONRPC",
        protocolVersion: options.protocolVersion ?? A2A_PROTOCOL_VERSION,
        transport: options.transport ?? "http",
        tenant: card.agentId,
      },
    ],
    ...(card.securitySchemes ? { securitySchemes: card.securitySchemes } : {}),
    ...(card.securityRequirements ? {
      security: card.securityRequirements.map((requirement) => Object.fromEntries(
        requirement.map((scheme) => [scheme, [] as string[]]),
      )),
    } : {}),
    metadata: {
      scoutAgentId: card.agentId,
      scoutDefinitionId: card.definitionId,
      scoutHandle: card.handle,
      scoutSelector: card.selector,
      scoutHarness: card.harness,
      scoutTransport: card.transport,
      brokerRegistered: card.brokerRegistered,
      ...(card.metadata ?? {}),
    },
  };
}
