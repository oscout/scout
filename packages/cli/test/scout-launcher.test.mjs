import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const scoutBin = resolve(repoRoot, "packages/cli/bin/scout.mjs");
const nodeEntrypoint = resolve(repoRoot, "packages/cli/dist/node/main.mjs");
const packageJson = JSON.parse(execFileSync(process.execPath, [
  "-e",
  "process.stdout.write(JSON.stringify(require('./packages/cli/package.json')))",
], { cwd: repoRoot, encoding: "utf8" }));

function bunlessEnv(extra = {}) {
  return {
    ...extra,
    HOME: mkdtempSync(resolve(tmpdir(), "openscout-launcher-home-")),
    PATH: "/usr/bin:/bin",
  };
}

test("prints package version without requiring Bun", () => {
  const output = execFileSync(process.execPath, [scoutBin, "--version"], {
    cwd: repoRoot,
    env: bunlessEnv(),
    encoding: "utf8",
  });

  assert.equal(output.trim(), packageJson.version);
});

test("prints fallback help without requiring Bun", () => {
  const output = execFileSync(process.execPath, [scoutBin, "--help"], {
    cwd: repoRoot,
    env: bunlessEnv({ OPENSCOUT_RUNTIME_HOST: "node" }),
    encoding: "utf8",
  });

  assert.match(output, /Scout/);
  assert.match(output, /scout (setup|statusline claude)/);
});

test("reports unsupported Node commands instead of failing in the shebang", () => {
  const result = spawnSync(process.execPath, [scoutBin, "whoami"], {
    cwd: repoRoot,
    env: bunlessEnv({ OPENSCOUT_RUNTIME_HOST: "node" }),
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Node headless entrypoint is not packaged yet|Unsupported in the Node headless CLI/);
  assert.doesNotMatch(result.stderr, /env: bun: No such file or directory/);
});

test("runs bundled headless service status directly on Node when packaged", () => {
  if (!existsSync(nodeEntrypoint)) {
    return;
  }
  const result = spawnSync(process.execPath, [scoutBin, "service", "status", "--json"], {
    cwd: repoRoot,
    env: bunlessEnv({
      OPENSCOUT_RUNTIME_HOST: "node",
      OPENSCOUT_SERVICE_ADAPTER: "headless-foreground",
    }),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.equal(status.serviceAdapter, "headless-foreground");
  assert.equal(status.usesLaunchAgent, false);
});

test("prints a direct next step after headless setup", () => {
  if (!existsSync(nodeEntrypoint)) {
    return;
  }
  const work = mkdtempSync(resolve(tmpdir(), "openscout-launcher-work-"));
  const result = spawnSync(process.execPath, [scoutBin, "setup", "--source-root", work], {
    cwd: work,
    env: bunlessEnv({
      OPENSCOUT_RUNTIME_HOST: "node",
      OPENSCOUT_SERVICE_ADAPTER: "headless-foreground",
      OPENSCOUT_SKIP_USER_PROJECT_HINTS: "1",
    }),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Next step: run `openscout-runtime broker`/);
  assert.doesNotMatch(result.stdout, /cannot start a background service/);
  assert.doesNotMatch(result.stdout, /service adapter cannot/);
});

test("runs bundled statusline directly on Node when Bun is unavailable", () => {
  const result = spawnSync(process.execPath, [scoutBin, "statusline", "claude"], {
    cwd: repoRoot,
    env: bunlessEnv({ OPENSCOUT_RUNTIME_HOST: "node" }),
    input: "",
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "Scout | Claude status");
  assert.equal(result.stderr.trim(), "");
});
