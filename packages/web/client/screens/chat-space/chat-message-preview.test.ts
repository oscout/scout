import { expect, test } from "bun:test";
import { chatMessagePreviewText } from "./chat-message-preview.ts";
import type { ChatMessage } from "./chat-api.ts";
const message = { id: "message", actorId: "alex", body: "  Saved context  ", createdAt: 1, class: "agent" } as ChatMessage;
test("previews distinguish text, files, and genuinely empty messages", () => {
  expect(chatMessagePreviewText(message)).toBe("Saved context");
  expect(chatMessagePreviewText({ ...message, body: "", attachments: [{ id: "file", mediaType: "text/markdown", fileName: "notes.md" }] })).toBe("notes.md");
  expect(chatMessagePreviewText({ ...message, body: "" })).toBe("Empty message");
  expect(chatMessagePreviewText({ ...message, body: "x".repeat(200) })).toHaveLength(100);
});
test("a tombstone cannot expose retained body or file names", () => {
  expect(chatMessagePreviewText({ ...message, metadata: { chatCorrection: { revision: 1, changedBy: "alex", deletedAt: 2 } }, attachments: [{ id: "file", mediaType: "text/plain", fileName: "private.md" }] })).toBe("Message deleted");
});
