import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SWIPE_COMMIT_PX, SWIPE_CUE_PX } from "./gesture-machine.ts";

/** P0.8 and the gesture/overlay policies that go with it.
 *
 * P0.8 was operator-observed: long-pressing a message raised WebKit's native
 * selection loupe, callout bar and tap-highlight *on top of* the custom focus
 * gesture. These assertions pin the fix and, just as importantly, pin its
 * scope — the cure must not reach the composer. */

const dir = import.meta.dir;
// The Swift surface lives in the private iOS tree; source-only checkouts skip
// the parity guard.
const EMBEDDED_CHAT_SURFACE = join(dir, "../../../../../apps/ios/Scout/EmbeddedChatSurface.swift");
const css = readFileSync(join(dir, "scout-chat.css"), "utf8");
const main = readFileSync(join(dir, "main.tsx"), "utf8");

function ruleFor(source: string, selector: string) {
  const index = source.indexOf(selector);
  if (index === -1) return null;
  const open = source.indexOf("{", index);
  const close = source.indexOf("}", open);
  return open === -1 || close === -1 ? null : source.slice(open + 1, close);
}

describe("P0.8 — no selection flash on long-press", () => {
  const policy = ruleFor(css, ".message-hit, .message-hit * {");

  it("applies the policy to the subtree, not just the hit target", () => {
    // The text the loupe grabs lives in the bubble, a descendant — a rule on
    // `.message-hit` alone never covered it.
    expect(policy).not.toBeNull();
    expect(css).toContain(".message-hit, .message-hit * {");
  });

  it("uses the prefixed property WebKit actually honours", () => {
    // `user-select:none` unprefixed is inert on iOS. This was the original bug.
    expect(policy).toContain("-webkit-user-select: none");
    expect(policy).toContain("user-select: none");
  });

  it("suppresses the callout, the drag, and the tap highlight", () => {
    expect(policy).toContain("-webkit-touch-callout: none");
    expect(policy).toContain("-webkit-user-drag: none");
    // The hit target is a div with role=button, so the global `button` rule at
    // the top of the file never reached it.
    expect(policy).toContain("-webkit-tap-highlight-color: transparent");
  });

  it.skipIf(!existsSync(EMBEDDED_CHAT_SURFACE))("never disables text interaction WebView-wide", () => {
    // Forbidden: it would take the composer's loupe, caret and editing with it.
    const swift = readFileSync(EMBEDDED_CHAT_SURFACE, "utf8");
    expect(swift).not.toContain("textInteractionEnabled");
  });

  it("leaves the composer's own selection alone", () => {
    // The policy is scoped to `.message-hit`; nothing may blanket the app.
    for (const blanket of ["* { -webkit-user-select: none", "body { -webkit-user-select: none"]) {
      expect(css).not.toContain(blanket);
    }
    expect(ruleFor(css, ".composer-field")).not.toContain("user-select: none");
  });
});

describe("exiting layers stop taking touches", () => {
  it("drops pointer-events for every closing layer", () => {
    // A layer is still in the tree for its 160ms exit. Without this, a fast
    // follow-up tap is eaten by a scrim the operator already dismissed.
    const block = /\.focus-layer\[data-phase="closing"\],[\s\S]{0,240}?\{([^}]*pointer-events:none[^}]*)\}/.exec(css);
    expect(block, "no closing-phase pointer-events rule").not.toBeNull();
    for (const layer of ["focus-layer", "identity-layer", "sheet-layer", "attachment-tray"]) {
      expect(css.includes(`.${layer}[data-phase="closing"]`), layer).toBe(true);
    }
  });
});

describe("swipe-reply settle", () => {
  it("settles back under a transform transition, not a snap", () => {
    const rule = ruleFor(css, '.message-hit[data-settling="true"]');
    expect(rule).toContain("transition: transform");
    // Transform only — settling must not animate layout.
    expect(rule).not.toMatch(/transition:[^;]*(width|height|left|margin)/);
  });

  it("is interruptible: a new press clears the settle before it finishes", () => {
    // The spring-back must never fight the finger.
    // Asserted as a boolean so a failure does not dump the whole module.
    expect(main.includes("swipeRef.current = 0; setSettling(false); setSwipeX(0); clear();")).toBe(true);
  });

  it("only settles an abandoned gesture, never a committed or cancelled one", () => {
    // The three-way outcome is decided in `gesture-machine.ts` and exercised in
    // `gesture-thresholds.test.ts`; what this file still owns is that the
    // handler acts on all three branches, and that cancel resets flat.
    expect(main.includes('if (outcome === "commit") onReply?.(); else if (outcome === "settle") setSettling(true)')).toBe(true);
    expect(main.includes("onPointerCancel={() => { clear(); swipeRef.current = 0; setSettling(false); setSwipeX(0); }}")).toBe(true);
  });

  it("keeps the 42px commit threshold and the 18px cue", () => {
    // Read the constants rather than the source text: this now fails when the
    // numbers change, which the string match could not do once they moved.
    expect(SWIPE_COMMIT_PX).toBe(42);
    expect(SWIPE_CUE_PX).toBe(18);
    expect(main.includes("releaseOutcome(swipeRef.current)")).toBe(true);
    expect(main.includes("showsSwipeCue(swipeX, { focused })")).toBe(true);
  });
});

describe("F2 — the transcript reveal is a first-paint event", () => {
  it("latches, so a refresh cannot replay the fade", () => {
    // `loading` legitimately flips again on a manual refresh or history load;
    // the reveal must not follow it.
    expect(main.includes("if (!loading) hasRevealed.current = true;")).toBe(true);
    expect(main.includes("data-revealed={hasRevealed.current || undefined}")).toBe(true);
    // The old form keyed straight off loading and would re-run the animation.
    expect(main.includes("data-revealed={!loading}")).toBe(false);
  });
});
