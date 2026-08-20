#!/usr/bin/env bun

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export const STAGE_IDS = [
  "S00", "S10", "S20", "S30", "S40", "S50",
  "S60", "S70", "S80", "S90", "S100", "S110",
] as const;

export type StageId = (typeof STAGE_IDS)[number];
export type LaneClassification = "UNCLASSIFIED" | "READY" | "HOLD" | "BLOCK" | "EXCLUDE";
export type ReviewMode = "SELF" | "INDEPENDENT" | "MULTI_AGENT";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: any };

export interface WorkflowStage {
  id: StageId;
  title: string;
  outputType: string;
  transitions: StageId[];
  externalMutation: boolean;
}

export interface WorkflowDefinition {
  id: string;
  version: string;
  timezone: string;
  dailySlots: string[];
  stateRoot: string;
  laneClassifications: string[];
  reviewModes: ReviewMode[];
  stages: WorkflowStage[];
  mutationReceiptKinds: string[];
  idempotentOperations: string[];
  operationGates: Record<string, StageId[]>;
  reviewEscalation: Array<{ risk: string; examples: string[]; minimumMode: ReviewMode }>;
  retryPolicy: {
    maxStageRetries: number;
    maxArtifactAttempts: number;
    ownerPollDeadlineMinutes: number;
    ciPollIntervalSeconds: number;
    stopAfterRepeatedBlocker: boolean;
    quarantineLaneOnBlock: boolean;
    loops: Record<string, StageId[]>;
  };
  terminalStop: {
    command: "stop";
    targetStage: "S110";
    allowedFrom: StageId[];
    requiresReason: boolean;
  };
  stopPolicy: string[];
}

export interface LaneRecord {
  laneId: string;
  idempotencyKey: string;
  workItemId: string | null;
  owner: string;
  checkout: string;
  branch: string;
  headSha: string;
  commits: string[];
  pr: string | null;
  status: string;
  classification: LaneClassification;
  quarantined: boolean;
  reason: string | null;
  responseRef: string | null;
  ownerAuthorization: string | null;
}

export interface ReceiptRecord {
  receiptId: string;
  idempotencyKey: string;
  kind: string;
  stage: StageId;
  laneId: string | null;
  target: string;
  externalId: string;
  url: string | null;
  recordedAt: string;
  data: JsonObject;
}

export interface Checkpoint {
  schemaVersion: 1;
  workflowVersion: string;
  runId: string;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  repo: {
    root: string;
    identity: string;
    remoteUrl: string;
    repoHash: string;
  };
  lock: {
    key: string;
    token: string;
    status: "active" | "released";
    acquiredAt: string;
    expiresAt: string;
    releasedAt: string | null;
  };
  currentStage: StageId;
  loopEpoch: number;
  stageHistory: Array<{ from: StageId | null; to: StageId; at: string; reason: string }>;
  inputs: JsonObject;
  outputs: Partial<Record<StageId, Array<{ attempt: number; epoch: number; hash: string; recordedAt: string; artifact: JsonObject }>>>;
  decisions: JsonObject[];
  receipts: ReceiptRecord[];
  retryCount: Partial<Record<StageId, number>>;
  lanes: LaneRecord[];
  blockers: Array<{ stage: StageId; laneId: string | null; reason: string; at: string }>;
  exclusions: Array<{ laneId: string; reason: string; at: string }>;
}

const SCRIPT_DIR = import.meta.dir;
const SKILL_ROOT = resolve(SCRIPT_DIR, "..");
const WORKFLOW_PATH = join(SKILL_ROOT, "references", "workflow-v1.json");
const CHECKPOINT_SCHEMA_PATH = join(SKILL_ROOT, "references", "checkpoint-v1.schema.json");
const RUN_ID_PATTERN = /^rt-[0-9]{8}-(09|17)-[a-f0-9]{8}$/u;

function fail(message: string): never {
  throw new Error(message);
}

function asObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value as JsonObject;
}

function asArray(value: unknown, label: string): any[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value;
}

function asNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be a non-empty string`);
  return value.trim();
}

function nowIso(): string {
  return new Date().toISOString();
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableKey(...parts: string[]): string {
  return `sha256:${sha256(parts.join("\u001f"))}`;
}

function readJson(path: string): JsonObject {
  try {
    return asObject(JSON.parse(readFileSync(path, "utf8")), path);
  } catch (error) {
    fail(`Cannot read JSON ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  const descriptor = openSync(temporaryPath, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporaryPath, path);
}

function runGit(root: string, args: string[], allowFailure = false): string {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (result.status !== 0 && !allowFailure) {
    fail(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return (result.stdout || "").trimEnd();
}

function canonicalRepoRoot(checkout: string): string {
  return resolve(runGit(resolve(checkout), ["rev-parse", "--show-toplevel"]));
}

function normalizeRemote(remoteUrl: string): string {
  return remoteUrl
    .replace(/^git@github\.com:/u, "https://github.com/")
    .replace(/\.git$/u, "")
    .replace(/\/$/u, "");
}

export function computeLaneId(repoIdentity: string, checkout: string, branch: string): string {
  return `lane-${sha256(`${repoIdentity}\u001f${resolve(checkout)}\u001f${branch}`).slice(0, 16)}`;
}

export function computeReceiptIdempotencyKey(repoIdentity: string, kind: string, laneId: string | null, target: string): string {
  const laneScope = ["owner_poll", "convergence_poll", "commit", "push", "rebase"].includes(kind)
    ? laneId || "missing-lane"
    : "repository";
  return stableKey(repoIdentity, kind, laneScope, target);
}

function repoContext(checkout: string): Checkpoint["repo"] {
  const root = canonicalRepoRoot(checkout);
  const remoteUrl = runGit(root, ["config", "--get", "remote.origin.url"], true) || "local:no-origin";
  const identity = remoteUrl === "local:no-origin" ? root : normalizeRemote(remoteUrl);
  return { root, identity, remoteUrl, repoHash: sha256(identity).slice(0, 8) };
}

function zonedParts(date: Date, timezone: string): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

export function cycleKey(date = new Date(), timezone = "America/Montreal"): string {
  let parts = zonedParts(date, timezone);
  const hour = Number(parts.hour);
  let slot = "09";
  if (hour >= 17) slot = "17";
  else if (hour < 9) {
    parts = zonedParts(new Date(date.getTime() - 24 * 60 * 60 * 1000), timezone);
    slot = "17";
  }
  return `${parts.year}${parts.month}${parts.day}-${slot}`;
}

function defaultStateRoot(): string {
  return resolve(
    process.env.OPENSCOUT_RELEASE_TRAIN_HOME?.trim()
      || join(homedir(), ".openscout", "control-plane", "release-train"),
  );
}

export function loadWorkflow(): WorkflowDefinition {
  return readJson(WORKFLOW_PATH) as WorkflowDefinition;
}

export function validateWorkflowDefinition(workflow: WorkflowDefinition): void {
  if (workflow.id !== "openscout-release-train/v1") fail(`Unexpected workflow id ${workflow.id}`);
  if (workflow.version !== "1.0.0") fail(`Unexpected workflow version ${workflow.version}`);
  if (workflow.timezone !== "America/Montreal") fail("Workflow timezone must be America/Montreal");
  if (JSON.stringify(workflow.dailySlots) !== JSON.stringify(["09:00", "17:00"])) fail("Workflow slots must be 09:00 and 17:00");
  const ids = workflow.stages.map((stage) => stage.id);
  if (JSON.stringify(ids) !== JSON.stringify(STAGE_IDS)) fail(`Stage order mismatch: ${ids.join(",")}`);
  const expectedTransitions: Record<StageId, StageId[]> = {
    S00: ["S10"], S10: ["S20"], S20: ["S30"], S30: ["S40"],
    S40: ["S50"], S50: ["S60"], S60: ["S70"],
    S70: ["S40", "S50", "S80"], S80: ["S40", "S50", "S90"],
    S90: ["S100"], S100: ["S110"], S110: [],
  };
  for (const stage of workflow.stages) {
    if (JSON.stringify(stage.transitions) !== JSON.stringify(expectedTransitions[stage.id])) {
      fail(`Illegal transition definition for ${stage.id}`);
    }
    if (!stage.outputType) fail(`${stage.id} has no output type`);
  }
  const operationKinds = new Set([...workflow.mutationReceiptKinds, ...workflow.idempotentOperations]);
  if ([...operationKinds].some((kind) => !workflow.operationGates[kind]?.length)) {
    fail("Every receipt operation must have at least one legal stage gate");
  }
  if (!workflow.retryPolicy.quarantineLaneOnBlock) fail("BLOCK quarantine must be enabled");
  if (workflow.terminalStop.command !== "stop" || workflow.terminalStop.targetStage !== "S110" || !workflow.terminalStop.requiresReason) {
    fail("Workflow terminal stop contract is invalid");
  }
  for (const [kind, stages] of Object.entries(workflow.operationGates)) {
    if (!operationKinds.has(kind)) fail(`Unknown operation gate ${kind}`);
    if (stages.some((stage) => !isStageId(stage))) fail(`Invalid stage in operation gate ${kind}`);
  }
  for (const path of [WORKFLOW_PATH, CHECKPOINT_SCHEMA_PATH]) {
    if (!existsSync(path)) fail(`Missing workflow artifact ${path}`);
    readJson(path);
  }
}

function stageDefinition(workflow: WorkflowDefinition, stageId: StageId): WorkflowStage {
  return workflow.stages.find((stage) => stage.id === stageId) || fail(`Unknown stage ${stageId}`);
}

function isStageId(value: string): value is StageId {
  return (STAGE_IDS as readonly string[]).includes(value);
}

function latestOutput(checkpoint: Checkpoint, stageId: StageId): JsonObject | null {
  const attempts = checkpoint.outputs[stageId] || [];
  return attempts.at(-1)?.artifact || null;
}

function latestAttempt(checkpoint: Checkpoint, stageId: StageId): { attempt: number; epoch: number; hash: string; recordedAt: string; artifact: JsonObject } | null {
  return checkpoint.outputs[stageId]?.at(-1) || null;
}

function approvedLaneIds(checkpoint: Checkpoint): string[] {
  const plan = latestOutput(checkpoint, "S30");
  return Array.isArray(plan?.approvedLaneIds)
    ? plan.approvedLaneIds.filter((laneId: string) => checkpoint.lanes.some((lane) => lane.laneId === laneId && lane.classification === "READY"))
    : [];
}

function frozenApprovedLaneIds(checkpoint: Checkpoint): string[] {
  const plan = latestOutput(checkpoint, "S30");
  return Array.isArray(plan?.approvedLaneIds) ? plan.approvedLaneIds : [];
}

function expectedPullRequestKeys(checkpoint: Checkpoint): string[] {
  const pullRequests = latestOutput(checkpoint, "S60")?.prs;
  if (!Array.isArray(pullRequests)) return [];
  return pullRequests.map((pullRequest) => String(pullRequest.number ?? pullRequest.url));
}

function requireExactKeys(expected: string[], observed: string[], label: string): void {
  if (new Set(observed).size !== observed.length
    || expected.length !== observed.length
    || expected.some((key) => !observed.includes(key))) {
    fail(`${label} must cover every planned PR exactly once`);
  }
}

function laneById(checkpoint: Checkpoint, laneId: string): LaneRecord {
  return checkpoint.lanes.find((lane) => lane.laneId === laneId) || fail(`Unknown lane ${laneId}`);
}

function normalizeLane(checkpoint: Checkpoint, input: JsonObject): LaneRecord {
  const checkout = resolve(asNonEmptyString(input.checkout, "lane.checkout"));
  const branch = asNonEmptyString(input.branch, "lane.branch");
  const computedLaneId = computeLaneId(checkpoint.repo.identity, checkout, branch);
  const laneId = typeof input.laneId === "string" && input.laneId.trim() ? input.laneId.trim() : computedLaneId;
  if (laneId !== computedLaneId) fail(`lane.laneId must equal stable computed id ${computedLaneId}`);
  return {
    laneId,
    idempotencyKey: stableKey(checkpoint.runId, "lane", laneId),
    workItemId: typeof input.workItemId === "string" ? input.workItemId : null,
    owner: typeof input.owner === "string" && input.owner.trim() ? input.owner.trim() : "unknown",
    checkout,
    branch,
    headSha: asNonEmptyString(input.headSha, "lane.headSha"),
    commits: Array.isArray(input.commits) ? input.commits.map(String) : [],
    pr: typeof input.pr === "string" ? input.pr : null,
    status: typeof input.status === "string" ? input.status : "discovered",
    classification: "UNCLASSIFIED",
    quarantined: false,
    reason: typeof input.blocker === "string" ? input.blocker : null,
    responseRef: null,
    ownerAuthorization: null,
  };
}

function requireLaneSet(checkpoint: Checkpoint, values: any[], label: string): void {
  const expected = new Set(checkpoint.lanes.map((lane) => lane.laneId));
  const observed = new Set(values.map((value) => asNonEmptyString(value.laneId, `${label}.laneId`)));
  if (expected.size !== observed.size || [...expected].some((laneId) => !observed.has(laneId))) {
    fail(`${label} must cover every discovered lane exactly once`);
  }
}

const REVIEW_RANK: Record<ReviewMode, number> = { SELF: 0, INDEPENDENT: 1, MULTI_AGENT: 2 };
const RISK_MINIMUM: Record<string, ReviewMode> = {
  low: "SELF", medium: "INDEPENDENT", high: "INDEPENDENT", critical: "MULTI_AGENT",
};

export function validateStageArtifact(
  workflow: WorkflowDefinition,
  checkpoint: Checkpoint,
  stageId: StageId,
  rawArtifact: unknown,
  historical = false,
): JsonObject {
  const artifact = asObject(rawArtifact, `${stageId} artifact`);
  const expectedType = stageDefinition(workflow, stageId).outputType;
  if (artifact.type !== expectedType) fail(`${stageId} requires type=${expectedType}`);

  switch (stageId) {
    case "S00":
      for (const key of ["capturedAt", "repoRoot", "remoteUrl", "headSha", "originMainSha", "statusPorcelainHash", "worktreeListHash"]) {
        asNonEmptyString(artifact[key], `S00.${key}`);
      }
      break;
    case "S10": {
      const lanes = asArray(artifact.lanes, "S10.lanes");
      const normalized = lanes.map((lane) => normalizeLane(checkpoint, asObject(lane, "S10 lane")));
      const ids = new Set(normalized.map((lane) => lane.laneId));
      if (ids.size !== normalized.length) fail("S10 lane IDs must be unique");
      artifact.lanes = normalized;
      break;
    }
    case "S20": {
      const lanes = asArray(artifact.lanes, "S20.lanes");
      requireLaneSet(checkpoint, lanes, "S20.lanes");
      for (const entry of lanes) {
        if (!["READY", "HOLD", "BLOCK", "EXCLUDE"].includes(entry.classification)) {
          fail(`Invalid S20 classification ${entry.classification}`);
        }
        asNonEmptyString(entry.reason, `S20.${entry.laneId}.reason`);
      }
      asNonEmptyString(artifact.pollId, "S20.pollId");
      asNonEmptyString(artifact.idempotencyKey, "S20.idempotencyKey");
      const pollStartedAt = Date.parse(asNonEmptyString(artifact.pollStartedAt, "S20.pollStartedAt"));
      const deadline = Date.parse(asNonEmptyString(artifact.deadline, "S20.deadline"));
      if (!Number.isFinite(pollStartedAt) || !Number.isFinite(deadline) || deadline < pollStartedAt) fail("S20 poll timestamps are invalid");
      if (deadline - pollStartedAt > workflow.retryPolicy.ownerPollDeadlineMinutes * 60_000) fail("S20 owner poll exceeds configured deadline");
      break;
    }
    case "S30": {
      const approved = asArray(artifact.approvedLaneIds, "S30.approvedLaneIds").map(String);
      const excluded = asArray(artifact.excludedLaneIds, "S30.excludedLaneIds").map(String);
      for (const laneId of approved) {
        if (!historical && laneById(checkpoint, laneId).classification !== "READY") fail(`S30 cannot approve non-READY lane ${laneId}`);
      }
      for (const lane of checkpoint.lanes) {
        if (!historical && lane.classification !== "READY" && !excluded.includes(lane.laneId)) fail(`S30 must exclude ${lane.laneId}`);
      }
      const commitPlan = asArray(artifact.commitPlan, "S30.commitPlan");
      const plannedCommits = commitPlan.map((entry) => asNonEmptyString(entry.laneId, "S30.commitPlan.laneId"));
      if (new Set(plannedCommits).size !== plannedCommits.length || approved.some((laneId) => !plannedCommits.includes(laneId))) {
        fail("S30 commitPlan must cover every approved lane exactly once");
      }
      const prPlan = asArray(artifact.prPlan, "S30.prPlan");
      const plannedPrLanes = prPlan.flatMap((entry) => asArray(entry.laneIds, "S30.prPlan.laneIds").map(String));
      if (new Set(plannedPrLanes).size !== plannedPrLanes.length || approved.some((laneId) => !plannedPrLanes.includes(laneId))) {
        fail("S30 prPlan must cover every approved lane exactly once");
      }
      if (plannedCommits.some((laneId) => !approved.includes(laneId)) || plannedPrLanes.some((laneId) => !approved.includes(laneId))) {
        fail("S30 plans may contain only approved lanes");
      }
      asObject(artifact.releasePlan, "S30.releasePlan");
      asNonEmptyString(artifact.scopeHash, "S30.scopeHash");
      break;
    }
    case "S40": {
      const receipts = asArray(artifact.receipts, "S40.receipts");
      const noCommit = new Set(Array.isArray(artifact.noCommitRequiredLaneIds) ? artifact.noCommitRequiredLaneIds.map(String) : []);
      for (const laneId of approvedLaneIds(checkpoint)) {
        if (!noCommit.has(laneId) && !receipts.some((receipt) => receipt.laneId === laneId)) fail(`S40 missing commit receipt for ${laneId}`);
      }
      for (const receipt of receipts) {
        const lane = laneById(checkpoint, asNonEmptyString(receipt.laneId, "S40.receipt.laneId"));
        if (!historical && lane.classification !== "READY") fail(`S40 receipt targets forbidden lane ${lane.laneId}`);
        asNonEmptyString(receipt.commitSha, "S40.receipt.commitSha");
        if (receipt.authorshipPreserved !== true) fail("S40 receipt must confirm authorshipPreserved=true");
      }
      break;
    }
    case "S50": {
      const receipts = asArray(artifact.receipts, "S50.receipts");
      const skipped = new Set(Array.isArray(artifact.validationNotRequiredLaneIds) ? artifact.validationNotRequiredLaneIds.map(String) : []);
      const eligibleLaneIds = historical ? frozenApprovedLaneIds(checkpoint) : approvedLaneIds(checkpoint);
      for (const receipt of receipts) {
        const laneId = asNonEmptyString(receipt.laneId, "S50.receipt.laneId");
        if (!eligibleLaneIds.includes(laneId)) fail(`S50 receipt targets unapproved lane ${laneId}`);
        if (!["PASS", "FAIL", "SKIP"].includes(receipt.result)) fail("S50 result must be PASS, FAIL, or SKIP");
        asNonEmptyString(receipt.command, "S50.receipt.command");
        asNonEmptyString(receipt.outputRef, "S50.receipt.outputRef");
      }
      for (const laneId of eligibleLaneIds) {
        if (!skipped.has(laneId) && !receipts.some((receipt) => receipt.laneId === laneId)) fail(`S50 missing validation receipt for ${laneId}`);
      }
      break;
    }
    case "S60": {
      const prs = asArray(artifact.prs, "S60.prs");
      const noPr = new Set(Array.isArray(artifact.noPullRequestRequiredLaneIds) ? artifact.noPullRequestRequiredLaneIds.map(String) : []);
      const eligibleLaneIds = historical ? frozenApprovedLaneIds(checkpoint) : approvedLaneIds(checkpoint);
      const covered: string[] = [];
      for (const pr of prs) {
        const laneIds = asArray(pr.laneIds, "S60.pr.laneIds").map(String);
        covered.push(...laneIds);
        if (laneIds.some((laneId) => !eligibleLaneIds.includes(laneId))) fail("S60 PR targets an unapproved lane");
        asNonEmptyString(pr.url, "S60.pr.url");
        asNonEmptyString(pr.headSha, "S60.pr.headSha");
        asNonEmptyString(pr.idempotencyKey, "S60.pr.idempotencyKey");
      }
      if (new Set(covered).size !== covered.length) fail("S60 PR lane coverage must be unique");
      for (const laneId of eligibleLaneIds) {
        if (!noPr.has(laneId) && !covered.includes(laneId)) fail(`S60 missing PR receipt for ${laneId}`);
      }
      break;
    }
    case "S70": {
      const decisions = asArray(artifact.decisions, "S70.decisions");
      requireExactKeys(expectedPullRequestKeys(checkpoint), decisions.map((decision) => String(decision.pr)), "S70 decisions");
      for (const decision of decisions) {
        if (!["SELF", "INDEPENDENT", "MULTI_AGENT"].includes(decision.mode)) fail("S70 review mode is invalid");
        if (!["APPROVE", "CHANGES", "FOLLOW_UP"].includes(decision.verdict)) fail("S70 verdict is invalid");
        asArray(decision.findings, "S70.decision.findings");
        const risk = typeof decision.risk === "string" ? decision.risk : "low";
        const minimum = RISK_MINIMUM[risk] || "INDEPENDENT";
        if (REVIEW_RANK[decision.mode as ReviewMode] < REVIEW_RANK[minimum]) fail(`S70 ${risk} risk requires ${minimum}`);
      }
      break;
    }
    case "S80": {
      const gates = asArray(artifact.gates, "S80.gates");
      requireExactKeys(expectedPullRequestKeys(checkpoint), gates.map((gate) => String(gate.pr)), "S80 gates");
      for (const gate of gates) {
        if (!["PASS", "FAIL", "PENDING"].includes(gate.checks)) fail("S80 checks is invalid");
        for (const key of ["mergeable", "baseCurrent", "blockingFeedback"]) {
          if (typeof gate[key] !== "boolean") fail(`S80.${key} must be boolean`);
        }
      }
      break;
    }
    case "S90": {
      if (!["VERIFIED", "NOT_REQUIRED", "AMBIGUOUS"].includes(artifact.releaseState)) fail("S90 releaseState is invalid");
      const merges = asArray(artifact.merges, "S90.merges");
      requireExactKeys(expectedPullRequestKeys(checkpoint), merges.map((merge) => String(merge.pr)), "S90 merges");
      asArray(artifact.releases, "S90.releases");
      if (artifact.releaseState === "AMBIGUOUS") asNonEmptyString(artifact.ambiguity, "S90.ambiguity");
      break;
    }
    case "S100":
      asNonEmptyString(artifact.pollId, "S100.pollId");
      asNonEmptyString(artifact.idempotencyKey, "S100.idempotencyKey");
      requireLaneSet(checkpoint, asArray(artifact.lanes, "S100.lanes"), "S100.lanes");
      for (const lane of artifact.lanes) {
        if (!["MERGED", "CURRENT", "HELD", "EXCLUDED", "BLOCKED"].includes(lane.disposition)) fail("S100 disposition is invalid");
        asNonEmptyString(lane.ownerNextAction, "S100.ownerNextAction");
        const source = laneById(checkpoint, lane.laneId);
        if (source.classification === "HOLD" && lane.disposition !== "HELD") fail(`${source.laneId} must remain HELD`);
        if (source.classification === "EXCLUDE" && lane.disposition !== "EXCLUDED") fail(`${source.laneId} must remain EXCLUDED`);
      }
      break;
    case "S110": {
      const queue = asObject(artifact.decisionQueue, "S110.decisionQueue");
      for (const key of ["readyToMerge", "needsReview", "needsFollowUp", "heldExcluded", "shipped"]) asArray(queue[key], `S110.${key}`);
      asArray(artifact.receipts, "S110.receipts");
      asArray(artifact.unresolved, "S110.unresolved");
      asNonEmptyString(artifact.nextRunCheckpoint, "S110.nextRunCheckpoint");
      break;
    }
  }
  return artifact;
}

export function assertLegalTransition(workflow: WorkflowDefinition, from: StageId, to: StageId): void {
  if (!stageDefinition(workflow, from).transitions.includes(to)) fail(`Illegal transition ${from} -> ${to}`);
}

export function assertRetryBudget(workflow: WorkflowDefinition, stage: StageId, usedRetries: number): void {
  if (workflow.retryPolicy.stopAfterRepeatedBlocker && usedRetries >= workflow.retryPolicy.maxStageRetries) {
    fail(`${stage} exceeded maximum ${workflow.retryPolicy.maxStageRetries} recovery loops`);
  }
}

export function assertAdvanceGate(checkpoint: Checkpoint, from: StageId, to: StageId): void {
  const attempt = latestAttempt(checkpoint, from) || fail(`${from} cannot advance without its typed output`);
  if (attempt.epoch < checkpoint.loopEpoch) fail(`${from} requires a fresh typed output for loop epoch ${checkpoint.loopEpoch}`);
  const artifact = attempt.artifact;
  if (from === "S20" && checkpoint.lanes.some((lane) => lane.classification === "UNCLASSIFIED")) fail("S20 has unclassified lanes");
  if (from === "S50" && asArray(artifact.receipts, "S50.receipts").some((receipt) => receipt.result === "FAIL" && approvedLaneIds(checkpoint).includes(receipt.laneId))) fail("S50 has failing validation");
  if (from === "S70") {
    const changes = asArray(artifact.decisions, "S70.decisions").some((decision) => decision.verdict === "CHANGES");
    if (changes && !["S40", "S50"].includes(to)) fail("S70 changes must loop to S40 or S50");
    if (!changes && ["S40", "S50"].includes(to)) return;
    if (!changes && to !== "S80") fail("S70 approved review must advance to S80");
  }
  if (from === "S80") {
    const green = asArray(artifact.gates, "S80.gates").every((gate) => gate.checks === "PASS" && gate.mergeable && gate.baseCurrent && !gate.blockingFeedback);
    if (!green && !["S40", "S50"].includes(to)) fail("S80 failures must loop to S40 or S50");
    if (green && to !== "S90") fail("S80 green gate must advance to S90");
  }
  if (from === "S90" && artifact.releaseState === "AMBIGUOUS") fail(`S90 stopped: ${artifact.ambiguity}`);
}

export function completionDecisionQueue(checkpoint: Checkpoint): JsonObject {
  const shipped = new Set<string>();
  for (const receipt of checkpoint.receipts.filter((item) => item.kind === "merge")) {
    for (const laneId of asArray(receipt.data.laneIds, `${receipt.receiptId}.data.laneIds`)) shipped.add(String(laneId));
  }
  return {
    readyToMerge: checkpoint.lanes
      .filter((lane) => lane.classification === "READY" && !shipped.has(lane.laneId))
      .map((lane) => lane.laneId),
    needsReview: [],
    needsFollowUp: checkpoint.lanes.filter((lane) => lane.classification === "BLOCK").map((lane) => lane.laneId),
    heldExcluded: checkpoint.lanes.filter((lane) => ["HOLD", "EXCLUDE"].includes(lane.classification)).map((lane) => lane.laneId),
    shipped: checkpoint.lanes.filter((lane) => shipped.has(lane.laneId)).map((lane) => lane.laneId),
  };
}

function validateCheckpoint(workflow: WorkflowDefinition, checkpoint: Checkpoint): void {
  if (checkpoint.schemaVersion !== 1) fail("Checkpoint schemaVersion must be 1");
  if (checkpoint.workflowVersion !== workflow.version) fail("Checkpoint workflow version mismatch");
  if (!isStageId(checkpoint.currentStage)) fail(`Invalid checkpoint stage ${checkpoint.currentStage}`);
  if (!Number.isInteger(checkpoint.loopEpoch) || checkpoint.loopEpoch < 0) fail("Checkpoint loopEpoch must be a non-negative integer");
  if (!checkpoint.runId || !checkpoint.idempotencyKey.startsWith("sha256:")) fail("Checkpoint IDs are invalid");
  if (
    !checkpoint.lock
    || typeof checkpoint.lock.key !== "string"
    || !checkpoint.lock.key.startsWith("sha256:")
    || typeof checkpoint.lock.token !== "string"
    || !checkpoint.lock.token
    || !["active", "released"].includes(checkpoint.lock.status)
    || !Number.isFinite(Date.parse(checkpoint.lock.acquiredAt))
    || !Number.isFinite(Date.parse(checkpoint.lock.expiresAt))
    || (checkpoint.lock.releasedAt !== null && !Number.isFinite(Date.parse(checkpoint.lock.releasedAt)))
  ) {
    fail("Checkpoint lock is malformed");
  }
  const laneIds = new Set<string>();
  for (const lane of checkpoint.lanes) {
    if (laneIds.has(lane.laneId)) fail(`Duplicate lane ${lane.laneId}`);
    laneIds.add(lane.laneId);
    if (!["UNCLASSIFIED", "READY", "HOLD", "BLOCK", "EXCLUDE"].includes(lane.classification)) fail(`Invalid lane classification ${lane.classification}`);
    if (["HOLD", "BLOCK", "EXCLUDE"].includes(lane.classification) && !lane.quarantined) fail(`${lane.laneId} must be quarantined`);
  }
  const receiptKeys = new Set<string>();
  for (const receipt of checkpoint.receipts) {
    if (receiptKeys.has(receipt.idempotencyKey)) fail(`Duplicate receipt key ${receipt.idempotencyKey}`);
    receiptKeys.add(receipt.idempotencyKey);
  }
  for (const [stage, attempts] of Object.entries(checkpoint.outputs)) {
    if (!isStageId(stage)) fail(`Unknown output stage ${stage}`);
    for (let index = 0; index < (attempts || []).length; index += 1) {
      const attempt = attempts![index]!;
      if (!Number.isInteger(attempt.epoch) || attempt.epoch < 0) fail(`${stage} attempt epoch is invalid`);
      if (attempt.attempt !== index + 1) fail(`${stage} attempt numbering is invalid`);
      if (typeof attempt.hash !== "string" || !attempt.hash.startsWith("sha256:")) fail(`${stage} stored output hash is invalid`);
      if (attempt.artifact?.type !== stageDefinition(workflow, stage).outputType) fail(`${stage} stored output type is invalid`);
    }
  }
}

function baselineSnapshot(repo: Checkpoint["repo"], lockKey: string): JsonObject {
  const headSha = runGit(repo.root, ["rev-parse", "HEAD"]);
  const originMainSha = runGit(repo.root, ["rev-parse", "origin/main"]);
  const status = runGit(repo.root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const worktrees = runGit(repo.root, ["worktree", "list", "--porcelain"]);
  return {
    type: "BaselineSnapshot",
    capturedAt: nowIso(),
    repoRoot: repo.root,
    remoteUrl: repo.remoteUrl,
    branch: runGit(repo.root, ["symbolic-ref", "--short", "-q", "HEAD"], true) || "DETACHED",
    headSha,
    originMainSha,
    statusPorcelainHash: `sha256:${sha256(status)}`,
    worktreeListHash: `sha256:${sha256(worktrees)}`,
    lockKey,
  };
}

function checkpointPath(stateRoot: string, runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) fail(`Invalid run id ${runId}`);
  return join(stateRoot, "runs", runId, "checkpoint.json");
}

function loadCheckpoint(path: string, workflow: WorkflowDefinition): Checkpoint {
  try {
    const checkpoint = readJson(path) as Checkpoint;
    checkpoint.loopEpoch ??= 0;
    for (const attempts of Object.values(checkpoint.outputs || {})) {
      for (const attempt of attempts || []) attempt.epoch ??= 0;
    }
    validateCheckpoint(workflow, checkpoint);
    return checkpoint;
  } catch (error) {
    fail(`Invalid checkpoint ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function checkpointPaths(stateRoot: string, repoHash: string): string[] {
  const runsRoot = join(stateRoot, "runs");
  if (!existsSync(runsRoot)) return [];
  return readdirSync(runsRoot)
    .filter((entry) => RUN_ID_PATTERN.test(entry) && entry.endsWith(`-${repoHash}`))
    .map((entry) => checkpointPath(stateRoot, entry))
    .filter(existsSync);
}

function findIncompleteCheckpoint(stateRoot: string, repo: Checkpoint["repo"], workflow: WorkflowDefinition): { path: string; checkpoint: Checkpoint } | null {
  const candidates: Array<{ path: string; checkpoint: Checkpoint }> = [];
  for (const path of checkpointPaths(stateRoot, repo.repoHash)) {
    const checkpoint = loadCheckpoint(path, workflow);
    if (checkpoint.repo.identity === repo.identity && !checkpoint.completedAt) candidates.push({ path, checkpoint });
  }
  candidates.sort((left, right) => right.checkpoint.updatedAt.localeCompare(left.checkpoint.updatedAt));
  return candidates[0] || null;
}

function lockPath(stateRoot: string, repoHash: string): string {
  return join(stateRoot, "locks", `${repoHash}.json`);
}

function readPersistedLock(path: string, checkpoint: Checkpoint): JsonObject {
  const lock = readJson(path);
  if (
    typeof lock.key !== "string"
    || lock.key !== checkpoint.lock.key
    || typeof lock.token !== "string"
    || !lock.token
    || !["active", "released"].includes(lock.status)
    || typeof lock.runId !== "string"
    || !RUN_ID_PATTERN.test(lock.runId)
    || lock.repoIdentity !== checkpoint.repo.identity
    || !Number.isFinite(Date.parse(lock.acquiredAt))
    || !Number.isFinite(Date.parse(lock.expiresAt))
    || (lock.releasedAt !== null && !Number.isFinite(Date.parse(lock.releasedAt)))
  ) {
    fail(`Release train lock is malformed: ${path}`);
  }
  return lock;
}

function withLockGuard<T>(stateRoot: string, checkpoint: Checkpoint, operation: () => T): T {
  const path = `${lockPath(stateRoot, checkpoint.repo.repoHash)}.guard`;
  mkdirSync(dirname(path), { recursive: true });
  const guardToken = randomUUID();
  const payload = `${JSON.stringify({ guardToken, runId: checkpoint.runId, pid: process.pid, createdAt: nowIso() })}\n`;
  let descriptor = -1;
  try {
    descriptor = openSync(path, "wx", 0o600);
  } catch {
    let existing: JsonObject;
    try {
      existing = asObject(JSON.parse(readFileSync(path, "utf8")), "release train lock guard");
    } catch {
      fail(`Release train lock guard is malformed: ${path}`);
    }
    const ownerPid = existing.pid;
    if (!Number.isInteger(ownerPid) || ownerPid <= 0) fail(`Release train lock guard is malformed: ${path}`);
    let ownerAlive = true;
    try {
      process.kill(ownerPid, 0);
    } catch (error) {
      ownerAlive = (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
    if (ownerAlive) fail(`Release train lock update already in progress for ${checkpoint.repo.identity}`);
    const stalePath = `${path}.stale.${guardToken}`;
    try {
      renameSync(path, stalePath);
      unlinkSync(stalePath);
      descriptor = openSync(path, "wx", 0o600);
    } catch {
      fail(`Release train lock guard changed during stale-owner recovery: ${path}`);
    }
  }
  try {
    writeFileSync(descriptor, payload, "utf8");
    closeSync(descriptor);
    descriptor = -1;
    return operation();
  } finally {
    if (descriptor >= 0) closeSync(descriptor);
    if (existsSync(path) && readFileSync(path, "utf8") === payload) unlinkSync(path);
  }
}

function acquireLockUnguarded(stateRoot: string, checkpoint: Checkpoint): void {
  const path = lockPath(stateRoot, checkpoint.repo.repoHash);
  if (existsSync(path)) {
    const existing = readPersistedLock(path, checkpoint);
    const expired = typeof existing.expiresAt === "string" && Date.parse(existing.expiresAt) <= Date.now();
    const sameRun = existing.runId === checkpoint.runId;
    if (existing.status === "active" && !expired && !sameRun) fail(`Release train lock held by ${existing.runId} until ${existing.expiresAt}`);
    if (sameRun && existing.token !== checkpoint.lock.token) fail(`Release train lock token conflict for ${checkpoint.runId}`);
  }
  checkpoint.lock.status = "active";
  checkpoint.lock.expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  atomicWriteJson(path, { ...checkpoint.lock, runId: checkpoint.runId, repoIdentity: checkpoint.repo.identity });
}

export function persistCheckpointWithLock(
  stateRoot: string,
  checkpointPathValue: string,
  workflow: WorkflowDefinition,
  candidate: Checkpoint,
): Checkpoint {
  return withLockGuard(stateRoot, candidate, () => {
    const checkpoint = existsSync(checkpointPathValue)
      ? loadCheckpoint(checkpointPathValue, workflow)
      : candidate;
    if (checkpoint.runId !== candidate.runId || checkpoint.repo.identity !== candidate.repo.identity) {
      fail(`Checkpoint changed identity while resuming ${candidate.runId}`);
    }
    if (checkpoint.completedAt) fail(`Checkpoint ${checkpoint.runId} completed while resuming; rerun init`);
    acquireLockUnguarded(stateRoot, checkpoint);
    persist(checkpointPathValue, checkpoint);
    return checkpoint;
  });
}

function withCheckpointWrite<T>(
  stateRoot: string,
  checkpointPathValue: string,
  workflow: WorkflowDefinition,
  checkpoint: Checkpoint,
  operation: (target: Checkpoint) => T,
): T {
  return withLockGuard(stateRoot, checkpoint, () => {
    const current = loadCheckpoint(checkpointPathValue, workflow);
    if (stableKey(JSON.stringify(current)) !== stableKey(JSON.stringify(checkpoint))) {
      fail(`Checkpoint changed while preparing ${checkpoint.runId}; reload and retry`);
    }
    const path = lockPath(stateRoot, checkpoint.repo.repoHash);
    if (!existsSync(path)) fail("Release train lock is missing; run init --write to reacquire it");
    const lock = readPersistedLock(path, checkpoint);
    if (
      lock.status !== "active"
      || lock.runId !== checkpoint.runId
      || lock.token !== checkpoint.lock.token
    ) {
      fail(`Release train lock is not owned by ${checkpoint.runId}; run init --write to reacquire it`);
    }

    const result = operation(checkpoint);
    if (checkpoint.lock.status === "active") {
      if (Date.parse(lock.expiresAt) <= Date.now()) {
        checkpoint.lock.expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
        atomicWriteJson(path, { ...checkpoint.lock, runId: checkpoint.runId, repoIdentity: checkpoint.repo.identity });
      } else {
        checkpoint.lock.expiresAt = lock.expiresAt;
      }
      persist(checkpointPathValue, checkpoint);
    } else {
      persist(checkpointPathValue, checkpoint);
      atomicWriteJson(path, { ...checkpoint.lock, runId: checkpoint.runId, repoIdentity: checkpoint.repo.identity });
    }
    return result;
  });
}

function createCheckpoint(workflow: WorkflowDefinition, repo: Checkpoint["repo"], runId: string): Checkpoint {
  if (!RUN_ID_PATTERN.test(runId)) fail(`Invalid run id ${runId}`);
  const createdAt = nowIso();
  const lockKey = stableKey(repo.identity, "lock");
  const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const checkpoint: Checkpoint = {
    schemaVersion: 1,
    workflowVersion: workflow.version,
    runId,
    idempotencyKey: stableKey(repo.identity, runId),
    createdAt,
    updatedAt: createdAt,
    completedAt: null,
    repo,
    lock: { key: lockKey, token: randomUUID(), status: "active", acquiredAt: createdAt, expiresAt, releasedAt: null },
    currentStage: "S00",
    loopEpoch: 0,
    stageHistory: [{ from: null, to: "S00", at: createdAt, reason: "initialized" }],
    inputs: { cycleKey: runId.split("-").slice(1, 3).join("-"), workflowPath: WORKFLOW_PATH },
    outputs: {},
    decisions: [],
    receipts: [],
    retryCount: {},
    lanes: [],
    blockers: [],
    exclusions: [],
  };
  const artifact = validateStageArtifact(workflow, checkpoint, "S00", baselineSnapshot(repo, lockKey));
  checkpoint.outputs.S00 = [{ attempt: 1, epoch: 0, hash: stableKey(JSON.stringify(artifact)), recordedAt: createdAt, artifact }];
  return checkpoint;
}

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Map<string, string[]>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const next = rest[index + 1];
    const flagValue = !next || next.startsWith("--") ? "true" : (index += 1, next);
    flags.set(value.slice(2), [...(flags.get(value.slice(2)) || []), flagValue]);
  }
  return { command, positional, flags };
}

function flag(args: ParsedArgs, name: string): string | undefined {
  return args.flags.get(name)?.at(-1);
}

function requireFlag(args: ParsedArgs, name: string): string {
  return flag(args, name) || fail(`--${name} is required`);
}

function writeEnabled(args: ParsedArgs): boolean {
  return flag(args, "write") === "true";
}

function selectedCheckpoint(
  args: ParsedArgs,
  workflow: WorkflowDefinition,
  repo: Checkpoint["repo"],
  stateRoot: string,
): { path: string; checkpoint: Checkpoint } {
  const explicitRunId = flag(args, "run-id");
  if (explicitRunId) {
    const path = checkpointPath(stateRoot, explicitRunId);
    if (!existsSync(path)) fail(`Checkpoint not found: ${path}`);
    return { path, checkpoint: loadCheckpoint(path, workflow) };
  }
  const incomplete = findIncompleteCheckpoint(stateRoot, repo, workflow);
  if (incomplete) return incomplete;
  const runId = `rt-${cycleKey(new Date(), workflow.timezone)}-${repo.repoHash}`;
  const path = checkpointPath(stateRoot, runId);
  if (!existsSync(path)) fail(`No checkpoint found. Preview or create it with init.`);
  return { path, checkpoint: loadCheckpoint(path, workflow) };
}

function persist(path: string, checkpoint: Checkpoint): void {
  checkpoint.updatedAt = nowIso();
  atomicWriteJson(path, checkpoint);
}

function recordStage(workflow: WorkflowDefinition, checkpoint: Checkpoint, stageId: StageId, rawArtifact: unknown): { changed: boolean; artifact: JsonObject } {
  if (checkpoint.currentStage !== stageId) fail(`Current stage is ${checkpoint.currentStage}; cannot record ${stageId}`);
  const artifact = validateStageArtifact(workflow, checkpoint, stageId, rawArtifact);
  const hash = stableKey(JSON.stringify(artifact));
  const attempts = checkpoint.outputs[stageId] || [];
  if (attempts.at(-1)?.hash === hash && attempts.at(-1)?.epoch === checkpoint.loopEpoch) return { changed: false, artifact };
  if (attempts.length >= workflow.retryPolicy.maxArtifactAttempts) fail(`${stageId} exceeded maximum ${workflow.retryPolicy.maxArtifactAttempts} artifact attempts`);
  attempts.push({ attempt: attempts.length + 1, epoch: checkpoint.loopEpoch, hash, recordedAt: nowIso(), artifact });
  checkpoint.outputs[stageId] = attempts;

  if (stageId === "S10") checkpoint.lanes = structuredClone(artifact.lanes) as LaneRecord[];
  if (stageId === "S20") {
    for (const entry of artifact.lanes) {
      const lane = laneById(checkpoint, entry.laneId);
      lane.classification = entry.classification;
      lane.quarantined = entry.classification !== "READY"
        && (entry.classification !== "BLOCK" || workflow.retryPolicy.quarantineLaneOnBlock);
      lane.reason = entry.reason;
      lane.responseRef = typeof entry.responseRef === "string" ? entry.responseRef : null;
      lane.ownerAuthorization = typeof entry.ownerAuthorization === "string" ? entry.ownerAuthorization : null;
      if (entry.classification === "EXCLUDE" && !checkpoint.exclusions.some((item) => item.laneId === lane.laneId && item.reason === lane.reason)) {
        checkpoint.exclusions.push({ laneId: lane.laneId, reason: lane.reason || "excluded", at: nowIso() });
      }
      if (entry.classification === "BLOCK" && !checkpoint.blockers.some((item) => item.stage === "S20" && item.laneId === lane.laneId && item.reason === lane.reason)) {
        checkpoint.blockers.push({ stage: "S20", laneId: lane.laneId, reason: lane.reason || "blocked", at: nowIso() });
      }
    }
  }
  if (["S30", "S70", "S90"].includes(stageId)) checkpoint.decisions.push({ stage: stageId, at: nowIso(), artifact });
  if (stageId === "S90" && artifact.releaseState === "AMBIGUOUS"
    && !checkpoint.blockers.some((item) => item.stage === "S90" && item.laneId === null && item.reason === artifact.ambiguity)) {
    checkpoint.blockers.push({ stage: "S90", laneId: null, reason: artifact.ambiguity, at: nowIso() });
  }
  return { changed: true, artifact };
}

function recordReceipt(workflow: WorkflowDefinition, checkpoint: Checkpoint, input: {
  kind: string; laneId: string | null; target: string; externalId: string; url: string | null; data: JsonObject;
}, historicalReceipts: ReceiptRecord[] = []): { changed: boolean; reused: boolean; receipt: ReceiptRecord } {
  const legalStages = workflow.operationGates[input.kind];
  if (!legalStages) fail(`Unknown receipt kind ${input.kind}`);
  if (!legalStages.includes(checkpoint.currentStage)) fail(`${input.kind} receipt is illegal at ${checkpoint.currentStage}; expected ${legalStages.join(" or ")}`);
  const lane = input.laneId ? laneById(checkpoint, input.laneId) : null;
  if (["owner_poll", "convergence_poll", "commit", "push", "pr_open", "pr_update", "rebase"].includes(input.kind) && !lane) {
    fail(`${input.kind} receipt requires --lane`);
  }
  if (["merge", "tag", "release"].includes(input.kind)) {
    const laneIds = asArray(input.data.laneIds, `${input.kind}.data.laneIds`).map(String);
    if (!laneIds.length) fail(`${input.kind} receipt requires data.laneIds`);
    for (const laneId of laneIds) {
      if (laneById(checkpoint, laneId).classification !== "READY") fail(`${input.kind} forbidden for ${laneId}`);
    }
  }
  if (lane && workflow.mutationReceiptKinds.includes(input.kind) && lane.classification !== "READY") {
    fail(`${input.kind} forbidden for ${lane.laneId} (${lane.classification})`);
  }
  const idempotencyKey = computeReceiptIdempotencyKey(checkpoint.repo.identity, input.kind, input.laneId, input.target);
  const current = checkpoint.receipts.find((receipt) => receipt.idempotencyKey === idempotencyKey);
  if (current) {
    if (current.externalId !== input.externalId) fail(`Idempotency conflict for ${input.kind} ${input.target}`);
    return { changed: false, reused: false, receipt: current };
  }
  const historical = historicalReceipts.find((receipt) => receipt.idempotencyKey === idempotencyKey);
  if (historical) {
    if (historical.externalId !== input.externalId) fail(`Idempotency conflict for ${input.kind} ${input.target}`);
    const reused = {
      ...historical,
      stage: checkpoint.currentStage,
      recordedAt: nowIso(),
      data: { ...historical.data, reusedFromReceiptId: historical.receiptId },
    };
    checkpoint.receipts.push(reused);
    return { changed: true, reused: true, receipt: reused };
  }
  const receipt: ReceiptRecord = {
    receiptId: `receipt-${sha256(idempotencyKey).slice(0, 16)}`,
    idempotencyKey,
    kind: input.kind,
    stage: checkpoint.currentStage,
    laneId: input.laneId,
    target: input.target,
    externalId: input.externalId,
    url: input.url,
    recordedAt: nowIso(),
    data: input.data,
  };
  checkpoint.receipts.push(receipt);
  return { changed: true, reused: false, receipt };
}

function renderLedger(checkpoint: Checkpoint): string {
  const lines = [
    `# Release train ${checkpoint.runId}`,
    "",
    `Stage: ${checkpoint.currentStage}${checkpoint.completedAt ? " (complete)" : ""}`,
    `Baseline: ${latestOutput(checkpoint, "S00")?.originMainSha || "missing"}`,
    `Updated: ${checkpoint.updatedAt}`,
    "",
    "| Lane | Owner | Checkout | Branch | HEAD | Class | Reason |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const lane of checkpoint.lanes) {
    lines.push(`| ${lane.laneId} | ${lane.owner} | ${lane.checkout} | ${lane.branch} | ${lane.headSha.slice(0, 12)} | ${lane.classification} | ${lane.reason || ""} |`);
  }
  lines.push("", `Receipts: ${checkpoint.receipts.length}`, `Blockers: ${checkpoint.blockers.length}`, `Exclusions: ${checkpoint.exclusions.length}`);
  return lines.join("\n");
}

function quarantineLane(checkpoint: Checkpoint, laneId: string, reason: string): { changed: boolean; lane: LaneRecord } {
  const lane = laneById(checkpoint, laneId);
  if (["HOLD", "EXCLUDE"].includes(lane.classification)) fail(`${laneId} is owner-controlled ${lane.classification} and cannot be reclassified`);
  if (lane.classification === "BLOCK" && lane.reason === reason) return { changed: false, lane };
  if (lane.classification !== "READY") fail(`${laneId} cannot be quarantined from ${lane.classification}`);
  lane.classification = "BLOCK";
  lane.quarantined = true;
  lane.reason = reason;
  if (!checkpoint.blockers.some((blocker) => blocker.laneId === laneId && blocker.reason === reason)) {
    checkpoint.blockers.push({ stage: checkpoint.currentStage, laneId, reason, at: nowIso() });
  }
  return { changed: true, lane };
}

function discover(repo: Checkpoint["repo"]): JsonObject {
  const raw = runGit(repo.root, ["worktree", "list", "--porcelain"]);
  const paths = raw.split("\n").filter((line) => line.startsWith("worktree ")).map((line) => line.slice("worktree ".length));
  const lanes = paths.filter(existsSync).map((checkout) => {
    const branch = runGit(checkout, ["symbolic-ref", "--short", "-q", "HEAD"], true) || "DETACHED";
    const headSha = runGit(checkout, ["rev-parse", "HEAD"]);
    const status = runGit(checkout, ["status", "--porcelain=v1", "--untracked-files=all"]);
    const counts = runGit(checkout, ["rev-list", "--left-right", "--count", "origin/main...HEAD"], true) || "unknown";
    return {
      laneId: computeLaneId(repo.identity, checkout, branch),
      workItemId: null,
      owner: "unknown",
      checkout,
      branch,
      headSha,
      commits: runGit(checkout, ["log", "--format=%H", "origin/main..HEAD"], true).split("\n").filter(Boolean),
      pr: null,
      status: `dirty=${status ? status.split("\n").length : 0}; origin-main-counts=${counts}`,
      blocker: null,
    };
  });
  return { type: "SourceOwnershipLedger", discoveredAt: nowIso(), lanes };
}

const HELP = `OpenScout release train runner (read-only unless --write)

Commands:
  validate                     Validate workflow/schema and selected checkpoint if present.
  init [--write]               Resume incomplete run or preview/create the current slot checkpoint.
  status                       Print selected checkpoint JSON.
  ledger                       Render the selected checkpoint as Markdown.
  next                         Show the current typed output and legal transitions.
  discover                     Render a read-only SourceOwnershipLedger starter artifact.
  record-stage --stage Sxx --artifact /abs/file.json [--write]
  advance --to Sxx [--reason text] [--write]
  receipt --kind kind [--lane id] --target stable-target --external-id receipt [--url url] [--data file.json] [--write]
  quarantine --lane id --reason text [--write]
  stop --reason text [--write]      Write terminal S110 unresolved output and release the lock.
  complete [--write]           Validate S110, mark complete, and release the local lock.

Shared flags:
  --checkout /absolute/repo    Defaults to cwd.
  --state-dir /absolute/path   Defaults to ~/.openscout/control-plane/release-train.
  --run-id rt-...              Select an exact checkpoint.

The runner records gates and receipts only. It never runs git/GitHub/release mutations.`;

export async function runCli(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (["help", "--help", "-h"].includes(args.command)) {
    console.log(HELP);
    return 0;
  }
  const workflow = loadWorkflow();
  validateWorkflowDefinition(workflow);
  const repo = repoContext(flag(args, "checkout") || process.cwd());
  const stateRoot = resolve(flag(args, "state-dir") || defaultStateRoot());

  if (args.command === "validate") {
    const explicitRunId = flag(args, "run-id");
    const incomplete = explicitRunId
      ? (existsSync(checkpointPath(stateRoot, explicitRunId)) ? { path: checkpointPath(stateRoot, explicitRunId), checkpoint: loadCheckpoint(checkpointPath(stateRoot, explicitRunId), workflow) } : null)
      : (() => {
        for (const path of checkpointPaths(stateRoot, repo.repoHash)) loadCheckpoint(path, workflow);
        return findIncompleteCheckpoint(stateRoot, repo, workflow);
      })();
    console.log(JSON.stringify({ ok: true, workflow: workflow.id, version: workflow.version, checkpoint: incomplete?.path || null }, null, 2));
    return 0;
  }

  if (args.command === "discover") {
    console.log(JSON.stringify(discover(repo), null, 2));
    return 0;
  }

  if (args.command === "init") {
    const incomplete = findIncompleteCheckpoint(stateRoot, repo, workflow);
    if (incomplete) {
      if (writeEnabled(args)) {
        incomplete.checkpoint = persistCheckpointWithLock(stateRoot, incomplete.path, workflow, incomplete.checkpoint);
      }
      console.log(JSON.stringify({ action: writeEnabled(args) ? "resumed" : "resume", write: writeEnabled(args), checkpointPath: incomplete.path, checkpoint: incomplete.checkpoint }, null, 2));
      return 0;
    }
    const runId = flag(args, "run-id") || `rt-${cycleKey(new Date(), workflow.timezone)}-${repo.repoHash}`;
    const path = checkpointPath(stateRoot, runId);
    if (existsSync(path)) {
      const checkpoint = loadCheckpoint(path, workflow);
      console.log(JSON.stringify({ action: "resume", write: false, checkpointPath: path, checkpoint }, null, 2));
      return 0;
    }
    const checkpoint = createCheckpoint(workflow, repo, runId);
    if (!writeEnabled(args)) {
      console.log(JSON.stringify({ action: "would_create", write: false, checkpointPath: path, checkpoint }, null, 2));
      return 0;
    }
    const persistedCheckpoint = persistCheckpointWithLock(stateRoot, path, workflow, checkpoint);
    console.log(JSON.stringify({ action: "created", write: true, checkpointPath: path, checkpoint: persistedCheckpoint }, null, 2));
    return 0;
  }

  const selected = selectedCheckpoint(args, workflow, repo, stateRoot);
  const checkpoint = selected.checkpoint;
  const writeCheckpoint = <T>(operation: (target: Checkpoint) => T): T =>
    withCheckpointWrite(stateRoot, selected.path, workflow, checkpoint, operation);

  if (args.command === "status") {
    console.log(JSON.stringify({ checkpointPath: selected.path, checkpoint }, null, 2));
    return 0;
  }
  if (args.command === "ledger") {
    console.log(renderLedger(checkpoint));
    return 0;
  }
  if (args.command === "next") {
    const stage = stageDefinition(workflow, checkpoint.currentStage);
    console.log(JSON.stringify({ runId: checkpoint.runId, stage, hasRequiredOutput: Boolean(latestOutput(checkpoint, checkpoint.currentStage)), ciPollIntervalSeconds: workflow.retryPolicy.ciPollIntervalSeconds, readyLanes: checkpoint.lanes.filter((lane) => lane.classification === "READY").map((lane) => lane.laneId), quarantinedLanes: checkpoint.lanes.filter((lane) => lane.quarantined).map((lane) => lane.laneId) }, null, 2));
    return 0;
  }
  if (args.command === "record-stage") {
    const stageValue = requireFlag(args, "stage");
    if (!isStageId(stageValue)) fail(`Invalid --stage ${stageValue}`);
    const artifactPath = resolve(requireFlag(args, "artifact"));
    const stageArtifact = readJson(artifactPath);
    const result = writeEnabled(args)
      ? writeCheckpoint((target) => recordStage(workflow, target, stageValue, stageArtifact))
      : recordStage(workflow, checkpoint, stageValue, stageArtifact);
    console.log(JSON.stringify({ action: result.changed ? (writeEnabled(args) ? "recorded" : "would_record") : "idempotent", write: writeEnabled(args), stage: stageValue, artifact: result.artifact }, null, 2));
    return 0;
  }
  if (args.command === "advance") {
    const toValue = requireFlag(args, "to");
    if (!isStageId(toValue)) fail(`Invalid --to ${toValue}`);
    const advance = (target: Checkpoint): { from: StageId; to: StageId } => {
      const from = target.currentStage;
      assertLegalTransition(workflow, from, toValue);
      assertAdvanceGate(target, from, toValue);
      const recoveryLoop = ["S70", "S80"].includes(from) && ["S40", "S50"].includes(toValue);
      if (recoveryLoop) assertRetryBudget(workflow, from, target.retryCount[from] || 0);
      if (recoveryLoop) {
        const usedRetries = target.retryCount[from] || 0;
        target.retryCount[from] = usedRetries + 1;
        target.loopEpoch += 1;
      }
      target.currentStage = toValue;
      target.stageHistory.push({ from, to: toValue, at: nowIso(), reason: flag(args, "reason") || "gate satisfied" });
      return { from, to: toValue };
    };
    const result = writeEnabled(args) ? writeCheckpoint(advance) : advance(checkpoint);
    if (!writeEnabled(args)) {
      console.log(JSON.stringify({ action: "would_advance", write: false, from: result.from, to: result.to }, null, 2));
      return 0;
    }
    const { from } = result;
    console.log(JSON.stringify({ action: "advanced", write: true, from, to: toValue, checkpointPath: selected.path }, null, 2));
    return 0;
  }
  if (args.command === "stop") {
    const reason = requireFlag(args, "reason");
    if (!workflow.terminalStop.allowedFrom.includes(checkpoint.currentStage)) fail(`Cannot stop from ${checkpoint.currentStage}`);
    const from = checkpoint.currentStage;
    const artifact = validateStageArtifact(workflow, checkpoint, "S110", {
      type: "CompletionReport",
      terminal: true,
      stoppedFrom: from,
      decisionQueue: completionDecisionQueue(checkpoint),
      receipts: checkpoint.receipts.map((receipt) => receipt.receiptId),
      unresolved: [{ stage: from, reason }],
      nextRunCheckpoint: `start a new run after resolving: ${reason}`,
    });
    if (!writeEnabled(args)) {
      console.log(JSON.stringify({ action: "would_stop", write: false, from, artifact }, null, 2));
      return 0;
    }
    writeCheckpoint((target) => {
      target.blockers.push({ stage: from, laneId: null, reason, at: nowIso() });
      target.currentStage = "S110";
      target.stageHistory.push({ from, to: "S110", at: nowIso(), reason: `terminal stop: ${reason}` });
      target.outputs.S110 = [{ attempt: 1, epoch: target.loopEpoch, hash: stableKey(JSON.stringify(artifact)), recordedAt: nowIso(), artifact }];
      target.completedAt = nowIso();
      target.lock.status = "released";
      target.lock.releasedAt = target.completedAt;
    });
    console.log(JSON.stringify({ action: "stopped", write: true, from, runId: checkpoint.runId, checkpointPath: selected.path }, null, 2));
    return 0;
  }
  if (args.command === "receipt") {
    const dataPath = flag(args, "data");
    const historicalReceipts = checkpointPaths(stateRoot, repo.repoHash)
      .map((path) => loadCheckpoint(path, workflow))
      .filter((other) => other.runId !== checkpoint.runId && other.repo.identity === checkpoint.repo.identity)
      .flatMap((other) => other.receipts);
    const receiptInput = {
      kind: requireFlag(args, "kind"),
      laneId: flag(args, "lane") || null,
      target: requireFlag(args, "target"),
      externalId: requireFlag(args, "external-id"),
      url: flag(args, "url") || null,
      data: dataPath ? readJson(resolve(dataPath)) : {},
    };
    const result = writeEnabled(args)
      ? writeCheckpoint((target) => recordReceipt(workflow, target, receiptInput, historicalReceipts))
      : recordReceipt(workflow, checkpoint, receiptInput, historicalReceipts);
    console.log(JSON.stringify({ action: result.reused ? (writeEnabled(args) ? "reused" : "would_reuse") : result.changed ? (writeEnabled(args) ? "recorded" : "would_record") : "idempotent", write: writeEnabled(args), receipt: result.receipt }, null, 2));
    return 0;
  }
  if (args.command === "quarantine") {
    if (!["S30", "S40", "S50", "S60", "S70", "S80", "S90", "S100"].includes(checkpoint.currentStage)) {
      fail(`Cannot quarantine a lane at ${checkpoint.currentStage}`);
    }
    const laneId = requireFlag(args, "lane");
    const reason = requireFlag(args, "reason");
    const result = writeEnabled(args)
      ? writeCheckpoint((target) => quarantineLane(target, laneId, reason))
      : quarantineLane(checkpoint, laneId, reason);
    console.log(JSON.stringify({ action: result.changed ? (writeEnabled(args) ? "quarantined" : "would_quarantine") : "idempotent", write: writeEnabled(args), lane: result.lane }, null, 2));
    return 0;
  }
  if (args.command === "complete") {
    if (checkpoint.currentStage !== "S110") fail(`Cannot complete from ${checkpoint.currentStage}`);
    if (!latestOutput(checkpoint, "S110")) fail("S110 cannot complete without CompletionReport");
    if (!writeEnabled(args)) {
      console.log(JSON.stringify({ action: "would_complete", write: false, runId: checkpoint.runId }, null, 2));
      return 0;
    }
    writeCheckpoint((target) => {
      target.completedAt = nowIso();
      target.lock.status = "released";
      target.lock.releasedAt = target.completedAt;
    });
    console.log(JSON.stringify({ action: "completed", write: true, runId: checkpoint.runId, checkpointPath: selected.path }, null, 2));
    return 0;
  }

  fail(`Unknown command ${args.command}. Run help.`);
}

if (import.meta.main) {
  try {
    process.exitCode = await runCli(process.argv.slice(2));
  } catch (error) {
    console.error(`release-train: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
