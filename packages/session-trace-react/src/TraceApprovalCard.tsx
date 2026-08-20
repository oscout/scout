"use client";

import React from "react";
import { createTraceDecisionIntent, describeTraceApprovalSummary, formatTraceActionKind, type ActionBlock, type TraceBlockViewModel, type TraceIntent } from "@openscout/session-trace";

type TraceApprovalCardProps = {
  block: TraceBlockViewModel;
  onIntent?: (intent: TraceIntent) => void;
  className?: string;
};

export function TraceApprovalCard({ block, onIntent, className }: TraceApprovalCardProps) {
  if (block.type !== "action") {
    return null;
  }

  const actionBlock = block.block as ActionBlock;
  const approval = actionBlock.action.approval;
  if (!approval) {
    return null;
  }
  const rootClassName = ["os-trace-approval-card", className].filter(Boolean).join(" ");

  return (
    <section className={rootClassName} data-trace-approval>
      <div data-trace-meta>
        <strong>{formatTraceActionKind(actionBlock.action.kind)}</strong>
        <span>{describeTraceApprovalSummary(approval.risk)}</span>
      </div>
      {approval.description ? <p>{approval.description}</p> : null}
      <div data-trace-actions>
        <button
          type="button"
          onClick={() =>
            onIntent?.(
              createTraceDecisionIntent(
                {
                  sessionId: block.sessionId,
                  turnId: block.turnId,
                  id: block.id,
                  approvalVersion: approval.version,
                },
                "approve",
              ),
            )
          }
        >
          Approve
        </button>
        <button
          type="button"
          onClick={() =>
            onIntent?.(
              createTraceDecisionIntent(
                {
                  sessionId: block.sessionId,
                  turnId: block.turnId,
                  id: block.id,
                  approvalVersion: approval.version,
                },
                "deny",
              ),
            )
          }
        >
          Deny
        </button>
      </div>
    </section>
  );
}
