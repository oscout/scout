"use client";

import React from "react";
import { createTraceCollapseIntent, type ActionBlock, type TraceBlockViewModel, type TraceIntent } from "@openscout/session-trace";
import { TraceApprovalCard } from "./TraceApprovalCard.js";

type TraceActionBlockProps = {
  block: TraceBlockViewModel;
  onIntent?: (intent: TraceIntent) => void;
  className?: string;
};

export function TraceActionBlock({ block, onIntent, className }: TraceActionBlockProps) {
  if (block.type !== "action") {
    return null;
  }

  const actionBlock = block.block as ActionBlock;
  const rootClassName = [
    "os-trace-action-block",
    actionBlock.action.kind,
    className,
  ].filter(Boolean).join(" ");

  const action = actionBlock.action;

  return (
    <section className={rootClassName} data-trace-action>
      <header>
        <strong>{block.label}</strong>
        <span>{action.status.replaceAll("_", " ")}</span>
      </header>
      <p>{block.summary}</p>
      {action.output ? <pre>{action.output}</pre> : null}
      <div data-trace-actions>
        <button
          type="button"
          onClick={() => onIntent?.(createTraceCollapseIntent(block, !block.collapsed))}
        >
          {block.collapsed ? "Expand" : "Collapse"}
        </button>
      </div>
      {action.approval ? <TraceApprovalCard block={block} onIntent={onIntent} /> : null}
    </section>
  );
}
