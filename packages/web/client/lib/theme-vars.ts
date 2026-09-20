/**
 * The Scout palette, as raw `--hud-*` custom properties.
 *
 * A leaf module on purpose. `scout/Provider.tsx` owns the operator shell — the
 * broker stream, agent state, Scoutbot — and the standalone surfaces (`/chat`,
 * `/invite/<token>`, hosted Chat) must carry the same palette without dragging
 * any of that into their bundle. So the maps live here and Provider re-exports
 * them; one source of color, two very different graphs above it.
 */

import type { CSSProperties } from "react";

export type ThemeVars = CSSProperties & Record<`--${string}`, string>;

// Exported for the design-sync lightweight preview provider (client/_ds/) — it
// reuses these vars so cards render on the real dark theme. No behavior change.
export const DARK_THEME_VARS: ThemeVars = {
  "--hud-bg": "oklch(0.118 0.004 260)",
  "--hud-surface": "oklch(0.205 0.005 260)",
  "--hud-ink": "oklch(0.975 0.006 260)",
  "--hud-muted": "oklch(0.80 0.008 260)",
  "--hud-dim": "oklch(0.70 0.007 260)",
  "--hud-border": "oklch(0.975 0.006 260 / 0.08)",
  "--hud-accent": "oklch(0.86 0.17 125)",
  "--hud-accent-soft": "oklch(0.86 0.17 125 / 0.08)",
  "--hud-shadow-soft": "oklch(0.08 0.004 260 / 0.42)",
  "--hud-chrome-border": "oklch(0.975 0.006 260 / 0.04)",
  "--hud-shadow-panel": "0 12px 34px oklch(0.08 0.004 260 / 0.45)",
  "--hud-shadow-panel-hover": "0 14px 38px oklch(0.08 0.004 260 / 0.52)",
  "--hud-shadow-bar": "0 -10px 28px oklch(0.08 0.004 260 / 0.38)",
  "--hud-shadow-nav": "0 8px 24px oklch(0.08 0.004 260 / 0.32)",
  "--hud-shadow-minimap": "0 10px 24px oklch(0.08 0.004 260 / 0.38)",
  "--hud-status-ok": "oklch(0.80 0.15 155)",
  "--hud-status-warn": "oklch(0.82 0.15 85)",
  "--hud-status-error": "oklch(0.72 0.18 25)",
  /* HudsonKit's Tailwind utilities (`bg-background`, `text-foreground`, used by
   * chrome/Frame) read raw OKLCH channels via `oklch(var(--background))`, a
   * layer separate from the --hud-* tokens above. HudsonKit only flips them
   * under [data-hudson-template][data-hudson-theme], a pair Scout never sets,
   * so Frame's full-viewport plane stayed dark in light mode while content
   * inherited light inks — dark-on-dark rails. Point the channels at Scout's
   * own canvas/ink instead of adopting HudsonKit's cool light (hue 213), which
   * would put a second white next to Scout's warm paper. */
  "--background": "0.132 0.004 260",
  "--foreground": "0.965 0.006 260",
  "--card": "0.178 0.005 260",
  "--card-foreground": "0.965 0.006 260",
  "--popover": "0.178 0.005 260",
  "--popover-foreground": "0.965 0.006 260",
  "--muted-foreground": "0.72 0.008 260",
  // Scout semantic colors (web-only; no HudsonKit equivalent).
  "--scrim": "rgba(0, 0, 0, 0.5)",
  "--scrim-soft": "rgba(0, 0, 0, 0.3)",
  "--info": "#62b6ff",
  "--shadow-card": "0 8px 22px rgba(0, 0, 0, 0.22)",
  "--shadow-card-hover": "0 14px 36px rgba(0, 0, 0, 0.30)",
  // Categorical / brand accents — distinct from status colors, do not flatten.
  "--cat-gold": "#d7a978",
  "--cat-purple": "#c58cff",
  "--cat-sky": "#38bdf8",
  "--scout-chrome-ink-strong": "color-mix(in srgb, var(--hud-ink) 94%, transparent)",
  "--scout-chrome-ink": "color-mix(in srgb, var(--hud-ink) 84%, transparent)",
  "--scout-chrome-ink-soft": "color-mix(in srgb, var(--hud-ink) 68%, transparent)",
  /* Secondary chrome text: keep hierarchy, but stay readable on near-black. */
  "--scout-chrome-ink-faint": "color-mix(in srgb, var(--hud-ink) 64%, transparent)",
  "--scout-chrome-ink-ghost": "color-mix(in srgb, var(--hud-ink) 56%, transparent)",
  "--scout-chrome-hover": "color-mix(in srgb, var(--hud-ink) 5%, transparent)",
  "--scout-chrome-active": "color-mix(in srgb, var(--hud-ink) 9%, transparent)",
  "--scout-chrome-border-soft": "color-mix(in srgb, var(--hud-ink) 8%, transparent)",
  "--scout-chrome-avatar-ink": "#111111",
  "--hud-font-sans": "'Inter', ui-sans-serif, system-ui, sans-serif",
  "--hud-font-mono": "'JetBrains Mono', ui-monospace, Menlo, monospace",
  "--hud-font-serif": "'Spectral', 'Cormorant Garamond', Georgia, serif",
  "--hud-font-accent-title": "'Inter Tight', var(--hud-font-sans)",
};

export const LIGHT_THEME_VARS: ThemeVars = {
  // Paper neutrals: keep warm hue (~78) and a little chroma so muted/dim
  // read as taupe/ink, not cool slate gray (Repos empty-state critique).
  "--hud-bg": "oklch(0.982 0.008 78)",
  "--hud-surface": "oklch(0.994 0.006 78)",
  "--hud-ink": "oklch(0.26 0.018 72)",
  "--hud-muted": "oklch(0.50 0.028 70)",
  "--hud-dim": "oklch(0.64 0.022 72)",
  "--hud-border": "oklch(0.86 0.016 75 / 0.92)",
  "--hud-accent": "oklch(0.72 0.16 125)",
  "--hud-accent-soft": "oklch(0.72 0.16 125 / 0.11)",
  "--hud-shadow-soft": "oklch(0.42 0.02 70 / 0.11)",
  "--hud-status-ok": "oklch(0.64 0.16 155)",
  "--hud-status-warn": "oklch(0.72 0.15 85)",
  "--hud-status-error": "oklch(0.62 0.19 25)",
  /* See DARK_THEME_VARS: raw channels behind HudsonKit's Tailwind utilities,
   * held on Scout's warm paper canvas rather than HudsonKit's cool light. */
  "--background": "0.978 0.004 85",
  "--foreground": "0.24 0.01 80",
  "--card": "0.992 0.003 85",
  "--card-foreground": "0.24 0.01 80",
  "--popover": "0.992 0.003 85",
  "--popover-foreground": "0.24 0.01 80",
  "--muted-foreground": "0.56 0.014 80",
  // Scout semantic colors (web-only; no HudsonKit equivalent).
  "--scrim": "rgba(28, 24, 20, 0.30)",
  "--scrim-soft": "rgba(28, 24, 20, 0.16)",
  "--info": "#2f7fd6",
  "--shadow-card": "0 8px 22px oklch(0.42 0.02 70 / 0.09)",
  "--shadow-card-hover": "0 14px 36px oklch(0.42 0.02 70 / 0.13)",
  // Categorical / brand accents — distinct from status colors, do not flatten.
  "--cat-gold": "#a9824f",
  "--cat-purple": "#8b5cf6",
  "--cat-sky": "#0ea5e9",
  "--scout-chrome-ink-strong": "color-mix(in srgb, var(--hud-ink) 94%, transparent)",
  "--scout-chrome-ink": "color-mix(in srgb, var(--hud-ink) 78%, transparent)",
  "--scout-chrome-ink-soft": "color-mix(in srgb, var(--hud-ink) 60%, transparent)",
  /* SCO-085: raise secondary text from ~35% to ~55–60% for sidebar/rail/lanes. */
  "--scout-chrome-ink-faint": "color-mix(in srgb, var(--hud-ink) 56%, transparent)",
  "--scout-chrome-ink-ghost": "color-mix(in srgb, var(--hud-ink) 50%, transparent)",
  "--scout-chrome-hover": "color-mix(in srgb, var(--hud-ink) 4%, transparent)",
  "--scout-chrome-active": "color-mix(in srgb, var(--hud-ink) 8%, transparent)",
  "--scout-chrome-border-soft": "color-mix(in srgb, var(--hud-border) 80%, transparent)",
  "--scout-chrome-avatar-ink": "#ffffff",
  "--hud-font-sans": "'Inter', ui-sans-serif, system-ui, sans-serif",
  "--hud-font-mono": "'JetBrains Mono', ui-monospace, Menlo, monospace",
  "--hud-font-serif": "'Spectral', 'Cormorant Garamond', Georgia, serif",
  "--hud-font-accent-title": "'Inter Tight', var(--hud-font-sans)",
};
