import { expect, test } from "bun:test";
import { mergeChatMessageRevisions, newestChatMessage } from "./chat-message-revisions.ts";
import type { ChatMessage } from "./chat-api.ts";
const original: ChatMessage = { id: "a", actorId: "maya", body: "Original", class: "agent", createdAt: 1 };
const edited: ChatMessage = { ...original, body: "Edited", metadata: { chatCorrection: { revision: 1, editedAt: 2, changedBy: "maya" } } };
test("late polls cannot resurrect old text or a deleted message", () => {
  expect(newestChatMessage(edited, original)).toBe(edited);
  const deleted = { ...edited, body: "", metadata: { chatCorrection: { revision: 2, deletedAt: 3, changedBy: "maya" } } };
  expect(newestChatMessage(deleted, edited)).toBe(deleted);
  expect(newestChatMessage(edited, deleted)).toBe(deleted);
  expect(mergeChatMessageRevisions([edited], [original])).toEqual([edited]);
});
test("equal revisions can refresh reactions and a new page retains its own membership", () => {
  const fresh = { ...edited, reactions: [] };
  expect(newestChatMessage(edited, fresh)).toBe(fresh);
  expect(mergeChatMessageRevisions([edited], [{ ...original, id: "b" }])).toEqual([{ ...original, id: "b" }]);
});
