import type { ScoutCommandContext } from "../context.ts";
import { defaultScoutContextDirectory } from "../context.ts";
import { parseContextRootCommandOptions } from "../options.ts";
import { loadScoutRuntimesReport } from "../../core/setup/service.ts";
import { renderScoutRuntimesReport } from "../../ui/terminal/setup.ts";

export async function runRuntimesCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    context.output.writeText("Usage: scout runtimes [--context-root <path>] [--json]\n\nShow configured runtimes, readiness, models, and reasoning efforts.");
    return;
  }
  const options = parseContextRootCommandOptions("runtimes", args, defaultScoutContextDirectory(context));
  const report = await loadScoutRuntimesReport(options.currentDirectory);
  context.output.writeValue(report, renderScoutRuntimesReport);
}
