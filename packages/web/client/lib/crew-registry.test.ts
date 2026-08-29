import { describe, expect, test } from "bun:test";

import { CHIP_ART, CREW_ART, crewGround, displayCoin } from "./crew-registry.ts";

describe("displayCoin", () => {
  test("keeps the authored crop at the crew floor", () => {
    expect(displayCoin(CREW_ART.milo, 28)).toEqual(CREW_ART.milo.coin);
    expect(displayCoin(CREW_ART.milo, 40)).toEqual(CREW_ART.milo.coin);
  });

  test("pulls the camera back below 28px so a visor does not become a smiley", () => {
    const [x, y, side] = displayCoin(CREW_ART.milo, 18);
    const [ax, ay, aSide] = CREW_ART.milo.coin;
    expect(side).toBeGreaterThan(aSide);
    const authoredCenterX = ax + aSide / 2;
    const authoredCenterY = ay + aSide / 2;
    expect(x + side / 2).toBeCloseTo(authoredCenterX, 5);
    expect(y + side / 2).toBeCloseTo(authoredCenterY, 5);
  });
});

describe("crewGround", () => {
  /** First lightness stop of a band, e.g. "0.34" from oklch(0.34 0.1 190). */
  function firstL(css: string): number {
    const m = css.match(/oklch\(([0-9.]+)/);
    if (!m) throw new Error(`no oklch stop in ${css}`);
    return Number(m[1]);
  }

  test("sends light art to the dark ground and dark art to the light one", () => {
    const light = firstL(crewGround(190, CREW_ART.milo.ink)); // 0.75 — cream dome
    const dark = firstL(crewGround(190, CREW_ART.vex.ink)); //  0.33 — near-black orb
    expect(light).toBeLessThan(0.5);
    expect(dark).toBeGreaterThan(0.7);
  });

  /** Lightness of every stop in a band, nearest first. */
  function stops(css: string): number[] {
    return [...css.matchAll(/oklch\(([0-9.]+)/g)].map((m) => Number(m[1]));
  }

  /** How far a member's ink sits from the closest part of the ground under it.
   *  Rounded to the two decimals `ink` is measured to — vex's chip lands on the
   *  floor exactly, and a raw float compare would fail it on 0.14999999. */
  function clearance(ink: number): number {
    const band = stops(crewGround(190, ink));
    return Math.round(Math.min(...band.map((l) => Math.abs(l - ink))) * 100) / 100;
  }

  test("keeps every member clear of its own ground", () => {
    // The failure this guards is not a crash — it is a coin that renders as one
    // flat disc, which nothing else in the suite can see. 0.15 is not a taste
    // call: it is the tightest the two bands actually get, at vex's chip (0.49,
    // a hair over the 0.45 split, against a ground topping out at 0.34). A new
    // member that lands closer than the worst case we already ship is a member
    // whose ink needs re-measuring, or a split that needs moving.
    for (const [slug, art] of Object.entries(CREW_ART)) {
      expect(`${slug} ${clearance(art.ink) >= 0.15}`).toBe(`${slug} true`);
    }
    for (const [slug, chip] of Object.entries(CHIP_ART)) {
      expect(`${slug}-chip ${clearance(chip.ink) >= 0.15}`).toBe(`${slug}-chip true`);
    }
  });

  test("holds the hue fixed across the band split — crew is hue, not lightness", () => {
    expect(crewGround(210, 0.9)).toContain(" 210)");
    expect(crewGround(210, 0.1)).toContain(" 210)");
  });
});
