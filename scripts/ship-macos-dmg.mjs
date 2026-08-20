#!/usr/bin/env node
/**
 * Local macOS app release path.
 *
 * Builds the signed/notarized DMG from this checkout, then attaches the DMG
 * assets to an existing GitHub release tag.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

function usage() {
  return `Usage:
  node scripts/ship-macos-dmg.mjs [version|tag] [options]

Examples:
  npm run ship:macos
  npm run ship:macos -- 0.2.70
  npm run ship:macos -- v0.2.70 --clobber
  npm run ship:macos -- 0.2.70 --dry-run

Options:
  --repo <owner/repo>       GitHub repository for gh.
  --clobber                 Replace existing release assets with the same names.
  --skip-build              Upload existing DMGs from apps/macos/dist.
  --skip-upload             Build only; do not upload to GitHub.
  --local                   Build without notarization. Requires --skip-upload.
  --notary-profile <name>   OPENSCOUT_NOTARY_PROFILE for build-dmg.sh.
  --sign-identity <value>   OPENSCOUT_SIGN_IDENTITY for build-dmg.sh.
  --dry-run                 Print commands without running them.
`;
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

function normalizeTarget(value) {
  const raw = value ?? readJson("package.json").version;
  let version = raw;
  let tag = raw;

  if (raw.startsWith("app-macos-v")) {
    version = raw.slice("app-macos-v".length);
  } else if (raw.startsWith("v")) {
    version = raw.slice(1);
  }

  if (/^\d+\.\d+\.\d+/.test(raw)) {
    tag = `v${raw}`;
  }

  if (!/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error(`Version must look like X.Y.Z, got: ${raw}`);
  }

  return { tag, version };
}

function parseArgs(argv) {
  const options = {
    target: null,
    repo: null,
    clobber: false,
    skipBuild: false,
    skipUpload: false,
    local: false,
    notaryProfile: null,
    signIdentity: null,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--repo") {
      options.repo = argv[++index];
      continue;
    }
    if (arg.startsWith("--repo=")) {
      options.repo = arg.slice("--repo=".length);
      continue;
    }
    if (arg === "--clobber") {
      options.clobber = true;
      continue;
    }
    if (arg === "--skip-build") {
      options.skipBuild = true;
      continue;
    }
    if (arg === "--skip-upload") {
      options.skipUpload = true;
      continue;
    }
    if (arg === "--local") {
      options.local = true;
      continue;
    }
    if (arg === "--notary-profile") {
      options.notaryProfile = argv[++index];
      continue;
    }
    if (arg.startsWith("--notary-profile=")) {
      options.notaryProfile = arg.slice("--notary-profile=".length);
      continue;
    }
    if (arg === "--sign-identity") {
      options.signIdentity = argv[++index];
      continue;
    }
    if (arg.startsWith("--sign-identity=")) {
      options.signIdentity = arg.slice("--sign-identity=".length);
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    if (options.target) {
      throw new Error(`Unexpected extra argument: ${arg}`);
    }
    options.target = arg;
  }

  return options;
}

function run(command, args, { dryRun, env } = {}) {
  const label = [command, ...args].join(" ");
  if (dryRun) {
    console.log(`DRY ${label}`);
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

function main() {
  const options = parseArgs(process.argv.slice(2));
  const { tag, version } = normalizeTarget(options.target);
  const buildEnv = { ...process.env };

  if (options.local && !options.skipUpload) {
    throw new Error("--local builds skip notarization; use --skip-upload for smoke builds.");
  }

  if (options.notaryProfile) {
    buildEnv.OPENSCOUT_NOTARY_PROFILE = options.notaryProfile;
  }
  if (options.signIdentity) {
    buildEnv.OPENSCOUT_SIGN_IDENTITY = options.signIdentity;
  }
  if (options.local) {
    buildEnv.SKIP_NOTARIZE = "1";
  }

  if (!options.skipBuild) {
    run("bash", ["apps/macos/scripts/build-dmg.sh", version], {
      dryRun: options.dryRun,
      env: buildEnv,
    });
    // Sign the fresh DMG into apps/macos/appcast.xml. This is fail-closed: the
    // release stops if the signer does not match the public key embedded in the
    // app. Committing/pushing the appcast is left to the release commit.
    run("node", [
      "scripts/update-appcast.mjs",
      version,
      `apps/macos/dist/OpenScout-${version}.dmg`,
    ], { dryRun: options.dryRun });
  }

  if (!options.skipUpload) {
    const uploadArgs = [
      "scripts/upload-macos-dmg-release.mjs",
      tag,
      "--version",
      version,
    ];
    if (options.repo) {
      uploadArgs.push("--repo", options.repo);
    }
    if (options.clobber) {
      uploadArgs.push("--clobber");
    }
    if (options.dryRun) {
      uploadArgs.push("--dry-run");
    }
    run("node", uploadArgs, { dryRun: false });
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
