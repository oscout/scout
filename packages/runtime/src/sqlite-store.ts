import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { and, asc, eq } from "drizzle-orm";

import {
  epochMs,
  normalizeTerminalWorkspaceColumns,
  nowMs,
  parseTerminalWorkspaceLayoutJson,
} from "@openscout/protocol";
import type {
  ActorIdentity,
  AgentDefinition,
  AgentEndpoint,
  BudgetQuotaWindowSnapshot,
  BudgetUsageRecord,
  CollaborationEvent,
  CollaborationRecord,
  CollaborationRelation,
  CollaborationPriority,
  CollaborationWaitingOn,
  CollaborationProgress,
  WorkItemState,
  QuestionState,
  ControlEvent,
  ConversationBinding,
  ConversationDefinition,
  ConversationReadCursor,
  DeliveryAttempt,
  DeliveryIntent,
  DurableAction,
  DurableActionCreateInput,
  DurableActionClaimInput,
  DurableActionHeartbeatInput,
  DurableAttempt,
  DurableCheckpoint,
  DurableSignal,
  FlightRecord,
  InvocationRequest,
  MessageAttachment,
  MessageMention,
  MessageRecord,
  NodeDefinition,
  ScoutDispatchRecord,
  TerminalSessionRecord,
  TerminalSessionRecordInput,
  TerminalSurface,
  TerminalWorkspaceCell,
  TerminalWorkspaceRecord,
  TerminalWorkspaceRecordInput,
  ThreadCollaborationEventSummary,
  ThreadCollaborationSummary,
  ThreadEventEnvelope,
  ThreadEventKind,
  ThreadEventNotification,
  ThreadFlightSummary,
  ThreadMessageSummary,
  ThreadSnapshot,
  TrustedPeerRecord,
} from "@openscout/protocol";

import {
  createRuntimeRegistrySnapshot,
  type RuntimeRegistrySnapshot,
} from "./registry.js";
import { openControlPlaneDrizzle } from "./drizzle-client.js";
import {
  openControlPlaneSqliteDatabase,
  type ControlPlaneSqliteBinding,
  type ControlPlaneSqliteDatabase,
  type ControlPlaneSqliteTransactionalDatabase,
} from "./sqlite-adapter.js";
import {
  configureControlPlaneDatabase,
  migrateControlPlaneDatabaseSchema,
} from "./control-plane-migrations.js";
import { Conversations, type ConversationsApi } from "./conversations/api.js";
import {
  deliveryAttemptsTable,
  deliveriesTable,
} from "./drizzle-schema.js";
import { budgetObservationsFromEndpoint } from "./budget-observations.js";

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function stringify(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function currentTimestampMs(): number {
  return nowMs();
}

const RUNTIME_SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const RUNTIME_SESSION_ALIAS_METADATA_KEYS = [
  { key: "sessionId", kind: "metadata_session" },
  { key: "externalSessionId", kind: "external" },
  { key: "threadId", kind: "thread" },
  { key: "nativeSessionId", kind: "native" },
  { key: "runtimeSessionId", kind: "runtime" },
  { key: "runtimeInstanceId", kind: "runtime" },
  { key: "tmuxSession", kind: "tmux" },
  { key: "pairingSessionId", kind: "pairing" },
] as const;

function normalizeTimestampMs(value: number | null | undefined): number | null {
  return epochMs(value);
}

function stableHash(value: string, length = 20): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function metadataStringValue(metadata: Record<string, unknown> | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function metadataTimestampValue(metadata: Record<string, unknown> | undefined, key: string): number | null {
  const value = metadata?.[key];
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return null;
}

function firstStringValue(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
}

function isSqliteConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
  return code.includes("SQLITE_CONSTRAINT")
    || message.includes("SQLITE_CONSTRAINT")
    || message.includes("constraint failed");
}

function metadataValue(
  metadata: Record<string, unknown> | undefined,
  key: string,
): unknown {
  return metadata?.[key];
}

function stringValue(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadataValue(metadata, key);
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function invocationStringValue(invocation: InvocationRequest, key: string): string | undefined {
  const contextValue = stringValue(invocation.context, key);
  if (contextValue) {
    return contextValue;
  }

  const nestedContext = metadataValue(invocation.context, "collaboration");
  if (nestedContext && typeof nestedContext === "object" && !Array.isArray(nestedContext)) {
    const nestedValue = stringValue(nestedContext as Record<string, unknown>, key);
    if (nestedValue) {
      return nestedValue;
    }
  }

  const metadataEntry = stringValue(invocation.metadata, key);
  if (metadataEntry) {
    return metadataEntry;
  }

  const nestedMetadata = metadataValue(invocation.metadata, "collaboration");
  if (nestedMetadata && typeof nestedMetadata === "object" && !Array.isArray(nestedMetadata)) {
    return stringValue(nestedMetadata as Record<string, unknown>, key);
  }

  return undefined;
}

function resolveInvocationCollaborationRecordId(invocation: InvocationRequest): string | undefined {
  return invocation.collaborationRecordId?.trim()
    || invocationStringValue(invocation, "collaborationRecordId")
    || invocationStringValue(invocation, "recordId");
}

type SQLiteBinding = ControlPlaneSqliteBinding;

type SQLiteStatementLike<Row, Params extends SQLiteBinding[]> = {
  all(...params: Params): Row[];
  get(...params: Params): Row | null;
};

type SQLiteTransactionalDatabase = ControlPlaneSqliteTransactionalDatabase;

function queryAll<Row, Params extends SQLiteBinding[] = []>(
  db: ControlPlaneSqliteDatabase,
  sql: string,
  ...params: Params
): Row[] {
  const statement = db.query(sql) as SQLiteStatementLike<Row, Params>;
  return statement.all(...params);
}

function queryAllDynamic<Row>(
  db: ControlPlaneSqliteDatabase,
  sql: string,
  params: SQLiteBinding[],
): Row[] {
  const statement = db.query(sql) as SQLiteStatementLike<Row, SQLiteBinding[]>;
  return statement.all(...params);
}

function queryGet<Row, Params extends SQLiteBinding[] = []>(
  db: ControlPlaneSqliteDatabase,
  sql: string,
  ...params: Params
): Row | null {
  const statement = db.query(sql) as SQLiteStatementLike<Row, Params>;
  return statement.get(...params);
}

function summarizeText(value: string, maxLength = 120): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

interface ActorRow {
  id: string;
  kind: ActorIdentity["kind"];
  display_name: string;
  handle: string | null;
  labels_json: string | null;
  metadata_json: string | null;
}

interface NodeRow {
  id: string;
  mesh_id: string;
  name: string;
  host_name: string | null;
  advertise_scope: NodeDefinition["advertiseScope"];
  broker_url: string | null;
  tailnet_name: string | null;
  capabilities_json: string | null;
  labels_json: string | null;
  metadata_json: string | null;
  last_seen_at: number | null;
  registered_at: number;
}

interface TrustedPeerRow {
  key_id: string;
  public_key: string;
  fingerprint: string;
  node_id: string | null;
  label: string;
  tier: TrustedPeerRecord["tier"];
  granted_via: TrustedPeerRecord["grantedVia"];
  granted_at: number;
  expires_at: number | null;
  revoked_at: number | null;
  last_seen_at: number | null;
  metadata_json: string | null;
  tls_spki_fingerprint: string | null;
}

interface AgentRow {
  id: string;
  definition_id: string;
  node_qualifier: string | null;
  workspace_qualifier: string | null;
  selector: string | null;
  default_selector: string | null;
  agent_class: AgentDefinition["agentClass"];
  capabilities_json: string;
  wake_policy: AgentDefinition["wakePolicy"];
  home_node_id: string;
  authority_node_id: string;
  advertise_scope: AgentDefinition["advertiseScope"];
  owner_id: string | null;
  metadata_json: string | null;
}

interface EndpointRow {
  id: string;
  agent_id: string;
  node_id: string;
  harness: AgentEndpoint["harness"];
  transport: AgentEndpoint["transport"];
  state: AgentEndpoint["state"];
  address: string | null;
  session_id: string | null;
  pane: string | null;
  cwd: string | null;
  project_root: string | null;
  metadata_json: string | null;
}

interface RuntimeSessionRow {
  id: string;
  agent_id: string;
  endpoint_id: string;
  node_id: string;
  harness: string;
  transport: string;
  state: string;
  primary_alias: string;
  external_session_id: string | null;
  cwd: string | null;
  project_root: string | null;
  started_at: number | null;
  last_seen_at: number;
  ended_at: number | null;
  expires_at: number | null;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
}

interface RuntimeSessionAliasRow {
  alias: string;
  session_id: string;
  alias_kind: string;
  agent_id: string;
  endpoint_id: string;
  node_id: string;
  harness: string;
  transport: string;
  first_seen_at: number;
  last_seen_at: number;
  expires_at: number | null;
}

export type RuntimeSessionIndexRecord = {
  id: string;
  agentId: string;
  endpointId: string;
  nodeId: string;
  harness: string;
  transport: string;
  state: string;
  primaryAlias: string;
  externalSessionId?: string;
  cwd?: string;
  projectRoot?: string;
  startedAt?: number;
  lastSeenAt: number;
  endedAt?: number;
  expiresAt?: number;
  createdAt: number;
  updatedAt: number;
  metadata?: Record<string, unknown>;
};

export type RuntimeSessionAliasRecord = {
  alias: string;
  sessionId: string;
  aliasKind: string;
  agentId: string;
  endpointId: string;
  nodeId: string;
  harness: string;
  transport: string;
  firstSeenAt: number;
  lastSeenAt: number;
  expiresAt?: number;
};

interface TerminalSessionRow {
  id: string;
  harness: string;
  source_session_id: string;
  cwd: string;
  resume_command: string;
  surfaces_json: string | null;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
}

interface TerminalWorkspaceRow {
  id: string;
  name: string;
  purpose: string;
  columns_count: number;
  /** Absent, not just null, on a row read from a table that predates the column. */
  layout_json?: string | null;
  cells_json: string | null;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
}

interface BudgetUsageRow {
  id: string;
  scope: BudgetUsageRecord["scope"];
  source: BudgetUsageRecord["source"];
  provider: string | null;
  harness: string | null;
  transport: string | null;
  model: string | null;
  agent_id: string | null;
  endpoint_id: string | null;
  session_id: string | null;
  project_root: string | null;
  conversation_id: string | null;
  message_id: string | null;
  invocation_id: string | null;
  flight_id: string | null;
  work_id: string | null;
  occurred_at: number;
  input_tokens: number | null;
  output_tokens: number | null;
  reasoning_output_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  total_tokens: number | null;
  estimated_usd: number | null;
  billed_usd: number | null;
  currency: string | null;
  dedup_key: string | null;
  metadata_json: string | null;
  created_at: number;
}

interface BudgetQuotaWindowRow {
  id: string;
  source: BudgetQuotaWindowSnapshot["source"];
  provider: string | null;
  harness: string | null;
  transport: string | null;
  model: string | null;
  agent_id: string | null;
  endpoint_id: string | null;
  session_id: string | null;
  user_id: string | null;
  account_id: string | null;
  plan_type: string | null;
  label: string;
  window_kind: string | null;
  used_percent: number | null;
  percent_remaining: number | null;
  used: number | null;
  limit_value: number | null;
  reset_at: number | null;
  window_ms: number | null;
  captured_at: number;
  metadata_json: string | null;
  created_at: number;
}

interface BudgetUsageListOptions {
  scope?: BudgetUsageRecord["scope"];
  provider?: string;
  agentId?: string;
  endpointId?: string;
  sessionId?: string;
  invocationId?: string;
  flightId?: string;
  since?: number;
  until?: number;
  limit?: number;
}

interface BudgetQuotaWindowListOptions {
  provider?: string;
  agentId?: string;
  endpointId?: string;
  sessionId?: string;
  label?: string;
  source?: BudgetQuotaWindowSnapshot["source"];
  since?: number;
  until?: number;
  limit?: number;
}

function budgetUsageFromRow(row: BudgetUsageRow): BudgetUsageRecord {
  return {
    id: row.id,
    scope: row.scope,
    source: row.source,
    provider: row.provider ?? undefined,
    harness: row.harness ?? undefined,
    transport: row.transport ?? undefined,
    model: row.model ?? undefined,
    agentId: row.agent_id ?? undefined,
    endpointId: row.endpoint_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    projectRoot: row.project_root ?? undefined,
    conversationId: row.conversation_id ?? undefined,
    messageId: row.message_id ?? undefined,
    invocationId: row.invocation_id ?? undefined,
    flightId: row.flight_id ?? undefined,
    workId: row.work_id ?? undefined,
    occurredAt: row.occurred_at,
    inputTokens: row.input_tokens ?? undefined,
    outputTokens: row.output_tokens ?? undefined,
    reasoningOutputTokens: row.reasoning_output_tokens ?? undefined,
    cacheCreationInputTokens: row.cache_creation_input_tokens ?? undefined,
    cacheReadInputTokens: row.cache_read_input_tokens ?? undefined,
    totalTokens: row.total_tokens ?? undefined,
    estimatedUsd: row.estimated_usd ?? undefined,
    billedUsd: row.billed_usd ?? undefined,
    currency: row.currency ?? undefined,
    dedupKey: row.dedup_key ?? undefined,
    metadata: parseJson<Record<string, unknown> | undefined>(row.metadata_json, undefined),
    createdAt: row.created_at,
  };
}

function normalizedListLimit(value: number | undefined, fallback = 100, max = 500): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function budgetQuotaWindowFromRow(row: BudgetQuotaWindowRow): BudgetQuotaWindowSnapshot {
  return {
    id: row.id,
    source: row.source,
    provider: row.provider ?? undefined,
    harness: row.harness ?? undefined,
    transport: row.transport ?? undefined,
    model: row.model ?? undefined,
    agentId: row.agent_id ?? undefined,
    endpointId: row.endpoint_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    userId: row.user_id ?? undefined,
    accountId: row.account_id ?? undefined,
    planType: row.plan_type ?? undefined,
    label: row.label,
    windowKind: row.window_kind ?? undefined,
    usedPercent: row.used_percent ?? undefined,
    percentRemaining: row.percent_remaining ?? undefined,
    used: row.used ?? undefined,
    limit: row.limit_value ?? undefined,
    resetAt: row.reset_at ?? undefined,
    windowMs: row.window_ms ?? undefined,
    capturedAt: row.captured_at,
    metadata: parseJson<Record<string, unknown> | undefined>(row.metadata_json, undefined),
    createdAt: row.created_at,
  };
}

function runtimeSessionFromRow(row: RuntimeSessionRow): RuntimeSessionIndexRecord {
  return {
    id: row.id,
    agentId: row.agent_id,
    endpointId: row.endpoint_id,
    nodeId: row.node_id,
    harness: row.harness,
    transport: row.transport,
    state: row.state,
    primaryAlias: row.primary_alias,
    externalSessionId: row.external_session_id ?? undefined,
    cwd: row.cwd ?? undefined,
    projectRoot: row.project_root ?? undefined,
    startedAt: row.started_at ?? undefined,
    lastSeenAt: row.last_seen_at,
    endedAt: row.ended_at ?? undefined,
    expiresAt: row.expires_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: parseJson<Record<string, unknown> | undefined>(row.metadata_json, undefined),
  };
}

/** Deterministic registry id so re-intaking the same harness session updates one record. */
function terminalSessionRegistryId(harness: string, sourceSessionId: string): string {
  return `ts.${stableHash(`${harness}${sourceSessionId}`)}`;
}

function terminalWorkspaceFromRow(row: TerminalWorkspaceRow): TerminalWorkspaceRecord {
  const layout = parseTerminalWorkspaceLayoutJson(row.layout_json);
  return {
    id: row.id,
    name: row.name,
    purpose: row.purpose,
    columns: normalizeTerminalWorkspaceColumns(row.columns_count),
    // Absent for a row written before layouts were stored, and for a row from a
    // table that predates the column. The record then carries only the resolved
    // column count and `terminalWorkspaceLayoutOf` infers a shape from it — a
    // fold-forward, not a substitute, which is why the column exists.
    ...(layout ? { layout } : {}),
    cells: parseJson<TerminalWorkspaceCell[]>(row.cells_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: parseJson<Record<string, unknown> | undefined>(row.metadata_json, undefined),
  };
}

function terminalSessionFromRow(row: TerminalSessionRow): TerminalSessionRecord {
  return {
    id: row.id,
    harness: row.harness,
    sourceSessionId: row.source_session_id,
    cwd: row.cwd,
    resumeCommand: row.resume_command,
    surfaces: parseJson<TerminalSurface[]>(row.surfaces_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: parseJson<Record<string, unknown> | undefined>(row.metadata_json, undefined),
  };
}

function trustedPeerFromRow(row: TrustedPeerRow): TrustedPeerRecord {
  return {
    keyId: row.key_id,
    publicKey: row.public_key,
    fingerprint: row.fingerprint,
    nodeId: row.node_id ?? undefined,
    label: row.label,
    tier: row.tier,
    grantedVia: row.granted_via,
    grantedAt: row.granted_at,
    expiresAt: row.expires_at ?? undefined,
    revokedAt: row.revoked_at ?? undefined,
    lastSeenAt: row.last_seen_at ?? undefined,
    metadata: parseJson<Record<string, unknown> | undefined>(row.metadata_json, undefined),
    tlsSpkiFingerprint: row.tls_spki_fingerprint ?? undefined,
  };
}

function runtimeSessionAliasFromRow(row: RuntimeSessionAliasRow): RuntimeSessionAliasRecord {
  return {
    alias: row.alias,
    sessionId: row.session_id,
    aliasKind: row.alias_kind,
    agentId: row.agent_id,
    endpointId: row.endpoint_id,
    nodeId: row.node_id,
    harness: row.harness,
    transport: row.transport,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at ?? undefined,
  };
}

type RuntimeSessionAliasInput = {
  alias: string;
  aliasKind: string;
};

function runtimeSessionMetadata(endpoint: AgentEndpoint): Record<string, unknown> {
  return endpoint.metadata ?? {};
}

function endpointRuntimeSessionPrimaryAlias(endpoint: AgentEndpoint): string | null {
  const metadata = runtimeSessionMetadata(endpoint);
  if (metadata.cardless === true) {
    return firstStringValue(
      metadataStringValue(metadata, "handle"),
      metadataStringValue(metadata, "externalSessionId"),
      metadataStringValue(metadata, "threadId"),
      endpoint.sessionId,
      endpoint.agentId,
    );
  }
  return firstStringValue(
    metadataStringValue(metadata, "externalSessionId"),
    metadataStringValue(metadata, "threadId"),
    metadataStringValue(metadata, "nativeSessionId"),
    metadataStringValue(metadata, "pairingSessionId"),
    metadataStringValue(metadata, "sessionId"),
    endpoint.sessionId,
    metadataStringValue(metadata, "runtimeSessionId"),
    metadataStringValue(metadata, "runtimeInstanceId"),
    metadataStringValue(metadata, "tmuxSession"),
  );
}

function endpointRuntimeSessionExternalId(endpoint: AgentEndpoint): string | null {
  const metadata = runtimeSessionMetadata(endpoint);
  return firstStringValue(
    metadataStringValue(metadata, "externalSessionId"),
    metadataStringValue(metadata, "threadId"),
    metadataStringValue(metadata, "nativeSessionId"),
    metadataStringValue(metadata, "pairingSessionId"),
  );
}

function endpointRuntimeSessionStartedAt(endpoint: AgentEndpoint, fallback: number): number {
  const metadata = runtimeSessionMetadata(endpoint);
  return metadataTimestampValue(metadata, "sessionStartedAt")
    ?? metadataTimestampValue(metadata, "startedAt")
    ?? metadataTimestampValue(metadata, "lastStartedAt")
    ?? fallback;
}

function endpointRuntimeSessionLastSeenAt(endpoint: AgentEndpoint, fallback: number): number {
  const metadata = runtimeSessionMetadata(endpoint);
  return Math.max(
    metadataTimestampValue(metadata, "lastSeenAt") ?? 0,
    metadataTimestampValue(metadata, "lastEnsuredAt") ?? 0,
    metadataTimestampValue(metadata, "lastStartedAt") ?? 0,
    metadataTimestampValue(metadata, "lastCompletedAt") ?? 0,
    metadataTimestampValue(metadata, "lastFailedAt") ?? 0,
    metadataTimestampValue(metadata, "lastResumedAt") ?? 0,
    metadataTimestampValue(metadata, "lastInterruptedAt") ?? 0,
    fallback,
  );
}

function endpointRuntimeSessionIsTerminal(endpoint: AgentEndpoint): boolean {
  return endpoint.state === "offline" || endpoint.metadata?.staleLocalRegistration === true;
}

function endpointRuntimeSessionState(endpoint: AgentEndpoint): string {
  return endpoint.metadata?.staleLocalRegistration === true ? "superseded" : endpoint.state;
}

function endpointRuntimeSessionId(endpoint: AgentEndpoint, primaryAlias: string): string {
  const key = [
    endpoint.nodeId,
    endpoint.agentId,
    endpoint.harness,
    endpoint.transport,
    primaryAlias,
  ].join("\u0000");
  return `sess.${stableHash(key)}`;
}

function endpointRuntimeSessionAliases(endpoint: AgentEndpoint, scoutSessionId: string): RuntimeSessionAliasInput[] {
  const metadata = runtimeSessionMetadata(endpoint);
  const aliases: RuntimeSessionAliasInput[] = [
    { alias: scoutSessionId, aliasKind: "scout" },
    { alias: endpoint.id, aliasKind: "endpoint" },
  ];
  if (endpoint.sessionId?.trim()) {
    aliases.push({ alias: endpoint.sessionId.trim(), aliasKind: "endpoint_session" });
  }
  for (const entry of RUNTIME_SESSION_ALIAS_METADATA_KEYS) {
    const value = metadataStringValue(metadata, entry.key);
    if (value) {
      aliases.push({ alias: value, aliasKind: entry.kind });
    }
  }
  const provisionalHandle = metadataStringValue(metadata, "handle");
  if (provisionalHandle) {
    aliases.push({ alias: provisionalHandle, aliasKind: "provisional" });
  }
  if (endpoint.agentId?.trim()) {
    aliases.push({ alias: endpoint.agentId.trim(), aliasKind: "session_actor" });
  }

  const unique = new Map<string, RuntimeSessionAliasInput>();
  for (const entry of aliases) {
    const alias = entry.alias.trim();
    if (!alias || unique.has(alias)) {
      continue;
    }
    unique.set(alias, { ...entry, alias });
  }
  return [...unique.values()];
}

interface ConversationRow {
  id: string;
  kind: ConversationDefinition["kind"];
  title: string;
  visibility: ConversationDefinition["visibility"];
  share_mode: ConversationDefinition["shareMode"];
  authority_node_id: string;
  topic: string | null;
  parent_conversation_id: string | null;
  message_id: string | null;
  metadata_json: string | null;
}

interface BindingRow {
  id: string;
  conversation_id: string;
  platform: string;
  mode: ConversationBinding["mode"];
  external_channel_id: string;
  external_thread_id: string | null;
  metadata_json: string | null;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  actor_id: string;
  origin_node_id: string;
  class: MessageRecord["class"];
  body: string;
  reply_to_message_id: string | null;
  thread_conversation_id: string | null;
  speech_json: string | null;
  audience_json: string | null;
  visibility: MessageRecord["visibility"];
  policy: MessageRecord["policy"];
  metadata_json: string | null;
  created_at: number;
}

interface MentionRow {
  message_id: string;
  actor_id: string;
  label: string | null;
}

interface AttachmentRow {
  id: string;
  message_id: string;
  media_type: string;
  file_name: string | null;
  blob_key: string | null;
  url: string | null;
  metadata_json: string | null;
}

interface ReadCursorRow {
  conversation_id: string;
  actor_id: string;
  reader_node_id: string | null;
  last_read_message_id: string | null;
  last_read_seq: number | null;
  last_read_at: number;
  updated_at: number;
  metadata_json: string | null;
}

interface InvocationRow {
  id: string;
  requester_id: string;
  requester_node_id: string;
  target_agent_id: string;
  target_node_id: string | null;
  action: InvocationRequest["action"];
  task: string;
  collaboration_record_id: string | null;
  conversation_id: string | null;
  message_id: string | null;
  context_json: string | null;
  execution_json: string | null;
  execution_resolution_json: string | null;
  ensure_awake: number;
  stream: number;
  timeout_ms: number | null;
  labels_json: string | null;
  metadata_json: string | null;
  created_at: number;
  // Flight status columns (Phase 3 flight→invocation storage merge, expand
  // phase). Written by the recordFlight dual-write; reads still come from the
  // flights table for now.
  flight_id: string | null;
  state: FlightRecord["state"] | null;
  summary: string | null;
  output: string | null;
  error: string | null;
  started_at: number | null;
  completed_at: number | null;
  flight_metadata_json: string | null;
}

interface FlightRow {
  id: string;
  invocation_id: string;
  requester_id: string;
  target_agent_id: string;
  state: FlightRecord["state"];
  summary: string | null;
  output: string | null;
  error: string | null;
  labels_json: string | null;
  metadata_json: string | null;
  started_at: number | null;
  completed_at: number | null;
}

interface DurableActionRow {
  id: string;
  kind: DurableAction["kind"];
  subject_id: string;
  authority_cell_id: string;
  state: DurableAction["state"];
  idempotency_key: string | null;
  lease_owner: string | null;
  lease_generation: number;
  lease_expires_at: number | null;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
}

interface DurableAttemptRow {
  id: string;
  action_id: string;
  attempt: number;
  state: DurableAttempt["state"];
  lease_generation: number;
  error: string | null;
  started_at: number | null;
  completed_at: number | null;
  metadata_json: string | null;
}

interface DurableCheckpointRow {
  action_id: string;
  name: string;
  payload_json: string | null;
  owner_attempt_id: string | null;
  created_at: number;
}

interface DurableSignalRow {
  action_id: string;
  name: string;
  payload_json: string | null;
  emitted_at: number;
}

function durableActionFromRow(row: DurableActionRow): DurableAction {
  return {
    id: row.id,
    kind: row.kind,
    subjectId: row.subject_id,
    authorityCellId: row.authority_cell_id,
    state: row.state,
    idempotencyKey: row.idempotency_key ?? undefined,
    leaseOwner: row.lease_owner ?? undefined,
    leaseGeneration: row.lease_generation,
    leaseExpiresAt: row.lease_expires_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: parseJson<Record<string, unknown> | undefined>(row.metadata_json, undefined),
  };
}

function durableAttemptFromRow(row: DurableAttemptRow): DurableAttempt {
  return {
    id: row.id,
    actionId: row.action_id,
    attempt: row.attempt,
    state: row.state,
    leaseGeneration: row.lease_generation,
    error: row.error ?? undefined,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    metadata: parseJson<Record<string, unknown> | undefined>(row.metadata_json, undefined),
  };
}

function durableCheckpointFromRow(row: DurableCheckpointRow): DurableCheckpoint {
  return {
    actionId: row.action_id,
    name: row.name,
    payload: parseJson<unknown>(row.payload_json, undefined),
    ownerAttemptId: row.owner_attempt_id ?? undefined,
    createdAt: row.created_at,
  };
}

function durableSignalFromRow(row: DurableSignalRow): DurableSignal {
  return {
    actionId: row.action_id,
    name: row.name,
    payload: parseJson<unknown>(row.payload_json, undefined),
    emittedAt: row.emitted_at,
  };
}

interface CollaborationRecordRow {
  id: string;
  kind: CollaborationRecord["kind"];
  state: string;
  acceptance_state: string;
  title: string;
  summary: string | null;
  created_by_id: string;
  owner_id: string | null;
  next_move_owner_id: string | null;
  conversation_id: string | null;
  parent_id: string | null;
  priority: string | null;
  labels_json: string | null;
  relations_json: string | null;
  detail_json: string | null;
  created_at: number;
  updated_at: number;
}

interface CollaborationEventRow {
  id: string;
  record_id: string;
  record_kind: string;
  kind: string;
  actor_id: string;
  summary: string | null;
  metadata_json: string | null;
  created_at: number;
}

interface EventRow {
  id: string;
  kind: string;
  actor_id: string;
  node_id: string | null;
  ts: number;
  payload_json: string;
}

interface ThreadEventRow {
  id: string;
  conversation_id: string;
  authority_node_id: string;
  seq: number;
  kind: ThreadEventKind;
  actor_id: string | null;
  ts: number;
  payload_json: string;
  notification_json: string | null;
}

interface ThreadCursorRow {
  conversation_id: string;
  authority_node_id: string;
  last_applied_seq: number;
  updated_at: number;
}

type ThreadEventInsert = {
  id: string;
  conversation: ConversationDefinition;
  kind: ThreadEventKind;
  actorId?: string;
  ts: number;
  payload: ThreadEventEnvelope["payload"];
  notification?: ThreadEventNotification;
};

export type ActivityItemKind =
  | "message_posted"
  | "agent_message"
  | "status_message"
  | "ask_opened"
  | "ask_working"
  | "ask_replied"
  | "ask_failed"
  | "handoff_sent"
  | "invocation_recorded"
  | "flight_updated"
  | "collaboration_event";

export type ActivityItem = {
  id: string;
  kind: ActivityItemKind;
  ts: number;
  conversationId?: string;
  messageId?: string;
  invocationId?: string;
  flightId?: string;
  recordId?: string;
  actorId?: string;
  counterpartId?: string;
  agentId?: string;
  workspaceRoot?: string;
  sessionId?: string;
  title?: string;
  summary?: string;
  payload?: Record<string, unknown>;
};

interface ActivityItemRow {
  id: string;
  kind: ActivityItemKind;
  ts: number;
  conversation_id: string | null;
  message_id: string | null;
  invocation_id: string | null;
  flight_id: string | null;
  record_id: string | null;
  actor_id: string | null;
  counterpart_id: string | null;
  agent_id: string | null;
  workspace_root: string | null;
  session_id: string | null;
  title: string | null;
  summary: string | null;
  payload_json: string | null;
}

function buildCollaborationRecord(row: CollaborationRecordRow): CollaborationRecord {
  const detail = parseJson<Record<string, unknown>>(row.detail_json, {});
  const base = {
    id: row.id,
    kind: row.kind,
    title: row.title,
    summary: row.summary ?? undefined,
    createdById: row.created_by_id,
    ownerId: row.owner_id ?? undefined,
    nextMoveOwnerId: row.next_move_owner_id ?? undefined,
    conversationId: row.conversation_id ?? undefined,
    parentId: row.parent_id ?? undefined,
    priority: (row.priority ?? undefined) as CollaborationPriority | undefined,
    labels: parseJson<string[] | undefined>(row.labels_json, undefined),
    relations: parseJson<CollaborationRelation[] | undefined>(row.relations_json, undefined),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: (detail as { metadata?: Record<string, unknown> }).metadata,
  };

  const acceptanceState = row.acceptance_state as CollaborationRecord["acceptanceState"];

  // Reconstruct the correct record kind — hardcoding "work_item" here would silently
  // rewrite persisted questions as work items on read (data corruption).
  if (row.kind === "question") {
    return {
      ...base,
      kind: "question",
      state: row.state as QuestionState,
      acceptanceState,
      askedById: detail.askedById as string | undefined,
      answeredById: detail.answeredById as string | undefined,
      answer: detail.answer as string | undefined,
      answeredAt: detail.answeredAt as number | undefined,
      closedAt: detail.closedAt as number | undefined,
    };
  }

  return {
    ...base,
    kind: "work_item",
    state: row.state as WorkItemState,
    acceptanceState,
    requestedById: detail.requestedById as string | undefined,
    waitingOn: detail.waitingOn as CollaborationWaitingOn | undefined,
    progress: detail.progress as CollaborationProgress | undefined,
    startedAt: detail.startedAt as number | undefined,
    reviewRequestedAt: detail.reviewRequestedAt as number | undefined,
    completedAt: detail.completedAt as number | undefined,
  };
}

export class SQLiteControlPlaneStore {
  private readonly db: ControlPlaneSqliteDatabase;
  private readonly readDb: ControlPlaneSqliteDatabase;
  private readonly drizzleDb: ReturnType<typeof openControlPlaneDrizzle>;
  private readonly drizzleReadDb: ReturnType<typeof openControlPlaneDrizzle>;
  private readonly persistEventsBatch: (events: ControlEvent[]) => void;
  private pendingEvents: ControlEvent[] = [];
  private flushPendingEventsTimer: ReturnType<typeof setTimeout> | null = null;
  private conversationsApi: ConversationsApi | null = null;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = openControlPlaneSqliteDatabase(dbPath, { create: true });
    configureControlPlaneDatabase(this.db);
    migrateControlPlaneDatabaseSchema(this.db);
    this.readDb = openControlPlaneSqliteDatabase(dbPath, { readonly: true });
    this.readDb.exec("PRAGMA busy_timeout = 5000;");
    this.readDb.exec("PRAGMA query_only = ON;");
    this.drizzleDb = openControlPlaneDrizzle(this.db);
    this.drizzleReadDb = openControlPlaneDrizzle(this.readDb);
    this.persistEventsBatch = (this.db as SQLiteTransactionalDatabase).transaction((events: ControlEvent[]) => {
      const statement = this.db.query(
        `INSERT OR REPLACE INTO events (id, kind, actor_id, node_id, ts, payload_json)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      );

      for (const event of events) {
        statement.run(
          event.id,
          event.kind,
          event.actorId,
          event.nodeId ?? null,
          event.ts,
          JSON.stringify(event.payload),
        );
      }
    });
  }

  listRuntimeSessions(options: {
    agentId?: string;
    endpointId?: string;
    sessionId?: string;
    includeExpired?: boolean;
    now?: number;
    limit?: number;
  } = {}): RuntimeSessionIndexRecord[] {
    const predicates: string[] = [];
    const params: SQLiteBinding[] = [];
    if (options.agentId) {
      predicates.push("agent_id = ?");
      params.push(options.agentId);
    }
    if (options.endpointId) {
      predicates.push("endpoint_id = ?");
      params.push(options.endpointId);
    }
    if (options.sessionId) {
      predicates.push("id = ?");
      params.push(options.sessionId);
    }
    if (!options.includeExpired) {
      predicates.push("(expires_at IS NULL OR expires_at > ?)");
      params.push(options.now ?? currentTimestampMs());
    }
    const limit = normalizedListLimit(options.limit, 100, 1000);
    params.push(limit);
    const where = predicates.length ? `WHERE ${predicates.join(" AND ")}` : "";
    return queryAllDynamic<RuntimeSessionRow>(
      this.readDb,
      `SELECT *
       FROM runtime_sessions
       ${where}
       ORDER BY last_seen_at DESC, updated_at DESC, id ASC
       LIMIT ?`,
      params,
    ).map(runtimeSessionFromRow);
  }

  listRuntimeSessionAliases(options: {
    alias?: string;
    sessionId?: string;
    includeExpired?: boolean;
    now?: number;
    limit?: number;
  } = {}): RuntimeSessionAliasRecord[] {
    const predicates: string[] = [];
    const params: SQLiteBinding[] = [];
    if (options.alias) {
      predicates.push("alias = ?");
      params.push(options.alias);
    }
    if (options.sessionId) {
      predicates.push("session_id = ?");
      params.push(options.sessionId);
    }
    if (!options.includeExpired) {
      predicates.push("(expires_at IS NULL OR expires_at > ?)");
      params.push(options.now ?? currentTimestampMs());
    }
    const limit = normalizedListLimit(options.limit, 100, 1000);
    params.push(limit);
    const where = predicates.length ? `WHERE ${predicates.join(" AND ")}` : "";
    return queryAllDynamic<RuntimeSessionAliasRow>(
      this.readDb,
      `SELECT *
       FROM runtime_session_aliases
       ${where}
       ORDER BY last_seen_at DESC, alias ASC, session_id ASC
       LIMIT ?`,
      params,
    ).map(runtimeSessionAliasFromRow);
  }

  resolveRuntimeSessionAlias(alias: string, options: {
    includeExpired?: boolean;
    now?: number;
    limit?: number;
  } = {}): RuntimeSessionIndexRecord[] {
    const trimmedAlias = alias.trim();
    if (!trimmedAlias) {
      return [];
    }
    const predicates = ["a.alias = ?"];
    const params: SQLiteBinding[] = [trimmedAlias];
    if (!options.includeExpired) {
      const now = options.now ?? currentTimestampMs();
      predicates.push("(a.expires_at IS NULL OR a.expires_at > ?)");
      params.push(now);
      predicates.push("(s.expires_at IS NULL OR s.expires_at > ?)");
      params.push(now);
    }
    const limit = normalizedListLimit(options.limit, 20, 100);
    params.push(limit);
    return queryAllDynamic<RuntimeSessionRow>(
      this.readDb,
      `SELECT s.*
       FROM runtime_session_aliases a
       JOIN runtime_sessions s ON s.id = a.session_id
       WHERE ${predicates.join(" AND ")}
       ORDER BY a.last_seen_at DESC, s.updated_at DESC, s.id ASC
       LIMIT ?`,
      params,
    ).map(runtimeSessionFromRow);
  }

  // Terminal session registry.
  // A stable harness session (identity) owning N disposable terminal surfaces
  // (tmux/zellij/future). Re-intaking the same harness session updates one
  // record. Surface merge/append policy is the caller's concern (intake);
  // this store persists the record faithfully.

  upsertTerminalSession(input: TerminalSessionRecordInput): TerminalSessionRecord {
    const id = input.id?.trim() || terminalSessionRegistryId(input.harness, input.sourceSessionId);
    const now = currentTimestampMs();
    const surfacesJson = JSON.stringify(input.surfaces ?? []);
    const metadataJson = stringify(input.metadata);
    this.db.query(
      `INSERT INTO terminal_session_registry (
         id, harness, source_session_id, cwd, resume_command, surfaces_json, metadata_json, created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
       ON CONFLICT(id) DO UPDATE SET
         harness = excluded.harness,
         source_session_id = excluded.source_session_id,
         cwd = excluded.cwd,
         resume_command = excluded.resume_command,
         surfaces_json = excluded.surfaces_json,
         metadata_json = excluded.metadata_json,
         updated_at = excluded.updated_at`,
    ).run(id, input.harness, input.sourceSessionId, input.cwd, input.resumeCommand, surfacesJson, metadataJson, now, now);
    const record = this.getTerminalSession(id);
    if (!record) {
      throw new Error(`failed to persist terminal session registry record ${id}`);
    }
    return record;
  }

  getTerminalSession(id: string): TerminalSessionRecord | null {
    const row = queryGet<TerminalSessionRow, [string]>(
      this.readDb,
      "SELECT * FROM terminal_session_registry WHERE id = ?1",
      id,
    );
    return row ? terminalSessionFromRow(row) : null;
  }

  listTerminalSessions(options: {
    harness?: string;
    sourceSessionId?: string;
    backend?: TerminalSurface["backend"];
    limit?: number;
  } = {}): TerminalSessionRecord[] {
    const predicates: string[] = [];
    const params: SQLiteBinding[] = [];
    if (options.harness) {
      predicates.push("harness = ?");
      params.push(options.harness);
    }
    if (options.sourceSessionId) {
      predicates.push("source_session_id = ?");
      params.push(options.sourceSessionId);
    }
    const limit = normalizedListLimit(options.limit, 100, 1000);
    params.push(limit);
    const where = predicates.length ? `WHERE ${predicates.join(" AND ")}` : "";
    const records = queryAllDynamic<TerminalSessionRow>(
      this.readDb,
      `SELECT *
       FROM terminal_session_registry
       ${where}
       ORDER BY updated_at DESC, id ASC
       LIMIT ?`,
      params,
    ).map(terminalSessionFromRow);
    if (!options.backend) {
      return records;
    }
    return records.filter((record) =>
      record.surfaces.some((surface) => surface.backend === options.backend),
    );
  }

  // Durable terminal workspaces.
  // A named arrangement of agent-CLI tiles. Cells carry the intent needed to
  // re-materialize them, so a workspace can be rebuilt after a reboot rather
  // than reopening onto a grid of dead session names.

  upsertTerminalWorkspace(input: TerminalWorkspaceRecordInput): TerminalWorkspaceRecord {
    const id = input.id?.trim() || `tw.${stableHash(`${input.name}${currentTimestampMs()}`)}`;
    const now = currentTimestampMs();
    this.db.query(
      `INSERT INTO terminal_workspaces (
         id, name, purpose, columns_count, layout_json, cells_json, metadata_json, created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         purpose = excluded.purpose,
         columns_count = excluded.columns_count,
         layout_json = excluded.layout_json,
         cells_json = excluded.cells_json,
         metadata_json = excluded.metadata_json,
         updated_at = excluded.updated_at`,
    ).run(
      id,
      input.name,
      input.purpose ?? "",
      normalizeTerminalWorkspaceColumns(input.columns),
      // The authored shape, which the resolved column count cannot stand in
      // for: "dynamic" comes back pinned to a number, and a lanes workspace
      // wider than the column clamp comes back a grid.
      input.layout === undefined ? null : JSON.stringify(input.layout),
      JSON.stringify(input.cells ?? []),
      stringify(input.metadata),
      now,
      now,
    );
    const record = this.getTerminalWorkspace(id);
    if (!record) {
      throw new Error(`failed to persist terminal workspace ${id}`);
    }
    return record;
  }

  getTerminalWorkspace(id: string): TerminalWorkspaceRecord | null {
    const row = queryGet<TerminalWorkspaceRow, [string]>(
      this.readDb,
      "SELECT * FROM terminal_workspaces WHERE id = ?1",
      id,
    );
    return row ? terminalWorkspaceFromRow(row) : null;
  }

  listTerminalWorkspaces(options: { limit?: number } = {}): TerminalWorkspaceRecord[] {
    const limit = normalizedListLimit(options.limit, 100, 1000);
    return queryAllDynamic<TerminalWorkspaceRow>(
      this.readDb,
      `SELECT *
       FROM terminal_workspaces
       ORDER BY updated_at DESC, id ASC
       LIMIT ?`,
      [limit],
    ).map(terminalWorkspaceFromRow);
  }

  deleteTerminalWorkspace(id: string): boolean {
    const result = this.db.query("DELETE FROM terminal_workspaces WHERE id = ?1").run(id) as {
      changes?: number;
    };
    return (result.changes ?? 0) > 0;
  }

  pruneExpiredRuntimeSessions(now = currentTimestampMs()): { aliasesDeleted: number; sessionsDeleted: number } {
    const aliasesResult = this.db.query(
      "DELETE FROM runtime_session_aliases WHERE expires_at IS NOT NULL AND expires_at <= ?1",
    ).run(now) as { changes?: number };
    const sessionsResult = this.db.query(
      "DELETE FROM runtime_sessions WHERE expires_at IS NOT NULL AND expires_at <= ?1",
    ).run(now) as { changes?: number };
    return {
      aliasesDeleted: aliasesResult.changes ?? 0,
      sessionsDeleted: sessionsResult.changes ?? 0,
    };
  }

  /**
   * Prunes old, disconnected node rows without inferring identity from a
   * hostname. Numeric labels such as `pi-4.local` and `pi-5.local` are valid,
   * distinct machine names; merging either one requires durable evidence that
   * both node IDs were authenticated by the same identity key. The current
   * schema does not retain that alias history, so this sweep deliberately
   * leaves every referenced or trusted node ID intact.
   */
  compactAndPruneMeshNodes(options: {
    localNodeId?: string;
    now?: number;
    maxStaleAgeMs?: number;
  } = {}): {
    rehomedNodeCount: number;
    prunedNodeCount: number;
    rehomedMappings: Array<{ from: string; to: string }>;
  } {
    const now = options.now ?? currentTimestampMs();
    const maxStaleAgeMs = options.maxStaleAgeMs ?? 7 * 24 * 60 * 60 * 1000;
    const staleCutoff = now - maxStaleAgeMs;

    const peerRows = this.db.query("SELECT * FROM trusted_peers").all() as TrustedPeerRow[];

    const rehomedMappings: Array<{ from: string; to: string }> = [];
    const rehomedNodeCount = 0;
    let prunedNodeCount = 0;

    (this.db as SQLiteTransactionalDatabase).transaction(() => {
      // Prune disconnected stale nodes. Foreign keys fail closed if any
      // durable record still refers to the node.
      const remainingNodes = this.db.query("SELECT * FROM nodes").all() as NodeRow[];
      for (const row of remainingNodes) {
        if (row.id === options.localNodeId) continue;
        const lastActive = row.last_seen_at ?? row.registered_at;
        if (lastActive > staleCutoff) continue;
        const isTrusted = peerRows.some((p) => p.node_id === row.id);
        if (isTrusted) continue;

        try {
          const delRes = this.db.query("DELETE FROM nodes WHERE id = ?1").run(row.id) as { changes?: number };
          if ((delRes.changes ?? 0) > 0) {
            prunedNodeCount++;
          }
        } catch {
          // Foreign key constraint failure means it has active references; leave it safe
        }
      }
    })();

    return {
      rehomedNodeCount,
      prunedNodeCount,
      rehomedMappings,
    };
  }

  close(): void {
    this.flushPendingEvents();
    if (this.flushPendingEventsTimer) {
      clearTimeout(this.flushPendingEventsTimer);
      this.flushPendingEventsTimer = null;
    }
    this.readDb.close?.();
    this.db.close?.();
  }

  private flushPendingEvents(): void {
    if (this.pendingEvents.length === 0) {
      return;
    }

    const nextBatch = this.pendingEvents;
    this.pendingEvents = [];
    this.persistEventsBatch(nextBatch);
  }

  private schedulePendingEventFlush(): void {
    if (this.flushPendingEventsTimer) {
      return;
    }

    this.flushPendingEventsTimer = setTimeout(() => {
      this.flushPendingEventsTimer = null;
      this.flushPendingEvents();
    }, 0);
    this.flushPendingEventsTimer.unref?.();
  }

  loadSnapshot(): RuntimeRegistrySnapshot {
    const snapshot = createRuntimeRegistrySnapshot();

    const nodes = queryAll<NodeRow>(this.readDb, "SELECT * FROM nodes");
    for (const row of nodes) {
      snapshot.nodes[row.id] = {
        id: row.id,
        meshId: row.mesh_id,
        name: row.name,
        hostName: row.host_name ?? undefined,
        advertiseScope: row.advertise_scope,
        brokerUrl: row.broker_url ?? undefined,
        tailnetName: row.tailnet_name ?? undefined,
        capabilities: parseJson<string[]>(row.capabilities_json, []),
        labels: parseJson<string[]>(row.labels_json, []),
        metadata: parseJson<Record<string, unknown> | undefined>(row.metadata_json, undefined),
        lastSeenAt: row.last_seen_at ?? undefined,
        registeredAt: row.registered_at,
      };
    }

    const actors = queryAll<ActorRow>(this.readDb, "SELECT * FROM actors");
    for (const row of actors) {
      snapshot.actors[row.id] = {
        id: row.id,
        kind: row.kind,
        displayName: row.display_name,
        handle: row.handle ?? undefined,
        labels: parseJson<string[] | undefined>(row.labels_json, undefined),
        metadata: parseJson<Record<string, unknown> | undefined>(row.metadata_json, undefined),
      };
    }

    const agents = queryAll<AgentRow>(this.readDb, "SELECT * FROM agents");
    for (const row of agents) {
      const actor = snapshot.actors[row.id];
      if (!actor) continue;

      snapshot.agents[row.id] = {
        ...actor,
        kind: "agent",
        definitionId: row.definition_id,
        nodeQualifier: row.node_qualifier ?? undefined,
        workspaceQualifier: row.workspace_qualifier ?? undefined,
        selector: row.selector ?? undefined,
        defaultSelector: row.default_selector ?? undefined,
        agentClass: row.agent_class,
        capabilities: parseJson<AgentDefinition["capabilities"]>(row.capabilities_json, []),
        wakePolicy: row.wake_policy,
        homeNodeId: row.home_node_id,
        authorityNodeId: row.authority_node_id,
        advertiseScope: row.advertise_scope,
        ownerId: row.owner_id ?? undefined,
        metadata: parseJson<Record<string, unknown> | undefined>(row.metadata_json, actor.metadata),
      };
    }

    const endpoints = queryAll<EndpointRow>(this.readDb, "SELECT * FROM agent_endpoints");
    for (const row of endpoints) {
      snapshot.endpoints[row.id] = {
        id: row.id,
        agentId: row.agent_id,
        nodeId: row.node_id,
        harness: row.harness,
        transport: row.transport,
        state: row.state,
        address: row.address ?? undefined,
        sessionId: row.session_id ?? undefined,
        pane: row.pane ?? undefined,
        cwd: row.cwd ?? undefined,
        projectRoot: row.project_root ?? undefined,
        metadata: parseJson<Record<string, unknown> | undefined>(row.metadata_json, undefined),
      };
    }

    const conversations = queryAll<ConversationRow>(this.readDb, "SELECT * FROM conversations");
    const members = queryAll<{ conversation_id: string; actor_id: string }>(
      this.readDb,
      "SELECT conversation_id, actor_id FROM conversation_members",
    );
    const memberMap = new Map<string, string[]>();
    for (const row of members) {
      const list = memberMap.get(row.conversation_id) ?? [];
      list.push(row.actor_id);
      memberMap.set(row.conversation_id, list);
    }
    for (const row of conversations) {
      snapshot.conversations[row.id] = {
        id: row.id,
        kind: row.kind,
        title: row.title,
        visibility: row.visibility,
        shareMode: row.share_mode,
        authorityNodeId: row.authority_node_id,
        participantIds: memberMap.get(row.id) ?? [],
        topic: row.topic ?? undefined,
        parentConversationId: row.parent_conversation_id ?? undefined,
        messageId: row.message_id ?? undefined,
        metadata: parseJson<Record<string, unknown> | undefined>(row.metadata_json, undefined),
      };
    }

    const bindings = queryAll<BindingRow>(this.readDb, "SELECT * FROM bindings");
    for (const row of bindings) {
      snapshot.bindings[row.id] = {
        id: row.id,
        conversationId: row.conversation_id,
        platform: row.platform,
        mode: row.mode,
        externalChannelId: row.external_channel_id,
        externalThreadId: row.external_thread_id ?? undefined,
        metadata: parseJson<Record<string, unknown> | undefined>(row.metadata_json, undefined),
      };
    }

    const messages = queryAll<MessageRow>(this.readDb, "SELECT * FROM messages");
    const mentionRows = queryAll<MentionRow>(this.readDb, "SELECT * FROM message_mentions");
    const attachmentRows = queryAll<AttachmentRow>(this.readDb, "SELECT * FROM message_attachments");
    const mentionsByMessage = new Map<string, MessageMention[]>();
    const attachmentsByMessage = new Map<string, MessageAttachment[]>();

    for (const row of mentionRows) {
      const list = mentionsByMessage.get(row.message_id) ?? [];
      list.push({ actorId: row.actor_id, label: row.label ?? undefined });
      mentionsByMessage.set(row.message_id, list);
    }
    for (const row of attachmentRows) {
      const list = attachmentsByMessage.get(row.message_id) ?? [];
      list.push({
        id: row.id,
        mediaType: row.media_type,
        fileName: row.file_name ?? undefined,
        blobKey: row.blob_key ?? undefined,
        url: row.url ?? undefined,
        metadata: parseJson<Record<string, unknown> | undefined>(row.metadata_json, undefined),
      });
      attachmentsByMessage.set(row.message_id, list);
    }

    for (const row of messages) {
      snapshot.messages[row.id] = {
        id: row.id,
        conversationId: row.conversation_id,
        actorId: row.actor_id,
        originNodeId: row.origin_node_id,
        class: row.class,
        body: row.body,
        replyToMessageId: row.reply_to_message_id ?? undefined,
        threadConversationId: row.thread_conversation_id ?? undefined,
        mentions: mentionsByMessage.get(row.id),
        attachments: attachmentsByMessage.get(row.id),
        speech: parseJson<MessageRecord["speech"]>(row.speech_json, undefined),
        audience: parseJson<MessageRecord["audience"]>(row.audience_json, undefined),
        visibility: row.visibility,
        policy: row.policy,
        createdAt: row.created_at,
        metadata: parseJson<Record<string, unknown> | undefined>(row.metadata_json, undefined),
      };
    }

    const readCursorRows = queryAll<ReadCursorRow>(this.readDb, "SELECT * FROM conversation_read_cursors");
    for (const row of readCursorRows) {
      const cursor: ConversationReadCursor = {
        conversationId: row.conversation_id,
        actorId: row.actor_id,
        readerNodeId: row.reader_node_id ?? undefined,
        lastReadMessageId: row.last_read_message_id ?? undefined,
        lastReadSeq: row.last_read_seq ?? undefined,
        lastReadAt: row.last_read_at,
        updatedAt: row.updated_at,
        metadata: parseJson<Record<string, unknown> | undefined>(row.metadata_json, undefined),
      };
      snapshot.readCursors[`${cursor.conversationId}\u0000${cursor.actorId}`] = cursor;
    }

    const invocations = queryAll<InvocationRow>(this.readDb, "SELECT * FROM invocations");
    for (const row of invocations) {
      snapshot.invocations[row.id] = {
        id: row.id,
        requesterId: row.requester_id,
        requesterNodeId: row.requester_node_id,
        targetAgentId: row.target_agent_id,
        targetNodeId: row.target_node_id ?? undefined,
        action: row.action,
        task: row.task,
        collaborationRecordId: row.collaboration_record_id ?? undefined,
        conversationId: row.conversation_id ?? undefined,
        messageId: row.message_id ?? undefined,
        context: parseJson<Record<string, unknown> | undefined>(row.context_json, undefined),
        execution: parseJson<InvocationRequest["execution"]>(row.execution_json, undefined),
        executionResolution: parseJson<InvocationRequest["executionResolution"]>(
          row.execution_resolution_json,
          undefined,
        ),
        ensureAwake: row.ensure_awake === 1,
        stream: row.stream === 1,
        timeoutMs: row.timeout_ms ?? undefined,
        labels: parseJson<string[] | undefined>(row.labels_json, undefined),
        metadata: parseJson<Record<string, unknown> | undefined>(row.metadata_json, undefined),
        createdAt: row.created_at,
      };
    }

    const flights = queryAll<FlightRow>(this.readDb, "SELECT * FROM flights");
    for (const row of flights) {
      snapshot.flights[row.id] = {
        id: row.id,
        invocationId: row.invocation_id,
        requesterId: row.requester_id,
        targetAgentId: row.target_agent_id,
        state: row.state,
        summary: row.summary ?? undefined,
        output: row.output ?? undefined,
        error: row.error ?? undefined,
        labels: parseJson<string[] | undefined>(row.labels_json, undefined),
        metadata: parseJson<Record<string, unknown> | undefined>(row.metadata_json, undefined),
        startedAt: row.started_at ?? undefined,
        completedAt: row.completed_at ?? undefined,
      };
    }

    const collaborationRows = queryAll<CollaborationRecordRow>(
      this.readDb,
      "SELECT * FROM collaboration_records",
    );
    for (const row of collaborationRows) {
      snapshot.collaborationRecords[row.id] = buildCollaborationRecord(row);
    }

    return snapshot;
  }

  recentEvents(limit = 100): ControlEvent[] {
    this.flushPendingEvents();
    const rows = queryAll<EventRow, [number]>(
      this.readDb,
      "SELECT * FROM events ORDER BY ts DESC LIMIT ?1",
      limit,
    ).reverse();

    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      actorId: row.actor_id,
      nodeId: row.node_id ?? undefined,
      ts: row.ts,
      payload: parseJson<Record<string, unknown>>(row.payload_json, {}),
    })) as ControlEvent[];
  }

  latestThreadSeq(conversationId: string): number {
    const row = queryGet<{ max_seq: number | null }, [string]>(
      this.readDb,
      "SELECT MAX(seq) AS max_seq FROM thread_events WHERE conversation_id = ?1",
      conversationId,
    );
    return row?.max_seq ?? 0;
  }

  oldestThreadSeq(conversationId: string): number {
    const row = queryGet<{ seq: number }, [string]>(
      this.readDb,
      "SELECT seq FROM thread_events WHERE conversation_id = ?1 ORDER BY seq ASC LIMIT 1",
      conversationId,
    );
    return row?.seq ?? 0;
  }

  listThreadEvents(options: {
    conversationId: string;
    afterSeq?: number;
    limit?: number;
  }): ThreadEventEnvelope[] {
    const rows = queryAll<ThreadEventRow, [string, number, number]>(
      this.readDb,
      `SELECT *
      FROM thread_events
      WHERE conversation_id = ?1 AND seq > ?2
      ORDER BY seq ASC
      LIMIT ?3`,
      options.conversationId,
      options.afterSeq ?? 0,
      options.limit ?? 500,
    );

    return rows.map((row) => this.buildThreadEvent(row));
  }

  getThreadSnapshot(conversationId: string): ThreadSnapshot | null {
    const conversation = this.getConversation(conversationId);
    if (!conversation) {
      return null;
    }

    return {
      conversation,
      latestSeq: this.latestThreadSeq(conversationId),
      messages: this.listConversationThreadMessages(conversation),
      collaboration: this.listConversationThreadCollaboration(conversation),
      activeFlights: this.listConversationThreadFlights(conversation),
    };
  }

  upsertThreadCursor(
    conversationId: string,
    authorityNodeId: string,
    lastAppliedSeq: number,
    updatedAt: number,
  ): void {
    this.db.query(
      `INSERT INTO thread_cursors (
        conversation_id, authority_node_id, last_applied_seq, updated_at
      ) VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT(conversation_id, authority_node_id) DO UPDATE SET
        last_applied_seq = excluded.last_applied_seq,
        updated_at = excluded.updated_at`,
    ).run(
      conversationId,
      authorityNodeId,
      lastAppliedSeq,
      updatedAt,
    );
  }

  getThreadCursor(conversationId: string, authorityNodeId: string): {
    conversationId: string;
    authorityNodeId: string;
    lastAppliedSeq: number;
    updatedAt: number;
  } | null {
    const row = queryGet<ThreadCursorRow, [string, string]>(
      this.readDb,
      `SELECT *
      FROM thread_cursors
      WHERE conversation_id = ?1 AND authority_node_id = ?2
      LIMIT 1`,
      conversationId,
      authorityNodeId,
    );

    if (!row) {
      return null;
    }

    return {
      conversationId: row.conversation_id,
      authorityNodeId: row.authority_node_id,
      lastAppliedSeq: row.last_applied_seq,
      updatedAt: row.updated_at,
    };
  }

  upsertNode(node: NodeDefinition): void {
    this.db.query(
      `INSERT INTO nodes (
        id, mesh_id, name, host_name, advertise_scope, broker_url, tailnet_name,
        capabilities_json, labels_json, metadata_json, last_seen_at, registered_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
      ON CONFLICT(id) DO UPDATE SET
        mesh_id = excluded.mesh_id,
        name = excluded.name,
        host_name = excluded.host_name,
        advertise_scope = excluded.advertise_scope,
        broker_url = excluded.broker_url,
        tailnet_name = excluded.tailnet_name,
        capabilities_json = excluded.capabilities_json,
        labels_json = excluded.labels_json,
        metadata_json = excluded.metadata_json,
        last_seen_at = excluded.last_seen_at,
        registered_at = excluded.registered_at`,
    ).run(
      node.id,
      node.meshId,
      node.name,
      node.hostName ?? null,
      node.advertiseScope,
      node.brokerUrl ?? null,
      node.tailnetName ?? null,
      stringify(node.capabilities),
      stringify(node.labels),
      stringify(node.metadata),
      node.lastSeenAt ?? null,
      node.registeredAt,
    );
  }

  upsertTrustedPeer(peer: TrustedPeerRecord): void {
    this.db.query(
      `INSERT INTO trusted_peers (
        key_id, public_key, fingerprint, node_id, label, tier, granted_via,
        granted_at, expires_at, revoked_at, last_seen_at, metadata_json,
        tls_spki_fingerprint
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
      ON CONFLICT(key_id) DO UPDATE SET
        public_key = excluded.public_key,
        fingerprint = excluded.fingerprint,
        node_id = excluded.node_id,
        label = excluded.label,
        tier = excluded.tier,
        granted_via = excluded.granted_via,
        granted_at = excluded.granted_at,
        expires_at = excluded.expires_at,
        revoked_at = excluded.revoked_at,
        last_seen_at = excluded.last_seen_at,
        metadata_json = excluded.metadata_json,
        -- §11.2 pin lifecycle: a tls-absent card/record NEVER clears or
        -- overwrites an existing pin — not on refresh, not on re-enrollment.
        tls_spki_fingerprint = COALESCE(excluded.tls_spki_fingerprint, trusted_peers.tls_spki_fingerprint)`,
    ).run(
      peer.keyId,
      peer.publicKey,
      peer.fingerprint,
      peer.nodeId ?? null,
      peer.label,
      peer.tier,
      peer.grantedVia,
      peer.grantedAt,
      peer.expiresAt ?? null,
      peer.revokedAt ?? null,
      peer.lastSeenAt ?? null,
      stringify(peer.metadata),
      peer.tlsSpkiFingerprint ?? null,
    );
  }

  /**
   * The peer's durable §11.2 TLS pin, when one has been stored. Reads the row
   * directly (no revocation/expiry filter — trust state is a separate check).
   */
  getTlsSpkiFingerprint(keyId: string): string | undefined {
    const row = queryGet<{ tls_spki_fingerprint: string | null }, [string]>(
      this.readDb,
      `SELECT tls_spki_fingerprint
      FROM trusted_peers
      WHERE key_id = ?1
      LIMIT 1`,
      keyId,
    );
    return row?.tls_spki_fingerprint ?? undefined;
  }

  /**
   * Store a peer's §11.2 TLS pin from a verified, well-formed card. The
   * never-clear rule is enforced here too (defense in depth): the pin can
   * only be written or replaced by another well-formed pin, never cleared.
   */
  setTlsSpkiFingerprint(keyId: string, spkiFingerprint: string): boolean {
    if (!/^[0-9a-f]{64}$/.test(spkiFingerprint)) {
      throw new Error("tls pin must be exactly 64 lowercase hex chars (SHA-256 of the certificate's SPKI DER)");
    }
    const result = this.db.query(
      `UPDATE trusted_peers
      SET tls_spki_fingerprint = ?2
      WHERE key_id = ?1`,
    ).run(keyId, spkiFingerprint) as { changes?: number };
    return (result.changes ?? 0) > 0;
  }

  trustedPeer(keyId: string): TrustedPeerRecord | undefined {
    const row = queryGet<TrustedPeerRow, [string, number]>(
      this.readDb,
      `SELECT *
      FROM trusted_peers
      WHERE key_id = ?1
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > ?2)
      LIMIT 1`,
      keyId,
      currentTimestampMs(),
    );
    return row ? trustedPeerFromRow(row) : undefined;
  }

  listTrustedPeers(): TrustedPeerRecord[] {
    const rows = queryAll<TrustedPeerRow, [number]>(
      this.readDb,
      `SELECT *
      FROM trusted_peers
      WHERE revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > ?1)
      ORDER BY label ASC`,
      currentTimestampMs(),
    );
    return rows.map(trustedPeerFromRow);
  }

  revokeTrustedPeer(keyId: string, at: number): boolean {
    const result = this.db.query(
      `UPDATE trusted_peers
      SET revoked_at = ?2
      WHERE key_id = ?1 AND revoked_at IS NULL`,
    ).run(keyId, at) as { changes?: number };
    return (result.changes ?? 0) > 0;
  }

  touchTrustedPeerLastSeen(keyId: string, at: number): void {
    this.db.query(
      `UPDATE trusted_peers
      SET last_seen_at = ?2
      WHERE key_id = ?1`,
    ).run(keyId, at);
  }

  // Durable replay protection (mesh-trust-cone §6): insert-before-execute.
  // The (peer_key_id, nonce) PK is the claim; a conflict means the nonce was
  // already seen. The expiry sweep rides the same transaction so a claimed
  // nonce can never race its own cleanup.
  claimPeerNonce(keyId: string, nonce: string, now: number, maxAgeMs: number): boolean {
    const claim = (this.db as SQLiteTransactionalDatabase).transaction(
      (): boolean => {
        this.db.query(
          `DELETE FROM peer_nonces
          WHERE peer_key_id = ?1 AND seen_at < ?2`,
        ).run(keyId, now - maxAgeMs);
        const result = this.db.query(
          `INSERT OR IGNORE INTO peer_nonces (peer_key_id, nonce, seen_at)
          VALUES (?1, ?2, ?3)`,
        ).run(keyId, nonce, now) as { changes?: number };
        return (result.changes ?? 0) > 0;
      },
    );
    return claim();
  }

  upsertActor(actor: ActorIdentity): void {
    this.db.query(
      `INSERT INTO actors (
        id, kind, display_name, handle, labels_json, metadata_json, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        display_name = excluded.display_name,
        handle = excluded.handle,
        labels_json = excluded.labels_json,
        metadata_json = excluded.metadata_json`,
    ).run(
      actor.id,
      actor.kind,
      actor.displayName,
      actor.handle ?? null,
      stringify(actor.labels),
      stringify(actor.metadata),
      currentTimestampMs(),
    );
  }

  upsertAgent(agent: AgentDefinition): void {
    this.db.query(
      `INSERT INTO agents (
        id, definition_id, node_qualifier, workspace_qualifier, selector, default_selector,
        agent_class, capabilities_json, wake_policy, home_node_id, authority_node_id,
        advertise_scope, owner_id, metadata_json
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
      ON CONFLICT(id) DO UPDATE SET
        definition_id = excluded.definition_id,
        node_qualifier = excluded.node_qualifier,
        workspace_qualifier = excluded.workspace_qualifier,
        selector = excluded.selector,
        default_selector = excluded.default_selector,
        agent_class = excluded.agent_class,
        capabilities_json = excluded.capabilities_json,
        wake_policy = excluded.wake_policy,
        home_node_id = excluded.home_node_id,
        authority_node_id = excluded.authority_node_id,
        advertise_scope = excluded.advertise_scope,
        owner_id = excluded.owner_id,
        metadata_json = excluded.metadata_json`,
    ).run(
      agent.id,
      agent.definitionId,
      agent.nodeQualifier ?? null,
      agent.workspaceQualifier ?? null,
      agent.selector ?? null,
      agent.defaultSelector ?? null,
      agent.agentClass,
      stringify(agent.capabilities),
      agent.wakePolicy,
      agent.homeNodeId,
      agent.authorityNodeId,
      agent.advertiseScope,
      agent.ownerId ?? null,
      stringify(agent.metadata),
    );
  }

  upsertEndpoint(endpoint: AgentEndpoint): void {
    // Projection replay is not a fresh observation. Prefer harness-owned
    // timestamps and preserve the prior projection time when the endpoint
    // record carries no observation evidence.
    const observedAt = endpointRuntimeSessionLastSeenAt(endpoint, 0);
    const insertedAt = currentTimestampMs();
    const persisted = this.db.query(
      `INSERT INTO agent_endpoints (
        id, agent_id, node_id, harness, transport, state, address, session_id, pane, cwd,
        project_root, metadata_json, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
        CASE WHEN ?13 > 0 THEN ?13 ELSE ?14 END
      )
      ON CONFLICT(id) DO UPDATE SET
        agent_id = excluded.agent_id,
        node_id = excluded.node_id,
        harness = excluded.harness,
        transport = excluded.transport,
        state = excluded.state,
        address = excluded.address,
        session_id = excluded.session_id,
        pane = excluded.pane,
        cwd = excluded.cwd,
        project_root = excluded.project_root,
        metadata_json = excluded.metadata_json,
        updated_at = CASE
          WHEN ?13 > agent_endpoints.updated_at THEN ?13
          ELSE agent_endpoints.updated_at
        END
      RETURNING updated_at`,
    ).get(
      endpoint.id,
      endpoint.agentId,
      endpoint.nodeId,
      endpoint.harness,
      endpoint.transport,
      endpoint.state,
      endpoint.address ?? null,
      endpoint.sessionId ?? null,
      endpoint.pane ?? null,
      endpoint.cwd ?? null,
      endpoint.projectRoot ?? null,
      stringify(endpoint.metadata),
      observedAt,
      insertedAt,
    ) as { updated_at: number } | null;
    const persistedAt = persisted?.updated_at ?? (observedAt || insertedAt);

    this.projectRuntimeSessionForEndpoint(endpoint, persistedAt);
    this.recordEndpointBudgetObservations(endpoint);
  }

  deleteEndpoint(endpointId: string): void {
    this.db.query("DELETE FROM agent_endpoints WHERE id = ?1").run(endpointId);
  }

  private markRuntimeSessionsForEndpointEnded(
    endpointId: string,
    keepSessionId: string | null,
    observedAt: number,
  ): void {
    const expiresAt = observedAt + RUNTIME_SESSION_RETENTION_MS;
    if (keepSessionId) {
      this.db.query(
        `UPDATE runtime_sessions
         SET state = CASE WHEN state IN ('offline', 'superseded') THEN state ELSE 'superseded' END,
             ended_at = COALESCE(ended_at, ?1),
             expires_at = COALESCE(expires_at, ?2),
             updated_at = ?3
         WHERE endpoint_id = ?4 AND id != ?5`,
      ).run(observedAt, expiresAt, observedAt, endpointId, keepSessionId);
      this.db.query(
        `UPDATE runtime_session_aliases
         SET expires_at = COALESCE(expires_at, ?1),
             last_seen_at = CASE WHEN last_seen_at > ?2 THEN last_seen_at ELSE ?2 END
         WHERE endpoint_id = ?3 AND session_id != ?4`,
      ).run(expiresAt, observedAt, endpointId, keepSessionId);
      return;
    }

    this.db.query(
      `UPDATE runtime_sessions
       SET state = CASE WHEN state IN ('offline', 'superseded') THEN state ELSE 'superseded' END,
           ended_at = COALESCE(ended_at, ?1),
           expires_at = COALESCE(expires_at, ?2),
           updated_at = ?3
       WHERE endpoint_id = ?4`,
    ).run(observedAt, expiresAt, observedAt, endpointId);
    this.db.query(
      `UPDATE runtime_session_aliases
       SET expires_at = COALESCE(expires_at, ?1),
           last_seen_at = CASE WHEN last_seen_at > ?2 THEN last_seen_at ELSE ?2 END
       WHERE endpoint_id = ?3`,
    ).run(expiresAt, observedAt, endpointId);
  }

  private projectRuntimeSessionForEndpoint(endpoint: AgentEndpoint, observedAt: number): void {
    const primaryAlias = endpointRuntimeSessionPrimaryAlias(endpoint);
    if (!primaryAlias) {
      this.markRuntimeSessionsForEndpointEnded(endpoint.id, null, observedAt);
      return;
    }

    const sessionId = endpointRuntimeSessionId(endpoint, primaryAlias);
    const lastSeenAt = endpointRuntimeSessionLastSeenAt(endpoint, observedAt);
    const startedAt = endpointRuntimeSessionStartedAt(endpoint, lastSeenAt);
    const terminal = endpointRuntimeSessionIsTerminal(endpoint);
    const endedAt = terminal ? lastSeenAt : null;
    const expiresAt = terminal ? lastSeenAt + RUNTIME_SESSION_RETENTION_MS : null;
    const aliases = endpointRuntimeSessionAliases(endpoint, sessionId);

    this.markRuntimeSessionsForEndpointEnded(endpoint.id, sessionId, lastSeenAt);
    this.db.query(
      `INSERT INTO runtime_sessions (
        id, agent_id, endpoint_id, node_id, harness, transport, state, primary_alias,
        external_session_id, cwd, project_root, started_at, last_seen_at, ended_at,
        expires_at, metadata_json, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
      ON CONFLICT(id) DO UPDATE SET
        agent_id = excluded.agent_id,
        endpoint_id = excluded.endpoint_id,
        node_id = excluded.node_id,
        harness = excluded.harness,
        transport = excluded.transport,
        state = excluded.state,
        primary_alias = excluded.primary_alias,
        external_session_id = excluded.external_session_id,
        cwd = excluded.cwd,
        project_root = excluded.project_root,
        started_at = COALESCE(runtime_sessions.started_at, excluded.started_at),
        last_seen_at = CASE
          WHEN runtime_sessions.last_seen_at > excluded.last_seen_at THEN runtime_sessions.last_seen_at
          ELSE excluded.last_seen_at
        END,
        ended_at = excluded.ended_at,
        expires_at = excluded.expires_at,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at`,
    ).run(
      sessionId,
      endpoint.agentId,
      endpoint.id,
      endpoint.nodeId,
      endpoint.harness,
      endpoint.transport,
      terminal ? endpointRuntimeSessionState(endpoint) : endpoint.state,
      primaryAlias,
      endpointRuntimeSessionExternalId(endpoint),
      endpoint.cwd ?? null,
      endpoint.projectRoot ?? null,
      startedAt,
      lastSeenAt,
      endedAt,
      expiresAt,
      stringify(endpoint.metadata),
      observedAt,
    );

    this.upsertRuntimeSessionAliases(endpoint, sessionId, aliases, lastSeenAt, expiresAt);
  }

  private upsertRuntimeSessionAliases(
    endpoint: AgentEndpoint,
    sessionId: string,
    aliases: RuntimeSessionAliasInput[],
    lastSeenAt: number,
    expiresAt: number | null,
  ): void {
    for (const alias of aliases) {
      this.db.query(
        `INSERT INTO runtime_session_aliases (
          alias, session_id, alias_kind, agent_id, endpoint_id, node_id, harness, transport,
          first_seen_at, last_seen_at, expires_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
        ON CONFLICT(alias, session_id) DO UPDATE SET
          alias_kind = excluded.alias_kind,
          agent_id = excluded.agent_id,
          endpoint_id = excluded.endpoint_id,
          node_id = excluded.node_id,
          harness = excluded.harness,
          transport = excluded.transport,
          last_seen_at = excluded.last_seen_at,
          expires_at = excluded.expires_at`,
      ).run(
        alias.alias,
        sessionId,
        alias.aliasKind,
        endpoint.agentId,
        endpoint.id,
        endpoint.nodeId,
        endpoint.harness,
        endpoint.transport,
        lastSeenAt,
        lastSeenAt,
        expiresAt,
      );
    }

    const aliasValues = aliases.map((alias) => alias.alias);
    if (aliasValues.length === 0) {
      this.db.query("DELETE FROM runtime_session_aliases WHERE session_id = ?1").run(sessionId);
      return;
    }
    const placeholders = aliasValues.map(() => "?").join(", ");
    this.db.query(
      `DELETE FROM runtime_session_aliases
       WHERE session_id = ? AND alias NOT IN (${placeholders})`,
    ).run(sessionId, ...aliasValues);
  }

  private recordEndpointBudgetObservations(endpoint: AgentEndpoint): void {
    const observations = budgetObservationsFromEndpoint(endpoint, currentTimestampMs());
    for (const record of observations.usage) {
      this.recordBudgetUsageEvent(record);
    }
    for (const snapshot of observations.quotaWindows) {
      this.recordBudgetQuotaWindowSnapshot(snapshot);
    }
  }

  recordBudgetUsageEvent(record: BudgetUsageRecord): void {
    const createdAt = record.createdAt ?? currentTimestampMs();
    this.db.query(
      `INSERT INTO budget_usage_events (
        id, scope, source, provider, harness, transport, model, agent_id, endpoint_id,
        session_id, project_root, conversation_id, message_id, invocation_id, flight_id,
        work_id, occurred_at, input_tokens, output_tokens, reasoning_output_tokens,
        cache_creation_input_tokens, cache_read_input_tokens, total_tokens, estimated_usd,
        billed_usd, currency, dedup_key, metadata_json, created_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
        ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29
      )
      ON CONFLICT(id) DO UPDATE SET
        scope = excluded.scope,
        source = excluded.source,
        provider = excluded.provider,
        harness = excluded.harness,
        transport = excluded.transport,
        model = excluded.model,
        agent_id = excluded.agent_id,
        endpoint_id = excluded.endpoint_id,
        session_id = excluded.session_id,
        project_root = excluded.project_root,
        conversation_id = excluded.conversation_id,
        message_id = excluded.message_id,
        invocation_id = excluded.invocation_id,
        flight_id = excluded.flight_id,
        work_id = excluded.work_id,
        occurred_at = excluded.occurred_at,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        reasoning_output_tokens = excluded.reasoning_output_tokens,
        cache_creation_input_tokens = excluded.cache_creation_input_tokens,
        cache_read_input_tokens = excluded.cache_read_input_tokens,
        total_tokens = excluded.total_tokens,
        estimated_usd = excluded.estimated_usd,
        billed_usd = excluded.billed_usd,
        currency = excluded.currency,
        dedup_key = excluded.dedup_key,
        metadata_json = excluded.metadata_json,
        created_at = excluded.created_at`,
    ).run(
      record.id,
      record.scope,
      record.source,
      record.provider ?? null,
      record.harness ?? null,
      record.transport ?? null,
      record.model ?? null,
      record.agentId ?? null,
      record.endpointId ?? null,
      record.sessionId ?? null,
      record.projectRoot ?? null,
      record.conversationId ?? null,
      record.messageId ?? null,
      record.invocationId ?? null,
      record.flightId ?? null,
      record.workId ?? null,
      record.occurredAt,
      record.inputTokens ?? null,
      record.outputTokens ?? null,
      record.reasoningOutputTokens ?? null,
      record.cacheCreationInputTokens ?? null,
      record.cacheReadInputTokens ?? null,
      record.totalTokens ?? null,
      record.estimatedUsd ?? null,
      record.billedUsd ?? null,
      record.currency ?? null,
      record.dedupKey ?? null,
      stringify(record.metadata),
      createdAt,
    );
  }

  listBudgetUsageEvents(options: BudgetUsageListOptions = {}): BudgetUsageRecord[] {
    const predicates: string[] = [];
    const params: SQLiteBinding[] = [];
    const addPredicate = (sql: string, value: SQLiteBinding): void => {
      predicates.push(sql);
      params.push(value);
    };

    if (options.scope) addPredicate("scope = ?", options.scope);
    if (options.provider) addPredicate("provider = ?", options.provider);
    if (options.agentId) addPredicate("agent_id = ?", options.agentId);
    if (options.endpointId) addPredicate("endpoint_id = ?", options.endpointId);
    if (options.sessionId) addPredicate("session_id = ?", options.sessionId);
    if (options.invocationId) addPredicate("invocation_id = ?", options.invocationId);
    if (options.flightId) addPredicate("flight_id = ?", options.flightId);
    if (typeof options.since === "number") addPredicate("occurred_at >= ?", options.since);
    if (typeof options.until === "number") addPredicate("occurred_at <= ?", options.until);

    const where = predicates.length > 0 ? `WHERE ${predicates.join(" AND ")}` : "";
    const rows = queryAllDynamic<BudgetUsageRow>(
      this.readDb,
      `SELECT *
      FROM budget_usage_events
      ${where}
      ORDER BY occurred_at DESC, created_at DESC
      LIMIT ?`,
      [...params, normalizedListLimit(options.limit)],
    );
    return rows.map(budgetUsageFromRow);
  }

  recordBudgetQuotaWindowSnapshot(snapshot: BudgetQuotaWindowSnapshot): void {
    const createdAt = snapshot.createdAt ?? currentTimestampMs();
    this.db.query(
      `INSERT INTO budget_quota_window_snapshots (
        id, source, provider, harness, transport, model, agent_id, endpoint_id,
        session_id, user_id, account_id, plan_type, label, window_kind, used_percent,
        percent_remaining, used, limit_value, reset_at, window_ms, captured_at,
        metadata_json, created_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
        ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23
      )
      ON CONFLICT(id) DO UPDATE SET
        source = excluded.source,
        provider = excluded.provider,
        harness = excluded.harness,
        transport = excluded.transport,
        model = excluded.model,
        agent_id = excluded.agent_id,
        endpoint_id = excluded.endpoint_id,
        session_id = excluded.session_id,
        user_id = excluded.user_id,
        account_id = excluded.account_id,
        plan_type = excluded.plan_type,
        label = excluded.label,
        window_kind = excluded.window_kind,
        used_percent = excluded.used_percent,
        percent_remaining = excluded.percent_remaining,
        used = excluded.used,
        limit_value = excluded.limit_value,
        reset_at = excluded.reset_at,
        window_ms = excluded.window_ms,
        captured_at = excluded.captured_at,
        metadata_json = excluded.metadata_json,
        created_at = excluded.created_at`,
    ).run(
      snapshot.id,
      snapshot.source,
      snapshot.provider ?? null,
      snapshot.harness ?? null,
      snapshot.transport ?? null,
      snapshot.model ?? null,
      snapshot.agentId ?? null,
      snapshot.endpointId ?? null,
      snapshot.sessionId ?? null,
      snapshot.userId ?? null,
      snapshot.accountId ?? null,
      snapshot.planType ?? null,
      snapshot.label,
      snapshot.windowKind ?? null,
      snapshot.usedPercent ?? null,
      snapshot.percentRemaining ?? null,
      snapshot.used ?? null,
      snapshot.limit ?? null,
      snapshot.resetAt ?? null,
      snapshot.windowMs ?? null,
      snapshot.capturedAt,
      stringify(snapshot.metadata),
      createdAt,
    );
  }

  listBudgetQuotaWindowSnapshots(options: BudgetQuotaWindowListOptions = {}): BudgetQuotaWindowSnapshot[] {
    const predicates: string[] = [];
    const params: SQLiteBinding[] = [];
    const addPredicate = (sql: string, value: SQLiteBinding): void => {
      predicates.push(sql);
      params.push(value);
    };

    if (options.source) addPredicate("source = ?", options.source);
    if (options.provider) addPredicate("provider = ?", options.provider);
    if (options.agentId) addPredicate("agent_id = ?", options.agentId);
    if (options.endpointId) addPredicate("endpoint_id = ?", options.endpointId);
    if (options.sessionId) addPredicate("session_id = ?", options.sessionId);
    if (options.label) addPredicate("label = ?", options.label);
    if (typeof options.since === "number") addPredicate("captured_at >= ?", options.since);
    if (typeof options.until === "number") addPredicate("captured_at <= ?", options.until);

    const where = predicates.length > 0 ? `WHERE ${predicates.join(" AND ")}` : "";
    const rows = queryAllDynamic<BudgetQuotaWindowRow>(
      this.readDb,
      `SELECT *
      FROM budget_quota_window_snapshots
      ${where}
      ORDER BY captured_at DESC, created_at DESC
      LIMIT ?`,
      [...params, normalizedListLimit(options.limit)],
    );
    return rows.map(budgetQuotaWindowFromRow);
  }

  upsertConversation(conversation: ConversationDefinition): void {
    (this.db as SQLiteTransactionalDatabase).transaction((nextConversation: ConversationDefinition) => {
      this.db.query(
        `INSERT INTO conversations (
          id, kind, title, visibility, share_mode, authority_node_id, topic,
          parent_conversation_id, message_id, metadata_json, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
        ON CONFLICT(id) DO UPDATE SET
          kind = excluded.kind,
          title = excluded.title,
          visibility = excluded.visibility,
          share_mode = excluded.share_mode,
          authority_node_id = excluded.authority_node_id,
          topic = excluded.topic,
          parent_conversation_id = excluded.parent_conversation_id,
          message_id = excluded.message_id,
          metadata_json = excluded.metadata_json`,
      ).run(
        nextConversation.id,
        nextConversation.kind,
        nextConversation.title,
        nextConversation.visibility,
        nextConversation.shareMode,
        nextConversation.authorityNodeId,
        nextConversation.topic ?? null,
        nextConversation.parentConversationId ?? null,
        nextConversation.messageId ?? null,
        stringify(nextConversation.metadata),
        currentTimestampMs(),
      );
      this.db.query("DELETE FROM conversation_members WHERE conversation_id = ?1").run(nextConversation.id);
      for (const participantId of nextConversation.participantIds) {
        this.db.query(
          "INSERT OR REPLACE INTO conversation_members (conversation_id, actor_id) VALUES (?1, ?2)",
        ).run(nextConversation.id, participantId);
      }
    })(conversation);
  }

  upsertBinding(binding: ConversationBinding): void {
    this.db.query(
      `INSERT INTO bindings (
        id, conversation_id, platform, mode, external_channel_id, external_thread_id, metadata_json
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      ON CONFLICT(id) DO UPDATE SET
        conversation_id = excluded.conversation_id,
        platform = excluded.platform,
        mode = excluded.mode,
        external_channel_id = excluded.external_channel_id,
        external_thread_id = excluded.external_thread_id,
        metadata_json = excluded.metadata_json`,
    ).run(
      binding.id,
      binding.conversationId,
      binding.platform,
      binding.mode,
      binding.externalChannelId,
      binding.externalThreadId ?? null,
      stringify(binding.metadata),
    );
  }

  recordMessage(message: MessageRecord): ThreadEventEnvelope[] {
    const activityItem = this.projectMessageActivity(message);
    const threadMessageEvent = this.buildThreadMessageEvent(message, this.readDb);
    let threadEvents: ThreadEventEnvelope[] = [];
    (this.db as SQLiteTransactionalDatabase).transaction((
      nextMessage: MessageRecord,
      nextActivityItem: ActivityItem,
      nextThreadMessageEvent: ThreadEventInsert | null,
    ) => {
      this.db.query(
        `INSERT INTO messages (
          id, conversation_id, actor_id, origin_node_id, class, body, reply_to_message_id,
          thread_conversation_id, speech_json, audience_json, visibility, policy, metadata_json, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
        ON CONFLICT(id) DO UPDATE SET
          conversation_id = excluded.conversation_id,
          actor_id = excluded.actor_id,
          origin_node_id = excluded.origin_node_id,
          class = excluded.class,
          body = excluded.body,
          reply_to_message_id = excluded.reply_to_message_id,
          thread_conversation_id = excluded.thread_conversation_id,
          speech_json = excluded.speech_json,
          audience_json = excluded.audience_json,
          visibility = excluded.visibility,
          policy = excluded.policy,
          metadata_json = excluded.metadata_json,
          created_at = excluded.created_at`,
      ).run(
        nextMessage.id,
        nextMessage.conversationId,
        nextMessage.actorId,
        nextMessage.originNodeId,
        nextMessage.class,
        nextMessage.body,
        nextMessage.replyToMessageId ?? null,
        nextMessage.threadConversationId ?? null,
        stringify(nextMessage.speech),
        stringify(nextMessage.audience),
        nextMessage.visibility,
        nextMessage.policy,
        stringify(nextMessage.metadata),
        nextMessage.createdAt,
      );
      this.db.query("DELETE FROM message_mentions WHERE message_id = ?1").run(nextMessage.id);
      for (const mention of nextMessage.mentions ?? []) {
        this.db.query(
          "INSERT OR REPLACE INTO message_mentions (message_id, actor_id, label) VALUES (?1, ?2, ?3)",
        ).run(nextMessage.id, mention.actorId, mention.label ?? null);
      }
      this.db.query("DELETE FROM message_attachments WHERE message_id = ?1").run(nextMessage.id);
      for (const attachment of nextMessage.attachments ?? []) {
        this.db.query(
          `INSERT OR REPLACE INTO message_attachments (
            id, message_id, media_type, file_name, blob_key, url, metadata_json
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
        ).run(
          attachment.id,
          nextMessage.id,
          attachment.mediaType,
          attachment.fileName ?? null,
          attachment.blobKey ?? null,
          attachment.url ?? null,
          stringify(attachment.metadata),
        );
      }
      this.recordActivityItem(nextActivityItem);
      threadEvents = nextThreadMessageEvent
        ? [this.appendThreadEvent(nextThreadMessageEvent)]
        : [];
    })(message, activityItem, threadMessageEvent);
    return threadEvents;
  }

  upsertReadCursor(cursor: ConversationReadCursor): void {
    this.db.query(
      `INSERT INTO conversation_read_cursors (
        conversation_id, actor_id, reader_node_id, last_read_message_id,
        last_read_seq, last_read_at, updated_at, metadata_json
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
      ON CONFLICT(conversation_id, actor_id) DO UPDATE SET
        reader_node_id = excluded.reader_node_id,
        last_read_message_id = excluded.last_read_message_id,
        last_read_seq = excluded.last_read_seq,
        last_read_at = excluded.last_read_at,
        updated_at = excluded.updated_at,
        metadata_json = excluded.metadata_json`,
    ).run(
      cursor.conversationId,
      cursor.actorId,
      cursor.readerNodeId ?? null,
      cursor.lastReadMessageId ?? null,
      cursor.lastReadSeq ?? null,
      cursor.lastReadAt,
      cursor.updatedAt,
      stringify(cursor.metadata),
    );
  }

  listReadCursors(conversationId: string): ConversationReadCursor[] {
    const rows = queryAll<ReadCursorRow, [string]>(
      this.readDb,
      `SELECT *
      FROM conversation_read_cursors
      WHERE conversation_id = ?1
      ORDER BY updated_at DESC`,
      conversationId,
    );
    return rows.map((row) => ({
      conversationId: row.conversation_id,
      actorId: row.actor_id,
      readerNodeId: row.reader_node_id ?? undefined,
      lastReadMessageId: row.last_read_message_id ?? undefined,
      lastReadSeq: row.last_read_seq ?? undefined,
      lastReadAt: row.last_read_at,
      updatedAt: row.updated_at,
      metadata: parseJson<Record<string, unknown> | undefined>(row.metadata_json, undefined),
    }));
  }

  recordInvocation(invocation: InvocationRequest): void {
    const collaborationRecordId = resolveInvocationCollaborationRecordId(invocation);
    this.db.query(
      `INSERT INTO invocations (
        id, requester_id, requester_node_id, target_agent_id, target_node_id, action, task,
        collaboration_record_id, conversation_id, message_id, context_json, execution_json,
        execution_resolution_json, ensure_awake, stream, timeout_ms, labels_json, metadata_json, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)
      ON CONFLICT(id) DO UPDATE SET
        requester_id = excluded.requester_id,
        requester_node_id = excluded.requester_node_id,
        target_agent_id = excluded.target_agent_id,
        target_node_id = excluded.target_node_id,
        action = excluded.action,
        task = excluded.task,
        collaboration_record_id = excluded.collaboration_record_id,
        conversation_id = excluded.conversation_id,
        message_id = excluded.message_id,
        context_json = excluded.context_json,
        execution_json = excluded.execution_json,
        execution_resolution_json = excluded.execution_resolution_json,
        ensure_awake = excluded.ensure_awake,
        stream = excluded.stream,
        timeout_ms = excluded.timeout_ms,
        labels_json = excluded.labels_json,
        metadata_json = excluded.metadata_json,
        created_at = excluded.created_at`,
    ).run(
      invocation.id,
      invocation.requesterId,
      invocation.requesterNodeId,
      invocation.targetAgentId,
      invocation.targetNodeId ?? null,
      invocation.action,
      invocation.task,
      collaborationRecordId ?? null,
      invocation.conversationId ?? null,
      invocation.messageId ?? null,
      stringify(invocation.context),
      stringify(invocation.execution),
      stringify(invocation.executionResolution),
      invocation.ensureAwake ? 1 : 0,
      invocation.stream ? 1 : 0,
      invocation.timeoutMs ?? null,
      stringify(invocation.labels),
      stringify(invocation.metadata),
      invocation.createdAt,
    );
    this.recordActivityItem(this.projectInvocationActivity(invocation));
  }

  recordFlight(flight: FlightRecord): ThreadEventEnvelope[] {
    let recorded = flight;
    // One transaction so the flight row and the invocation shadow can never
    // durably diverge — a crash between the two writes would otherwise leave
    // a stale shadow until the next boot's self-healing reconcile.
    (this.db as SQLiteTransactionalDatabase).transaction(() => {
      // The invocation is the identity authority: a flight is that
      // invocation's status, so its requester/target cannot disagree with the
      // invocation's. Every broker path already passes matching values; this
      // normalizes the one unguarded writer (raw FlightRecord posts on
      // /v1/flights), whose divergent identity fields readers would otherwise
      // silently override now that they project from the invocation row.
      const identity = this.db.query(
        "SELECT requester_id, target_agent_id FROM invocations WHERE id = ?1",
      ).get(flight.invocationId) as {
        requester_id: string;
        target_agent_id: string;
      } | null;
      if (
        identity &&
        (identity.requester_id !== flight.requesterId ||
          identity.target_agent_id !== flight.targetAgentId)
      ) {
        recorded = {
          ...flight,
          requesterId: identity.requester_id,
          targetAgentId: identity.target_agent_id,
        };
      }

      this.db.query(
        `INSERT OR REPLACE INTO flights (
          id, invocation_id, requester_id, target_agent_id, state, summary, output, error,
          labels_json, metadata_json, started_at, completed_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
      ).run(
        recorded.id,
        recorded.invocationId,
        recorded.requesterId,
        recorded.targetAgentId,
        recorded.state,
        recorded.summary ?? null,
        recorded.output ?? null,
        recorded.error ?? null,
        stringify(recorded.labels),
        stringify(recorded.metadata),
        recorded.startedAt ?? null,
        recorded.completedAt ?? null,
      );

      // Dual-write the flight's status onto the merged invocation record
      // (Phase 3 flight→invocation storage merge, expand phase). Reads still
      // come from the flights table above; these columns are the shadow copy
      // PR D will read from. No-op when the invocation row is absent. The
      // WHERE guard keeps the shadow on the invocation's LATEST flight — same
      // freshness ordering as the backfill and the read-side projector
      // (COALESCE(completed_at, started_at, 0), ties to the newer write) — so
      // an out-of-order write of an older sibling flight cannot regress it;
      // rewrites of the shadowed flight itself always land.
      this.db.query(
        `UPDATE invocations SET
           flight_id = ?2, state = ?3, summary = ?4, output = ?5, error = ?6,
           started_at = ?7, completed_at = ?8, flight_metadata_json = ?9
         WHERE id = ?1
           AND (
             flight_id IS NULL
             OR flight_id = ?2
             OR COALESCE(?8, ?7, 0) >= COALESCE(completed_at, started_at, 0)
           )`,
      ).run(
        recorded.invocationId,
        recorded.id,
        recorded.state,
        recorded.summary ?? null,
        recorded.output ?? null,
        recorded.error ?? null,
        recorded.startedAt ?? null,
        recorded.completedAt ?? null,
        stringify(recorded.metadata),
      );
    })();

    this.recordActivityItem(this.projectFlightActivity(recorded));
    return this.recordThreadFlightEvent(recorded);
  }

  recordScoutDispatch(dispatch: ScoutDispatchRecord): void {
    this.db.query(
      `INSERT OR REPLACE INTO scout_dispatches (
        id, kind, asked_label, detail, invocation_id, conversation_id, requester_id,
        dispatcher_node_id, dispatched_at, payload_json
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    ).run(
      dispatch.id,
      dispatch.kind,
      dispatch.askedLabel,
      dispatch.detail,
      dispatch.invocationId ?? null,
      dispatch.conversationId ?? null,
      dispatch.requesterId ?? null,
      dispatch.dispatcherNodeId,
      dispatch.dispatchedAt,
      JSON.stringify(dispatch),
    );
  }

  recordCollaborationRecord(record: CollaborationRecord): ThreadEventEnvelope[] {
    const detail: Record<string, unknown> = {
      metadata: record.metadata,
    };

    if (record.kind === "question") {
      detail.askedById = record.askedById;
      detail.answeredById = record.answeredById;
      detail.answer = record.answer;
      detail.answeredAt = record.answeredAt;
      detail.closedAt = record.closedAt;
    } else {
      detail.requestedById = record.requestedById;
      detail.waitingOn = record.waitingOn;
      detail.progress = record.progress;
      detail.startedAt = record.startedAt;
      detail.reviewRequestedAt = record.reviewRequestedAt;
      detail.completedAt = record.completedAt;
    }

    this.db.query(
      `INSERT INTO collaboration_records (
        id, kind, state, acceptance_state, title, summary, created_by_id, owner_id,
        next_move_owner_id, conversation_id, parent_id, priority, labels_json, relations_json,
        detail_json, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        state = excluded.state,
        acceptance_state = excluded.acceptance_state,
        title = excluded.title,
        summary = excluded.summary,
        created_by_id = excluded.created_by_id,
        owner_id = excluded.owner_id,
        next_move_owner_id = excluded.next_move_owner_id,
        conversation_id = excluded.conversation_id,
        parent_id = excluded.parent_id,
        priority = excluded.priority,
        labels_json = excluded.labels_json,
        relations_json = excluded.relations_json,
        detail_json = excluded.detail_json,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at`,
    ).run(
      record.id,
      record.kind,
      record.state,
      record.acceptanceState,
      record.title,
      record.summary ?? null,
      record.createdById,
      record.ownerId ?? null,
      record.nextMoveOwnerId ?? null,
      record.conversationId ?? null,
      record.parentId ?? null,
      record.priority ?? null,
      stringify(record.labels),
      stringify(record.relations),
      stringify(detail),
      record.createdAt,
      record.updatedAt,
    );
    return this.recordThreadCollaborationEvent(record);
  }

  recordCollaborationEvent(event: CollaborationEvent): ThreadEventEnvelope[] {
    this.db.query(
      `INSERT OR REPLACE INTO collaboration_events (
        id, record_id, record_kind, kind, actor_id, summary, metadata_json, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    ).run(
      event.id,
      event.recordId,
      event.recordKind,
      event.kind,
      event.actorId,
      event.summary ?? null,
      stringify(event.metadata),
      event.at,
    );

    this.recordActivityItem({
      id: `activity:record:${event.id}`,
      kind: "collaboration_event",
      ts: event.at,
      recordId: event.recordId,
      actorId: event.actorId,
      title: summarizeText(event.summary ?? event.kind),
      summary: event.summary ?? event.kind,
      payload: {
        recordKind: event.recordKind,
        kind: event.kind,
        metadata: event.metadata,
      },
    });
    return this.recordThreadCollaborationEventAppend(event);
  }

  listActivityItems(options: {
    agentId?: string;
    actorId?: string;
    conversationId?: string;
    limit?: number;
  } = {}): ActivityItem[] {
    const filters: string[] = [];
    const values: Array<string | number> = [];

    if (options.agentId) {
      filters.push(`agent_id = ?${values.length + 1}`);
      values.push(options.agentId);
    }
    if (options.actorId) {
      filters.push(`actor_id = ?${values.length + 1}`);
      values.push(options.actorId);
    }
    if (options.conversationId) {
      filters.push(`conversation_id = ?${values.length + 1}`);
      values.push(options.conversationId);
    }

    const limit = options.limit ?? 200;
    const sql = [
      "SELECT * FROM activity_items",
      filters.length ? `WHERE ${filters.join(" AND ")}` : "",
      "ORDER BY ts DESC",
      `LIMIT ?${values.length + 1}`,
    ].filter(Boolean).join(" ");
    const rows = queryAll<ActivityItemRow, Array<string | number>>(this.readDb, sql, ...values, limit);
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      ts: row.ts,
      conversationId: row.conversation_id ?? undefined,
      messageId: row.message_id ?? undefined,
      invocationId: row.invocation_id ?? undefined,
      flightId: row.flight_id ?? undefined,
      recordId: row.record_id ?? undefined,
      actorId: row.actor_id ?? undefined,
      counterpartId: row.counterpart_id ?? undefined,
      agentId: row.agent_id ?? undefined,
      workspaceRoot: row.workspace_root ?? undefined,
      sessionId: row.session_id ?? undefined,
      title: row.title ?? undefined,
      summary: row.summary ?? undefined,
      payload: parseJson<Record<string, unknown> | undefined>(row.payload_json, undefined),
    }));
  }

  listCollaborationRecords(options: {
    limit?: number;
    kind?: CollaborationRecord["kind"];
    state?: string;
    ownerId?: string;
    nextMoveOwnerId?: string;
  } = {}): CollaborationRecord[] {
    const filters: string[] = [];
    const values: Array<string | number> = [];

    if (options.kind) {
      filters.push(`kind = ?${values.length + 1}`);
      values.push(options.kind);
    }
    if (options.state) {
      filters.push(`state = ?${values.length + 1}`);
      values.push(options.state);
    }
    if (options.ownerId) {
      filters.push(`owner_id = ?${values.length + 1}`);
      values.push(options.ownerId);
    }
    if (options.nextMoveOwnerId) {
      filters.push(`next_move_owner_id = ?${values.length + 1}`);
      values.push(options.nextMoveOwnerId);
    }

    const limit = options.limit ?? 200;
    const sql = [
      "SELECT * FROM collaboration_records",
      filters.length ? `WHERE ${filters.join(" AND ")}` : "",
      "ORDER BY updated_at DESC",
      `LIMIT ?${values.length + 1}`,
    ].filter(Boolean).join(" ");
    const rows = queryAll<CollaborationRecordRow, Array<string | number>>(this.readDb, sql, ...values, limit);
    return rows.map(buildCollaborationRecord);
  }

  listCollaborationEvents(options: { limit?: number; recordId?: string } = {}): CollaborationEvent[] {
    const filters: string[] = [];
    const values: Array<string | number> = [];

    if (options.recordId) {
      filters.push(`record_id = ?${values.length + 1}`);
      values.push(options.recordId);
    }

    const limit = options.limit ?? 200;
    const sql = [
      "SELECT * FROM collaboration_events",
      filters.length ? `WHERE ${filters.join(" AND ")}` : "",
      "ORDER BY created_at DESC",
      `LIMIT ?${values.length + 1}`,
    ].filter(Boolean).join(" ");
    const rows = queryAll<CollaborationEventRow, Array<string | number>>(this.readDb, sql, ...values, limit);
    return rows.map((row) => ({
      id: row.id,
      recordId: row.record_id,
      recordKind: row.record_kind as CollaborationEvent["recordKind"],
      kind: row.kind as CollaborationEvent["kind"],
      actorId: row.actor_id,
      summary: row.summary ?? undefined,
      metadata: parseJson<Record<string, unknown> | undefined>(row.metadata_json, undefined),
      at: row.created_at,
    }));
  }

  recordDeliveries(deliveries: DeliveryIntent[]): void {
    for (const delivery of deliveries) {
      this.drizzleDb
        .insert(deliveriesTable)
        .values({
          id: delivery.id,
          messageId: delivery.messageId ?? null,
          invocationId: delivery.invocationId ?? null,
          targetId: delivery.targetId,
          targetNodeId: delivery.targetNodeId ?? null,
          targetKind: delivery.targetKind,
          transport: delivery.transport,
          reason: delivery.reason,
          policy: delivery.policy,
          status: delivery.status,
          bindingId: delivery.bindingId ?? null,
          leaseOwner: delivery.leaseOwner ?? null,
          leaseExpiresAt: delivery.leaseExpiresAt ?? null,
          metadataJson: stringify(delivery.metadata),
          createdAt: this.deliveryCreatedAt(delivery),
        })
        .onConflictDoUpdate({
          target: deliveriesTable.id,
          set: {
            messageId: delivery.messageId ?? null,
            invocationId: delivery.invocationId ?? null,
            targetId: delivery.targetId,
            targetNodeId: delivery.targetNodeId ?? null,
            targetKind: delivery.targetKind,
            transport: delivery.transport,
            reason: delivery.reason,
            policy: delivery.policy,
            status: delivery.status,
            bindingId: delivery.bindingId ?? null,
            leaseOwner: delivery.leaseOwner ?? null,
            leaseExpiresAt: delivery.leaseExpiresAt ?? null,
            metadataJson: stringify(delivery.metadata),
          },
        })
        .run();
    }
  }

  private deliveryCreatedAt(delivery: DeliveryIntent): number {
    const messageCreatedAt = delivery.messageId
      ? queryGet<{ created_at: number }, [string]>(
          this.db,
          "SELECT created_at FROM messages WHERE id = ?1 LIMIT 1",
          delivery.messageId,
        )?.created_at
      : null;
    const invocationCreatedAt = delivery.invocationId
      ? queryGet<{ created_at: number }, [string]>(
          this.db,
          "SELECT created_at FROM invocations WHERE id = ?1 LIMIT 1",
          delivery.invocationId,
        )?.created_at
      : null;
    return normalizeTimestampMs(messageCreatedAt)
      ?? normalizeTimestampMs(invocationCreatedAt)
      ?? currentTimestampMs();
  }

  listDeliveries(options: {
    transport?: DeliveryIntent["transport"];
    status?: DeliveryIntent["status"];
    limit?: number;
  } = {}): DeliveryIntent[] {
    const limit = options.limit ?? 200;

    const baseQuery = this.drizzleReadDb
      .select()
      .from(deliveriesTable)
      .orderBy(asc(deliveriesTable.createdAt))
      .limit(limit);
    const rows = (options.transport && options.status
      ? baseQuery.where(
        and(
          eq(deliveriesTable.transport, options.transport),
          eq(deliveriesTable.status, options.status),
        ),
      ).all()
      : options.transport
        ? baseQuery.where(eq(deliveriesTable.transport, options.transport)).all()
        : options.status
          ? baseQuery.where(eq(deliveriesTable.status, options.status)).all()
          : baseQuery.all()) as Array<{
            id: string;
            messageId: string | null;
            invocationId: string | null;
            targetId: string;
            targetNodeId: string | null;
            targetKind: DeliveryIntent["targetKind"];
            transport: DeliveryIntent["transport"];
            reason: DeliveryIntent["reason"];
            policy: DeliveryIntent["policy"];
            status: DeliveryIntent["status"];
            bindingId: string | null;
            leaseOwner: string | null;
            leaseExpiresAt: number | null;
            metadataJson: string | null;
          }>;

    return rows.map((row) => ({
      id: row.id,
      messageId: row.messageId ?? undefined,
      invocationId: row.invocationId ?? undefined,
      targetId: row.targetId,
      targetNodeId: row.targetNodeId ?? undefined,
      targetKind: row.targetKind,
      transport: row.transport,
      reason: row.reason,
      policy: row.policy,
      status: row.status,
      bindingId: row.bindingId ?? undefined,
      leaseOwner: row.leaseOwner ?? undefined,
      leaseExpiresAt: row.leaseExpiresAt ?? undefined,
      metadata: parseJson<Record<string, unknown> | undefined>(row.metadataJson, undefined),
    }));
  }

  updateDeliveryStatus(
    deliveryId: string,
    status: DeliveryIntent["status"],
    options: {
      metadata?: Record<string, unknown> | undefined;
      leaseOwner?: string | null;
      leaseExpiresAt?: number | null;
    } = {},
  ): void {
    const current = this.drizzleDb
      .select({ metadataJson: deliveriesTable.metadataJson })
      .from(deliveriesTable)
      .where(eq(deliveriesTable.id, deliveryId))
      .get();
    const mergedMetadata = options.metadata
      ? {
          ...parseJson<Record<string, unknown>>(current?.metadataJson, {}),
          ...options.metadata,
        }
      : current?.metadataJson
        ? parseJson<Record<string, unknown>>(current.metadataJson, {})
        : undefined;

    this.drizzleDb
      .update(deliveriesTable)
      .set({
        status,
        leaseOwner: options.leaseOwner ?? null,
        leaseExpiresAt: options.leaseExpiresAt ?? null,
        metadataJson: stringify(mergedMetadata),
      })
      .where(eq(deliveriesTable.id, deliveryId))
      .run();
  }

  listDeliveryAttempts(deliveryId: string): DeliveryAttempt[] {
    const rows = this.drizzleReadDb
      .select()
      .from(deliveryAttemptsTable)
      .where(eq(deliveryAttemptsTable.deliveryId, deliveryId))
      .orderBy(asc(deliveryAttemptsTable.attempt), asc(deliveryAttemptsTable.createdAt))
      .all();

    return (rows as Array<{
      id: string;
      deliveryId: string;
      attempt: number;
      status: DeliveryAttempt["status"];
      error: string | null;
      externalRef: string | null;
      createdAt: number;
      metadataJson: string | null;
    }>).map((row) => ({
      id: row.id,
      deliveryId: row.deliveryId,
      attempt: row.attempt,
      status: row.status,
      error: row.error ?? undefined,
      externalRef: row.externalRef ?? undefined,
      createdAt: row.createdAt,
      metadata: parseJson<Record<string, unknown> | undefined>(row.metadataJson, undefined),
    }));
  }

  recordDeliveryAttempt(attempt: DeliveryAttempt): void {
    this.drizzleDb
      .insert(deliveryAttemptsTable)
      .values({
        id: attempt.id,
        deliveryId: attempt.deliveryId,
        attempt: attempt.attempt,
        status: attempt.status,
        error: attempt.error ?? null,
        externalRef: attempt.externalRef ?? null,
        metadataJson: stringify(attempt.metadata),
        createdAt: attempt.createdAt,
      })
      .onConflictDoUpdate({
        target: deliveryAttemptsTable.id,
        set: {
          deliveryId: attempt.deliveryId,
          attempt: attempt.attempt,
          status: attempt.status,
          error: attempt.error ?? null,
          externalRef: attempt.externalRef ?? null,
          metadataJson: stringify(attempt.metadata),
          createdAt: attempt.createdAt,
        },
      })
      .run();
  }

  createOrGetDurableAction(input: DurableActionCreateInput): {
    action: DurableAction;
    duplicate: boolean;
  } {
    const existing = input.idempotencyKey
      ? queryGet<DurableActionRow, [string, string, string]>(
          this.db,
          `SELECT * FROM durable_actions
           WHERE authority_cell_id = ?1 AND kind = ?2 AND idempotency_key = ?3`,
          input.authorityCellId,
          input.kind,
          input.idempotencyKey,
        )
      : queryGet<DurableActionRow, [string]>(
          this.db,
          "SELECT * FROM durable_actions WHERE id = ?1",
          input.id,
        );
    if (existing) {
      return { action: durableActionFromRow(existing), duplicate: true };
    }

    const action: DurableAction = {
      id: input.id,
      kind: input.kind,
      subjectId: input.subjectId,
      authorityCellId: input.authorityCellId,
      state: "pending",
      idempotencyKey: input.idempotencyKey,
      leaseGeneration: 0,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      metadata: input.metadata,
    };
    this.recordDurableAction(action);
    return { action, duplicate: false };
  }

  recordDurableAction(action: DurableAction): void {
    this.db.query(
      `INSERT INTO durable_actions (
        id, kind, subject_id, authority_cell_id, state, idempotency_key, lease_owner,
        lease_generation, lease_expires_at, metadata_json, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
      ON CONFLICT DO UPDATE SET
        kind = excluded.kind,
        subject_id = excluded.subject_id,
        authority_cell_id = excluded.authority_cell_id,
        state = excluded.state,
        idempotency_key = excluded.idempotency_key,
        lease_owner = excluded.lease_owner,
        lease_generation = excluded.lease_generation,
        lease_expires_at = excluded.lease_expires_at,
        metadata_json = excluded.metadata_json,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at`,
    ).run(
      action.id,
      action.kind,
      action.subjectId,
      action.authorityCellId,
      action.state,
      action.idempotencyKey ?? null,
      action.leaseOwner ?? null,
      action.leaseGeneration,
      action.leaseExpiresAt ?? null,
      stringify(action.metadata),
      action.createdAt,
      action.updatedAt,
    );
  }

  getDurableAction(actionId: string): DurableAction | null {
    const row = queryGet<DurableActionRow, [string]>(
      this.readDb,
      "SELECT * FROM durable_actions WHERE id = ?1",
      actionId,
    );
    return row ? durableActionFromRow(row) : null;
  }

  getDurableActionByIdempotencyKey(input: {
    authorityCellId: string;
    kind: DurableAction["kind"];
    idempotencyKey: string;
  }): DurableAction | null {
    const row = queryGet<DurableActionRow, [string, string, string]>(
      this.readDb,
      `SELECT * FROM durable_actions
       WHERE authority_cell_id = ?1 AND kind = ?2 AND idempotency_key = ?3`,
      input.authorityCellId,
      input.kind,
      input.idempotencyKey,
    );
    return row ? durableActionFromRow(row) : null;
  }

  listDueDurableActions(input: {
    kind?: DurableAction["kind"];
    authorityCellId?: string;
    dueAtLte: number;
    claimableAt?: number;
    limit?: number;
  }): DurableAction[] {
    const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? 50)));
    const claimableAt = input.claimableAt ?? input.dueAtLte;
    const where: string[] = [
      `(
        state IN ('pending', 'waiting')
        OR (
          state NOT IN ('completed', 'failed', 'cancelled')
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at <= ?1
        )
      )`,
      `COALESCE(
        CAST(json_extract(metadata_json, '$.dueAt') AS REAL),
        CAST(json_extract(metadata_json, '$.due_at') AS REAL)
      ) <= ?2`,
    ];
    const params: Array<string | number> = [claimableAt, input.dueAtLte];

    if (input.kind) {
      params.push(input.kind);
      where.push(`kind = ?${params.length}`);
    }
    if (input.authorityCellId) {
      params.push(input.authorityCellId);
      where.push(`authority_cell_id = ?${params.length}`);
    }
    params.push(limit);

    const rows = this.readDb.query(
      `SELECT *
       FROM durable_actions
       WHERE ${where.join(" AND ")}
       ORDER BY COALESCE(
         CAST(json_extract(metadata_json, '$.dueAt') AS REAL),
         CAST(json_extract(metadata_json, '$.due_at') AS REAL)
       ) ASC,
       updated_at ASC
       LIMIT ?${params.length}`,
    ).all(...params) as DurableActionRow[];
    return rows.map(durableActionFromRow);
  }

  claimDurableAction(input: DurableActionClaimInput): DurableAction | null {
    const current = queryGet<DurableActionRow, [string]>(
      this.db,
      "SELECT * FROM durable_actions WHERE id = ?1",
      input.actionId,
    );
    if (!current) {
      return null;
    }
    const now = input.claimedAt;
    const terminal = current.state === "completed"
      || current.state === "failed"
      || current.state === "cancelled";
    const leaseExpired = current.lease_expires_at !== null && current.lease_expires_at <= now;
    const claimable = current.state === "pending"
      || current.state === "waiting"
      || (!terminal && leaseExpired);
    if (!claimable) {
      return durableActionFromRow(current);
    }

    const nextGeneration = current.lease_generation + 1;
    const leaseExpiresAt = now + input.leaseMs;
    const result = this.db.query(
      `UPDATE durable_actions
       SET state = 'leased',
           lease_owner = ?2,
           lease_generation = ?3,
           lease_expires_at = ?4,
           updated_at = ?5
       WHERE id = ?1
         AND lease_generation = ?6
         AND (
           state IN ('pending', 'waiting')
           OR (
             state NOT IN ('completed', 'failed', 'cancelled')
             AND lease_expires_at IS NOT NULL
             AND lease_expires_at <= ?5
           )
         )`,
    ).run(
      input.actionId,
      input.owner,
      nextGeneration,
      leaseExpiresAt,
      now,
      current.lease_generation,
    ) as { changes?: number };

    if ((result.changes ?? 0) === 0) {
      // Claim loss is represented by returning the current action. Callers
      // determine ownership by comparing leaseOwner/leaseGeneration to their
      // requested owner and the expected next generation.
      return this.getDurableAction(input.actionId);
    }

    return this.getDurableAction(input.actionId);
  }

  heartbeatDurableAction(input: DurableActionHeartbeatInput): DurableAction | null {
    const leaseExpiresAt = input.heartbeatAt + input.leaseMs;
    const result = this.db.query(
      `UPDATE durable_actions
       SET lease_expires_at = ?4,
           updated_at = ?5
       WHERE id = ?1
         AND lease_owner = ?2
         AND lease_generation = ?3
         AND state NOT IN ('completed', 'failed', 'cancelled')`,
    ).run(
      input.actionId,
      input.owner,
      input.generation,
      leaseExpiresAt,
      input.heartbeatAt,
    ) as { changes?: number };

    return (result.changes ?? 0) > 0
      ? this.getDurableAction(input.actionId)
      : null;
  }

  transitionDurableAction(input: {
    actionId: string;
    owner: string;
    generation: number;
    nextState: DurableAction["state"];
    transitionedAt: number;
    metadata?: Record<string, unknown>;
  }): DurableAction | null {
    const current = queryGet<DurableActionRow, [string]>(
      this.db,
      "SELECT * FROM durable_actions WHERE id = ?1",
      input.actionId,
    );
    if (!current || current.lease_owner !== input.owner || current.lease_generation !== input.generation) {
      return null;
    }
    const metadata = input.metadata
      ? {
          ...parseJson<Record<string, unknown>>(current.metadata_json, {}),
          ...input.metadata,
        }
      : parseJson<Record<string, unknown> | undefined>(current.metadata_json, undefined);
    this.db.query(
      `UPDATE durable_actions
       SET state = ?2,
           metadata_json = ?3,
           updated_at = ?4
       WHERE id = ?1`,
    ).run(input.actionId, input.nextState, stringify(metadata), input.transitionedAt);
    return this.getDurableAction(input.actionId);
  }

  startDurableAttempt(input: {
    id: string;
    actionId: string;
    owner: string;
    generation: number;
    startedAt: number;
    metadata?: Record<string, unknown>;
  }): DurableAttempt | null {
    const createAttempt = (this.db as SQLiteTransactionalDatabase).transaction(
      (): DurableAttempt | null => {
        const action = queryGet<DurableActionRow, [string]>(
          this.db,
          "SELECT * FROM durable_actions WHERE id = ?1",
          input.actionId,
        );
        if (!action || action.lease_owner !== input.owner || action.lease_generation !== input.generation) {
          return null;
        }
        const attemptNumber = (queryGet<{ next_attempt: number | null }, [string]>(
          this.db,
          "SELECT MAX(attempt) + 1 AS next_attempt FROM durable_attempts WHERE action_id = ?1",
          input.actionId,
        )?.next_attempt ?? 1);
        const attempt: DurableAttempt = {
          id: input.id,
          actionId: input.actionId,
          attempt: attemptNumber,
          state: "running",
          leaseGeneration: input.generation,
          startedAt: input.startedAt,
          metadata: input.metadata,
        };
        this.recordDurableAttempt(attempt);
        return attempt;
      },
    );
    try {
      return createAttempt();
    } catch (error) {
      if (isSqliteConstraintError(error)) {
        return null;
      }
      throw error;
    }
  }

  recordDurableAttempt(attempt: DurableAttempt): void {
    this.db.query(
      `INSERT INTO durable_attempts (
        id, action_id, attempt, state, lease_generation, error, started_at,
        completed_at, metadata_json
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
      ON CONFLICT(id) DO UPDATE SET
        action_id = excluded.action_id,
        attempt = excluded.attempt,
        state = excluded.state,
        lease_generation = excluded.lease_generation,
        error = excluded.error,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        metadata_json = excluded.metadata_json`,
    ).run(
      attempt.id,
      attempt.actionId,
      attempt.attempt,
      attempt.state,
      attempt.leaseGeneration,
      attempt.error ?? null,
      attempt.startedAt ?? null,
      attempt.completedAt ?? null,
      stringify(attempt.metadata),
    );
  }

  listDurableAttempts(actionId: string): DurableAttempt[] {
    return queryAll<DurableAttemptRow, [string]>(
      this.readDb,
      "SELECT * FROM durable_attempts WHERE action_id = ?1 ORDER BY attempt ASC",
      actionId,
    ).map(durableAttemptFromRow);
  }

  commitDurableCheckpoint(checkpoint: DurableCheckpoint): {
    checkpoint: DurableCheckpoint;
    duplicate: boolean;
  } | null {
    if (!this.durableFactLeaseMatches(
      checkpoint.actionId,
      checkpoint.leaseOwner,
      checkpoint.leaseGeneration,
    )) {
      return null;
    }
    if (checkpoint.ownerAttemptId && !this.durableAttemptStillOwnsAction(
      checkpoint.actionId,
      checkpoint.ownerAttemptId,
    )) {
      return null;
    }
    const existing = queryGet<DurableCheckpointRow, [string, string]>(
      this.db,
      "SELECT * FROM durable_checkpoints WHERE action_id = ?1 AND name = ?2",
      checkpoint.actionId,
      checkpoint.name,
    );
    if (existing) {
      return { checkpoint: durableCheckpointFromRow(existing), duplicate: true };
    }
    this.db.query(
      `INSERT INTO durable_checkpoints (
        action_id, name, payload_json, owner_attempt_id, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5)`,
    ).run(
      checkpoint.actionId,
      checkpoint.name,
      stringify(checkpoint.payload),
      checkpoint.ownerAttemptId ?? null,
      checkpoint.createdAt,
    );
    return { checkpoint, duplicate: false };
  }

  emitDurableSignal(signal: DurableSignal): {
    signal: DurableSignal;
    duplicate: boolean;
  } | null {
    if (!this.durableFactLeaseMatches(
      signal.actionId,
      signal.leaseOwner,
      signal.leaseGeneration,
    )) {
      return null;
    }
    const existing = queryGet<DurableSignalRow, [string, string]>(
      this.db,
      "SELECT * FROM durable_signals WHERE action_id = ?1 AND name = ?2",
      signal.actionId,
      signal.name,
    );
    if (existing) {
      return { signal: durableSignalFromRow(existing), duplicate: true };
    }
    this.db.query(
      "INSERT INTO durable_signals (action_id, name, payload_json, emitted_at) VALUES (?1, ?2, ?3, ?4)",
    ).run(signal.actionId, signal.name, stringify(signal.payload), signal.emittedAt);
    return { signal, duplicate: false };
  }

  private durableFactLeaseMatches(
    actionId: string,
    owner: string | undefined,
    generation: number | undefined,
  ): boolean {
    if (!owner && generation === undefined) {
      // Undefined lease identity is the journal replay path. Live command
      // callers should pass both fields so stale owners cannot write facts.
      return true;
    }
    if (!owner || generation === undefined) {
      return false;
    }
    const action = queryGet<DurableActionRow, [string]>(
      this.db,
      "SELECT * FROM durable_actions WHERE id = ?1",
      actionId,
    );
    return Boolean(
      action
      && action.lease_owner === owner
      && action.lease_generation === generation
      && action.state !== "completed"
      && action.state !== "failed"
      && action.state !== "cancelled",
    );
  }

  private durableAttemptStillOwnsAction(
    actionId: string,
    attemptId: string,
  ): boolean {
    const attempt = queryGet<DurableAttemptRow, [string, string]>(
      this.db,
      "SELECT * FROM durable_attempts WHERE id = ?1 AND action_id = ?2",
      attemptId,
      actionId,
    );
    if (!attempt) {
      return false;
    }
    const action = queryGet<DurableActionRow, [string]>(
      this.db,
      "SELECT * FROM durable_actions WHERE id = ?1",
      actionId,
    );
    return Boolean(
      action
      && action.lease_generation === attempt.lease_generation
      && action.state !== "completed"
      && action.state !== "failed"
      && action.state !== "cancelled",
    );
  }

  private recordActivityItem(item: ActivityItem): void {
    this.db.query(
      `INSERT OR REPLACE INTO activity_items (
        id, kind, ts, conversation_id, message_id, invocation_id, flight_id, record_id,
        actor_id, counterpart_id, agent_id, workspace_root, session_id, title, summary, payload_json
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`,
    ).run(
      item.id,
      item.kind,
      item.ts,
      item.conversationId ?? null,
      item.messageId ?? null,
      item.invocationId ?? null,
      item.flightId ?? null,
      item.recordId ?? null,
      item.actorId ?? null,
      item.counterpartId ?? null,
      item.agentId ?? null,
      item.workspaceRoot ?? null,
      item.sessionId ?? null,
      item.title ?? null,
      item.summary ?? null,
      stringify(item.payload),
    );
  }

  private projectMessageActivity(message: MessageRecord): ActivityItem {
    const agentId = this.resolveActivityAgentIdForMessage(message);
    const counterpartId = this.resolveCounterpartIdForMessage(message, agentId);
    const agentContext = this.resolveAgentContext(agentId);
    const kind = this.classifyMessageActivity(message, agentId, counterpartId);
    const bodySummary = summarizeText(message.body);

    return {
      id: `activity:message:${message.id}`,
      kind,
      ts: message.createdAt,
      conversationId: message.conversationId,
      messageId: message.id,
      actorId: message.actorId,
      counterpartId: counterpartId ?? undefined,
      agentId: agentId ?? undefined,
      workspaceRoot: agentContext.workspaceRoot ?? undefined,
      sessionId: agentContext.sessionId ?? undefined,
      title: bodySummary,
      summary: kind === "status_message" || kind === "ask_working" || kind === "ask_failed"
        ? bodySummary
        : undefined,
      payload: {
        class: message.class,
        replyToMessageId: message.replyToMessageId ?? null,
        mentionActorIds: (message.mentions ?? []).map((mention) => mention.actorId),
        visibility: message.visibility,
        policy: message.policy,
      },
    };
  }

  private projectInvocationActivity(invocation: InvocationRequest): ActivityItem {
    const agentContext = this.resolveAgentContext(invocation.targetAgentId);
    return {
      id: `activity:invocation:${invocation.id}`,
      kind: "invocation_recorded",
      ts: invocation.createdAt,
      conversationId: invocation.conversationId ?? undefined,
      messageId: invocation.messageId ?? undefined,
      invocationId: invocation.id,
      actorId: invocation.requesterId,
      counterpartId: invocation.targetAgentId,
      agentId: invocation.targetAgentId,
      workspaceRoot: agentContext.workspaceRoot ?? undefined,
      sessionId: agentContext.sessionId ?? undefined,
      title: summarizeText(invocation.task),
      summary: invocation.action,
      payload: {
        action: invocation.action,
        targetNodeId: invocation.targetNodeId ?? null,
        ensureAwake: invocation.ensureAwake,
        stream: invocation.stream,
        timeoutMs: invocation.timeoutMs ?? null,
      },
    };
  }

  private projectFlightActivity(flight: FlightRecord): ActivityItem {
    const agentContext = this.resolveAgentContext(flight.targetAgentId);
    return {
      id: `activity:flight:${flight.id}`,
      kind: "flight_updated",
      ts: flight.completedAt ?? flight.startedAt ?? currentTimestampMs(),
      invocationId: flight.invocationId,
      flightId: flight.id,
      actorId: flight.requesterId,
      counterpartId: flight.targetAgentId,
      agentId: flight.targetAgentId,
      workspaceRoot: agentContext.workspaceRoot ?? undefined,
      sessionId: agentContext.sessionId ?? undefined,
      title: summarizeText(flight.summary ?? flight.state),
      summary: flight.error ?? flight.output ?? flight.summary ?? flight.state,
      payload: {
        state: flight.state,
        startedAt: flight.startedAt ?? null,
        completedAt: flight.completedAt ?? null,
      },
    };
  }

  private classifyMessageActivity(
    message: MessageRecord,
    agentId: string | null,
    counterpartId: string | null,
  ): ActivityItemKind {
    const body = message.body.toLowerCase();
    if (message.class === "status") {
      if (/failed|timed out|error/.test(body)) {
        return "ask_failed";
      }
      if (/working|running|waking|queued/.test(body)) {
        return "ask_working";
      }
      return "status_message";
    }

    if (this.isKnownAgentId(message.actorId) && counterpartId && this.isKnownAgentId(counterpartId) && counterpartId !== message.actorId) {
      return "handoff_sent";
    }

    if (message.replyToMessageId && this.isKnownAgentId(message.actorId)) {
      return "ask_replied";
    }

    if (agentId && message.actorId !== agentId && this.isDirectConversation(message.conversationId)) {
      return "ask_opened";
    }

    if (this.isKnownAgentId(message.actorId)) {
      return "agent_message";
    }

    return "message_posted";
  }

  private isDirectConversation(conversationId: string | undefined, db: ControlPlaneSqliteDatabase = this.readDb): boolean {
    if (!conversationId) {
      return false;
    }
    const row = queryGet<{ kind: string }, [string]>(
      db,
      "SELECT kind FROM conversations WHERE id = ?1 LIMIT 1",
      conversationId,
    );
    return row?.kind === "direct";
  }

  private resolveActivityAgentIdForMessage(message: MessageRecord): string | null {
    if (message.class === "status" && typeof message.metadata?.targetAgentId === "string" && this.isKnownAgentId(message.metadata.targetAgentId)) {
      return message.metadata.targetAgentId;
    }

    if (this.isKnownAgentId(message.actorId)) {
      return message.actorId;
    }

    const mentionedAgentIds = Array.from(new Set(
      (message.mentions ?? [])
        .map((mention) => mention.actorId)
        .filter((actorId) => this.isKnownAgentId(actorId)),
    ));
    if (mentionedAgentIds.length === 1) {
      return mentionedAgentIds[0] ?? null;
    }

    const conversationAgents = this.listConversationAgentIds(message.conversationId).filter((actorId) => actorId !== message.actorId);
    if (conversationAgents.length === 1) {
      return conversationAgents[0] ?? null;
    }

    return null;
  }

  private resolveCounterpartIdForMessage(message: MessageRecord, agentId: string | null): string | null {
    const conversationMembers = this.listConversationMemberIds(message.conversationId).filter((actorId) => actorId !== message.actorId);
    if (agentId && message.actorId !== agentId) {
      return message.actorId;
    }

    const explicitMentions = (message.mentions ?? [])
      .map((mention) => mention.actorId)
      .filter((actorId) => actorId !== message.actorId);
    if (explicitMentions.length === 1) {
      return explicitMentions[0] ?? null;
    }

    if (conversationMembers.length === 1) {
      return conversationMembers[0] ?? null;
    }

    return null;
  }

  private listConversationAgentIds(conversationId: string | undefined, db: ControlPlaneSqliteDatabase = this.readDb): string[] {
    if (!conversationId) {
      return [];
    }

    return queryAll<{ actor_id: string }, [string]>(
      db,
      `SELECT cm.actor_id
      FROM conversation_members cm
      JOIN agents a ON a.id = cm.actor_id
      WHERE cm.conversation_id = ?1`,
      conversationId,
    ).map((row) => row.actor_id);
  }

  private listConversationMemberIds(conversationId: string | undefined, db: ControlPlaneSqliteDatabase = this.readDb): string[] {
    if (!conversationId) {
      return [];
    }

    return queryAll<{ actor_id: string }, [string]>(
      db,
      "SELECT actor_id FROM conversation_members WHERE conversation_id = ?1",
      conversationId,
    ).map((row) => row.actor_id);
  }

  private isKnownAgentId(actorId: string | undefined | null, db: ControlPlaneSqliteDatabase = this.readDb): actorId is string {
    if (!actorId) {
      return false;
    }

    const row = queryGet<{ id: string }, [string]>(
      db,
      "SELECT id FROM agents WHERE id = ?1 LIMIT 1",
      actorId,
    );
    return Boolean(row?.id);
  }

  private resolveAgentContext(agentId: string | undefined | null): { workspaceRoot: string | null; sessionId: string | null } {
    if (!agentId) {
      return { workspaceRoot: null, sessionId: null };
    }

    const row = queryGet<Pick<EndpointRow, "project_root" | "cwd" | "session_id">, [string]>(
      this.readDb,
      `SELECT project_root, cwd, session_id
      FROM agent_endpoints
      WHERE agent_id = ?1
      ORDER BY updated_at DESC
      LIMIT 1`,
      agentId,
    );

    return {
      workspaceRoot: row?.project_root ?? row?.cwd ?? null,
      sessionId: row?.session_id ?? null,
    };
  }

  /**
   * SCO-031 §5: lazy singleton `Conversations` api bound to this store.
   * Callers do `store.conversations.findById(id)` rather than reaching for
   * `getConversation` directly. The api owns conversation identity logic
   * (legacy structural-ID parsing, future `ensureByNaturalKey` semantics).
   */
  get conversations(): ConversationsApi {
    if (!this.conversationsApi) {
      this.conversationsApi = new Conversations(this);
    }
    return this.conversationsApi;
  }

  /**
   * @internal SCO-031: writer-side SQLite database exposed to `Conversations`
   * so the api can issue conversation-only queries without opening a third
   * connection. Not part of the public API; downstream code should go through
   * `store.conversations` or other purpose-built methods.
   */
  get writerDb(): ControlPlaneSqliteDatabase {
    return this.db;
  }

  /**
   * @internal SCO-031: read-side SQLite database (PRAGMA `query_only`) exposed to
   * `Conversations`. Same caveats as `writerDb` — internal only.
   */
  get readerDb(): ControlPlaneSqliteDatabase {
    return this.readDb;
  }

  /**
   * Load the canonical `ConversationDefinition` for a conversation id, or
   * `null` when the row is unknown. Promoted to public per SCO-031 §13 Q3 so
   * `Conversations.findById` can call it without reaching into a private — the
   * api (`packages/runtime/src/conversations/api.ts`) is the intended caller.
   * Other call sites should prefer `store.conversations.findById` over
   * invoking this directly.
   */
  getConversation(conversationId: string, db: ControlPlaneSqliteDatabase = this.db): ConversationDefinition | null {
    const row = queryGet<ConversationRow, [string]>(
      db,
      "SELECT * FROM conversations WHERE id = ?1 LIMIT 1",
      conversationId,
    );
    if (!row) {
      return null;
    }

    return {
      id: row.id,
      kind: row.kind,
      title: row.title,
      visibility: row.visibility,
      shareMode: row.share_mode,
      authorityNodeId: row.authority_node_id,
      participantIds: this.listConversationMemberIds(row.id, db),
      topic: row.topic ?? undefined,
      parentConversationId: row.parent_conversation_id ?? undefined,
      messageId: row.message_id ?? undefined,
      metadata: parseJson<Record<string, unknown> | undefined>(row.metadata_json, undefined),
    };
  }

  private buildThreadEvent(row: ThreadEventRow): ThreadEventEnvelope {
    return {
      id: row.id,
      conversationId: row.conversation_id,
      authorityNodeId: row.authority_node_id,
      seq: row.seq,
      kind: row.kind,
      actorId: row.actor_id ?? undefined,
      ts: row.ts,
      payload: parseJson<ThreadEventEnvelope["payload"]>(
        row.payload_json,
        {} as ThreadEventEnvelope["payload"],
      ),
      notification: parseJson<ThreadEventNotification | undefined>(
        row.notification_json,
        undefined,
      ),
    };
  }

  private threadModeForConversation(conversation: ConversationDefinition): "summary" | "shared" {
    return conversation.shareMode === "summary" ? "summary" : "shared";
  }

  private appendThreadEvent(input: ThreadEventInsert): ThreadEventEnvelope {
    const existing = queryGet<ThreadEventRow, [string]>(
      this.db,
      "SELECT * FROM thread_events WHERE id = ?1 LIMIT 1",
      input.id,
    );
    if (existing) {
      return this.buildThreadEvent(existing);
    }

    const nextSeqRow = queryGet<{ next_seq: number | null }, [string]>(
      this.db,
      "SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM thread_events WHERE conversation_id = ?1",
      input.conversation.id,
    );
    const seq = nextSeqRow?.next_seq ?? 1;

    this.db.query(
      `INSERT INTO thread_events (
        id, conversation_id, authority_node_id, seq, kind, actor_id, ts, payload_json, notification_json
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    ).run(
      input.id,
      input.conversation.id,
      input.conversation.authorityNodeId,
      seq,
      input.kind,
      input.actorId ?? null,
      input.ts,
      JSON.stringify(input.payload),
      stringify(input.notification),
    );

    return {
      id: input.id,
      conversationId: input.conversation.id,
      authorityNodeId: input.conversation.authorityNodeId,
      seq,
      kind: input.kind,
      actorId: input.actorId,
      ts: input.ts,
      payload: input.payload,
      notification: input.notification,
    };
  }

  private recordThreadMessageEvent(message: MessageRecord): ThreadEventEnvelope[] {
    const input = this.buildThreadMessageEvent(message);
    return input ? [this.appendThreadEvent(input)] : [];
  }

  private buildThreadMessageEvent(message: MessageRecord, db: ControlPlaneSqliteDatabase = this.db): ThreadEventInsert | null {
    const conversation = this.getConversation(message.conversationId, db);
    if (!conversation) {
      return null;
    }

    const payload = this.threadModeForConversation(conversation) === "summary"
      ? { message: this.buildThreadMessageSummary(message) }
      : { message };

    return {
      id: `thread-event:message:${message.id}:${message.createdAt}`,
      conversation,
      kind: "message.posted",
      actorId: message.actorId,
      ts: message.createdAt,
      payload,
      notification: this.buildMessageThreadNotification(message, db),
    };
  }

  private recordThreadFlightEvent(flight: FlightRecord): ThreadEventEnvelope[] {
    const invocation = queryGet<Pick<InvocationRow, "conversation_id">, [string]>(
      this.db,
      "SELECT conversation_id FROM invocations WHERE id = ?1 LIMIT 1",
      flight.invocationId,
    );
    if (!invocation?.conversation_id) {
      return [];
    }

    const conversation = this.getConversation(invocation.conversation_id);
    if (!conversation) {
      return [];
    }

    const payload = this.threadModeForConversation(conversation) === "summary"
      ? { flight: this.buildThreadFlightSummary(flight) }
      : { flight };
    const ts = flight.completedAt ?? flight.startedAt ?? currentTimestampMs();

    return [this.appendThreadEvent({
      id: `thread-event:flight:${flight.id}:${flight.state}:${ts}`,
      conversation,
      kind: "flight.updated",
      actorId: flight.requesterId,
      ts,
      payload,
      notification: this.buildFlightThreadNotification(flight),
    })];
  }

  private recordThreadCollaborationEvent(record: CollaborationRecord): ThreadEventEnvelope[] {
    if (!record.conversationId) {
      return [];
    }

    const conversation = this.getConversation(record.conversationId);
    if (!conversation) {
      return [];
    }

    const payload = this.threadModeForConversation(conversation) === "summary"
      ? { record: this.buildThreadCollaborationSummary(record) }
      : { record };

    return [this.appendThreadEvent({
      id: `thread-event:collaboration:${record.id}:${record.updatedAt}`,
      conversation,
      kind: "collaboration.upserted",
      actorId: record.createdById,
      ts: record.updatedAt,
      payload,
      notification: this.buildCollaborationThreadNotification(record),
    })];
  }

  private recordThreadCollaborationEventAppend(event: CollaborationEvent): ThreadEventEnvelope[] {
    const record = queryGet<CollaborationRecordRow, [string]>(
      this.db,
      "SELECT * FROM collaboration_records WHERE id = ?1 LIMIT 1",
      event.recordId,
    );
    if (!record?.conversation_id) {
      return [];
    }

    const conversation = this.getConversation(record.conversation_id);
    if (!conversation) {
      return [];
    }

    const payload = this.threadModeForConversation(conversation) === "summary"
      ? { event: this.buildThreadCollaborationEventSummary(event) }
      : { event };

    return [this.appendThreadEvent({
      id: `thread-event:collaboration-event:${event.id}:${event.at}`,
      conversation,
      kind: "collaboration.event.appended",
      actorId: event.actorId,
      ts: event.at,
      payload,
      notification: undefined,
    })];
  }

  private buildThreadMessageSummary(message: MessageRecord): ThreadMessageSummary {
    return {
      id: message.id,
      actorId: message.actorId,
      class: message.class,
      replyToMessageId: message.replyToMessageId,
      threadConversationId: message.threadConversationId,
      mentionActorIds: (message.mentions ?? []).map((mention) => mention.actorId),
      createdAt: message.createdAt,
      summary: summarizeText(message.body),
    };
  }

  private buildThreadFlightSummary(flight: FlightRecord): ThreadFlightSummary {
    return {
      id: flight.id,
      invocationId: flight.invocationId,
      requesterId: flight.requesterId,
      targetAgentId: flight.targetAgentId,
      state: flight.state,
      summary: flight.summary,
      error: flight.error,
      startedAt: flight.startedAt,
      completedAt: flight.completedAt,
    };
  }

  private buildThreadCollaborationSummary(record: CollaborationRecord): ThreadCollaborationSummary {
    return {
      id: record.id,
      kind: record.kind,
      state: record.state,
      acceptanceState: record.acceptanceState,
      title: record.title,
      summary: record.summary,
      ownerId: record.ownerId,
      nextMoveOwnerId: record.nextMoveOwnerId,
      updatedAt: record.updatedAt,
    };
  }

  private buildThreadCollaborationEventSummary(event: CollaborationEvent): ThreadCollaborationEventSummary {
    return {
      id: event.id,
      recordId: event.recordId,
      recordKind: event.recordKind,
      kind: event.kind,
      actorId: event.actorId,
      at: event.at,
      summary: event.summary,
    };
  }

  private buildMessageThreadNotification(message: MessageRecord, db: ControlPlaneSqliteDatabase = this.db): ThreadEventNotification | undefined {
    const mentionActorIds = [...new Set(
      (message.mentions ?? [])
        .map((mention) => mention.actorId)
        .filter((actorId) => actorId && actorId !== message.actorId),
    )];
    if (mentionActorIds.length > 0) {
      return {
        tier: "badge",
        targetActorIds: mentionActorIds,
        reason: "mention",
        summary: summarizeText(message.body, 80),
      };
    }

    if (!message.replyToMessageId) {
      return undefined;
    }

    const replyTarget = queryGet<{ actor_id: string }, [string]>(
      db,
      "SELECT actor_id FROM messages WHERE id = ?1 LIMIT 1",
      message.replyToMessageId,
    );
    if (!replyTarget?.actor_id || replyTarget.actor_id === message.actorId) {
      return undefined;
    }

    return {
      tier: "badge",
      targetActorIds: [replyTarget.actor_id],
      reason: "thread_reply",
      summary: summarizeText(message.body, 80),
    };
  }

  private buildFlightThreadNotification(flight: FlightRecord): ThreadEventNotification | undefined {
    if (flight.state === "completed") {
      return {
        tier: "badge",
        targetActorIds: [flight.requesterId],
        reason: "flight_completed",
        summary: summarizeText(flight.summary ?? `${flight.targetAgentId} completed`, 80),
      };
    }

    if (flight.state === "failed") {
      return {
        tier: "interrupt",
        targetActorIds: [flight.requesterId],
        reason: "flight_failed",
        summary: summarizeText(flight.error ?? flight.summary ?? `${flight.targetAgentId} failed`, 80),
      };
    }

    return undefined;
  }

  private buildCollaborationThreadNotification(record: CollaborationRecord): ThreadEventNotification | undefined {
    if (!record.nextMoveOwnerId || record.nextMoveOwnerId === record.createdById) {
      return undefined;
    }

    return {
      tier: "badge",
      targetActorIds: [record.nextMoveOwnerId],
      reason: "next_move",
      summary: summarizeText(record.summary ?? record.title, 80),
    };
  }

  private listConversationThreadMessages(
    conversation: ConversationDefinition,
  ): ThreadSnapshot["messages"] {
    const snapshot = this.loadSnapshot();
    const messages = Object.values(snapshot.messages)
      .filter((message) => message.conversationId === conversation.id)
      .sort((lhs, rhs) => lhs.createdAt - rhs.createdAt);

    return messages.map((message) => (
      this.threadModeForConversation(conversation) === "summary"
        ? this.buildThreadMessageSummary(message)
        : message
    ));
  }

  private listConversationThreadCollaboration(
    conversation: ConversationDefinition,
  ): ThreadSnapshot["collaboration"] {
    const snapshot = this.loadSnapshot();
    const records = Object.values(snapshot.collaborationRecords)
      .filter((record) => record.conversationId === conversation.id)
      .sort((lhs, rhs) => lhs.updatedAt - rhs.updatedAt);

    return records.map((record) => (
      this.threadModeForConversation(conversation) === "summary"
        ? this.buildThreadCollaborationSummary(record)
        : record
    ));
  }

  private listConversationThreadFlights(
    conversation: ConversationDefinition,
  ): ThreadSnapshot["activeFlights"] {
    const rows = queryAll<FlightRow, [string]>(
      this.readDb,
      `SELECT f.*
      FROM flights f
      JOIN invocations i ON i.id = f.invocation_id
      WHERE i.conversation_id = ?1
        AND f.state IN ('queued', 'waking', 'running', 'waiting')
      ORDER BY COALESCE(f.completed_at, f.started_at, 0) ASC`,
      conversation.id,
    );

    return rows.map((row) => {
      const flight: FlightRecord = {
        id: row.id,
        invocationId: row.invocation_id,
        requesterId: row.requester_id,
        targetAgentId: row.target_agent_id,
        state: row.state,
        summary: row.summary ?? undefined,
        output: row.output ?? undefined,
        error: row.error ?? undefined,
        labels: parseJson<string[] | undefined>(row.labels_json, undefined),
        metadata: parseJson<Record<string, unknown> | undefined>(row.metadata_json, undefined),
        startedAt: row.started_at ?? undefined,
        completedAt: row.completed_at ?? undefined,
      };

      return this.threadModeForConversation(conversation) === "summary"
        ? this.buildThreadFlightSummary(flight)
        : flight;
    });
  }

  recordEvent(event: ControlEvent): void {
    this.pendingEvents.push(event);
    this.schedulePendingEventFlush();
  }
}
