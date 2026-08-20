import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveScoutAppRoot, resolveScoutWorkspaceRoot } from "./paths.ts";

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function makeFixtureRoot(): string {
  return mkdtempSync(join(tmpdir(), "scout-paths-"));
}

function createWorkspace(root: string): { workspaceRoot: string; appRoot: string; cliRoot: string } {
  const workspaceRoot = join(root, "workspace");
  const appRoot = join(workspaceRoot, "apps", "desktop");
  const cliRoot = join(workspaceRoot, "packages", "cli");
  mkdirSync(join(appRoot, "bin"), { recursive: true });
  mkdirSync(cliRoot, { recursive: true });
  writeJson(join(workspaceRoot, "package.json"), { workspaces: ["apps/*", "packages/*"] });
  writeJson(join(appRoot, "package.json"), { name: "@scout/app" });
  writeFileSync(join(appRoot, "bin", "scout.ts"), "#!/usr/bin/env bun\n");
  return { workspaceRoot, appRoot, cliRoot };
}

function createExternalModuleDirectory(root: string): string {
  const moduleDirectory = join(root, "global", "node_modules", "@openscout", "cli", "dist");
  mkdirSync(moduleDirectory, { recursive: true });
  return moduleDirectory;
}

function createInstalledCliPackage(root: string): { packageRoot: string; moduleDirectory: string } {
  const packageRoot = join(root, "node_modules", "@openscout", "scout");
  const moduleDirectory = join(packageRoot, "dist");
  mkdirSync(moduleDirectory, { recursive: true });
  writeJson(join(packageRoot, "package.json"), { name: "@openscout/scout" });
  return { packageRoot, moduleDirectory };
}

const cleanupDirectories: string[] = [];

afterEach(() => {
  while (cleanupDirectories.length > 0) {
    const directory = cleanupDirectories.pop();
    if (!directory) {
      continue;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("shared path resolution", () => {
  test("resolves the workspace root from the requested current directory", () => {
    const fixtureRoot = makeFixtureRoot();
    cleanupDirectories.push(fixtureRoot);
    const { workspaceRoot, cliRoot } = createWorkspace(fixtureRoot);
    const moduleDirectory = createExternalModuleDirectory(fixtureRoot);

    const resolved = resolveScoutWorkspaceRoot({
      currentDirectory: cliRoot,
      env: {},
      moduleDirectory,
    });

    expect(resolved).toBe(workspaceRoot);
  });

  test("resolves the source app root to apps/desktop for installed CLI builds", () => {
    const fixtureRoot = makeFixtureRoot();
    cleanupDirectories.push(fixtureRoot);
    const { appRoot, cliRoot } = createWorkspace(fixtureRoot);
    const moduleDirectory = createExternalModuleDirectory(fixtureRoot);

    const resolved = resolveScoutAppRoot({
      currentDirectory: cliRoot,
      env: {},
      moduleDirectory,
    });

    expect(resolved).toBe(appRoot);
  });

  test("resolves installed CLI package roots from the installed module location", () => {
    const fixtureRoot = makeFixtureRoot();
    cleanupDirectories.push(fixtureRoot);
    const { packageRoot, moduleDirectory } = createInstalledCliPackage(fixtureRoot);

    const resolved = resolveScoutAppRoot({
      currentDirectory: fixtureRoot,
      env: {},
      moduleDirectory,
    });

    expect(resolved).toBe(packageRoot);
  });
});
