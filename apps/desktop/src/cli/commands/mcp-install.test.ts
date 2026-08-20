import { describe, expect, test } from "bun:test";

import {
  installScoutMcpForHosts,
  parseMcpInstallCommandOptions,
} from "./mcp-install.ts";

describe("parseMcpInstallCommandOptions", () => {
  test("parses repeated hosts and flags", () => {
    const options = parseMcpInstallCommandOptions(
      ["--host", "codex", "--host=claude", "--force", "--dry-run"],
      process.env,
    );

    expect(options).toEqual({
      hosts: ["codex", "claude"],
      force: true,
      dryRun: true,
    });
  });
});

describe("installScoutMcpForHosts", () => {
  test("reports already-installed hosts without changing them", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const outcomes = installScoutMcpForHosts({
      env: process.env,
      hosts: ["codex", "claude"],
      force: false,
      dryRun: false,
      resolveHostPath: (host) => `/tmp/${host}`,
      resolveLaunchCommand: () => ({
        command: "/tmp/scout",
        args: ["mcp"],
      }),
      run: (command, args) => {
        calls.push({ command, args });
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    expect(outcomes).toEqual([
      {
        host: "codex",
        status: "already_installed",
        detail: "Codex already has a scout MCP entry.",
      },
      {
        host: "claude",
        status: "already_installed",
        detail: "Claude Code already has a scout MCP entry.",
      },
    ]);
    expect(calls).toEqual([
      { command: "/tmp/codex", args: ["mcp", "get", "scout"] },
      { command: "/tmp/claude", args: ["mcp", "get", "scout"] },
    ]);
  });

  test("replaces an existing Codex entry when forced", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const responses = [
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
    ];
    const outcomes = installScoutMcpForHosts({
      env: process.env,
      hosts: ["codex"],
      force: true,
      dryRun: false,
      resolveHostPath: () => "/tmp/codex",
      resolveLaunchCommand: () => ({
        command: "/tmp/scout",
        args: ["mcp"],
      }),
      run: (command, args) => {
        calls.push({ command, args });
        return responses.shift() ?? { status: 1, stdout: "", stderr: "unexpected call" };
      },
    });

    expect(outcomes).toEqual([
      {
        host: "codex",
        status: "installed",
        detail: "Installed scout MCP for Codex.",
      },
    ]);
    expect(calls).toEqual([
      { command: "/tmp/codex", args: ["mcp", "get", "scout"] },
      { command: "/tmp/codex", args: ["mcp", "remove", "scout"] },
      { command: "/tmp/codex", args: ["mcp", "add", "scout", "--", "/tmp/scout", "mcp"] },
    ]);
  });

  test("supports dry-run installs", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const outcomes = installScoutMcpForHosts({
      env: process.env,
      hosts: ["claude"],
      force: false,
      dryRun: true,
      resolveHostPath: () => "/tmp/claude",
      resolveLaunchCommand: () => ({
        command: "/tmp/scout",
        args: ["mcp"],
      }),
      run: (command, args) => {
        calls.push({ command, args });
        return { status: 1, stdout: "", stderr: "missing" };
      },
    });

    expect(outcomes).toEqual([
      {
        host: "claude",
        status: "installed",
        detail: "Would run: /tmp/claude mcp add --scope user scout -- /tmp/scout mcp",
      },
    ]);
    expect(calls).toEqual([
      { command: "/tmp/claude", args: ["mcp", "get", "scout"] },
    ]);
  });
});
