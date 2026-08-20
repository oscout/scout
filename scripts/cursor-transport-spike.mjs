#!/usr/bin/env bun
import { runCursorTransportSpike, formatCursorTransportSpikeReport } from "../packages/runtime/src/cursor-transport-spike/run-spike.ts";

/** @typedef {import("../packages/protocol/src/cursor-transport.ts").CursorLocalTransportMode} CursorLocalTransportMode */

function parseArgs(argv) {
  let cwd = process.cwd();
  let prompt = "Reply with exactly: SPIKE_OK";
  let followUpPrompt = "Reply with exactly: SPIKE_FOLLOWUP";
  /** @type {CursorLocalTransportMode[]} */
  const modes = [];
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cwd" && argv[index + 1]) {
      cwd = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--prompt" && argv[index + 1]) {
      prompt = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--follow-up" && argv[index + 1]) {
      followUpPrompt = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--mode" && argv[index + 1]) {
      modes.push(/** @type {CursorLocalTransportMode} */ (argv[index + 1]));
      index += 1;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log(`Usage: bun scripts/cursor-transport-spike.mjs [--cwd <path>] [--prompt <text>] [--follow-up <text>] [--mode <mode>]... [--json]

Modes:
  cursor_cli_text
  cursor_cli_stream_json
  cursor_sdk_local
  cursor_sdk_local_no_key

Auth:
  Uses CURSOR_API_KEY or ~/.cursor/api_key.env when present.
  cursor_sdk_local_no_key and login-only CLI paths are tested explicitly.
`);
      process.exit(0);
    }
  }

  return {
    cwd,
    prompt,
    followUpPrompt,
    modes: modes.length > 0 ? modes : undefined,
    json,
  };
}

const options = parseArgs(process.argv.slice(2));
const report = await runCursorTransportSpike({
  cwd: options.cwd,
  prompt: options.prompt,
  followUpPrompt: options.followUpPrompt,
  modes: options.modes,
});

if (options.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(formatCursorTransportSpikeReport(report));
}

const failed = report.results.some((result) => !result.ok && result.mode !== "cursor_sdk_local_no_key");
process.exit(failed ? 1 : 0);
