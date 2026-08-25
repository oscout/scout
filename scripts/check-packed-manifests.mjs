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

const FORBIDDEN_PACKED_PREFIXES = {
  "@openscout/scout": ["package/dist/client/crew/"],
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

function auditTarball(tarballPath, packageDir = repoRoot) {
  const packedManifestText = execFileSync(
    "tar",
    ["-xOf", tarballPath, "package/package.json"],
    {
      cwd: packageDir,
      encoding: "utf8",
    },
  );
  const pkg = JSON.parse(packedManifestText);
  const entries = listTarballEntries(tarballPath, packageDir);
  const missingFiles = (REQUIRED_PACKED_FILES[pkg.name] ?? []).filter(
    (required) => !entries.includes(required),
  );
  const forbiddenFiles = entries.filter((entry) =>
    (FORBIDDEN_PACKED_PREFIXES[pkg.name] ?? []).some((prefix) => entry.startsWith(prefix)),
  );

  return {
    name: pkg.name,
    leaks: findWorkspaceLeaks(pkg),
    missingFiles,
    forbiddenFiles,
    tarballPath,
  };
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

  return auditTarball(tarballPath, packageDir);
}

function reportFailures(results) {
  const failures = results.filter((result) =>
    result.leaks.length > 0
    || result.missingFiles.length > 0
    || result.forbiddenFiles.length > 0
  );
  for (const failure of failures) {
    if (failure.leaks.length > 0) {
      console.error(`${failure.name} packed with workspace dependencies:`);
      for (const leak of failure.leaks) console.error(`  - ${leak}`);
    }
    if (failure.missingFiles.length > 0) {
      console.error(`${failure.name} is missing required packed files:`);
      for (const missing of failure.missingFiles) console.error(`  - ${missing}`);
    }
    if (failure.forbiddenFiles.length > 0) {
      console.error(`${failure.name} contains private product assets:`);
      for (const forbidden of failure.forbiddenFiles) console.error(`  - ${forbidden}`);
    }
  }
  return failures.length;
}

async function main() {
  if (process.argv[2] === "--tarball") {
    const tarballs = process.argv.slice(3).map((value) => path.resolve(value));
    if (tarballs.length === 0) {
      throw new Error("--tarball requires at least one exact candidate path");
    }
    process.exitCode = reportFailures(tarballs.map((tarball) => auditTarball(tarball))) > 0
      ? 1
      : 0;
    return;
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openscout-pack-check-"));

  try {
    const results = [];

    for (const packageDir of findWorkspaceDirs()) {
      results.push(await inspectPackedManifest(packageDir, tempDir));
    }

    if (reportFailures(results) > 0) {
      process.exitCode = 1;
      return;
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

await main();
