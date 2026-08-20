import { describe, expect, test } from "bun:test";

import {
  contextCaptureDraftHasContent,
  dictationBlocksContextCaptureClose,
  mergeContextCaptureDraft,
} from "./context-capture-draft.ts";

function capture(name: string, lastModified = 1): File {
  return new File([name], name, { type: "text/plain", lastModified });
}

describe("context capture draft resilience", () => {
  test("only presents a restored state for drafts with unsent content", () => {
    const empty = mergeContextCaptureDraft(null, {});
    const message = mergeContextCaptureDraft(null, { message: "  Keep this  " });
    const attachment = mergeContextCaptureDraft(null, { files: [capture("notes.md")] });

    expect(contextCaptureDraftHasContent(empty)).toBe(false);
    expect(contextCaptureDraftHasContent(message)).toBe(true);
    expect(contextCaptureDraftHasContent(attachment)).toBe(true);
  });

  test("reopens an unsent draft without losing its target, text, or files", () => {
    const first = mergeContextCaptureDraft(null, {
      intent: "route-capture",
      agentId: "agent:one",
      conversationId: "chat:one",
      message: "Keep this thought",
      files: [capture("notes.md")],
      preferExistingChat: true,
    });
    first.projectPath = "/work/project";
    first.projectQuery = "Project";

    const reopened = mergeContextCaptureDraft(first, {});

    expect(reopened).toMatchObject({
      intent: "route-capture",
      agentId: "agent:one",
      conversationId: "chat:one",
      message: "Keep this thought",
      mode: "existing-chat",
      projectPath: "/work/project",
      projectQuery: "Project",
    });
    expect(reopened.files.map((file) => file.name)).toEqual(["notes.md"]);
  });

  test("a fresh task keeps the draft but drops every hidden agent or session route", () => {
    const contextual = mergeContextCaptureDraft(null, {
      intent: "route-capture",
      agentId: "agent:old",
      conversationId: "chat:old",
      message: "Keep this thought",
      preferExistingChat: true,
    });
    contextual.projectPath = "/work/openscout";

    const fresh = mergeContextCaptureDraft(contextual, { intent: "new-task" });

    expect(fresh).toEqual(expect.objectContaining({
      intent: "new-task",
      message: "Keep this thought",
      projectPath: "/work/openscout",
      mode: "new-session",
    }));
    expect(fresh).not.toHaveProperty("agentId");
    expect(fresh).not.toHaveProperty("conversationId");
  });

  test("adds a new capture to the restored draft without duplicating existing files", () => {
    const notes = capture("notes.md");
    const current = mergeContextCaptureDraft(null, {
      message: "Existing draft",
      files: [notes],
    });

    const merged = mergeContextCaptureDraft(current, {
      files: [notes, capture("screen.png", 2)],
      attachmentFeedback: "Added a new capture.",
    });

    expect(merged.message).toBe("Existing draft");
    expect(merged.files.map((file) => file.name)).toEqual(["notes.md", "screen.png"]);
    expect(merged.attachmentFeedback).toBe("Added a new capture.");
  });

  test("preserves an explicit forward source and context choice without leaking them to a normal task", () => {
    const source = {
      selectedMessage: "Forwarded message",
      selectedMessageId: "message:one",
      sourceConversationId: "chat:one",
      recentContext: "Earlier context",
      recentMessageCount: 1,
    };
    const forwarded = mergeContextCaptureDraft(null, {
      intent: "forward-message",
      forwardContext: source,
      forwardContextMode: "recent-context",
    });

    expect(contextCaptureDraftHasContent(forwarded)).toBe(true);
    expect(forwarded).toMatchObject({
      intent: "forward-message",
      forwardContext: source,
      forwardContextMode: "recent-context",
    });

    const fresh = mergeContextCaptureDraft(forwarded, { intent: "new-task" });
    expect(fresh.forwardContext).toBeUndefined();
    expect(fresh.forwardContextMode).toBe("selected-message");
  });

  test("keeps the sheet mounted throughout the dictation lifecycle", () => {
    expect(dictationBlocksContextCaptureClose("starting")).toBe(true);
    expect(dictationBlocksContextCaptureClose("recording")).toBe(true);
    expect(dictationBlocksContextCaptureClose("processing")).toBe(true);
    expect(dictationBlocksContextCaptureClose("idle")).toBe(false);
    expect(dictationBlocksContextCaptureClose(null)).toBe(false);
  });
});
