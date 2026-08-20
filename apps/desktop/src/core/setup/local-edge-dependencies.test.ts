import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  ensureScoutLocalEdgeTrust,
  ensureScoutLocalEdgeDependencies,
  inspectScoutLocalEdgeDependencies,
} from "./local-edge-dependencies.ts";

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

function createCaddyRoot(directory: string): string {
  const path = join(directory, "Library", "Application Support", "Caddy", "pki", "authorities", "local", "root.crt");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "test root\n", "utf8");
  return path;
}

describe("local edge dependencies", () => {
  test("reports Caddy as ready when it is on PATH", () => {
    const directory = mkdtempSync(join(tmpdir(), "openscout-caddy-ready-"));
    testDirectories.add(directory);
    const caddyPath = createExecutable(directory, "caddy");

    const report = inspectScoutLocalEdgeDependencies({
      env: { PATH: directory, HOME: directory },
      commonDirectories: [],
      runCommand: () => ({ status: 0, stdout: "v2.10.2 h1:test\n", stderr: "" }),
    });

    expect(report.status).toBe("ready");
    expect(report.caddyPath).toBe(caddyPath);
    expect(report.caddyVersion).toBe("v2.10.2 h1:test");
    expect(report.trust.status).toBe("unavailable");
  });

  test("installs Caddy with Homebrew on macOS when missing", () => {
    const directory = mkdtempSync(join(tmpdir(), "openscout-caddy-install-"));
    testDirectories.add(directory);
    createExecutable(directory, "brew");
    const calls: string[] = [];

    const report = ensureScoutLocalEdgeDependencies({
      env: { PATH: directory, HOME: directory },
      platform: "darwin",
      commonDirectories: [],
      runCommand: (command, args) => {
        calls.push([command, ...args].join(" "));
        if (args[0] === "install" && args[1] === "caddy") {
          createExecutable(directory, "caddy");
          return { status: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "version") {
          return { status: 0, stdout: "v2.10.2 h1:test\n", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: "unexpected command" };
      },
    });

    expect(report.status).toBe("installed");
    expect(report.caddyPath).toBe(join(directory, "caddy"));
    expect(report.installCommand).toBe("brew install caddy");
    expect(report.trust.status).toBe("unavailable");
    expect(calls.some((call) => call.endsWith("brew install caddy"))).toBe(true);
  });

  test("trusts the Caddy root through macOS authorization when the root exists", () => {
    const directory = mkdtempSync(join(tmpdir(), "openscout-caddy-trust-"));
    testDirectories.add(directory);
    const rootPath = createCaddyRoot(directory);
    let trusted = false;
    const calls: string[] = [];

    const report = ensureScoutLocalEdgeTrust({
      env: { PATH: directory, HOME: directory },
      platform: "darwin",
      commonDirectories: [],
      runCommand: (command, args) => {
        calls.push([command, ...args].join(" "));
        if (command === "security" && args[0] === "verify-cert") {
          return trusted
            ? { status: 0, stdout: "", stderr: "" }
            : { status: 1, stdout: "", stderr: "not trusted" };
        }
        if (command === "osascript") {
          expect(args.join(" ")).toContain(rootPath);
          trusted = true;
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: "unexpected command" };
      },
    });

    expect(report.status).toBe("installed");
    expect(report.rootCertificatePath).toBe(rootPath);
    expect(calls.some((call) => call.startsWith("osascript "))).toBe(true);
  });

  test("does not attempt automatic install outside macOS", () => {
    const directory = mkdtempSync(join(tmpdir(), "openscout-caddy-linux-"));
    testDirectories.add(directory);
    let calls = 0;

    const report = ensureScoutLocalEdgeDependencies({
      env: { PATH: directory, HOME: directory },
      platform: "linux",
      commonDirectories: [],
      runCommand: () => {
        calls += 1;
        return { status: 1, stdout: "", stderr: "" };
      },
    });

    expect(report.status).toBe("skipped");
    expect(report.caddyPath).toBeNull();
    expect(calls).toBe(0);
  });
});
