import type { ScoutCommandContext } from "../context.ts";
import { defaultScoutContextDirectory } from "../context.ts";
import { parseInboxCommandOptions } from "../options.ts";
import {
  loadScoutMessages,
  resolveScoutSenderId,
} from "../../core/broker/service.ts";
import { renderScoutMessageList } from "../../ui/terminal/broker.ts";

function newestMessagesFirst<T extends { createdAt: number }>(messages: T[]): T[] {
  return [...messages].sort((left, right) => right.createdAt - left.createdAt);
}

export function renderInboxCommandHelp(): string {
  return [
    "Usage: scout inbox [--latest <count>] [--since <duration>] [--as <agent>] [--json]",
    "",
    "Read recent direct messages and addressed messages for the current Scout identity.",
    "",
    "Examples:",
    "  scout inbox --latest 10 --json",
    "  scout inbox --since 1h --json",
  ].join("\n");
}

export async function runInboxCommand(
  context: ScoutCommandContext,
  args: string[],
): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    context.output.writeText(renderInboxCommandHelp());
    return;
  }

  const options = parseInboxCommandOptions(args, defaultScoutContextDirectory(context));
  const participantId = await resolveScoutSenderId(
    options.agentName,
    options.currentDirectory,
    context.env,
  );
  const messages = await loadScoutMessages({
    participantId,
    inboxOnly: true,
    limit: options.latest,
    since: options.since,
  });

  context.output.writeValue(newestMessagesFirst(messages), renderScoutMessageList);
}
