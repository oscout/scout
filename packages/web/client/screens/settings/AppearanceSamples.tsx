/**
 * Appearance specimens shared by the Settings page and the older settings
 * sheet. Each one is drawn inside its own theme frame, so a palette, shape or
 * accent sample shows that choice rather than the one currently applied.
 * Styles live in settings-drawer.css.
 */

import type { ReactNode } from "react";
import type {
  ScoutThemeAccent,
  ScoutThemeContrast,
  ScoutThemePalette,
  ScoutThemeTemplate,
} from "../../lib/theme.ts";

export type AppearanceTheme = "light" | "dark";

export function AppearanceFrame({
  className,
  theme,
  template,
  palette,
  contrast,
  accent,
  children,
}: {
  className: string;
  theme: AppearanceTheme;
  template: ScoutThemeTemplate;
  palette: ScoutThemePalette;
  contrast: ScoutThemeContrast;
  accent: ScoutThemeAccent;
  children: ReactNode;
}) {
  return (
    <div
      className={className}
      data-scout-theme={theme}
      data-scout-theme-mode={theme}
      data-scout-palette={palette}
      data-scout-contrast={contrast}
      data-scout-accent={accent}
      data-hudson-theme={theme}
      data-hudson-template={template}
    >
      {children}
    </div>
  );
}

export function PaletteSample({
  palette,
  theme,
  template,
}: {
  palette: ScoutThemePalette;
  theme: AppearanceTheme;
  template: ScoutThemeTemplate;
}) {
  return (
    <AppearanceFrame
      className="s-settings-palette-sample"
      theme={theme}
      template={template}
      palette={palette}
      contrast="balanced"
      accent="theme"
    >
      <span className="s-settings-palette-rail"><i /><i data-active /><i /><i /></span>
      <span className="s-settings-palette-list"><i /><i data-selected /><i /></span>
      <span className="s-settings-palette-detail"><i data-title /><i /><i /><i data-action /></span>
    </AppearanceFrame>
  );
}

/** A window outline for the app layout choice; `data-shell` on an ancestor tints Slack's chrome. */
export function ShellSample() {
  return (
    <span className="s-settings-shell-sample" aria-hidden="true">
      <i data-part="top" />
      <i data-part="rail" />
      <i data-part="list"><b /><b /><b /></i>
      <i data-part="content"><b /><b /><b /></i>
    </span>
  );
}

export function LiveAppearancePreview({
  theme,
  template,
  palette,
  contrast,
  accent,
}: {
  theme: AppearanceTheme;
  template: ScoutThemeTemplate;
  palette: ScoutThemePalette;
  contrast: ScoutThemeContrast;
  accent: ScoutThemeAccent;
}) {
  return (
    <AppearanceFrame
      className="s-settings-live-preview"
      theme={theme}
      template={template}
      palette={palette}
      contrast={contrast}
      accent={accent}
    >
      <div className="s-settings-live-preview-bar">
        <span><i /> SCOUT</span>
        <span className="s-settings-live-preview-state"><i /> WORKING</span>
      </div>
      <div className="s-settings-live-preview-shell">
        <div className="s-settings-live-preview-rail" aria-hidden="true">
          <i data-active /><i /><i /><i /><i />
        </div>
        <div className="s-settings-live-preview-list">
          <span className="s-settings-live-preview-kicker">CONVERSATIONS</span>
          <span className="s-settings-live-preview-row" data-selected>
            <i /><b>Openscout</b><small>now</small>
          </span>
          <span className="s-settings-live-preview-row"><i /><b>Hudson</b><small>8m</small></span>
          <span className="s-settings-live-preview-row"><i /><b>Scout</b><small>1h</small></span>
        </div>
        <div className="s-settings-live-preview-detail">
          <span className="s-settings-live-preview-kicker">ACTIVE FLIGHT</span>
          <strong>Theme system review</strong>
          <p>Separating palette, interface shape, and contrast keeps every choice honest.</p>
          <div className="s-settings-live-preview-event"><i /> Agent is working · updated now</div>
          <button type="button" tabIndex={-1}>Open trace</button>
        </div>
      </div>
    </AppearanceFrame>
  );
}
