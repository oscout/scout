import type { CollaborationEvent, QuestionRecord } from "@openscout/protocol";

export class ChatQuestionError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, message: string) { super(message); }
}

export function transitionChatQuestion(record: QuestionRecord, actorId: string, input: unknown, now: number): { record: QuestionRecord; event: CollaborationEvent } {
  if (!input || typeof input !== "object") throw new ChatQuestionError(400, "A question action is required.");
  const change = input as Record<string, unknown>;
  if (!Number.isSafeInteger(change.expectedUpdatedAt) || (typeof change.action !== "string" || !["answer", "close", "reopen"].includes(change.action))) {
    throw new ChatQuestionError(400, "Invalid question action or version.");
  }
  if (change.expectedUpdatedAt !== record.updatedAt) throw new ChatQuestionError(409, "This question changed. Review its current state before trying again.");
  const action = change.action;
  const requesterId = record.askedById ?? record.createdById;
  if (action === "answer") {
    if (record.state !== "open") throw new ChatQuestionError(409, "This question is no longer open.");
    if ((record.nextMoveOwnerId ?? record.ownerId) !== actorId) throw new ChatQuestionError(403, "Only the assigned respondent can answer this question.");
    if (typeof change.answer !== "string" || !change.answer.trim() || change.answer.length > 32000) throw new ChatQuestionError(400, "Enter an answer of at most 32,000 characters.");
  } else {
    if (record.state !== "answered") throw new ChatQuestionError(409, "Only an answered question can be reviewed.");
    if (requesterId !== actorId || (record.nextMoveOwnerId && record.nextMoveOwnerId !== actorId)) throw new ChatQuestionError(403, "Only the requesting actor can review this answer.");
  }
  const at = Math.max(now, record.updatedAt + 1);
  const next: QuestionRecord = action === "answer"
    ? { ...record, state: "answered", acceptanceState: "pending", answer: (change.answer as string).trim(), answeredById: actorId, answeredAt: at, closedAt: undefined, askedById: requesterId, nextMoveOwnerId: requesterId, updatedAt: at }
    : action === "close"
      ? { ...record, state: "closed", acceptanceState: "accepted", closedAt: at, nextMoveOwnerId: undefined, updatedAt: at }
      : { ...record, state: "open", acceptanceState: "reopened", nextMoveOwnerId: record.ownerId ?? record.answeredById, answer: undefined, answeredById: undefined, answeredAt: undefined, closedAt: undefined, updatedAt: at };
  return {
    record: next,
    event: { id: `evt:chat-question:${record.id}:${at}`, recordId: record.id, recordKind: "question", actorId, at,
      kind: action === "answer" ? "handoff" : action === "close" ? "accepted" : "reopened",
      summary: action === "answer" ? next.answer : action === "close" ? "Answer accepted and question closed." : "Question reopened for another answer.",
      metadata: { source: "chat", action },
    },
  };
}
