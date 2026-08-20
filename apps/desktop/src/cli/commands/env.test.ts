import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeProjectConfig } from "@openscout/runtime/setup";

import { createScoutCommandContext } from "../context.ts";
import { runEnvCommand } from "./env.ts";
import { runWhoAmICommand } from "./whoami.ts";

const originalHome = process.env.HOME;
const originalSupportDirectory = process.env.OPENSCOUT_SUPPORT_DIRECTORY;
const originalControlHome = process.env.OPENSCOUT_CONTROL_HOME;
const originalRelayHub = process.env.OPENSCOUT_RELAY_HUB;
const originalBrokerUrl = process.env.OPENSCOUT_BROKER_URL;
const testDirectories = new Set<string>();

afterEach(() => {
  process.env.HOME = originalHome;
  if (originalSupportDirectory === undefined) {
    delete process.env.OPENSCOUT_SUPPORT_DIRECTORY;
  } else {
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = originalSupportDirectory;
  }
  if (originalControlHome === undefined) {
    delete process.env.OPENSCOUT_CONTROL_HOME;
  } else {
    process.env.OPENSCOUT_CONTROL_HOME = originalControlHome;
  }
  if (originalRelayHub === undefined) {
    delete process.env.OPENSCOUT_RELAY_HUB;
  } else {
    process.env.OPENSCOUT_RELAY_HUB = originalRelayHub;
  }
  if (originalBrokerUrl === undefined) {
    delete process.env.OPENSCOUT_BROKER_URL;
  } else {
    process.env.OPENSCOUT_BROKER_URL = originalBrokerUrl;
  }
  for (const directory of testDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  testDirectories.clear();
});

function useIsolatedOpenScoutHome(): string {
  const home = mkdtempSync(join(tmpdir(), "openscout-cli-env-"));
  testDirectories.add(home);
  process.env.HOME = home;
  process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(home, "Library", "Application Support", "OpenScout");
  process.env.OPENSCOUT_CONTROL_HOME = join(home, ".openscout", "control-plane");
  process.env.OPENSCOUT_RELAY_HUB = join(home, ".openscout", "relay");
  process.env.OPENSCOUT_BROKER_URL = "http://broker.test";
  return home;
}

async function runCommandJson(
  handler: (context: ReturnType<typeof createScoutCommandContext>, args: string[]) => Promise<void>,
  input: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    args?: string[];
  },
): Promise<unknown> {
  const lines: string[] = [];
  const context = createScoutCommandContext({
    cwd: input.cwd,
    env: input.env,
    outputMode: "json",
    stdout(line) {
      lines.push(line);
    },
  });

  await handler(context, input.args ?? []);

  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!);
}

describe("runEnvCommand", () => {
  test("reports the same resolved sender as whoami inside a project", async () => {
    const home = useIsolatedOpenScoutHome();
    const projectRoot = join(home, "dev", "sample");

    mkdirSync(join(projectRoot, ".git"), { recursive: true });
    await writeProjectConfig(projectRoot, {
      version: 1,
      project: {
        id: "sample",
        name: "Sample",
      },
      agent: {
        id: "sample",
      },
    });

    const envReport = await runCommandJson(runEnvCommand, { cwd: projectRoot }) as {
      agent: { resolvedId: string; projectRoot: string | null };
    };
    const whoamiReport = await runCommandJson(runWhoAmICommand, { cwd: projectRoot }) as {
      defaultSenderId: string;
      projectRoot: string | null;
    };

    expect(envReport.agent.resolvedId).toBe(whoamiReport.defaultSenderId);
    expect(envReport.agent.projectRoot).toBe(whoamiReport.projectRoot);
  });

  test("respects OPENSCOUT_AGENT from the command context env", async () => {
    const home = useIsolatedOpenScoutHome();
    const scratch = join(home, "scratch");
    mkdirSync(scratch, { recursive: true });

    const env = {
      ...process.env,
      OPENSCOUT_AGENT: "vox.main.mini",
    };

    const envReport = await runCommandJson(runEnvCommand, { cwd: scratch, env }) as {
      agent: { resolvedId: string; envAgent: string | null };
    };
    const whoamiReport = await runCommandJson(runWhoAmICommand, { cwd: scratch, env }) as {
      defaultSenderId: string;
      envAgent: string | null;
    };

    expect(envReport.agent.resolvedId).toBe("vox.main.mini");
    expect(envReport.agent.envAgent).toBe("vox.main.mini");
    expect(whoamiReport.defaultSenderId).toBe("vox.main.mini");
    expect(whoamiReport.envAgent).toBe("vox.main.mini");
  });
});
