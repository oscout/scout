import type { AgentHarness } from "./actors.js";
import type { MetadataMap, ScoutId, VisibilityScope } from "./common.js";
import type {
  FlightRecord,
  Invocation,
  InvocationExecutionPreference,
  InvocationRequest,
} from "./invocations.js";
import {
  normalizeScoutPermissionProfile,
  type ScoutPermissionProfile,
} from "./permission-policy.js";

export const AGENT_RUN_STATES = [
  "queued",
  "waking",
  "running",
  "waiting",
  "review",
  "completed",
  "failed",
  "cancelled",
  "unknown",
] as const;

export type AgentRunState = typeof AGENT_RUN_STATES[number];

export const AGENT_RUN_SOURCES = [
  "ask",
  "message",
  "schedule",
  "recipe",
  "external_issue",
  "manual",
  "eval",
  "unknown",
] as const;

export type AgentRunSource = typeof AGENT_RUN_SOURCES[number];

export const AGENT_RUN_REVIEW_STATES = [
  "none",
  "needed",
  "blocked",
  "approved",
  "rejected",
] as const;

export type AgentRunReviewState = typeof AGENT_RUN_REVIEW_STATES[number];

export interface AgentRevisionSnapshot {
  id?: ScoutId;
  agentId?: ScoutId;
  definitionId?: ScoutId;
  revision?: number | string;
  digest?: string;
  displayName?: string;
  runtime?: {
    harness?: AgentHarness;
    transport?: string;
    model?: string;
    reasoningEffort?: string;
    session?: InvocationExecutionPreference["session"];
    launchArgs?: string[];
  };
  permissions?: {
    permissionProfile?: ScoutPermissionProfile | string;
    sandbox?: string;
    approvalPolicy?: string;
    enforcementLevel?: string;
    secretRefs?: string[];
  };
  workspace?: {
    projectRoot?: string;
    cwd?: string;
    mode?: "shared" | "isolated" | "external_sandbox";
    hooks?: string[];
  };
  provenance?: {
    source?: "managed_agent" | "ad_hoc" | "imported" | "promotion";
    sourceRef?: string;
    parentRevisionId?: ScoutId;
  };
  metadata?: MetadataMap;
}

export interface AgentRunMetrics {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimatedUsd?: number;
  wallClockMs?: number;
  toolCallCount?: number;
  retryCount?: number;
}

export interface AgentRun {
  id: ScoutId;
  source: AgentRunSource;
  requesterId: ScoutId;
  agentId: ScoutId;
  agentRevisionId?: ScoutId;
  agentRevisionSnapshot?: AgentRevisionSnapshot;
  aliasId?: ScoutId;
  workId?: ScoutId;
  collaborationRecordId?: ScoutId;
  conversationId?: ScoutId;
  messageId?: ScoutId;
  invocationId?: ScoutId;
  flightIds?: ScoutId[];
  parentRunId?: ScoutId;
  rootRunId?: ScoutId;
  recipeId?: ScoutId;
  attempt?: number;
  idempotencyKey?: string;
  state: AgentRunState;
  reviewState?: AgentRunReviewState;
  terminalReason?: string;
  input: MetadataMap;
  output?: MetadataMap;
  artifactIds?: ScoutId[];
  reviewTaskIds?: ScoutId[];
  traceSessionIds?: ScoutId[];
  createdAt: number;
  startedAt?: number;
  updatedAt: number;
  completedAt?: number;
  harness?: AgentHarness;
  model?: string;
  permissionProfile?: ScoutPermissionProfile;
  metrics?: AgentRunMetrics;
  metadata?: MetadataMap;
}

export type RunArtifactKind =
  | "patch"
  | "branch"
  | "commit"
  | "pull_request"
  | "file"
  | "report"
  | "screenshot"
  | "dataset_row"
  | "log_bundle"
  | "summary";

export interface RunArtifact {
  id: ScoutId;
  runId: ScoutId;
  stepId?: ScoutId;
  kind: RunArtifactKind;
  title: string;
  uri?: string;
  resourceId?: ScoutId;
  contentHash?: string;
  reviewTaskId?: ScoutId;
  createdAt: number;
  createdById?: ScoutId;
  metadata?: MetadataMap;
}

export type ReviewTaskKind =
  | "permission"
  | "output_review"
  | "promotion"
  | "retry_decision"
  | "eval_label"
  | "handoff";

export type ReviewTaskState =
  | "open"
  | "claimed"
  | "approved"
  | "rejected"
  | "dismissed"
  | "expired";

export interface ReviewTask {
  id: ScoutId;
  kind: ReviewTaskKind;
  subject: {
    runId?: ScoutId;
    workId?: ScoutId;
    stepId?: ScoutId;
    artifactId?: ScoutId;
    agentRevisionId?: ScoutId;
    promotionId?: ScoutId;
    traceRef?: {
      sessionId: ScoutId;
      turnId?: ScoutId;
      blockId?: ScoutId;
      version?: number;
    };
  };
  assigneeId?: ScoutId;
  groupId?: ScoutId;
  state: ReviewTaskState;
  risk?: "low" | "medium" | "high";
  form?: MetadataMap;
  decision?: MetadataMap;
  createdAt: number;
  claimedAt?: number;
  completedAt?: number;
  metadata?: MetadataMap;
}

export interface SavedRunView {
  id: ScoutId;
  name: string;
  ownerId?: ScoutId;
  visibility?: VisibilityScope;
  filters: MetadataMap;
  sort?: Array<{
    field: string;
    direction: "asc" | "desc";
  }>;
  createdAt: number;
  updatedAt: number;
  metadata?: MetadataMap;
}

export interface ProjectAgentRunFromInvocationFlightInput {
  invocation: InvocationRequest;
  flight?: FlightRecord;
  now?: number;
  source?: AgentRunSource;
  reviewState?: AgentRunReviewState;
  agentRevisionSnapshot?: AgentRevisionSnapshot;
  reviewTaskIds?: ScoutId[];
  artifactIds?: ScoutId[];
  traceSessionIds?: ScoutId[];
}

export interface ProjectAgentRunFromInvocationInput {
  /** The merged invocation record, carrying its own execution status. */
  invocation: Invocation;
  now?: number;
  source?: AgentRunSource;
  reviewState?: AgentRunReviewState;
  agentRevisionSnapshot?: AgentRevisionSnapshot;
  reviewTaskIds?: ScoutId[];
  artifactIds?: ScoutId[];
  traceSessionIds?: ScoutId[];
}

export function deriveProjectedAgentRunId(input: {
  invocationId: ScoutId;
  flightId?: ScoutId;
}): ScoutId {
  const flightId = trimString(input.flightId);
  if (flightId) {
    return `run:flight:${flightId}`;
  }

  return `run:invocation:${input.invocationId}`;
}

export function projectAgentRunFromInvocationFlight(
  input: ProjectAgentRunFromInvocationFlightInput,
): AgentRun {
  const { invocation, flight } = input;
  const agentRevisionSnapshot = input.agentRevisionSnapshot
    ?? metadataObject<AgentRevisionSnapshot>(invocation.metadata, "agentRevisionSnapshot");
  const reviewTaskIds = uniqueIds(input.reviewTaskIds ?? metadataIdList(invocation.metadata, "reviewTaskIds"));
  const artifactIds = uniqueIds(input.artifactIds ?? metadataIdList(invocation.metadata, "artifactIds"));
  const traceSessionIds = uniqueIds(input.traceSessionIds ?? metadataIdList(invocation.metadata, "traceSessionIds"));
  const reviewState = inferReviewState({
    explicitReviewState: input.reviewState,
    invocationMetadata: invocation.metadata,
    flightMetadata: flight?.metadata,
    reviewTaskIds,
  });
  const state = projectAgentRunState(flight?.state, reviewState);
  const output = projectOutput(flight);
  const metadata = projectMetadata({
    invocationMetadata: invocation.metadata,
    flightMetadata: flight?.metadata,
    agentRevisionSnapshot,
  });
  const permissionProfile = inferPermissionProfile(invocation, agentRevisionSnapshot);
  const harness = invocation.execution?.harness ?? agentRevisionSnapshot?.runtime?.harness;
  const model = stringMetadata(invocation.metadata, "model")
    ?? stringMetadata(flight?.metadata, "model")
    ?? agentRevisionSnapshot?.runtime?.model;
  const workId = inferWorkId(invocation);
  const collaborationRecordId = inferCollaborationRecordId(invocation);

  const run: AgentRun = {
    id: deriveProjectedAgentRunId({
      invocationId: invocation.id,
      flightId: flight?.id,
    }),
    source: input.source ?? inferAgentRunSource(invocation),
    requesterId: invocation.requesterId,
    agentId: invocation.targetAgentId,
    state,
    input: projectInput(invocation),
    createdAt: invocation.createdAt,
    updatedAt: projectUpdatedAt(invocation, flight, input.now),
  };

  addOptional(run, "agentRevisionId", agentRevisionSnapshot?.id ?? stringMetadata(invocation.metadata, "agentRevisionId"));
  addOptional(run, "agentRevisionSnapshot", agentRevisionSnapshot);
  addOptional(run, "aliasId", stringMetadata(invocation.metadata, "aliasId"));
  addOptional(run, "workId", workId);
  addOptional(run, "collaborationRecordId", collaborationRecordId);
  addOptional(run, "conversationId", invocation.conversationId);
  addOptional(run, "messageId", invocation.messageId);
  addOptional(run, "invocationId", invocation.id);
  addOptional(run, "flightIds", flight ? [flight.id] : undefined);
  addOptional(run, "parentRunId", stringMetadata(invocation.metadata, "parentRunId"));
  addOptional(run, "rootRunId", stringMetadata(invocation.metadata, "rootRunId"));
  addOptional(run, "recipeId", stringMetadata(invocation.metadata, "recipeId"));
  addOptional(run, "attempt", numberMetadata(invocation.metadata, "attempt"));
  addOptional(run, "idempotencyKey", stringMetadata(invocation.metadata, "idempotencyKey"));
  addOptional(run, "reviewState", reviewState);
  addOptional(run, "terminalReason", terminalReason(flight, state));
  addOptional(run, "output", output);
  addOptional(run, "artifactIds", artifactIds.length > 0 ? artifactIds : undefined);
  addOptional(run, "reviewTaskIds", reviewTaskIds.length > 0 ? reviewTaskIds : undefined);
  addOptional(run, "traceSessionIds", traceSessionIds.length > 0 ? traceSessionIds : undefined);
  addOptional(run, "startedAt", flight?.startedAt);
  addOptional(run, "completedAt", flight?.completedAt);
  addOptional(run, "harness", harness);
  addOptional(run, "model", model);
  addOptional(run, "permissionProfile", permissionProfile);
  addOptional(run, "metrics", inferMetrics(invocation.metadata, flight?.metadata));
  addOptional(run, "metadata", metadata);

  return run;
}

/**
 * Project an AgentRun from the merged invocation record (Phase 3's single source
 * of truth), where execution status lives on the invocation itself.
 *
 * Until the storage merge (PR B+) lands, this re-derives the flight view from the
 * invocation's status subset and delegates to
 * {@link projectAgentRunFromInvocationFlight}, so the two projectors stay
 * behavior-identical and the stable `run:flight:<flightId>` id is preserved. A
 * record with no durable flightId projects as an invocation-only run, exactly as
 * the flight-based projector does when no flight is present.
 */
export function projectAgentRunFromInvocation(
  input: ProjectAgentRunFromInvocationInput,
): AgentRun {
  const { invocation } = input;
  const flight: FlightRecord | undefined = invocation.flightId
    ? {
        id: invocation.flightId,
        invocationId: invocation.id,
        requesterId: invocation.requesterId,
        targetAgentId: invocation.targetAgentId,
        state: invocation.state ?? "queued",
        summary: invocation.summary,
        output: invocation.output,
        error: invocation.error,
        startedAt: invocation.startedAt,
        completedAt: invocation.completedAt,
        labels: invocation.labels,
        metadata: invocation.metadata,
      }
    : undefined;

  return projectAgentRunFromInvocationFlight({
    invocation,
    flight,
    now: input.now,
    source: input.source,
    reviewState: input.reviewState,
    agentRevisionSnapshot: input.agentRevisionSnapshot,
    reviewTaskIds: input.reviewTaskIds,
    artifactIds: input.artifactIds,
    traceSessionIds: input.traceSessionIds,
  });
}

export function projectAgentRunState(
  flightState: FlightRecord["state"] | string | undefined,
  reviewState?: AgentRunReviewState,
): AgentRunState {
  if (flightState === "failed") {
    return "failed";
  }
  if (flightState === "cancelled") {
    return "cancelled";
  }
  if (flightState === "completed" && isBlockingReviewState(reviewState)) {
    return "review";
  }
  if (isAgentRunState(flightState)) {
    return flightState;
  }

  return "unknown";
}

function projectInput(invocation: InvocationRequest): MetadataMap {
  const projected: MetadataMap = {
    action: invocation.action,
    task: invocation.task,
    targetAgentId: invocation.targetAgentId,
    requesterNodeId: invocation.requesterNodeId,
    ensureAwake: invocation.ensureAwake,
    stream: invocation.stream,
  };

  addOptional(projected, "targetNodeId", invocation.targetNodeId);
  addOptional(projected, "timeoutMs", invocation.timeoutMs);
  addOptional(projected, "context", invocation.context);
  addOptional(projected, "execution", invocation.execution);
  addOptional(projected, "metadata", invocation.metadata);

  return projected;
}

function projectOutput(flight: FlightRecord | undefined): MetadataMap | undefined {
  if (!flight) {
    return undefined;
  }

  const output: MetadataMap = {};
  addOptional(output, "summary", flight.summary);
  addOptional(output, "text", flight.output);
  addOptional(output, "error", flight.error);
  addOptional(output, "metadata", flight.metadata);

  return Object.keys(output).length > 0 ? output : undefined;
}

function projectMetadata(input: {
  invocationMetadata?: MetadataMap;
  flightMetadata?: MetadataMap;
  agentRevisionSnapshot?: AgentRevisionSnapshot;
}): MetadataMap | undefined {
  const metadata: MetadataMap = {};
  const rawSource = stringMetadata(input.invocationMetadata, "source");

  addOptional(metadata, "rawSource", rawSource);
  addOptional(metadata, "invocationMetadata", input.invocationMetadata);
  addOptional(metadata, "flightMetadata", input.flightMetadata);
  addOptional(metadata, "agentRevisionSnapshot", input.agentRevisionSnapshot);

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function projectUpdatedAt(
  invocation: InvocationRequest,
  flight: FlightRecord | undefined,
  now: number | undefined,
): number {
  if (flight?.completedAt !== undefined) {
    return flight.completedAt;
  }
  if (now !== undefined) {
    return now;
  }
  if (flight?.startedAt !== undefined) {
    return flight.startedAt;
  }
  return invocation.createdAt;
}

function inferAgentRunSource(invocation: InvocationRequest): AgentRunSource {
  const explicit = stringMetadata(invocation.metadata, "agentRunSource")
    ?? stringMetadata(invocation.metadata, "runSource");
  if (isAgentRunSource(explicit)) {
    return explicit;
  }

  const rawSource = stringMetadata(invocation.metadata, "source");
  if (isAgentRunSource(rawSource)) {
    return rawSource;
  }

  switch (rawSource) {
    case "collaboration-record":
      return "ask";
    case "broker-deliver":
      return "message";
    case "scout-app":
      return invocation.messageId ? "message" : "manual";
    case "scout-cli":
      return invocation.messageId ? "message" : "ask";
    default:
      break;
  }

  if (
    invocation.collaborationRecordId
    || metadataObject(invocation.context, "collaboration")
    || stringMetadata(invocation.context, "collaborationRecordId")
  ) {
    return "ask";
  }
  if (invocation.messageId || invocation.conversationId) {
    return "message";
  }
  if (invocation.action === "wake") {
    return "manual";
  }

  return "ask";
}

function inferReviewState(input: {
  explicitReviewState?: AgentRunReviewState;
  invocationMetadata?: MetadataMap;
  flightMetadata?: MetadataMap;
  reviewTaskIds: ScoutId[];
}): AgentRunReviewState | undefined {
  if (input.explicitReviewState) {
    return input.explicitReviewState;
  }

  const metadataReviewState = stringMetadata(input.flightMetadata, "reviewState")
    ?? stringMetadata(input.invocationMetadata, "reviewState");
  if (isAgentRunReviewState(metadataReviewState)) {
    return metadataReviewState;
  }

  if (
    input.reviewTaskIds.length > 0
    || booleanMetadata(input.flightMetadata, "reviewNeeded")
    || booleanMetadata(input.flightMetadata, "needsReview")
    || booleanMetadata(input.flightMetadata, "requiresReview")
    || booleanMetadata(input.invocationMetadata, "reviewNeeded")
    || booleanMetadata(input.invocationMetadata, "needsReview")
    || booleanMetadata(input.invocationMetadata, "requiresReview")
  ) {
    return "needed";
  }

  return undefined;
}

function inferPermissionProfile(
  invocation: InvocationRequest,
  agentRevisionSnapshot: AgentRevisionSnapshot | undefined,
): ScoutPermissionProfile | undefined {
  return invocation.execution?.permissionProfile
    ?? normalizeScoutPermissionProfile(stringMetadata(invocation.metadata, "permissionProfile"))
    ?? normalizeScoutPermissionProfile(agentRevisionSnapshot?.permissions?.permissionProfile);
}

function inferMetrics(
  invocationMetadata: MetadataMap | undefined,
  flightMetadata: MetadataMap | undefined,
): AgentRunMetrics | undefined {
  const metrics = metadataObject(flightMetadata, "metrics")
    ?? metadataObject(invocationMetadata, "metrics");
  if (!metrics) {
    return undefined;
  }

  const projected: AgentRunMetrics = {};
  addOptional(projected, "inputTokens", numberMetadata(metrics, "inputTokens"));
  addOptional(projected, "outputTokens", numberMetadata(metrics, "outputTokens"));
  addOptional(projected, "totalTokens", numberMetadata(metrics, "totalTokens"));
  addOptional(projected, "estimatedUsd", numberMetadata(metrics, "estimatedUsd"));
  addOptional(projected, "wallClockMs", numberMetadata(metrics, "wallClockMs"));
  addOptional(projected, "toolCallCount", numberMetadata(metrics, "toolCallCount"));
  addOptional(projected, "retryCount", numberMetadata(metrics, "retryCount"));

  return Object.keys(projected).length > 0 ? projected : undefined;
}

function inferWorkId(invocation: InvocationRequest): ScoutId | undefined {
  return stringMetadata(invocation.metadata, "workId")
    ?? stringMetadata(invocation.context, "workId")
    ?? inferCollaborationWorkId(invocation);
}

function inferCollaborationRecordId(invocation: InvocationRequest): ScoutId | undefined {
  return invocation.collaborationRecordId
    ?? stringMetadata(invocation.metadata, "collaborationRecordId")
    ?? stringMetadata(invocation.context, "collaborationRecordId")
    ?? stringMetadata(metadataObject(invocation.context, "collaboration"), "recordId");
}

function inferCollaborationWorkId(invocation: InvocationRequest): ScoutId | undefined {
  const collaboration = metadataObject(invocation.context, "collaboration");
  const collaborationKind = stringMetadata(invocation.metadata, "collaborationRecordKind")
    ?? stringMetadata(invocation.context, "collaborationRecordKind")
    ?? stringMetadata(collaboration, "kind")
    ?? stringMetadata(collaboration, "recordKind");
  if (collaborationKind !== "work_item") {
    return undefined;
  }

  return invocation.collaborationRecordId
    ?? stringMetadata(invocation.metadata, "collaborationRecordId")
    ?? stringMetadata(invocation.context, "collaborationRecordId")
    ?? stringMetadata(collaboration, "recordId");
}

function terminalReason(
  flight: FlightRecord | undefined,
  state: AgentRunState,
): string | undefined {
  if (!flight || (state !== "failed" && state !== "cancelled")) {
    return undefined;
  }

  return trimString(flight.error) ?? trimString(flight.summary);
}

function isBlockingReviewState(state: AgentRunReviewState | undefined): boolean {
  return state === "needed" || state === "blocked";
}

function isAgentRunState(value: unknown): value is AgentRunState {
  return typeof value === "string" && AGENT_RUN_STATES.includes(value as AgentRunState);
}

function isAgentRunSource(value: unknown): value is AgentRunSource {
  return typeof value === "string" && AGENT_RUN_SOURCES.includes(value as AgentRunSource);
}

function isAgentRunReviewState(value: unknown): value is AgentRunReviewState {
  return typeof value === "string" && AGENT_RUN_REVIEW_STATES.includes(value as AgentRunReviewState);
}

function metadataObject<T extends object = MetadataMap>(
  metadata: MetadataMap | undefined,
  key: string,
): T | undefined {
  const value = metadata?.[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as T : undefined;
}

function stringMetadata(metadata: MetadataMap | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return trimString(typeof value === "string" ? value : undefined);
}

function numberMetadata(metadata: MetadataMap | undefined, key: string): number | undefined {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanMetadata(metadata: MetadataMap | undefined, key: string): boolean {
  return metadata?.[key] === true;
}

function metadataIdList(metadata: MetadataMap | undefined, key: string): ScoutId[] {
  const value = metadata?.[key];
  if (Array.isArray(value)) {
    return value
      .map((item) => trimString(typeof item === "string" ? item : undefined))
      .filter((item): item is string => Boolean(item));
  }

  const single = trimString(typeof value === "string" ? value : undefined);
  return single ? [single] : [];
}

function uniqueIds(ids: ScoutId[]): ScoutId[] {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
}

function trimString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function addOptional<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
): void {
  if (value !== undefined) {
    target[key] = value;
  }
}
