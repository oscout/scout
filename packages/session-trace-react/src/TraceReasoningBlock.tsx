"use client";

import React from "react";
import { createTraceCollapseIntent, type ReasoningBlock, type TraceBlockViewModel, type TraceIntent } from "@openscout/session-trace";

type TraceReasoningBlockProps = {
  block: TraceBlockViewModel;
  onIntent?: (intent: TraceIntent) => void;
  className?: string;
};

export function TraceReasoningBlock({ block, onIntent, className }: TraceReasoningBlockProps) {
  if (block.type !== "reasoning") {
    return null;
  }

  const reasoningBlock = block.block as ReasoningBlock;
  const rootClassName = [
    "os-trace-reasoning-block",
    block.collapsed ? "is-collapsed" : "is-expanded",
    className,
  ].filter(Boolean).join(" ");

  return (
    <section className={rootClassName} data-trace-reasoning>
      <header>
        <strong>{block.label}</strong>
        <button
          type="button"
          onClick={() => onIntent?.(createTraceCollapseIntent(block, !block.collapsed))}
        >
          {block.collapsed ? "Expand" : "Collapse"}
        </button>
      </header>
      {!block.collapsed ? <p>{reasoningBlock.text || block.summary}</p> : null}
    </section>
  );
}
