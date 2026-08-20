import type { ScoutCommandContext } from "../context.ts";
import { defaultScoutContextDirectory } from "../context.ts";
import { parseLatestCommandOptions } from "../options.ts";
import {
  loadScoutActivityItems,
  loadScoutMessages,
  scoutConversationIdForChannel,
} from "../../core/broker/service.ts";
import {
  renderScoutActivityList,
  renderScoutMessageList,
} from "../../ui/terminal/broker.ts";

const HELP_FLAGS = new Set(["--help", "-h"]);

function newestMessagesFirst<T extends { createdAt: number }>(messages: T[]): T[] {
  return [...messages].sort((left, right) => right.createdAt - left.createdAt);
}

export function renderLatestCommandHelp(): string {
  return [
    "Usage: scout latest [--messages] [--conversation <id> | --channel <name>] [--agent <id>] [--actor <id>] [--limit <count>] [--json]",
    "",
    "Show the latest Scout activity by default.",
    "",
    "Modes:",
    "  default activity                  -> broker activity timeline across messages, asks, flights, and collaboration events",
    "  --messages                        -> raw broker messages only",
    "",
    "Filters:",
    "  --conversation <id>               -> limit activity or messages to one conversation id",
    "  --channel <name>                  -> limit to channel.<name>; cannot be combined with --conversation",
    "  --agent <id>                      -> activity where the agent is involved",
    "  --actor <id>                      -> activity created by one actor",
    "  --limit <count>                   -> maximum rows to print (default 12)",
    "",
    "Examples:",
    "  scout latest",
    "  scout latest --messages --channel triage --limit 20",
    "  scout latest --conversation dm.hudson.operator --messages",
  ].join("\n");
}

export async function runLatestCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  if (args.some((arg) => HELP_FLAGS.has(arg))) {
    context.output.writeText(renderLatestCommandHelp());
    return;
  }

  const options = parseLatestCommandOptions(args, defaultScoutContextDirectory(context));
  const conversationId = options.conversationId ?? (
    options.channel ? scoutConversationIdForChannel(options.channel) : undefined
  );
  if (options.messages) {
    const messages = await loadScoutMessages({
      channel: options.channel,
      conversationId,
      limit: options.limit,
    });
    context.output.writeValue(newestMessagesFirst(messages), renderScoutMessageList);
    return;
  }

  const items = await loadScoutActivityItems({
    agentId: options.agentId,
    actorId: options.actorId,
    conversationId,
    limit: options.limit,
  });
  context.output.writeValue(items, renderScoutActivityList);
}
