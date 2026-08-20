import { findNearestProjectRoot } from "@openscout/runtime/setup";
import {
  detectCodingAgentHost,
  OPENSCOUT_AGENT_DISCOVERY,
  PROJECT_AGENT_INSTRUCTION_CANDIDATES,
  type CodingAgentHostMatch,
  type OpenScoutAgentDiscovery,
} from "@openscout/runtime";
import { access } from "node:fs/promises";
import { join } from "node:path";

import type { ScoutCommandContext } from "../context.ts";
import { defaultScoutContextDirectory } from "../context.ts";
import { parseContextRootCommandOptions } from "../options.ts";
import {
  resolveScoutBrokerUrl,
  resolveScoutSenderId,
} from "../../core/broker/service.ts";

const HELP_FLAGS = new Set(["--help", "-h"]);

type ScoutWhoAmIReport = {
  defaultSenderId: string;
  envAgent: string | null;
  codingAgentHost: CodingAgentHostMatch | null;
  currentDirectory: string;
  projectRoot: string | null;
  projectAgentsMd: string | null;
  brokerUrl: string;
  discovery: OpenScoutAgentDiscovery;
};

async function resolveProjectAgentsMd(projectRoot: string | null): Promise<string | null> {
  if (!projectRoot) {
    return null;
  }

  for (const candidate of PROJECT_AGENT_INSTRUCTION_CANDIDATES) {
    const path = join(projectRoot, candidate);
    try {
      await access(path);
      return path;
    } catch {
      // try next candidate
    }
  }

  return null;
}

async function loadScoutWhoAmIReport(
  context: ScoutCommandContext,
  currentDirectory: string,
): Promise<ScoutWhoAmIReport> {
  const defaultSenderId = await resolveScoutSenderId(null, currentDirectory, context.env);
  const projectRoot = await findNearestProjectRoot(currentDirectory);

  return {
    defaultSenderId,
    envAgent: context.env.OPENSCOUT_AGENT?.trim() || null,
    codingAgentHost: detectCodingAgentHost(context.env),
    currentDirectory,
    projectRoot,
    projectAgentsMd: await resolveProjectAgentsMd(projectRoot),
    brokerUrl: resolveScoutBrokerUrl(),
    discovery: OPENSCOUT_AGENT_DISCOVERY,
  };
}

function renderScoutWhoAmIReport(report: ScoutWhoAmIReport): string {
  const lines = [
    `Default Sender: ${report.defaultSenderId}`,
    `Current Directory: ${report.currentDirectory}`,
  ];

  if (report.envAgent) {
    lines.push(`OPENSCOUT_AGENT: ${report.envAgent}`);
  }

  if (report.codingAgentHost) {
    lines.push(`Host Harness: ${report.codingAgentHost.harness} (${report.codingAgentHost.signal})`);
  }

  lines.push(`Broker: ${report.brokerUrl}`);

  if (report.projectRoot) {
    lines.push(`Project Root: ${report.projectRoot}`);
  }

  if (report.projectAgentsMd) {
    lines.push(`Project Instructions: ${report.projectAgentsMd}`);
  }

  lines.push(`Discovery: ${report.discovery.agentInstructions}`);

  return lines.join("\n");
}

export function renderWhoAmICommandHelp(): string {
  return [
    "Usage: scout whoami [--context-root <path>] [--json]",
    "",
    "Show the current Scout sender and broker context.",
    "",
    "The report includes the default sender id, current directory, nearest Scout project root when found,",
    "OPENSCOUT_AGENT when it overrides the sender, detected host harness signals (Cursor, Claude Code, Codex),",
    "the broker URL the CLI will contact, OpenScout discovery URLs, and the nearest project AGENTS.md path when found.",
    "",
    "Examples:",
    "  scout whoami",
    "  scout whoami --context-root ~/dev/openscout --json",
  ].join("\n");
}

export async function runWhoAmICommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  if (args.some((arg) => HELP_FLAGS.has(arg))) {
    context.output.writeText(renderWhoAmICommandHelp());
    return;
  }

  const options = parseContextRootCommandOptions("whoami", args, defaultScoutContextDirectory(context));
  const report = await loadScoutWhoAmIReport(context, options.currentDirectory);
  context.output.writeValue(report, renderScoutWhoAmIReport);
}
