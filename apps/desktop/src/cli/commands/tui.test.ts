import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { createScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";
import {
  parseTuiLaunchOptions,
  renderTuiCommandHelp,
  resolveScoutTuiLaunch,
  runTuiCommand,
} from "./tui.ts";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeExecutable(path: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

describe("scout tui", () => {
  test("documents the night instrument launch", () => {
    const help = renderTuiCommandHelp();
    expect(help).toContain("scout tui");
    expect(help).toContain("--take");
    expect(help).toContain("scout monitor");
    expect(help).not.toContain("--monitor");
    expect(help).toContain("SCOUT_TUI_BIN");
  });

  test("defaults to the TUI and treats --monitor as a retired alias", () => {
    expect(parseTuiLaunchOptions([])).toEqual({ mode: "instrument", passthrough: [] });
    expect(parseTuiLaunchOptions(["--take", "mesh"])).toEqual({
      mode: "instrument",
      passthrough: ["--take", "mesh"],
    });
    expect(parseTuiLaunchOptions(["--monitor", "--limit", "8"])).toEqual({
      mode: "monitor",
      args: ["--limit", "8"],
    });
    expect(parseTuiLaunchOptions(["monitor"])).toEqual({
      mode: "monitor",
      args: [],
    });
    expect(parseTuiLaunchOptions(["--help"])).toEqual({ mode: "help" });
  });

  test("prefers SCOUT_TUI_BIN when it is executable", () => {
    const dir = tempDir("openscout-tui-bin-");
    const bin = writeExecutable(join(dir, "scout-tui"));
    expect(resolveScoutTuiLaunch({
      env: { SCOUT_TUI_BIN: bin, PATH: "" },
      cwd: dir,
    })).toEqual({ kind: "bin", command: bin, args: [] });
  });

  test("uses the checkout release binary before cargo run", () => {
    const root = tempDir("openscout-tui-checkout-");
    mkdirSync(join(root, "crates/scout-tui"), { recursive: true });
    writeFileSync(join(root, "crates/scout-tui/Cargo.toml"), "[package]\nname = \"scout-tui\"\n");
    const bin = writeExecutable(join(root, "target/release/scout-tui"));
    expect(resolveScoutTuiLaunch({
      env: { PATH: "" },
      cwd: join(root, "crates/scout-tui"),
    })).toEqual({ kind: "bin", command: bin, args: [] });
  });

  test("falls back to cargo run from a checkout without a built binary", () => {
    const root = tempDir("openscout-tui-cargo-");
    mkdirSync(join(root, "crates/scout-tui"), { recursive: true });
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "crates/scout-tui/Cargo.toml"), "[package]\nname = \"scout-tui\"\n");
    const cargo = writeExecutable(join(root, "scripts/cargo.sh"));
    expect(resolveScoutTuiLaunch({
      env: { PATH: "" },
      cwd: root,
    })).toEqual({
      kind: "cargo",
      command: cargo,
      args: [
        "run",
        "--manifest-path",
        "crates/scout-tui/Cargo.toml",
        "--bin",
        "scout-tui",
      ],
      cwd: root,
    });
  });

  test("rejects --json and launches the resolved binary with passthrough args", async () => {
    const dir = tempDir("openscout-tui-run-");
    const bin = writeExecutable(join(dir, "scout-tui"));
    const jsonContext = createScoutCommandContext({
      env: { SCOUT_TUI_BIN: bin },
      outputMode: "json",
    });
    await expect(runTuiCommand(jsonContext, [])).rejects.toThrow(ScoutCliError);

    const calls: Array<{ command: string; args: string[] }> = [];
    const context = createScoutCommandContext({
      env: { SCOUT_TUI_BIN: bin, PATH: "" },
      cwd: dir,
    });
    await runTuiCommand(context, ["--take", "quota"], {
      spawnSync: ((command: string, args?: readonly string[]) => {
        calls.push({ command, args: [...(args ?? [])] });
        return { status: 0, signal: null, error: undefined, pid: 0, output: [], stdout: "", stderr: "" };
      }) as unknown as typeof import("node:child_process").spawnSync,
      exit: () => {
        throw new Error("should not exit on success");
      },
    });
    expect(calls).toEqual([{ command: bin, args: ["--take", "quota"] }]);
  });
});
