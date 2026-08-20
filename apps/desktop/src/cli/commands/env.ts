import { existsSync } from "node:fs";
import { join } from "node:path";
import { findNearestProjectRoot } from "@openscout/runtime/setup";

import type { ScoutCommandContext } from "../context.ts";
import { defaultScoutContextDirectory } from "../context.ts";
import { parseContextRootCommandOptions } from "../options.ts";
import { resolveScoutBrokerUrl, resolveScoutSenderId } from "../../core/broker/service.ts";
import { resolveScoutAppRoot, resolveScoutWorkspaceRoot } from "../../shared/paths.ts";

type ScoutEnvReport = {
  executable: {
    command: string;
    fallbackCommand: string;
    scoutPath: string | null;
  };
  agent: {
    resolvedId: string;
    envAgent: string | null;
    projectRoot: string | null;
  };
  context: {
    cwd: string;
    currentDirectory: string;
    setupCwd: string | null;
    workspaceRoot: string;
    appRoot: string;
    binPath: string;
  };
  broker: {
    url: string;
  };
};

function resolveCommandOnPath(command: string, env: NodeJS.ProcessEnv): string | null {
  const pathValue = env.PATH ?? "";
  for (const directory of pathValue.split(":")) {
    const trimmed = directory.trim();
    if (!trimmed) {
      continue;
    }
    const candidate = join(trimmed, command);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolveScoutBinPath(appRoot: string): string {
  const candidates = [
    join(appRoot, "bin", "scout.ts"),
    join(appRoot, "bin", "scout.mjs"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[candidates.length - 1]!;
}

async function loadScoutEnvReport(
  context: ScoutCommandContext,
  currentDirectory: string,
): Promise<ScoutEnvReport> {
  const appRoot = resolveScoutAppRoot({
    currentDirectory,
    env: context.env,
  });
  const workspaceRoot = (() => {
    try {
      return resolveScoutWorkspaceRoot({
        currentDirectory,
        env: context.env,
      });
    } catch {
      return appRoot;
    }
  })();
  const binPath = resolveScoutBinPath(appRoot);
  const scoutPath = resolveCommandOnPath("scout", context.env);
  const fallbackCommand = `bun ${binPath}`;
  const resolvedId = await resolveScoutSenderId(null, currentDirectory, context.env);
  const projectRoot = await findNearestProjectRoot(currentDirectory);

  return {
    executable: {
      command: scoutPath ? "scout" : fallbackCommand,
      fallbackCommand,
      scoutPath,
    },
    agent: {
      resolvedId,
      envAgent: context.env.OPENSCOUT_AGENT?.trim() || null,
      projectRoot,
    },
    context: {
      cwd: context.cwd,
      currentDirectory,
      setupCwd: context.env.OPENSCOUT_SETUP_CWD?.trim() || null,
      workspaceRoot,
      appRoot,
      binPath,
    },
    broker: {
      url: resolveScoutBrokerUrl(),
    },
  };
}

function renderScoutEnvReport(report: ScoutEnvReport): string {
  return [
    `Command: ${report.executable.command}`,
    `Fallback: ${report.executable.fallbackCommand}`,
    `Agent: ${report.agent.resolvedId}`,
    `Current Directory: ${report.context.currentDirectory}`,
    `Broker: ${report.broker.url}`,
  ].join("\n");
}

export async function runEnvCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  const options = parseContextRootCommandOptions("env", args, defaultScoutContextDirectory(context));
  const report = await loadScoutEnvReport(context, options.currentDirectory);
  context.output.writeValue(report, renderScoutEnvReport);
}
