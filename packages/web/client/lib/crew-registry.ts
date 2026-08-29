/**
 * Crew Registry & Cast definitions for OpenScout.
 *
 * Implements the 4-slot avatar contract:
 *   - Head: WHO (slug / character art)
 *   - Suit/Ground: CREW (project hue radial gradient)
 *   - Badge: RUNTIME (harness badge)
 *   - Lights: DOING (live status ring & eye expression module)
 */

import { makeRng } from "./agent-identity.ts";

export const CREW_PACK_BASE_URL = "/crew";
export const CREW_ASSETS_AVAILABLE = true;

export function crewAssetUrl(relativePath: string): string {
  return `${CREW_PACK_BASE_URL}/${relativePath.replace(/^\/+/u, "")}`;
}

export interface FacePlacement {
  module: "eye-plate-v1";
  origin: [number, number];
  size: [96, 40];
}

export interface Art {
  w: number;
  h: number;
  coin: [number, number, number];
  /**
   * Mean lightness of the art inside the coin, 0–1, measured off the bust.
   *
   * Not decoration: it picks which GROUND the member stands on. See
   * `crewGround` — a cast that runs from vex at 0.33 to milo at 0.75 cannot
   * share one ground without dissolving half of itself into it.
   */
  ink: number;
  kernel: string;
  face?: FacePlacement;
}

export interface Sheet {
  patch: [number, number, number, number];
  roles: string[];
  dir: string;
}

export interface CastMemberDef {
  slug: string;
  name: string;
  kernel: string;
  title: string;
  blurb: string;
}

export const EYE_MODULE = {
  id: "eye-plate-v1" as const,
  size: [96, 40] as const,
  inner: [8, 6, 80, 28] as const,
  eyeCenters: [[30, 20], [66, 20]] as const,
};

const LULU_FACE: FacePlacement = { module: EYE_MODULE.id, origin: [190, 180], size: [96, 40] };
const NORI_FACE: FacePlacement = { module: EYE_MODULE.id, origin: [149, 203], size: [96, 40] };

export const CREW_ART: Record<string, Art> = {
  milo: { w: 492, h: 512, coin: [145, 16, 213], ink: 0.75, kernel: "dome·antennae·visor" },
  brik: { w: 490, h: 512, coin: [73, -29, 273], ink: 0.37, kernel: "slab·bare·screen" },
  sprout: { w: 516, h: 512, coin: [146, -3, 223], ink: 0.74, kernel: "bell·leaves·painted" },
  wrench: { w: 509, h: 512, coin: [123, -26, 261], ink: 0.52, kernel: "cone·knob·lens" },
  vex: { w: 512, h: 512, coin: [129, 0, 254], ink: 0.33, kernel: "orb·ears·slit" },
  lulu: { w: 475, h: 512, coin: [-24, -153, 522], ink: 0.75, kernel: "orb·gills·eye-plate", face: LULU_FACE },
  nori: { w: 394, h: 512, coin: [-20, -109, 433], ink: 0.71, kernel: "cap·lamp·eye-plate", face: NORI_FACE },
};

/**
 * Pixel Chip art — the same four-slot contract, rendered from pixel identity.
 *
 * `<slug>-chip-id.webp` is identity pixels only: the kit's chip files bake a
 * status ring and a character emblem into the art, so those are stripped and
 * the head-and-collar square cut out by scripts/crew-chip-identity.mjs in the
 * studio. Ground, ring, and runtime badge are drawn live by the renderer from
 * the same data every other renderer uses — nothing about state lives in art.
 *
 * `nudge` shifts the identity inside the coin as a fraction of the coin, for
 * members whose visual mass does not sit on the crop's geometric centre.
 */
export interface ChipArt {
  /** Fraction of the coin the identity occupies (the rest is ring + lap margin). */
  fill: number;
  /**
   * Mean lightness of the CHIP cut, measured separately from the bust.
   *
   * The two renderers disagree, and not by a little: brik's bust is dark
   * chassis at 0.37 while his chip is a bright pixel face at 0.81. Reusing the
   * bust's ink would put half the chip cast on the wrong ground.
   */
  ink: number;
  nudge?: [number, number];
}

export const CHIP_ART: Record<string, ChipArt> = {
  milo: { fill: 0.86, ink: 0.5 },
  brik: { fill: 0.86, ink: 0.81 },
  sprout: { fill: 0.88, ink: 0.64, nudge: [0, -0.01] },
  wrench: { fill: 0.88, ink: 0.53, nudge: [0, -0.01] },
  vex: { fill: 0.86, ink: 0.49 },
};

/** Members the Pixel Chip renderer can actually draw. Everything else falls back. */
export const CHIP_CAST: readonly string[] = Object.keys(CHIP_ART);

export function hasChipArt(slug?: string | null): boolean {
  return Boolean(slug && CHIP_ART[slug.toLowerCase()]);
}

/** Renderer coverage, so settings and previews can state it instead of implying it. */
export function rendererCoverage(style: "crew" | "chip" | "sprite"): { covered: number; total: number } | null {
  if (style === "sprite") return null; // generative — covers every name by construction
  const total = CAST_MEMBERS.length;
  return { covered: style === "chip" ? CHIP_CAST.length : Object.keys(CREW_ART).length, total };
}

export const CREW_SHEETS: Record<string, Sheet> = {
  sprout: {
    patch: [210, 133, 96, 29],
    roles: ["blink-half", "blink-shut", "look-left", "look-right", "look-up"],
    dir: "sheets/sprout",
  },
  lulu: {
    patch: [...LULU_FACE.origin, ...LULU_FACE.size],
    roles: ["blink-half", "blink-shut", "look-left", "look-right", "look-up"],
    dir: `sheets/${EYE_MODULE.id}`,
  },
  nori: {
    patch: [...NORI_FACE.origin, ...NORI_FACE.size],
    roles: ["blink-half", "blink-shut", "look-left", "look-right", "look-up"],
    dir: `sheets/${EYE_MODULE.id}`,
  },
};

export const CAST_MEMBERS: CastMemberDef[] = [
  { slug: "milo", name: "Milo", kernel: "dome·antennae·visor", title: "Navigator", blurb: "Curious scout with sensory antennae and panoramic visor." },
  { slug: "brik", name: "Brik", kernel: "slab·bare·screen", title: "Heavy Ops", blurb: "Resilient bedrock unit with bevelled chassis and glyph screen." },
  { slug: "sprout", name: "Sprout", kernel: "bell·leaves·painted", title: "Botanist & Growth", blurb: "Bio-mechanical explorer with sprouted leaf crest and painted smile." },
  { slug: "wrench", name: "Wrench", kernel: "cone·knob·lens", title: "Field Mechanic", blurb: "Precision troubleshooter with pressure valve knob and heavy lens." },
  { slug: "vex", name: "Vex", kernel: "orb·ears·slit", title: "Signal Watcher", blurb: "Agile acoustic observer with radar ears and slit optics." },
  { slug: "lulu", name: "Lulu", kernel: "orb·gills·eye-plate", title: "Deep Explorer", blurb: "Aquatic hydro-scout with atmospheric gills and modular eye-plate." },
  { slug: "nori", name: "Nori", kernel: "cap·lamp·eye-plate", title: "Cave & Tunnel Scout", blurb: "Underground explorer with wide cap canopy and headlamp housing." },
];

export const SHEET_FRAMES = [
  { role: "rest", note: "eyes open, forward" },
  { role: "blink-half", note: "lids half down" },
  { role: "blink-shut", note: "lids closed" },
  { role: "look-left", note: "eyes left" },
  { role: "look-right", note: "eyes right" },
  { role: "look-up", note: "eyes up" },
];

/**
 * Calculates framing coordinates for master bust in a circle of `size` px.
 */
export function coinFrame(a: Art, size: number) {
  const [x, y, side] = displayCoin(a, size);
  const k = size / side;
  return { width: a.w * k, height: a.h * k, left: -x * k, top: -y * k };
}

/**
 * Crew busts are authored for ≥28px coins. Below that, a visor crop reads as
 * two dots and a smile. Pull the camera back so helmet / antennae survive.
 */
export function displayCoin(a: Art, size: number): [number, number, number] {
  const [x, y, side] = a.coin;
  if (size >= 28) return [x, y, side];
  const pull = Math.min(1.65, 28 / Math.max(size, 12));
  const newSide = side * pull;
  const cx = x + side / 2;
  const cy = y + side / 2;
  return [cx - newSide / 2, cy - newSide / 2, newSide];
}

/**
 * Derives a stable hue for a project/crew name.
 */
export function projectHue(project?: string | null): number {
  if (!project) return 210;
  return Math.floor(makeRng("crew:" + project.trim().toLowerCase()).next() * 360);
}

/**
 * Art lighter than this takes the dark ground; art darker takes the light one.
 *
 * Set clear of the whole cast rather than at the midpoint, so nothing sits on
 * the edge and flips band when a re-encode moves a member two hundredths. The
 * nearest are wrench's bust at 0.52 and vex's chip at 0.49.
 */
const GROUND_SPLIT = 0.45;

/**
 * Ground radial gradient for cast coins.
 *
 * HUE is the crew — that part is identity and never moves. LIGHTNESS is not:
 * it belongs to legibility, and it goes to whichever side of the character
 * leaves a silhouette.
 *
 * One fixed ground cannot do that, because the cast is not one value. The bust
 * cut runs from vex at 0.33 to milo at 0.75, so the single mid-lightness wash
 * this used to draw — 0.52 down to 0.30 — sat at the lightness of half the
 * members it was carrying. Milo on it was a teal robot on a teal disc: legible
 * as a coin, unreadable as a face.
 *
 * Two bands rather than a continuous ramp, so a crew still reads as one crew:
 * same hue throughout, and only ever two grounds to learn.
 *
 * This decides art-against-ground only. Coin-against-surface is a different
 * edge with a different owner — the rim in crew-avatar.css — because the dark
 * band is by construction close to a dark app chrome, and no choice of ground
 * can be far from both the art and the background it sits on.
 */
export function crewGround(hue: number | null, ink = 1): string {
  if (hue == null) {
    return "color-mix(in srgb, var(--hud-ink, #fff) 8%, var(--hud-surface, #1e2029))";
  }
  return ink >= GROUND_SPLIT
    ? `radial-gradient(115% 105% at 50% 112%, oklch(0.34 0.1 ${hue}) 0%, oklch(0.25 0.07 ${hue}) 52%, oklch(0.17 0.04 ${hue}) 100%)`
    : `radial-gradient(115% 105% at 50% 112%, oklch(0.9 0.035 ${hue}) 0%, oklch(0.84 0.05 ${hue}) 52%, oklch(0.75 0.06 ${hue}) 100%)`;
}

/**
 * Matches a name or slug to the cast member it actually names — or nobody.
 *
 * Matching is on token boundaries, not substrings: "milo-2" and "agent.milo"
 * are Milo, "familiar" and "convex" are not. A bare `includes` quietly turned
 * unrelated agents into cast members, which is the same identity bug as
 * assigning one at random, just harder to see.
 */
export function matchCastSlug(nameOrSlug?: string | null): string | undefined {
  if (!nameOrSlug) return undefined;
  const clean = nameOrSlug.trim().toLowerCase().replace(/^@/, "");
  if (CREW_ART[clean]) return clean;

  const tokens = clean.split(/[^a-z0-9]+/).filter(Boolean);
  for (const slug of Object.keys(CREW_ART)) {
    if (tokens.includes(slug)) return slug;
  }
  return undefined;
}

/**
 * Deterministically hands out a cast member for a seed.
 *
 * This is assignment, not identification. It is right where the cast IS the
 * decoration — a workspace mascot, an operator picking a character — and wrong
 * for an agent's avatar, where borrowing another member's face is a lie about
 * who you are looking at. Unmatched agents get the generative renderer instead.
 */
export function assignCastSlug(seed: string): string {
  const knownSlugs = Object.keys(CREW_ART);
  const rng = makeRng("crew:cast:" + seed.trim().toLowerCase());
  return knownSlugs[Math.floor(rng.next() * knownSlugs.length)];
}

/**
 * Resolves a name or slug to a known cast member slug, or maps deterministically.
 *
 * @deprecated Prefer `matchCastSlug` for identity and `assignCastSlug` for
 * decoration — passing `true` here conflates the two.
 */
export function resolveCastSlug(nameOrSlug?: string | null, fallbackDeterministic = false): string | undefined {
  if (!nameOrSlug) return undefined;
  return matchCastSlug(nameOrSlug) ?? (fallbackDeterministic ? assignCastSlug(nameOrSlug) : undefined);
}
