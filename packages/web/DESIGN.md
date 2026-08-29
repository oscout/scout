---
name: Scout Web
description: The browser dialect of the Lit Control Room — an OKLCH neutral canvas, a lime signal, and hairline-flat instrument chrome.
colors:
  canvas: "oklch(0.118 0.004 260)"
  surface: "oklch(0.205 0.005 260)"
  ink: "oklch(0.975 0.006 260)"
  muted: "oklch(0.80 0.008 260)"
  dim: "oklch(0.70 0.007 260)"
  border: "oklch(0.975 0.006 260 / 0.08)"
  accent: "oklch(0.86 0.17 125)"
  accent-soft: "oklch(0.86 0.17 125 / 0.08)"
  status-ok: "oklch(0.80 0.15 155)"
  status-warn: "oklch(0.82 0.15 85)"
  status-error: "oklch(0.72 0.18 25)"
  info: "#62b6ff"
  cat-gold: "#d7a978"
  cat-purple: "#c58cff"
  cat-sky: "#38bdf8"
  scrim: "rgba(0, 0, 0, 0.5)"
  scrim-soft: "rgba(0, 0, 0, 0.3)"
  canvas-light: "oklch(0.978 0.004 85)"
  surface-light: "oklch(0.992 0.003 85)"
  ink-light: "oklch(0.24 0.01 80)"
  muted-light: "oklch(0.56 0.014 80)"
  dim-light: "oklch(0.72 0.01 80)"
  border-light: "oklch(0.88 0.008 82 / 0.95)"
  accent-light: "oklch(0.72 0.16 125)"
typography:
  display:
    fontFamily: "'Inter Tight', 'Inter', ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(34px, calc(28px + 2vw), 52px)"
    fontWeight: 600
    lineHeight: 1.12
    letterSpacing: "0"
  title:
    fontFamily: "'Inter', ui-sans-serif, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.35
  body:
    fontFamily: "'Inter', ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
  body-compact:
    fontFamily: "'Inter', ui-sans-serif, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.35
  label:
    fontFamily: "'JetBrains Mono', ui-monospace, Menlo, monospace"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "0.12em"
  serif:
    fontFamily: "'Spectral', 'Cormorant Garamond', Georgia, serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  xs: "2px"
  sm: "4px"
  md: "6px"
  lg: "8px"
  xl: "12px"
  2xl: "16px"
  pill: "999px"
spacing:
  3xs: "2px"
  2xs: "4px"
  xs: "6px"
  sm: "8px"
  md: "10px"
  lg: "12px"
  xl: "14px"
  2xl: "16px"
  3xl: "20px"
  4xl: "24px"
  5xl: "32px"
  6xl: "40px"
  7xl: "48px"
  8xl: "64px"
components:
  button:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "6px 14px"
    typography: "{typography.body-compact}"
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.canvas}"
    rounded: "{rounded.md}"
    padding: "6px 14px"
  button-accent:
    textColor: "{colors.accent}"
    rounded: "{rounded.md}"
    padding: "6px 14px"
  button-sm:
    rounded: "{rounded.md}"
    padding: "4px 10px"
  chip:
    rounded: "{rounded.md}"
    padding: "2px 8px"
    typography: "{typography.body-compact}"
  chip-pill:
    rounded: "{rounded.pill}"
    padding: "2px 8px"
  surface-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.xl}"
    padding: "16px"
  surface-card-stat:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    padding: "12px 14px"
---

# Design System: Scout Web

## Overview

**Creative North Star: "The Lit Control Room"** — browser dialect.

Scout Web is the widest and densest of the product surfaces: 60+ screens over the
same broker state, viewed on a desktop monitor at arm's length, usually in a
window the operator is not currently looking at. It inherits the root grammar
wholesale — eyebrow labels, dot vocabulary, hairline separation, the compact
scale — and adds the one thing the other surfaces don't need: a token layer built
to stop 60 screens from improvising.

Its identity is a near-neutral OKLCH canvas at hue 260 with a **lime** signal at
hue 125. That pairing is unusual on purpose. The canvas is so close to neutral
that the accent has nowhere to hide, and lime is far enough from every status hue
(green 155, amber 85, red 25) that "working" never reads as "OK." Light mode
inverts to a warm paper canvas at hue 80–85 rather than a cool one, matching the
native Paper preset and the marketing site's paper/ink system.

Architecturally the surface is a middle layer: HudsonKit's `--hud-*` primitives
underneath, Scout's scales and semantic colors on top, component CSS last. That
ordering is deliberate — primitives load first so per-component CSS naturally wins
as a contextual override. HudsonKit itself is shared with iOS and macOS and is
never modified from here.

**Key Characteristics:**

- OKLCH throughout, hue 260 in dark and hue 80–85 in light
- A lime accent deliberately distant from every status hue
- Flat surfaces, 1px hairlines, shadow only as a response to state
- Four eyebrow tiers as the structural label voice
- A composable primitive set — label, chip, dot, button, surface-card
- Theme-varying color in one file; theme-independent scales in another

## Shell presentations

Scout supports two presentations over the same routes, records, commands, and
permissions. A presentation may reorganize chrome; it must never create a
parallel data model or imply a capability the active Scout runtime does not have.

- **Scout** is the default control-room shell: near-neutral rails, technical
  labels, and the full route hierarchy.
- **Slack** maps the same product into a familiar workspace rhythm: a compact
  primary rail, a channel/context list, the conversation canvas, an optional
  inspector, and a global search bar. Its low-chroma smoky-plum chrome is
  navigation color, not a new status or product accent. The compact primary rail
  is 56px so 20px glyphs sit on a stable 28px centerline. In this presentation,
  Home restores the conversation workspace and Activity owns the operational
  digest.

The Home overview has no right inspector in either presentation. Context chrome
is earned by a concrete conversation, task, session, agent, or selected record;
an empty or ambient context panel is not a placeholder.

## Colors

A near-neutral OKLCH field with a single high-chroma signal — the canvas is
almost achromatic (chroma 0.004–0.008) so the accent at chroma 0.17 carries the
entire chromatic weight of the screen.

### Primary

- **Signal Lime** (dark `oklch(0.86 0.17 125)`, light `oklch(0.72 0.16 125)`): the
  working/active state, primary CTAs, focus rings, and interactive affordance. Its
  soft form at 8% (dark) / 11% (light) alpha fills selected rows and active
  segments.

### Neutral

- **Deep Slate Canvas** (`oklch(0.118 0.004 260)`) / **Warm Paper Canvas**
  (`oklch(0.978 0.004 85)`): the page floor. Note the hue flip — dark is cool-neutral,
  light is warm-neutral, so light mode reads as paper rather than office-cool.
- **Lifted Slate Surface** (`oklch(0.205 0.005 260)`) / **Near-White Surface**
  (`oklch(0.992 0.003 85)`): cards and panels, one clear step off the canvas.
- **Full Ink** (`oklch(0.975 0.006 260)` / `oklch(0.24 0.01 80)`): primary text.
- **Muted Ink** (`oklch(0.80 0.008 260)` / `oklch(0.56 0.014 80)`): secondary text.
- **Dim Ink** (`oklch(0.70 0.007 260)` / `oklch(0.72 0.01 80)`): tertiary text and
  disabled affordances.
- **Whisper Border** (`oklch(0.975 0.006 260 / 0.08)`): the 8%-alpha hairline that
  does nearly all structural separation in dark mode.

On top of these sit a set of derived chrome inks — strong (94%), normal (84%),
soft (68%), faint (64%), ghost (56%) — plus hover (5%) and active (9%)
tints, all built with `color-mix` off the ink token so they follow the theme
automatically. The faint tier stays above 60% so sidebar, rail, and lane text
remain readable on near-black; do not lower it back.

### Status

- **Status OK** (`oklch(0.80 0.15 155)`), **Status Warn** (`oklch(0.82 0.15 85)`),
  **Status Error** (`oklch(0.72 0.18 25)`): earned by real state only.

### Tertiary

- **Briefings Gold** (`#d7a978` / `#a9824f`), **Ops Purple** (`#c58cff` / `#8b5cf6`),
  **Mesh Sky** (`#38bdf8` / `#0ea5e9`): categorical brand accents scoped to specific
  areas. **Info Blue** (`#62b6ff` / `#2f7fd6`) is the ops/tail highlight.

### Named Rules

**The Signal-Not-Status Rule.** Lime is "working," not "good." It sits at hue 125,
deliberately between the eye's reading of green (155 = OK) and yellow — close
enough to feel alive, far enough that an active agent never reads as a passing check.

**The Category-Is-Not-Status Rule.** The three `--cat-*` tokens and `--info` are
brand and area colors. Routing briefings gold to `--amber` or mesh sky to `--info`
flattens two distinct vocabularies into one. This has been tried; don't repeat it.

**The Color-Mix Rule.** Derived inks, tints, and washes are built with
`color-mix()` off a semantic token, never hand-written as a new literal. A new
`rgba(255,255,255,.06)` in a component is a token that should have existed.

## Typography

**Display Font:** Inter Tight (falls back to Inter)
**Body Font:** Inter (with `ui-sans-serif, system-ui`)
**Label/Mono Font:** JetBrains Mono (with `ui-monospace, Menlo`)
**Editorial:** Spectral (with Cormorant Garamond, Georgia) — reserved, rarely used

**Character:** Inter and JetBrains Mono at small sizes, doing sharply divided
jobs. Inter carries everything a person wrote; JetBrains Mono carries everything
the machine knows — ids, paths, counts, harness names, statuses, section headers.
Inter Tight appears only at display sizes, where Inter's default width starts to
feel loose.

### Hierarchy

- **Display** (600, `clamp(34px → 52px)`, 1.12): empty states and onboarding only.
  Three fluid steps exist (`xs` 24→28, `sm` 28→34, `md` 34→52).
- **Title** (600, 16–20px, 1.35): screen and panel titles.
- **Body** (400, 13px, 1.45): the reading default — matches `--hud-text-base`.
- **Body-compact** (400, 12px, 1.35): list rows and dense detail.
- **Label** (mono, 600, uppercase, 9–11px): four tiers — `xs` 9px/0.18em,
  `sm` 10px/0.08em, `md` 11px/0.12em, `lg` 11px/0.18em.

The full size ladder runs 9, 10, 11, 12, 13, 14, 16, 18, 20, 24, 28, 34, 44, 52 —
whole pixels only.

### Named Rules

**The Eyebrow-Tier Rule.** Use `.label-xs` through `.label-lg`. Writing
`font-family + text-transform + letter-spacing + font-size` by hand to make a
label is how the type voice drifts; there are exactly four legal eyebrows.

**The Whole-Pixel Rule.** 9.5, 10.5, 11.5, and 12.5 were retired. Fractional sizes
do not come back.

## Layout

Padding, margin, and gap come off a 14-step scale anchored at `xs=6 / sm=8 / lg=12`,
fine at the bottom because ops chrome lives between 2px and 12px.

Two snapping biases apply when tokenizing existing values: round **up** for
interactive padding (preserving touch targets), and **to nearest, ties down** for
layout gaps and margins. So a raw 5px becomes `xs` (6) as button padding but `2xs`
(4) as a gap; a raw 9px becomes `md` (10) as padding but `sm` (8) as a gap.

Layout constants are not spacing and are never snapped: status bar 28px, sidebar
280px. Widths, heights, insets, transforms, border-widths, shadow geometry, blur,
flex-basis, and grid tracks all stay literal.

Motion runs off a nine-step duration scale (120/150/220/340/600ms, then 1.1s
typing, 1.6s pulse, 2s breathe, 3.2s scan) with three easings — standard
`cubic-bezier(0.2, 0.7, 0.2, 1)`, emphasis `cubic-bezier(0.16, 1, 0.3, 1)`, and
linear. Rail collapse and resize-commit use a dedicated 160ms. Everything is
behind a single `prefers-reduced-motion` gate.

Files load in a fixed order — `tokens.css` and `primitives.css` at the top of
`main.tsx`, before `arc-tailwind.css` and `app.css`, with per-component CSS
imported later per-`.tsx` so it wins as a contextual override.

## Elevation & Depth

**Flat with hairlines.** Surfaces sit flat at rest and separate through a 1px
hairline plus a tonal step. In dark mode that hairline is only 4% alpha — the
tonal step between canvas (L 0.132) and surface (L 0.178) does most of the work.

Shadows exist but are a **response to state**, not a resting condition. Buttons
gain a 1–2px shadow on hover; cards gain theirs on hover; panels, bars, nav, and
the minimap carry standing shadows only as window-level chrome, not as content
decoration.

### Shadow Vocabulary

- **Soft** (`--shadow-soft`, `oklch(0.08 0.004 260 / 0.42)` dark): the base shadow
  color, used with local geometry.
- **Card** (`0 8px 22px rgba(0,0,0,0.22)` dark / `0 8px 22px oklch(0.42 0.01 80 / 0.10)`
  light): card elevation on hover.
- **Card hover** (`0 14px 36px rgba(0,0,0,0.30)` / `… / 0.14` light).
- **Panel / bar / nav / minimap** (`0 12px 34px`, `0 -10px 28px`, `0 8px 24px`,
  `0 10px 24px` at 32–45% alpha): window chrome only.

Light-mode shadows are derived far softer than their dark counterparts — a heavy
black shadow on a light surface reads as dirt.

### Named Rules

**The Flat-At-Rest Rule.** A surface at rest has no shadow. If a card needs a
shadow to be findable, its tonal step or its hairline is wrong.

**The Opaque-Bridge Rule.** Window opacity must not be baked into theme variables
when the surface is composited over a dark backdrop — that was the root cause of
muddy light-mode embeds. Keep the bridge opaque and let the host window own
translucency.

## Shapes

Small, purposeful radii: 2px and 4px for micro-elements, **6px as the default**
control and chip radius, 8px for stat cards and inset wells, 12px for standard
content cards, 16px for large surfaces, and a 999px pill for capsule chips and
segmented controls. `border-radius: 50%` is for dots and avatars only and is
never tokenized.

Borders are 1px hairlines, usually a `color-mix` of ink at 4–6% in dark or the
border token in light. Border-width is never snapped to the spacing scale.

The `--surface-card--accent` variant adds a 2px left rail in accent — and this is
the one place a left bar is legal, because the variant is used on flat rows and
bands rather than on rounded wells.

## Components

Crisp and machined, composed from a base class plus a tone plus modifiers. The
five primitives below replaced a sprawl of near-duplicate component classes; new
code composes them rather than re-rolling.

### Buttons

- **Shape:** default radius (6px), `6px 14px` padding, 1px border.
- **Default:** surface fill, border-token hairline, ink text, weight 500,
  13px sans. Transitions on `all 140ms cubic-bezier(0.16, 1, 0.3, 1)`.
- **Primary:** solid ink on canvas-colored text — the one highest-contrast action.
  Hover mixes 10% canvas into the ink and deepens the shadow.
- **Accent:** 15% accent fill, 60% accent border, accent text. Hover raises the
  fill to 24%.
- **Ghost:** transparent with a chrome-hover fill on hover, no shadow.
- **Danger:** red text with a 30% red border; hover fills to 8%.
- **Sizes:** `sm` (`4px 10px`, 11px), default, `lg` (`8px 16px`), `icon` (`4px`,
  no gap).
- **Mono:** uppercase JetBrains Mono at 0.08em tracking, for nav and fleet actions.
- **Focus:** inherits the global `:focus-visible` ring
  (`0 0 0 3px color-mix(in srgb, var(--accent) 35%, transparent)`). Never stripped.
- **Disabled:** 40% opacity, `not-allowed`.

### Chips

- **Shape:** 6px radius, `2px 8px` padding, 1px border, weight 600, 10px.
- **Tones:** neutral, working, success, warning, danger, info — each derived from
  one color at ~12% background and ~18–22% border alpha.
- **Modifiers:** `pill` (999px), `sm` (9px, tighter padding), `ghost` (no border or
  background), `mono` (JetBrains Mono, weight 500), `caps` (uppercase, 0.04em).

### Dots

- **Shape:** a 6px circle (`sm` 5px, `lg` 7px), `currentColor` fill.
- **Tones:** neutral, success, working, warning, danger, info — tone sets `color`
  only, so modifiers echo it automatically.
- **Modifiers:** `glow` (6px halo at 55% of the tone), `pulse` (1.4s ease-in-out
  opacity 0.4→1), `ring` (2px ring in `--dot-ring`, defaulting to the canvas — for
  dots overlapping avatars).

### Cards / Containers

- **Corner style:** 12px standard, 8px for stat and inset variants.
- **Background:** surface at 96% (standard), 92% (stat), or canvas at 80% (inset).
- **Border:** 1px at 6% ink; the inset variant has none.
- **Internal padding:** 16px standard, `12px 14px` stat, 12px inset.
- **Accent variant:** a 2px left rail at 60% accent.

### Inputs / Fields

Fields follow the button's resting treatment — surface fill, hairline border, 6px
radius — and signal focus through a border shift plus the global focus ring. A
rounded composer or modal well signals active state with its focus border, never
with a left accent bar.

### Excluded from the primitives

Some components stay bespoke on purpose and only source their values from tokens:
the glass/blur agent card and scoutbot popover, the fixed-height scoutbot status
chip, and the equal-fill fleet segmented control.

## Do's and Don'ts

### Do:

- **Do** compose `.label-*`, `.chip`, `.dot`, `.btn`, and `.surface-card` instead of
  writing new near-duplicate classes.
- **Do** build derived colors with `color-mix()` off a semantic token.
- **Do** keep lime for "working" and the status triad for real status.
- **Do** round interactive padding **up** and layout gaps **to nearest** when
  tokenizing.
- **Do** check both dark and light after any color work — light mode is the
  higher-risk theme here.
- **Do** run `vite build` as the TS+CSS gate before calling a change done.
- **Do** keep surfaces flat at rest and let hover own the shadow.

### Don't:

- **Don't** modify HudsonKit from this package. iOS and macOS depend on it; new
  tokens are web-side only.
- **Don't** route the `--cat-*` brand colors or `--info` to status tokens.
- **Don't** add fractional font sizes or off-scale letter-spacing.
- **Don't** tokenize width, height, inset, transform, border-width, shadow
  geometry, blur, flex-basis, or grid tracks — those stay literal.
- **Don't** snap the layout constants (28px status bar, 280px sidebar).
- **Don't** strip a focus outline without restoring an equivalent ring.
- **Don't** lower the faint chrome-ink tier back toward 35%; it sits at 55–60% for
  legibility.
- **Don't** put a left accent bar on a rounded well — that treatment belongs to
  flat rows and bands.
- **Don't** ship a resting shadow on a card.
