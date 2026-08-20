import { randomUUID } from "node:crypto";

import type {
  AgentEndpoint,
  InvocationRequest,
  MetadataMap,
  A2AJsonRpcMethod,
  A2AJsonRpcResponse,
} from "@openscout/protocol";
import {
  A2A_JSON_RPC_METHODS,
  A2A_LEGACY_JSON_RPC_METHODS,
} from "@openscout/protocol";

const DEFAULT_A2A_INVOCATION_TIMEOUT_MS = 120_000;
const MAX_ERROR_BODY_CHARS = 2_000;

export type A2AHttpInvocationResult = {
  output: string;
  externalSessionId?: string | null;
  metadata?: Record<string, unknown>;
};

type A2AMessage = {
  kind?: unknown;
  role?: unknown;
  messageId?: unknown;
  contextId?: unknown;
  parts?: unknown;
  metadata?: unknown;
};

type A2AArtifact = {
  parts?: unknown;
};

type A2ATask = {
  kind?: unknown;
  id?: unknown;
  contextId?: unknown;
  status?: {
    state?: unknown;
    message?: unknown;
  };
  artifacts?: unknown;
  history?: unknown;
  metadata?: unknown;
};

type A2AJsonRpcError = NonNullable<A2AJsonRpcResponse["error"]>;

type A2AWireStyle = "canonical" | "legacy";

function metadataStringValue(metadata: MetadataMap | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function metadataRecord(metadata: MetadataMap | undefined, key: string): Record<string, unknown> | null {
  return asRecord(metadata?.[key]);
}

function recordStringValue(record: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function metadataSupportedInterfaces(metadata: MetadataMap | undefined): Record<string, unknown>[] {
  const value = metadata?.supportedInterfaces;
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry));
}

function interfaceLooksA2A(entry: Record<string, unknown>): boolean {
  const protocol = recordStringValue(entry, "protocol")?.toLowerCase();
  const binding = recordStringValue(entry, "protocolBinding")?.toLowerCase();
  if (protocol === "a2a" || protocol === "a2a-jsonrpc") {
    return true;
  }
  return Boolean(binding && (binding.includes("jsonrpc") || binding.includes("a2a")));
}

function normalizedHttpUrl(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function a2aExecutionUrlForEndpoint(endpoint: AgentEndpoint): string | null {
  const metadata = endpoint.metadata;
  const direct = normalizedHttpUrl(
    metadataStringValue(metadata, "a2aExecutionUrl")
      ?? metadataStringValue(metadata, "a2aUrl")
      ?? null,
  );
  if (direct) {
    return direct;
  }

  const card = metadataRecord(metadata, "a2aAgentCard") ?? metadataRecord(metadata, "agentCard");
  const cardExecutionUrl = normalizedHttpUrl(recordStringValue(card, "url"));
  if (cardExecutionUrl) {
    return cardExecutionUrl;
  }

  const supportedInterface = metadataSupportedInterfaces(metadata)
    .find((entry) => interfaceLooksA2A(entry) && normalizedHttpUrl(recordStringValue(entry, "url")));
  const interfaceUrl = normalizedHttpUrl(recordStringValue(supportedInterface, "url"));
  if (interfaceUrl) {
    return interfaceUrl;
  }

  return normalizedHttpUrl(endpoint.address);
}

export function isA2AHttpEndpoint(endpoint: AgentEndpoint | null | undefined): boolean {
  return Boolean(
    endpoint
      && endpoint.transport === "http"
      && endpoint.state !== "offline"
      && a2aExecutionUrlForEndpoint(endpoint),
  );
}

function endpointHeaders(endpoint: AgentEndpoint): Record<string, string> {
  const configured = metadataRecord(endpoint.metadata, "a2aHeaders") ?? metadataRecord(endpoint.metadata, "headers");
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  for (const [key, value] of Object.entries(configured ?? {})) {
    if (typeof value === "string" && key.trim()) {
      headers[key] = value;
    }
  }
  return headers;
}

function endpointA2AProtocolVersion(endpoint: AgentEndpoint): string | null {
  const metadata = endpoint.metadata;
  const direct = metadataStringValue(metadata, "a2aProtocolVersion");
  if (direct) {
    return direct;
  }
  const card = metadataRecord(metadata, "a2aAgentCard") ?? metadataRecord(metadata, "agentCard");
  const cardVersion = recordStringValue(card, "protocolVersion");
  if (cardVersion) {
    return cardVersion;
  }
  const supportedInterface = metadataSupportedInterfaces(metadata)
    .find((entry) => interfaceLooksA2A(entry) && recordStringValue(entry, "protocolVersion"));
  return recordStringValue(supportedInterface, "protocolVersion");
}

function endpointA2AWireStyle(endpoint: AgentEndpoint): A2AWireStyle {
  const configured = metadataStringValue(endpoint.metadata, "a2aWireStyle")
    ?? metadataStringValue(endpoint.metadata, "a2aJsonRpcStyle");
  if (configured === "canonical" || configured === "v1") {
    return "canonical";
  }
  if (configured === "legacy" || configured === "slash") {
    return "legacy";
  }
  const version = endpointA2AProtocolVersion(endpoint);
  return version?.startsWith("1.") ? "canonical" : "legacy";
}

function endpointMessageSendMethodAttempts(endpoint: AgentEndpoint): Array<{
  method: A2AJsonRpcMethod;
  style: A2AWireStyle;
}> {
  const configured = metadataStringValue(endpoint.metadata, "a2aJsonRpcMethod")
    ?? metadataStringValue(endpoint.metadata, "a2aMessageSendMethod");
  if (configured) {
    return [{
      method: configured as A2AJsonRpcMethod,
      style: configured.includes("/") ? "legacy" : endpointA2AWireStyle(endpoint),
    }];
  }

  return endpointA2AWireStyle(endpoint) === "canonical"
    ? [
        { method: A2A_JSON_RPC_METHODS.sendMessage, style: "canonical" },
        { method: A2A_LEGACY_JSON_RPC_METHODS.sendMessage, style: "legacy" },
      ]
    : [
        { method: A2A_LEGACY_JSON_RPC_METHODS.sendMessage, style: "legacy" },
        { method: A2A_JSON_RPC_METHODS.sendMessage, style: "canonical" },
      ];
}

function definedRecord(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  );
}

function a2aContextIdForInvocation(
  endpoint: AgentEndpoint,
  invocation: InvocationRequest,
): string | undefined {
  const explicit = invocation.execution?.targetSessionId?.trim();
  if (explicit) {
    return explicit;
  }
  if (invocation.execution?.session === "existing") {
    return endpoint.sessionId?.trim() || metadataStringValue(endpoint.metadata, "externalSessionId") || undefined;
  }
  return undefined;
}

function buildA2AMessage(
  endpoint: AgentEndpoint,
  invocation: InvocationRequest,
  style: A2AWireStyle,
): Record<string, unknown> {
  const contextId = a2aContextIdForInvocation(endpoint, invocation);
  const parts = [
    definedRecord({
      ...(style === "legacy" ? { kind: "text" } : {}),
      text: invocation.task,
    }),
  ];
  return definedRecord({
    ...(style === "legacy" ? { kind: "message" } : {}),
    role: style === "legacy" ? "user" : "ROLE_USER",
    messageId: invocation.messageId ?? randomUUID(),
    contextId,
    parts,
    metadata: definedRecord({
      scoutInvocationId: invocation.id,
      scoutRequesterId: invocation.requesterId,
      scoutConversationId: invocation.conversationId,
      scoutAction: invocation.action,
      scoutLabels: invocation.labels,
      scoutContext: invocation.context,
      scoutMetadata: invocation.metadata,
    }),
  });
}

function isTextPart(part: unknown): part is { text: string } {
  const record = asRecord(part);
  if (!record) {
    return false;
  }
  const kind = typeof record.kind === "string" ? record.kind : record.type;
  return (kind === undefined || kind === "text") && typeof record.text === "string";
}

function textFromParts(parts: unknown): string {
  if (!Array.isArray(parts)) {
    return "";
  }
  return parts
    .filter(isTextPart)
    .map((part) => String(part.text).trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function textFromMessage(message: unknown): string {
  const record = asRecord(message) as A2AMessage | null;
  return record ? textFromParts(record.parts) : "";
}

function textFromArtifacts(artifacts: unknown): string {
  if (!Array.isArray(artifacts)) {
    return "";
  }
  return artifacts
    .map((artifact) => textFromParts((asRecord(artifact) as A2AArtifact | null)?.parts))
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function textFromHistory(history: unknown): string {
  if (!Array.isArray(history)) {
    return "";
  }
  const agentMessages = history
    .map((entry) => asRecord(entry) as A2AMessage | null)
    .filter((entry): entry is A2AMessage => Boolean(entry))
    .filter((entry) => entry.role === "agent" || entry.role === "ROLE_AGENT");
  for (const message of [...agentMessages].reverse()) {
    const text = textFromMessage(message);
    if (text) {
      return text;
    }
  }
  return "";
}

function outputFromA2AResult(result: unknown): string {
  const record = asRecord(result);
  if (!record) {
    return "";
  }

  if ("message" in record) {
    return textFromMessage(record.message);
  }

  if ("task" in record) {
    return outputFromA2AResult(record.task);
  }

  if (record.kind === "message") {
    return textFromMessage(record);
  }

  const task = record as A2ATask;
  return textFromArtifacts(task.artifacts)
    || textFromMessage(task.status?.message)
    || textFromHistory(task.history);
}

function compactErrorData(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    return JSON.stringify(value).slice(0, MAX_ERROR_BODY_CHARS);
  } catch {
    return String(value).slice(0, MAX_ERROR_BODY_CHARS);
  }
}

function jsonRpcErrorMessage(error: A2AJsonRpcError): string {
  const message = typeof error.message === "string" && error.message.trim()
    ? error.message.trim()
    : "A2A endpoint returned a JSON-RPC error";
  const code = error.code === undefined ? "" : ` (${String(error.code)})`;
  const data = compactErrorData(error.data);
  return data ? `${message}${code}: ${data}` : `${message}${code}`;
}

function taskResultFromA2AResult(result: unknown): Record<string, unknown> | null {
  const record = asRecord(result);
  if (!record) {
    return null;
  }
  if ("task" in record) {
    return asRecord(record.task);
  }
  return record;
}

function resultMetadata(endpointUrl: string, result: unknown): Record<string, unknown> {
  const task = taskResultFromA2AResult(result) as A2ATask | null;
  const metadata = asRecord(task?.metadata);
  return definedRecord({
    a2aExecutionUrl: endpointUrl,
    a2aTaskId: typeof task?.id === "string" ? task.id : undefined,
    a2aContextId: typeof task?.contextId === "string" ? task.contextId : undefined,
    a2aState: typeof task?.status?.state === "string" ? task.status.state : undefined,
    a2aMetadata: metadata ?? undefined,
  });
}

async function parseJsonResponse(response: Response, endpointUrl: string): Promise<A2AJsonRpcResponse> {
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(
      `A2A endpoint ${endpointUrl} returned non-JSON response (${response.status} ${response.statusText}): ${text.slice(0, MAX_ERROR_BODY_CHARS)}`,
    );
  }

  if (!response.ok) {
    throw new Error(
      `A2A endpoint ${endpointUrl} rejected request (${response.status} ${response.statusText}): ${text.slice(0, MAX_ERROR_BODY_CHARS)}`,
    );
  }

  const record = asRecord(parsed);
  if (!record) {
    throw new Error(
      `A2A endpoint ${endpointUrl} returned an invalid JSON-RPC response.`,
    );
  }
  return record as unknown as A2AJsonRpcResponse;
}

function invocationTimeoutMs(invocation: InvocationRequest): number {
  if (typeof invocation.timeoutMs === "number" && Number.isFinite(invocation.timeoutMs) && invocation.timeoutMs > 0) {
    return Math.floor(invocation.timeoutMs);
  }
  return DEFAULT_A2A_INVOCATION_TIMEOUT_MS;
}

async function sendA2AJsonRpcRequest(
  endpoint: AgentEndpoint,
  endpointUrl: string,
  method: A2AJsonRpcMethod,
  style: A2AWireStyle,
  invocation: InvocationRequest,
): Promise<A2AJsonRpcResponse> {
  const request = {
    jsonrpc: "2.0",
    id: randomUUID(),
    method,
    params: {
      message: buildA2AMessage(endpoint, invocation, style),
    },
  };

  let response: Response;
  try {
    response = await fetch(endpointUrl, {
      method: "POST",
      headers: endpointHeaders(endpoint),
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(invocationTimeoutMs(invocation)),
    });
  } catch (error) {
    throw new Error(
      `A2A endpoint ${endpointUrl} could not be reached: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return parseJsonResponse(response, endpointUrl);
}

function shouldTryLegacyFallback(error: A2AJsonRpcError): boolean {
  return error.code === -32601 || error.code === -32602;
}

export async function invokeA2AHttpEndpoint(
  endpoint: AgentEndpoint,
  invocation: InvocationRequest,
): Promise<A2AHttpInvocationResult> {
  const endpointUrl = a2aExecutionUrlForEndpoint(endpoint);
  if (!endpointUrl) {
    throw new Error(`Endpoint ${endpoint.id} is missing an A2A execution URL.`);
  }

  const attempts = endpointMessageSendMethodAttempts(endpoint);
  let payload: A2AJsonRpcResponse | null = null;
  for (const [index, attempt] of attempts.entries()) {
    payload = await sendA2AJsonRpcRequest(endpoint, endpointUrl, attempt.method, attempt.style, invocation);
    if (!payload.error || index === attempts.length - 1 || !shouldTryLegacyFallback(payload.error)) {
      break;
    }
  }
  if (!payload) {
    throw new Error(`A2A endpoint ${endpointUrl} did not return a JSON-RPC response.`);
  }
  if (payload.error) {
    throw new Error(jsonRpcErrorMessage(payload.error));
  }

  const output = outputFromA2AResult(payload.result);
  const metadata = resultMetadata(endpointUrl, payload.result);
  const externalSessionId = typeof metadata.a2aContextId === "string"
    ? metadata.a2aContextId
    : typeof metadata.a2aTaskId === "string"
    ? metadata.a2aTaskId
    : null;
  return {
    output,
    externalSessionId,
    metadata,
  };
}
