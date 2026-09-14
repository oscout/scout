import { describe, expect, test } from "bun:test";
import {
  clearOperatorTitle,
  CONVERSATION_TITLE_MAX,
  isOperatorTitled,
  markOperatorTitled,
  normalizeConversationTitle,
  resolveConversationTitle,
} from "./conversation-title.ts";

describe("normalizeConversationTitle", () => {
  test("trims and collapses whitespace", () => {
    expect(normalizeConversationTitle("  terminal   polish  ")).toBe("terminal polish");
    expect(normalizeConversationTitle("a\n\nb\tc")).toBe("a b c");
  });

  test("whitespace-only means hand it back to automatic naming, not an error", () => {
    expect(normalizeConversationTitle("   ")).toBe("");
    expect(normalizeConversationTitle("")).toBe("");
  });

  test("control characters never reach the rail", () => {
    expect(normalizeConversationTitle("we\u0007ird\u0000 name")).toBe("we ird name");
  });

  test("non-strings are empty, not a throw", () => {
    expect(normalizeConversationTitle(null)).toBe("");
    expect(normalizeConversationTitle(42)).toBe("");
    expect(normalizeConversationTitle({ title: "x" })).toBe("");
  });

  test("caps without leaving a trailing space", () => {
    const long = `${"x".repeat(CONVERSATION_TITLE_MAX - 1)} tail`;
    const capped = normalizeConversationTitle(long);
    expect(capped.length).toBeLessThanOrEqual(CONVERSATION_TITLE_MAX);
    expect(capped).toBe(capped.trim());
  });
});

describe("operator ownership", () => {
  test("an untouched conversation is not operator-titled", () => {
    expect(isOperatorTitled(undefined)).toBe(false);
    expect(isOperatorTitled({})).toBe(false);
    expect(isOperatorTitled({ titleSource: "derived" })).toBe(false);
  });

  test("marking keeps the rest of the metadata", () => {
    const next = markOperatorTitled({ surface: "broker", naturalKey: "a\u0000b" }, 1700);
    expect(next.surface).toBe("broker");
    expect(next.naturalKey).toBe("a\u0000b");
    expect(isOperatorTitled(next)).toBe(true);
    expect(next.titleSetAt).toBe(1700);
  });

  test("clearing removes both marks and nothing else", () => {
    const next = clearOperatorTitle(markOperatorTitled({ surface: "broker" }, 1700));
    expect(isOperatorTitled(next)).toBe(false);
    expect(next.titleSetAt).toBeUndefined();
    expect(next.surface).toBe("broker");
  });
});

describe("resolveConversationTitle", () => {
  test("automatic naming applies when no one has renamed the thread", () => {
    expect(resolveConversationTitle({
      derived: "openscout-einstein-6",
      existingTitle: "Art <> openscout-einstein-6",
      existingMetadata: { surface: "broker" },
    })).toBe("openscout-einstein-6");
  });

  test("a rename survives the broker re-deriving the conversation", () => {
    // The real regression: a share-mode flip re-upserts the definition, and
    // without this guard the derived title would overwrite the human's.
    expect(resolveConversationTitle({
      derived: "Art <> openscout-einstein-6",
      existingTitle: "terminal polish",
      existingMetadata: markOperatorTitled({}, 1),
    })).toBe("terminal polish");
  });

  test("an operator mark with no usable title falls back rather than blanking", () => {
    expect(resolveConversationTitle({
      derived: "openscout-einstein-6",
      existingTitle: "   ",
      existingMetadata: markOperatorTitled({}, 1),
    })).toBe("openscout-einstein-6");
    expect(resolveConversationTitle({
      derived: "openscout-einstein-6",
      existingTitle: null,
      existingMetadata: markOperatorTitled({}, 1),
    })).toBe("openscout-einstein-6");
  });

  test("a brand new conversation just takes the derived name", () => {
    expect(resolveConversationTitle({ derived: "Scout" })).toBe("Scout");
  });
});
