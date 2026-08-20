import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** V1 — the quoted-message preview is quiet and flat.
 *  V2 — the composer row shares one optical centre and holds 44pt.
 *
 * Both are geometry, so the authority is the browser harness
 * (`design/captures/chat-density/composer-alignment.html`, and the containment
 * sweep re-run because the quote is its adversarial atom). These assertions
 * exist so the rules cannot be quietly undone between harness runs. */

const dir = import.meta.dir;
const base = readFileSync(join(dir, "scout-chat.css"), "utf8");
const messages = readFileSync(join(dir, "messages-theme.css"), "utf8");
const whatsapp = readFileSync(join(dir, "whatsapp-theme.css"), "utf8");
const main = readFileSync(join(dir, "main.tsx"), "utf8");

/** CSS comments removed, for scans that walk from a selector token to its brace.
 * Prose that names a selector is not a rule, and must not be read as one. */
function withoutComments(source: string) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

function ruleFor(source: string, selector: string) {
  const index = source.indexOf(selector);
  if (index === -1) return null;
  const open = source.indexOf("{", index);
  const close = source.indexOf("}", open);
  return open === -1 || close === -1 ? null : source.slice(open + 1, close);
}

describe("V1.1 — the quote loses its chrome", () => {
  it("has no accent strip in any sheet", () => {
    // An accent bar inside a rounded container also contradicts the standing
    // rule that bars belong on flat, square rows.
    for (const [name, css] of [["base", base], ["messages", messages], ["whatsapp", whatsapp]] as const) {
      expect(css.includes(".quoted-message::before"), `${name} still draws an accent strip`).toBe(false);
    }
  });

  it("is no longer a rounded, bordered box inside a box", () => {
    const quote = ruleFor(base, ".quoted-message {")!;
    expect(quote).toContain("border-radius: 0");
    expect(quote).toContain("background: transparent");
    expect(quote).toContain("border:0");
  });

  it("drops the tinted fill in both themes, light and dark", () => {
    expect(ruleFor(messages, '.chat-app[data-style="messages"] .quoted-message {')!)
      .toContain("background: transparent");
    expect(ruleFor(whatsapp, '.chat-app[data-style="whatsapp"] .quoted-message {')!)
      .toContain("background: transparent");
    // The own-bubble washes and the dark-block fills go too, or the flattening
    // only holds in one of four combinations. Scoped to the quote's own rules —
    // a blanket string search picks up unrelated cards with the same tint.
    //
    // Comments are stripped first: this scan walks from a `.quoted-message`
    // token to the next `{`, so a comment that merely *mentions* the selector
    // would hand it the following unrelated rule's body. That is not
    // hypothetical — a comment on `.reply-target` referring readers to the quote
    // did exactly this.
    for (const css of [messages, whatsapp].map(withoutComments)) {
      for (const rule of css.matchAll(/\.quoted-message[^{}]*\{([^}]*)\}/g)) {
        for (const declaration of rule[1].matchAll(/background:\s*([^;]+)/g)) {
          expect(declaration[1].trim()).toMatch(/^(transparent|none)$/);
        }
      }
    }
  });
});

describe("V1.2 — hierarchy comes from type", () => {
  it("carries the sender line on weight and opacity, not on accent colour", () => {
    const strong = ruleFor(base, ".quoted-message strong")!;
    expect(strong).toContain("font-weight: 600");
    expect(strong).toContain("opacity");
    expect(strong).not.toContain("var(--accent)");
    expect(ruleFor(whatsapp, '.chat-app[data-style="whatsapp"] .quoted-message strong {')!)
      .not.toContain("--accent-strong");
  });

  it("keeps the quote line subordinate to the message body", () => {
    expect(ruleFor(messages, '.chat-app[data-style="messages"] .quoted-message span')!).toContain("opacity");
  });

  it("introduces no new colour semantics", () => {
    const quote = ruleFor(base, ".quoted-message {")!;
    for (const banned = ["--danger", "--warning", "red", "yellow"] as string[]; ;) {
      for (const token of banned) expect(quote).not.toContain(token);
      break;
    }
  });
});

describe("V1.3 — still obviously a tappable quote", () => {
  it("holds the 44pt target", () => {
    // Measured at 42.2pt once already; the floor stays even though the box is
    // now invisible at rest.
    expect(ruleFor(base, ".quoted-message {")!).toContain("min-height: 44px");
  });

  it("answers a press and keeps a focus ring", () => {
    expect(base).toContain(".quoted-message:active");
    expect(base).toContain(".quoted-message:focus-visible");
  });

  it("keeps the ellipsis machinery that made containment possible", () => {
    const span = ruleFor(base, ".quoted-message span {")!;
    expect(span).toContain("min-width: 0");
    expect(span).toContain("white-space: nowrap");
    expect(span).toContain("text-overflow: ellipsis");
  });
});

/** V1.2, dark — the base sheet still carries a dark-mode quote fill.
 *
 * `scout-chat.css`'s `@media (prefers-color-scheme: dark)` block sets
 * `.quoted-message { background: rgba(0,0,0,.25) }`. It looks like a survivor of
 * the treatment V1.1 removed, and the dark screenshots had to answer whether it
 * paints. It does not, and the reason is specificity, not source order:
 *
 *   base dark    `.quoted-message`                            → (0,1,0)
 *   messages     `.chat-app[data-style="messages"] .quoted-…` → (0,3,0)
 *   whatsapp     `.chat-app[data-style="whatsapp"] .quoted-…` → (0,3,0)
 *
 * Media queries contribute no specificity, so both overrides beat it in either
 * scheme — and `data-style` is bound unconditionally at `main.tsx:844` from a
 * `"messages" | "whatsapp"` union, so there is no third state in which the base
 * rule is the last one standing. It is dead code, kept honest here rather than
 * deleted blind: deleting it is a separate call, and this pins the claim either
 * way. */
describe("V1.2 — the base dark quote fill never paints", () => {
  const DARK_FILL = "rgba(0,0,0,.25)";

  it("still exists in the base sheet, so the claim is about specificity", () => {
    // If someone deletes it, this test should be revisited, not silently pass.
    expect(base).toContain(`.quoted-message{background:${DARK_FILL}`);
  });

  it("is overridden to transparent by both style sheets", () => {
    expect(ruleFor(messages, '.chat-app[data-style="messages"] .quoted-message {')!)
      .toContain("background: transparent");
    expect(ruleFor(whatsapp, '.chat-app[data-style="whatsapp"] .quoted-message {')!)
      .toContain("background: transparent");
  });

  it("is overridden again inside whatsapp's own dark block", () => {
    // Belt and braces on the side where the fill would have been visible.
    const darkIndex = whatsapp.indexOf("prefers-color-scheme: dark");
    expect(darkIndex).toBeGreaterThan(-1);
    const dark = whatsapp.slice(darkIndex);
    expect(ruleFor(dark, '.chat-app[data-style="whatsapp"] .quoted-message {')!)
      .toContain("background: transparent");
  });

  it("can never be the winning rule, because a style is always set", () => {
    // The specificity argument only holds if one of the two overrides always
    // matches. `data-style` is not conditional and its type has two members.
    expect(main).toContain('data-style={style}');
    expect(main).toContain('type ChatStyle = "messages" | "whatsapp"');
    expect(main).not.toMatch(/data-style=\{[^}]*\?\s/);
  });
});

/** V1.4 / R4.1 — the composer's reply-target chip speaks the quote's language.
 *
 * This was flagged in Round 3 and ruled a GO blocker: the chip kept exactly the
 * two things V1.1 stripped from the in-bubble quote — a 3px accent strip and a
 * rounded filled container — while rendering the same semantic object. A swipe
 * to reply puts both on screen at once, so the contradiction was visible in a
 * single frame.
 *
 * The rule these assertions defend is the general one, not just this chip: an
 * accent bar never belongs inside a rounded container, and one idea gets one
 * grammar. A flat wash may remain for separation; chrome may not come back. */
describe("V1.4 — the reply-target chip joins the flat language", () => {
  const chipRules = [
    ["base", ruleFor(base, ".reply-target {")!],
    ["messages", ruleFor(messages, '.chat-app[data-style="messages"] .reply-target {')!],
    ["whatsapp", ruleFor(whatsapp, '.chat-app[data-style="whatsapp"] .reply-target {')!],
  ] as const;

  it("has no accent strip in any sheet", () => {
    for (const [name, rule] of chipRules) {
      expect(rule, name).not.toMatch(/border-left:\s*[1-9]/);
      expect(rule, name).not.toContain("solid var(--accent)");
    }
  });

  it("is not a rounded pill in any sheet", () => {
    for (const [name, rule] of chipRules) {
      // `border-radius: 0` is fine; any non-zero radius is the pill returning.
      const radius = /border-radius:\s*([^;]+)/.exec(rule)?.[1]?.trim();
      expect(radius, name).toBe("0");
    }
  });

  it("carries no shadow, so it reads as a wash and not a raised card", () => {
    for (const [name, rule] of chipRules) {
      if (rule.includes("box-shadow")) expect(rule, name).toContain("box-shadow: none");
    }
  });

  it("takes its hierarchy from type, not from an accent-coloured sender line", () => {
    // The in-bubble quote uses ink at reduced opacity; the chip now matches.
    const senders = [
      ruleFor(messages, '.chat-app[data-style="messages"] .reply-target strong {')!,
      ruleFor(whatsapp, '.chat-app[data-style="whatsapp"] .reply-target strong {')!,
    ];
    for (const rule of senders) {
      expect(rule).not.toContain("var(--accent-strong)");
      expect(rule).toMatch(/opacity:\s*\.\d/);
    }
  });

  it("keeps the strip out of the dark overrides too", () => {
    const darkIndex = whatsapp.indexOf("prefers-color-scheme: dark");
    const dark = whatsapp.slice(darkIndex);
    const rule = ruleFor(dark, '.chat-app[data-style="whatsapp"] .reply-target {')!;
    expect(rule).not.toContain("border-left-color");
    expect(rule).not.toMatch(/border-left:\s*[1-9]/);
  });

  it("does not quietly lose the cancel target (R4.2)", () => {
    // The treatment got quieter; the affordance must not have.
    const button = ruleFor(base, ".reply-target button{")!;
    expect(button).toContain("width:44px");
    expect(button).toContain("height:44px");
    expect(base).toContain(".reply-target button:focus-visible");
    expect(base).toContain(".reply-target button:active");
  });

  it("stops the ✕ being shrunk by a long quote", () => {
    // Declaring 44×44 is not the same as painting it. The chip is a flex row,
    // and a shrinkable button measured 28×44 under a long quote — before this
    // round as well as after, so this pins a latent defect rather than a
    // regression. `min-width:0` on the text span is not enough: shrinkage is
    // distributed across every shrinkable item, siblings included.
    expect(ruleFor(base, ".reply-target button{")!).toContain("flex:none");
  });
});

describe("V2.3 — composer controls hold a 44pt hit box", () => {
  it("gets in-field controls to 44pt without growing the field", () => {
    // Measured at 42.0 in WhatsApp. Growing the box to 44 is the obvious fix
    // and it is wrong: the field's content box is 44 minus its borders, so a
    // 44px child pushed the field to 46 and produced exactly the 1px
    // `align-items:end` drift this section exists to remove (measured:
    // fieldH 46, dAttach 1.0). A transparent expander adds touch area with no
    // layout, so the field stays at 44 and the row stays centred.
    const baseButton = ruleFor(base, ".composer-field button {")!;
    expect(baseButton).toContain("width:42px");
    expect(baseButton).toContain("position:relative");
    const expander = ruleFor(base, ".composer-field button::after")!;
    expect(expander).toContain("position:absolute");
    expect(expander).toContain("inset:-1px");
  });

  it("keeps the row controls at 44pt", () => {
    expect(ruleFor(base, ".composer-row > button")!).toContain("width: 44px");
    expect(ruleFor(base, ".composer-row > button")!).toContain("height: 44px");
  });

  it("keeps the field's painted height equal to the controls at single line", () => {
    // `box-sizing: border-box` is what makes this true: the field's 1px borders
    // sit INSIDE its 44px, so it paints at 44 and not 46. That is why the
    // predicted ~2px `align-items:end` drift does not occur — see the report.
    expect(base).toContain("* { box-sizing: border-box; }");
    expect(ruleFor(base, ".composer-field {")!).toContain("min-height: 44px");
  });
});

/** V2.5 — the regression that pins the DEFECT, not its inputs.
 *
 * The block above asserts the ingredients: 44px controls, a 44px field,
 * border-box. None of those is the bug. The bug was a **centre delta** — the
 * field painting 46px against 44px controls under `align-items:end`, dropping
 * the icons 1px low — and a test that lists ingredients passes happily while the
 * dish comes out wrong. So this block reconstructs the painted boxes from the
 * declared CSS and asserts the centres coincide.
 *
 * `paintedFieldHeight` is the whole argument in one function: under
 * `align-items:end` in a grid row, every item's bottom edge is shared, so an
 * item's centre sits at `-height/2` from that edge and the delta between two
 * items is exactly `|h₁ − h₂| / 2`. Restoring `height:44px` on an in-field
 * button (the "obvious" fix V2.3 warns about) drives the field to 46 and this
 * test to a 1.0px delta — which is the geometry the operator photographed. */
describe("V2.5 — composer centre delta, derived from the box model", () => {
  /** The row bottom-aligns, so centre offset from that shared edge is -h/2. */
  const centreOffset = (paintedHeight: number) => -paintedHeight / 2;

  const px = (rule: string, property: string) => {
    const match = new RegExp(`(?:^|[;{\\s])${property}\\s*:\\s*([0-9.]+)px`).exec(rule);
    return match ? Number(match[1]) : null;
  };

  /** The field is `display:flex` with a min-height, so it paints at whichever is
   * taller: its own floor, or its tallest child plus the borders it must wrap.
   * Under `box-sizing:border-box` the min-height already contains the borders;
   * the content-driven branch does not, which is exactly where 46 came from. */
  function paintedFieldHeight(minHeight: number, border: number, children: number[]) {
    return Math.max(minHeight, Math.max(...children) + border * 2);
  }

  const styles = [
    {
      name: "messages (base sheet)",
      control: px(ruleFor(base, ".composer-row > button")!, "height")!,
      fieldMin: px(ruleFor(base, ".composer-field {")!, "min-height")!,
      border: 1, // `border: 1px solid …`
      children: [
        px(ruleFor(base, ".composer-field button {")!, "height")!,
        px(ruleFor(base, ".composer-field textarea")!, "min-height")!,
      ],
    },
    {
      name: "whatsapp (override)",
      // `--touch: 44px`, resolved — the override states its geometry in tokens.
      control: 44,
      fieldMin: 44,
      border: 0.5, // `border: 0.5px solid …`
      children: [
        px(ruleFor(whatsapp, '.chat-app[data-style="whatsapp"] .composer-field button {')!, "height")!,
        px(ruleFor(whatsapp, '.chat-app[data-style="whatsapp"] .composer-field textarea {')!, "min-height")!,
      ],
    },
  ];

  for (const style of styles) {
    it(`shares one optical centre in ${style.name}`, () => {
      // Guard the parse itself: a null here would silently make NaN pass.
      expect(style.control).toBeGreaterThan(0);
      expect(style.children.every((child) => child > 0)).toBe(true);

      const field = paintedFieldHeight(style.fieldMin, style.border, style.children);
      const delta = Math.abs(centreOffset(style.control) - centreOffset(field));

      // V2.1's acceptance number, applied to the thing it was written about.
      expect(delta).toBeLessThanOrEqual(0.5);
    });

    it(`keeps in-field controls from inflating the field in ${style.name}`, () => {
      // The negative case, stated as a test so the reasoning is executable: a
      // 44px in-field control pushes the field to `44 + 2×border`, and since the
      // row bottom-aligns, the resulting drift is exactly the border width.
      //
      // Worth reading off this identity rather than a hardcoded 1.0: the base
      // sheet's 1px borders make the mistake a clear 1.0px failure, but
      // WhatsApp's 0.5px borders make the SAME mistake land on exactly 0.5 —
      // right on V2.1's tolerance, which would admit it. That style has no
      // margin against this defect; the guard is the 42px + expander rule
      // (V2.3), not the tolerance. Flagged in the report.
      const inflated = paintedFieldHeight(style.fieldMin, style.border, [44, ...style.children]);
      const delta = Math.abs(centreOffset(style.control) - centreOffset(inflated));

      expect(delta).toBeCloseTo(style.border, 5);
      expect(delta).toBeGreaterThan(0);
    });
  }

  it("bottom-aligns the row, which is what makes the delta pure height", () => {
    // If this ever becomes `center`, the arithmetic above stops describing the
    // layout and the test would pass for the wrong reason.
    expect(ruleFor(base, ".composer-row {")!).toContain("align-items: end");
    expect(ruleFor(whatsapp, '.chat-app[data-style="whatsapp"] .composer-row {')!).toContain("align-items: end");
  });
});
