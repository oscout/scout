import { expect, test } from "bun:test";
import type { QuestionRecord } from "@openscout/protocol";
import { transitionChatQuestion } from "./chat-question-transition.js";

const question: QuestionRecord = { id: "q", kind: "question", title: "Which release?", state: "open", acceptanceState: "none", createdById: "relay", askedById: "maya", ownerId: "alex", nextMoveOwnerId: "alex", createdAt: 1, updatedAt: 2 };

test("answer, reopen and close use requester identity, preserve history and monotonic versions", () => {
  const answered = transitionChatQuestion(question, "alex", { action: "answer", expectedUpdatedAt: 2, answer: "  Release two  " }, 1);
  expect(answered.record).toMatchObject({ answer: "Release two", nextMoveOwnerId: "maya", answeredById: "alex", updatedAt: 3 });
  expect(answered.event).toMatchObject({ kind: "handoff", actorId: "alex", summary: "Release two" });
  expect(() => transitionChatQuestion(answered.record, "relay", { action: "close", expectedUpdatedAt: 3 }, 4)).toThrow("requesting actor");
  const reopened = transitionChatQuestion(answered.record, "maya", { action: "reopen", expectedUpdatedAt: 3 }, 4);
  expect(reopened.record).toMatchObject({ state: "open", nextMoveOwnerId: "alex", acceptanceState: "reopened" });
  expect(reopened.record.answer).toBeUndefined();
  expect(answered.record.answer).toBe("Release two");
  const closed = transitionChatQuestion(answered.record, "maya", { action: "close", expectedUpdatedAt: 3 }, 4);
  expect(closed.record).toMatchObject({ state: "closed", closedAt: 4 });
  expect(() => transitionChatQuestion(closed.record, "maya", { action: "close", expectedUpdatedAt: 3 }, 5)).toThrow("changed");
});

test("invalid input and unassigned actors never transition a question", () => {
  for (const change of [null, { action: "approve", expectedUpdatedAt: 2 }, { action: "answer", expectedUpdatedAt: 2.5 }, { action: "answer", expectedUpdatedAt: 2, answer: " " }, { action: "answer", expectedUpdatedAt: 2, answer: "x".repeat(32001) }]) {
    expect(() => transitionChatQuestion(question, "alex", change, 4)).toThrow();
  }
  expect(() => transitionChatQuestion({ ...question, ownerId: undefined, nextMoveOwnerId: undefined }, "alex", { action: "answer", expectedUpdatedAt: 2, answer: "Two" }, 4)).toThrow("assigned respondent");
});
