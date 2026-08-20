import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import {
  isWorkItemTerminalState,
  type CollaborationPriority,
  type FlightState,
  type MetadataMap,
  type ScoutId,
  type ScoutPermissionProfile,
  type WorkItemRecord,
  type WorkItemState,
} from "@openscout/protocol";

export type IssueSourceKind = "linear" | "github" | "scout";

export interface ExternalIssueSnapshot {
  source: IssueSourceKind;
  sourceInstanceId?: string;
  externalId: string;
  identifier: string;
  title: string;
  description?: string | null;
  state: string;
  priority?: number | null;
  url?: string | null;
  labels: string[];
  assignee?: {
    id?: string | null;
    name?: string | null;
  } | null;
  branchName?: string | null;
  blockedBy?: Array<{
    externalId?: string | null;
    identifier?: string | null;
    state?: string | null;
  }>;
  createdAt?: number;
  updatedAt?: number;
  version?: string | number | null;
  lastSeenAt: number;
  metadata?: MetadataMap;
}

export type IssueWorkspaceMode = "worktree" | "copy" | "container" | "external_sandbox";

export interface IssueRunnerProfile {
  id: ScoutId;
  displayName: string;
  enabled: boolean;
  projectRoot: string;
  revision?: string;
  tracker: {
    kind: IssueSourceKind;
    sourceInstanceId?: string;
    projectKey?: string;
    query?: string;
    activeStates: string[];
    terminalStates: string[];
    blockedStates?: string[];
    handoffStates?: string[];
    labelAllowlist?: string[];
    labelBlocklist?: string[];
  };
  polling: {
    intervalMs: number;
    jitterMs?: number;
    staleSourceAfterMs?: number;
  };
  claim: {
    leaseMs: number;
    heartbeatMs: number;
    staleGraceMs: number;
  };
  workspace: {
    root: string;
    mode: IssueWorkspaceMode;
    branchTemplate?: string;
    baseRef?: string;
    cleanupTerminal?: boolean;
    retainReviewWorkspaces?: boolean;
    dirtyWorkspacePolicy?: "reuse" | "quarantine" | "fail";
  };
  hooks?: {
    afterCreate?: string;
    beforeRun?: string;
    afterRun?: string;
    beforeRemove?: string;
    timeoutMs?: number;
  };
  agent: {
    agentId: ScoutId;
    maxConcurrentRuns: number;
    maxConcurrentRunsByState?: Record<string, number>;
  };
  continuation: {
    maxTurnsPerAttempt: number;
    maxAttemptsPerIssue: number;
    continueInSameThread: boolean;
    stallAfterMs: number;
  };
  retry: {
    maxAttempts: number;
    initialBackoffMs: number;
    maxBackoffMs: number;
    jitterMs?: number;
    retryableFailureKinds: string[];
  };
  permissions?: {
    permissionProfile?: ScoutPermissionProfile;
    requireReviewBeforePush?: boolean;
    requireReviewBeforeIssueDone?: boolean;
    requiredCapabilities?: string[];
  };
  handoff: {
    createReviewTask: boolean;
    reviewerId?: ScoutId;
    moveTrackerToState?: string;
    commentTemplate?: string;
    artifactPolicy: "summary" | "patch" | "branch" | "pull_request";
  };
  promptTemplate: string;
  metadata?: MetadataMap;
}

export type IssueBindingState = "active" | "archived" | "superseded";

export interface IssueBinding {
  id: ScoutId;
  key: string;
  profileId: ScoutId;
  source: IssueSourceKind;
  sourceInstanceId?: string;
  externalId: string;
  identifier: string;
  workId: ScoutId;
  state: IssueBindingState;
  latestIssue?: ExternalIssueSnapshot;
  createdAt: number;
  updatedAt: number;
  metadata?: MetadataMap;
}

export type IssueClaimState =
  | "claimed"
  | "provisioning"
  | "running"
  | "waiting"
  | "review"
  | "releasing"
  | "released"
  | "expired"
  | "cancelled";

export type IssueRunnerAttemptFailureKind =
  | "profile"
  | "source"
  | "binding"
  | "claim"
  | "workspace"
  | "agent"
  | "permission"
  | "run"
  | "timeout"
  | "cancelled"
  | "unknown";

export interface IssueClaim {
  id: ScoutId;
  profileId: ScoutId;
  bindingKey: string;
  workId: ScoutId;
  runnerId: ScoutId;
  generation: number;
  state: IssueClaimState;
  leaseOwnerId: ScoutId;
  leaseExpiresAt: number;
  heartbeatAt?: number;
  workspaceId?: ScoutId;
  runId?: ScoutId;
  flightId?: ScoutId;
  attempt: number;
  nextRetryAt?: number;
  lastError?: {
    kind: IssueRunnerAttemptFailureKind | string;
    message: string;
    retryable: boolean;
  };
  createdAt: number;
  updatedAt: number;
  metadata?: MetadataMap;
}

export type IssueWorkspaceDirtyState = "unknown" | "clean" | "dirty" | "quarantined";

export interface IssueWorkspace {
  id: ScoutId;
  profileId: ScoutId;
  bindingKey: string;
  workId: ScoutId;
  key: string;
  mode: IssueWorkspaceMode;
  path?: string;
  externalEnvironmentId?: string;
  projectRoot: string;
  baseRef?: string;
  baseCommit?: string;
  branchName?: string;
  createdAt: number;
  lastUsedAt: number;
  dirtyState: IssueWorkspaceDirtyState;
  cleanupTerminal?: boolean;
  cleanupDeadlineAt?: number;
  requestedPermissionProfile?: ScoutPermissionProfile;
  effectivePermissionProfile?: ScoutPermissionProfile;
  artifactDirectory?: string;
  metadata?: MetadataMap;
}

export type IssueRunnerFailureCategory =
  | "invalid_profile"
  | "profile_disabled"
  | "source_mismatch"
  | "source_stale"
  | "invalid_issue_identity"
  | "issue_inactive_state"
  | "issue_terminal_state"
  | "issue_blocked_state"
  | "issue_blocked_label"
  | "issue_blocked_dependency"
  | "work_item_missing"
  | "work_item_terminal_state"
  | "work_item_next_move_blocked"
  | "active_claim"
  | "active_run"
  | "not_due"
  | "max_attempts"
  | "concurrency_limit"
  | "workspace_path_unsafe"
  | "agent_unavailable"
  | "permission_unavailable";

export interface RunnerEligibilityFailure {
  category: IssueRunnerFailureCategory;
  message: string;
  metadata?: MetadataMap;
}

export interface IssueRunnerWorkItemLike {
  id: ScoutId;
  kind?: "work_item";
  title?: string;
  state: WorkItemState | string;
  acceptanceState?: WorkItemRecord["acceptanceState"];
  ownerId?: ScoutId;
  nextMoveOwnerId?: ScoutId;
  priority?: CollaborationPriority;
  labels?: string[];
  createdAt?: number;
  updatedAt?: number;
  metadata?: MetadataMap;
}

export interface IssueRunnerIssueInput {
  externalIssue: ExternalIssueSnapshot;
  workItem?: IssueRunnerWorkItemLike;
  binding?: IssueBinding;
  claim?: IssueClaim | null;
  activeRunIds?: ScoutId[];
  activeFlightStates?: FlightState[];
  nextRetryAt?: number;
  metadata?: MetadataMap;
}

export interface IssueRunnerCapacitySnapshot {
  activeRuns?: number;
  activeRunsByState?: Record<string, number>;
}

export interface EvaluateIssueRunnerEligibilityInput {
  profile: IssueRunnerProfile;
  issue: IssueRunnerIssueInput;
  now: number;
  workspaceRoot?: string;
  runnerId?: ScoutId;
  capacity?: IssueRunnerCapacitySnapshot;
}

export interface IssueWorkspacePathFailure {
  ok: false;
  category: "workspace_path_unsafe";
  message: string;
  rootPath?: string;
  workspaceKey?: string;
}

export interface IssueWorkspacePathSuccess {
  ok: true;
  rootPath: string;
  workspaceKey: string;
  workspacePath: string;
}

export type IssueWorkspacePathResult = IssueWorkspacePathSuccess | IssueWorkspacePathFailure;

export interface IssueSortKey {
  priorityRank: number;
  createdAtRank: number;
  updatedAtRank: number;
  identifier: string;
  bindingKey: string;
}

export interface RunnerEligibilityResult {
  eligible: boolean;
  profileId: ScoutId;
  issue: ExternalIssueSnapshot;
  workItem?: IssueRunnerWorkItemLike;
  bindingKey?: string;
  workspace?: IssueWorkspacePathSuccess;
  sortKey?: IssueSortKey;
  claimGeneration?: number;
  reclaimingExpiredClaim?: boolean;
  blockingClaim?: IssueClaim;
  failures: RunnerEligibilityFailure[];
}

export interface IssueDispatchPlan {
  id: ScoutId;
  profileId: ScoutId;
  runnerId: ScoutId;
  bindingKey: string;
  binding: IssueBinding;
  issue: ExternalIssueSnapshot;
  workItem: IssueRunnerWorkItemLike;
  claim: IssueClaim;
  workspace: IssueWorkspace;
  invocation: {
    targetAgentId: ScoutId;
    action: "execute";
    task: string;
    collaborationRecordId: ScoutId;
    context: MetadataMap;
    execution?: {
      permissionProfile?: ScoutPermissionProfile;
    };
    metadata: MetadataMap;
  };
  metadata: MetadataMap;
}

export interface PlanIssueRunnerDispatchesInput {
  profile: IssueRunnerProfile;
  candidates: IssueRunnerIssueInput[];
  now: number;
  workspaceRoot?: string;
  runnerId?: ScoutId;
  leaseOwnerId?: ScoutId;
  capacity?: IssueRunnerCapacitySnapshot;
  maxDispatches?: number;
}

export interface RunnerEligibilityPlan {
  profileId: ScoutId;
  now: number;
  eligible: RunnerEligibilityResult[];
  ineligible: RunnerEligibilityResult[];
  dispatches: IssueDispatchPlan[];
}

const CLAIM_TERMINAL_STATES = new Set<IssueClaimState>(["released", "expired", "cancelled"]);
const ACTIVE_FLIGHT_STATES = new Set<FlightState>(["queued", "waking", "running", "waiting"]);
const MAX_WORKSPACE_KEY_PREFIX_LENGTH = 72;

function shortHash(value: string, length = 10): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

export function deriveIssueRunnerStableId(prefix: string, value: string, length = 16): ScoutId {
  const normalizedPrefix = prefix.trim() || "issue-runner";
  return `${normalizedPrefix}-${shortHash(value, length)}`;
}

function normalizeComparable(value: string | undefined | null): string {
  return (value ?? "").trim().toLowerCase();
}

function matchesAny(value: string, candidates: string[] | undefined): boolean {
  const normalized = normalizeComparable(value);
  return Boolean(normalized) && (candidates ?? []).some((candidate) => normalizeComparable(candidate) === normalized);
}

function hasAnyLabel(labels: string[], candidates: string[] | undefined): boolean {
  const normalizedLabels = new Set(labels.map(normalizeComparable));
  return (candidates ?? []).some((candidate) => normalizedLabels.has(normalizeComparable(candidate)));
}

function issuePriorityRank(issue: ExternalIssueSnapshot): number {
  return typeof issue.priority === "number" && Number.isFinite(issue.priority)
    ? issue.priority
    : Number.MAX_SAFE_INTEGER;
}

function issueCreatedAtRank(issue: ExternalIssueSnapshot): number {
  return typeof issue.createdAt === "number" && Number.isFinite(issue.createdAt)
    ? issue.createdAt
    : Number.MAX_SAFE_INTEGER;
}

function issueUpdatedAtRank(issue: ExternalIssueSnapshot): number {
  return typeof issue.updatedAt === "number" && Number.isFinite(issue.updatedAt)
    ? issue.updatedAt
    : Number.MAX_SAFE_INTEGER;
}

function issueSortKey(profileId: ScoutId, issue: ExternalIssueSnapshot): IssueSortKey {
  let bindingKey: string;
  try {
    bindingKey = deriveIssueBindingKey(profileId, issue);
  } catch {
    bindingKey = `invalid:${issue.source}:${issue.sourceInstanceId ?? ""}:${issue.externalId}:${issue.identifier}`;
  }

  return {
    priorityRank: issuePriorityRank(issue),
    createdAtRank: issueCreatedAtRank(issue),
    updatedAtRank: issueUpdatedAtRank(issue),
    identifier: issue.identifier,
    bindingKey,
  };
}

function compareIssueSortKeys(left: IssueSortKey, right: IssueSortKey): number {
  return left.priorityRank - right.priorityRank
    || left.createdAtRank - right.createdAtRank
    || left.updatedAtRank - right.updatedAtRank
    || left.identifier.localeCompare(right.identifier)
    || left.bindingKey.localeCompare(right.bindingKey);
}

function safeSegment(value: string): string {
  return encodeURIComponent(value.trim());
}

function slugifyWorkspaceSegment(value: string): string {
  const slug = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "issue";
}

function containsPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

function isContainedPath(rootPath: string, candidatePath: string): boolean {
  const rel = relative(rootPath, candidatePath);
  return Boolean(rel) && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") && !isAbsolute(rel);
}

function failure(category: IssueRunnerFailureCategory, message: string, metadata?: MetadataMap): RunnerEligibilityFailure {
  return metadata ? { category, message, metadata } : { category, message };
}

function isTerminalWorkItemState(state: string): boolean {
  return isWorkItemTerminalState(state as WorkItemState) || state === "done" || state === "cancelled";
}

function hasActiveRun(input: IssueRunnerIssueInput): boolean {
  if ((input.activeRunIds?.length ?? 0) > 0) {
    return true;
  }

  return (input.activeFlightStates ?? []).some((state) => ACTIVE_FLIGHT_STATES.has(state));
}

function buildWorkspacePathFailure(message: string, rootPath?: string, workspaceKey?: string): IssueWorkspacePathFailure {
  return {
    ok: false,
    category: "workspace_path_unsafe",
    message,
    rootPath,
    workspaceKey,
  };
}

export function deriveIssueBindingKey(
  profileId: ScoutId,
  issue: Pick<ExternalIssueSnapshot, "source" | "sourceInstanceId" | "externalId">,
): string {
  if (!profileId.trim()) {
    throw new Error("profileId is required to derive an issue binding key");
  }
  if (!issue.source.trim()) {
    throw new Error("issue source is required to derive an issue binding key");
  }
  if (!issue.externalId.trim()) {
    throw new Error("externalId is required to derive an issue binding key");
  }

  return [
    "issue-binding",
    safeSegment(profileId),
    safeSegment(issue.source),
    safeSegment(issue.sourceInstanceId ?? ""),
    safeSegment(issue.externalId),
  ].join(":");
}

export function deriveIssueWorkspaceKey(
  profileId: ScoutId,
  issue: Pick<ExternalIssueSnapshot, "identifier" | "source" | "sourceInstanceId" | "externalId">,
  bindingKey = deriveIssueBindingKey(profileId, issue),
): string {
  const prefix = slugifyWorkspaceSegment(`${profileId}-${issue.identifier}`).slice(0, MAX_WORKSPACE_KEY_PREFIX_LENGTH);
  return `${prefix}-${shortHash(bindingKey)}`;
}

export function resolveIssueWorkspacePath(root: string, workspaceKey: string): IssueWorkspacePathResult {
  if (!root.trim()) {
    return buildWorkspacePathFailure("workspace root is required");
  }
  if (!workspaceKey.trim()) {
    return buildWorkspacePathFailure("workspace key is required", resolve(root));
  }
  if (isAbsolute(workspaceKey) || containsPathSeparator(workspaceKey)) {
    return buildWorkspacePathFailure("workspace key must be a single relative path segment", resolve(root), workspaceKey);
  }

  const rootPath = resolve(root);
  const workspacePath = resolve(rootPath, workspaceKey);
  if (!isContainedPath(rootPath, workspacePath)) {
    return buildWorkspacePathFailure("workspace path escapes configured root", rootPath, workspaceKey);
  }

  return {
    ok: true,
    rootPath,
    workspaceKey,
    workspacePath,
  };
}

export function isIssueClaimTerminal(claim: Pick<IssueClaim, "state">): boolean {
  return CLAIM_TERMINAL_STATES.has(claim.state);
}

export function isIssueClaimLeaseExpired(claim: Pick<IssueClaim, "leaseExpiresAt">, now: number): boolean {
  return claim.leaseExpiresAt <= now;
}

export function isIssueClaimStale(
  claim: Pick<IssueClaim, "leaseExpiresAt" | "heartbeatAt">,
  now: number,
  staleGraceMs: number,
): boolean {
  const staleAfter = Math.max(claim.leaseExpiresAt, claim.heartbeatAt ?? claim.leaseExpiresAt);
  return staleAfter + Math.max(0, staleGraceMs) <= now;
}

export function nextIssueClaimGeneration(claim?: IssueClaim | null): number {
  return claim ? claim.generation + 1 : 1;
}

export function sortIssueRunnerCandidates<T extends { externalIssue: ExternalIssueSnapshot }>(
  profileId: ScoutId,
  candidates: T[],
): T[] {
  return [...candidates].sort((left, right) =>
    compareIssueSortKeys(issueSortKey(profileId, left.externalIssue), issueSortKey(profileId, right.externalIssue))
  );
}

export function sortEligibleIssues<T extends RunnerEligibilityResult>(results: T[]): T[] {
  return [...results].sort((left, right) => {
    const leftKey = left.sortKey ?? issueSortKey(left.profileId, left.issue);
    const rightKey = right.sortKey ?? issueSortKey(right.profileId, right.issue);
    return compareIssueSortKeys(leftKey, rightKey);
  });
}

export function evaluateIssueRunnerEligibility(input: EvaluateIssueRunnerEligibilityInput): RunnerEligibilityResult {
  const { profile, issue: candidate, now } = input;
  const failures: RunnerEligibilityFailure[] = [];
  let bindingKey: string | undefined;
  let workspace: IssueWorkspacePathSuccess | undefined;
  let sortKey: IssueSortKey | undefined;

  if (!profile.id.trim()) {
    failures.push(failure("invalid_profile", "runner profile id is required"));
  }
  if (!profile.enabled) {
    failures.push(failure("profile_disabled", "runner profile is disabled"));
  }
  if (candidate.externalIssue.source !== profile.tracker.kind) {
    failures.push(failure("source_mismatch", "issue source does not match runner profile tracker"));
  }
  if (
    profile.tracker.sourceInstanceId
    && profile.tracker.sourceInstanceId !== (candidate.externalIssue.sourceInstanceId ?? "")
  ) {
    failures.push(failure("source_mismatch", "issue source instance does not match runner profile tracker"));
  }
  if (profile.polling.staleSourceAfterMs && candidate.externalIssue.lastSeenAt + profile.polling.staleSourceAfterMs <= now) {
    failures.push(failure("source_stale", "issue source snapshot is stale"));
  }
  if (!candidate.externalIssue.externalId.trim() || !candidate.externalIssue.identifier.trim()) {
    failures.push(failure("invalid_issue_identity", "issue externalId and identifier are required"));
  }

  if (!matchesAny(candidate.externalIssue.state, profile.tracker.activeStates)) {
    failures.push(failure("issue_inactive_state", "issue state is not active for this runner profile"));
  }
  if (matchesAny(candidate.externalIssue.state, profile.tracker.terminalStates)) {
    failures.push(failure("issue_terminal_state", "issue state is terminal"));
  }
  if (matchesAny(candidate.externalIssue.state, profile.tracker.blockedStates)) {
    failures.push(failure("issue_blocked_state", "issue state is blocked"));
  }
  if (hasAnyLabel(candidate.externalIssue.labels, profile.tracker.labelBlocklist)) {
    failures.push(failure("issue_blocked_label", "issue has a blocked label"));
  }
  if (
    profile.tracker.labelAllowlist?.length
    && !hasAnyLabel(candidate.externalIssue.labels, profile.tracker.labelAllowlist)
  ) {
    failures.push(failure("issue_blocked_label", "issue does not have an allowed label"));
  }
  if (
    candidate.externalIssue.blockedBy?.some((blocker) =>
      !blocker.state || !matchesAny(blocker.state, profile.tracker.terminalStates)
    )
  ) {
    failures.push(failure("issue_blocked_dependency", "issue has unresolved blockers"));
  }

  try {
    bindingKey = candidate.binding?.key ?? deriveIssueBindingKey(profile.id, candidate.externalIssue);
    sortKey = issueSortKey(profile.id, candidate.externalIssue);
  } catch (error) {
    failures.push(failure("invalid_issue_identity", error instanceof Error ? error.message : "issue binding key failed"));
  }

  if (!candidate.workItem) {
    failures.push(failure("work_item_missing", "issue has no Scout work item projection"));
  } else {
    if (candidate.workItem.kind && candidate.workItem.kind !== "work_item") {
      failures.push(failure("work_item_missing", "collaboration record is not a Scout work item"));
    }
    if (isTerminalWorkItemState(candidate.workItem.state)) {
      failures.push(failure("work_item_terminal_state", "Scout work item is terminal"));
    }
    const expectedNextMoveOwner = input.runnerId ?? profile.agent.agentId;
    if (
      candidate.workItem.nextMoveOwnerId
      && candidate.workItem.nextMoveOwnerId !== expectedNextMoveOwner
      && candidate.workItem.nextMoveOwnerId !== profile.agent.agentId
    ) {
      failures.push(failure("work_item_next_move_blocked", "Scout work item next move belongs to another actor"));
    }
  }

  if (candidate.claim && !isIssueClaimTerminal(candidate.claim)) {
    if (isIssueClaimLeaseExpired(candidate.claim, now)) {
      // Expired claims are reclaimable by a later broker transaction; the plan carries the next generation.
    } else {
      failures.push(failure("active_claim", "a non-expired issue claim already exists"));
    }
  }

  if (hasActiveRun(candidate)) {
    failures.push(failure("active_run", "work item already has an active run attempt"));
  }
  if (candidate.nextRetryAt && candidate.nextRetryAt > now) {
    failures.push(failure("not_due", "issue retry backoff has not elapsed"));
  }
  if (
    candidate.claim
    && isIssueClaimTerminal(candidate.claim)
    && candidate.claim.lastError
    && candidate.claim.attempt >= Math.min(profile.retry.maxAttempts, profile.continuation.maxAttemptsPerIssue)
  ) {
    failures.push(failure("max_attempts", "issue runner retry limit has been reached", {
      attempt: candidate.claim.attempt,
      maxAttempts: Math.min(profile.retry.maxAttempts, profile.continuation.maxAttemptsPerIssue),
      lastError: candidate.claim.lastError.message,
    }));
  }

  const capacityActiveRuns = input.capacity?.activeRuns ?? 0;
  if (profile.agent.maxConcurrentRuns >= 0 && capacityActiveRuns >= profile.agent.maxConcurrentRuns) {
    failures.push(failure("concurrency_limit", "runner profile has no global concurrency slots"));
  }
  const stateLimit = profile.agent.maxConcurrentRunsByState?.[candidate.externalIssue.state];
  const activeRunsForState = input.capacity?.activeRunsByState?.[candidate.externalIssue.state] ?? 0;
  if (typeof stateLimit === "number" && stateLimit >= 0 && activeRunsForState >= stateLimit) {
    failures.push(failure("concurrency_limit", "runner profile has no concurrency slots for this issue state"));
  }

  if (bindingKey) {
    const workspaceKey = deriveIssueWorkspaceKey(profile.id, candidate.externalIssue, bindingKey);
    const workspacePath = resolveIssueWorkspacePath(input.workspaceRoot ?? profile.workspace.root, workspaceKey);
    if (workspacePath.ok) {
      workspace = workspacePath;
    } else {
      failures.push(failure("workspace_path_unsafe", workspacePath.message, {
        rootPath: workspacePath.rootPath,
        workspaceKey: workspacePath.workspaceKey,
      }));
    }
  }

  const blockingClaim = candidate.claim && !isIssueClaimTerminal(candidate.claim) && !isIssueClaimLeaseExpired(candidate.claim, now)
    ? candidate.claim
    : undefined;

  return {
    eligible: failures.length === 0,
    profileId: profile.id,
    issue: candidate.externalIssue,
    workItem: candidate.workItem,
    bindingKey,
    workspace,
    sortKey,
    claimGeneration: nextIssueClaimGeneration(candidate.claim),
    reclaimingExpiredClaim: Boolean(
      candidate.claim
      && !isIssueClaimTerminal(candidate.claim)
      && isIssueClaimLeaseExpired(candidate.claim, now),
    ),
    blockingClaim,
    failures,
  };
}

function deriveIssueBranchName(profile: IssueRunnerProfile, issue: ExternalIssueSnapshot, bindingKey: string): string | undefined {
  if (profile.workspace.mode !== "worktree") {
    return undefined;
  }

  const identifier = slugifyWorkspaceSegment(issue.identifier).toLowerCase();
  const hash = shortHash(bindingKey, 8);
  if (!profile.workspace.branchTemplate) {
    return `codex/${identifier}-${hash}`;
  }

  return profile.workspace.branchTemplate
    .replaceAll("{{identifier}}", identifier)
    .replaceAll("{{bindingHash}}", hash)
    .replaceAll("{{profileId}}", slugifyWorkspaceSegment(profile.id).toLowerCase());
}

export function buildIssueDispatchPlan(input: {
  profile: IssueRunnerProfile;
  candidate: IssueRunnerIssueInput;
  eligibility: RunnerEligibilityResult;
  now: number;
  runnerId?: ScoutId;
  leaseOwnerId?: ScoutId;
}): IssueDispatchPlan {
  const { profile, candidate, eligibility, now } = input;
  if (!eligibility.eligible || !eligibility.bindingKey || !eligibility.workspace || !candidate.workItem) {
    throw new Error("cannot build issue dispatch plan for an ineligible issue");
  }

  const runnerId = input.runnerId ?? profile.agent.agentId;
  const leaseOwnerId = input.leaseOwnerId ?? runnerId;
  const claimGeneration = eligibility.claimGeneration ?? nextIssueClaimGeneration(candidate.claim);
  const binding: IssueBinding = candidate.binding ?? {
    id: `issue-binding-${shortHash(eligibility.bindingKey)}`,
    key: eligibility.bindingKey,
    profileId: profile.id,
    source: candidate.externalIssue.source,
    sourceInstanceId: candidate.externalIssue.sourceInstanceId,
    externalId: candidate.externalIssue.externalId,
    identifier: candidate.externalIssue.identifier,
    workId: candidate.workItem.id,
    state: "active",
    latestIssue: candidate.externalIssue,
    createdAt: now,
    updatedAt: now,
  };
  const workspaceId = `issue-workspace-${shortHash(`${profile.id}:${eligibility.bindingKey}`)}`;
  const claimId = `issue-claim-${shortHash(`${eligibility.bindingKey}:${claimGeneration}`, 16)}`;
  const workspace: IssueWorkspace = {
    id: workspaceId,
    profileId: profile.id,
    bindingKey: eligibility.bindingKey,
    workId: candidate.workItem.id,
    key: eligibility.workspace.workspaceKey,
    mode: profile.workspace.mode,
    path: eligibility.workspace.workspacePath,
    projectRoot: profile.projectRoot,
    baseRef: profile.workspace.baseRef,
    branchName: deriveIssueBranchName(profile, candidate.externalIssue, eligibility.bindingKey),
    createdAt: now,
    lastUsedAt: now,
    dirtyState: "unknown",
    cleanupTerminal: profile.workspace.cleanupTerminal,
    requestedPermissionProfile: profile.permissions?.permissionProfile,
    effectivePermissionProfile: profile.permissions?.permissionProfile,
  };
  const claim: IssueClaim = {
    id: claimId,
    profileId: profile.id,
    bindingKey: eligibility.bindingKey,
    workId: candidate.workItem.id,
    runnerId,
    generation: claimGeneration,
    state: "claimed",
    leaseOwnerId,
    leaseExpiresAt: now + profile.claim.leaseMs,
    workspaceId,
    attempt: candidate.claim ? candidate.claim.attempt + 1 : 1,
    createdAt: now,
    updatedAt: now,
    metadata: {
      previousClaimId: candidate.claim?.id,
      reclaimingExpiredClaim: eligibility.reclaimingExpiredClaim,
    },
  };

  return {
    id: `issue-dispatch-${shortHash(`${eligibility.bindingKey}:${claimGeneration}`, 16)}`,
    profileId: profile.id,
    runnerId,
    bindingKey: eligibility.bindingKey,
    binding,
    issue: candidate.externalIssue,
    workItem: candidate.workItem,
    claim,
    workspace,
    invocation: {
      targetAgentId: profile.agent.agentId,
      action: "execute",
      task: profile.promptTemplate,
      collaborationRecordId: candidate.workItem.id,
      context: {
        issueRunner: {
          profileId: profile.id,
          profileRevision: profile.revision,
          bindingKey: eligibility.bindingKey,
          claimId,
          claimGeneration,
          workspaceId,
          workspacePath: workspace.path,
          externalIssue: candidate.externalIssue,
          workItemId: candidate.workItem.id,
        },
      },
      execution: profile.permissions?.permissionProfile
        ? { permissionProfile: profile.permissions.permissionProfile }
        : undefined,
      metadata: {
        source: "external_issue",
        profileId: profile.id,
        bindingKey: eligibility.bindingKey,
        claimId,
        claimGeneration,
        workspaceId,
      },
    },
    metadata: {
      sortKey: eligibility.sortKey,
      reclaimingExpiredClaim: eligibility.reclaimingExpiredClaim,
      retry: {
        maxAttempts: Math.min(profile.retry.maxAttempts, profile.continuation.maxAttemptsPerIssue),
        initialBackoffMs: profile.retry.initialBackoffMs,
        maxBackoffMs: profile.retry.maxBackoffMs,
      },
    },
  };
}

export function planIssueRunnerDispatches(input: PlanIssueRunnerDispatchesInput): RunnerEligibilityPlan {
  const eligible: RunnerEligibilityResult[] = [];
  const ineligible: RunnerEligibilityResult[] = [];
  const dispatches: IssueDispatchPlan[] = [];
  const capacity: Required<IssueRunnerCapacitySnapshot> = {
    activeRuns: input.capacity?.activeRuns ?? 0,
    activeRunsByState: { ...(input.capacity?.activeRunsByState ?? {}) },
  };
  const maxDispatches = input.maxDispatches ?? Number.POSITIVE_INFINITY;

  for (const candidate of sortIssueRunnerCandidates(input.profile.id, input.candidates)) {
    const result = evaluateIssueRunnerEligibility({
      profile: input.profile,
      issue: candidate,
      now: input.now,
      workspaceRoot: input.workspaceRoot,
      runnerId: input.runnerId,
      capacity,
    });

    if (result.eligible && dispatches.length >= maxDispatches) {
      const capped = {
        ...result,
        eligible: false,
        failures: [
          ...result.failures,
          failure("concurrency_limit", "dispatch plan has reached maxDispatches"),
        ],
      };
      ineligible.push(capped);
      continue;
    }

    if (!result.eligible) {
      ineligible.push(result);
      continue;
    }

    const dispatch = buildIssueDispatchPlan({
      profile: input.profile,
      candidate,
      eligibility: result,
      now: input.now,
      runnerId: input.runnerId,
      leaseOwnerId: input.leaseOwnerId,
    });
    dispatches.push(dispatch);
    eligible.push(result);
    capacity.activeRuns += 1;
    capacity.activeRunsByState[candidate.externalIssue.state] = (capacity.activeRunsByState[candidate.externalIssue.state] ?? 0) + 1;
  }

  return {
    profileId: input.profile.id,
    now: input.now,
    eligible,
    ineligible,
    dispatches,
  };
}
