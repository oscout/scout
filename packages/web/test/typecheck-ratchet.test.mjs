// The typecheck gate is only worth having if it cannot be talked into passing.
//
// A review reproduced two ways it could: a compiler that crashed before
// emitting any TypeScript diagnostic was graded as "0 errors, down from 105"
// and exited 0, and `--update` would then have written that zero into the
// baseline. These tests drive the real CLI against a stub compiler so both
// paths are pinned by behaviour, not by reading the source.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  baselineGrowth,
  compilerRunProblem,
  parseDiagnostics,
  regressionsOf,
  tally,
} from "../scripts/typecheck-core.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageDirectory = path.resolve(testDirectory, "..");
const gate = path.join(packageDirectory, "scripts", "typecheck.mjs");

/** A fake tsc that prints what the test wants and exits with the code it wants. */
function stubCompiler(directory, { stdout = "", stderr = "", exitCode = 0 }) {
  const binary = path.join(directory, "stub-tsc.mjs");
  writeFileSync(
    binary,
    `#!/usr/bin/env node\n`
      + `process.stdout.write(${JSON.stringify(stdout)});\n`
      + `process.stderr.write(${JSON.stringify(stderr)});\n`
      + `process.exit(${exitCode});\n`,
  );
  chmodSync(binary, 0o755);
  return binary;
}

function baselineFile(directory, errors) {
  const file = path.join(directory, "baseline.json");
  writeFileSync(
    file,
    `${JSON.stringify({ total: errors.reduce((sum, entry) => sum + entry.count, 0), errors }, null, 2)}\n`,
  );
  return file;
}

function runGate(directory, { compiler, baseline, args = [] }) {
  return spawnSync("node", [gate, ...args], {
    cwd: packageDirectory,
    encoding: "utf8",
    env: {
      ...process.env,
      OPENSCOUT_WEB_TYPECHECK_TSC: compiler,
      OPENSCOUT_WEB_TYPECHECK_BASELINE: baseline,
    },
  });
}

const KNOWN_ERROR = {
  file: "client/lib/thing.ts",
  code: "TS2339",
  message: "Property 'x' does not exist on type 'Y'.",
  count: 1,
};
const KNOWN_ERROR_LINE = "client/lib/thing.ts(90,28): error TS2339: Property 'x' does not exist on type 'Y'.";

test("a compiler that crashes before emitting diagnostics fails the gate", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "web-typecheck-"));
  const result = runGate(directory, {
    compiler: stubCompiler(directory, { stderr: "Killed: 9\n", exitCode: 1 }),
    baseline: baselineFile(directory, [{ ...KNOWN_ERROR, count: 105 }]),
  });

  assert.equal(result.status, 1, "a compiler that checked nothing must not pass");
  assert.match(result.stderr, /did not run/u);
  assert.doesNotMatch(result.stdout, /down from/u);
});

test("a positionless fatal fails the gate instead of parsing as zero errors", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "web-typecheck-"));
  const result = runGate(directory, {
    compiler: stubCompiler(directory, {
      stdout: "error TS5058: The specified path does not exist: 'tsconfig.json'.\n",
      exitCode: 1,
    }),
    baseline: baselineFile(directory, [{ ...KNOWN_ERROR, count: 105 }]),
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /TS5058/u);
  assert.match(result.stderr, /did not type-check/u);
});

test("a compiler that crashes AFTER emitting a diagnostic cannot tighten the baseline", () => {
  // The second reproduction, and the more dangerous one: the run was accepted
  // because it had parsed something, so one surviving diagnostic was graded as
  // an improvement from 101 errors to 1 and the gate REWROTE the baseline down
  // to that single entry. A truncated read always looks like progress.
  const directory = mkdtempSync(path.join(tmpdir(), "web-typecheck-"));
  const baseline = baselineFile(directory, [{ ...KNOWN_ERROR, count: 101 }]);
  const before = readFileSync(baseline, "utf8");
  const heapDeath = `${KNOWN_ERROR_LINE}\n`
    + "\n<--- Last few GCs --->\n"
    + "\n<--- JS stacktrace --->\n"
    + "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n";
  const compiler = stubCompiler(directory, { stdout: heapDeath, exitCode: 134 });

  const gated = runGate(directory, { compiler, baseline });
  assert.notEqual(gated.status, 0, "a compiler that died mid-check must not pass");
  assert.match(gated.stderr, /did not run to completion/u);
  assert.doesNotMatch(gated.stdout, /down from/u);
  assert.equal(readFileSync(baseline, "utf8"), before, "the baseline must be byte-identical");

  // Nor through the escape hatch, which sees the same one-error "improvement".
  const updated = runGate(directory, { compiler, baseline, args: ["--update"] });
  assert.notEqual(updated.status, 0, "--update must not record a crashed run either");
  assert.equal(readFileSync(baseline, "utf8"), before, "the baseline must be byte-identical");
});

test("a diagnostic header the parser cannot read fails the gate", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "web-typecheck-"));
  const result = runGate(directory, {
    compiler: stubCompiler(directory, {
      stdout: `${KNOWN_ERROR_LINE}\nweird/shape error TS9999: something the regex does not match\n`,
      exitCode: 1,
    }),
    baseline: baselineFile(directory, [KNOWN_ERROR]),
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot read/u);
});

test("a clean compiler run at the baseline passes without rewriting it", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "web-typecheck-"));
  const baseline = baselineFile(directory, [KNOWN_ERROR]);
  const before = readFileSync(baseline, "utf8");
  const result = runGate(directory, {
    compiler: stubCompiler(directory, { stdout: `${KNOWN_ERROR_LINE}\n`, exitCode: 1 }),
    baseline,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no new type errors \(1 baselined\)/u);
  assert.equal(readFileSync(baseline, "utf8"), before);
});

test("fixing an error tightens the baseline instead of banking headroom", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "web-typecheck-"));
  const baseline = baselineFile(directory, [{ ...KNOWN_ERROR, count: 3 }]);
  const result = runGate(directory, {
    compiler: stubCompiler(directory, { stdout: `${KNOWN_ERROR_LINE}\n`, exitCode: 1 }),
    baseline,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Baseline tightened/u);
  const rewritten = JSON.parse(readFileSync(baseline, "utf8"));
  assert.equal(rewritten.total, 1, "the slack must be gone, not left for a future error to spend");
  assert.equal(rewritten.errors[0].count, 1);
});

test("--update refuses to grow the baseline", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "web-typecheck-"));
  const baseline = baselineFile(directory, [KNOWN_ERROR]);
  const before = readFileSync(baseline, "utf8");
  const result = runGate(directory, {
    compiler: stubCompiler(directory, {
      stdout: `${KNOWN_ERROR_LINE}\nclient/lib/other.ts(4,2): error TS2322: Type 'a' is not assignable to type 'b'.\n`,
      exitCode: 1,
    }),
    baseline,
    args: ["--update"],
  });

  assert.equal(result.status, 1, "--update must not be a way to record a new error");
  assert.match(result.stderr, /would GROW/u);
  assert.equal(readFileSync(baseline, "utf8"), before);
});

test("--update records a genuine improvement", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "web-typecheck-"));
  const baseline = baselineFile(directory, [{ ...KNOWN_ERROR, count: 4 }]);
  const result = runGate(directory, {
    compiler: stubCompiler(directory, { stdout: `${KNOWN_ERROR_LINE}\n`, exitCode: 1 }),
    baseline,
    args: ["--update"],
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(readFileSync(baseline, "utf8")).total, 1);
});

test("a new error still fails the gate", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "web-typecheck-"));
  const result = runGate(directory, {
    compiler: stubCompiler(directory, {
      stdout: `${KNOWN_ERROR_LINE}\nclient/lib/new.ts(1,1): error TS2322: Type 'a' is not assignable to type 'b'.\n`,
      exitCode: 1,
    }),
    baseline: baselineFile(directory, [KNOWN_ERROR]),
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /client\/lib\/new\.ts:1/u);
});

test("grading helpers agree with the CLI they back", () => {
  const parsed = parseDiagnostics(`${KNOWN_ERROR_LINE}\n  Type 'undefined' is not assignable.\nFound 1 error in 1 file.\n`);
  assert.equal(parsed.diagnostics.length, 1, "continuation lines are not diagnostics");
  assert.equal(parsed.reportedTotal, 1);
  assert.equal(compilerRunProblem({ status: 1, signal: null }, parsed), null);

  const mismatched = parseDiagnostics(`${KNOWN_ERROR_LINE}\nFound 7 errors in 3 files.\n`);
  assert.match(
    compilerRunProblem({ status: 1, signal: null }, mismatched) ?? "",
    /refusing to grade a partial read/u,
  );

  assert.match(
    compilerRunProblem({ status: null, signal: "SIGKILL" }, parseDiagnostics("")) ?? "",
    /killed by SIGKILL/u,
  );

  const observed = tally(parsed.diagnostics);
  const baseline = new Map([[JSON.stringify([KNOWN_ERROR.file, KNOWN_ERROR.code, KNOWN_ERROR.message]), 1]]);
  assert.equal(regressionsOf(parsed.diagnostics, observed, baseline).length, 0);
  assert.equal(baselineGrowth(observed, baseline).length, 0);
  assert.equal(baselineGrowth(observed, new Map()).length, 1);
});
