import { describe, expect, test } from "bun:test";
import {
  conversationFailureNotice,
  conversationalMessagePreview,
  conversationalTargetLabel,
  isNoisyConversationStatusMessage,
} from "./message-visibility.ts";

describe("conversation message presentation", () => {
  test("presents a missing Codex rollout as a human failure notice", () => {
    const notice = conversationFailureNotice({
      actorId: "system",
      class: "status",
      body: [
        "openscout-quill-5 failed to respond.",
        "Failed to resume requested Codex thread thread-1: no rollout found for thread id thread-1",
      ].join("\n"),
    });

    expect(notice).toEqual({
      target: "openscout-quill-5",
      explanation: "The session linked to this conversation is no longer available.",
      technicalDetail:
        "Failed to resume requested Codex thread thread-1: no rollout found for thread id thread-1",
    });
  });

  test("keeps unrelated status and authored messages on their normal path", () => {
    expect(conversationFailureNotice({
      actorId: "system",
      class: "status",
      body: "Agent One is waiting for approval.",
    })).toBeNull();
    expect(conversationFailureNotice({
      actorId: "agent-1",
      class: "agent",
      body: "Agent One failed to respond.",
    })).toBeNull();
  });

  test("presents an unaccepted Scout request as a clearable failure notice", () => {
    expect(conversationFailureNotice({
      actorId: "system",
      class: "status",
      body: "Arach sent a request to Scout, but no operator session accepted it.",
    })).toEqual({
      target: "Scout",
      explanation: "No available Scout session accepted this request.",
      technicalDetail: null,
    });
  });

  test("keeps technical failure text out of conversation previews", () => {
    expect(conversationalMessagePreview([
      "Agent One failed to respond.",
      "No conversation found with session ID: stale-session",
    ].join("\n"))).toBe(
      "Agent One couldn’t reply. The session linked to this conversation is no longer available.",
    );
  });

  test("turns generated OpenScout worker ids into human labels", () => {
    expect(conversationalTargetLabel("openscout-quill-5")).toBe("Quill");
    expect(conversationalTargetLabel("Agent One")).toBe("Agent One");
  });

  test("continues to hide the duplicate snapshot failure noise", () => {
    expect(isNoisyConversationStatusMessage({
      actorId: "system",
      class: "status",
      body: "Agent One failed to respond.\nsnapshot.messages could not be read",
    })).toBe(true);
  });
});
