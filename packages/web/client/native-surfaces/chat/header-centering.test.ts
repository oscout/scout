import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The chat header's identity must sit on the phone's true centre line.
 *
 * The bug this pins: Back ("‹ Chats") and Search are different widths, so a
 * `80px 1fr 56px` header centres the name inside the LEFTOVER space, which
 * lands it off-axis by half the difference. Two equal side columns put the
 * content-sized middle exactly on 50% regardless of what the edge controls
 * measure.
 *
 * These are static assertions on the stylesheet — the real geometry is
 * measured in a browser at phone width, but a rule change that silently
 * re-introduces asymmetry should fail here, in the suite, first. */

const css = readFileSync(join(import.meta.dir, "scout-chat.css"), "utf8");
const main = readFileSync(join(import.meta.dir, "main.tsx"), "utf8");

function ruleFor(selector: string) {
  const index = css.indexOf(selector);
  if (index === -1) return null;
  const open = css.indexOf("{", index);
  const close = css.indexOf("}", open);
  return open === -1 || close === -1 ? null : css.slice(open + 1, close);
}

describe("chat header true centering", () => {
  it("centres the cluster out of flow, so track sizing cannot move it", () => {
    const contact = ruleFor(".contact-button {")!;
    expect(contact).toContain("position: absolute");
    // Pinned to BOTH edges with auto inline margins: the box is centred by the
    // margins themselves, with no transform rounding in the path.
    expect(contact).toContain("left: 0");
    expect(contact).toContain("right: 0");
    expect(contact).toContain("margin-inline: auto");
    expect(contact).toContain("width: fit-content");
    expect(ruleFor(".chat-header {")!).toContain("position: relative");
  });

  it("anchors the reserve to the header, never to the viewport", () => {
    // A vw-anchored reserve ignores the header's own padding and let the row
    // overflow on device, which dragged the centre 5.2pt right.
    const contact = ruleFor(".contact-button {")!;
    expect(contact).not.toContain("100vw");
    expect(contact).toMatch(/max-width:\s*calc\(100% - \d+px\)/);
  });

  it("cannot be shifted by an overflowing edge control", () => {
    expect(ruleFor(".chat-header {")!).toContain("overflow: hidden");
  });

  it("centres the identity rather than left-aligning it", () => {
    const contact = ruleFor(".contact-button {")!;
    expect(contact).toContain("justify-items: center");
    expect(contact).not.toContain("justify-items: start");
  });
});

describe("chat header collision behaviour", () => {
  it("reserves runway on both sides so the cluster cannot reach an edge control", () => {
    const contact = ruleFor(".contact-button {")!;
    const reserve = /max-width:\s*calc\(100%\s*-\s*(\d+)px\)/.exec(contact)?.[1];
    expect(reserve).toBeDefined();
    // Both 44pt controls plus their padding, on both sides.
    expect(Number(reserve)).toBeGreaterThanOrEqual(2 * 88);
  });

  it("truncates the name instead of widening past the reserve", () => {
    const name = ruleFor(".contact-button strong {")!;
    expect(name).toContain("text-overflow: ellipsis");
    expect(name).toContain("white-space: nowrap");
    expect(name).toContain("overflow: hidden");
  });

  it("carries no status copy in the header at all", () => {
    // Ordinary status answers no question up here; it moved to the card, and
    // only when it would change a decision.
    expect(main).not.toContain("contact-status");
    expect(css).not.toContain(".contact-status");
    const headerMarkup = main.slice(main.indexOf('className="contact-button"'), main.indexOf("header-actions"));
    expect(headerMarkup).not.toMatch(/typing|Scout conversation|session\.status/);
  });

  it("keeps both edge controls at a 44pt target", () => {
    const pair = ruleFor(".back-button, .header-actions button {")!;
    expect(pair).toContain("width: 44px");
    expect(pair).toContain("height: 44px");
    expect(pair).toContain("min-width: 44px");
    expect(pair).toContain("min-height: 44px");
  });

  it("gives both edge controls one authored plate, smaller than the target", () => {
    const plate = ruleFor(".back-button::before, .header-actions button::before {")!;
    const size = /width:\s*(\d+)px/.exec(plate)?.[1];
    expect(Number(size)).toBeLessThan(44);
    expect(Number(size)).toBeGreaterThanOrEqual(28);
    expect(plate).toContain("var(--edge-plate)");
  });

  it("keeps the app column from exceeding the phone, which is what moved the centre", () => {
    // A grid item's automatic minimum is min-content, so the transcript's
    // widest atom widened the whole app and the header centred inside a box
    // wider than the screen.
    expect(ruleFor(".chat-app > * {")!).toContain("min-width: 0");
  });

  it("carries no borrowed text back affordance", () => {
    expect(main).not.toContain("back-label");
    expect(css).not.toContain(".back-label");
    // The control keeps its accessible name without a visible label.
    expect(main).toMatch(/className="back-button"[^>]*aria-label="Back"/);
  });
});

describe("chat header vertical composition", () => {
  it("stacks the mark above the name rather than sitting beside it", () => {
    const contact = ruleFor(".contact-button {")!;
    expect(contact).toContain("display: grid");
    expect(contact).toContain("justify-items: center");
    // A horizontal cluster puts the optical centre off the box centre.
    expect(contact).not.toContain("display: flex");
  });

  it("renders the mark, then the name, and nothing else", () => {
    const header = main.slice(main.indexOf('className="contact-button"'), main.indexOf("header-actions"));
    const mark = header.indexOf("<ChatAvatar");
    const name = header.indexOf("<strong>");
    expect(mark).toBeGreaterThan(-1);
    expect(name).toBeGreaterThan(mark);
    expect(header.match(/<strong>/g)?.length).toBe(1);
  });

  it("gives the stack room without collapsing conversation density", () => {
    const height = /min-height:\s*(\d+)px/.exec(ruleFor(".chat-header {")!)?.[1];
    expect(Number(height)).toBeGreaterThan(58);
    expect(Number(height)).toBeLessThanOrEqual(78);
    // Safe-area behaviour must survive the taller header.
    expect(ruleFor(".chat-header {")!).toContain("env(safe-area-inset-top)");
  });
});

describe("chat header avatar effect", () => {
  it("is bounded to the mark and drawn without a filter", () => {
    const ring = ruleFor(".contact-button .avatar::after {")!;
    expect(ring).toContain("box-shadow");
    // No continuous expensive blur.
    expect(ring).not.toContain("backdrop-filter");
    expect(ring).not.toContain("filter:");
    expect(ring).toContain("pointer-events: none");
  });

  it("is visible and static by default, and only breathes while really working", () => {
    expect(ruleFor(".contact-button .avatar::after {")!).not.toContain("animation");
    expect(ruleFor('.contact-button[data-working="true"] .avatar::after {')!).toContain("animation: scout-ring");
    expect(main).toContain("data-working={working}");
  });

  it("moves only the ring — never the cluster or the header", () => {
    // Slice to the block's own closing brace; a fixed-length window overruns
    // into the next rule and reads its properties as if they were the motion.
    const start = css.indexOf("@keyframes scout-ring");
    let depth = 0, end = start;
    for (let i = css.indexOf("{", start); i < css.length; i += 1) {
      if (css[i] === "{") depth += 1;
      else if (css[i] === "}") { depth -= 1; if (depth === 0) { end = i + 1; break; } }
    }
    const keyframes = css.slice(start, end);
    // Compositor-friendly: opacity only, so the ring's geometry never shifts
    // and nothing around the mark reflows.
    expect(keyframes).toContain("opacity");
    for (const moving of ["transform", "translate", "scale", "box-shadow", "top:", "left:", "margin", "width", "height"]) {
      expect(keyframes).not.toContain(moving);
    }
  });

  it("honours reduced motion", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion:\s*reduce\)\s*\{\s*\*\s*\{[^}]*animation:\s*none\s*!important/);
  });

  it("tints the ring from cool tokens in both themes", () => {
    const ring = ruleFor(".contact-button .avatar::after {")!;
    expect(ring).toContain("var(--ring-edge)");
    expect(ring).toContain("var(--ring-glow)");
    // Declared light and dark; the colour guard separately proves they are cool.
    expect(css.match(/--ring-edge:/g)?.length).toBe(2);
    // The ring is legible before any animation runs.
    expect(ruleFor(".contact-button .avatar::after {")!).toMatch(/opacity:\s*\.\d+/);
  });
});

describe("chat header restraint", () => {
  it("drops decorative glass from the top bar", () => {
    // Product-owned material: a quiet vertical tone and a hairline, not a
    // blurred pane borrowed from the platform's messenger.
    expect(ruleFor(".chat-header {")!).not.toContain("backdrop-filter");
    expect(ruleFor(".chat-header {")!).toContain("linear-gradient");
    expect(ruleFor(".chat-header {")!).toContain("border-bottom");
  });

  it("adds no capsule, card, or heavy chrome around the cluster", () => {
    const contact = ruleFor(".contact-button {")!;
    for (const chrome of ["background:", "box-shadow:", "border:", "border-radius:", "backdrop-filter:"]) {
      expect(contact).not.toContain(chrome);
    }
  });

  it("still opens the compact identity card", () => {
    expect(main).toContain('className="contact-button"');
    expect(main).toContain("setIdentityActorId(soleIncomingActorId ?? CONVERSATION_IDENTITY)");
    expect(main).toMatch(/aria-label=\{`About \$\{config\.title\}`\}/);
  });
});
