#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

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
  "@openscout/scout": [
    "package/bin/scoutd",
    "package/dist/scout-control-plane-web.mjs",
    "package/dist/scout-web-server.mjs",
    "package/dist/client/index.html",
  ],
};

const FORBIDDEN_PACKED_PREFIXES = {
  "@openscout/scout": ["package/dist/client/crew/"],
};

// Calibrated against the reviewed 0.2.92 candidate (about 8.08 MB packed,
// 36.97 MB unpacked, 445 files), the 0.2.94 candidate (about 6.65 MB packed,
// 30.75 MB unpacked, 452 files), and the 0.2.96 candidate (about 7.34 MB packed,
// 36.36 MB unpacked, 482 files). The previous release's duplicated
// 3.45 MB web-server bundle exceeds both byte ceilings. Raising a ceiling is a
// deliberate release-review decision, not an incidental side effect of npm
// packaging.
const PACKED_FOOTPRINT_BUDGETS = {
  "@openscout/scout": {
    maxPackedBytes: 8_500_000,
    maxUnpackedBytes: 38_000_000,
    maxFileCount: 500,
  },
};

// The old entry name remains as a compatibility import only. Keeping its own
// small ceiling prevents the full server graph from being duplicated again
// even if unrelated package files later shrink enough to fit the total budget.
const PACKED_FILE_BUDGETS = {
  "@openscout/scout": {
    "package/dist/scout-web-server.mjs": 1_024,
  },
};

function parseTarOctal(field, label) {
  const value = field.toString("ascii").replace(/\0.*$/s, "").trim();
  if (!value) return 0;
  if (!/^[0-7]+$/.test(value)) {
    throw new Error(`Unsupported tar ${label}: ${JSON.stringify(value)}`);
  }
  return Number.parseInt(value, 8);
}

export function readTarballFootprint(tarballPath) {
  const archive = gunzipSync(readFileSync(tarballPath));
  const fileSizes = new Map();
  let unpackedBytes = 0;
  let fileCount = 0;
  let offset = 0;

  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/s, "");
    const entryPath = prefix ? `${prefix}/${name}` : name;
    const size = parseTarOctal(header.subarray(124, 136), `size for ${entryPath}`);
    const type = header[156];
    if (type === 0 || type === 48) {
      fileCount += 1;
      unpackedBytes += size;
      fileSizes.set(entryPath, size);
    }

    offset += 512 + Math.ceil(size / 512) * 512;
  }

  return {
    packedBytes: statSync(tarballPath).size,
    unpackedBytes,
    fileCount,
    fileSizes,
  };
}

export function findFootprintFailures(packageName, footprint) {
  const failures = [];
  const budget = PACKED_FOOTPRINT_BUDGETS[packageName];
  if (budget) {
    if (footprint.packedBytes > budget.maxPackedBytes) {
      failures.push(
        `packed size ${footprint.packedBytes.toLocaleString("en-US")} exceeds ${budget.maxPackedBytes.toLocaleString("en-US")} bytes`,
      );
    }
    if (footprint.unpackedBytes > budget.maxUnpackedBytes) {
      failures.push(
        `unpacked size ${footprint.unpackedBytes.toLocaleString("en-US")} exceeds ${budget.maxUnpackedBytes.toLocaleString("en-US")} bytes`,
      );
    }
    if (footprint.fileCount > budget.maxFileCount) {
      failures.push(`file count ${footprint.fileCount} exceeds ${budget.maxFileCount}`);
    }
  }

  for (const [entryPath, maxBytes] of Object.entries(PACKED_FILE_BUDGETS[packageName] ?? {})) {
    const observedBytes = footprint.fileSizes.get(entryPath);
    if (observedBytes !== undefined && observedBytes > maxBytes) {
      failures.push(
        `${entryPath} is ${observedBytes.toLocaleString("en-US")} bytes; compatibility entry must not exceed ${maxBytes.toLocaleString("en-US")} bytes`,
      );
    }
  }
  return failures;
}

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
  const footprint = readTarballFootprint(tarballPath);
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
    footprint,
    footprintFailures: findFootprintFailures(pkg.name, footprint),
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
    || result.footprintFailures.length > 0
  );
  for (const result of results) {
    if (PACKED_FOOTPRINT_BUDGETS[result.name]) {
      console.log(
        `${result.name} footprint: ${result.footprint.packedBytes.toLocaleString("en-US")} packed bytes, ${result.footprint.unpackedBytes.toLocaleString("en-US")} unpacked bytes, ${result.footprint.fileCount} files`,
      );
    }
  }
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
    if (failure.footprintFailures.length > 0) {
      console.error(`${failure.name} exceeds its reviewed package footprint:`);
      for (const footprintFailure of failure.footprintFailures) {
        console.error(`  - ${footprintFailure}`);
      }
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
