import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

export const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const temporaryDirectories = new Set();

export function temporaryDirectory(prefix = "scout-cli-test-") {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temporaryDirectories.add(directory);
  return directory;
}

test.after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

// Tests must not reuse an operator's HOME, socket, service, or broker. These
// settings also apply when a test deliberately removes Bun from PATH.
export function isolatedEnvironment(extra = {}) {
  const home = temporaryDirectory("scout-cli-home-");
  return {
    PATH: process.env.PATH,
    HOME: home,
    OPENSCOUT_HOME: join(home, ".openscout"),
    OPENSCOUT_CONTROL_HOME: join(home, "control"),
    OPENSCOUT_SUPPORT_DIRECTORY: join(home, "support"),
    OPENSCOUT_RELAY_HUB: join(home, "relay"),
    OPENSCOUT_BROKER_SOCKET_PATH: join(home, "absent.sock"),
    OPENSCOUT_PROBES_SOCKET: join(home, "absent-probes.sock"),
    OPENSCOUT_BROKER_URL: "http://127.0.0.1:1",
    OPENSCOUT_BROKER_HOST: "127.0.0.1",
    OPENSCOUT_BROKER_PORT: "1",
    OPENSCOUT_SCOUTD_BIN: "/usr/bin/false",
    OPENSCOUT_SERVICE_ADAPTER: "headless-foreground",
    OPENSCOUT_SKIP_USER_PROJECT_HINTS: "1",
    NO_COLOR: "1",
    ...extra,
  };
}

// Build only the JavaScript entries these tests exercise. A fresh CI checkout
// has no dist; an existing checkout may have stale dist. Neither should decide
// which implementation passes. Keep native packaging and the working dist out
// of these tests, and let Node resolve the same declared package dependencies.
export function createCliFixture() {
  const directory = temporaryDirectory("scout-cli-package-");
  mkdirSync(join(directory, "bin"));
  mkdirSync(join(directory, "dist", "node"), { recursive: true });
  for (const name of ["scout", "scout.mjs", "lifecycle-preflight.mjs"]) {
    copyFileSync(join(packageDirectory, "bin", name), join(directory, "bin", name));
  }
  const manifest = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8"));
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name: manifest.name, version: manifest.version, type: "module" }));
  symlinkSync(join(packageDirectory, "node_modules"), join(directory, "node_modules"), "dir");
  for (const [source, target, output] of [
    ["main.ts", "bun", "main.mjs"],
    ["node-main.ts", "node", "node/main.mjs"],
    ["statusline.ts", "bun", "statusline.mjs"],
  ]) {
    // Workspace packages expose source through their "bun" export condition;
    // select that source even while generating code for the Node runtime.
    execFileSync("bun", ["build", join(packageDirectory, "src", source), `--target=${target}`, "--conditions=bun", "--format=esm", "--outfile", join(directory, "dist", output), '--banner=import "reflect-metadata";'], {
      cwd: packageDirectory,
      stdio: "pipe",
      timeout: 60_000,
    });
  }
  return directory;
}
