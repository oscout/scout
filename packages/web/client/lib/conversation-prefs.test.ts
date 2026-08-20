import { afterEach, describe, expect, test } from "bun:test";

import {
  archiveConversation,
  emptyConversationPrefs,
  isArchived,
  isPinned,
  loadConversationPrefs,
  pinConversation,
  pinRank,
  saveConversationPrefs,
  toggleArchive,
  togglePin,
  unarchiveConversation,
  unpinConversation,
  __test,
} from "./conversation-prefs.ts";

afterEach(() => {
  try {
    localStorage.removeItem(__test.STORAGE_KEY);
  } catch {
    // ignore
  }
  // Reset in-memory fallback so tests don't leak across cases.
  saveConversationPrefs(emptyConversationPrefs());
});

describe("conversation prefs", () => {
  test("pin moves a conversation into pinned state and clears archive", () => {
    let prefs = emptyConversationPrefs();
    prefs = archiveConversation("c1", prefs, 10);
    expect(isArchived("c1", prefs)).toBe(true);

    prefs = pinConversation("c1", prefs, 20);
    expect(isPinned("c1", prefs)).toBe(true);
    expect(isArchived("c1", prefs)).toBe(false);
    expect(pinRank("c1", prefs)).toBe(20);
  });

  test("archive clears pin", () => {
    let prefs = pinConversation("c1", emptyConversationPrefs(), 5);
    prefs = archiveConversation("c1", prefs, 9);
    expect(isPinned("c1", prefs)).toBe(false);
    expect(isArchived("c1", prefs)).toBe(true);
  });

  test("toggle pin and archive round-trip", () => {
    let prefs = emptyConversationPrefs();
    prefs = togglePin("a", prefs);
    expect(isPinned("a", prefs)).toBe(true);
    prefs = togglePin("a", prefs);
    expect(isPinned("a", prefs)).toBe(false);

    prefs = toggleArchive("b", prefs);
    expect(isArchived("b", prefs)).toBe(true);
    prefs = unarchiveConversation("b", prefs);
    expect(isArchived("b", prefs)).toBe(false);
  });

  test("persists through loadConversationPrefs", () => {
    pinConversation("keep", emptyConversationPrefs(), 42);
    const loaded = loadConversationPrefs();
    expect(isPinned("keep", loaded)).toBe(true);
    expect(pinRank("keep", loaded)).toBe(42);
  });

  test("unpin is a no-op when not pinned", () => {
    const prefs = emptyConversationPrefs();
    expect(unpinConversation("x", prefs)).toBe(prefs);
  });
});
