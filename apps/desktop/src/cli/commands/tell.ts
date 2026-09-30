import type { ScoutCommandContext } from "../context.ts";
import { defaultScoutContextDirectory } from "../context.ts";
import { resolveMessageBody } from "../input-file.ts";
import { parseTellCommandOptions } from "../options.ts";
import { runMessageOnlySend } from "./send.ts";

const HELP_FLAGS = new Set(["--help", "-h"]);

export function renderTellCommandHelp(): string {
  return [
    "Usage: scout tell [--as <sender>] [--to <agent> | --ref <ref>] [--alias-project <path>] [--alias-host <node>] [--channel <name>] [--speak] [--harness <runtime>] [--message-file <path> | <message>]",
    "",
    "Post a durable FYI, status, or completed result. Tell never creates new owned work.",
    "It is the explicit spelling of a plain `scout send`: same routing, same message-only delivery.",
    "",
    "Routing:",
    "  --to <agent>                      -> DM message; body @mentions stay text",
    "  --to target:<name> or --to ⌖name   -> saved situated target",
    "  --to alias:<name>                  -> explicit broker route alias",
    "  --ref <ref>                        -> reply into that bound thread/session",
    "  --channel <name>                   -> named group thread",
    "  no target + no channel             -> error",
    "  multiple targets + no channel      -> error",
    "",
    "Use tell for completed results and heads-ups with no owned next step.",
    "If the target should act, reply, or report back, use `scout ask` (or `scout send --tracked --to`);",
    "tell rejects --wake and --tracked because making a target act is dispatch, not an FYI.",
    "",
    "Input:",
    "  inline message                    -> message body",
    "  --message-file <path>             -> read the message body from a UTF-8 file",
    "  --body-file <path>                -> alias for --message-file",
    "",
    "Examples:",
    '  scout tell --to hudson "review completed; findings recorded in the PR"',
    '  scout tell --ref 7f3a9c21 "FYI: the build passed; no action needed"',
    '  scout tell --channel triage "both reviews are complete"',
    "  scout tell --channel triage --message-file ./status.md",
    '  scout tell --as premotion.master.mini --to hudson "editor branch is green"',
  ].join("\n");
}

export async function runTellCommand(
  context: ScoutCommandContext,
  args: string[],
): Promise<void> {
  if (args.some((arg) => HELP_FLAGS.has(arg))) {
    context.output.writeText(renderTellCommandHelp());
    return;
  }

  const options = parseTellCommandOptions(
    args,
    defaultScoutContextDirectory(context),
  );
  const body = await resolveMessageBody(options);
  await runMessageOnlySend(context, options, body);
}
