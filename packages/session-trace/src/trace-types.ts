import type {
  Action,
  ActionBlock,
  Block,
  BlockState,
  QuestionBlock,
  QuestionOption,
  Session,
  SessionState,
  SessionSummary,
  SequencedEvent,
  TextBlock,
  ReasoningBlock,
  Turn,
  TurnState,
  FileBlock,
  ErrorBlock,
  FileChangeAction,
  CommandAction,
  ToolCallAction,
  SubagentAction,
} from "@openscout/agent-sessions/client";

export type SessionStatus = Session["status"];
export type SessionSnapshot = SessionState;
export type TurnStatus = TurnState["status"];
export type BlockStatus = Block["status"];
export type QuestionBlockStatus = QuestionBlock["questionStatus"];
export type ActionStatus = Action["status"];

export type {
  Action,
  ActionBlock,
  Block,
  BlockState,
  CommandAction,
  ErrorBlock,
  FileBlock,
  FileChangeAction,
  QuestionBlock,
  QuestionOption,
  ReasoningBlock,
  Session,
  SessionState,
  SessionSummary,
  SequencedEvent,
  SubagentAction,
  TextBlock,
  ToolCallAction,
  Turn,
  TurnState,
};

export interface SequencedSessionEvent {
  sequence: number;
  capturedAt: number | string | Date;
  event: SessionTraceEvent;
}

export type SessionTraceEvent =
  | { event: "session:update"; session: Session }
  | { event: "session:closed"; sessionId: string }
  | { event: "turn:start"; sessionId: string; turn: Turn }
  | { event: "turn:end"; sessionId: string; turnId: string; status: Turn["status"] }
  | { event: "turn:error"; sessionId: string; turnId: string; message: string }
  | { event: "block:start"; sessionId: string; turnId: string; block: Block }
  | { event: "block:delta"; sessionId: string; turnId: string; blockId: string; text: string }
  | { event: "block:action:output"; sessionId: string; turnId: string; blockId: string; output: string }
  | {
      event: "block:action:status";
      sessionId: string;
      turnId: string;
      blockId: string;
      status: ActionStatus;
      meta?: Record<string, unknown>;
    }
  | {
      event: "block:action:approval";
      sessionId: string;
      turnId: string;
      blockId: string;
      approval: {
        version: number;
        description?: string;
        risk?: "low" | "medium" | "high";
      };
    }
  | {
      event: "block:question:answer";
      sessionId: string;
      turnId: string;
      blockId: string;
      questionStatus: QuestionBlockStatus;
      answer?: string[];
    }
  | { event: "block:end"; sessionId: string; turnId: string; blockId: string; status: BlockStatus };

export function isActionBlock(block: Block): block is ActionBlock {
  return block.type === "action";
}

export function isReasoningBlock(block: Block): block is ReasoningBlock {
  return block.type === "reasoning";
}

export function isQuestionBlock(block: Block): block is QuestionBlock {
  return block.type === "question";
}
