import type { ScoutCommandContext } from "../context.ts";
import { defaultScoutContextDirectory } from "../context.ts";
import { parseContextRootCommandOptions } from "../options.ts";
import { restartScoutAgents } from "../../core/agents/service.ts";
import { renderScoutRestartResult } from "../../ui/terminal/agents.ts";

export async function runRestartCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  const options = parseContextRootCommandOptions("restart", args, defaultScoutContextDirectory(context));
  const agents = await restartScoutAgents({
    currentDirectory: options.currentDirectory,
  });
  context.output.writeValue(agents, renderScoutRestartResult);
}
