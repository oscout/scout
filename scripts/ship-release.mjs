#!/usr/bin/env node
/**
 * One entry point for a coordinated OpenScout release.
 *
 * Default mode is intentionally non-mutating: it prints the version plan and the
 * commands that would run. Pass --execute --yes to bump, verify, tag, publish,
 * and create the GitHub release.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const PUBLIC_PACKAGES = [
  "packages/cli",
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

function usage() {
  return `Usage:
  node scripts/ship-release.mjs <version|patch|minor|major> [options]

Examples:
  npm run ship -- patch
  npm run ship -- 0.2.64 --execute --yes
  npm run ship -- patch --execute --yes --include-ios

Options:
  --execute              Run the release. Without this, only prints the plan.
  --yes                  Required with --execute; confirms publish/tag actions.
  --allow-dirty          Allow a dirty worktree before bumping.
  --skip-bump            Do not run scripts/bump-version.mjs.
  --skip-npm             Skip npm package verification and publish.
  --github-npm           Verify npm locally, then let GitHub Actions publish
                         after the GitHub release is created.
  --skip-dmg             Skip the macOS DMG build and GitHub asset upload.
  --skip-github-release  Skip gh release creation.
  --include-ios          Run apps/ios/scripts/release.sh after npm/GitHub steps.
  --no-commit            Do not commit bumped manifest versions.
  --skip-tag             Do not create the local v<version> tag.
  --skip-push            Do not push branch/tags before publishing.
  --release-notes-file <path>
                         Use explicit GitHub release notes instead of generated notes.
`;
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

function packageVersion(relativeDir) {
  const manifestPath = relativeDir === "." ? "package.json" : `${relativeDir}/package.json`;
  return readJson(manifestPath).version;
}

function bumpSemver(current, kind) {
  const match = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(current);
  if (!match) {
    throw new Error(`Cannot parse semver: ${current}`);
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (kind === "major") return `${major + 1}.0.0`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  if (kind === "patch") return `${major}.${minor}.${patch + 1}`;
  throw new Error(`Unknown bump kind: ${kind}`);
}

function parseArgs(argv) {
  const options = {
    execute: false,
    yes: false,
    allowDirty: false,
    skipBump: false,
    skipNpm: false,
    githubNpm: false,
    skipDmg: false,
    skipGithubRelease: false,
    includeIos: false,
    commit: true,
    skipTag: false,
    skipPush: false,
    releaseNotesFile: null,
  };
  let target = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--execute") {
      options.execute = true;
      continue;
    }
    if (arg === "--yes") {
      options.yes = true;
      continue;
    }
    if (arg === "--allow-dirty") {
      options.allowDirty = true;
      continue;
    }
    if (arg === "--skip-bump") {
      options.skipBump = true;
      continue;
    }
    if (arg === "--skip-npm") {
      options.skipNpm = true;
      continue;
    }
    if (arg === "--github-npm") {
      options.githubNpm = true;
      continue;
    }
    if (arg === "--skip-dmg") {
      options.skipDmg = true;
      continue;
    }
    if (arg === "--skip-github-release") {
      options.skipGithubRelease = true;
      continue;
    }
    if (arg === "--include-ios") {
      options.includeIos = true;
      continue;
    }
    if (arg === "--no-commit") {
      options.commit = false;
      continue;
    }
    if (arg === "--skip-tag") {
      options.skipTag = true;
      continue;
    }
    if (arg === "--skip-push") {
      options.skipPush = true;
      continue;
    }
    if (arg === "--release-notes-file") {
      options.releaseNotesFile = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg.startsWith("--release-notes-file=")) {
      options.releaseNotesFile = arg.slice("--release-notes-file=".length);
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    if (target) {
      throw new Error(`Unexpected extra argument: ${arg}`);
    }
    target = arg;
  }

  if (!target) {
    throw new Error("Missing release version target.");
  }
  if (options.skipNpm && options.githubNpm) {
    throw new Error("Use either --skip-npm or --github-npm, not both.");
  }
  if (options.githubNpm && options.skipGithubRelease) {
    throw new Error("--github-npm runs after GitHub release creation; remove --skip-github-release.");
  }
  if (options.releaseNotesFile && !existsSync(path.resolve(repoRoot, options.releaseNotesFile))) {
    throw new Error(`Release notes file not found: ${options.releaseNotesFile}`);
  }

  return { target, options };
}

function run(command, args, { execute, env } = { execute: false }) {
  const label = [command, ...args].join(" ");
  if (!execute) {
    console.log(`  DRY ${label}`);
    return;
  }
  console.log(`\n$ ${label}`);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: env ?? process.env,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if ((result.status ?? 1) !== 0) {
    throw new Error(`${label} exited with ${result.status}`);
  }
}

function capture(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", options.inheritStderr ? "inherit" : "pipe"],
  }).trim();
}

function gitDirty() {
  return capture("git", ["status", "--porcelain"]).length > 0;
}

function printVersionTable(nextVersion) {
  console.log("Release version plan:");
  for (const relativeDir of VERSION_MANIFESTS) {
    const label = relativeDir === "." ? "root package.json" : `${relativeDir}/package.json`;
    console.log(`  ${label}: ${packageVersion(relativeDir)} -> ${nextVersion}`);
  }
}

function npmDistTag() {
  return process.env.NPM_TAG || "latest";
}

function macosDmgPath(version) {
  return `apps/macos/dist/OpenScout-${version}.dmg`;
}

function macosLatestDmgPath() {
  return "apps/macos/dist/OpenScout.dmg";
}

function printPlan(version, options) {
  const dmgPath = macosDmgPath(version);

  console.log("\nRelease steps:");
  if (!options.skipBump) {
    run("node", ["scripts/bump-version.mjs", version], { execute: false });
  }
  if (!options.skipNpm) {
    run("bash", ["scripts/ship-npm.sh", "--dry-run"], { execute: false });
  }
  if (!options.skipDmg) {
    run("bash", ["apps/macos/scripts/build-dmg.sh", version], { execute: false });
    run("node", ["scripts/update-appcast.mjs", version, dmgPath], { execute: false });
  }
  if (options.commit) {
    run("git", ["add", ...VERSION_MANIFESTS.map((dir) => dir === "." ? "package.json" : `${dir}/package.json`), "apps/macos/appcast.xml"], { execute: false });
    run("git", ["commit", "-m", `🔖 Release v${version}`], { execute: false });
  }
  if (!options.skipTag) {
    run("git", ["tag", "-a", `v${version}`, "-m", `Release v${version}`], { execute: false });
  }
  if (!options.skipPush) {
    run("git", ["push", "origin", "HEAD", "--follow-tags"], { execute: false });
  }
  if (options.githubNpm) {
    console.log("  DRY GitHub Actions publishes npm after release creation");
  } else if (!options.skipNpm) {
    run("bash", ["scripts/ship-npm.sh"], { execute: false });
  }
  if (!options.skipGithubRelease) {
    const args = ["release", "create", `v${version}`, "--title", `OpenScout v${version}`];
    if (!options.skipDmg) args.push(dmgPath, macosLatestDmgPath());
    if (options.releaseNotesFile) {
      args.push("--notes-file", options.releaseNotesFile);
    } else {
      args.push("--generate-notes");
    }
    run("gh", args, { execute: false });
  }
  if (options.githubNpm) {
    run("gh", [
      "workflow",
      "run",
      "release-package-npm.yml",
      "--ref",
      "main",
      "--field",
      `tag=v${version}`,
      "--field",
      `npm_tag=${npmDistTag()}`,
    ], { execute: false });
  }
  if (options.includeIos) {
    run("bash", ["apps/ios/scripts/release.sh"], { execute: false });
  }
}

function verifyLockstep(nextVersion) {
  const versions = new Map();
  for (const relativeDir of VERSION_MANIFESTS) {
    const version = packageVersion(relativeDir);
    if (version !== nextVersion) {
      versions.set(relativeDir, version);
    }
  }
  return versions;
}

function gitAddReleaseManifests(execute) {
  const manifests = VERSION_MANIFESTS.map((dir) => dir === "." ? "package.json" : `${dir}/package.json`);
  // The signed Sparkle appcast is a release artifact that must ride along with
  // the version bump commit so raw.githubusercontent.com serves the new item.
  manifests.push("apps/macos/appcast.xml");
  run("git", ["add", ...manifests], { execute });
}

function stagedChangesExist() {
  const result = spawnSync("git", ["diff", "--cached", "--quiet"], {
    cwd: repoRoot,
    stdio: "ignore",
  });
  return result.status !== 0;
}

function main() {
  const { target, options } = parseArgs(process.argv.slice(2));
  const currentPackageVersion = packageVersion(PUBLIC_PACKAGES[0]);
  const nextVersion = ["patch", "minor", "major"].includes(target)
    ? bumpSemver(currentPackageVersion, target)
    : target;

  if (!/^\d+\.\d+\.\d+/.test(nextVersion)) {
    throw new Error(`Invalid version: ${nextVersion}`);
  }

  printVersionTable(nextVersion);
  printPlan(nextVersion, options);

  if (!options.execute) {
    console.log("\nDry run only. Re-run with --execute --yes to ship.");
    return;
  }

  if (!options.yes) {
    throw new Error("Refusing to publish without --yes.");
  }
  if (!options.allowDirty && gitDirty()) {
    throw new Error("Worktree is dirty. Commit/stash changes or pass --allow-dirty.");
  }

  if (!options.skipBump) {
    run("node", ["scripts/bump-version.mjs", nextVersion], { execute: true });
  }

  const drift = verifyLockstep(nextVersion);
  if (drift.size > 0) {
    const detail = [...drift].map(([dir, version]) => `${dir}=${version}`).join(", ");
    throw new Error(`Release manifests are not synced to ${nextVersion}: ${detail}`);
  }

  if (!options.skipNpm) {
    run("bash", ["scripts/ship-npm.sh", "--dry-run"], { execute: true });
  }
  if (!options.skipDmg) {
    run("bash", ["apps/macos/scripts/build-dmg.sh", nextVersion], { execute: true });
    run("node", ["scripts/update-appcast.mjs", nextVersion, macosDmgPath(nextVersion)], { execute: true });
  }

  if (options.commit) {
    gitAddReleaseManifests(true);
    if (stagedChangesExist()) {
      run("git", ["commit", "-m", `🔖 Release v${nextVersion}`], { execute: true });
    } else {
      console.log("\nNo release manifest changes to commit.");
    }
  }

  if (!options.skipTag) {
    run("git", ["tag", "-a", `v${nextVersion}`, "-m", `Release v${nextVersion}`], { execute: true });
  }
  if (!options.skipPush) {
    run("git", ["push", "origin", "HEAD", "--follow-tags"], { execute: true });
  }
  if (options.githubNpm) {
    console.log("\nGitHub Actions will publish npm after the GitHub release is created.");
  } else if (!options.skipNpm) {
    run("bash", ["scripts/ship-npm.sh"], { execute: true });
  }
  if (!options.skipGithubRelease) {
    const args = ["release", "create", `v${nextVersion}`, "--title", `OpenScout v${nextVersion}`];
    const dmgPath = macosDmgPath(nextVersion);
    if (!options.skipDmg) {
      args.push(dmgPath, macosLatestDmgPath());
    }
    if (options.releaseNotesFile) {
      args.push("--notes-file", options.releaseNotesFile);
    } else {
      args.push("--generate-notes");
    }
    run("gh", args, { execute: true });
  }
  if (options.githubNpm) {
    run("gh", [
      "workflow",
      "run",
      "release-package-npm.yml",
      "--ref",
      "main",
      "--field",
      `tag=v${nextVersion}`,
      "--field",
      `npm_tag=${npmDistTag()}`,
    ], { execute: true });
  }
  if (options.includeIos) {
    run("bash", ["apps/ios/scripts/release.sh"], { execute: true });
  }

  console.log(`\nOpenScout v${nextVersion} release complete.`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
