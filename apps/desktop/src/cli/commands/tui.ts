import type { ScoutCommandContext } from "../context.ts";
import { parseTuiCommandOptions } from "../options.ts";
import { runScoutMonitorApp } from "../../ui/monitor/index.tsx";

export async function runTuiCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  if (context.output.mode === "json") {
    throw new Error("scout tui does not support --json");
  }

  const options = parseTuiCommandOptions(args, context.cwd);

  await runScoutMonitorApp({
    currentDirectory: options.currentDirectory,
    channel: options.channel,
    limit: options.limit,
    refreshIntervalMs: options.intervalMs,
  });
}
