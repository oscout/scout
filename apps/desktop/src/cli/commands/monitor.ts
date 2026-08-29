import type { ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";
import { parseMonitorCommandOptions } from "../options.ts";
import { runScoutMonitorApp } from "../../ui/monitor/index.tsx";

const HELP_FLAGS = new Set(["--help", "-h", "help"]);

export function renderMonitorCommandHelp(): string {
  return [
    "Usage:",
    "  scout monitor [--channel <name>] [--limit <n>] [--interval <ms>]",
    "",
    "Launch the v1 OpenTUI console (ask, harness, tail).",
    "",
    "This is the original desktop terminal dashboard. It is retained for broker",
    "ask/harness work. The current TUI is `scout tui`.",
    "",
    "Examples:",
    "  scout monitor",
    "  scout monitor --channel shared --limit 20",
  ].join("\n");
}

export async function runMonitorCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  if (context.output.mode === "json") {
    throw new ScoutCliError("scout monitor does not support --json");
  }
  if (args.some((arg) => HELP_FLAGS.has(arg))) {
    context.output.writeText(renderMonitorCommandHelp());
    return;
  }

  const options = parseMonitorCommandOptions(args, context.cwd);
  await runScoutMonitorApp({
    currentDirectory: options.currentDirectory,
    channel: options.channel,
    limit: options.limit,
    refreshIntervalMs: options.intervalMs,
  });
}
