import type { ScoutCommandContext } from "../context.ts";
import { defaultScoutContextDirectory } from "../context.ts";
import { resolveScoutSenderId, sendScoutMessage } from "../../core/broker/service.ts";

const HELP_FLAGS = new Set(["--help", "-h"]);

/**
 * `scout need` — the agent's way to say it cannot proceed without the operator.
 *
 * This is the *declared* half of the needs-you surface. Everything else that
 * raises the operator is inferred: a permission prompt spotted in a harness
 * snapshot, a session that stopped moving. Inference is a guess about an agent
 * that cannot speak for itself, and it produced alerts with nothing in them.
 * A `need` is authored — the agent says what it wants, in its own words, and
 * cannot file one without saying it.
 *
 * Deliberately a CLI verb rather than an MCP tool: every coding agent already
 * has shell access, so the command works with any harness and needs no
 * per-harness configuration. Bash is the universal tool interface.
 *
 * The validation below is the point, not ceremony. A malformed need exits
 * non-zero with an instruction, the agent reads that in its tool result, and
 * it retries — the same loop a schema-validating tool gives you, built out of
 * exit codes. Rejecting at the boundary is what makes the empty ask
 * structurally impossible instead of filtered downstream.
 */
export function renderNeedCommandHelp(): string {
  return [
    "Usage: scout need --question <text> [--option <choice> ...] [--because <reason>] [--as <sender>]",
    "",
    "Tell your operator you are blocked and need an answer to continue.",
    "",
    "Use this when you cannot make further progress on your own. It is the only",
    "signal that marks you as waiting on the human; it interrupts them, so the",
    "question has to be one they can actually answer.",
    "",
    "Do not use it for:",
    "  progress updates                 -> scout send",
    "  work handed to another agent     -> scout ask",
    "  a decision you can default       -> make the call, say what you chose",
    "",
    "Options:",
    "  --question <text>   what you need from the operator (required)",
    "  --option <choice>   a discrete choice; repeat for each. Prefer these when",
    "                      the answer is a selection — they are far faster to answer",
    "  --because <reason>  why you cannot continue without it",
    "  --as <sender>       send under an explicit agent identity",
    "",
    "Examples:",
    '  scout need --question "Which database should the export target?" \\',
    '    --option "postgres (prod)" --option "sqlite (local fixture)"',
    '  scout need --question "The staging deploy key is missing. Where should I get it?" \\',
    '    --because "cannot run the smoke suite without it"',
  ].join("\n");
}

export type ParsedNeedOptions = {
  question: string;
  options: string[];
  because?: string;
  agentName?: string;
  currentDirectory?: string;
};

/**
 * Errors are written for the agent that will read them in a tool result, not
 * for a human scanning a terminal: each one names the flag to pass and shows
 * the shape. An error a model cannot act on just burns a turn.
 */
export class NeedValidationError extends Error {}

export function parseNeedCommandOptions(args: string[]): ParsedNeedOptions {
  let question: string | undefined;
  let because: string | undefined;
  let agentName: string | undefined;
  let currentDirectory: string | undefined;
  const options: string[] = [];
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    const takeValue = (flag: string): string => {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new NeedValidationError(`${flag} needs a value.`);
      }
      index += 1;
      return value;
    };

    switch (arg) {
      case "--question":
      case "-q":
        question = takeValue(arg);
        break;
      case "--option":
        options.push(takeValue(arg));
        break;
      case "--because":
      case "--reason":
        because = takeValue(arg);
        break;
      case "--as":
        agentName = takeValue(arg);
        break;
      case "--cwd":
        currentDirectory = takeValue(arg);
        break;
      default:
        if (arg.startsWith("--")) {
          throw new NeedValidationError(
            `unknown flag ${arg}. Run \`scout need --help\` for the accepted flags.`,
          );
        }
        positional.push(arg);
        break;
    }
  }

  // A bare `scout need "why is this failing?"` is the mistake an agent is most
  // likely to make, so accept the positional form rather than refusing a
  // perfectly clear question on a technicality.
  if (question === undefined && positional.length > 0) {
    question = positional.join(" ");
  }

  const trimmedQuestion = question?.trim() ?? "";
  if (!trimmedQuestion) {
    throw new NeedValidationError(
      "a need has no question. Pass --question \"<what you need from the operator>\".\n"
        + "Example: scout need --question \"Which database should the export target?\" "
        + "--option \"postgres\" --option \"sqlite\"",
    );
  }

  // "help" / "?" / "blocked" tell the operator nothing and cannot be answered.
  // Catching them here costs one turn; letting them through costs an alert the
  // operator opens, cannot act on, and learns to ignore.
  if (trimmedQuestion.length < 8 || !/[a-z]/i.test(trimmedQuestion)) {
    throw new NeedValidationError(
      `"${trimmedQuestion}" is not a question your operator can answer. `
        + "Say what you need in a full sentence — what you were doing, and what you want them to decide.",
    );
  }

  const trimmedOptions = options
    .map((option) => option.trim())
    .filter((option) => option.length > 0);
  if (trimmedOptions.length !== options.length) {
    throw new NeedValidationError("--option cannot be empty. Drop it, or give it a real choice.");
  }
  if (trimmedOptions.length === 1) {
    throw new NeedValidationError(
      "a single --option is not a choice. Give at least two, or drop --option and ask an open question.",
    );
  }

  const trimmedBecause = because?.trim();

  return {
    question: trimmedQuestion,
    options: trimmedOptions,
    ...(trimmedBecause ? { because: trimmedBecause } : {}),
    ...(agentName ? { agentName } : {}),
    ...(currentDirectory ? { currentDirectory } : {}),
  };
}

/**
 * The body the operator reads. The question leads because it is the thing
 * being answered; the reason and choices follow it.
 */
export function renderNeedBody(parsed: ParsedNeedOptions): string {
  const lines = [parsed.question];
  if (parsed.because) {
    lines.push("", `Blocked: ${parsed.because}`);
  }
  if (parsed.options.length > 0) {
    lines.push("", ...parsed.options.map((option) => `- ${option}`));
  }
  return lines.join("\n");
}

export async function runNeedCommand(
  context: ScoutCommandContext,
  args: string[],
): Promise<void> {
  if (args.length === 0 || args.some((arg) => HELP_FLAGS.has(arg))) {
    context.output.writeText(renderNeedCommandHelp());
    return;
  }

  const parsed = parseNeedCommandOptions(args);
  const currentDirectory = parsed.currentDirectory ?? defaultScoutContextDirectory(context);
  const senderId = await resolveScoutSenderId(parsed.agentName, currentDirectory, context.env);
  const body = renderNeedBody(parsed);

  const result = await sendScoutMessage({
    senderId,
    body,
    targetLabel: "operator",
    currentDirectory,
    source: "scout-need",
    operatorSignal: {
      kind: "need",
      blocking: true,
      replyExpectation: "required",
      question: parsed.question,
      ...(parsed.options.length > 0 ? { options: parsed.options } : {}),
      ...(parsed.because ? { blockedReason: parsed.because } : {}),
    },
  });

  if (!result.usedBroker) {
    throw new Error("broker is not reachable; your need was not filed.");
  }
  if (result.unresolvedTargets.length > 0) {
    throw new Error("could not reach your operator; your need was not filed.");
  }

  context.output.writeValue(
    {
      senderId,
      question: parsed.question,
      options: parsed.options,
      blockedReason: parsed.because,
      conversationId: result.conversationId,
      messageId: result.messageId,
    },
    (value) =>
      [
        `Your operator has been asked: ${value.question}`,
        "They have been interrupted for this, so wait for their answer rather than guessing.",
      ].join("\n"),
  );
}
