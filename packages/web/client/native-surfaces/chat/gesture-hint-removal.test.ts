import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The floating "Reactions and replies / Touch and hold any message" card is
 * gone for good. It taught something the surface already affords, and it sat
 * on top of the conversation to do it.
 *
 * Removing an onboarding hint is easy to undo by accident, and the failure is
 * silent — a re-added overlay looks like a feature, not a regression. So this
 * pins two things at once: the hint stays deleted, AND the interactions it
 * used to advertise stay wired. Deleting the affordances to make the first
 * half pass would fail the second half. */

const SOURCE = ["main.tsx", "presentation.ts"];
const STYLESHEETS = ["scout-chat.css", "messages-theme.css", "whatsapp-theme.css"];

function read(fileName: string) {
  return readFileSync(join(import.meta.dir, fileName), "utf8");
}

/** Every trace of the hint: markup, copy, state, and its persisted key. */
const HINT_TRACES = [
  "gesture-hint",
  "gestureHint",
  "Touch and hold",
  "Reactions and replies",
  "dismissGestureHint",
  "scout.chat.gesture-hint",
];

describe("gesture hint removal", () => {
  it.each([...SOURCE, ...STYLESHEETS])("leaves no trace of the hint in %s", (fileName) => {
    const contents = read(fileName);
    const found = HINT_TRACES.filter((trace) => contents.includes(trace));
    expect(found).toEqual([]);
  });

  it("does not leave the persisted dismissal key behind", () => {
    // The key must not linger even in a migration or cleanup path — nothing
    // reads it, so nothing should write or clear it either.
    for (const fileName of SOURCE) {
      expect(read(fileName)).not.toMatch(/gesture-hint/i);
    }
  });
});

describe("the interactions the hint used to advertise", () => {
  const main = read("main.tsx");

  it("still opens the actions sheet from a long press", () => {
    // The long-press timer arms the focus handler that opens the sheet. The
    // 420ms itself now lives in `gesture-machine.ts` beside the arming rule.
    expect(main).toContain("timer.current = window.setTimeout(onFocus, LONG_PRESS_MS)");
    expect(main).toContain("onFocus={() => setFocusedId(message.id)}");
  });

  it("still opens the actions sheet from a context menu and keyboard", () => {
    expect(main).toContain("onContextMenu={(event) => { event.preventDefault(); onFocus(); }}");
    expect(main).toMatch(/event\.key === "Enter" \|\| event\.key === " "/);
  });

  it("still supports swipe-right to reply", () => {
    expect(main).toContain("swipe-reply-cue");
    // The threshold moved out of this file into `gesture-machine.ts`, where it
    // can be exercised rather than spelled. Asserting the literal `>= 42` here
    // was the brittleness §6.3 was raised to remove — see
    // `gesture-thresholds.test.ts` for the arithmetic itself.
    expect(main).toContain("releaseOutcome(swipeRef.current)");
    expect(main).toContain('if (outcome === "commit") onReply?.()');
  });

  it("still renders the reply composer target and the reactions row", () => {
    expect(main).toContain("reply-target");
    expect(main).toContain("reaction-picker");
    expect(main).toContain("action-menu");
  });

  it("keeps the floating overlays that are NOT the hint", () => {
    // jump-to-latest and the toast shared a placement rule with the hint;
    // removing the hint must not take their layout with it.
    expect(main).toContain("jump-button");
    expect(main).toContain('className="toast"');
    const messages = read("messages-theme.css");
    expect(messages).toContain('.chat-app[data-style="messages"] .jump-button,');
    expect(messages).toContain('.chat-app[data-style="messages"] .toast {');
  });
});
