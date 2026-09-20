import { describe, expect, mock, test } from "bun:test";
import type { CrewPhotoFigure } from "./CrewPhoto.tsx";

/* Pure helpers only — nothing here renders. The module they live in is a
   component file, so the JSX runtime has to resolve before it can be imported;
   bun otherwise walks into @types/react. Same shim as ProjectsInbox.test.ts. */
// @ts-expect-error Bun tests load React's runtime entrypoints directly to avoid local TS path aliases.
const React = await import("../../node_modules/react/index.js");
// @ts-expect-error Bun tests load React's runtime entrypoints directly to avoid local TS path aliases.
const ReactJsxRuntime = await import("../../node_modules/react/jsx-runtime.js");
// @ts-expect-error Bun tests load React's runtime entrypoints directly to avoid local TS path aliases.
const ReactJsxDevRuntime = await import("../../node_modules/react/jsx-dev-runtime.js");
mock.module("react", () => React);
mock.module("react/jsx-runtime", () => ReactJsxRuntime);
mock.module("react/jsx-dev-runtime", () => ReactJsxDevRuntime);
mock.module("react-dom", () => ({ createPortal: (children: unknown) => children }));

const {
  CREW_PHOTO_LIMIT,
  arrivingCastSlugs,
  crewPhotoRoster,
  fitFigureHeight,
} = await import("./CrewPhoto.tsx");

const NOW = 1_700_000_000_000;

function figure(partial: Partial<CrewPhotoFigure> & { castSlug: string }): CrewPhotoFigure {
  return {
    key: partial.key ?? `agent:${partial.castSlug}`,
    name: partial.name ?? partial.castSlug,
    lastActivityAt: partial.lastActivityAt ?? NOW,
    castSlug: partial.castSlug,
  };
}

describe("crewPhotoRoster", () => {
  test("orders the photo by most recent activity", () => {
    const roster = crewPhotoRoster([
      figure({ castSlug: "milo", lastActivityAt: NOW - 5_000 }),
      figure({ castSlug: "vex", lastActivityAt: NOW - 1_000 }),
      figure({ castSlug: "brik", lastActivityAt: NOW - 9_000 }),
    ]);
    expect(roster.map((entry) => entry.castSlug)).toEqual(["vex", "milo", "brik"]);
  });

  test("keeps one figure per cast slug — the most recently active", () => {
    const roster = crewPhotoRoster([
      figure({ key: "role:a", castSlug: "sprout", name: "sprout-old", lastActivityAt: NOW - 8_000 }),
      figure({ key: "role:b", castSlug: "sprout", name: "sprout-live", lastActivityAt: NOW - 100 }),
      figure({ castSlug: "wrench", lastActivityAt: NOW - 4_000 }),
    ]);
    expect(roster).toHaveLength(2);
    expect(roster[0]!.name).toBe("sprout-live");
    expect(roster.map((entry) => entry.castSlug)).toEqual(["sprout", "wrench"]);
  });

  test("caps the band at six figures, dropping the stalest", () => {
    const slugs = ["milo", "brik", "sprout", "wrench", "vex", "lulu", "nori", "pip"];
    const roster = crewPhotoRoster(
      slugs.map((slug, index) => figure({ castSlug: slug, lastActivityAt: NOW - index * 1_000 })),
    );
    expect(roster).toHaveLength(CREW_PHOTO_LIMIT);
    expect(roster.map((entry) => entry.castSlug)).toEqual(["milo", "brik", "sprout", "wrench", "vex", "lulu"]);
  });

  test("breaks ties by name so a refetch cannot reshuffle the band", () => {
    const first = crewPhotoRoster([
      figure({ castSlug: "vex", name: "Vex" }),
      figure({ castSlug: "milo", name: "Milo" }),
    ]);
    const second = crewPhotoRoster([
      figure({ castSlug: "milo", name: "Milo" }),
      figure({ castSlug: "vex", name: "Vex" }),
    ]);
    expect(first.map((entry) => entry.castSlug)).toEqual(second.map((entry) => entry.castSlug));
  });

  test("honours a caller's smaller limit (the empty stage asks for one)", () => {
    const roster = crewPhotoRoster([
      figure({ castSlug: "milo", lastActivityAt: NOW - 5_000 }),
      figure({ castSlug: "vex", lastActivityAt: NOW - 1_000 }),
    ], 1);
    expect(roster.map((entry) => entry.castSlug)).toEqual(["vex"]);
  });

  test("an empty crew makes an empty roster", () => {
    expect(crewPhotoRoster([])).toEqual([]);
  });
});

describe("arrivingCastSlugs", () => {
  test("a refetch of the same set brings nobody in", () => {
    expect(arrivingCastSlugs(["milo", "vex"], ["milo", "vex"])).toEqual([]);
  });

  test("reordering the same members is not an arrival", () => {
    expect(arrivingCastSlugs(["milo", "vex"], ["vex", "milo"])).toEqual([]);
  });

  test("names only the slugs that were not shown before", () => {
    expect(arrivingCastSlugs(["milo"], ["milo", "sprout", "vex"])).toEqual(["sprout", "vex"]);
  });

  test("a member that left and came back arrives again", () => {
    const afterLeaving = arrivingCastSlugs(["milo", "vex"], ["milo"]);
    expect(afterLeaving).toEqual([]);
    expect(arrivingCastSlugs(["milo"], ["milo", "vex"])).toEqual(["vex"]);
  });

  test("accepts the component's ref set as well as a list", () => {
    expect(arrivingCastSlugs(new Set(["milo"]), ["milo", "brik"])).toEqual(["brik"]);
  });

  test("never names the same arrival twice", () => {
    expect(arrivingCastSlugs([], ["sprout", "sprout"])).toEqual(["sprout"]);
  });
});

describe("fitFigureHeight", () => {
  /* 3 slots at aspect 1: padding 18×2 + gap 16×2 = 68px of chrome. */
  test("keeps the preferred height when the band has room", () => {
    expect(fitFigureHeight([1, 1, 1], 2_000)).toBe(120);
  });

  test("shrinks the crew to fit a narrow band rather than clipping it", () => {
    expect(fitFigureHeight([1, 1, 1], 368)).toBe(100);
  });

  test("measures the row from the art, not from a head count", () => {
    // A narrow member (nori is 394×512) leaves the others more room.
    expect(fitFigureHeight([1, 1, 0.5], 368)).toBeGreaterThan(fitFigureHeight([1, 1, 1], 368));
  });

  test("never shrinks a member into a smudge", () => {
    expect(fitFigureHeight([1, 1, 1], 100)).toBe(64);
    expect(fitFigureHeight([1, 1, 1], 40)).toBe(64);
  });

  test("an unmeasured band draws at the preferred height", () => {
    expect(fitFigureHeight([1, 1], 0)).toBe(120);
    expect(fitFigureHeight([], 900)).toBe(120);
  });

  test("honours a caller's own preferred height", () => {
    expect(fitFigureHeight([1], 2_000, 210)).toBe(210);
  });
});
