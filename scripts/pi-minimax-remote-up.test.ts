import { describe, expect, test } from "bun:test";

import {
  parseArgs,
  remoteLoginCommand,
  remoteLinuxCredentialPresenceScript,
  remoteLinuxCredentialProvisionScript,
  remoteShellCommand,
  remoteSecretPresenceScript,
  shellQuote,
  validateSshHost,
} from "./pi-minimax-remote-up.mjs";

describe("remote Pi MiniMax bootstrap", () => {
  test("requires an explicit host and absolute remote project", () => {
    expect(() => parseArgs(["--project", "/Users/worker/dev/project"])).toThrow("--host");
    expect(() => parseArgs(["--host", "worker", "--project", "relative"])).toThrow("absolute");
  });

  test("rejects SSH option and shell injection in the host", () => {
    expect(() => validateSshHost("-oProxyCommand=bad")).toThrow("--host");
    expect(() => validateSshHost("-V")).toThrow("--host");
    expect(() => validateSshHost("-Fattacker-config")).toThrow("--host");
    expect(() => validateSshHost("worker; touch /tmp/nope")).toThrow("--host");
    expect(validateSshHost("arach@air.local")).toBe("arach@air.local");
  });

  test("builds a quoted remote login command", () => {
    const command = remoteLoginCommand(["scout", "card", "create", "/Users/worker/Project's files"]);
    expect(command).toContain("sh -lc");
    expect(command).toContain("Project");
    expect(command).not.toContain("Project's files'");
    expect(shellQuote("a'b")).toBe("'a'\"'\"'b'");
  });

  test("uses the portable POSIX shell for Linux bootstrap scripts", () => {
    expect(remoteShellCommand("test -s \"$HOME/key\"")).toStartWith("sh -lc ");
    expect(remoteShellCommand("true")).not.toContain("zsh");
  });

  test("keeps secret provisioning explicit in the plan", () => {
    const parsed = parseArgs([
      "--host", "air",
      "--project", "/Users/worker/dev/openscout",
      "--name", "minimax-air",
      "--install-pi",
      "--provision-key",
      "--dry-run",
    ]);
    expect(parsed).toMatchObject({
      host: "air",
      project: "/Users/worker/dev/openscout",
      agentName: "minimax-air",
      installPi: true,
      provisionKey: true,
      dryRun: true,
    });
  });

  test("supports an existing edge-authenticated provider without provisioning a key", () => {
    const parsed = parseArgs([
      "--host", "remote-node.example.com",
      "--project", "/home/exedev/scout-ocean-agent",
      "--name", "ocean-minimax",
      "--provider", "minimax-byok-anthropic",
      "--edge-authenticated",
      "--dry-run",
    ]);
    expect(parsed).toMatchObject({
      provider: "minimax-byok-anthropic",
      edgeAuthenticated: true,
      provisionKey: false,
    });
    expect(() => parseArgs([
      "--host", "remote-node.example.com",
      "--project", "/home/exedev/scout-ocean-agent",
      "--edge-authenticated",
      "--provision-key",
    ])).toThrow("mutually exclusive");
  });

  test("checks remote credential presence without transporting its value", () => {
    expect(remoteSecretPresenceScript()).toBe(
      "secret get MINIMAX_API_KEY >/dev/null 2>&1",
    );
    expect(remoteLinuxCredentialPresenceScript()).toBe(
      'test -s "$HOME/.config/openscout/credentials/MINIMAX_API_KEY"',
    );
  });

  test("provisions the Linux credential from stdin with private permissions", () => {
    const script = remoteLinuxCredentialProvisionScript();
    expect(script).toContain("umask 077");
    expect(script).toContain("dd of=");
    expect(script).toContain("chmod 600");
    expect(script).not.toContain("mktemp");
    expect(script).not.toContain("MINIMAX_API_KEY=");
  });
});
