import type { ScoutCommandContext } from "../context.ts";
import { defaultScoutContextDirectory } from "../context.ts";
import { resolveMessageBody } from "../input-file.ts";
import { parseSendCommandOptions } from "../options.ts";
import {
  acquireScoutOnAir,
  getScoutVoiceForChannel,
  loadScoutRelayConfig,
  parseScoutHarness,
  releaseScoutOnAir,
  resolveScoutSenderId,
  sendScoutMessage,
  speakScoutText,
  stripScoutAgentSelectorLabels,
} from "../../core/broker/service.ts";
import { renderScoutMessagePostResult } from "../../ui/terminal/broker.ts";
import { formatScoutSendRoutingError } from "./send.ts";

export async function runSpeakCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  const options = parseSendCommandOptions(args, defaultScoutContextDirectory(context));
  const currentDirectory = options.currentDirectory ?? defaultScoutContextDirectory(context);
  const senderId = await resolveScoutSenderId(options.agentName, currentDirectory, context.env);
  const config = await loadScoutRelayConfig();
  const voice = getScoutVoiceForChannel(config, "voice");
  const body = await resolveMessageBody(options);

  await acquireScoutOnAir(senderId);
  try {
    const clean = stripScoutAgentSelectorLabels(body);
    if (clean) {
      await speakScoutText(clean, voice);
    }
  } finally {
    await releaseScoutOnAir();
  }

  const result = await sendScoutMessage({
    senderId,
    body,
    channel: "voice",
    shouldSpeak: true,
    executionHarness: parseScoutHarness(options.harness),
    currentDirectory: options.currentDirectory,
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
    },
    renderScoutMessagePostResult,
  );
}
