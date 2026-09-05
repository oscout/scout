import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const scoutBin = resolve(repoRoot, "packages/cli/bin/scout.mjs");
const scoutLauncher = resolve(repoRoot, "packages/cli/bin/scout");
const nodeEntrypoint = resolve(repoRoot, "packages/cli/dist/node/main.mjs");
const packageJson = JSON.parse(execFileSync(process.execPath, [
  "-e",
  "process.stdout.write(JSON.stringify(require('./packages/cli/package.json')))",
], { cwd: repoRoot, encoding: "utf8" }));
const temporaryDirectories = new Set();

function temporaryDirectory(prefix) {
  const directory = realpathSync(mkdtempSync(resolve(tmpdir(), prefix)));
  temporaryDirectories.add(directory);
  return directory;
}

test.after(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function bunlessEnv(extra = {}) {
  return {
    ...extra,
    HOME: temporaryDirectory("openscout-launcher-home-"),
    PATH: "/usr/bin:/bin",
  };
}

function launcherEnv() {
  const env = bunlessEnv();
  env.PATH = `${dirname(process.execPath)}:${env.PATH}`;
  return env;
}

function makeTwoHopLauncher(mode) {
  const root = temporaryDirectory("openscout-launcher-chain-");
  const packageBin = join(root, "package", "bin");
  const bunBin = join(root, "bun", "bin");
  const localBin = join(root, "local", "bin");
  mkdirSync(packageBin, { recursive: true });
  mkdirSync(bunBin, { recursive: true });
  mkdirSync(localBin, { recursive: true });

  const realScout = join(packageBin, "scout");
  const realMjs = join(packageBin, "scout.mjs");
  copyFileSync(scoutLauncher, realScout);
  chmodSync(realScout, 0o755);
  writeFileSync(realMjs, "console.log(`SCOUT_LAUNCHER ${process.argv[1]}`);\n");

  const bunScout = join(bunBin, "scout");
  const localScout = join(localBin, "scout");
  if (mode === "relative") {
    symlinkSync(relative(bunBin, realScout), bunScout);
    symlinkSync(relative(localBin, bunScout), localScout);
  } else {
    symlinkSync(realScout, bunScout);
    symlinkSync(bunScout, localScout);
  }

  return { localScout, bunScout, realMjs };
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

test("prints a direct next step after headless setup", { timeout: 15_000 }, () => {
  if (!existsSync(nodeEntrypoint)) {
    return;
  }
  const work = temporaryDirectory("openscout-launcher-work-");
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

test("resolves a two-hop absolute launcher chain to the package scout.mjs", () => {
  const { localScout, bunScout, realMjs } = makeTwoHopLauncher("absolute");
  const result = spawnSync(localScout, ["--version"], {
    env: launcherEnv(),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), `SCOUT_LAUNCHER ${realMjs}`);
  assert.doesNotMatch(result.stderr, /Cannot find module|MODULE_NOT_FOUND/);
  assert.notEqual(result.stdout.trim(), `SCOUT_LAUNCHER ${bunScout}.mjs`);
});

test("resolves a two-hop relative launcher chain to the package scout.mjs", () => {
  const { localScout, bunScout, realMjs } = makeTwoHopLauncher("relative");
  const result = spawnSync(localScout, ["--version"], {
    env: launcherEnv(),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), `SCOUT_LAUNCHER ${realMjs}`);
  assert.doesNotMatch(result.stderr, /Cannot find module|MODULE_NOT_FOUND/);
  assert.notEqual(result.stdout.trim(), `SCOUT_LAUNCHER ${bunScout}.mjs`);
});

test("bounded symlink walks do not loop forever", () => {
  const root = temporaryDirectory("openscout-launcher-loop-");
  const first = join(root, "scout-a");
  const second = join(root, "scout-b");
  symlinkSync(second, first);
  symlinkSync(first, second);

  // Source the real launcher while setting $0 to the cyclic chain. Executing
  // the symlink directly would let the kernel return ELOOP before the launcher's
  // own bounded readlink walk runs.
  const result = spawnSync("/bin/sh", ["-c", '. "$1"', first, scoutLauncher], {
    env: launcherEnv(),
    encoding: "utf8",
    timeout: 3000,
  });

  assert.notEqual(result.error?.code, "ETIMEDOUT");
  assert.notEqual(result.status, 0);
});
