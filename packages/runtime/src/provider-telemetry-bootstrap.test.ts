import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readManagedInstalls } from "./managed-installs.js";
import { resolveClaudeStatuslineDelegatePath } from "./claude-statusline.js";
import { ensureProviderTelemetryBootstrap } from "./provider-telemetry-bootstrap.js";

const originalHome = process.env.HOME;
const originalSupportDirectory = process.env.OPENSCOUT_SUPPORT_DIRECTORY;
const originalScoutCommand = process.env.OPENSCOUT_SCOUT_COMMAND;
const originalTelemetryBootstrap = process.env.OPENSCOUT_PROVIDER_TELEMETRY_BOOTSTRAP;
const testDirectories = new Set<string>();

afterEach(() => {
  process.env.HOME = originalHome;
  if (originalSupportDirectory === undefined) {
    delete process.env.OPENSCOUT_SUPPORT_DIRECTORY;
  } else {
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = originalSupportDirectory;
  }
  if (originalScoutCommand === undefined) {
    delete process.env.OPENSCOUT_SCOUT_COMMAND;
  } else {
    process.env.OPENSCOUT_SCOUT_COMMAND = originalScoutCommand;
  }
  if (originalTelemetryBootstrap === undefined) {
    delete process.env.OPENSCOUT_PROVIDER_TELEMETRY_BOOTSTRAP;
  } else {
    process.env.OPENSCOUT_PROVIDER_TELEMETRY_BOOTSTRAP = originalTelemetryBootstrap;
  }

  for (const directory of testDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  testDirectories.clear();
});

function useTempHome(prefix: string): string {
  const home = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  testDirectories.add(home);
  process.env.HOME = home;
  process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(home, "Library", "Application Support", "OpenScout");
  process.env.OPENSCOUT_SCOUT_COMMAND = "scout";
  mkdirSync(home, { recursive: true });
  return home;
}

describe("provider telemetry bootstrap", () => {
  test("does not create Claude settings when Claude has no local config", async () => {
    const home = useTempHome("openscout-provider-telemetry-no-claude");
    const settingsPath = join(home, ".claude", "settings.json");

    const report = await ensureProviderTelemetryBootstrap();

    expect(report.claude).toEqual(expect.objectContaining({
      settingsPath,
      status: "skipped",
      reason: "settings-missing",
    }));
    expect(report.statuslineLatest.status).toBe("missing");
    expect(existsSync(settingsPath)).toBe(false);
  });

  test("installs Claude statusline capture and preserves the current statusline as delegate", async () => {
    const home = useTempHome("openscout-provider-telemetry-claude");
    const settingsPath = join(home, ".claude", "settings.json");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      statusLine: {
        type: "command",
        command: "bun ~/.claude/statusline/index.ts",
        padding: 1,
      },
    }, null, 2), "utf8");

    const report = await ensureProviderTelemetryBootstrap();
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      statusLine: Record<string, unknown>;
    };
    const delegate = JSON.parse(readFileSync(resolveClaudeStatuslineDelegatePath(), "utf8")) as {
      command: string;
      statusLine: Record<string, unknown>;
    };
    const installs = await readManagedInstalls();

    expect(report.claude.status).toBe("installed");
    expect(report.claude.previousCommand).toBe("bun ~/.claude/statusline/index.ts");
    expect(settings.statusLine.command).toBe(`'${report.claude.wrapperPath}'`);
    expect(settings.statusLine.padding).toBe(1);
    expect(delegate.command).toBe("bun ~/.claude/statusline/index.ts");
    expect(delegate.statusLine.padding).toBe(1);
    expect(installs.find((entry) => entry.name === "claude-statusline")).toEqual(expect.objectContaining({
      kind: "statusline",
      owner: "openscout",
      status: "active",
    }));
  });
});
