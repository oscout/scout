import type { ScoutOutputMode } from "./output.ts";

export type ScoutCliInput = {
  command: string | null;
  args: string[];
  helpRequested: boolean;
  versionRequested: boolean;
  outputMode: ScoutOutputMode;
};

export function parseScoutArgv(argv: string[]): ScoutCliInput {
  let command: string | null = null;
  let helpRequested = false;
  let versionRequested = false;
  let outputMode: ScoutOutputMode = "plain";
  const args: string[] = [];

  for (const token of argv) {
    if (token === "--json") {
      outputMode = "json";
      continue;
    }

    if (command === null && (token === "--help" || token === "-h" || token === "help")) {
      helpRequested = true;
      continue;
    }

    if (command === null && (token === "--version" || token === "-v" || token === "version")) {
      versionRequested = true;
      continue;
    }

    if (command === null) {
      command = token;
      continue;
    }

    args.push(token);
  }

  return {
    command,
    args,
    helpRequested,
    versionRequested,
    outputMode,
  };
}
