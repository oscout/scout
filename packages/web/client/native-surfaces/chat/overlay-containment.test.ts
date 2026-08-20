import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** P0.4 / P0.5 — the message-actions overlay must stay inside the phone.
 *
 * What went wrong, in the operator's 2026-08-12 captures: the reaction picker,
 * lifted message and action menu were shifted ~68pt right and clipped by the
 * screen edge, with the quoted line cut mid-word rather than ellipsised — the
 * signature of clipping, not truncation.
 *
 * Mechanism, and why these specific rules are load-bearing:
 *   1. `.quoted-message span` is a GRID ITEM with `white-space:nowrap`. A grid
 *      item's automatic minimum size is its min-content, and nowrap makes that
 *      the entire unwrapped sentence (~460pt). `overflow:hidden` clips at paint
 *      and does NOT reduce a min-content contribution — only a floor does.
 *   2. `.focus-layer` used an implicit `auto` track, and an auto track takes its
 *      base size from the item's min-content contribution. So (1) grew the track
 *      past the phone, and `justify-items:center` then centred the stack inside
 *      the oversized track — pushing it off-screen.
 *
 * This is the same bug class the transcript already fixed once via
 * `.chat-app > * { min-width: 0 }` (see the note at the top of scout-chat.css);
 * the overlay layers had simply never been given the same treatment.
 *
 * These are static assertions on the stylesheet. The real geometry is measured
 * in a browser by `design/captures/chat-density/overlay-containment.html` (18
 * cases: 3 widths × 2 styles × 3 densities, against an adversarial fixture).
 * This suite exists so a rule change that silently re-opens the hole fails here,
 * in CI, before anyone has to look at a phone. */

const dir = import.meta.dir;
const css = readFileSync(join(dir, "scout-chat.css"), "utf8");
const whatsapp = readFileSync(join(dir, "whatsapp-theme.css"), "utf8");

function ruleFor(source: string, selector: string) {
  const index = source.indexOf(selector);
  if (index === -1) return null;
  const open = source.indexOf("{", index);
  const close = source.indexOf("}", open);
  return open === -1 || close === -1 ? null : source.slice(open + 1, close);
}

describe("overlay track cannot be widened by its content", () => {
  it("gives the focus layer a 0-floor track instead of an auto one", () => {
    const layer = ruleFor(css, ".focus-layer{")!;
    expect(layer).toContain("grid-template-columns:minmax(0,1fr)");
    // `place-items:center` alone leaves the track `auto`, which is the hole.
    expect(layer).not.toMatch(/place-items\s*:\s*center/);
    expect(layer).toContain("justify-items:center");
  });

  it("gives the identity layer the same 0-floor track", () => {
    const layer = ruleFor(css, ".identity-layer {")!;
    expect(layer).toContain("grid-template-columns:minmax(0,1fr)");
    expect(layer).not.toMatch(/place-items\s*:\s*center/);
  });

  it("floors the nowrap quote so the ellipsis can actually engage", () => {
    const quoted = ruleFor(css, ".quoted-message span {")!;
    expect(quoted).toContain("min-width: 0");
    // The floor only matters because the quote refuses to wrap.
    expect(quoted).toContain("white-space: nowrap");
  });

  it("lets every box in the lifted-message chain shrink", () => {
    for (const selector of [
      ".focused-message{",
      ".focused-message>.message-row{",
      ".focused-message>.message-row .bubble-stack{",
      ".action-menu{",
    ]) {
      expect(ruleFor(css, selector), selector).toContain("min-width:0");
    }
    expect(ruleFor(whatsapp, '.chat-app[data-style="whatsapp"] .focused-message {')!)
      .toContain("min-width: 0");
  });

  it("caps the wide atoms at the width actually available", () => {
    // 230pt and 224pt floors are preferences, not licences to overflow a 320pt
    // phone. Left uncapped they propagate up and widen whatever contains them.
    expect(ruleFor(css, ".file-card {")!).toContain("min-width: min(230px, 100%)");
    expect(ruleFor(css, ".file-card {")!).toContain("max-width: 100%");
    expect(ruleFor(css, ".voice-note{")!).toContain("min-width:min(224px,100%)");
  });

  it("measures the stack against the space it has, without a second gutter", () => {
    // `calc(100% - 40px)` double-inset the stack: the layer's own padding had
    // already reserved that space.
    expect(ruleFor(css, ".focused-message{")!).toContain("width:min(324px,100%)");
    expect(ruleFor(whatsapp, '.chat-app[data-style="whatsapp"] .focused-message {')!)
      .toContain("width: min(340px, 100%)");
  });

  it("insets the layer by all four safe-area edges", () => {
    const layer = ruleFor(css, ".focus-layer{")!;
    for (const edge of ["top", "right", "bottom", "left"]) {
      expect(layer, edge).toContain(`env(safe-area-inset-${edge})`);
    }
  });
});

describe("44pt targets survive a 320pt phone", () => {
  /** Seven 44pt targets are 308pt of hard minimum; a 320pt phone leaves ~280pt
   * between the gutters. The row cannot fit, so it must scroll or drop targets —
   * shrinking them is the one thing that is not allowed. */
  it("scrolls the reaction row rather than shrinking a target", () => {
    const picker = ruleFor(css, ".reaction-picker{")!;
    expect(picker).toContain("overflow-x:auto");
    expect(picker).toContain("min-width:0");
    expect(ruleFor(css, ".reaction-picker button{")!).toContain("width:44px");
    expect(ruleFor(css, ".reaction-picker button{")!).toContain("height:44px");
    // Nothing may shrink the fixed 44pt cells to make them fit.
    expect(ruleFor(css, ".reaction-picker button{")!).toContain("flex:0 0 auto");
  });

  it("reflows the emoji grid instead of squeezing its columns", () => {
    const grid = ruleFor(css, ".emoji-grid{")!;
    // Six fixed columns cannot hold 44pt cells at 320pt; auto-fit drops to five.
    expect(grid).toContain("repeat(auto-fit,minmax(44px,1fr))");
    expect(grid).not.toContain("repeat(6,1fr)");
    expect(ruleFor(css, ".emoji-grid button{")!).toContain("min-width:44px");
    expect(ruleFor(css, ".emoji-grid button{")!).toContain("min-height:44px");
  });

  it("holds the quote's jump target to 44pt", () => {
    // Measured at 42.2pt in the `messages` style before this floor.
    expect(ruleFor(css, ".quoted-message {")!).toContain("min-height: 44px");
  });

  it("keeps the action rows at a thumb-sized height", () => {
    expect(ruleFor(css, ".action-menu button{")!).toContain("min-height:46px");
  });
});
