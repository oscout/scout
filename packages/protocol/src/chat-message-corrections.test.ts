import { expect, test } from "bun:test";
import { correctChatMessage as correct, parseChatMessageChange, readChatMessageCorrection } from "./chat-message-corrections.ts";
const original = { id: "a", actorId: "maya", body: "First", createdAt: 10, replyToMessageId: "root", metadata: { custom: "retained" }, attachments: [{ id: "file" }], mentions: [{ actorId: "alex" }], speech: { text: "First" } };

test("edits retain message identity and reject stale or unauthorized overwrites", () => {
  const edited = correct(original, { expectedRevision: 0, body: "Corrected" }, "maya", false, 20);
  expect(edited).toMatchObject({ id: "a", createdAt: 10, replyToMessageId: "root", body: "Corrected", metadata: { custom: "retained" } });
  expect(readChatMessageCorrection(edited.metadata)).toEqual({ revision: 1, editedAt: 20, changedBy: "maya" });
  expect(() => correct(edited, { expectedRevision: 0, body: "Stale" }, "maya", false, 30)).toThrow("changed since");
  expect(() => correct(original, { expectedRevision: 0, body: "Impersonation" }, "alex", true, 30)).toThrow("Only the author");
  expect(original.body).toBe("First");
});

test("deletion preserves thread anchors, clears displayed content, and is terminal", () => {
  const deleted = correct(original, { expectedRevision: 0, deleted: true }, "host", true, 30);
  expect(deleted).toMatchObject({ id: "a", replyToMessageId: "root", body: "", attachments: [], mentions: [] });
  expect(deleted.speech).toBeUndefined();
  expect(readChatMessageCorrection(deleted.metadata)).toEqual({ revision: 1, deletedAt: 30, changedBy: "host" });
  expect(() => correct(deleted, { expectedRevision: 1, body: "Revive" }, "maya", false, 40)).toThrow("already been deleted");
  expect(() => correct(original, { expectedRevision: 0, deleted: true }, "alex", false, 30)).toThrow("Only the author");
});

test("correction contract rejects broad replacement, forged authority, and blank edits", () => {
  for (const value of [null, {}, [], { expectedRevision: -1, body: "x" }, { expectedRevision: 0, body: " " }, { expectedRevision: 0, deleted: false },
    { expectedRevision: 0, body: "x", actorId: "other" }, { expectedRevision: 0, deleted: true, body: "x" }]) expect(() => parseChatMessageChange(value)).toThrow();
});
