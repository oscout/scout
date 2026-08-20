export interface TraceTargetRef {
  sessionId: string;
  turnId: string;
  id: string;
}

export type TraceIntent =
  | {
      type: "answer";
      sessionId: string;
      turnId: string;
      blockId: string;
      answer: string[];
    }
  | {
      type: "decide";
      sessionId: string;
      turnId: string;
      blockId: string;
      version: number;
      decision: "approve" | "deny";
      reason?: string;
    }
  | {
      type: "copy";
      targetId: string;
      text: string;
    }
  | {
      type: "collapse";
      sessionId: string;
      turnId: string;
      blockId: string;
      collapsed: boolean;
    }
  | {
      type: "jump";
      targetId: string;
    };

export interface TraceApprovalTargetRef extends TraceTargetRef {
  approvalVersion: number;
}

export function createTraceAnswerIntent(
  question: TraceTargetRef,
  answer: string[],
): TraceIntent {
  return {
    type: "answer",
    sessionId: question.sessionId,
    turnId: question.turnId,
    blockId: question.id,
    answer,
  };
}

export function createTraceDecisionIntent(
  block: TraceApprovalTargetRef,
  decision: "approve" | "deny",
  reason?: string,
): TraceIntent {
  return {
    type: "decide",
    sessionId: block.sessionId,
    turnId: block.turnId,
    blockId: block.id,
    version: block.approvalVersion,
    decision,
    reason,
  };
}

export function createTraceCopyIntent(targetId: string, text: string): TraceIntent {
  return {
    type: "copy",
    targetId,
    text,
  };
}

export function createTraceCollapseIntent(
  block: TraceTargetRef,
  collapsed: boolean,
): TraceIntent {
  return {
    type: "collapse",
    sessionId: block.sessionId,
    turnId: block.turnId,
    blockId: block.id,
    collapsed,
  };
}

export function createTraceJumpIntent(targetId: string): TraceIntent {
  return {
    type: "jump",
    targetId,
  };
}
