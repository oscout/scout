import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import {
  resolveCodexExecutableCandidates,
  resolveCodexExecutableInventory,
} from "./codex-executable.js";

const tempPaths = new Set<string>();

afterEach(() => {
  for (const path of tempPaths) {
    rmSync(path, { recursive: true, force: true });
  }
  tempPaths.clear();
});

function fakeCodex(directory: string, version: string): string {
  const executablePath = join(directory, "codex");
  writeFileSync(executablePath, `#!/usr/bin/env bun
if (process.argv.includes("--version")) {
  console.log("codex-cli ${version}");
  process.exit(0);
}
console.log("fake codex");
`);
  chmodSync(executablePath, 0o755);
  return executablePath;
}

describe("Codex executable inventory", () => {
  test("keeps explicit Codex binary overrides first", () => {
    expect(resolveCodexExecutableCandidates({
      HOME: "/Users/tester",
      PATH: "/custom/bin",
      OPENSCOUT_CODEX_BIN: "/explicit/codex",
      CODEX_BIN: "/fallback/codex",
    }).slice(0, 2)).toEqual([
      "/explicit/codex",
      "/fallback/codex",
    ]);
  });

  test("inventories discovered PATH executable versions", () => {
    const oldPathRoot = mkdtempSync(join(tmpdir(), "openscout-codex-path-old-"));
    const newPathRoot = mkdtempSync(join(tmpdir(), "openscout-codex-path-new-"));
    tempPaths.add(oldPathRoot);
    tempPaths.add(newPathRoot);
    const oldPathBin = fakeCodex(oldPathRoot, "0.121.0");
    const newPathBin = fakeCodex(newPathRoot, "0.128.0-alpha.1");

    const inventory = resolveCodexExecutableInventory({
      HOME: "/Users/tester",
      PATH: [oldPathRoot, newPathRoot].join(delimiter),
      OPENSCOUT_CODEX_BIN: "",
      CODEX_BIN: "",
    });

    expect(inventory.candidates.find((candidate) => candidate.path === newPathBin)?.version).toBe("0.128.0-alpha.1");
    expect(inventory.candidates.find((candidate) => candidate.path === oldPathBin)?.version).toBe("0.121.0");
  });

  test("discovers Codex bundled in ChatGPT.app when PATH is empty", () => {
    const homeRoot = mkdtempSync(join(tmpdir(), "openscout-codex-chatgpt-home-"));
    tempPaths.add(homeRoot);
    const bundleResources = join(homeRoot, "Applications", "ChatGPT.app", "Contents", "Resources");
    mkdirSync(bundleResources, { recursive: true });
    const bundledBin = fakeCodex(bundleResources, "999.0.0");

    const inventory = resolveCodexExecutableInventory({
      HOME: homeRoot,
      PATH: "",
      OPENSCOUT_CODEX_BIN: "",
      CODEX_BIN: "",
    });

    expect(inventory.selectedPath).toBe(bundledBin);
    expect(inventory.selected?.source).toBe("codex_app_bundle");
  });

  test("prefers an explicit executable even when PATH has a newer one", () => {
    const explicitRoot = mkdtempSync(join(tmpdir(), "openscout-codex-explicit-"));
    const pathRoot = mkdtempSync(join(tmpdir(), "openscout-codex-path-"));
    tempPaths.add(explicitRoot);
    tempPaths.add(pathRoot);
    const explicitBin = fakeCodex(explicitRoot, "0.121.0");
    fakeCodex(pathRoot, "0.200.0");

    const inventory = resolveCodexExecutableInventory({
      HOME: "/Users/tester",
      PATH: pathRoot,
      OPENSCOUT_CODEX_BIN: explicitBin,
    });

    expect(inventory.selectedPath).toBe(explicitBin);
  });
});
