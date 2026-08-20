import { describe, expect, test } from "bun:test";

import {
  buildForwardTaskInstructions,
  createForwardContextSource,
  type ForwardSourceTurn,
} from "./forward-context.ts";

const turns: ForwardSourceTurn[] = [
  { id: "one", actorLabel: "Art", body: "Keep the routing explicit." },
  { id: "two", actorLabel: "Scout", body: "I will update the flow." },
  { id: "three", actorLabel: "Art", body: "Use Codex for the new task.", attachmentCount: 1 },
];

describe("forward context", () => {
  test("keeps the selected message separate from a bounded prior excerpt", () => {
    const source = createForwardContextSource({
      conversationId: "chat:source",
      messages: turns,
      selectedMessageId: "three",
    });

    expect(source).toMatchObject({
      selectedMessageId: "three",
      sourceConversationId: "chat:source",
      recentMessageCount: 2,
    });
    expect(source.recentContext).toContain("Art:\nKeep the routing explicit.");
    expect(source.recentContext).not.toContain("Use Codex for the new task.");
    expect(source.selectedMessage).toContain("Forwarded from Art in Scout");
    expect(source.selectedMessage).toContain(
      "> [1 attachment remains on the source Scout message; not copied]",
    );
  });

  test("builds truthful message, excerpt-plus-message, and instructions-only prompts", () => {
    const source = createForwardContextSource({
      conversationId: "chat:source",
      messages: turns,
      selectedMessageId: "three",
    });

    expect(buildForwardTaskInstructions(source, "selected-message", "Investigate this.")).toBe(
      `Investigate this.\n\n---\n\n${source.selectedMessage}`,
    );
    expect(buildForwardTaskInstructions(source, "recent-context", "")).toContain(
      "Recent Scout conversation before the forwarded message (2 messages)",
    );
    expect(buildForwardTaskInstructions(source, "recent-context", "")).toContain(source.selectedMessage);
    expect(buildForwardTaskInstructions(source, "instructions-only", "Start clean.")).toBe("Start clean.");
  });
});
