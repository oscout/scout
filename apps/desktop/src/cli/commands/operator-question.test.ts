import { describe, expect, test } from "bun:test";

import {
  OperatorQuestionValidationError,
  parseOperatorQuestionOptions,
  renderOperatorQuestionBody,
} from "./operator-question.ts";

/**
 * These assert the *boundary*, which is the whole reason the command exists.
 * A need that cannot be answered must fail here — where the agent reads the
 * error and retries — rather than being filtered out downstream, which is how
 * the operator ended up with an alert containing nothing.
 */
describe("parseOperatorQuestionOptions", () => {
  test("accepts a question with choices", () => {
    const parsed = parseOperatorQuestionOptions([
      "--question",
      "Which database should the export target?",
      "--option",
      "postgres",
      "--option",
      "sqlite",
    ]);

    expect(parsed.question).toBe("Which database should the export target?");
    expect(parsed.options).toEqual(["postgres", "sqlite"]);
  });

  test("accepts the bare positional form agents reach for first", () => {
    const parsed = parseOperatorQuestionOptions(["Where should the deploy key come from?"]);
    expect(parsed.question).toBe("Where should the deploy key come from?");
  });

  test("rejects a missing question and names the flag", () => {
    expect(() => parseOperatorQuestionOptions(["--because", "stuck"]))
      .toThrow(OperatorQuestionValidationError);
    try {
      parseOperatorQuestionOptions(["--because", "stuck"]);
    } catch (error) {
      // The message is read by a model in a tool result, so it has to carry the
      // fix, not just the complaint.
      expect((error as Error).message).toContain("--question");
      expect((error as Error).message).toContain("Example:");
    }
  });

  test("rejects a whitespace-only question", () => {
    expect(() => parseOperatorQuestionOptions(["--question", "   "]))
      .toThrow(OperatorQuestionValidationError);
  });

  test("rejects a question too thin to answer", () => {
    // "help" is the exact shape of alert that trains an operator to ignore the
    // surface: it interrupts, and there is nothing to decide.
    expect(() => parseOperatorQuestionOptions(["--question", "help"]))
      .toThrow(/not a question your operator can answer/);
    expect(() => parseOperatorQuestionOptions(["--question", "???????????"]))
      .toThrow(/not a question your operator can answer/);
  });

  test("rejects a single option as a non-choice", () => {
    expect(() =>
      parseOperatorQuestionOptions([
        "--question",
        "Should I proceed with the migration?",
        "--option",
        "yes",
      ]),
    ).toThrow(/single --option is not a choice/);
  });

  test("rejects an empty option", () => {
    expect(() =>
      parseOperatorQuestionOptions([
        "--question",
        "Which target should I use?",
        "--option",
        "postgres",
        "--option",
        "  ",
      ]),
    ).toThrow(/--option cannot be empty/);
  });

  test("rejects a flag with no value instead of swallowing the next flag", () => {
    expect(() => parseOperatorQuestionOptions(["--question", "--because", "stuck"]))
      .toThrow(/--question needs a value/);
  });

  test("rejects unknown flags", () => {
    expect(() =>
      parseOperatorQuestionOptions(["--question", "Which one should I use?", "--urgent"]),
    ).toThrow(/unknown flag --urgent/);
  });
});

describe("renderOperatorQuestionBody", () => {
  test("leads with the question, then reason, then choices", () => {
    const body = renderOperatorQuestionBody({
      question: "Which database should the export target?",
      options: ["postgres (prod)", "sqlite (local fixture)"],
      because: "the fixture and prod schemas have diverged",
    });

    expect(body).toBe(
      [
        "Which database should the export target?",
        "",
        "Blocked: the fixture and prod schemas have diverged",
        "",
        "- postgres (prod)",
        "- sqlite (local fixture)",
      ].join("\n"),
    );
  });

  test("a bare question renders as itself", () => {
    expect(renderOperatorQuestionBody({ question: "Where is the deploy key?", options: [] }))
      .toBe("Where is the deploy key?");
  });
});
