import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { validateMergeEvidence } from "./validation-evidence";
import type { Checkpoint } from "./release-train";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "scout-validation-")); dirs.push(dir);
  const outputRef = join(dir, "unit.log"); writeFileSync(outputRef, "passed\n");
  const headSha = "a".repeat(40), baseSha = "b".repeat(40);
  const receipt = { laneId: "lane", checkId: "unit", headSha, baseSha, result: "PASS", exitCode: 0, command: "bun test", outputRef,
    outputSha256: createHash("sha256").update("passed\n").digest("hex"), platform: "darwin", architecture: "arm64", toolVersions: { bun: "1.3.14" }, startedAt: "2026-08-01T00:00:00Z", finishedAt: "2026-08-01T00:00:01Z" };
  const plan: any = { validationPlan: [{ laneId: "lane", checks: [{ id: "unit", platform: "darwin" }] }] };
  const pr = { number: 1, laneIds: ["lane"], headSha, baseSha };
  const review = { pr: 1, headSha, verdict: "APPROVE" };
  const checkpoint = { outputs: { S30: [{ artifact: plan }], S50: [{ artifact: { receipts: [receipt] } }], S60: [{ artifact: { prs: [pr] } }], S70: [{ artifact: { decisions: [review] } }] } } as unknown as Checkpoint;
  const gate: any = { pr: 1, headSha, baseSha, validationSource: "LOCAL_RECEIPTS" };
  return { checkpoint, gate, receipt, plan, pr, review };
}
test("accepts explicit local evidence without fabricating a hosted status", () => {
  const f = fixture(); expect(() => validateMergeEvidence(f.checkpoint, f.gate)).not.toThrow();
});
for (const [name, mutate] of Object.entries({
  "changed head": (f: ReturnType<typeof fixture>) => { f.pr.headSha = "c".repeat(40); },
  "changed base": (f: ReturnType<typeof fixture>) => { f.pr.baseSha = "c".repeat(40); },
  "stale receipt": (f: ReturnType<typeof fixture>) => { f.receipt.headSha = "c".repeat(40); },
  "skipped check": (f: ReturnType<typeof fixture>) => { f.receipt.result = "SKIP"; },
  "failed exit": (f: ReturnType<typeof fixture>) => { f.receipt.exitCode = 1; },
  "wrong platform": (f: ReturnType<typeof fixture>) => { f.receipt.platform = "linux"; },
  "missing coverage": (f: ReturnType<typeof fixture>) => { f.plan.validationPlan[0].checks.push({ id: "other", platform: "darwin" }); },
  "unapproved review": (f: ReturnType<typeof fixture>) => { f.review.verdict = "FOLLOW_UP"; },
  "stale review": (f: ReturnType<typeof fixture>) => { f.review.headSha = "c".repeat(40); },
  "altered log": (f: ReturnType<typeof fixture>) => { writeFileSync(f.receipt.outputRef, "different"); },
  "missing log": (f: ReturnType<typeof fixture>) => { rmSync(f.receipt.outputRef); },
  "missing tools": (f: ReturnType<typeof fixture>) => { f.receipt.toolVersions = {} as any; },
  "invalid timestamps": (f: ReturnType<typeof fixture>) => { f.receipt.finishedAt = "invalid"; },
  "implicit hosted execution": (f: ReturnType<typeof fixture>) => { f.gate.validationSource = "HOSTED_CI"; },
  "legacy green assertion": (f: ReturnType<typeof fixture>) => { delete f.gate.validationSource; },
})) test(`rejects ${name}`, () => { const f = fixture(); mutate(f); expect(() => validateMergeEvidence(f.checkpoint, f.gate)).toThrow(); });

test("hosted mode requires authorization and a hashed exact-revision run receipt", () => {
  const f = fixture(); f.gate.validationSource = "HOSTED_CI"; f.plan.hostedCiAuthorization = "Operator explicitly requested this run";
  expect(() => validateMergeEvidence(f.checkpoint, f.gate)).toThrow();
  const payload = JSON.stringify({ headSha: f.gate.headSha, baseSha: f.gate.baseSha, runUrl: "https://github.com/oscout/scout/actions/runs/123", checks: [f.receipt] });
  const outputRef = join(dirs.at(-1)!, "hosted.json"); writeFileSync(outputRef, payload);
  f.gate.hostedEvidence = { outputRef, outputSha256: createHash("sha256").update(payload).digest("hex") };
  expect(() => validateMergeEvidence(f.checkpoint, f.gate)).not.toThrow();
  f.plan.hostedCiAuthorization = ""; expect(() => validateMergeEvidence(f.checkpoint, f.gate)).toThrow();
});
