import type { ScoutCommandContext } from "../context.ts";
import { defaultScoutContextDirectory } from "../context.ts";
import { resolveScoutSenderId, sendScoutMessage } from "../../core/broker/service.ts";

const HELP_FLAGS = new Set(["--help", "-h"]);

/**
 * `scout ask --operator` — the agent's way to say it cannot proceed without the operator.
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
export function renderOperatorQuestionHelp(): string {
  return [
    "Usage: scout ask --operator --question <text> [--option <choice> ...] [--because <reason>] [--as <sender>]",
    "",
    "Tell your operator you are blocked and need an answer to continue.",
    "",
    "Use this when progress requires an operator answer. Notification delivery",
    "is best-effort; the receipt confirms that the question was recorded.",
    "",
    "Do not use it for:",
    "  operator updates                 -> scout notify --message <text>",
    "  work handed to another agent     -> scout ask",
    "  a decision you can default       -> make the call, say what you chose",
    "",
    "Options:",
    "  --question <text>   what you need from the operator (required)",
    "  --option <choice>   a discrete choice; repeat for each. Prefer these when",
    "                      the answer is a selection — they are far faster to answer",
    "  --because <reason>  why you cannot continue without it",
    "  --permission       label this as a permission question; does not grant harness permissions",
    "  --as <sender>       send under an explicit agent identity",
    "",
    "Examples:",
    '  scout ask --operator --question "Which database should the export target?" \\',
    '    --option "postgres (prod)" --option "sqlite (local fixture)"',
    '  scout ask --operator --question "The staging deploy key is missing. Where should I get it?" \\',
    '    --because "cannot run the smoke suite without it"',
  ].join("\n");
}

export type OperatorQuestionOptions = {
  question: string;
  options: string[];
  because?: string;
  agentName?: string;
  currentDirectory?: string;
  permission?: boolean;
};

/**
 * Errors are written for the agent that will read them in a tool result, not
 * for a human scanning a terminal: each one names the flag to pass and shows
 * the shape. An error a model cannot act on just burns a turn.
 */
export class OperatorQuestionValidationError extends Error {}

export function parseOperatorQuestionOptions(args: string[]): OperatorQuestionOptions {
  let question: string | undefined;
  let because: string | undefined;
  let agentName: string | undefined;
  let currentDirectory: string | undefined;
  const options: string[] = [];
  const positional: string[] = [];
  let permission = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    const takeValue = (flag: string): string => {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new OperatorQuestionValidationError(`${flag} needs a value.`);
      }
      index += 1;
      return value;
    };

    switch (arg) {
      case "--permission":
        permission = true;
        break;
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
          throw new OperatorQuestionValidationError(
            `unknown flag ${arg}. Run \`scout ask --operator --help\` for the accepted flags.`,
          );
        }
        positional.push(arg);
        break;
    }
  }

  // A bare `scout ask --operator "why is this failing?"` is the mistake an agent is most
  // likely to make, so accept the positional form rather than refusing a
  // perfectly clear question on a technicality.
  if (question === undefined && positional.length > 0) {
    question = positional.join(" ");
  }

  const trimmedQuestion = question?.trim() ?? "";
  if (!trimmedQuestion) {
    throw new OperatorQuestionValidationError(
      "an operator question is missing its text. Pass --question \"<what you need from the operator>\".\n"
        + "Example: scout ask --operator --question \"Which database should the export target?\" "
        + "--option \"postgres\" --option \"sqlite\"",
    );
  }

  // "help" / "?" / "blocked" tell the operator nothing and cannot be answered.
  // Catching them here costs one turn; letting them through costs an alert the
  // operator opens, cannot act on, and learns to ignore.
  if (trimmedQuestion.length < 8 || !/\p{L}/u.test(trimmedQuestion)) {
    throw new OperatorQuestionValidationError(
      `"${trimmedQuestion}" is not a question your operator can answer. `
        + "Say what you need in a full sentence — what you were doing, and what you want them to decide.",
    );
  }

  const trimmedOptions = options
    .map((option) => option.trim())
    .filter((option) => option.length > 0);
  if (trimmedOptions.length !== options.length) {
    throw new OperatorQuestionValidationError("--option cannot be empty. Drop it, or give it a real choice.");
  }
  if (trimmedOptions.length === 1) {
    throw new OperatorQuestionValidationError(
      "a single --option is not a choice. Give at least two, or drop --option and ask an open question.",
    );
  }

  const trimmedBecause = because?.trim();

  return {
    question: trimmedQuestion,
    permission,
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
export function renderOperatorQuestionBody(parsed: OperatorQuestionOptions): string {
  const lines = [parsed.question];
  if (parsed.because) {
    lines.push("", `Blocked: ${parsed.because}`);
  }
  if (parsed.options.length > 0) {
    lines.push("", ...parsed.options.map((option) => `- ${option}`));
  }
  return lines.join("\n");
}

export async function runOperatorQuestionCommand(
  context: ScoutCommandContext,
  args: string[],
): Promise<void> {
  if (args.length === 0 || args.some((arg) => HELP_FLAGS.has(arg))) {
    context.output.writeText(renderOperatorQuestionHelp());
    return;
  }

  const parsed = parseOperatorQuestionOptions(args);
  const currentDirectory = parsed.currentDirectory ?? defaultScoutContextDirectory(context);
  const senderId = await resolveScoutSenderId(parsed.agentName, currentDirectory, context.env);
  const body = renderOperatorQuestionBody(parsed);

  const result = await sendScoutMessage({
    senderId,
    body,
    targetLabel: "operator",
    currentDirectory,
    source: "scout-ask-operator",
    operatorSignal: {
      kind: "need",
      blocking: true,
      replyExpectation: "required",
      question: parsed.question,
      ...(parsed.permission ? { requestKind: "permission" as const } : {}),
      ...(parsed.options.length > 0 ? { options: parsed.options } : {}),
      ...(parsed.because ? { blockedReason: parsed.because } : {}),
    },
  });

  if (!result.usedBroker) {
    throw new Error("broker is not reachable; your question was not recorded.");
  }
  if (result.unresolvedTargets.length > 0 || result.routingError || !result.messageId) {
    throw new Error("could not reach your operator; your question was not recorded.");
  }

  context.output.writeValue(
    {
      senderId,
      status: "recorded",
      notificationDelivery: "unconfirmed",
      question: parsed.question,
      options: parsed.options,
      blockedReason: parsed.because,
      conversationId: result.conversationId,
      messageId: result.messageId,
    },
    (value) =>
      [
        `Your operator has been asked: ${value.question}`,
        "Question recorded; notification delivery is unconfirmed. Do not proceed without an answer.",
        `Message: ${value.messageId}. Conversation: ${value.conversationId}.`,
        `Inspect: scout status ${value.messageId}`,
      ].join("\n"),
  );
}
