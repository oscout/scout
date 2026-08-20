import type { ScoutCommandContext } from "../context.ts";
import { defaultScoutContextDirectory } from "../context.ts";
import { ScoutCliError } from "../errors.ts";
import { resolveMessageBody } from "../input-file.ts";
import { parseSendCommandOptions } from "../options.ts";
import { parseScoutHarness, resolveScoutSenderId, sendScoutMessage } from "../../core/broker/service.ts";
import { renderScoutBroadcastResult } from "../../ui/terminal/broker.ts";
import { formatScoutSendRoutingError } from "./send.ts";

const HELP_FLAGS = new Set(["--help", "-h"]);

export function renderBroadcastCommandHelp(): string {
  return [
    "Usage: scout broadcast [--as <sender>] [--harness <runtime>] [--message-file <path> | <message>]",
    "",
    "Broadcast to channel.shared.",
    "",
    "Use this only when the message is genuinely for everyone.",
    "Do not use broadcast for ordinary one-to-one delegation or small-group coordination.",
    "",
    "Input:",
    "  inline message                    -> broadcast body",
    "  --message-file <path>             -> read the broadcast body from a UTF-8 file",
    "  --body-file <path>                -> alias for --message-file",
    "",
    "Examples:",
    '  scout broadcast "deploying in 15m, pause long flights"',
    "  scout broadcast --message-file ./maintenance.md",
    '  scout broadcast --as scout.main.mini "broker maintenance starts now"',
  ].join("\n");
}

export async function runBroadcastCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  if (args.some((arg) => HELP_FLAGS.has(arg))) {
    context.output.writeText(renderBroadcastCommandHelp());
    return;
  }

  const options = parseSendCommandOptions(args, defaultScoutContextDirectory(context));
  if (options.channel) {
    throw new ScoutCliError("broadcast always targets channel.shared; do not pass --channel");
  }
  const currentDirectory = options.currentDirectory ?? defaultScoutContextDirectory(context);
  const senderId = await resolveScoutSenderId(options.agentName, currentDirectory, context.env);
  const body = await resolveMessageBody(options);
  const result = await sendScoutMessage({
    senderId,
    // The explicit shared channel is the broadcast route. Keep the body as payload.
    body,
    channel: "shared",
    executionHarness: parseScoutHarness(options.harness),
    currentDirectory,
  });

  if (!result.usedBroker) {
    throw new Error("broker is not reachable");
  }
  if (result.unresolvedTargets.length > 0) {
    throw new Error(formatScoutSendRoutingError(result));
  }

  context.output.writeValue(
    {
      message: body,
      invokedTargets: result.invokedTargets,
      unresolvedTargets: result.unresolvedTargets,
      routeKind: result.routeKind,
    },
    renderScoutBroadcastResult,
  );
}
