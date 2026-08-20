import type { ScoutCommandContext } from "../context.ts";
import { startScoutPairingSession } from "../../core/pairing/service.ts";
import { renderScoutPairingEvent } from "../../ui/terminal/pairing.ts";

type ScoutPairCommandOptions = {
  relayUrl?: string;
  forceManagedRelay: boolean;
};

function parsePairCommandOptions(args: string[]): ScoutPairCommandOptions {
  let relayUrl: string | undefined;
  let forceManagedRelay = false;

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index] ?? "";
    if (current === "--managed") {
      forceManagedRelay = true;
      continue;
    }
    if (current === "--relay") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("missing value for --relay");
      }
      relayUrl = value;
      index += 1;
      continue;
    }
    if (current.startsWith("--relay=")) {
      relayUrl = current.slice("--relay=".length);
      continue;
    }
    throw new Error(`unexpected arguments for pair: ${args.join(" ")}`);
  }

  return {
    relayUrl,
    forceManagedRelay,
  };
}

export async function runPairCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  const options = parsePairCommandOptions(args);
  const session = await startScoutPairingSession({
    relayUrl: options.relayUrl,
    forceManagedRelay: options.forceManagedRelay,
    onEvent(event) {
      if (context.output.mode === "json") {
        context.stdout(JSON.stringify(event));
        return;
      }
      context.stdout(renderScoutPairingEvent(event));
    },
  });

  const controller = new AbortController();
  let stopped = false;
  const stop = async () => {
    if (stopped) {
      return;
    }
    stopped = true;
    controller.abort();
    await session.stop();
  };

  const handleSignal = () => {
    void stop();
  };

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  try {
    await new Promise<void>((resolve) => {
      controller.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  } finally {
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
  }
}
