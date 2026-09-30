import { expect, test } from "bun:test";
import type { QuestionRecord } from "@openscout/protocol";
import { chatQuestionPage, chatQuestionAttentionCounts } from "./chat-question-page.ts";
const question = (id: string, conversationId = "channel"): QuestionRecord => ({ id, kind: "question", title: id, state: "open", acceptanceState: "none", conversationId, createdById: "maya", createdAt: 1, updatedAt: 1 });

test("question pages include threads and old open records but exclude other rooms and terminal states", () => {
  const result = chatQuestionPage([question("a"), question("b", "thread"), question("c", "elsewhere"), { ...question("d"), state: "closed" }, { ...question("e"), state: "answered", answer: "Two" }], "channel", new Set(["thread"]));
  expect(result.records.map(record => record.id)).toEqual(["a", "b", "e"]);
  expect(result.nextCursor).toBeNull();
});
test("equal timestamps paginate without gaps even after the previous boundary closes", () => {
  const rows = [question("a"), question("b"), question("c")];
  const first = chatQuestionPage(rows, "channel", new Set(), null, 2);
  rows[1] = { ...rows[1]!, state: "closed" };
  expect(chatQuestionPage(rows, "channel", new Set(), first.nextCursor, 2).records.map(record => record.id)).toEqual(["c"]);
  expect(() => chatQuestionPage(rows, "other", new Set(), first.nextCursor)).toThrow("cursor");
  expect(() => chatQuestionPage(rows, "channel", new Set(), "bad cursor")).toThrow("cursor");
});


test("question attention follows the actionable person and visible root channel independently of reads", () => {
  const records = [
    { ...question("assigned"), ownerId: "alex" },
    { ...question("thread", "thread"), nextMoveOwnerId: "alex" },
    { ...question("review"), state: "answered" as const, askedById: "alex", nextMoveOwnerId: "alex" },
    { ...question("other"), ownerId: "maya" },
    { ...question("settled"), state: "closed" as const, ownerId: "alex" },
    { ...question("hidden", "private"), ownerId: "alex" },
    { ...question("hidden-thread", "private-thread"), ownerId: "alex" },
    { ...question("handed-off"), state: "answered" as const, askedById: "alex", nextMoveOwnerId: "maya" },
    question("unassigned"),
  ];
  const conversations = { thread: { kind: "thread", parentConversationId: "channel" }, "private-thread": { kind: "thread", parentConversationId: "private" } } as Parameters<typeof chatQuestionAttentionCounts>[1];
  expect(chatQuestionAttentionCounts(records, conversations, new Set(["channel"]), "alex")).toEqual({ channel: 3 });
  expect(chatQuestionAttentionCounts(records, conversations, new Set(), "alex")).toEqual({});
});

test("history includes only terminal records and cannot reuse an open-question cursor", () => {
  const rows = [{ ...question("a"), state: "closed" as const }, { ...question("b"), state: "declined" as const }, question("c")];
  const first = chatQuestionPage(rows, "channel", new Set(), null, 1, true);
  expect(first.records.map(row => row.id)).toEqual(["a"]);
  expect(chatQuestionPage(rows, "channel", new Set(), first.nextCursor, 1, true).records.map(row => row.id)).toEqual(["b"]);
  expect(() => chatQuestionPage(rows, "channel", new Set(), first.nextCursor)).toThrow("cursor");
});
