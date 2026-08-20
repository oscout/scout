import type { ScoutCommandContext } from "../context.ts";
import { defaultScoutContextDirectory } from "../context.ts";
import { parseWatchCommandOptions } from "../options.ts";
import {
  loadScoutMessages,
  watchScoutMessages,
  type ScoutBrokerMessageRecord,
} from "../../core/broker/service.ts";
import {
  renderScoutMessage,
  renderScoutMessageList,
} from "../../ui/terminal/broker.ts";

const HELP_FLAGS = new Set(["--help", "-h"]);

export function renderWatchCommandHelp(): string {
  return [
    "Usage: scout watch [--channel <name> | --conversation <id>] [--since <time>] [--limit <count>] [--once] [--json]",
    "",
    "Stream Scout broker messages as they arrive.",
    "",
    "Filters:",
    "  --channel <name>                  -> watch one channel; defaults to shared",
    "  --conversation <id>               -> watch one conversation or ask thread directly",
    "  --since <time>                    -> first print backlog since a timestamp, date, or duration like 10m, 1h, 2d",
    "  --limit <count>                   -> first print at most this many backlog messages",
    "  --once                            -> print the requested backlog and exit instead of streaming",
    "",
    "--channel and --conversation are mutually exclusive.",
    "",
    "Examples:",
    "  scout watch",
    "  scout watch --channel triage",
    "  scout watch --conversation dm.operator.hudson",
    "  scout watch --since 1h --limit 25 --once --json",
  ].join("\n");
}

export async function runWatchCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  if (args.some((arg) => HELP_FLAGS.has(arg))) {
    context.output.writeText(renderWatchCommandHelp());
    return;
  }

  const options = parseWatchCommandOptions(args, defaultScoutContextDirectory(context));
  const emitMessage = (message: ScoutBrokerMessageRecord) => {
    if (context.output.mode === "json") {
      context.stdout(JSON.stringify(message));
      return;
    }
    context.output.writeValue(message, renderScoutMessage);
  };

  if (options.since || options.limit) {
    const backlog = await loadScoutMessages({
      channel: options.channel,
      conversationId: options.conversationId,
      since: options.since,
      limit: options.limit,
    });
    if (options.once) {
      context.output.writeValue(backlog, renderScoutMessageList);
      return;
    }
    for (const message of backlog) {
      emitMessage(message);
    }
  }

  const controller = new AbortController();
  const shutdown = () => controller.abort();
  process.on("SIGINT", shutdown);

  try {
    if (context.output.mode === "plain") {
      context.stdout(`Watching ${options.conversationId ?? options.channel?.trim() ?? "shared"}`);
    }
    await watchScoutMessages({
      channel: options.channel,
      conversationId: options.conversationId,
      signal: controller.signal,
      onMessage(message) {
        emitMessage(message);
      },
    });
  } finally {
    process.off("SIGINT", shutdown);
  }
}
