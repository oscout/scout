import type { ScoutCommandContext } from "../context.ts";

const HELP_FLAGS = new Set(["--help", "-h"]);
const QUESTION_FLAGS = new Set(["--question", "-q", "--option", "--because", "--reason", "--permission"]);

/**
 * `scout operator` — the one verb an agent needs to reach its operator.
 *
 * The two underlying commands already existed but lived in different places:
 * the heads-up was `scout notify --message`, and the blocking question hid
 * behind a flag on the overloaded `scout ask`. This verb is the front door for
 * both; the question flags pick which one runs.
 */
export function renderOperatorCommandHelp(): string {
  return [
    "Usage: scout operator <message> [--image <path>]",
    "       scout operator --question <text> [--option <choice> ...] [--because <reason>] [--permission]",
    "",
    "Reach your operator (the human running Scout). Arrives in the Scout apps and as a phone push.",
    "",
    "  Tell them something, keep working    scout operator \"The build is green; screenshot attached.\" --image ./shot.png",
    "  You are blocked on their answer      scout operator --question \"Ship to staging or prod?\" --option staging --option prod",
    "",
    "Use --question only when you cannot continue without the answer; make the call yourself when you",
    "can and say what you chose. Offer --option choices whenever the answer is a pick; they answer in one tap.",
    "Delivery is best-effort: the receipt confirms the message was recorded, not that it was read.",
    "",
    "Same commands, long form: scout notify --message <text>, scout ask --operator --question <text>.",
  ].join("\n");
}

export function isOperatorQuestion(args: string[]): boolean {
  return args.some((arg) => QUESTION_FLAGS.has(arg));
}

/** Positional text becomes the notify message; flags pass through untouched. */
export function operatorMessageArgs(args: string[]): string[] {
  const passthrough: string[] = [];
  const words: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json") {
      passthrough.push(arg);
    } else if (arg.startsWith("--")) {
      passthrough.push(arg, args[index + 1] ?? "");
      index += 1;
    } else {
      words.push(arg);
    }
  }
  const hasMessageFlag = passthrough.includes("--message");
  return words.length && !hasMessageFlag ? ["--message", words.join(" "), ...passthrough] : passthrough;
}

export async function runOperatorCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  if (args.length === 0 || args.some((arg) => HELP_FLAGS.has(arg))) {
    context.output.writeText(renderOperatorCommandHelp());
    return;
  }
  if (isOperatorQuestion(args)) {
    const { runOperatorQuestionCommand } = await import("./operator-question.ts");
    await runOperatorQuestionCommand(context, args);
    return;
  }
  const { runNotifyCommand } = await import("./notify.ts");
  await runNotifyCommand(context, operatorMessageArgs(args));
}
