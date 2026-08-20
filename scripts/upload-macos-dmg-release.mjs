#!/usr/bin/env node
/**
 * Attach a locally built macOS DMG to a GitHub release.
 *
 * This intentionally does not build in CI. Build/sign/notarize locally with
 * apps/macos/scripts/build-dmg.sh, then run this helper against an existing tag.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

function usage() {
  return `Usage:
  node scripts/upload-macos-dmg-release.mjs [tag] [options]

Examples:
  node scripts/upload-macos-dmg-release.mjs v0.2.70
  node scripts/upload-macos-dmg-release.mjs app-macos-v0.2.70 --version 0.2.70
  node scripts/upload-macos-dmg-release.mjs v0.2.70 --clobber

Options:
  --version <value>       Version used for apps/macos/dist/OpenScout-<version>.dmg.
                          Defaults to root package.json.
  --dmg <path>            Versioned DMG path. Defaults to apps/macos/dist/OpenScout-<version>.dmg.
  --latest-dmg <path>     Stable DMG asset path. Defaults to apps/macos/dist/OpenScout.dmg.
  --no-latest             Upload only the versioned DMG.
  --repo <owner/repo>     GitHub repository for gh. Defaults to the current checkout.
  --title <value>         Release title when the release does not exist yet.
  --notes <value>         Release notes when the release does not exist yet.
  --clobber               Replace existing assets with the same name.
  --skip-verify           Upload without running the local DMG verifier.
  --dry-run               Print gh commands without running them.
`;
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

function parseArgs(argv) {
  const options = {
    tag: null,
    version: readJson("package.json").version,
    dmgPath: null,
    latestDmgPath: null,
    uploadLatest: true,
    repo: null,
    title: null,
    notes: "Signed and notarized OpenScout macOS installer.",
    clobber: false,
    skipVerify: false,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--version") {
      options.version = argv[++index];
      continue;
    }
    if (arg.startsWith("--version=")) {
      options.version = arg.slice("--version=".length);
      continue;
    }
    if (arg === "--dmg") {
      options.dmgPath = argv[++index];
      continue;
    }
    if (arg.startsWith("--dmg=")) {
      options.dmgPath = arg.slice("--dmg=".length);
      continue;
    }
    if (arg === "--latest-dmg") {
      options.latestDmgPath = argv[++index];
      continue;
    }
    if (arg.startsWith("--latest-dmg=")) {
      options.latestDmgPath = arg.slice("--latest-dmg=".length);
      continue;
    }
    if (arg === "--no-latest") {
      options.uploadLatest = false;
      continue;
    }
    if (arg === "--repo") {
      options.repo = argv[++index];
      continue;
    }
    if (arg.startsWith("--repo=")) {
      options.repo = arg.slice("--repo=".length);
      continue;
    }
    if (arg === "--title") {
      options.title = argv[++index];
      continue;
    }
    if (arg.startsWith("--title=")) {
      options.title = arg.slice("--title=".length);
      continue;
    }
    if (arg === "--notes") {
      options.notes = argv[++index];
      continue;
    }
    if (arg.startsWith("--notes=")) {
      options.notes = arg.slice("--notes=".length);
      continue;
    }
    if (arg === "--clobber") {
      options.clobber = true;
      continue;
    }
    if (arg === "--skip-verify") {
      options.skipVerify = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    if (options.tag) {
      throw new Error(`Unexpected extra argument: ${arg}`);
    }
    options.tag = arg;
  }

  if (!/^\d+\.\d+\.\d+/.test(options.version)) {
    throw new Error(`Version must look like X.Y.Z, got: ${options.version}`);
  }

  options.tag ??= `v${options.version}`;
  options.title ??= `OpenScout macOS ${options.version}`;
  options.dmgPath ??= `apps/macos/dist/OpenScout-${options.version}.dmg`;
  options.latestDmgPath ??= "apps/macos/dist/OpenScout.dmg";
  return options;
}

function repoArgs(repo) {
  return repo ? ["--repo", repo] : [];
}

function runGh(args, { dryRun, stdio = "inherit" } = {}) {
  const label = ["gh", ...args].join(" ");
  if (dryRun) {
    console.log(`DRY ${label}`);
    return { status: 0 };
  }
  const result = spawnSync("gh", args, {
    cwd: repoRoot,
    stdio,
    encoding: "utf8",
  });
  if (result.error) {
    throw result.error;
  }
  if ((result.status ?? 1) !== 0 && stdio === "inherit") {
    throw new Error(`${label} exited with ${result.status}`);
  }
  return result;
}

function assertFile(relativeOrAbsolutePath) {
  const fullPath = path.resolve(repoRoot, relativeOrAbsolutePath);
  if (!existsSync(fullPath)) {
    throw new Error(`DMG not found: ${relativeOrAbsolutePath}`);
  }
  return relativeOrAbsolutePath;
}

function runLocal(command, args, { dryRun } = {}) {
  const label = [command, ...args].join(" ");
  if (dryRun) {
    console.log(`DRY ${label}`);
    return;
  }
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if ((result.status ?? 1) !== 0) {
    throw new Error(`${label} exited with ${result.status}`);
  }
}

function verifyAssets(options) {
  if (options.skipVerify) {
    return;
  }
  runLocal("node", ["scripts/verify-macos-dmg.mjs", options.dmgPath], {
    dryRun: options.dryRun,
  });
  if (options.uploadLatest) {
    runLocal("cmp", ["-s", options.dmgPath, options.latestDmgPath], {
      dryRun: options.dryRun,
    });
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const assets = [options.dryRun ? options.dmgPath : assertFile(options.dmgPath)];
  if (options.uploadLatest) {
    assets.push(options.dryRun ? options.latestDmgPath : assertFile(options.latestDmgPath));
  }
  verifyAssets(options);

  if (options.dryRun) {
    runGh(["release", "view", options.tag, ...repoArgs(options.repo)], { dryRun: true });
    runGh([
      "release",
      "upload",
      options.tag,
      ...assets,
      ...repoArgs(options.repo),
      ...(options.clobber ? ["--clobber"] : []),
    ], { dryRun: true });
    runGh([
      "release",
      "create",
      options.tag,
      ...assets,
      "--title",
      options.title,
      "--notes",
      options.notes,
      "--verify-tag",
      ...repoArgs(options.repo),
    ], { dryRun: true });
    console.log("Dry run: upload is used when the release exists; create is used when the tag exists but the release does not.");
    return;
  }

  const releaseView = runGh(
    ["release", "view", options.tag, ...repoArgs(options.repo)],
    { dryRun: false, stdio: "pipe" },
  );

  if ((releaseView.status ?? 1) === 0) {
    const uploadArgs = [
      "release",
      "upload",
      options.tag,
      ...assets,
      ...repoArgs(options.repo),
    ];
    if (options.clobber) {
      uploadArgs.push("--clobber");
    }
    runGh(uploadArgs, { dryRun: options.dryRun });
    console.log(`Uploaded ${assets.length} DMG asset(s) to ${options.tag}.`);
    return;
  }

  runGh([
    "release",
    "create",
    options.tag,
    ...assets,
    "--title",
    options.title,
    "--notes",
    options.notes,
    "--verify-tag",
    ...repoArgs(options.repo),
  ], { dryRun: options.dryRun });
  console.log(`Created release ${options.tag} and uploaded ${assets.length} DMG asset(s).`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
