"use client";

import React from "react";
import { type TraceBlockViewModel, type TraceIntent } from "@openscout/session-trace";
import { TraceActionBlock } from "./TraceActionBlock.js";
import { TraceReasoningBlock } from "./TraceReasoningBlock.js";
import { TraceQuestionBlock } from "./TraceQuestionBlock.js";

type TraceBlockProps = {
  block: TraceBlockViewModel;
  onIntent?: (intent: TraceIntent) => void;
  className?: string;
};

export function TraceBlock({ block, onIntent, className }: TraceBlockProps) {
  switch (block.type) {
    case "action":
      return <TraceActionBlock block={block} onIntent={onIntent} className={className} />;
    case "reasoning":
      return <TraceReasoningBlock block={block} onIntent={onIntent} className={className} />;
    case "question":
      return <TraceQuestionBlock block={block} onIntent={onIntent} className={className} />;
    case "text": {
      return (
        <article className={["os-trace-text-block", className].filter(Boolean).join(" ")} data-trace-text>
          <header>
            <strong>{block.label}</strong>
            <span>{block.status.replaceAll("_", " ")}</span>
          </header>
          <p>{block.summary}</p>
        </article>
      );
    }
    case "file": {
      const fileBlock = block.block as { mimeType: string };
      return (
        <article className={["os-trace-file-block", className].filter(Boolean).join(" ")} data-trace-file>
          <header>
            <strong>{block.label}</strong>
            <span>{fileBlock.mimeType}</span>
          </header>
          <p>{block.summary}</p>
        </article>
      );
    }
    case "error":
      return (
        <article className={["os-trace-error-block", className].filter(Boolean).join(" ")} data-trace-error>
          <header>
            <strong>{block.label}</strong>
            <span>{block.status.replaceAll("_", " ")}</span>
          </header>
          <p>{block.summary}</p>
        </article>
      );
  }

  return null;
}
