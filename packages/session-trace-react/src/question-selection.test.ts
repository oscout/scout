import { describe, expect, test } from "bun:test";

import { composeTraceQuestionAnswer, toggleTraceQuestionSelection } from "./question-selection.js";
import type { QuestionBlock } from "@openscout/session-trace";

describe("question selection helpers", () => {
  test("toggles selected labels", () => {
    expect(toggleTraceQuestionSelection(["A"], "B")).toEqual(["A", "B"]);
    expect(toggleTraceQuestionSelection(["A", "B"], "A")).toEqual(["B"]);
  });

  test("composes multi-select answers in option order", () => {
    const question: QuestionBlock = {
      id: "block-1",
      turnId: "turn-1",
      type: "question",
      status: "streaming",
      index: 0,
      question: "Pick some options",
      options: [{ label: "Alpha" }, { label: "Beta" }, { label: "Gamma" }],
      multiSelect: true,
      questionStatus: "awaiting_answer",
    };

    expect(composeTraceQuestionAnswer(question, ["Gamma", "Alpha"])).toEqual(["Alpha", "Gamma"]);
  });

  test("reduces single-select answers to the first selected label", () => {
    const question: QuestionBlock = {
      id: "block-1",
      turnId: "turn-1",
      type: "question",
      status: "streaming",
      index: 0,
      question: "Pick one option",
      options: [{ label: "Alpha" }, { label: "Beta" }],
      multiSelect: false,
      questionStatus: "awaiting_answer",
    };

    expect(composeTraceQuestionAnswer(question, ["Beta", "Alpha"])).toEqual(["Alpha"]);
  });
});
