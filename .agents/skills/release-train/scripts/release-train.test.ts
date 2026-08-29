import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import {
  STAGE_IDS,
  assertLegalTransition,
  assertRetryBudget,
  completionDecisionQueue,
  computeLaneId,
  computeReceiptIdempotencyKey,
  cycleKey,
  loadWorkflow,
  persistCheckpointWithLock,
  sha256,
  validateWorkflowDefinition,
} from "./release-train";

const SCRIPT = resolve(import.meta.dir, "release-train.ts");
let sandbox = "";
let repo = "";
let state = "";

function shell(command: string, args: string[], cwd = repo): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function runner(command: string, args: string[] = [], succeeds = true, stateRoot = state): { stdout: string; stderr: string; status: number } {
  const result = Bun.spawnSync({
    cmd: [process.execPath, SCRIPT, command, ...args, "--checkout", repo, "--state-dir", stateRoot],
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    status: result.exitCode,
  };
  if (succeeds && output.status !== 0) throw new Error(output.stderr || output.stdout);
  if (!succeeds && output.status === 0) throw new Error(`Expected failure: ${output.stdout}`);
  return output;
}

function artifact(name: string, value: unknown): string {
  const path = join(sandbox, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), "openscout-release-train-test."));
  repo = join(sandbox, "repo");
  state = join(sandbox, "state");
  shell("mkdir", ["-p", repo], sandbox);
  shell("git", ["init", "-b", "main"], repo);
  shell("git", ["config", "user.name", "Release Train Test"], repo);
  shell("git", ["config", "user.email", "release-train@example.invalid"], repo);
  writeFileSync(join(repo, "README.md"), "fixture\n");
  shell("git", ["add", "README.md"], repo);
  shell("git", ["commit", "-m", "🧪 Add release train fixture"], repo);
  shell("git", ["remote", "add", "origin", "https://github.com/arach/openscout.git"], repo);
  shell("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], repo);
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe("release-train workflow", () => {
  test("definition encodes the exact graph and stable IDs", () => {
    const workflow = loadWorkflow();
    expect(() => validateWorkflowDefinition(workflow)).not.toThrow();
    expect(workflow.stages.map((stage) => stage.id)).toEqual([...STAGE_IDS]);
    expect(workflow.stages.find((stage) => stage.id === "S70")?.transitions).toEqual(["S40", "S50", "S80"]);
    expect(workflow.stages.find((stage) => stage.id === "S80")?.transitions).toEqual(["S40", "S50", "S90"]);
    expect(() => assertLegalTransition(workflow, "S70", "S40")).not.toThrow();
    expect(() => assertLegalTransition(workflow, "S70", "S90")).toThrow("Illegal transition");
    expect(() => assertRetryBudget(workflow, "S70", 2)).not.toThrow();
    expect(() => assertRetryBudget(workflow, "S70", 3)).toThrow("recovery loops");
    expect(computeLaneId("repo", "/tmp/work", "branch")).toBe(computeLaneId("repo", "/tmp/work", "branch"));
    expect(computeReceiptIdempotencyKey("repo", "release", null, "v1")).toBe(computeReceiptIdempotencyKey("repo", "release", null, "v1"));
    expect(computeReceiptIdempotencyKey("repo", "pr_open", "lane-a", "head:feature")).toBe(computeReceiptIdempotencyKey("repo", "pr_open", "lane-b", "head:feature"));
    expect(cycleKey(new Date("2026-08-12T14:00:00Z"))).toMatch(/^20260812-(09|17)$/);
  });

  test("dry-run is read-only and the checkpointed state machine fails closed", () => {
    const preview = JSON.parse(runner("init").stdout);
    expect(preview.action).toBe("would_create");
    expect(Bun.file(preview.checkpointPath).size).toBe(0);

    const created = JSON.parse(runner("init", ["--write"]).stdout);
    const checkpointPath = created.checkpointPath as string;
    const runId = created.checkpoint.runId as string;
    expect(JSON.parse(readFileSync(checkpointPath, "utf8")).currentStage).toBe("S00");
    expect(JSON.parse(runner("init", ["--write"]).stdout).action).toBe("resumed");

    runner("advance", ["--to", "S10", "--write", "--run-id", runId]);
    expect(runner("advance", ["--to", "S20", "--write", "--run-id", runId], false).stderr).toContain("typed output");

    const readyLane = computeLaneId("https://github.com/arach/openscout", join(sandbox, "ready"), "codex/ready");
    const holdLane = computeLaneId("https://github.com/arach/openscout", join(sandbox, "hold"), "codex/hold");
    const s10 = artifact("s10.json", {
      type: "SourceOwnershipLedger",
      lanes: [
        { laneId: readyLane, owner: "agent:ready", checkout: join(sandbox, "ready"), branch: "codex/ready", headSha: "a".repeat(40), commits: ["a".repeat(40)], pr: null, status: "clean" },
        { laneId: holdLane, owner: "agent:hold", checkout: join(sandbox, "hold"), branch: "codex/hold", headSha: "b".repeat(40), commits: ["b".repeat(40)], pr: null, status: "clean" },
      ],
    });
    runner("record-stage", ["--stage", "S10", "--artifact", s10, "--write", "--run-id", runId]);
    runner("advance", ["--to", "S20", "--write", "--run-id", runId]);

    const s20 = artifact("s20.json", {
      type: "OwnerClassificationLedger",
      pollId: "poll:20260812-09",
      idempotencyKey: "sha256:poll",
      pollStartedAt: "2026-08-12T13:00:00-04:00",
      deadline: "2026-08-12T13:10:00-04:00",
      lanes: [
        { laneId: readyLane, classification: "READY", reason: "owner approved", responseRef: "flight:ready", ownerAuthorization: "rebase allowed" },
        { laneId: holdLane, classification: "HOLD", reason: "owner requested hold", responseRef: "flight:hold" },
      ],
    });
    runner("record-stage", ["--stage", "S20", "--artifact", s20, "--write", "--run-id", runId]);
    runner("advance", ["--to", "S30", "--write", "--run-id", runId]);

    const s30 = artifact("s30.json", {
      type: "FrozenScopePlan",
      scopeHash: "sha256:scope",
      approvedLaneIds: [readyLane],
      excludedLaneIds: [holdLane],
      commitPlan: [{ laneId: readyLane, outcome: "ship ready lane" }],
      prPlan: [{ laneIds: [readyLane], outcome: "one coherent PR" }],
      releasePlan: { mode: "canonical", target: null, ambiguity: null, risk: "medium" },
    });
    runner("record-stage", ["--stage", "S30", "--artifact", s30, "--write", "--run-id", runId]);
    runner("advance", ["--to", "S40", "--write", "--run-id", runId]);

    expect(runner("receipt", ["--kind", "merge", "--target", "pr:711", "--external-id", "blocked", "--write", "--run-id", runId], false).stderr).toContain("illegal at S40");
    expect(runner("receipt", ["--kind", "commit", "--lane", holdLane, "--target", "head", "--external-id", "blocked", "--write", "--run-id", runId], false).stderr).toContain("forbidden");
    const firstReceipt = JSON.parse(runner("receipt", ["--kind", "commit", "--lane", readyLane, "--target", "head", "--external-id", "c".repeat(40), "--write", "--run-id", runId]).stdout);
    expect(firstReceipt.action).toBe("recorded");
    const duplicate = JSON.parse(runner("receipt", ["--kind", "commit", "--lane", readyLane, "--target", "head", "--external-id", "c".repeat(40), "--write", "--run-id", runId]).stdout);
    expect(duplicate.action).toBe("idempotent");
    expect(runner("receipt", ["--kind", "commit", "--lane", readyLane, "--target", "head", "--external-id", "d".repeat(40), "--write", "--run-id", runId], false).stderr).toContain("Idempotency conflict");

    const s40 = artifact("s40.json", { type: "CommitReceiptSet", receipts: [{ laneId: readyLane, commitSha: "c".repeat(40), subject: "✨ Ready", paths: ["README.md"], authorshipPreserved: true }] });
    runner("record-stage", ["--stage", "S40", "--artifact", s40, "--write", "--run-id", runId]);
    runner("advance", ["--to", "S50", "--write", "--run-id", runId]);

    const s50Fail = artifact("s50-fail.json", { type: "ValidationReceiptSet", receipts: [{ laneId: readyLane, command: "bun test", result: "FAIL", at: "2026-08-12T13:00:00Z", outputRef: "log:fail" }] });
    runner("record-stage", ["--stage", "S50", "--artifact", s50Fail, "--write", "--run-id", runId]);
    expect(runner("advance", ["--to", "S60", "--write", "--run-id", runId], false).stderr).toContain("failing validation");
    const s50Pass = artifact("s50-pass.json", { type: "ValidationReceiptSet", receipts: [{ laneId: readyLane, command: "bun test", result: "PASS", at: "2026-08-12T13:02:00Z", outputRef: "log:pass" }] });
    runner("record-stage", ["--stage", "S50", "--artifact", s50Pass, "--write", "--run-id", runId]);
    runner("advance", ["--to", "S60", "--write", "--run-id", runId]);

    const s60 = artifact("s60.json", { type: "PullRequestReceiptSet", prs: [{ laneIds: [readyLane], number: 711, url: "https://github.com/arach/openscout/pull/711", headSha: "c".repeat(40), base: "main", action: "OPENED", idempotencyKey: "sha256:pr" }] });
    runner("record-stage", ["--stage", "S60", "--artifact", s60, "--write", "--run-id", runId]);
    runner("advance", ["--to", "S70", "--write", "--run-id", runId]);
    const s70Changes = artifact("s70-changes.json", { type: "ReviewDecisionSet", decisions: [{ pr: 711, risk: "medium", mode: "INDEPENDENT", verdict: "CHANGES", findings: [{ class: "must_fix", summary: "fix" }], reviewerRef: "flight:review" }] });
    runner("record-stage", ["--stage", "S70", "--artifact", s70Changes, "--write", "--run-id", runId]);
    expect(runner("advance", ["--to", "S80", "--write", "--run-id", runId], false).stderr).toContain("must loop");
    runner("advance", ["--to", "S40", "--write", "--run-id", runId]);
    expect(runner("advance", ["--to", "S50", "--write", "--run-id", runId], false).stderr).toContain("fresh typed output");
    runner("record-stage", ["--stage", "S40", "--artifact", s40, "--write", "--run-id", runId]);
    runner("advance", ["--to", "S50", "--write", "--run-id", runId]);
    runner("record-stage", ["--stage", "S50", "--artifact", s50Pass, "--write", "--run-id", runId]);
    runner("advance", ["--to", "S60", "--write", "--run-id", runId]);
    runner("record-stage", ["--stage", "S60", "--artifact", s60, "--write", "--run-id", runId]);
    runner("advance", ["--to", "S70", "--write", "--run-id", runId]);
    const s70Approve = artifact("s70-approve.json", { type: "ReviewDecisionSet", decisions: [{ pr: 711, risk: "medium", mode: "INDEPENDENT", verdict: "APPROVE", findings: [], reviewerRef: "flight:review-2" }] });
    runner("record-stage", ["--stage", "S70", "--artifact", s70Approve, "--write", "--run-id", runId]);
    runner("advance", ["--to", "S80", "--write", "--run-id", runId]);

    const s80Fail = artifact("s80-fail.json", { type: "MergeGateSet", gates: [{ pr: 711, headSha: "c".repeat(40), checks: "FAIL", mergeable: true, baseCurrent: true, blockingFeedback: false }] });
    runner("record-stage", ["--stage", "S80", "--artifact", s80Fail, "--write", "--run-id", runId]);
    expect(runner("advance", ["--to", "S90", "--write", "--run-id", runId], false).stderr).toContain("must loop");
    runner("advance", ["--to", "S50", "--write", "--run-id", runId]);
    expect(runner("advance", ["--to", "S60", "--write", "--run-id", runId], false).stderr).toContain("fresh typed output");
    runner("record-stage", ["--stage", "S50", "--artifact", s50Pass, "--write", "--run-id", runId]);
    runner("advance", ["--to", "S60", "--write", "--run-id", runId]);
    runner("record-stage", ["--stage", "S60", "--artifact", s60, "--write", "--run-id", runId]);
    runner("advance", ["--to", "S70", "--write", "--run-id", runId]);
    runner("record-stage", ["--stage", "S70", "--artifact", s70Approve, "--write", "--run-id", runId]);
    runner("advance", ["--to", "S80", "--write", "--run-id", runId]);
    const s80Pass = artifact("s80-pass.json", { type: "MergeGateSet", gates: [{ pr: 711, headSha: "c".repeat(40), checks: "PASS", mergeable: true, baseCurrent: true, blockingFeedback: false }] });
    runner("record-stage", ["--stage", "S80", "--artifact", s80Pass, "--write", "--run-id", runId]);
    runner("advance", ["--to", "S90", "--write", "--run-id", runId]);

    const s90Ambiguous = artifact("s90-ambiguous.json", { type: "ReleaseReceiptSet", releaseState: "AMBIGUOUS", ambiguity: "version not authorized", merges: [{ pr: 711, mergeCommit: "e".repeat(40) }], releases: [] });
    runner("record-stage", ["--stage", "S90", "--artifact", s90Ambiguous, "--write", "--run-id", runId]);
    expect(runner("advance", ["--to", "S100", "--write", "--run-id", runId], false).stderr).toContain("S90 stopped");
    const s90Verified = artifact("s90-verified.json", { type: "ReleaseReceiptSet", releaseState: "NOT_REQUIRED", ambiguity: null, merges: [{ pr: 711, mergeCommit: "e".repeat(40) }], releases: [] });
    runner("record-stage", ["--stage", "S90", "--artifact", s90Verified, "--write", "--run-id", runId]);
    runner("advance", ["--to", "S100", "--write", "--run-id", runId]);

    const checkpoint = JSON.parse(runner("status", ["--run-id", runId]).stdout).checkpoint;
    expect(checkpoint.lanes.find((lane: any) => lane.laneId === holdLane)).toMatchObject({ classification: "HOLD", quarantined: true });
    expect(checkpoint.retryCount.S70).toBeGreaterThan(0);
    expect(checkpoint.retryCount.S80).toBeGreaterThan(0);
    expect(checkpoint.blockers.some((blocker: any) => blocker.stage === "S90")).toBe(true);
  }, 120_000);

  test("validate fails visibly for a corrupt matching checkpoint", () => {
    const repoHash = sha256("https://github.com/arach/openscout").slice(0, 8);
    const corruptDirectory = join(state, "runs", `rt-20260812-17-${repoHash}`);
    mkdirSync(corruptDirectory, { recursive: true });
    writeFileSync(join(corruptDirectory, "checkpoint.json"), "{truncated");
    expect(runner("validate", [], false).stderr).toContain(`Invalid checkpoint ${join(corruptDirectory, "checkpoint.json")}`);
    rmSync(corruptDirectory, { recursive: true, force: true });
  });

  test("run ids cannot escape state and semantic checkpoint errors name the file", () => {
    const isolatedState = join(sandbox, "run-id-state");
    expect(runner("init", ["--run-id", "../../escape", "--write"], false, isolatedState).stderr).toContain("Invalid run id");
    expect(Bun.file(join(sandbox, "escape", "checkpoint.json")).size).toBe(0);

    const created = JSON.parse(runner("init", ["--write"], true, isolatedState).stdout);
    const path = created.checkpointPath as string;
    const checkpoint = JSON.parse(readFileSync(path, "utf8"));
    checkpoint.workflowVersion = "0.0.0";
    writeFileSync(path, `${JSON.stringify(checkpoint, null, 2)}\n`);
    const result = runner("validate", ["--run-id", checkpoint.runId], false, isolatedState);
    expect(result.stderr).toContain(`Invalid checkpoint ${path}`);
    expect(result.stderr).toContain("workflow version mismatch");
  });

  test("stray run directories are ignored", () => {
    const isolatedState = join(sandbox, "stray-directory-state");
    const repoHash = sha256("https://github.com/arach/openscout").slice(0, 8);
    mkdirSync(join(isolatedState, "runs", `junk-${repoHash}`), { recursive: true });
    expect(JSON.parse(runner("init", [], true, isolatedState).stdout).action).toBe("would_create");
  });

  test("one scheduled write renews an expired same-run lease and advances", () => {
    const isolatedState = join(sandbox, "expired-lease-state");
    const created = JSON.parse(runner("init", ["--write"], true, isolatedState).stdout);
    const runId = created.checkpoint.runId as string;
    const checkpointPath = created.checkpointPath as string;
    const lockPath = join(isolatedState, "locks", `${created.checkpoint.repo.repoHash}.json`);
    const expiredAt = "2026-08-14T00:00:00.000Z";

    const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8"));
    checkpoint.lock.expiresAt = expiredAt;
    writeFileSync(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    lock.expiresAt = expiredAt;
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

    const result = JSON.parse(runner("advance", ["--to", "S10", "--write", "--run-id", runId], true, isolatedState).stdout);
    expect(result.action).toBe("advanced");
    const renewedCheckpoint = JSON.parse(readFileSync(checkpointPath, "utf8"));
    const renewedLock = JSON.parse(readFileSync(lockPath, "utf8"));
    expect(renewedCheckpoint.currentStage).toBe("S10");
    expect(Date.parse(renewedCheckpoint.lock.expiresAt)).toBeGreaterThan(Date.now());
    expect(renewedLock.expiresAt).toBe(renewedCheckpoint.lock.expiresAt);
  });

  test("scheduled writes never renew a token-mismatched lease", () => {
    const isolatedState = join(sandbox, "foreign-lease-state");
    const created = JSON.parse(runner("init", ["--write"], true, isolatedState).stdout);
    const runId = created.checkpoint.runId as string;
    const lockPath = join(isolatedState, "locks", `${created.checkpoint.repo.repoHash}.json`);
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    lock.token = "different-owner-token";
    lock.expiresAt = "2026-08-14T00:00:00.000Z";
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

    expect(runner("advance", ["--to", "S10", "--write", "--run-id", runId], false, isolatedState).stderr).toContain("lock is not owned");
    expect(JSON.parse(readFileSync(created.checkpointPath, "utf8")).currentStage).toBe("S00");
  });

  test("an illegal scheduled write does not renew an expired lease", () => {
    const isolatedState = join(sandbox, "illegal-write-state");
    const created = JSON.parse(runner("init", ["--write"], true, isolatedState).stdout);
    const runId = created.checkpoint.runId as string;
    const lockPath = join(isolatedState, "locks", `${created.checkpoint.repo.repoHash}.json`);
    const expiredAt = "2026-08-14T00:00:00.000Z";
    const checkpoint = JSON.parse(readFileSync(created.checkpointPath, "utf8"));
    checkpoint.lock.expiresAt = expiredAt;
    writeFileSync(created.checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    lock.expiresAt = expiredAt;
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

    expect(runner("complete", ["--write", "--run-id", runId], false, isolatedState).stderr).toContain("Cannot complete from S00");
    expect(JSON.parse(readFileSync(lockPath, "utf8")).expiresAt).toBe(expiredAt);
    expect(JSON.parse(readFileSync(created.checkpointPath, "utf8")).currentStage).toBe("S00");
  });

  test("a concurrent lock update guard prevents stale-owner overwrite", () => {
    const isolatedState = join(sandbox, "lock-guard-state");
    const created = JSON.parse(runner("init", ["--write"], true, isolatedState).stdout);
    const runId = created.checkpoint.runId as string;
    const lockPath = join(isolatedState, "locks", `${created.checkpoint.repo.repoHash}.json`);
    const guardPath = `${lockPath}.guard`;
    const before = readFileSync(lockPath, "utf8");
    writeFileSync(guardPath, `${JSON.stringify({ guardToken: "foreign", runId, pid: process.pid, createdAt: new Date().toISOString() })}\n`);

    expect(runner("advance", ["--to", "S10", "--write", "--run-id", runId], false, isolatedState).stderr).toContain("lock update already in progress");
    expect(readFileSync(lockPath, "utf8")).toBe(before);
    expect(JSON.parse(readFileSync(created.checkpointPath, "utf8")).currentStage).toBe("S00");
    rmSync(guardPath);
  });

  test("a dead lock updater guard is reclaimed without weakening live-owner exclusion", () => {
    const isolatedState = join(sandbox, "stale-lock-guard-state");
    const created = JSON.parse(runner("init", ["--write"], true, isolatedState).stdout);
    const runId = created.checkpoint.runId as string;
    const lockPath = join(isolatedState, "locks", `${created.checkpoint.repo.repoHash}.json`);
    const guardPath = `${lockPath}.guard`;
    writeFileSync(guardPath, `${JSON.stringify({ guardToken: "stale", runId, pid: 2_147_483_647, createdAt: "2026-08-14T00:00:00.000Z" })}\n`);

    expect(JSON.parse(runner("advance", ["--to", "S10", "--write", "--run-id", runId], true, isolatedState).stdout).action).toBe("advanced");
    expect(JSON.parse(readFileSync(created.checkpointPath, "utf8")).currentStage).toBe("S10");
    expect(Bun.file(guardPath).size).toBe(0);
  });

  test("a stale init resume cannot overwrite a concurrent stage write", () => {
    const isolatedState = join(sandbox, "stale-init-state");
    const created = JSON.parse(runner("init", ["--write"], true, isolatedState).stdout);
    const staleCheckpoint = structuredClone(created.checkpoint);
    const runId = created.checkpoint.runId as string;

    runner("advance", ["--to", "S10", "--write", "--run-id", runId], true, isolatedState);
    persistCheckpointWithLock(isolatedState, created.checkpointPath, loadWorkflow(), staleCheckpoint);

    const checkpoint = JSON.parse(readFileSync(created.checkpointPath, "utf8"));
    expect(checkpoint.currentStage).toBe("S10");
    expect(checkpoint.stageHistory.at(-1)).toMatchObject({ from: "S00", to: "S10" });
  });

  test("malformed persisted locks fail closed", () => {
    const isolatedState = join(sandbox, "malformed-lock-state");
    const created = JSON.parse(runner("init", ["--write"], true, isolatedState).stdout);
    const runId = created.checkpoint.runId as string;
    const lockPath = join(isolatedState, "locks", `${created.checkpoint.repo.repoHash}.json`);
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    lock.repoIdentity = "https://github.com/arach/not-openscout";
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

    expect(runner("advance", ["--to", "S10", "--write", "--run-id", runId], false, isolatedState).stderr).toContain("lock is malformed");
    expect(JSON.parse(readFileSync(created.checkpointPath, "utf8")).currentStage).toBe("S00");
  });

  test("a post-S20 blocker is quarantined while another READY lane continues", () => {
    const isolatedState = join(sandbox, "quarantine-state");
    const created = JSON.parse(runner("init", ["--write"], true, isolatedState).stdout);
    const runId = created.checkpoint.runId as string;
    runner("advance", ["--to", "S10", "--write", "--run-id", runId], true, isolatedState);
    const blockedLane = computeLaneId("https://github.com/arach/openscout", join(sandbox, "late-block"), "codex/late-block");
    const safeLane = computeLaneId("https://github.com/arach/openscout", join(sandbox, "safe"), "codex/safe");
    const s10 = artifact("quarantine-s10.json", { type: "SourceOwnershipLedger", lanes: [
      { laneId: blockedLane, owner: "agent:block", checkout: join(sandbox, "late-block"), branch: "codex/late-block", headSha: "1".repeat(40), commits: [], pr: null, status: "clean" },
      { laneId: safeLane, owner: "agent:safe", checkout: join(sandbox, "safe"), branch: "codex/safe", headSha: "2".repeat(40), commits: [], pr: null, status: "clean" },
    ] });
    runner("record-stage", ["--stage", "S10", "--artifact", s10, "--write", "--run-id", runId], true, isolatedState);
    runner("advance", ["--to", "S20", "--write", "--run-id", runId], true, isolatedState);
    const s20 = artifact("quarantine-s20.json", { type: "OwnerClassificationLedger", pollId: "poll:q", idempotencyKey: "sha256:q", pollStartedAt: "2026-08-12T13:00:00Z", deadline: "2026-08-12T13:10:00Z", lanes: [
      { laneId: blockedLane, classification: "READY", reason: "initially ready", responseRef: "flight:block" },
      { laneId: safeLane, classification: "READY", reason: "ready", responseRef: "flight:safe" },
    ] });
    runner("record-stage", ["--stage", "S20", "--artifact", s20, "--write", "--run-id", runId], true, isolatedState);
    runner("advance", ["--to", "S30", "--write", "--run-id", runId], true, isolatedState);
    const s30 = artifact("quarantine-s30.json", { type: "FrozenScopePlan", scopeHash: "sha256:q", approvedLaneIds: [blockedLane, safeLane], excludedLaneIds: [], commitPlan: [{ laneId: blockedLane }, { laneId: safeLane }], prPlan: [{ laneIds: [blockedLane] }, { laneIds: [safeLane] }], releasePlan: { mode: "canonical" } });
    runner("record-stage", ["--stage", "S30", "--artifact", s30, "--write", "--run-id", runId], true, isolatedState);
    runner("advance", ["--to", "S40", "--write", "--run-id", runId], true, isolatedState);
    runner("quarantine", ["--lane", blockedLane, "--reason", "late validation blocker", "--write", "--run-id", runId], true, isolatedState);
    expect(runner("receipt", ["--kind", "commit", "--lane", blockedLane, "--target", "blocked", "--external-id", "x", "--write", "--run-id", runId], false, isolatedState).stderr).toContain("forbidden");
    expect(JSON.parse(runner("receipt", ["--kind", "commit", "--lane", safeLane, "--target", "safe", "--external-id", "y", "--write", "--run-id", runId], true, isolatedState).stdout).action).toBe("recorded");
    const checkpoint = JSON.parse(runner("status", ["--run-id", runId], true, isolatedState).stdout).checkpoint;
    expect(checkpoint.lanes.find((lane: any) => lane.laneId === blockedLane)).toMatchObject({ classification: "BLOCK", quarantined: true });
    expect(checkpoint.lanes.find((lane: any) => lane.laneId === safeLane)).toMatchObject({ classification: "READY", quarantined: false });
  }, 120_000);

  test("terminal stop writes S110 unresolved output and releases the lock", () => {
    const isolatedState = join(sandbox, "stop-state");
    const created = JSON.parse(runner("init", ["--write"], true, isolatedState).stdout);
    const runId = created.checkpoint.runId as string;
    expect(JSON.parse(runner("stop", ["--reason", "retry budget exhausted", "--run-id", runId], true, isolatedState).stdout).action).toBe("would_stop");
    expect(JSON.parse(runner("stop", ["--reason", "retry budget exhausted", "--write", "--run-id", runId], true, isolatedState).stdout).action).toBe("stopped");
    const checkpoint = JSON.parse(runner("status", ["--run-id", runId], true, isolatedState).stdout).checkpoint;
    expect(checkpoint.currentStage).toBe("S110");
    expect(checkpoint.completedAt).not.toBeNull();
    expect(checkpoint.lock.status).toBe("released");
    expect(checkpoint.outputs.S110[0].artifact.unresolved[0].reason).toBe("retry budget exhausted");
  });

  test("terminal stop queue separates merged READY lanes from pending READY lanes", () => {
    const checkpoint = {
      lanes: [
        { laneId: "merged", classification: "READY" },
        { laneId: "pending", classification: "READY" },
        { laneId: "held", classification: "HOLD" },
        { laneId: "blocked", classification: "BLOCK" },
      ],
      receipts: [
        { receiptId: "receipt-merge", kind: "merge", data: { laneIds: ["merged"] } },
      ],
    } as any;
    expect(completionDecisionQueue(checkpoint)).toEqual({
      readyToMerge: ["pending"],
      needsReview: [],
      needsFollowUp: ["blocked"],
      heldExcluded: ["held"],
      shipped: ["merged"],
    });
  });
});
