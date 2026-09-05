import type { ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";

const HELP_FLAGS = new Set(["--help", "-h", "help"]);

export function renderMonitorCommandHelp(): string {
  return [
    "Usage:",
    "  scout monitor",
    "",
    "The legacy v1 OpenTUI console (`scout monitor`) has been retired.",
    "Use `scout tui` for the terminal instrument.",
    "",
    "Examples:",
    "  scout tui",
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

  context.stderr("`scout monitor` (the legacy v1 OpenTUI console) has been retired. Use `scout tui`.");
  context.output.writeText(renderMonitorCommandHelp());
}
