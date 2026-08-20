import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MOTION_ENTER_MS, MOTION_EXIT_MS, MOTION_QUICK_MS, nextOverlayPhase } from "./overlay-phase.ts";

/** §5 — one restrained motion system, and the guarantees that keep it honest. */

const dir = import.meta.dir;
const css = readFileSync(join(dir, "scout-chat.css"), "utf8");
const main = readFileSync(join(dir, "main.tsx"), "utf8");

describe("overlay phase machine", () => {
  it("opens, closes through an exit, and only then unmounts", () => {
    let phase = nextOverlayPhase("closed", "open");
    expect(phase).toBe("open");
    phase = nextOverlayPhase(phase, "close");
    // The point of the machine: dismissal does NOT unmount immediately, or the
    // exit animation would have nothing left to animate.
    expect(phase).toBe("closing");
    phase = nextOverlayPhase(phase, "exit-finished");
    expect(phase).toBe("closed");
  });

  it("lets a re-open win over an exit already in flight", () => {
    const phase = nextOverlayPhase("closing", "open");
    expect(phase).toBe("open");
    // The superseded timer must not then tear down the re-opened layer.
    expect(nextOverlayPhase(phase, "exit-finished")).toBe("open");
  });

  it("does not invent an exit for something already closed", () => {
    expect(nextOverlayPhase("closed", "close")).toBe("closed");
    expect(nextOverlayPhase("closed", "exit-finished")).toBe("closed");
  });

  it("keeps durations short enough to feel like furniture, not a performance", () => {
    expect(MOTION_ENTER_MS).toBeLessThanOrEqual(250);
    expect(MOTION_EXIT_MS).toBeLessThanOrEqual(MOTION_ENTER_MS);
    expect(MOTION_QUICK_MS).toBeLessThanOrEqual(MOTION_EXIT_MS);
  });
});

describe("what may be animated", () => {
  /** Every keyframe this surface declares, as a list of the properties it sets.
   *
   * Brace-balanced rather than regex-lazy: a keyframe body contains nested
   * blocks (`from{…}to{…}`), so a non-greedy match stops at the first inner
   * brace and then runs on into whatever rule follows — which is how this check
   * once "found" a `top` that belonged to the next selector entirely. */
  function keyframeProperties() {
    const properties: string[] = [];
    for (const start of css.matchAll(/@keyframes\s+[\w-]+\s*\{/g)) {
      let depth = 1;
      let index = start.index! + start[0].length;
      const bodyStart = index;
      while (index < css.length && depth > 0) {
        if (css[index] === "{") depth += 1;
        else if (css[index] === "}") depth -= 1;
        index += 1;
      }
      const body = css.slice(bodyStart, index - 1);
      for (const decl of body.matchAll(/([a-z-]+)\s*:/g)) properties.push(decl[1]);
    }
    return properties;
  }

  it("animates transform and opacity only", () => {
    // Animating layout properties costs a frame budget this surface does not
    // have on a phone; box-shadow has already failed a pass here.
    const banned = ["width", "height", "top", "left", "right", "bottom", "margin", "padding", "box-shadow"];
    for (const property of keyframeProperties()) {
      expect(banned, `@keyframes animates ${property}`).not.toContain(property);
    }
  });

  it("declares the scout motion keyframes it uses", () => {
    for (const name of [
      "scout-scrim-in", "scout-scrim-out",
      "scout-lift-in", "scout-lift-out",
      "scout-sheet-in", "scout-sheet-out",
      "scout-rise-in", "scout-rise-out",
      "scout-content-in",
    ]) {
      expect(css, name).toContain(`@keyframes ${name}`);
    }
  });

  it("gives every overlay an exit, not just an entrance", () => {
    for (const selector of [
      '.focus-layer[data-phase="closing"]',
      '.identity-layer[data-phase="closing"]',
      '.sheet-layer[data-phase="closing"]',
      '.attachment-tray[data-phase="closing"]',
    ]) {
      expect(css, selector).toContain(selector);
    }
  });

  it("reveals the transcript without moving it", () => {
    // A translate here would shift messages under a thumb mid-reach.
    expect(css).toContain("@keyframes scout-content-in{from{opacity:0}to{opacity:1}}");
  });

  it("keeps no ambient loop on the header, transcript, or viewport", () => {
    // `infinite` is allowed only on the pre-existing local activity indicators.
    const infinite = [...css.matchAll(/([^;{}]*animation[^;{}]*infinite[^;{}]*)/g)].map((m) => m[1]);
    for (const rule of infinite) {
      expect(rule).toMatch(/typing|pulse|shimmer|scout-ring/);
    }
  });
});

describe("reduced motion", () => {
  it("neutralises all motion through one global switch", () => {
    const switchRule = /@media \(prefers-reduced-motion:reduce\)\{\*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(switchRule).toContain("animation:none!important");
    expect(switchRule).toContain("transition:none!important");
    // A wildcard is the point: per-rule fallbacks drift the moment a keyframe
    // is added without one.
    expect(css).toContain("@media (prefers-reduced-motion:reduce){*{");
  });

  it("also shortens the unmount timer, which CSS cannot reach", () => {
    const source = readFileSync(join(dir, "overlay-motion.ts"), "utf8");
    expect(source).toContain("prefers-reduced-motion: reduce");
    // Without this the layer would sit invisible-but-mounted for the exit.
    expect(source).toMatch(/if \(reduced \|\| exitMs <= 0\)/);
  });
});

describe("overlays are wired to the machine", () => {
  it("renders each layer from its presence, not straight from its state", () => {
    for (const wiring of [
      "focusPresence.rendered && focused",
      "identityPresence.rendered && identity",
      "infoPresence.rendered",
      "trayPresence.rendered",
    ]) {
      expect(main, wiring).toContain(wiring);
    }
  });

  it("publishes the phase to CSS on every layer", () => {
    expect(main).toContain("data-phase={focusPresence.phase}");
    expect(main).toContain("data-phase={infoPresence.phase}");
    expect(main).toContain("data-phase={trayPresence.phase}");
    expect(main).toContain("phase={identityPresence.phase}");
  });

  it("retains the dismissed subject so the exit has something to draw", () => {
    expect(main).toContain("useRetainedValue(focusedId");
    expect(main).toContain("identityPresence.rendered,");
  });
});
