import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Checkpoint } from "./release-train";

type RecordValue = Record<string, any>;
const fail = (message: string): never => { throw new Error(`S80 evidence: ${message}`); };
const text = (value: unknown, label: string): string =>
  typeof value === "string" && value.trim() ? value : fail(`${label} is required`);
const list = (value: unknown, label: string): any[] => Array.isArray(value) ? value : fail(`${label} must be an array`);
const sha = (value: unknown, label: string): string =>
  typeof value === "string" && /^[a-f0-9]{40}$/.test(value) ? value : fail(`${label} must be a full commit SHA`);
const latest = (checkpoint: Checkpoint, stage: "S30" | "S50" | "S60" | "S70") => checkpoint.outputs[stage]?.at(-1)?.artifact;

/** Verify evidence at recording and again at S80 -> S90, never synthesize GitHub checks. */
export function validateMergeEvidence(checkpoint: Checkpoint, gate: RecordValue): void {
  const pr = latest(checkpoint, "S60")?.prs?.find((entry: RecordValue) => entry.number === gate.pr);
  if (!pr) fail("missing current PR receipt");
  const head = sha(gate.headSha, "headSha");
  const base = sha(gate.baseSha, "baseSha");
  if (head !== pr.headSha || base !== pr.baseSha) fail("head/base differs from current S60 PR receipt");
  const review = latest(checkpoint, "S70")?.decisions?.find((entry: RecordValue) => entry.pr === gate.pr);
  if (review?.verdict !== "APPROVE" || review.headSha !== head) fail("exact head requires an approved review");
  const plan = latest(checkpoint, "S30");
  const requirements = list(plan?.validationPlan, "S30.validationPlan")
    .filter((entry: RecordValue) => pr.laneIds.includes(entry.laneId));
  for (const laneId of pr.laneIds) {
    const lanes = requirements.filter((entry: RecordValue) => entry.laneId === laneId);
    if (lanes.length !== 1 || !list(lanes[0].checks, "required checks").length) fail(`missing unique check plan for ${laneId}`);
  }
  if (gate.validationSource === "HOSTED_CI") {
    text(plan?.hostedCiAuthorization, "explicit hosted CI authorization");
    const evidence = readEvidence(gate.hostedEvidence);
    if (evidence.headSha !== head || evidence.baseSha !== base) fail("hosted evidence revision mismatch");
    text(evidence.runUrl, "hosted run URL");
    if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+$/.test(evidence.runUrl)) fail("invalid hosted run URL");
    verifyChecks(requirements, list(evidence.checks, "hosted checks"), head, base, false);
  } else if (gate.validationSource === "LOCAL_RECEIPTS") {
    const receipts = list(latest(checkpoint, "S50")?.receipts, "S50 receipts");
    verifyChecks(requirements, receipts, head, base, true);
  } else fail("validationSource must be LOCAL_RECEIPTS or explicitly authorized HOSTED_CI");
}

function readEvidence(ref: RecordValue): RecordValue {
  if (!ref || !isAbsolute(text(ref.outputRef, "outputRef"))) fail("outputRef must be absolute");
  const bytes = readFileSync(ref.outputRef);
  if (createHash("sha256").update(bytes).digest("hex") !== ref.outputSha256) fail(`evidence hash mismatch: ${ref.outputRef}`);
  try { return JSON.parse(bytes.toString("utf8")); } catch { return {}; }
}

function verifyChecks(requirements: RecordValue[], receipts: RecordValue[], head: string, base: string, local: boolean): void {
  for (const requirement of requirements) {
    const ids = new Set<string>();
    for (const check of list(requirement.checks, "required checks")) {
      const id = text(check.id, "check id");
      if (ids.has(id)) fail("duplicate required check");
      ids.add(id);
      text(check.platform, "required platform");
      const matches = receipts.filter((receipt) => receipt.laneId === requirement.laneId && receipt.checkId === id);
      if (matches.length !== 1) fail(`missing unique receipt for ${id}`);
      const receipt = matches[0]!;
      if (receipt.headSha !== head || receipt.baseSha !== base) fail(`stale revision for ${id}`);
      if (receipt.platform !== check.platform) fail(`platform mismatch for ${id}`);
      if (receipt.result !== "PASS" || receipt.exitCode !== 0) fail(`check did not pass: ${id}`);
      text(receipt.command, "command");
      text(receipt.architecture, "architecture");
      if (!receipt.toolVersions || !Object.keys(receipt.toolVersions).length
        || Object.values(receipt.toolVersions).some((value) => typeof value !== "string" || !value.trim())) fail("tool versions required");
      const start = Date.parse(receipt.startedAt), end = Date.parse(receipt.finishedAt);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end > Date.now() + 60000) fail("invalid check timestamps");
      if (local) readEvidence(receipt);
    }
  }
}
