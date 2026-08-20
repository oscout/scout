import { describe, expect, test } from "bun:test";
import { isComposerSendShortcut } from "./compose-shortcuts.ts";

describe("composer shortcuts", () => {
  test("uses Cmd+Enter or Ctrl+Enter to send", () => {
    expect(isComposerSendShortcut({ key: "Enter", metaKey: true })).toBe(true);
    expect(isComposerSendShortcut({ key: "Enter", ctrlKey: true })).toBe(true);
  });

  test("leaves plain Enter and Shift+Enter for line breaks", () => {
    expect(isComposerSendShortcut({ key: "Enter" })).toBe(false);
    expect(isComposerSendShortcut({ key: "Enter", shiftKey: true })).toBe(false);
    expect(isComposerSendShortcut({ key: "Enter", metaKey: true, shiftKey: true })).toBe(false);
  });

  test("supports task composers where Enter sends and Shift+Enter inserts a line break", () => {
    expect(isComposerSendShortcut({ key: "Enter" }, true)).toBe(true);
    expect(isComposerSendShortcut({ key: "Enter", shiftKey: true }, true)).toBe(false);
  });

  test("does not send while IME composition is active", () => {
    expect(
      isComposerSendShortcut({
        key: "Enter",
        metaKey: true,
        nativeEvent: { isComposing: true },
      }),
    ).toBe(false);
  });
});
