#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

function npmTarballName(name, version) {
  return `${name.replace(/^@/, "").replace(/\//g, "-")}-${version}.tgz`;
}

function findWorkspaceDirs() {
  return [
    "packages/protocol",
    "packages/agent-sessions",
    "packages/runtime",
    "packages/cli",
    "packages/web",
    "packages/session-trace",
    "packages/session-trace-react",
  ]
    .map((relativePath) => path.join(repoRoot, relativePath))
    .filter((dir) => existsSync(path.join(dir, "package.json")))
    .filter((dir) => {
      const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
      return pkg.private !== true;
    });
}

function findWorkspaceLeaks(pkg) {
  const leaks = [];

  for (const section of DEPENDENCY_SECTIONS) {
    const deps = pkg[section];
    if (!deps) {
      continue;
    }

    for (const [name, range] of Object.entries(deps)) {
      if (typeof range === "string" && range.startsWith("workspace:")) {
        leaks.push(`${section}.${name}=${range}`);
      }
    }
  }

  return leaks;
}

// Files that MUST be present in a package's tarball. Keyed by package name.
// @openscout/scout ships the prebuilt scoutd broker service binary; if it is
// missing, npm-installed users hit "Unable to locate scoutd" for every broker
// operation (resolveScoutdCommand in broker-process-manager.ts).
const REQUIRED_PACKED_FILES = {
  "@openscout/scout": ["package/bin/scoutd"],
};

function listTarballEntries(tarballPath, packageDir) {
  return execFileSync("tar", ["-tzf", tarballPath], {
    cwd: packageDir,
    encoding: "utf8",
  })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function inspectPackedManifest(packageDir, tempDir) {
  const pkg = JSON.parse(await fs.readFile(path.join(packageDir, "package.json"), "utf8"));
  const tarballPath = path.join(tempDir, npmTarballName(pkg.name, pkg.version));
  const npmCache = process.env.npm_config_cache || path.join(os.tmpdir(), "openscout-npm-cache");
  await fs.mkdir(npmCache, { recursive: true });

  execFileSync("npm", ["pack", "--pack-destination", tempDir], {
    cwd: packageDir,
    env: {
      ...process.env,
      npm_config_cache: npmCache,
    },
    stdio: "inherit",
  });

  const packedManifestText = execFileSync(
    "tar",
    ["-xOf", tarballPath, "package/package.json"],
    {
      cwd: packageDir,
      encoding: "utf8",
    },
  );

  const entries = listTarballEntries(tarballPath, packageDir);
  const missingFiles = (REQUIRED_PACKED_FILES[pkg.name] ?? []).filter(
    (required) => !entries.includes(required),
  );

  return {
    name: pkg.name,
    leaks: findWorkspaceLeaks(JSON.parse(packedManifestText)),
    missingFiles,
    tarballPath,
  };
}

async function main() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openscout-pack-check-"));

  try {
    const failures = [];

    for (const packageDir of findWorkspaceDirs()) {
      const result = await inspectPackedManifest(packageDir, tempDir);
      if (result.leaks.length > 0 || result.missingFiles.length > 0) {
        failures.push(result);
      }
    }

    if (failures.length > 0) {
      for (const failure of failures) {
        if (failure.leaks.length > 0) {
          console.error(`${failure.name} packed with workspace dependencies:`);
          for (const leak of failure.leaks) {
            console.error(`  - ${leak}`);
          }
        }
        if (failure.missingFiles.length > 0) {
          console.error(`${failure.name} is missing required packed files:`);
          for (const missing of failure.missingFiles) {
            console.error(`  - ${missing}`);
          }
        }
      }
      process.exitCode = 1;
      return;
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

await main();
