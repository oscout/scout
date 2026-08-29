import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useOptionalFlag } from "hudsonkit/flags";
import { useOptionalTheme } from "hudsonkit/theme";
import { Check, Copy, Maximize2, Minimize2, Monitor, Moon, RefreshCw, Sparkles, Sun } from "lucide-react";
import { api } from "../../lib/api.ts";
import {
  deleteOpenAIApiKey,
  deleteOpenAIKeyFromServer,
  ensureOpenAIKeyOnServer,
  getClientCredentialState,
  getServerCredentialState,
  saveOpenAIKeyToServer,
  setOpenAIApiKey,
  type ClientCredentialState,
  type ServerCredentialState,
} from "../../lib/credentials.ts";
import { useScout } from "../../scout/Provider.tsx";
import type {
  CommsChannel,
  CommsTone,
  CommsVerbosity,
  InterruptThreshold,
  MeshStatus,
  OperatorProfile,
  PairingState,
  ProvisionalAgentNamesMode,
} from "../../lib/types.ts";
import { timeAgo } from "../../lib/time.ts";
import {
  fetchScoutVoiceHistory,
  fetchScoutVoiceSettings,
  saveScoutVoiceSettings,
  type ScoutVoiceInputDevice,
  type ScoutVoicePermissionStatus,
  type ScoutVoicePreference,
  type ScoutVoiceSessionHistoryEntry,
  type ScoutVoiceSettings,
} from "../../lib/scout-voice.ts";
import { useFocusTrap } from "../../lib/keyboard-nav.ts";
import { routePath } from "../../lib/router.ts";
import {
  normalizeScoutThemeTemplate,
  type ScoutThemeAccent,
  type ScoutThemeContrast,
  type ScoutThemePalette,
  type ScoutShellStyle,
  type ScoutThemeTemplate,
  type ScoutAvatarStyle,
  type ScoutAvatarSize,
} from "../../lib/theme.ts";
import { CAST_MEMBERS, CREW_ASSETS_AVAILABLE, rendererCoverage } from "../../lib/crew-registry.ts";
import { CrewAvatar } from "../../components/CrewAvatar.tsx";
import { CastPicker } from "../../components/CastPicker.tsx";
import { placementSize } from "../../components/AgentAvatar.tsx";
import { CrewStage } from "../../components/CrewStage.tsx";
import { SpriteAvatar } from "../../components/SpriteAvatar.tsx";
import { SCOUT_REALTIME_VOICE_FLAG } from "../../../shared/realtime-voice.ts";
import {
  fetchScoutRealtimeVoiceSettings,
  publishScoutRealtimeVoiceSettings,
  saveScoutRealtimeVoiceSettings,
} from "../../lib/realtime-voice-settings.ts";
import { VoiceHostStatusBanner, VoicePermissionsPanel } from "./VoicePermissionsPanel.tsx";
import "./settings-drawer.css";
import "./voice-permissions-panel.css";

export type DrawerSettingsSection = "appearance" | "operator" | "comms" | "credentials" | "voice" | "devices" | "about";
type Section = DrawerSettingsSection;

const HUE_PRESETS = [195, 125, 300, 45, 355, 210];

function hueColor(hue: number): string {
  return `oklch(0.80 0.14 ${hue})`;
}
function hueInk(hue: number): string {
  return `oklch(0.18 0.08 ${hue})`;
}

// ── Field primitives ──────────────────────────────────────────────────

function SectionRule({ label, right }: { label: string; right?: string }) {
  return (
    <div className="s-settings-section-rule">
      <span className="s-settings-section-label">{label}</span>
      <span className="s-settings-section-line" />
      {right && <span className="s-settings-section-right">{right}</span>}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="s-settings-field">
      <label className="s-settings-field-label">{label}</label>
      {children}
      {hint && <span className="s-settings-field-hint">{hint}</span>}
    </div>
  );
}

function TextInput({ value, onChange, mono }: { value: string; onChange: (v: string) => void; mono?: boolean }) {
  return (
    <input
      className={`s-settings-input${mono ? " s-settings-input--mono" : ""}`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function TextArea({ value, onChange, rows = 3 }: { value: string; onChange: (v: string) => void; rows?: number }) {
  return (
    <textarea
      className="s-settings-textarea"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={rows}
    />
  );
}

function SliderInput({
  value, onChange, min, max, step = 1, unit = "",
}: {
  value: number; onChange: (v: number) => void; min: number; max: number; step?: number; unit?: string;
}) {
  return (
    <div className="s-settings-slider-wrap">
      <input type="range" min={min} max={max} step={step}
        value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="s-settings-slider-value">{value} {unit}</span>
    </div>
  );
}

function OptionRow<T extends string>({
  value, onChange, options, stacked, columns,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { id: T; label: string; sub: string }[];
  stacked?: boolean;
  columns?: number;
}) {
  return (
    <div
      className={stacked ? "s-settings-option-stacked" : "s-settings-option-grid"}
      style={!stacked ? { gridTemplateColumns: `repeat(${columns ?? options.length}, 1fr)` } : undefined}
    >
      {options.map((o) => (
        <button
          key={o.id}
          className={`s-settings-option-btn${value === o.id ? " s-settings-option-btn--active" : ""}`}
          onClick={() => onChange(o.id)}
        >
          <span className="s-settings-option-label">{o.label}</span>
          <span className="s-settings-option-sub">{o.sub}</span>
        </button>
      ))}
    </div>
  );
}

// ── Appearance section ────────────────────────────────────────────────

const THEME_MODES = [
  { id: "system", label: "System", sub: "Follow this device", icon: Monitor },
  { id: "light", label: "Light", sub: "Bright workspace", icon: Sun },
  { id: "dark", label: "Dark", sub: "Low-light workspace", icon: Moon },
] as const;

const SHELL_STYLES = [
  {
    id: "scout",
    label: "Scout",
    sub: "Control-room navigation",
  },
  {
    id: "slack",
    label: "Slack",
    sub: "Workspace rail and channel-style lists",
  },
] as const satisfies readonly {
  id: ScoutShellStyle;
  label: string;
  sub: string;
}[];

const THEME_PALETTES = [
  { id: "scout", label: "Scout", sub: "Near-neutral control room", spec: "SLATE · LIME" },
  { id: "graphite", label: "Graphite", sub: "Monochrome technical chassis", spec: "BLACK · SLATE" },
  { id: "polar", label: "Polar", sub: "Nord-inspired arctic slate", spec: "POLAR · FROST" },
  { id: "solar", label: "Solar", sub: "Solarized-inspired measured contrast", spec: "TEAL · PAPER" },
] as const satisfies readonly {
  id: ScoutThemePalette;
  label: string;
  sub: string;
  spec: string;
}[];

const INTERFACE_STYLES = [
  { id: "hudson", label: "Rounded", sub: "Soft corners and luminous chrome", spec: "8PX" },
  { id: "editorial", label: "Compact", sub: "Tighter corners and flatter hierarchy", spec: "4PX" },
  { id: "drafting", label: "Square", sub: "Zero-radius technical grid", spec: "0PX" },
] as const satisfies readonly {
  id: ScoutThemeTemplate;
  label: string;
  sub: string;
  spec: string;
}[];

const CONTRAST_LEVELS = [
  { id: "soft", label: "Soft", sub: "Quiet separators" },
  { id: "balanced", label: "Defined", sub: "Clear structure" },
  { id: "strong", label: "Strong", sub: "High separation" },
] as const satisfies readonly {
  id: ScoutThemeContrast;
  label: string;
  sub: string;
}[];

const ACCENT_OPTIONS = [
  { id: "theme", label: "Theme" },
  { id: "lime", label: "Lime" },
  { id: "cyan", label: "Cyan" },
  { id: "violet", label: "Violet" },
  { id: "amber", label: "Amber" },
] as const satisfies readonly { id: ScoutThemeAccent; label: string }[];

const AVATAR_STYLES = [
  {
    id: "crew",
    label: "Crew Cast",
    sub: "Rendered character art with 4-slot status ring & eye animation",
    spec: "4-SLOT CAST",
  },
  {
    id: "sprite",
    label: "Generative",
    sub: "Deterministic 7×7 creatures from name hashes",
    spec: "PRNG VECTOR",
  },
  {
    id: "chip",
    label: "Pixel Chip",
    sub: "Pixel portraits of the chip cast; everyone else stays generative",
    spec: "PIXEL ART",
  },
] as const satisfies readonly {
  id: ScoutAvatarStyle;
  label: string;
  sub: string;
  spec: string;
}[];

const AVAILABLE_AVATAR_STYLES = CREW_ASSETS_AVAILABLE
  ? AVATAR_STYLES
  : AVATAR_STYLES.filter((option) => option.id === "sprite");

/**
 * Avatar size is a DENSITY choice, so the copy names what you get more of —
 * rows on screen, or a face you can read without leaning in — rather than a
 * measurement. The px are shown too, but read off the ladder in AgentAvatar
 * rather than restated here, so the label and the drawing cannot drift apart.
 */
const AVATAR_SIZES = [
  { id: "compact", label: "Compact", sub: "More rows per screen; the name carries" },
  { id: "regular", label: "Regular", sub: "Scout's default balance" },
  { id: "large", label: "Large", sub: "Faces legible at a glance" },
] as const satisfies readonly {
  id: ScoutAvatarSize;
  label: string;
  sub: string;
}[];

/** Three faces, not one: the tier that reads well for a pale member can still
 *  lose a dark one, and the point of previewing at true size is to catch that
 *  before committing. Members with chip art so the row is honest under every
 *  renderer. */
const AVATAR_SIZE_SPECIMENS = ["milo", "vex", "sprout"] as const;

function AppearanceFrame({
  className,
  theme,
  template,
  palette,
  contrast,
  accent,
  children,
}: {
  className: string;
  theme: "light" | "dark";
  template: ScoutThemeTemplate;
  palette: ScoutThemePalette;
  contrast: ScoutThemeContrast;
  accent: ScoutThemeAccent;
  children: React.ReactNode;
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

function PaletteSample({
  palette,
  theme,
  template,
}: {
  palette: ScoutThemePalette;
  theme: "light" | "dark";
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

function LiveAppearancePreview({
  theme,
  template,
  palette,
  contrast,
  accent,
}: {
  theme: "light" | "dark";
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

function AppearanceSection() {
  const appearance = useOptionalTheme();
  const { appearanceDetails, updateAppearanceDetails } = useScout();
  if (!appearance) {
    return <div className="s-settings-inline-note">Theme controls are unavailable in this embedded surface.</div>;
  }

  const resolvedTheme = appearance.resolvedTheme ?? "dark";
  const activeTemplate = normalizeScoutThemeTemplate(appearance.template) ?? "hudson";
  const paletteLabel = THEME_PALETTES.find((option) => option.id === appearanceDetails.palette)?.label ?? "Scout";
  const styleLabel = INTERFACE_STYLES.find((option) => option.id === activeTemplate)?.label ?? "Rounded";
  const contrastLabel = CONTRAST_LEVELS.find((option) => option.id === appearanceDetails.contrast)?.label ?? "Defined";
  const accentLabel = ACCENT_OPTIONS.find((option) => option.id === appearanceDetails.accent)?.label ?? "Theme";
  const avatarStyleLabel = AVAILABLE_AVATAR_STYLES.find((option) => option.id === appearanceDetails.avatarStyle)?.label ?? "Generative";
  const avatarSizeLabel = AVATAR_SIZES.find((option) => option.id === appearanceDetails.avatarSize)?.label ?? "Regular";

  return (
    <div className="s-settings-col-gap">
      <SectionRule
        label="App layout"
        right={`currently ${appearanceDetails.shell}`}
      />
      <div className="s-settings-shell-grid" role="group" aria-label="App layout">
        {SHELL_STYLES.map((option) => {
          const active = appearanceDetails.shell === option.id;
          return (
            <button
              key={option.id}
              type="button"
              className="s-settings-shell-choice"
              data-shell={option.id}
              data-active={active || undefined}
              aria-pressed={active}
              onClick={() => updateAppearanceDetails({ shell: option.id })}
            >
              <span className="s-settings-shell-sample" aria-hidden="true">
                <i data-part="top" />
                <i data-part="rail" />
                <i data-part="list"><b /><b /><b /></i>
                <i data-part="content"><b /><b /><b /></i>
              </span>
              <span className="s-settings-choice-copy">
                <span className="s-settings-choice-title">
                  <strong>{option.label}</strong>
                  {active ? <Check className="s-settings-theme-check" size={15} aria-hidden /> : null}
                </span>
                <small>{option.sub}</small>
              </span>
            </button>
          );
        })}
      </div>

      <SectionRule label="Color mode" right={`currently ${resolvedTheme}`} />
      <div className="s-settings-theme-mode-grid" role="group" aria-label="Color mode">
        {THEME_MODES.map((option) => {
          const Icon = option.icon;
          const active = appearance.theme === option.id;
          const sub = option.id === "system"
            ? `Follow this device · resolves to ${appearance.resolvedTheme ?? "…"}`
            : option.sub;
          return (
            <button
              key={option.id}
              type="button"
              className="s-settings-theme-mode"
              data-active={active || undefined}
              aria-pressed={active}
              onClick={() => appearance.setTheme(option.id)}
            >
              <Icon size={18} strokeWidth={1.7} aria-hidden />
              <span>
                <strong>{option.label}</strong>
                <small>{sub}</small>
              </span>
              {active ? <Check className="s-settings-theme-check" size={15} aria-hidden /> : null}
            </button>
          );
        })}
      </div>

      <div className="s-settings-appearance-workbench">
        <div className="s-settings-appearance-controls">
          <SectionRule label="Color theme" right={`currently ${paletteLabel.toLowerCase()}`} />
          <div className="s-settings-palette-grid" role="group" aria-label="Color theme">
            {THEME_PALETTES.map((option) => {
              const active = appearanceDetails.palette === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  className="s-settings-palette-choice"
                  data-active={active || undefined}
                  aria-pressed={active}
                  onClick={() => updateAppearanceDetails({ palette: option.id })}
                >
                  <PaletteSample palette={option.id} theme={resolvedTheme} template={activeTemplate} />
                  <span className="s-settings-choice-copy">
                    <span className="s-settings-choice-title">
                      <strong>{option.label}</strong>
                      {active ? <Check className="s-settings-theme-check" size={15} aria-hidden /> : null}
                    </span>
                    <small>{option.sub}</small>
                    <span>{option.spec}</span>
                  </span>
                </button>
              );
            })}
          </div>

          <SectionRule label="Interface shape" right={`currently ${styleLabel.toLowerCase()}`} />
          <div className="s-settings-interface-grid" role="group" aria-label="Interface shape">
            {INTERFACE_STYLES.map((option) => {
              const active = activeTemplate === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  className="s-settings-interface-choice"
                  data-active={active || undefined}
                  aria-pressed={active}
                  onClick={() => appearance.setTemplate(option.id)}
                >
                  <AppearanceFrame
                    className="s-settings-shape-sample"
                    theme={resolvedTheme}
                    template={option.id}
                    palette={appearanceDetails.palette}
                    contrast={appearanceDetails.contrast}
                    accent={appearanceDetails.accent}
                  >
                    <i><i /></i>
                  </AppearanceFrame>
                  <span className="s-settings-choice-copy">
                    <span className="s-settings-choice-title">
                      <strong>{option.label}</strong>
                      {active ? <Check className="s-settings-theme-check" size={14} aria-hidden /> : null}
                    </span>
                    <small>{option.sub}</small>
                    <span>{option.spec}</span>
                  </span>
                </button>
              );
            })}
          </div>

          <SectionRule label="Separation" right={`currently ${contrastLabel.toLowerCase()}`} />
          <div className="s-settings-contrast-grid" role="group" aria-label="Interface contrast">
            {CONTRAST_LEVELS.map((option) => {
              const active = appearanceDetails.contrast === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  className="s-settings-contrast-choice"
                  data-active={active || undefined}
                  aria-pressed={active}
                  onClick={() => updateAppearanceDetails({ contrast: option.id })}
                >
                  <span className="s-settings-contrast-lines" data-level={option.id} aria-hidden><i /><i /><i /></span>
                  <strong>{option.label}</strong>
                  <small>{option.sub}</small>
                </button>
              );
            })}
          </div>

          <SectionRule label="Signal accent" right={`currently ${accentLabel.toLowerCase()}`} />
          <div className="s-settings-accent-row" role="group" aria-label="Signal accent">
            {ACCENT_OPTIONS.map((option) => {
              const active = appearanceDetails.accent === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  className="s-settings-accent-choice"
                  data-accent-option={option.id}
                  data-active={active || undefined}
                  aria-pressed={active}
                  aria-label={`${option.label} accent`}
                  onClick={() => updateAppearanceDetails({ accent: option.id })}
                >
                  <AppearanceFrame
                    className="s-settings-accent-dot"
                    theme={resolvedTheme}
                    template={activeTemplate}
                    palette={appearanceDetails.palette}
                    contrast={appearanceDetails.contrast}
                    accent={option.id}
                  >
                    <i />
                  </AppearanceFrame>
                  <span>{option.label}</span>
                  {active ? <Check size={13} aria-hidden /> : null}
                </button>
              );
            })}
          </div>

          <SectionRule label="Avatar system" right={`currently ${avatarStyleLabel.toLowerCase()}`} />
          <div className="s-settings-avatar-grid" role="group" aria-label="Avatar system">
            {AVAILABLE_AVATAR_STYLES.map((option) => {
              const active = appearanceDetails.avatarStyle === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  className="s-settings-palette-choice s-settings-avatar-choice"
                  data-active={active || undefined}
                  aria-pressed={active}
                  onClick={() => updateAppearanceDetails({ avatarStyle: option.id })}
                >
                  {/* ONE specimen. This used to draw the covered member and the
                      generative fallback overlapped, to show coverage — but two
                      unrelated creatures half on top of each other read as a
                      layout fault, not as a claim, and the coverage is already
                      stated in words a line below ("5 of 7 cast", "everyone else
                      stays generative"). A picture that has to be explained is
                      losing to the sentence that explains it. */}
                  <div className="s-settings-avatar-preview">
                    {option.id === "crew" ? (
                      <CrewAvatar slug="milo" size={38} ring={false} badge={false} />
                    ) : option.id === "chip" ? (
                      <CrewAvatar slug="milo" size={38} chip ring={false} badge={false} />
                    ) : (
                      <SpriteAvatar name="Milo" size={38} />
                    )}
                  </div>
                  <span className="s-settings-choice-copy">
                    <span className="s-settings-choice-title">
                      <strong>{option.label}</strong>
                      {active ? <Check className="s-settings-theme-check" size={14} aria-hidden /> : null}
                    </span>
                    <small>{option.sub}</small>
                    <span>
                      {option.spec}
                      {(() => {
                        const c = rendererCoverage(option.id);
                        return c ? ` · ${c.covered} of ${c.total} cast` : " · every agent";
                      })()}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          <SectionRule label="Avatar size" right={`currently ${avatarSizeLabel.toLowerCase()}`} />
          <div className="s-settings-avatar-size-row" role="group" aria-label="Avatar size">
            {AVATAR_SIZES.map((option) => {
              const active = appearanceDetails.avatarSize === option.id;
              /* Previewed at the size it actually draws, in the placement this
                 setting is felt in most — the list row. A swatch scaled to fit
                 the card would be a picture of the choice rather than the
                 choice itself, and the whole question here is "can I read that
                 face at that size". */
              const px = placementSize("row", option.id) ?? 24;
              return (
                <button
                  key={option.id}
                  type="button"
                  className="s-settings-avatar-size-choice"
                  data-active={active || undefined}
                  aria-pressed={active}
                  onClick={() => updateAppearanceDetails({ avatarSize: option.id })}
                >
                  <span className="s-settings-avatar-size-sample" aria-hidden>
                    {AVATAR_SIZE_SPECIMENS.map((slug) => (
                      !CREW_ASSETS_AVAILABLE || appearanceDetails.avatarStyle === "sprite"
                        ? <SpriteAvatar key={slug} name={slug} size={px} />
                        : (
                          <CrewAvatar
                            key={slug}
                            slug={slug}
                            size={px}
                            chip={appearanceDetails.avatarStyle === "chip"}
                            ring={false}
                            badge={false}
                          />
                        )
                    ))}
                  </span>
                  <span className="s-settings-choice-title">
                    <strong>{option.label}</strong>
                    {active ? <Check className="s-settings-theme-check" size={14} aria-hidden /> : null}
                  </span>
                  <small>{option.sub}</small>
                  <span className="s-settings-avatar-size-spec">
                    {`${px}PX ROW · ${placementSize("inspector", option.id)}PX TILE`}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="s-settings-appearance-note">
            <strong>Saved on this device</strong>
            <span>Layout, mode, palette, shape, separation, and accent stay in sync across tabs. URL overrides remain available for embeds and visual QA.</span>
          </div>
        </div>

        <aside className="s-settings-preview-column" aria-label="Live appearance preview">
          <SectionRule label="Live specimen" right={resolvedTheme} />
          <LiveAppearancePreview
            theme={resolvedTheme}
            template={activeTemplate}
            palette={appearanceDetails.palette}
            contrast={appearanceDetails.contrast}
            accent={appearanceDetails.accent}
          />
          <dl className="s-settings-theme-readout">
            <div><dt>Palette</dt><dd>{paletteLabel}</dd></div>
            <div><dt>Shape</dt><dd>{styleLabel}</dd></div>
            <div><dt>Separation</dt><dd>{contrastLabel}</dd></div>
            <div><dt>Accent</dt><dd>{accentLabel}</dd></div>
          </dl>
          <p className="s-settings-preview-note">Each control changes one visual axis. Success, warning, and failure colors keep their meaning.</p>
        </aside>
      </div>
    </div>
  );
}

// ── Operator section ──────────────────────────────────────────────────

function OperatorSection({
  profile, update,
}: {
  profile: OperatorProfile;
  update: (patch: Partial<OperatorProfile>) => void;
}) {
  const { appearanceDetails, updateAppearanceDetails } = useScout();
  const [selectedMascot, setSelectedMascot] = useState(
    appearanceDetails.operatorCharacter || "milo",
  );
  const activeMascot = selectedMascot;
  const [breakoutOpen, setBreakoutOpen] = useState(true);

  const activeMember = CREW_ASSETS_AVAILABLE
    ? (CAST_MEMBERS.find((m) => m.slug.toLowerCase() === activeMascot.toLowerCase()) ?? CAST_MEMBERS[0])
    : {
        slug: "sprite",
        name: profile.name || "Operator",
        kernel: "name·hue·deterministic",
        title: "Generative Identity",
        blurb: "Built locally from your display name and identity hue, without external artwork.",
      };

  const handleSelectMascot = (slug: string) => {
    setSelectedMascot(slug);
    updateAppearanceDetails({ operatorCharacter: slug });
  };

  return (
    <div className="s-settings-col-gap">
      <SectionRule
        label={CREW_ASSETS_AVAILABLE ? "Operator Character Stage" : "Operator Identity"}
        right={CREW_ASSETS_AVAILABLE ? "cast mascot & identity" : "generative avatar"}
      />

      <div
        className="s-settings-stage-hero-card"
        data-open={CREW_ASSETS_AVAILABLE && breakoutOpen ? "true" : "false"}
      >
        <div className="s-settings-stage-hero-header">
          <div className="s-settings-stage-hero-badge">
            <span className="s-settings-stage-live-dot" />
            <span className="s-settings-stage-badge-text">
              {breakoutOpen ? "FULL FIGURE BREAKOUT" : "COIN DISC FRAMING"}
            </span>
          </div>

          {CREW_ASSETS_AVAILABLE ? (
            <button
              type="button"
              className="s-settings-stage-toggle-btn"
              onClick={() => setBreakoutOpen((v) => !v)}
              title={breakoutOpen ? "Collapse to coin framing" : "Break out to full body figure"}
            >
              {breakoutOpen ? (
                <>
                  <Minimize2 size={13} aria-hidden />
                  <span>Coin Framing</span>
                </>
              ) : (
                <>
                  <Sparkles size={13} aria-hidden />
                  <span>Breakout Figure</span>
                </>
              )}
            </button>
          ) : null}
        </div>

        <div className="s-settings-stage-hero-body">
          <div className="s-settings-stage-art-col">
            {CREW_ASSETS_AVAILABLE ? (
              // Character (cast PNG) and background (disc) are decoupled —
              // the disc falls back to a neutral band based on art.ink,
              // not the operator's identity hue. profile.hue still tints
              // the SpriteAvatar fallback below.
              <CrewStage
                slug={activeMascot}
                open={breakoutOpen}
                onToggle={() => setBreakoutOpen((v) => !v)}
                coin={64}
                figure={256}
                state="working"
              />
            ) : (
              <SpriteAvatar name={profile.name || "Operator"} size={96} hue={profile.hue} />
            )}
            <span className="s-settings-stage-click-hint">
              {CREW_ASSETS_AVAILABLE
                ? (breakoutOpen ? "Click avatar to collapse" : "Click avatar to break out")
                : "Deterministic identity · no external artwork"}
            </span>
          </div>

          <div className="s-settings-stage-meta-col">
            <div className="s-settings-stage-title-row">
              <span className="s-settings-stage-char-name">{activeMember.name}</span>
              <span className="s-settings-stage-char-title">{activeMember.title}</span>
            </div>

            <div className="s-settings-stage-kernel-pill">
              <code>{activeMember.kernel}</code>
            </div>

            <p className="s-settings-stage-blurb">{activeMember.blurb}</p>

            <div className="s-settings-stage-identity-group">
              <div className="s-settings-stage-operator-id">
                <strong>{profile.name || "Operator"}</strong>
                <span>{profile.handle || "@you"} · {profile.pronouns || "—"}</span>
              </div>

              <div className="s-settings-hue-wrap">
                <span className="s-settings-field-label">Stage & Identity Hue</span>
                <div className="s-settings-hue-row">
                  {HUE_PRESETS.map((h) => (
                    <button
                      key={h}
                      type="button"
                      onClick={() => update({ hue: h })}
                      className={`s-settings-hue-dot${profile.hue === h ? " s-settings-hue-dot--active" : ""}`}
                      style={{ background: hueColor(h) }}
                      title={`Hue ${h}°`}
                    />
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {CREW_ASSETS_AVAILABLE ? (
        <>
          <SectionRule label="Your character mascot" right={`currently ${activeMember.name.toLowerCase()}`} />
          <div className="s-settings-cast-grid-wrap">
            <CastPicker
              selectedSlug={activeMascot}
              onSelect={handleSelectMascot}
            />
          </div>
        </>
      ) : null}

      <Field label="Display name" hint="Shown when agents address you.">
        <TextInput value={profile.name} onChange={(v) => update({ name: v })} />
      </Field>
      <Field label="Handle" hint="Used in @mentions across threads.">
        <TextInput value={profile.handle} onChange={(v) => update({ handle: v })} mono />
      </Field>
      <Field label="Pronouns">
        <TextInput value={profile.pronouns} onChange={(v) => update({ pronouns: v })} />
      </Field>

      <SectionRule label="How agents understand you" right="shipped as system prompt context" />
      <Field label="Operator bio" hint="How you want to be worked with. Agents read this before asking you things.">
        <TextArea value={profile.bio} onChange={(v) => update({ bio: v })} rows={4} />
      </Field>

      <div className="s-settings-two-col">
        <Field label="Timezone">
          <TextInput value={profile.timezone} onChange={(v) => update({ timezone: v })} mono />
        </Field>
        <Field label="Working hours">
          <TextInput value={profile.workingHours} onChange={(v) => update({ workingHours: v })} mono />
        </Field>
      </div>

      <SectionRule label="Ephemeral agent names" right="rotation pool for one-off agents" />
      <Field
        label="Name pool"
        hint={
          profile.provisionalAgentNames.length > 0
            ? `${profile.provisionalAgentNamesResolvedCount} names active (${profile.provisionalAgentNamesSource}). Preview: ${profile.provisionalAgentNamesPreview.join(", ")}${profile.provisionalAgentNamesResolvedCount > profile.provisionalAgentNamesPreview.length ? ", …" : ""}`
            : "Leave empty to use Scout's built-in rotation. One short name per line."
        }
      >
        <TextArea
          value={profile.provisionalAgentNames.join("\n")}
          onChange={(v) => update({
            provisionalAgentNames: v
              .split(/\r?\n/u)
              .map((line) => line.trim())
              .filter(Boolean),
          })}
          rows={6}
        />
      </Field>
      <Field
        label="Pool mode"
        hint="Replace uses only your list. Add to defaults prepends yours, then Scout's built-in names."
      >
        <OptionRow<ProvisionalAgentNamesMode>
          value={profile.provisionalAgentNamesMode}
          onChange={(v) => update({ provisionalAgentNamesMode: v })}
          options={[
            { id: "replace", label: "Replace", sub: "your list only" },
            { id: "extend", label: "Add to defaults", sub: "yours first, then Scout" },
          ]}
          columns={2}
        />
      </Field>
    </div>
  );
}

// ── Communication section ─────────────────────────────────────────────

function CommsSection({
  profile, update,
}: {
  profile: OperatorProfile;
  update: (patch: Partial<OperatorProfile>) => void;
}) {
  return (
    <div className="s-settings-col-gap">
      <SectionRule label="Interrupt policy" />
      <Field label="When agents can ping you directly"
        hint="Blocking-only means only asks that truly stall work. Others get batched.">
        <OptionRow<InterruptThreshold>
          value={profile.interruptThreshold}
          onChange={(v) => update({ interruptThreshold: v })}
          options={[
            { id: "always", label: "Always", sub: "any ask, any time" },
            { id: "blocking-only", label: "Blocking only", sub: "stuck agents · default" },
            { id: "batched", label: "Batched", sub: "grouped every 15m" },
            { id: "never", label: "Never", sub: "queue only, I'll check in" },
          ]}
        />
      </Field>

      <div className="s-settings-two-col">
        <Field label="Batch window (min)">
          <SliderInput value={profile.batchWindow} min={5} max={60} step={5}
            onChange={(v) => update({ batchWindow: v })} unit="min" />
        </Field>
        <Field label="Quiet hours">
          <TextInput value={profile.quietHours} onChange={(v) => update({ quietHours: v })} mono />
        </Field>
      </div>

      <SectionRule label="Where to reach you" />
      <Field label="Preferred channel">
        <OptionRow<CommsChannel>
          value={profile.channel}
          onChange={(v) => update({ channel: v })}
          options={[
            { id: "here", label: "Here only", sub: "desktop app" },
            { id: "mobile", label: "Mobile only", sub: "paired phone" },
            { id: "here+mobile", label: "Both", sub: "whichever is active" },
          ]}
        />
      </Field>

      <SectionRule label="Tone calibration" right="how agents write to you" />
      <div className="s-settings-two-col">
        <Field label="Verbosity">
          <OptionRow<CommsVerbosity>
            stacked
            value={profile.verbosity}
            onChange={(v) => update({ verbosity: v })}
            options={[
              { id: "terse", label: "Terse", sub: "one-liners, answers only" },
              { id: "normal", label: "Normal", sub: "context + answer" },
              { id: "detailed", label: "Detailed", sub: "show reasoning" },
            ]}
          />
        </Field>
        <Field label="Tone">
          <OptionRow<CommsTone>
            stacked
            value={profile.tone}
            onChange={(v) => update({ tone: v })}
            options={[
              { id: "direct", label: "Direct", sub: "no hedging" },
              { id: "warm", label: "Warm", sub: "friendly, conversational" },
              { id: "formal", label: "Formal", sub: "business-like" },
            ]}
          />
        </Field>
      </div>
    </div>
  );
}

// ── Credentials section ───────────────────────────────────────────────

function CredentialsSection({
  clientCredentials,
  serverCredentials,
  reloadCredentials,
}: {
  clientCredentials: ClientCredentialState | null;
  serverCredentials: ServerCredentialState | null;
  reloadCredentials: () => Promise<void>;
}) {
  const [openAIKeyDraft, setOpenAIKeyDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const serverOpenAI = serverCredentials?.openai ?? null;
  const configured = Boolean(serverOpenAI?.configured);
  const serverSource = serverOpenAI?.source === "env"
    ? "OPENAI_API_KEY"
    : serverOpenAI?.source === "local-config"
      ? "local Scout config"
      : serverOpenAI?.source === "local-store"
        ? "local OpenScout store"
        : "missing";
  const source = serverOpenAI?.source === "local-store" && clientCredentials?.configured
    ? "local OpenScout store + HudVault mirror"
    : serverSource;
  const preview = serverOpenAI?.preview ?? clientCredentials?.preview ?? null;

  const saveOpenAIKey = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const apiKey = openAIKeyDraft.trim();
      await saveOpenAIKeyToServer(apiKey);
      let hudVaultError: string | null = null;
      try {
        await setOpenAIApiKey(apiKey);
      } catch (error) {
        hudVaultError = error instanceof Error ? error.message : "HudVault save failed.";
      }
      setOpenAIKeyDraft("");
      await reloadCredentials();
      setStatus(hudVaultError
        ? `Saved to local OpenScout store. Browser mirror failed: ${hudVaultError}`
        : "Saved to local OpenScout store and Hudson Vault.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save key.");
    } finally {
      setSaving(false);
    }
  };

  const clearOpenAIKey = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const [clientResult, serverResult] = await Promise.allSettled([
        deleteOpenAIApiKey(),
        deleteOpenAIKeyFromServer(),
      ]);
      setOpenAIKeyDraft("");
      await reloadCredentials();
      if (clientResult.status === "rejected" || serverResult.status === "rejected") {
        setStatus("Cleared what I could; one credential store did not respond.");
      } else {
        setStatus(serverOpenAI?.source === "env" || serverOpenAI?.source === "local-config"
        ? "Removed saved key. Server fallback is still configured."
        : "Removed saved key.");
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not clear key.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="s-settings-col-gap">
      <SectionRule label="Model providers" right={configured ? `configured · ${source}` : "missing"} />

      <div className="s-settings-relay-card">
        <div>
          <div className="s-settings-relay-title">
            OpenAI · <span className="s-settings-device-status" style={{ color: configured ? "var(--green)" : "var(--dim)" }}>
              {"●"} {configured ? "ready" : "missing"}
            </span>
          </div>
          <div className="s-settings-relay-meta">
            {preview ?? "No key stored"} · {source}
          </div>
          <div className="s-settings-relay-desc">
            Scout stores user-entered keys in the local OpenScout credential store and keeps a HudVault mirror for this browser profile.
          </div>
        </div>
      </div>

      <Field label="OpenAI API key" hint="Saved locally. Existing keys are never shown again.">
        <input
          className="s-settings-input s-settings-input--mono"
          type="password"
          value={openAIKeyDraft}
          placeholder={configured ? "Saved key configured" : "sk-..."}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setOpenAIKeyDraft(event.target.value)}
        />
      </Field>

      {status && <div className="s-settings-field-hint">{status}</div>}

      <div className="s-settings-button-row">
        <button
          type="button"
          className="s-btn"
          disabled={saving || !openAIKeyDraft.trim()}
          onClick={() => void saveOpenAIKey()}
        >
          {saving ? "Saving" : "Save key"}
        </button>
        <button
          type="button"
          className="s-btn"
          disabled={saving || !(clientCredentials?.configured || serverOpenAI?.source === "local-store")}
          onClick={() => void clearOpenAIKey()}
        >
          Clear saved key
        </button>
      </div>
    </div>
  );
}

// ── Voice section ─────────────────────────────────────────────────────

const VOICE_ENGINE_OPTIONS: { id: ScoutVoicePreference; label: string; sub: string }[] = [
  { id: "auto", label: "Auto", sub: "Parakeet when warm, Apple fallback" },
  { id: "parakeet", label: "Parakeet", sub: "on-device, best quality" },
  { id: "apple", label: "Apple Speech", sub: "instant, no model warmup" },
];

function VoiceSection() {
  const realtimeVoiceAvailable = useOptionalFlag(SCOUT_REALTIME_VOICE_FLAG, true);
  const [settings, setSettings] = useState<ScoutVoiceSettings | null>(null);
  const [realtimeSettings, setRealtimeSettings] = useState<Awaited<ReturnType<typeof fetchScoutRealtimeVoiceSettings>> | null>(null);
  const [devices, setDevices] = useState<ScoutVoiceInputDevice[]>([]);
  const [history, setHistory] = useState<ScoutVoiceSessionHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [realtimeSaving, setRealtimeSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [snapshot, sessions, realtime] = await Promise.all([
        fetchScoutVoiceSettings(),
        fetchScoutVoiceHistory(12).catch(() => []),
        // The host voice inventory remains useful when an older or restarting
        // web server has not mounted the realtime settings endpoint yet.
        fetchScoutRealtimeVoiceSettings().catch(() => null),
      ]);
      setSettings(snapshot.settings);
      setDevices(snapshot.devices);
      setHistory(sessions);
      setRealtimeSettings(realtime);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const apply = useCallback(async (
    patch: Partial<Pick<ScoutVoiceSettings, "preference" | "inputDeviceId">>,
  ) => {
    setSaving(true);
    setError(null);
    try {
      const snapshot = await saveScoutVoiceSettings(patch);
      setSettings(snapshot.settings);
      setDevices(snapshot.devices);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  }, []);

  const applyRealtimeEnabled = useCallback(async (enabled: boolean) => {
    setRealtimeSaving(true);
    setError(null);
    try {
      const snapshot = await saveScoutRealtimeVoiceSettings(enabled);
      setRealtimeSettings(snapshot);
      publishScoutRealtimeVoiceSettings(snapshot);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setRealtimeSaving(false);
    }
  }, []);

  if (loading && !settings) {
    return <div className="s-settings-field-hint">Loading voice settings…</div>;
  }

  const selectedDeviceId = settings?.inputDeviceId
    ?? devices.find((device) => device.isDefault)?.id
    ?? "";
  const micPermission = settings?.permissions?.find((entry) => entry.kind === "microphone") ?? null;
  const speechPermission = settings?.permissions?.find((entry) => entry.kind === "speechRecognition") ?? null;
  const hostOnline = (settings?.permissions?.length ?? 0) > 0 || devices.length > 0;
  const realtimeEnabled = realtimeVoiceAvailable && realtimeSettings?.enabled === true;
  const realtimeToggleDisabled = realtimeSaving
    || !realtimeVoiceAvailable
    || !realtimeSettings
    || realtimeSettings.locked;
  const realtimeStatus = !realtimeVoiceAvailable
    ? "Unavailable in this build."
    : !realtimeSettings
      ? "Live voice settings are temporarily unavailable."
      : realtimeSettings.locked
        ? `Controlled by OPENSCOUT_REALTIME_VOICE_ENABLED · ${realtimeSettings.enabled ? "on" : "off"}`
        : realtimeEnabled
          ? "Ready. Use Voice in the footer to start a call."
          : "Off. No microphone or OpenAI connection runs in the background.";

  const troubleshootingTips = [
    !hostOnline
      ? "Scout voice host is offline. Launch Scout Menu on this Mac — the browser does not capture audio."
      : null,
    micPermission?.status === "denied" || micPermission?.status === "restricted"
      ? micPermission?.status === "restricted"
        ? "Microphone access is restricted on this Mac."
        : "Microphone access is off for Scout Menu. Choose Retry access to reopen the macOS permission pane."
      : micPermission?.canRequest
        ? "Microphone has not been requested yet. Request access or tap the mic in chat to show the macOS prompt."
        : null,
    !speechPermission?.granted && (speechPermission?.status === "denied" || speechPermission?.status === "restricted")
      ? speechPermission?.status === "restricted"
        ? "Speech recognition is restricted on this Mac."
        : "Speech recognition is off for Scout Menu. Open Privacy & Security → Speech Recognition to change it."
      : null,
    settings?.modelReady
      ? null
      : "Parakeet may download on first use. Apple Speech stays available while the model warms.",
    "Dictation requires Scout Menu running. The browser does not capture audio.",
    "If transcription hangs on Processing, wait up to 60 seconds or tap the mic again to cancel.",
  ].filter((tip): tip is string => Boolean(tip));

  return (
    <div className="s-settings-col-gap">
      {error && <div className="s-settings-field-hint" style={{ color: "var(--amber)" }}>{error}</div>}

      <SectionRule label="Realtime conversation" right="operator control" />
      <div
        className="s-settings-realtime-voice"
        data-enabled={realtimeEnabled || undefined}
        data-unavailable={!realtimeVoiceAvailable || undefined}
      >
        <span className="s-settings-realtime-voice-copy">
          <strong>Enable live voice on this Scout</strong>
          <span>
            Allows live conversations with Scoutbot. Microphone audio and OpenAI usage begin only when you explicitly start a call.
          </span>
          <em>{realtimeStatus}</em>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={realtimeEnabled}
          aria-label="Enable live voice on this Scout"
          disabled={realtimeToggleDisabled}
          data-checked={realtimeEnabled || undefined}
          className="s-settings-switch"
          onClick={() => void applyRealtimeEnabled(!realtimeEnabled)}
        >
          <span className="s-settings-switch-thumb" aria-hidden="true" />
          <span className="sr-only">{realtimeEnabled ? "On" : "Off"}</span>
        </button>
      </div>

      <VoiceHostStatusBanner
        hostOnline={hostOnline}
        micPermission={micPermission}
        speechPermission={speechPermission}
        modelReady={settings?.modelReady}
      />

      <SectionRule label="Scout Menu permissions" right="voice host" />
      <VoicePermissionsPanel
        permissions={settings?.permissions}
        hostOnline={hostOnline}
        disabled={saving || loading}
        onError={(message) => setError(message)}
        onRefresh={load}
      />

      <SectionRule label="Transcription" />
      <Field
        label="Engine"
        hint={
          settings?.modelReady
            ? "Parakeet is warm and ready."
            : settings?.modelInstalled
              ? "Parakeet is installed; first dictation may warm the model."
              : "Parakeet downloads on first use. Apple Speech stays available meanwhile."
        }
      >
        <OptionRow<ScoutVoicePreference>
          value={settings?.preference ?? "auto"}
          onChange={(preference) => {
            setSettings((prev) => (prev ? { ...prev, preference } : prev));
            void apply({ preference });
          }}
          options={VOICE_ENGINE_OPTIONS}
          columns={3}
        />
      </Field>

      <Field
        label="Microphone input"
        hint="Scout Menu uses the macOS system default input unless you pick a device here. The browser never captures audio."
      >
        {devices.length > 0 ? (
          <select
            className="s-settings-input"
            value={selectedDeviceId}
            disabled={saving}
            onChange={(event) => {
              const inputDeviceId = event.target.value || null;
              setSettings((prev) => (
                prev
                  ? {
                      ...prev,
                      inputDeviceId,
                      inputDeviceName: devices.find((device) => device.id === inputDeviceId)?.name ?? null,
                    }
                  : prev
              ));
              void apply({ inputDeviceId });
            }}
          >
            {devices.map((device) => (
              <option key={device.id} value={device.id}>
                {device.name}{device.isDefault ? " (system default)" : ""}
              </option>
            ))}
          </select>
        ) : (
          <div className="s-settings-field-hint">
            Scout Menu is not reporting microphones. Launch Scout Menu, grant mic access, then refresh.
          </div>
        )}
      </Field>

      <SectionRule label="Diagnostics" />
      <ul className="s-settings-field-hint" style={{ margin: 0, paddingLeft: "1.1rem", display: "grid", gap: "0.35rem" }}>
        {troubleshootingTips.map((tip) => (
          <li key={tip}>{tip}</li>
        ))}
      </ul>

      <SectionRule label="Recent sessions" right={history.length ? `${history.length} shown` : "none"} />
      {history.length === 0 ? (
        <div className="s-settings-field-hint">
          No recent dictation sessions on this web server. History fills as you use the mic in chat.
        </div>
      ) : (
        <div className="s-settings-col-gap" style={{ gap: "0.35rem" }}>
          {history.map((session) => (
            <div key={session.sessionId} className="s-settings-device-row" style={{ alignItems: "flex-start" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="s-settings-device-name" style={{ fontFamily: "var(--mono)" }}>
                  {session.status}
                  {" · "}
                  {session.lastEvent ?? "started"}
                </div>
                <div className="s-settings-device-meta">
                  {session.surface}
                  {" · "}
                  {timeAgo(session.updatedAt)}
                  {session.error ? ` · ${session.error}` : ""}
                </div>
                {session.lastTranscript ? (
                  <div className="s-settings-field-hint" style={{ marginTop: "0.2rem" }}>
                    {session.lastTranscript.length > 96
                      ? `${session.lastTranscript.slice(0, 96)}…`
                      : session.lastTranscript}
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="s-settings-button-row">
        <button type="button" className="s-btn" disabled={loading || saving} onClick={() => void load()}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
    </div>
  );
}

// ── Devices section ───────────────────────────────────────────────────

type PeerDevice = {
  id: string;
  name: string;
  kind: "desktop" | "mobile" | "tablet";
  status: "this-device" | "online" | "offline";
  relay: string;
  lastSeen: string;
};

const DEVICE_GLYPHS: Record<string, string> = { desktop: "◻", mobile: "▯", tablet: "▭" };

function DeviceRow({ device }: { device: PeerDevice }) {
  const statusColor = device.status === "this-device" ? "var(--accent)"
    : device.status === "online" ? "var(--green)"
    : "var(--dim)";
  return (
    <div className="s-settings-device-row">
      <span className="s-settings-device-icon">{DEVICE_GLYPHS[device.kind] ?? "□"}</span>
      <div>
        <div className="s-settings-device-name">{device.name}</div>
        <div className="s-settings-device-meta">
          {device.kind} · via {device.relay} · {device.lastSeen}
        </div>
      </div>
      <span className="s-settings-device-status" style={{ color: statusColor }}>
        {"●"} {device.status === "this-device" ? "this device" : device.status}
      </span>
      <button className="s-btn" disabled={device.status === "this-device"}>
        {device.status === "this-device" ? "—" : "Unpair"}
      </button>
    </div>
  );
}

function DevicesSection({ pairing }: { pairing: PairingState | null }) {
  const devices: PeerDevice[] = [
    { id: "local", name: "This machine", kind: "desktop", status: "this-device", relay: "local", lastSeen: "now" },
  ];
  if (pairing?.trustedPeers) {
    for (const peer of pairing.trustedPeers) {
      const isConnected = peer.fingerprint === pairing.connectedPeerFingerprint;
      devices.push({
        id: peer.fingerprint,
        name: peer.name ?? "Paired device",
        kind: "mobile",
        status: isConnected ? "online" : "offline",
        relay: "tailscale",
        lastSeen: peer.lastSeenLabel ?? "—",
      });
    }
  }

  return (
    <div className="s-settings-col-gap">
      <SectionRule label={`Paired devices · ${devices.length}`} />

      <div className="s-settings-col-gap" style={{ gap: 10 }}>
        {devices.map((d) => <DeviceRow key={d.id} device={d} />)}
      </div>

      <SectionRule label="Relay" />
      <div className="s-settings-relay-card">
        <div>
          <div className="s-settings-relay-title">
            Relay · <span className="s-settings-device-status" style={{ color: pairing?.isRunning ? "var(--green)" : "var(--dim)" }}>
              {"●"} {pairing?.isRunning ? "connected" : "offline"}
            </span>
          </div>
          <div className="s-settings-relay-meta">
            {pairing?.relay ?? "not configured"} · tailscale
          </div>
          <div className="s-settings-relay-desc">
            Agents route through your relay to reach mobile when the app is backgrounded.
            End-to-end encrypted; keys never leave your devices.
          </div>
        </div>
        <button className="s-btn">Configure</button>
      </div>
    </div>
  );
}

// THESIS: About is a diagnostic ledger, not a marketing card or a decorative version badge.
// OWN-WORLD: It inherits the Lit Control Room: flat bands, hairlines, machine labels, one lime signal.
// STORY: The operator distinguishes release identity from checkout identity, then copies one truthful report.
// FIRST VIEWPORT: Product version leads; source, broker, host, and browser facts follow in scan-order.
// FORM: A compact settings extension with one summary band and grouped key/value rows.
type WebBuildInfo = {
  version: string | null;
  branch: string | null;
  commit: string | null;
  dirty: boolean | null;
  mode: "dev" | "production";
  server?: {
    engine: "bun" | "node";
    engineVersion: string;
    nodeVersion: string;
    platform: string;
    arch: string;
  };
};

type AboutSnapshot = {
  build: WebBuildInfo | null;
  mesh: MeshStatus | null;
  collectedAt: Date;
  buildCollectedAt: Date | null;
  meshCollectedAt: Date | null;
};

function sourceIdentity(
  branch: string | null | undefined,
  commit: string | null | undefined,
  dirty = false,
): string {
  if (!branch && !commit) return "Not reported";
  const branchLabel = branch || "detached";
  return commit ? `${branchLabel} @ ${commit}${dirty ? " (modified)" : ""}` : branchLabel;
}

function browserPlatformLabel(): string {
  const navigatorWithUserAgentData = navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  return navigatorWithUserAgentData.userAgentData?.platform || navigator.platform || "Unknown";
}

function AboutFact({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="s-settings-about-fact">
      <dt>{label}</dt>
      <dd>
        <code>{value}</code>
        {detail ? <span>{detail}</span> : null}
      </dd>
    </div>
  );
}

function troubleshootingReport(snapshot: AboutSnapshot): string {
  const { build, mesh } = snapshot;
  const brokerBuild = mesh?.health.build ?? null;
  const localHost = mesh?.localNode ? mesh.nodes[mesh.localNode.id]?.host : undefined;
  const browserPlatform = browserPlatformLabel();
  return [
    "OpenScout troubleshooting report",
    `Collected: ${snapshot.collectedAt.toISOString()}`,
    "",
    `[Web]`,
    `Observed: ${snapshot.buildCollectedAt?.toISOString() ?? "unknown"}`,
    `Version: ${build?.version ?? "unknown"}`,
    `Mode: ${build?.mode ?? "unknown"}`,
    `Source: ${sourceIdentity(build?.branch, build?.commit, build?.dirty === true)}`,
    `Server: ${build?.server ? `${build.server.engine} ${build.server.engineVersion}` : "unknown"}`,
    `Server platform: ${build?.server ? `${build.server.platform}/${build.server.arch}` : "unknown"}`,
    "",
    `[Broker]`,
    `Observed: ${snapshot.meshCollectedAt?.toISOString() ?? "unknown"}`,
    `Reachable: ${mesh?.health.reachable === undefined ? "unknown" : mesh.health.reachable ? "yes" : "no"}`,
    `Healthy: ${mesh?.health.ok === undefined ? "unknown" : mesh.health.ok ? "yes" : "no"}`,
    `Error: ${mesh?.health.error ?? "none reported"}`,
    `Package: ${brokerBuild?.packageName ?? "unknown"}`,
    `Version: ${brokerBuild?.version ?? "unknown"}`,
    `Mode: ${brokerBuild?.mode ?? "unknown"}`,
    `Source: ${sourceIdentity(brokerBuild?.branch, brokerBuild?.commit)}`,
    `Build: ${brokerBuild?.buildNumber ?? brokerBuild?.buildId ?? "not reported"}`,
    `Node: ${mesh?.health.nodeId ?? "unknown"}`,
    `Broker URL: ${mesh?.brokerUrl ?? "unknown"}`,
    "",
    `[Host]`,
    `Name: ${mesh?.localNode?.name ?? "unknown"}`,
    `Scout version: ${localHost?.scoutVersion ?? "not reported"}`,
    `System: ${localHost?.os ?? "unknown"}`,
    `Architecture: ${localHost?.arch ?? build?.server?.arch ?? "unknown"}`,
    "",
    `[Browser]`,
    `Platform: ${browserPlatform}`,
    `User agent: ${navigator.userAgent}`,
    `Origin: ${window.location.origin}`,
  ].join("\n");
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Clipboard access is unavailable");
}

function AboutSection() {
  const [snapshot, setSnapshot] = useState<AboutSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");

  const load = useCallback(async (forceRefresh = false) => {
    setLoading(true);
    setError(null);
    setCopyState("idle");
    const [buildResult, meshResult] = await Promise.allSettled([
      api<WebBuildInfo>(forceRefresh ? "/api/build?refresh=1" : "/api/build"),
      api<MeshStatus>("/api/mesh"),
    ]);
    const collectedAt = new Date();
    setSnapshot((previous) => ({
      build: buildResult.status === "fulfilled" ? buildResult.value : previous?.build ?? null,
      mesh: meshResult.status === "fulfilled" ? meshResult.value : previous?.mesh ?? null,
      collectedAt,
      buildCollectedAt: buildResult.status === "fulfilled" ? collectedAt : previous?.buildCollectedAt ?? null,
      meshCollectedAt: meshResult.status === "fulfilled" ? collectedAt : previous?.meshCollectedAt ?? null,
    }));
    if (buildResult.status === "rejected" || meshResult.status === "rejected") {
      const missing = [
        buildResult.status === "rejected" ? "web build" : null,
        meshResult.status === "rejected" ? "broker" : null,
      ].filter(Boolean).join(" and ");
      setError(`Could not refresh ${missing} details. Last reported values are kept when available.`);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const build = snapshot?.build ?? null;
  const mesh = snapshot?.mesh ?? null;
  const brokerBuild = mesh?.health.build ?? null;
  const localHost = mesh?.localNode ? mesh.nodes[mesh.localNode.id]?.host : undefined;
  const browserPlatform = browserPlatformLabel();
  const brokerStatus = mesh === null
    ? "not reported"
    : !mesh.health.reachable
      ? "unreachable"
      : mesh.health.ok
        ? "healthy"
        : "degraded";

  const copyReport = useCallback(() => {
    if (!snapshot) return;
    void copyText(troubleshootingReport(snapshot))
      .then(() => {
        setCopyState("copied");
        setTimeout(() => setCopyState("idle"), 1800);
      })
      .catch(() => {
        setCopyState("error");
      });
  }, [snapshot]);

  if (loading && !snapshot) {
    return <div className="s-settings-loading">Collecting version details…</div>;
  }

  return (
    <div className="s-settings-about">
      <div className="s-settings-about-summary">
        <div>
          <span className="s-settings-about-product">OpenScout Web</span>
          <strong>{build?.version ? `v${build.version}` : "Version unavailable"}</strong>
          <span className="s-settings-about-source">
            {build?.mode ?? "unknown mode"} · {sourceIdentity(build?.branch, build?.commit, build?.dirty === true)}
          </span>
          <span className="s-settings-about-collected">
            Snapshot collected {snapshot?.collectedAt.toLocaleString() ?? "—"}
          </span>
        </div>
        <div className="s-settings-about-actions">
          <button type="button" className="s-btn" onClick={() => void load(true)} disabled={loading}>
            <RefreshCw size={13} aria-hidden />
            {loading ? "Refreshing…" : "Refresh"}
          </button>
          <button type="button" className="s-btn s-settings-about-copy" onClick={copyReport} disabled={!snapshot}>
            {copyState === "copied" ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
            {copyState === "copied" ? "Copied report" : copyState === "error" ? "Copy failed" : "Copy report"}
          </button>
        </div>
      </div>

      {error ? <div className="s-settings-about-warning" role="status">{error}</div> : null}
      {copyState === "error" && snapshot ? (
        <div className="s-settings-about-copy-fallback" role="alert">
          <strong>Clipboard access was denied.</strong>
          <span>Select and copy the report below.</span>
          <textarea readOnly value={troubleshootingReport(snapshot)} aria-label="OpenScout troubleshooting report" />
        </div>
      ) : null}

      <SectionRule label="Web application" right="release and source identity" />
      <dl className="s-settings-about-ledger">
        <AboutFact
          label="Package version"
          value={build?.version ?? "Unknown"}
          detail={`Observed ${snapshot?.buildCollectedAt?.toLocaleString() ?? "at an unknown time"}. Use this when comparing releases.`}
        />
        <AboutFact label="Run mode" value={build?.mode ?? "Unknown"} />
        <AboutFact
          label="Source checkout"
          value={sourceIdentity(build?.branch, build?.commit, build?.dirty === true)}
          detail="A dev SHA identifies the running checkout; it is not the release version."
        />
        <AboutFact
          label="Server engine"
          value={build?.server ? `${build.server.engine} ${build.server.engineVersion}` : "Not reported"}
          detail={build?.server ? `Node compatibility ${build.server.nodeVersion} · ${build.server.platform}/${build.server.arch}` : undefined}
        />
      </dl>

      <SectionRule label="Broker" right={brokerStatus} />
      <dl className="s-settings-about-ledger">
        <AboutFact
          label="Status"
          value={brokerStatus}
          detail={[
            `Observed ${snapshot?.meshCollectedAt?.toLocaleString() ?? "at an unknown time"}.`,
            mesh?.health.error,
          ].filter(Boolean).join(" ")}
        />
        <AboutFact label="Package" value={brokerBuild?.packageName ?? "Not reported"} />
        <AboutFact label="Version" value={brokerBuild?.version ?? "Not reported"} />
        <AboutFact label="Source" value={sourceIdentity(brokerBuild?.branch, brokerBuild?.commit)} />
        <AboutFact label="Build" value={brokerBuild?.buildNumber ?? brokerBuild?.buildId ?? "Not reported"} />
        <AboutFact label="Node" value={mesh?.health.nodeId ?? "Not reported"} detail={mesh?.brokerUrl} />
      </dl>

      <SectionRule label="Host and browser" right="troubleshooting context" />
      <dl className="s-settings-about-ledger">
        <AboutFact label="Host" value={mesh?.localNode?.name ?? "Not reported"} />
        <AboutFact label="Host Scout" value={localHost?.scoutVersion ?? "Not reported"} />
        <AboutFact
          label="Host system"
          value={[localHost?.os, localHost?.arch ?? build?.server?.arch].filter(Boolean).join(" · ") || "Not reported"}
        />
        <AboutFact label="Browser platform" value={browserPlatform} />
        <AboutFact label="Browser" value={navigator.userAgent} />
        <AboutFact label="Page origin" value={window.location.origin} />
      </dl>

      <p className="s-settings-about-note">
        Native app and CLI versions are shown only when those components report them. Scout does not infer a version from a nearby checkout.
      </p>
    </div>
  );
}

// ── Main drawer ───────────────────────────────────────────────────────

const SECTIONS: { id: Section; label: string; sub: string }[] = [
  { id: "appearance", label: "Appearance", sub: "mode · workspace style" },
  { id: "operator", label: "Operator", sub: "identity · bio · hours" },
  { id: "comms", label: "Communication", sub: "how agents reach you" },
  { id: "voice", label: "Voice", sub: "realtime · permissions · dictation" },
  { id: "credentials", label: "Credentials", sub: "model provider keys" },
  { id: "devices", label: "Paired devices", sub: "relay · connected" },
  { id: "about", label: "About", sub: "versions · build · runtime" },
];

const SECTION_TITLES: Record<Section, string> = {
  appearance: "Appearance",
  operator: "Operator identity",
  comms: "Communication",
  voice: "Voice",
  credentials: "Credentials",
  devices: "Paired devices",
  about: "About OpenScout",
};

const SECTION_DESCRIPTIONS: Record<Section, string> = {
  appearance: "Choose how Scout looks on this device. Changes apply immediately across the workspace.",
  operator: "Your identity, availability, and the context agents receive when they work with you.",
  comms: "Set interruption rules, delivery channels, response style, and quiet hours.",
  voice: "Configure dictation, realtime voice, permissions, and input devices.",
  credentials: "Manage model-provider credentials stored by this Scout installation.",
  devices: "Review the relay and devices currently connected to this Scout workspace.",
  about: "Exact release, source, broker, host, and browser details for troubleshooting.",
};

const DEFAULT_PROFILE: OperatorProfile = {
  name: "",
  handle: "",
  pronouns: "",
  hue: 195,
  bio: "",
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  workingHours: "08:00 – 18:00",
  interruptThreshold: "blocking-only",
  batchWindow: 15,
  channel: "here+mobile",
  verbosity: "terse",
  tone: "direct",
  quietHours: "22:00 – 07:00",
  provisionalAgentNames: [],
  provisionalAgentNamesMode: "replace",
  provisionalAgentNamesResolvedCount: 0,
  provisionalAgentNamesPreview: [],
  provisionalAgentNamesSource: "default",
};

function SettingsExperience({
  open,
  onClose,
  section: controlledSection,
  onSectionChange,
  presentation,
}: {
  open: boolean;
  onClose: () => void;
  /** When set, the rail is controlled by the URL (SCO-082 Phase B). */
  section?: Section;
  onSectionChange?: (section: Section) => void;
  presentation: "drawer" | "page";
}) {
  const { refreshOnboarding } = useScout();
  const { ref: drawerRef, onKeyDown: onDrawerKeyDown } = useFocusTrap<HTMLDivElement>(open && presentation === "drawer");
  const [uncontrolledSection, setUncontrolledSection] = useState<Section>("appearance");
  const section = controlledSection ?? uncontrolledSection;
  const setSection = useCallback((next: Section) => {
    if (onSectionChange) onSectionChange(next);
    else setUncontrolledSection(next);
  }, [onSectionChange]);
  const [profile, setProfile] = useState<OperatorProfile>(DEFAULT_PROFILE);
  const [pairing, setPairing] = useState<PairingState | null>(null);
  const [clientCredentials, setClientCredentials] = useState<ClientCredentialState | null>(null);
  const [serverCredentials, setServerCredentials] = useState<ServerCredentialState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">("saved");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const activeSectionRef = useRef<HTMLElement | null>(null);

  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  const loadCredentials = useCallback(async () => {
    const [client, server] = await Promise.allSettled([
      getClientCredentialState(),
      getServerCredentialState(),
    ]);
    const clientValue = client.status === "fulfilled" ? client.value : null;
    let serverValue = server.status === "fulfilled" ? server.value : null;
    if (clientValue?.configured && !serverValue?.openai.configured) {
      serverValue = await ensureOpenAIKeyOnServer().catch(() => serverValue);
    }
    setClientCredentials(clientValue);
    setServerCredentials(serverValue);
  }, []);

  const load = useCallback(async () => {
    try {
      const userPromise = api<OperatorProfile>("/api/user");
      const pairPromise = Promise.race([
        api<PairingState>("/api/pairing-state"),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
      ]);
      const [user, pair] = await Promise.allSettled([userPromise, pairPromise]);
      if (user.status === "fulfilled") setProfile(user.value);
      if (pair.status === "fulfilled") setPairing(pair.value);
      await loadCredentials();
    } finally {
      setLoaded(true);
    }
  }, [loadCredentials]);

  useEffect(() => {
    if (open && section !== "appearance" && section !== "about" && !loaded) void load();
  }, [loaded, open, load, section]);

  useEffect(() => {
    if (!open || !window.matchMedia("(max-width: 760px)").matches) return;
    const frame = window.requestAnimationFrame(() => {
      activeSectionRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, section]);

  const cycleSection = useCallback((delta: number) => {
    const index = SECTIONS.findIndex((entry) => entry.id === section);
    const next = (index + delta + SECTIONS.length) % SECTIONS.length;
    setSection(SECTIONS[next]!.id);
  }, [section]);

  const handleDrawerKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    onDrawerKeyDown(event);
    if (presentation === "drawer" && event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    const target = event.target as HTMLElement | null;
    const onRail = Boolean(target?.closest(".s-settings-rail"));
    if (!onRail) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      cycleSection(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      cycleSection(-1);
    }
  }, [cycleSection, onClose, onDrawerKeyDown, presentation]);

  const save = useCallback((next: OperatorProfile) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaveState("saving");
    saveTimer.current = setTimeout(() => {
      void api<OperatorProfile>("/api/user", {
        method: "POST",
        body: JSON.stringify(next),
      })
        .then(() => refreshOnboarding())
        .then(() => {
          if (mountedRef.current) setSaveState("saved");
        })
        .catch(() => {
          if (mountedRef.current) setSaveState("error");
        });
    }, 400);
  }, [refreshOnboarding]);

  const update = useCallback((patch: Partial<OperatorProfile>) => {
    setProfile((prev) => {
      const next = { ...prev, ...patch };
      save(next);
      return next;
    });
  }, [save]);

  const sectionNav = (
    <nav className="s-settings-rail" aria-label="Settings pages">
      {SECTIONS.map((s) => {
        const content = (
          <>
            <span className="s-settings-rail-label">{s.label}</span>
            <span className="s-settings-rail-sub">{s.sub}</span>
          </>
        );
        const className = `s-settings-rail-btn${section === s.id ? " s-settings-rail-btn--active" : ""}`;
        if (presentation === "page") {
          return (
            <a
              key={s.id}
              ref={section === s.id ? (node) => { activeSectionRef.current = node; } : undefined}
              href={routePath({ view: "settings", section: s.id })}
              aria-current={section === s.id ? "page" : undefined}
              className={className}
              onClick={(event) => {
                if (
                  event.button !== 0
                  || event.metaKey
                  || event.ctrlKey
                  || event.shiftKey
                  || event.altKey
                ) return;
                event.preventDefault();
                setSection(s.id);
              }}
            >
              {content}
            </a>
          );
        }
        return (
          <button key={s.id}
            ref={section === s.id ? (node) => { activeSectionRef.current = node; } : undefined}
            onClick={() => setSection(s.id)}
            aria-current={section === s.id ? "page" : undefined}
            className={className}>
            {content}
          </button>
        );
      })}
    </nav>
  );

  const sectionContent = (
    <main
      className="s-settings-content"
      id={`settings-${section}`}
      data-settings-section={section}
      tabIndex={-1}
    >
      {section === "appearance" ? (
        <AppearanceSection />
      ) : section === "about" ? (
        <AboutSection />
      ) : !loaded ? (
        <div className="s-settings-loading">Loading settings…</div>
      ) : (
        <>
          {section === "operator" && <OperatorSection profile={profile} update={update} />}
          {section === "comms" && <CommsSection profile={profile} update={update} />}
          {section === "credentials" && (
            <CredentialsSection
              clientCredentials={clientCredentials}
              serverCredentials={serverCredentials}
              reloadCredentials={loadCredentials}
            />
          )}
          {section === "voice" && <VoiceSection />}
          {section === "devices" && <DevicesSection pairing={pairing} />}
        </>
      )}
    </main>
  );

  if (presentation === "page") {
    return (
      <section className="s-settings-page" aria-labelledby="settings-page-title">
        <header className="s-settings-page-header">
          <div>
            <div className="s-settings-page-kicker">Settings</div>
            <h1 id="settings-page-title">{SECTION_TITLES[section]}</h1>
            <p>{SECTION_DESCRIPTIONS[section]}</p>
          </div>
          {section === "about" ? (
            <div className="s-settings-page-save-state" data-state="neutral">
              <span aria-hidden="true" />
              Diagnostic snapshot
            </div>
          ) : (
            <div className="s-settings-page-save-state" data-state={saveState} role="status" aria-live="polite">
              <span aria-hidden="true" />
              {saveState === "saving"
                ? "Saving changes…"
                : saveState === "error"
                  ? "Couldn’t save changes"
                  : "Saved automatically"}
            </div>
          )}
        </header>
        <div className="s-settings-page-layout">
          {sectionNav}
          {sectionContent}
        </div>
      </section>
    );
  }

  return (
    <>
      <div
        className={`s-settings-scrim ${open ? "s-settings-scrim--open" : "s-settings-scrim--closed"}`}
        onClick={onClose}
      />
      <div
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className={`s-settings-drawer ${open ? "s-settings-drawer--open" : "s-settings-drawer--closed"}`}
        onKeyDown={handleDrawerKeyDown}
      >
        {/* Header */}
        <div className="s-settings-header">
          <div className="s-settings-header-title">{"⚙"} SETTINGS</div>
          <span className="s-settings-header-sep">/</span>
          <span className="s-settings-header-section">{SECTION_TITLES[section]}</span>
          <span style={{ flex: 1 }} />
          <span className="s-settings-header-hint">ESC to close</span>
          <button className="s-settings-close" onClick={onClose}>{"×"}</button>
        </div>

        {sectionNav}
        {sectionContent}

        {/* Footer */}
        <div className="s-settings-footer">
          <span className="s-settings-footer-sync">{"●"} synced</span>
          <span>{"·"}</span>
          <span>changes apply instantly to every agent in your fleet</span>
          <span style={{ flex: 1 }} />
          <button className="s-btn" onClick={onClose}>Done</button>
        </div>
      </div>
    </>
  );
}

export function SettingsDrawer(props: {
  open: boolean;
  onClose: () => void;
  section?: Section;
  onSectionChange?: (section: Section) => void;
}) {
  return <SettingsExperience {...props} presentation="drawer" />;
}

export function SettingsPage({
  section = "appearance",
  onSectionChange,
}: {
  section?: Section;
  onSectionChange: (section: Section) => void;
}) {
  return (
    <SettingsExperience
      open
      onClose={() => {}}
      section={section}
      onSectionChange={onSectionChange}
      presentation="page"
    />
  );
}
