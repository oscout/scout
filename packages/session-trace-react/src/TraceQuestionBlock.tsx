"use client";

import React from "react";
import { createTraceAnswerIntent, type QuestionBlock, type TraceBlockViewModel, type TraceIntent } from "@openscout/session-trace";
import { composeTraceQuestionAnswer, toggleTraceQuestionSelection } from "./question-selection.js";

type TraceQuestionBlockProps = {
  block: TraceBlockViewModel;
  onIntent?: (intent: TraceIntent) => void;
  className?: string;
};

export function TraceQuestionBlock({ block, onIntent, className }: TraceQuestionBlockProps) {
  if (block.type !== "question") {
    return null;
  }

  const question = block.block as QuestionBlock;
  const [selectedLabels, setSelectedLabels] = React.useState<string[]>([]);
  const rootClassName = ["os-trace-question-block", className].filter(Boolean).join(" ");

  React.useEffect(() => {
    setSelectedLabels([]);
  }, [block.id, question.multiSelect]);

  function submitAnswer(answerLabels: string[]): void {
    onIntent?.(createTraceAnswerIntent(block, answerLabels));
    setSelectedLabels([]);
  }

  return (
    <section className={rootClassName} data-trace-question>
      <header>
        <strong>{block.label}</strong>
        <span>{question.questionStatus.replaceAll("_", " ")}</span>
      </header>
      <p>{question.question}</p>
      <div data-trace-options>
        {question.options.map((option: QuestionBlock["options"][number]) => (
          <button
            key={option.label}
            type="button"
            aria-pressed={question.multiSelect ? selectedLabels.includes(option.label) : undefined}
            onClick={() => {
              if (!question.multiSelect) {
                submitAnswer([option.label]);
                return;
              }

              setSelectedLabels((current) => toggleTraceQuestionSelection(current, option.label));
            }}
          >
            {option.label}
          </button>
        ))}
      </div>
      {question.multiSelect ? (
        <>
          <small>{selectedLabels.length > 0 ? `${selectedLabels.length} selected` : "Multi-select question"}</small>
          <button
            type="button"
            disabled={selectedLabels.length === 0}
            onClick={() => submitAnswer(composeTraceQuestionAnswer(question, selectedLabels))}
          >
            Submit selection
          </button>
        </>
      ) : null}
    </section>
  );
}
