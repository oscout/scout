import { describe, expect, test } from "bun:test";

import { brokerOperatorSignalSchema } from "./broker-command-boundary-schemas.js";

/**
 * The broker is the second gate on an operator signal; the CLI is the first.
 * Both refuse a `need` without a question, so the empty attention card cannot
 * be produced by a hand-rolled client either — the guarantee is the boundary,
 * not one well-behaved caller.
 */
describe("brokerOperatorSignalSchema", () => {
  test("accepts a need carrying a question", () => {
    const parsed = brokerOperatorSignalSchema.parse({
      kind: "need",
      blocking: true,
      replyExpectation: "required",
      question: "Which database should the export target?",
      options: ["postgres", "sqlite"],
      blockedReason: "schemas have diverged",
    });

    expect(parsed).toMatchObject({ kind: "need", blocking: true });
  });

  test("accepts a need without options", () => {
    expect(() =>
      brokerOperatorSignalSchema.parse({
        kind: "need",
        blocking: true,
        replyExpectation: "required",
        question: "Where should the deploy key come from?",
      }),
    ).not.toThrow();
  });

  test("rejects a need with no question", () => {
    expect(() =>
      brokerOperatorSignalSchema.parse({
        kind: "need",
        blocking: true,
        replyExpectation: "required",
      }),
    ).toThrow();
  });

  test("rejects a need whose question is whitespace", () => {
    expect(() =>
      brokerOperatorSignalSchema.parse({
        kind: "need",
        blocking: true,
        replyExpectation: "required",
        question: "   ",
      }),
    ).toThrow();
  });

  test("a need is blocking by construction — blocking:false is not a need", () => {
    expect(() =>
      brokerOperatorSignalSchema.parse({
        kind: "need",
        blocking: false,
        replyExpectation: "required",
        question: "Which database should the export target?",
      }),
    ).toThrow();
  });

  test("notify and consult stay non-blocking", () => {
    expect(brokerOperatorSignalSchema.parse({
      kind: "notify",
      blocking: false,
      replyExpectation: "none",
    })).toMatchObject({ kind: "notify" });

    expect(brokerOperatorSignalSchema.parse({
      kind: "consult",
      blocking: false,
      replyExpectation: "optional",
      defaultAction: "proceed with sqlite",
    })).toMatchObject({ kind: "consult" });
  });

  test("consult still requires its default action", () => {
    // The whole point of consult is that silence is answerable, which is only
    // true if the agent already said what it will do.
    expect(() =>
      brokerOperatorSignalSchema.parse({
        kind: "consult",
        blocking: false,
        replyExpectation: "optional",
      }),
    ).toThrow();
  });
});
