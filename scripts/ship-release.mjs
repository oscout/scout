#!/usr/bin/env node
/**
 * Canonical package release entry point for the public Scout repository.
 *
 * Release preparation is intentionally separate. Execution only accepts an
 * already-versioned, reviewed, clean public main commit and resumes matching
 * tag, npm, and GitHub state after an interrupted attempt.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const CANONICAL_REPOSITORY = "https://github.com/oscout/scout";
const CANONICAL_GITHUB_REPOSITORY = "oscout/scout";

const PUBLIC_PACKAGES = [
  { dir: "packages/protocol", name: "@openscout/protocol" },
  { dir: "packages/cli", name: "@openscout/scout" },
];

const VERSION_MANIFESTS = [
  ".",
  "apps/desktop",
  "packages/agent-sessions",
  "packages/cli",
  "packages/protocol",
  "packages/runtime",
  "packages/session-trace",
  "packages/session-trace-react",
  "packages/web",
];

const APP_VERSION_SOURCE = "apps/desktop/src/shared/product.ts";
const DOCS_VERSION_SOURCE = "docs.json";
const APP_VERSION_PATTERN =
  /export const SCOUT_APP_VERSION = process\.env\.SCOUT_APP_VERSION\?\.trim\(\) \|\| "([^"]+)";/;

function usage() {
  return [
    "Usage:",
    "  node scripts/ship-release.mjs <version> [options]",
    "",
    "Example:",
    "  npm run ship -- 0.2.88",
    "  npm run ship -- 0.2.88 --execute --yes",
    "",
    "Options:",
    "  --execute              Resume or run the package release.",
    "  --yes                  Required with --execute.",
    "  --release-notes-file <path>",
    "                         Use explicit GitHub release notes.",
    "",
    "Execution never bumps or commits. Prepare and merge the reviewed release",
    "version first, then run from a clean public main checkout.",
    "GitHub npm dispatch is disabled for the 0.2.88 authority cutover; local",
    "signed publication is canonical.",
    "",
  ].join("\n");
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

function packageVersion(relativeDir) {
  const manifestPath = relativeDir === "." ? "package.json" : relativeDir + "/package.json";
  return readJson(manifestPath).version;
}

function parseArgs(argv) {
  const options = {
    execute: false,
    yes: false,
    releaseNotesFile: null,
  };
  let target = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--github-npm") {
      throw new Error(
        "--github-npm is disabled for the public authority cutover; use local signed publication.",
      );
    }
    if (arg === "--execute") options.execute = true;
    else if (arg === "--yes") options.yes = true;
    else if (arg === "--release-notes-file") {
      options.releaseNotesFile = argv[index + 1] ?? null;
      index += 1;
    } else if (arg.startsWith("--release-notes-file=")) {
      options.releaseNotesFile = arg.slice("--release-notes-file=".length);
    } else if (arg.startsWith("--")) {
      throw new Error("Unsupported release option: " + arg);
    } else if (target) {
      throw new Error("Unexpected extra argument: " + arg);
    } else {
      target = arg;
    }
  }

  if (!target) throw new Error("Missing release version target.");
  if (!/^\d+\.\d+\.\d+$/.test(target)) {
    throw new Error("Invalid stable version: " + target);
  }
  if (options.releaseNotesFile && !existsSync(path.resolve(repoRoot, options.releaseNotesFile))) {
    throw new Error("Release notes file not found: " + options.releaseNotesFile);
  }
  return { version: target, options };
}

function commandLabel(command, args) {
  return [command, ...args].join(" ");
}

function run(command, args) {
  const label = commandLabel(command, args);
  console.log("\n$ " + label);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) throw new Error(label + " exited with " + result.status);
}

function capture(command, args) {
  return execFileSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function spawnCapture(command, args) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function normalizeGithubRemote(remote) {
  return remote
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/^ssh:\/\/git@github\.com\//, "https://github.com/")
    .replace(/^git\+/, "")
    .replace(/\.git$/, "");
}

function assertCleanWorktree() {
  const status = capture("git", ["status", "--porcelain", "--untracked-files=normal"]);
  if (status) {
    throw new Error(
      "Release execution requires a clean reviewed worktree; found:\n" + status,
    );
  }
}

function assertCanonicalLocalSource() {
  const remote = normalizeGithubRemote(capture("git", ["remote", "get-url", "origin"]));
  if (remote !== CANONICAL_REPOSITORY) {
    throw new Error("Release origin must be " + CANONICAL_REPOSITORY + ", got " + remote);
  }
  const branch = capture("git", ["branch", "--show-current"]);
  if (branch !== "main") {
    throw new Error("Release execution requires public main, got " + (branch || "detached HEAD"));
  }
}

function currentHead() {
  return capture("git", ["rev-parse", "HEAD^{commit}"]);
}

function fetchAndVerifyRemoteMain(expectedHead) {
  run("git", ["fetch", "--no-tags", "origin", "refs/heads/main"]);
  const fetchedMain = capture("git", ["rev-parse", "FETCH_HEAD^{commit}"]);
  const head = currentHead();
  if (head !== expectedHead) {
    throw new Error("Release HEAD changed during verification: " + expectedHead + " -> " + head);
  }
  if (head !== fetchedMain) {
    throw new Error("Release HEAD " + head + " does not match fetched origin/main " + fetchedMain);
  }
}

function readAppVersion() {
  const contents = readFileSync(path.join(repoRoot, APP_VERSION_SOURCE), "utf8");
  const match = APP_VERSION_PATTERN.exec(contents);
  if (!match) throw new Error("Could not read SCOUT_APP_VERSION from " + APP_VERSION_SOURCE);
  return match[1];
}

function verifyReleaseVersion(version) {
  const drift = [];
  for (const relativeDir of VERSION_MANIFESTS) {
    const found = packageVersion(relativeDir);
    if (found !== version) drift.push(relativeDir + "=" + found);
  }
  const appVersion = readAppVersion();
  if (appVersion !== version) drift.push(APP_VERSION_SOURCE + "=" + appVersion);
  const docsVersion = readJson(DOCS_VERSION_SOURCE).version;
  if (docsVersion !== version) drift.push(DOCS_VERSION_SOURCE + "=" + docsVersion);
  if (drift.length > 0) {
    throw new Error("Reviewed release sources are not synced to " + version + ": " + drift.join(", "));
  }
  for (const pkg of PUBLIC_PACKAGES) {
    const manifest = readJson(pkg.dir + "/package.json");
    if (manifest.name !== pkg.name || manifest.version !== version) {
      throw new Error(
        "Published package identity mismatch in "
          + pkg.dir + ": " + manifest.name + "@" + manifest.version,
      );
    }
  }
}

function printVersionTable(version) {
  console.log("Release source verification:");
  for (const relativeDir of VERSION_MANIFESTS) {
    const label = relativeDir === "." ? "root package.json" : relativeDir + "/package.json";
    console.log("  " + label + ": " + packageVersion(relativeDir));
  }
  console.log("  " + APP_VERSION_SOURCE + ": " + readAppVersion());
  console.log("  " + DOCS_VERSION_SOURCE + ": " + readJson(DOCS_VERSION_SOURCE).version);
  console.log("\nPublished package set:");
  for (const pkg of PUBLIC_PACKAGES) console.log("  " + pkg.name + "@" + version);
}

function printPlan(version, options) {
  const tag = "v" + version;
  console.log("\nRelease steps:");
  console.log("  DRY require clean oscout/scout main already versioned at " + version);
  console.log("  DRY git fetch --no-tags origin refs/heads/main");
  console.log("  DRY bash scripts/ship-npm.sh --verify-state");
  console.log("  DRY bash scripts/ship-npm.sh --dry-run");
  console.log("  DRY create or verify " + tag + " at HEAD");
  console.log(
    "  DRY git push --atomic origin HEAD:refs/heads/main refs/tags/"
      + tag + ":refs/tags/" + tag,
  );
  console.log("  DRY bash scripts/ship-npm.sh");
  console.log("  DRY bash scripts/ship-npm.sh --verify-published");
  const note = options.releaseNotesFile
    ? " --notes-file " + options.releaseNotesFile
    : " --generate-notes";
  console.log("  DRY create, finalize, or verify GitHub release " + tag + note);
}

function localTagCommit(tag) {
  const result = spawnCapture("git", ["rev-parse", "--verify", "refs/tags/" + tag + "^{commit}"]);
  if (result.status === 0) return result.stdout.trim();
  const diagnostic = (result.stdout || "") + "\n" + (result.stderr || "");
  if (/unknown revision|needed a single revision|ambiguous argument/i.test(diagnostic)) return null;
  throw new Error("Could not inspect local tag " + tag + ": " + diagnostic.trim());
}

function remoteTagCommit(tag) {
  const directRef = "refs/tags/" + tag;
  const peeledRef = directRef + "^{}";
  const result = spawnCapture("git", ["ls-remote", "--tags", "origin", directRef, peeledRef]);
  if (result.status !== 0) {
    throw new Error(
      "Could not inspect remote tag " + tag + ": "
        + ((result.stderr || result.stdout || "unknown error").trim()),
    );
  }
  const refs = new Map();
  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) continue;
    const [object, ref] = line.trim().split(/\s+/, 2);
    refs.set(ref, object);
  }
  return refs.get(peeledRef) ?? refs.get(directRef) ?? null;
}

function assertMatchingTagState(tag, expectedHead) {
  const local = localTagCommit(tag);
  if (local && local !== expectedHead) {
    throw new Error("Local tag " + tag + " points to " + local + ", expected " + expectedHead);
  }
  const remote = remoteTagCommit(tag);
  if (remote && remote !== expectedHead) {
    throw new Error("Remote tag " + tag + " points to " + remote + ", expected " + expectedHead);
  }
  return { local, remote };
}

function ensureRemoteTag(tag, expectedHead) {
  let state = assertMatchingTagState(tag, expectedHead);
  if (!state.local) {
    run("git", ["tag", "-a", tag, "-m", "Release " + tag, expectedHead]);
    state = assertMatchingTagState(tag, expectedHead);
  }
  if (!state.remote) {
    run("git", [
      "push", "--atomic", "origin",
      "HEAD:refs/heads/main",
      "refs/tags/" + tag + ":refs/tags/" + tag,
    ]);
    state = assertMatchingTagState(tag, expectedHead);
  }
  if (state.local !== expectedHead || state.remote !== expectedHead) {
    throw new Error("Could not establish matching local and remote " + tag + " state.");
  }
}

function inspectGithubRelease(tag) {
  const result = spawnCapture("gh", [
    "release", "view", tag,
    "--repo", CANONICAL_GITHUB_REPOSITORY,
    "--json", "tagName,isDraft,isPrerelease,url",
  ]);
  if (result.status === 0) {
    let release;
    try {
      release = JSON.parse(result.stdout);
    } catch {
      throw new Error("Could not parse GitHub release state for " + tag + ".");
    }
    if (release.tagName !== tag) {
      throw new Error("GitHub release tag mismatch: " + release.tagName + ", expected " + tag);
    }
    return release;
  }
  const diagnostic = (result.stdout || "") + "\n" + (result.stderr || "");
  if (/release not found|not found|HTTP 404/i.test(diagnostic)) return null;
  throw new Error("Could not inspect GitHub release " + tag + ": " + diagnostic.trim());
}

function ensureGithubRelease(tag, options) {
  let release = inspectGithubRelease(tag);
  if (!release) {
    const args = [
      "release", "create", tag,
      "--repo", CANONICAL_GITHUB_REPOSITORY,
      "--verify-tag",
      "--title", "Scout " + tag,
    ];
    if (options.releaseNotesFile) args.push("--notes-file", options.releaseNotesFile);
    else args.push("--generate-notes");
    run("gh", args);
    release = inspectGithubRelease(tag);
  }
  if (!release) throw new Error("GitHub release " + tag + " was not observable after creation.");
  if (release.isDraft) {
    run("gh", [
      "release", "edit", tag,
      "--repo", CANONICAL_GITHUB_REPOSITORY,
      "--draft=false",
    ]);
    release = inspectGithubRelease(tag);
  }
  if (release?.isPrerelease) {
    run("gh", [
      "release", "edit", tag,
      "--repo", CANONICAL_GITHUB_REPOSITORY,
      "--prerelease=false",
    ]);
    release = inspectGithubRelease(tag);
  }
  if (!release || release.isDraft || release.isPrerelease) {
    throw new Error("GitHub release " + tag + " is not a final stable release.");
  }
  console.log("\nGitHub release: " + release.url);
}

function main() {
  const { version, options } = parseArgs(process.argv.slice(2));
  verifyReleaseVersion(version);
  printVersionTable(version);
  printPlan(version, options);

  if (!options.execute) {
    console.log("\nDry run only. Re-run with --execute --yes after review and merge.");
    return;
  }
  if (!options.yes) throw new Error("Refusing to publish without --yes.");

  assertCanonicalLocalSource();
  assertCleanWorktree();
  const head = currentHead();
  fetchAndVerifyRemoteMain(head);
  assertCleanWorktree();

  const tag = "v" + version;
  assertMatchingTagState(tag, head);
  run("bash", ["scripts/ship-npm.sh", "--verify-state"]);
  run("bash", ["scripts/ship-npm.sh", "--dry-run"]);

  assertCleanWorktree();
  if (currentHead() !== head) throw new Error("Release HEAD changed during package verification.");
  fetchAndVerifyRemoteMain(head);
  assertCleanWorktree();
  ensureRemoteTag(tag, head);

  run("bash", ["scripts/ship-npm.sh"]);
  run("bash", ["scripts/ship-npm.sh", "--verify-published"]);
  ensureGithubRelease(tag, options);

  const finalTag = remoteTagCommit(tag);
  if (finalTag !== head) {
    throw new Error("Final remote tag verification failed: " + finalTag + ", expected " + head);
  }
  console.log("\nScout " + tag + " release complete at " + head + ".");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
