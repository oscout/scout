"use client";

import React from "react";
import { type TraceIntent, type TraceTurnViewModel } from "@openscout/session-trace";
import { TraceBlock } from "./TraceBlock.js";

type TraceTurnProps = {
  turn: TraceTurnViewModel;
  onIntent?: (intent: TraceIntent) => void;
  className?: string;
};

export function TraceTurn({ turn, onIntent, className }: TraceTurnProps) {
  const rootClassName = ["os-trace-turn", turn.isCurrent ? "is-current" : null, className].filter(Boolean).join(" ");

  return (
    <section className={rootClassName} data-trace-turn>
      <header>
        <strong>Turn {turn.id}</strong>
        <span>{turn.statusLabel}</span>
        <time dateTime={typeof turn.startedAt === "string" ? turn.startedAt : undefined}>{turn.startedAtLabel}</time>
      </header>
      <div data-trace-blocks>
        {turn.blocks.map((block) => (
          <TraceBlock key={block.id} block={block} onIntent={onIntent} />
        ))}
      </div>
    </section>
  );
}

