#!/usr/bin/env node

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

const BACKUP_FILENAME = ".package.json.publish-backup";

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function findRepoRoot(startDir) {
  let currentDir = path.resolve(startDir);

  while (true) {
    const candidate = path.join(currentDir, "package.json");
    if (existsSync(candidate)) {
      const pkg = await readJson(candidate);
      if (Array.isArray(pkg.workspaces)) {
        return currentDir;
      }
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error(`Could not find repo root above ${startDir}`);
    }
    currentDir = parentDir;
  }
}

async function collectWorkspaceVersions(repoRoot) {
  const rootPkg = await readJson(path.join(repoRoot, "package.json"));
  const versions = new Map();

  for (const workspacePattern of rootPkg.workspaces ?? []) {
    if (!workspacePattern.endsWith("/*")) {
      continue;
    }

    const workspaceRoot = path.join(repoRoot, workspacePattern.slice(0, -2));
    if (!existsSync(workspaceRoot)) {
      continue;
    }

    const entries = await fs.readdir(workspaceRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const packageJsonPath = path.join(workspaceRoot, entry.name, "package.json");
      if (!existsSync(packageJsonPath)) {
        continue;
      }

      const workspacePkg = await readJson(packageJsonPath);
      if (workspacePkg.name && workspacePkg.version) {
        versions.set(workspacePkg.name, workspacePkg.version);
      }
    }
  }

  return versions;
}

function resolveWorkspaceRange(range, version) {
  const workspaceRange = range.slice("workspace:".length);

  if (!workspaceRange || workspaceRange === "*") {
    return version;
  }

  if (workspaceRange === "^" || workspaceRange === "~") {
    return `${workspaceRange}${version}`;
  }

  return workspaceRange;
}

function rewriteWorkspaceDependencies(pkg, versions) {
  let changed = false;

  for (const section of DEPENDENCY_SECTIONS) {
    const deps = pkg[section];
    if (!deps) {
      continue;
    }

    for (const [name, range] of Object.entries(deps)) {
      if (typeof range !== "string" || !range.startsWith("workspace:")) {
        continue;
      }

      if (section === "devDependencies") {
        delete deps[name];
        if (Object.keys(deps).length === 0) {
          delete pkg[section];
        }
        changed = true;
        continue;
      }

      const resolvedVersion = versions.get(name);
      if (!resolvedVersion) {
        continue;
      }

      const publishRange = resolveWorkspaceRange(range, resolvedVersion);
      if (publishRange !== range) {
        deps[name] = publishRange;
        changed = true;
      }
    }
  }

  return changed;
}

async function restoreStaleBackup(packageDir) {
  const pkgPath = path.join(packageDir, "package.json");
  const backupPath = path.join(packageDir, BACKUP_FILENAME);

  if (!existsSync(backupPath)) {
    return;
  }

  await fs.copyFile(backupPath, pkgPath);
  await fs.unlink(backupPath);
}

async function main() {
  const packageDir = path.resolve(process.argv[2] ?? ".");
  const pkgPath = path.join(packageDir, "package.json");
  const backupPath = path.join(packageDir, BACKUP_FILENAME);

  await restoreStaleBackup(packageDir);

  const repoRoot = await findRepoRoot(packageDir);
  const versions = await collectWorkspaceVersions(repoRoot);
  const pkgText = await fs.readFile(pkgPath, "utf8");
  const pkg = JSON.parse(pkgText);

  if (!rewriteWorkspaceDependencies(pkg, versions)) {
    return;
  }

  await fs.writeFile(backupPath, pkgText);
  await fs.writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

await main();
