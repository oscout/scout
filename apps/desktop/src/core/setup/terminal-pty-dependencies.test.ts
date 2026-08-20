import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { inspectScoutTerminalPtyDependencies } from "./terminal-pty-dependencies.ts";

const testDirectories = new Set<string>();

afterEach(() => {
  for (const directory of testDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  testDirectories.clear();
});

function createExecutable(directory: string, name: string): string {
  const path = join(directory, name);
  writeFileSync(path, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(path, 0o755);
  return path;
}

function createNodeDirectory(prefix: string): { directory: string; nodePath: string } {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  testDirectories.add(directory);
  const nodePath = createExecutable(directory, "node");
  return { directory, nodePath };
}

const NODE_PTY = "/pkg/node_modules/@lydell/node-pty/index.js";
const BINDING = "/pkg/node_modules/@lydell/node-pty-darwin-arm64/lib/index.js";

function resolveEverything(specifier: string): string | null {
  if (specifier === "@lydell/node-pty") return NODE_PTY;
  if (specifier.startsWith("@lydell/node-pty-")) return BINDING;
  return null;
}

describe("terminal PTY dependencies", () => {
  test("reports missing-node when node is not on PATH", () => {
    const directory = mkdtempSync(join(tmpdir(), "openscout-pty-nonode-"));
    testDirectories.add(directory);

    const report = inspectScoutTerminalPtyDependencies({
      env: { PATH: directory },
      platform: "darwin",
      arch: "arm64",
      commonDirectories: [],
      resolveModule: resolveEverything,
      runCommand: () => ({ status: 0, stdout: "", stderr: "" }),
    });

    expect(report.status).toBe("missing-node");
    expect(report.nodePath).toBeNull();
    expect(report.installCommand).toBe("brew install node");
    expect(report.bindingPackage).toBe("@lydell/node-pty-darwin-arm64");
  });

  test("reports missing-binding when the platform package cannot be resolved", () => {
    const { directory, nodePath } = createNodeDirectory("openscout-pty-nobinding-");

    const report = inspectScoutTerminalPtyDependencies({
      env: { PATH: directory },
      platform: "darwin",
      arch: "arm64",
      commonDirectories: [],
      resolveModule: (specifier) =>
        specifier === "@lydell/node-pty" ? NODE_PTY : null,
      runCommand: (_command, args) => {
        if (args[0] === "--version") {
          return { status: 0, stdout: "v20.11.0\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    expect(report.status).toBe("missing-binding");
    expect(report.nodePath).toBe(nodePath);
    expect(report.nodePtyPath).toBe(NODE_PTY);
    expect(report.bindingPath).toBeNull();
    expect(report.detail).toContain("@lydell/node-pty-darwin-arm64 is not installed");
  });

  test("reports ready when the PTY smoke check exits cleanly", () => {
    const { directory, nodePath } = createNodeDirectory("openscout-pty-ready-");
    const calls: string[][] = [];

    const report = inspectScoutTerminalPtyDependencies({
      env: { PATH: directory },
      platform: "darwin",
      arch: "arm64",
      commonDirectories: [],
      resolveModule: resolveEverything,
      runCommand: (command, args) => {
        calls.push([command, ...args]);
        if (args[0] === "--version") {
          return { status: 0, stdout: "v20.11.0\n", stderr: "" };
        }
        return { status: 0, stdout: JSON.stringify({ ok: true, exitCode: 0 }), stderr: "" };
      },
    });

    expect(report.status).toBe("ready");
    expect(report.nodePath).toBe(nodePath);
    expect(report.nodeVersion).toBe("v20.11.0");
    expect(report.bindingPath).toBe(BINDING);
    expect(report.detail).toContain("v20.11.0");
    expect(calls.some((call) => call.includes("-e"))).toBe(true);
  });

  test("reports load-failed with the verbatim error when require throws", () => {
    const { directory } = createNodeDirectory("openscout-pty-load-");

    const report = inspectScoutTerminalPtyDependencies({
      env: { PATH: directory },
      platform: "darwin",
      arch: "arm64",
      commonDirectories: [],
      resolveModule: resolveEverything,
      runCommand: (_command, args) => {
        if (args[0] === "--version") {
          return { status: 0, stdout: "v20.11.0\n", stderr: "" };
        }
        return {
          status: 0,
          stdout: JSON.stringify({ ok: false, stage: "load", message: "dlopen failed: wrong architecture" }),
          stderr: "",
        };
      },
    });

    expect(report.status).toBe("load-failed");
    expect(report.detail).toContain("dlopen failed: wrong architecture");
    expect(report.detail).toContain("architecture mismatch");
  });

  test("reports spawn-failed when the PTY never exits", () => {
    const { directory } = createNodeDirectory("openscout-pty-spawn-");

    const report = inspectScoutTerminalPtyDependencies({
      env: { PATH: directory },
      platform: "darwin",
      arch: "arm64",
      commonDirectories: [],
      resolveModule: resolveEverything,
      runCommand: (_command, args) => {
        if (args[0] === "--version") {
          return { status: 0, stdout: "v20.11.0\n", stderr: "" };
        }
        return {
          status: 0,
          stdout: JSON.stringify({ ok: false, stage: "spawn", message: "PTY did not exit within the timeout" }),
          stderr: "",
        };
      },
    });

    expect(report.status).toBe("spawn-failed");
    expect(report.detail).toContain("PTY did not exit within the timeout");
  });
});
