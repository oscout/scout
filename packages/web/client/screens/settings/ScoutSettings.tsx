/**
 * Scout Settings — take A · Quiet.
 *
 * One page for three places: the web app (/settings/:section), the Scout app's
 * embedded stage (/embed/settings), and the menu's Settings window, which
 * opens the same embed in a WKWebView. The web owns the whole UI. What only
 * the Mac knows or can do (window material, terminals, notifications, Sparkle
 * updates, OS panes) comes through `host-settings-bridge.ts`; those groups
 * carry a THIS MAC tag and are left out when the page runs in a plain browser.
 *
 * Grammar: each page says in one line what it is for, then groups hairline
 * cards of rows. A row is a title, one sentence, and a control on the right.
 * Every choice is a select. States are small mono caps with a dot.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useOptionalFlag } from "hudsonkit/flags";
import { useOptionalTheme } from "hudsonkit/theme";
import {
  Activity,
  ArrowUpCircle,
  Check,
  Info,
  KeyRound,
  MessageSquare,
  Mic,
  Network,
  PackageCheck,
  Palette,
  Smartphone,
  SquareTerminal,
  UserRound,
  type LucideIcon,
} from "lucide-react";
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
import {
  hostSettings,
  hostSettingsAvailable,
  onHostSettings,
  type HostOpenTarget,
  type HostOption,
  type HostPermissionKind,
  type HostPermissionState,
  type HostSettingKey,
  type HostSettingsSnapshot,
} from "../../lib/host-settings-bridge.ts";
import { canNavigateBrowserBack, navigateBrowserBack, routePath } from "../../lib/router.ts";

import {
  fetchScoutVoiceHistory,
  fetchScoutVoiceSettings,
  openScoutVoicePrivacySettings,
  requestScoutVoicePermissions,
  saveScoutVoiceSettings,
  type ScoutVoiceInputDevice,
  type ScoutVoicePermissionStatus,
  type ScoutVoicePreference,
  type ScoutVoiceSessionHistoryEntry,
  type ScoutVoiceSettings,
} from "../../lib/scout-voice.ts";
import {
  fetchScoutRealtimeVoiceSettings,
  publishScoutRealtimeVoiceSettings,
  saveScoutRealtimeVoiceSettings,
} from "../../lib/realtime-voice-settings.ts";
import {
  fetchScoutVoicePlaybackSettings,
  publishScoutVoicePlaybackSettings,
  saveScoutVoicePlaybackSettings,
} from "../../lib/voice-playback-settings.ts";
import {
  normalizeScoutThemeTemplate,
  type ScoutAvatarSize,
  type ScoutAvatarStyle,
  type ScoutShellStyle,
  type ScoutThemeAccent,
  type ScoutThemeContrast,
  type ScoutThemePalette,
  type ScoutThemeTemplate,
} from "../../lib/theme.ts";
import { timeAgo } from "../../lib/time.ts";
import type {
  MeshStatus,
  OperatorProfile,
  PairingState,
  Route,
  SettingsSection,
} from "../../lib/types.ts";
import { CREW_ASSETS_AVAILABLE, rendererCoverage } from "../../lib/crew-registry.ts";
import { placementSize } from "../../components/AgentAvatar.tsx";
import { CastPicker } from "../../components/CastPicker.tsx";
import { CrewAvatar } from "../../components/CrewAvatar.tsx";
import { SpriteAvatar } from "../../components/SpriteAvatar.tsx";
import { SCOUT_REALTIME_VOICE_FLAG } from "../../../shared/realtime-voice.ts";
import type { LocalHttpsState } from "../../../shared/api/local-https.ts";
import type { SoloProAction, SoloProComponent, SoloProPhase, SoloProStatus } from "@openscout/runtime/solo-pro";
import {
  SCOUT_VOICE_PLAYBACK_ENV,
  type ScoutVoicePlaybackSettings,
} from "../../../shared/voice-playback.ts";
import { useScout } from "../../scout/Provider.tsx";
import { OnboardingEmbedGate } from "../../scout/takeover/OnboardingEmbedGate.tsx";
import { defineSurface } from "../../surfaces/types.ts";
import { BASIC_WEB } from "../../basic/profile.ts";
import { AppearanceFrame, LiveAppearancePreview, PaletteSample, ShellSample } from "./AppearanceSamples.tsx";
// CastPicker is styled by the older settings sheet.
import "./settings-drawer.css";
import "./scout-settings.css";

/* ── pages ──────────────────────────────────────────────────────────────── */

export type ScoutSettingsSection = Extract<
  SettingsSection,
  "appearance" | "operator" | "comms" | "voice" | "terminal" | "credentials" | "assistants" | "devices" | "mesh" | "pro" | "system" | "about"
>;

type PageDef = {
  id: ScoutSettingsSection;
  title: string;
  promise: string;
  icon: LucideIcon;
  /** the page exists only when the Scout app hosts it */
  hostOnly?: boolean;
};

const PAGES: PageDef[] = [
  { id: "appearance", title: "Appearance", promise: "How Scout looks, here and in the browser.", icon: Palette },
  { id: "operator", title: "Operator", promise: "Who the agents are working for, and what they should know first.", icon: UserRound },
  { id: "comms", title: "Communication", promise: "When agents may interrupt you, where, and how they write.", icon: MessageSquare },
  { id: "voice", title: "Voice", promise: "Talk to Scout, and hear it answer.", icon: Mic },
  { id: "terminal", title: "Terminal", promise: "The terminals Scout draws, and the one it hands off to.", icon: SquareTerminal, hostOnly: true },
  { id: "credentials", title: "Keys", promise: "Keys Scout uses on your behalf. Saved on this Mac, never shown again.", icon: KeyRound },
  { id: "assistants", title: "Connected assistants", promise: "Review requests and manage assistants allowed into your Scout.", icon: UserRound, hostOnly: true },
  { id: "devices", title: "Devices", promise: "Phones and iPads that can reach this Scout.", icon: Smartphone },
  { id: "mesh", title: "Mesh", promise: "The other Scouts this Mac works with.", icon: Network },
  { id: "pro", title: "Solo Pro", promise: "Whether this account has it, what is installed here, and what is running.", icon: PackageCheck },
  { id: "system", title: "System", promise: "What is running, and what to do when it isn't.", icon: Activity },
  { id: "about", title: "About", promise: "Contact, support, and which Scout this is.", icon: Info },
];

export function isScoutSettingsSection(value: unknown): value is ScoutSettingsSection {
  return PAGES.some((page) => page.id === value);
}

/* ── primitives ─────────────────────────────────────────────────────────── */

type Opt = { value: string; label: string };

function Section({ label, note, mac, children }: { label: string; note?: ReactNode; mac?: boolean; children: ReactNode }) {
  return (
    <section>
      <h2 className="sq-label">
        {label}
        {mac ? <span className="sq-mac-tag">This Mac</span> : null}
      </h2>
      <div className="sq-card">{children}</div>
      {note ? <p className="sq-note">{note}</p> : null}
    </section>
  );
}

function Row({
  title,
  detail,
  children,
  dim,
  stack,
}: {
  title: ReactNode;
  detail?: ReactNode;
  children?: ReactNode;
  dim?: boolean;
  stack?: boolean;
}) {
  return (
    <div className="sq-row" data-dim={dim || undefined} data-stack={stack || undefined}>
      <div className="sq-row-text">
        <div className="sq-row-title">{title}</div>
        {detail ? <div className="sq-row-detail">{detail}</div> : null}
      </div>
      {children ? <div className="sq-row-control">{children}</div> : null}
    </div>
  );
}

function Fact({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="sq-fact">
      <span>{k}</span>
      <span className="sq-mono">{v}</span>
    </div>
  );
}

function Toggle({
  on,
  onChange,
  label,
  disabled,
}: {
  on: boolean;
  onChange: (value: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className="sq-toggle"
      disabled={disabled}
      onClick={() => onChange(!on)}
    >
      <span aria-hidden />
    </button>
  );
}

function Select({
  value,
  onChange,
  options,
  label,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  options: readonly Opt[];
  label: string;
  disabled?: boolean;
}) {
  return (
    <span className="sq-select-wrap">
      <select
        className="sq-select"
        value={value}
        aria-label={label}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <svg width="9" height="9" viewBox="0 0 9 9" aria-hidden>
        <path d="M1.5 3.2 4.5 6l3-2.8" fill="none" stroke="currentColor" strokeWidth="1.4" />
      </svg>
    </span>
  );
}

function Input({
  value,
  onChange,
  label,
  mono,
  narrow,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  mono?: boolean;
  narrow?: boolean;
  placeholder?: string;
}) {
  return (
    <input
      className={`sq-input${mono ? " sq-mono" : ""}`}
      data-narrow={narrow || undefined}
      aria-label={label}
      value={value}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function TextArea({
  value,
  onChange,
  label,
  rows = 3,
  mono,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  rows?: number;
  mono?: boolean;
}) {
  return (
    <textarea
      className={`sq-textarea${mono ? " sq-mono" : ""}`}
      aria-label={label}
      rows={rows}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function Range({
  value,
  onChange,
  min,
  max,
  step = 1,
  label,
  format,
  disabled,
}: {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  label: string;
  format: (value: number) => string;
  disabled?: boolean;
}) {
  return (
    <span className="sq-range">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <output>{format(value)}</output>
    </span>
  );
}

function Button({
  children,
  onClick,
  quiet,
  danger,
  primary,
  disabled,
}: {
  children: ReactNode;
  onClick?: () => void;
  quiet?: boolean;
  danger?: boolean;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="sq-button"
      data-quiet={quiet || undefined}
      data-danger={danger || undefined}
      data-primary={primary || undefined}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Status({ ok, bad, children }: { ok?: boolean; bad?: boolean; children: ReactNode }) {
  return (
    <span className="sq-status" data-ok={ok || undefined} data-bad={bad || undefined}>
      <span aria-hidden />
      {children}
    </span>
  );
}

function Note({ children, error }: { children: ReactNode; error?: boolean }) {
  return (
    <p className="sq-note" data-tone={error ? "error" : undefined} role={error ? "alert" : undefined}>
      {children}
    </p>
  );
}

/* Scout mark: ring + filled inner hex (assets/icons/app/scout-app-icon.svg, simplified). */
function ScoutMark() {
  return (
    <svg className="sq-mark" viewBox="0 0 24 24" aria-hidden>
      <path d="M12 2.5 20.2 7.25v9.5L12 21.5l-8.2-4.75v-9.5Z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M12 8.2 15.3 10.1v3.8L12 15.8l-3.3-1.9v-3.8Z" fill="currentColor" />
    </svg>
  );
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
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

function hostOptions(options: HostOption[] | undefined, value: string): Opt[] {
  const list = options ?? [];
  return list.some((option) => option.value === value) ? list : [{ value, label: value || "Automatic" }, ...list];
}

/* ── host ───────────────────────────────────────────────────────────────── */

type Host = {
  /** the Scout app hosts this page */
  available: boolean;
  snapshot: HostSettingsSnapshot | null;
  error: string | null;
  set: (key: HostSettingKey, value: string | number | boolean) => void;
  run: (action: () => Promise<HostSettingsSnapshot | null>) => Promise<void>;
  open: (target: HostOpenTarget) => void;
};

function useHost(): Host {
  const available = useMemo(() => hostSettingsAvailable(), []);
  const [snapshot, setSnapshot] = useState<HostSettingsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!available) return;
    let live = true;
    hostSettings.snapshot()
      .then((next) => { if (live) setSnapshot(next); })
      .catch((err) => { if (live) setError(errorText(err, "The Scout app did not answer.")); });
    const off = onHostSettings((next) => setSnapshot(next));
    return () => {
      live = false;
      off();
    };
  }, [available]);

  const run = useCallback(async (action: () => Promise<HostSettingsSnapshot | null>) => {
    setError(null);
    try {
      const next = await action();
      if (next) setSnapshot(next);
    } catch (err) {
      setError(errorText(err, "The Scout app could not do that."));
    }
  }, []);

  const set = useCallback((key: HostSettingKey, value: string | number | boolean) => {
    // Optimistic: the control moves now, the host's answer settles it.
    setSnapshot((prev) => (prev ? patchSnapshot(prev, key, value) : prev));
    void run(() => hostSettings.set(key, value));
  }, [run]);

  const open = useCallback((target: HostOpenTarget) => {
    void run(async () => {
      await hostSettings.open(target);
      return null;
    });
  }, [run]);

  return { available, snapshot, error, set, run, open };
}

function patchSnapshot(
  snapshot: HostSettingsSnapshot,
  key: HostSettingKey,
  value: string | number | boolean,
): HostSettingsSnapshot {
  const [group, field] = key.split(".") as [string, string];
  const current = (snapshot as Record<string, unknown>)[group];
  if (!current || typeof current !== "object") return snapshot;
  return { ...snapshot, [group]: { ...(current as Record<string, unknown>), [field]: value } };
}

/* ── profile (/api/user) ────────────────────────────────────────────────── */

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
  runtimeShortlistText: "",
  runtimePresetsText: "",
};

/** `/api/user` returns presets as objects; the page edits grammar lines. */
type OperatorUserResponse = OperatorProfile & {
  runtimeShortlist?: string[];
  runtimePresets?: Array<{ id: string; label?: string; runtime: string }>;
};

type SaveState = "saved" | "saving" | "error";

function useProfile() {
  const { refreshOnboarding } = useScout();
  const [profile, setProfile] = useState<OperatorProfile>(DEFAULT_PROFILE);
  const [loaded, setLoaded] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [saveError, setSaveError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    api<OperatorUserResponse>("/api/user")
      .then((user) => {
        if (!mounted.current) return;
        setProfile({
          ...user,
          runtimeShortlistText: (user.runtimeShortlist ?? []).join(", "),
          runtimePresetsText: (user.runtimePresets ?? [])
            .map((preset) => `${preset.id}${preset.label ? `:${preset.label}` : ""}=${preset.runtime}`)
            .join("\n"),
        });
      })
      .catch((err) => {
        if (mounted.current) setSaveError(errorText(err, "Could not load your profile."));
      })
      .finally(() => {
        if (mounted.current) setLoaded(true);
      });
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const save = useCallback((next: OperatorProfile) => {
    if (timer.current) clearTimeout(timer.current);
    setSaveState("saving");
    timer.current = setTimeout(() => {
      // The runtime lists travel as their API shapes so the server can
      // validate them and answer 400 with the reason.
      const { runtimeShortlistText, runtimePresetsText, ...rest } = next;
      void api<OperatorProfile>("/api/user", {
        method: "POST",
        body: JSON.stringify({
          ...rest,
          runtimeShortlist: runtimeShortlistText.split(",").map((entry) => entry.trim()).filter(Boolean),
          runtimePresets: runtimePresetsText.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean),
        }),
      })
        .then(() => refreshOnboarding())
        .then(() => {
          if (!mounted.current) return;
          setSaveState("saved");
          setSaveError(null);
        })
        .catch((err) => {
          if (!mounted.current) return;
          setSaveState("error");
          setSaveError(errorText(err, "Could not save."));
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

  return { profile, loaded, update, saveState, saveError };
}

type ProfileProps = ReturnType<typeof useProfile>;

/* ── Appearance ─────────────────────────────────────────────────────────── */

const MODE_OPTIONS = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const;

type OptionValue<T extends readonly Opt[]> = T[number]["value"];

/** A labelled visual choice: a specimen, a name, and one line of spec. */
type Tile<T extends string> = { value: T; label: string; spec?: string };

const PALETTE_TILES: Tile<ScoutThemePalette>[] = [
  { value: "graphite", label: "Graphite", spec: "Neutral graphite" },
  { value: "scout", label: "Scout", spec: "Slate control room" },
  { value: "polar", label: "Polar", spec: "Arctic slate" },
  { value: "solar", label: "Solar", spec: "Teal on paper" },
];
const ACCENT_TILES: Tile<ScoutThemeAccent>[] = [
  { value: "amber", label: "Amber" },
  { value: "theme", label: "Theme" },
  { value: "lime", label: "Lime" },
  { value: "cyan", label: "Cyan" },
  { value: "violet", label: "Violet" },
];
const CORNER_TILES: Tile<ScoutThemeTemplate>[] = [
  { value: "hudson", label: "Rounded", spec: "8px" },
  { value: "editorial", label: "Compact", spec: "4px" },
  { value: "drafting", label: "Square", spec: "0px" },
];
const CONTRAST_TILES: Tile<ScoutThemeContrast>[] = [
  { value: "soft", label: "Soft", spec: "Quiet" },
  { value: "balanced", label: "Defined", spec: "Clear" },
  { value: "strong", label: "Strong", spec: "Firm" },
];
const DENSITY_TILES: Tile<ScoutAvatarSize>[] = [
  { value: "compact", label: "Compact" },
  { value: "regular", label: "Regular" },
  { value: "large", label: "Large" },
];
/** Only the full app carries crew art; the basic build has the generative sprite alone. */
const AVATAR_TILES: Tile<ScoutAvatarStyle>[] = [
  { value: "crew", label: "Crew" },
  { value: "sprite", label: "Generative" },
  { value: "chip", label: "Pixel chip" },
];
const LAYOUT_TILES: Tile<ScoutShellStyle>[] = [
  { value: "scout", label: "Scout", spec: "Control-room rail" },
  { value: "slack", label: "Slack", spec: "Channels on the left" },
];
/** A pale, a dark and a mid member, so a size that loses one of them shows it. */
const DENSITY_SPECIMENS = ["milo", "vex", "sprout"] as const;

function Tiles<T extends string>({
  label,
  value,
  options,
  onChange,
  render,
  variant,
}: {
  label: string;
  value: T;
  options: readonly Tile<T>[];
  onChange: (value: T) => void;
  render: (option: Tile<T>) => ReactNode;
  variant?: "swatch";
}) {
  return (
    <div className="sq-tiles" role="group" aria-label={label} data-variant={variant} data-count={options.length} style={{ "--sq-tiles": options.length } as CSSProperties}>
      {options.map((option) => {
        const on = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            className="sq-tile"
            aria-pressed={on}
            onClick={() => onChange(option.value)}
          >
            <span className="sq-tile-art" aria-hidden="true">{render(option)}</span>
            <span className="sq-tile-name">
              {option.label}
              {on ? <Check size={13} strokeWidth={2.2} aria-hidden="true" /> : null}
            </span>
            {option.spec ? <span className="sq-tile-spec">{option.spec}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

function SpecimenFace({ slug, size, style }: { slug: string; size: number; style: ScoutAvatarStyle }) {
  return CREW_ASSETS_AVAILABLE && style !== "sprite"
    ? <CrewAvatar slug={slug} size={size} chip={style === "chip"} ring={false} badge={false} />
    : <SpriteAvatar name={slug} size={size} />;
}

function AppearancePage({ host }: { host: Host }) {
  const appearance = useOptionalTheme();
  const { appearanceDetails, updateAppearanceDetails } = useScout();
  const win = host.snapshot?.window ?? null;
  const theme = appearance?.resolvedTheme === "light" ? "light" : "dark";
  const template = normalizeScoutThemeTemplate(appearance?.template) ?? "hudson";
  const { palette, contrast, accent, avatarStyle, avatarSize, shell } = appearanceDetails;
  const frame = { theme, template, palette, contrast, accent } as const;
  const name = (tiles: readonly Tile<string>[], value: string) => tiles.find((tile) => tile.value === value)?.label ?? value;

  return (
    <>
      <section className="sq-specimen" aria-label="Preview">
        <LiveAppearancePreview {...frame} />
        <p className="sq-specimen-caption">
          <span>{name(PALETTE_TILES, palette)}</span>
          <span>{name(ACCENT_TILES, accent)} accent</span>
          <span>{name(CORNER_TILES, template)}</span>
          <span>{name(CONTRAST_TILES, contrast)} lines</span>
          <span>{theme}</span>
        </p>
      </section>

      <Section label="Color">
        {appearance ? (
          <Row title="Mode" detail={`System follows this device as it switches between day and night. Now ${theme}.`}>
            <Select
              label="Mode"
              value={appearance.theme ?? "system"}
              options={MODE_OPTIONS}
              onChange={(value) => appearance.setTheme(value as OptionValue<typeof MODE_OPTIONS>)}
            />
          </Row>
        ) : null}
        <Row title="Theme" detail="Graphite with a touch of amber is the default. Scout, Polar and Solar offer other palettes." stack>
          <Tiles
            label="Theme"
            value={palette}
            options={PALETTE_TILES}
            onChange={(next) => updateAppearanceDetails({ palette: next })}
            render={(option) => <PaletteSample palette={option.value} theme={theme} template={template} />}
          />
        </Row>
        <Row title="Accent" detail="The one color Scout spends on what is live." stack>
          <Tiles
            label="Accent"
            variant="swatch"
            value={accent}
            options={ACCENT_TILES}
            onChange={(next) => updateAppearanceDetails({ accent: next })}
            render={(option) => (
              <AppearanceFrame className="s-settings-accent-dot" {...frame} accent={option.value}><i /></AppearanceFrame>
            )}
          />
        </Row>
      </Section>

      <Section label="Shape">
        {appearance ? (
          <Row title="Corners" detail="How round panels, rows and buttons are." stack>
            <Tiles
              label="Corners"
              value={template}
              options={CORNER_TILES}
              onChange={(next) => appearance.setTemplate(next)}
              render={(option) => (
                <AppearanceFrame className="s-settings-shape-sample" {...frame} template={option.value}><i><i /></i></AppearanceFrame>
              )}
            />
          </Row>
        ) : null}
        <Row title="Separators" detail="How firmly lines divide one thing from the next." stack>
          <Tiles
            label="Separators"
            value={contrast}
            options={CONTRAST_TILES}
            onChange={(next) => updateAppearanceDetails({ contrast: next })}
            render={(option) => <span className="s-settings-contrast-lines" data-level={option.value}><i /><i /><i /></span>}
          />
        </Row>
        <Row title="Density" detail="Compact fits more rows. Large makes faces legible at a glance. Shown at list-row size." stack>
          <Tiles
            label="Density"
            value={avatarSize}
            options={DENSITY_TILES.map((tile) => ({ ...tile, spec: `${placementSize("row", tile.value) ?? 24}px row` }))}
            onChange={(next) => updateAppearanceDetails({ avatarSize: next })}
            render={(option) => (
              <span className="sq-faces">
                {DENSITY_SPECIMENS.map((slug) => (
                  <SpecimenFace key={slug} slug={slug} size={placementSize("row", option.value) ?? 24} style={avatarStyle} />
                ))}
              </span>
            )}
          />
        </Row>
      </Section>

      <Section label="Workspace" note="Changes apply as you make them and are saved automatically.">
        {CREW_ASSETS_AVAILABLE ? (
          <Row title="Avatars" detail="How agents are drawn: the crew cast, a generated sprite, or a pixel chip." stack>
            <Tiles
              label="Avatars"
              value={avatarStyle}
              options={AVATAR_TILES.map((tile) => {
                const coverage = rendererCoverage(tile.value);
                return { ...tile, spec: coverage ? `${coverage.covered} of ${coverage.total} cast` : "Every agent" };
              })}
              onChange={(next) => updateAppearanceDetails({ avatarStyle: next })}
              render={(option) => <SpecimenFace slug="milo" size={36} style={option.value} />}
            />
          </Row>
        ) : (
          <Row title="Avatars" detail="Every agent gets a generated sprite, drawn from its name.">
            <span className="sq-portrait"><SpriteAvatar name="milo" size={36} /></span>
          </Row>
        )}
        <Row title="Layout" detail="Slack puts channels on the left and threads beside the conversation." stack>
          <Tiles
            label="Layout"
            value={shell}
            options={LAYOUT_TILES}
            onChange={(next) => updateAppearanceDetails({ shell: next })}
            render={(option) => <span className="sq-shell" data-shell={option.value}><ShellSample /></span>}
          />
        </Row>
      </Section>

      {win ? (
        <Section
          label="Window"
          mac
          note={win.reduceTransparency
            ? "Reduce Transparency is on in System Settings, so materials stay solid whatever is set here."
            : "Reduce Transparency in System Settings keeps materials solid, whatever is set here."}
        >
          <Row title="Sidebar material" detail="What shows through the sidebar.">
            <Select
              label="Sidebar material"
              value={win.sidebarMaterial}
              options={hostOptions(win.sidebarMaterialOptions, win.sidebarMaterial)}
              onChange={(value) => host.set("window.sidebarMaterial", value)}
            />
          </Row>
          <Row title="Blur">
            <Select
              label="Blur"
              value={win.sidebarBlur}
              options={hostOptions(win.sidebarBlurOptions, win.sidebarBlur)}
              onChange={(value) => host.set("window.sidebarBlur", value)}
            />
          </Row>
          <Row title="Tint" detail="How much of the theme color washes the sidebar.">
            <Range
              label="Tint"
              value={Math.round(win.sidebarTint * 100)}
              min={0}
              max={100}
              format={(value) => `${value}%`}
              onChange={(value) => host.set("window.sidebarTint", value / 100)}
            />
          </Row>
          <Row title="Content opacity" detail="The page behind the sidebar, from sheer to solid.">
            <Range
              label="Content opacity"
              value={Math.round(win.contentOpacity * 100)}
              min={0}
              max={100}
              format={(value) => `${value}%`}
              onChange={(value) => host.set("window.contentOpacity", value / 100)}
            />
          </Row>
          <Row title="Hold the material when unfocused" detail="Otherwise macOS flattens it while another app is in front.">
            <Toggle
              label="Hold the material when unfocused"
              on={win.holdMaterialWhenUnfocused}
              onChange={(value) => host.set("window.holdMaterialWhenUnfocused", value)}
            />
          </Row>
          <Row title="Preview accents on hover" detail="Hovering an accent tries it on the window before you choose.">
            <Toggle
              label="Preview accents on hover"
              on={win.previewAccentsOnHover}
              onChange={(value) => host.set("window.previewAccentsOnHover", value)}
            />
          </Row>
          <Row title="Conversations" detail="How a thread opens in the app.">
            <Select
              label="Conversations"
              value={win.conversationPresentation}
              options={hostOptions(win.conversationPresentationOptions, win.conversationPresentation)}
              onChange={(value) => host.set("window.conversationPresentation", value)}
            />
          </Row>
        </Section>
      ) : null}
    </>
  );
}

/* ── Operator ───────────────────────────────────────────────────────────── */

const HUE_PRESETS = [195, 125, 300, 45, 355, 210];
const POOL_OPTIONS = [
  { value: "replace", label: "Only mine" },
  { value: "extend", label: "Mine, then Scout's" },
] as const;

function OperatorPage({ profile, update, saveError }: ProfileProps) {
  const { appearanceDetails, updateAppearanceDetails } = useScout();
  const poolDetail = profile.provisionalAgentNames.length > 0
    ? `${profile.provisionalAgentNamesResolvedCount} in rotation: ${profile.provisionalAgentNamesPreview.join(", ")}${profile.provisionalAgentNamesResolvedCount > profile.provisionalAgentNamesPreview.length ? ", …" : ""}`
    : "Names given to one-off agents, in rotation. One per line. Empty uses Scout's own.";

  return (
    <>
      <Section label="Identity">
        <Row title="Display name" detail="What agents call you.">
          <Input label="Display name" value={profile.name} onChange={(name) => update({ name })} />
        </Row>
        <Row title="Handle" detail="Used in @mentions across threads.">
          <Input label="Handle" value={profile.handle} onChange={(handle) => update({ handle })} mono />
        </Row>
        <Row title="Pronouns">
          <Input label="Pronouns" value={profile.pronouns} onChange={(pronouns) => update({ pronouns })} />
        </Row>
        <Row title="Color" detail="Your hue, on your avatar and wherever you are named.">
          <div className="sq-hues" role="radiogroup" aria-label="Color">
            {HUE_PRESETS.map((hue) => (
              <button
                key={hue}
                type="button"
                role="radio"
                aria-checked={profile.hue === hue}
                aria-label={`Hue ${hue}`}
                className="sq-hue"
                style={{ background: `oklch(0.80 0.14 ${hue})` }}
                onClick={() => update({ hue })}
              />
            ))}
          </div>
        </Row>
        {CREW_ASSETS_AVAILABLE ? (
          <Row title="Character" detail="The crew member who stands in for you." stack>
            <div className="sq-cast">
              <CastPicker
                selectedSlug={appearanceDetails.operatorCharacter || "milo"}
                onSelect={(slug) => updateAppearanceDetails({ operatorCharacter: slug })}
              />
            </div>
          </Row>
        ) : (
          <Row title="Character" detail="Drawn from your name and color. Change either and it redraws.">
            <span className="sq-portrait">
              <SpriteAvatar name={profile.name || "Operator"} size={40} hue={profile.hue} />
            </span>
          </Row>
        )}
      </Section>

      <Section label="What agents read first" note="Sent as context at the start of every conversation.">
        <Row title="About you" detail="How you like to be worked with. Agents read this before they ask you anything." stack>
          <TextArea label="About you" value={profile.bio} onChange={(bio) => update({ bio })} rows={3} />
        </Row>
        <Row title="Timezone">
          <Input label="Timezone" value={profile.timezone} onChange={(timezone) => update({ timezone })} mono />
        </Row>
        <Row title="Working hours" detail="Outside these, asks wait unless they block work.">
          <Input label="Working hours" value={profile.workingHours} onChange={(workingHours) => update({ workingHours })} mono narrow />
        </Row>
      </Section>

      <Section label="Agent names">
        <Row title="Name pool" detail={poolDetail} stack>
          <TextArea
            label="Name pool"
            rows={3}
            value={profile.provisionalAgentNames.join("\n")}
            onChange={(value) => update({
              provisionalAgentNames: value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean),
            })}
          />
        </Row>
        <Row title="Use" detail="Your list only, or yours first and then Scout's built-in names.">
          <Select
            label="Use"
            value={profile.provisionalAgentNamesMode}
            options={POOL_OPTIONS}
            onChange={(value) => update({ provisionalAgentNamesMode: value as OptionValue<typeof POOL_OPTIONS> })}
          />
        </Row>
      </Section>

      <section>
        <h2 className="sq-label">Models</h2>
        <div className="sq-card">
          <Row title="Shortlist" detail="Pinned first in every model picker, as harness/model, separated by commas." stack>
            <Input
              label="Shortlist"
              value={profile.runtimeShortlistText}
              onChange={(runtimeShortlistText) => update({ runtimeShortlistText })}
              placeholder="claude/opus-5-5, codex/gpt-5.6-sol"
              mono
            />
          </Row>
          <Row title="Presets" detail="One per line: id:Label=harness/model/effort." stack>
            <TextArea
              label="Presets"
              rows={3}
              mono
              value={profile.runtimePresetsText}
              onChange={(runtimePresetsText) => update({ runtimePresetsText })}
            />
          </Row>
        </div>
        {saveError ? <Note error>{saveError}</Note> : null}
      </section>
    </>
  );
}

/* ── Communication ──────────────────────────────────────────────────────── */

const PING_OPTIONS = [
  { value: "always", label: "Always" },
  { value: "blocking-only", label: "Blocking only" },
  { value: "batched", label: "Batched" },
  { value: "never", label: "Never" },
] as const;
const CHANNEL_OPTIONS = [
  { value: "here", label: "Here" },
  { value: "mobile", label: "Phone" },
  { value: "here+mobile", label: "Both" },
] as const;
const VERBOSITY_OPTIONS = [
  { value: "terse", label: "Terse" },
  { value: "normal", label: "Normal" },
  { value: "detailed", label: "Detailed" },
] as const;
const TONE_OPTIONS = [
  { value: "direct", label: "Direct" },
  { value: "warm", label: "Warm" },
  { value: "formal", label: "Formal" },
] as const;

function CommsPage({ profile, update, host }: ProfileProps & { host: Host }) {
  const attention = host.snapshot?.attention ?? null;
  const notifications = host.snapshot?.permissions.notifications ?? null;
  const spaces = host.snapshot?.spaces ?? null;
  return (
    <>
      <Section
        label="Interruptions"
        note="Blocking only means an agent has stopped and cannot go on without you. Everything else waits in your inbox."
      >
        <Row title="Agents may ping me" detail="Which asks reach you the moment they are made.">
          <Select
            label="Agents may ping me"
            value={profile.interruptThreshold}
            options={PING_OPTIONS}
            onChange={(value) => update({ interruptThreshold: value as OptionValue<typeof PING_OPTIONS> })}
          />
        </Row>
        <Row title="Batch every" detail="When batched, asks arrive together on this interval." dim={profile.interruptThreshold !== "batched"}>
          <Range
            label="Batch every"
            value={profile.batchWindow}
            min={5}
            max={60}
            step={5}
            format={(value) => `${value} min`}
            onChange={(batchWindow) => update({ batchWindow })}
          />
        </Row>
        <Row title="Quiet hours" detail="Nothing reaches you here or on your phone.">
          <Input label="Quiet hours" value={profile.quietHours} onChange={(quietHours) => update({ quietHours })} mono narrow />
        </Row>
      </Section>

      {attention ? (
        <Section label="Attention" mac>
          <Row title="Notify on agent requests" detail="A macOS notification for each ask that reaches you.">
            {notifications && notifications !== "granted" ? (
              <PermissionControl
                state={notifications}
                onAsk={() => void host.run(() => hostSettings.requestPermission("notifications"))}
                onOpen={() => host.open("notification-settings")}
              />
            ) : null}
            <Toggle
              label="Notify on agent requests"
              on={attention.notifyWhenNeeded}
              onChange={(value) => host.set("attention.notifyWhenNeeded", value)}
            />
          </Row>
          <Row title="Play a sound" dim={!attention.notifyWhenNeeded}>
            <Toggle
              label="Play a sound"
              on={attention.playSound}
              disabled={!attention.notifyWhenNeeded}
              onChange={(value) => host.set("attention.playSound", value)}
            />
          </Row>
          <Row title="Count on the Dock icon" detail="How many asks are open.">
            <Toggle
              label="Count on the Dock icon"
              on={attention.dockBadge}
              onChange={(value) => host.set("attention.dockBadge", value)}
            />
          </Row>
        </Section>
      ) : null}

      <Section label="Where">
        <Row title="Reach me" detail="Both means whichever device you used last.">
          <Select
            label="Reach me"
            value={profile.channel}
            options={CHANNEL_OPTIONS}
            onChange={(value) => update({ channel: value as OptionValue<typeof CHANNEL_OPTIONS> })}
          />
        </Row>
        {spaces ? (
          <Row
            title="Spaces room"
            detail={BASIC_WEB
              ? `This Scout serves no local room, so Spaces appears in the sidebar only with Hosted, the room at ${spaces.hostedHost}.`
              : `The shared room Spaces opens: this Mac's, or the one at ${spaces.hostedHost}.`}
          >
            <Select
              label="Spaces room"
              value={spaces.origin}
              options={hostOptions(spaces.originOptions, spaces.origin)}
              onChange={(value) => host.set("spaces.origin", value)}
            />
          </Row>
        ) : null}
      </Section>

      <Section label="How they write">
        <Row title="Length" detail="Terse is the answer alone. Detailed shows the reasoning.">
          <Select
            label="Length"
            value={profile.verbosity}
            options={VERBOSITY_OPTIONS}
            onChange={(value) => update({ verbosity: value as OptionValue<typeof VERBOSITY_OPTIONS> })}
          />
        </Row>
        <Row title="Tone">
          <Select
            label="Tone"
            value={profile.tone}
            options={TONE_OPTIONS}
            onChange={(value) => update({ tone: value as OptionValue<typeof TONE_OPTIONS> })}
          />
        </Row>
      </Section>
    </>
  );
}

function PermissionControl({
  state,
  onAsk,
  onOpen,
}: {
  state: HostPermissionState;
  onAsk: () => void;
  onOpen: () => void;
}) {
  if (state === "granted") return <Status ok>Allowed</Status>;
  if (state === "not-determined") {
    return (
      <>
        <Status>Not asked</Status>
        <Button onClick={onAsk}>Ask</Button>
      </>
    );
  }
  return (
    <>
      <Status bad>{state === "restricted" ? "Restricted" : state === "denied" ? "Off" : "Unknown"}</Status>
      <Button quiet onClick={onOpen}>Open Settings</Button>
    </>
  );
}

/* ── Voice ──────────────────────────────────────────────────────────────── */

const ENGINE_OPTIONS = [
  { value: "auto", label: "Auto" },
  { value: "parakeet", label: "Parakeet" },
  { value: "apple", label: "Apple Speech" },
] as const;

function voicePermissionState(entry: ScoutVoicePermissionStatus | null): HostPermissionState {
  if (!entry) return "unknown";
  if (entry.granted) return "granted";
  if (entry.status === "restricted") return "restricted";
  if (entry.status === "denied") return "denied";
  if (entry.canRequest) return "not-determined";
  return "unknown";
}

function VoicePage({ host }: { host: Host }) {
  // Opening Voice is the deliberate credential-dependent action. Generic
  // settings snapshots and first-run setup must not initialize speech keys.
  const { available: nativeVoiceAvailable, run: runNativeVoice } = host;
  useEffect(() => {
    if (nativeVoiceAvailable) void runNativeVoice(() => hostSettings.speechCatalog());
  }, [nativeVoiceAvailable, runNativeVoice]);

  const realtimeAvailable = useOptionalFlag(SCOUT_REALTIME_VOICE_FLAG, true);
  const [settings, setSettings] = useState<ScoutVoiceSettings | null>(null);
  const [devices, setDevices] = useState<ScoutVoiceInputDevice[]>([]);
  const [history, setHistory] = useState<ScoutVoiceSessionHistoryEntry[]>([]);
  const [realtime, setRealtime] = useState<Awaited<ReturnType<typeof fetchScoutRealtimeVoiceSettings>> | null>(null);
  const [playback, setPlayback] = useState<ScoutVoicePlaybackSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [snapshot, sessions, realtimeResult, playbackResult] = await Promise.allSettled([
      withTimeout(fetchScoutVoiceSettings(), 6000),
      fetchScoutVoiceHistory(12),
      fetchScoutRealtimeVoiceSettings(),
      fetchScoutVoicePlaybackSettings(),
    ]);
    if (snapshot.status === "fulfilled") {
      setSettings(snapshot.value.settings);
      setDevices(snapshot.value.devices);
      setError(null);
    } else {
      setError("Scout's voice host did not answer. Dictation and permissions need Scout running on this Mac.");
    }
    setHistory(sessions.status === "fulfilled" ? sessions.value : []);
    setRealtime(realtimeResult.status === "fulfilled" ? realtimeResult.value : null);
    setPlayback(playbackResult.status === "fulfilled" ? playbackResult.value : null);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorText(err, "That did not go through."));
    } finally {
      setBusy(false);
    }
  }, []);

  const apply = (patch: Partial<Pick<ScoutVoiceSettings, "preference" | "inputDeviceId">>) =>
    act(async () => {
      const snapshot = await saveScoutVoiceSettings(patch);
      setSettings(snapshot.settings);
      setDevices(snapshot.devices);
    });

  const realtimeOn = realtimeAvailable && realtime?.enabled === true;
  const realtimeDetail = !realtimeAvailable
    ? "Not in this build."
    : !realtime
      ? "Live voice settings are not answering right now."
      : realtime.locked
        ? `Set by OPENSCOUT_REALTIME_VOICE_ENABLED, ${realtime.enabled ? "on" : "off"}.`
        : "Talk with Scoutbot in real time. The microphone and OpenAI usage start only when you start a call.";

  const hostOnline = (settings?.permissions?.length ?? 0) > 0 || devices.length > 0;
  const onMac = playback?.playback === "host";
  const playbackDetail = !playback
    ? "Playback settings are not answering right now."
    : playback.locked
      ? `Set by ${SCOUT_VOICE_PLAYBACK_ENV}, ${playback.playback}.`
      : onMac && !hostOnline
        ? "On, but Scout's voice host is offline on this Mac."
        : "Replies and briefs play through Scout on the Mac, not the browser tab.";

  const spoken = host.snapshot?.spokenReplies ?? null;
  const mic = settings?.permissions?.find((entry) => entry.kind === "microphone") ?? null;
  const speech = settings?.permissions?.find((entry) => entry.kind === "speechRecognition") ?? null;
  const selectedDevice = settings?.inputDeviceId ?? devices.find((device) => device.isDefault)?.id ?? "";
  const permission = (kind: "microphone" | "speechRecognition", entry: ScoutVoicePermissionStatus | null) => (
    <PermissionControl
      state={voicePermissionState(entry)}
      onAsk={() => void act(async () => {
        await requestScoutVoicePermissions(kind);
        await load();
      })}
      onOpen={() => void act(() => openScoutVoicePrivacySettings(kind))}
    />
  );

  return (
    <>
      {error ? <Note error>{error}</Note> : null}

      <Section label="Conversation">
        <Row title="Live voice" detail={realtimeDetail}>
          <Toggle
            label="Live voice"
            on={realtimeOn}
            disabled={busy || !realtimeAvailable || !realtime || realtime.locked}
            onChange={(enabled) => void act(async () => {
              const snapshot = await saveScoutRealtimeVoiceSettings(enabled);
              setRealtime(snapshot);
              publishScoutRealtimeVoiceSettings(snapshot);
            })}
          />
        </Row>
      </Section>

      <Section label="Spoken replies" mac>
        <Row title="Speak on this Mac" detail={playbackDetail}>
          <Toggle
            label="Speak on this Mac"
            on={onMac}
            disabled={busy || !playback || playback.locked}
            onChange={(value) => void act(async () => {
              const snapshot = await saveScoutVoicePlaybackSettings(value ? "host" : "browser");
              setPlayback(snapshot);
              publishScoutVoicePlaybackSettings(snapshot);
            })}
          />
        </Row>
        {spoken ? (
          <>
            <Row title="Voice" dim={!onMac}>
              <Select
                label="Voice"
                value={spoken.voice}
                options={hostOptions(spoken.voiceOptions, spoken.voice)}
                onChange={(value) => host.set("spokenReplies.voice", value)}
              />
            </Row>
            <Row title="Model" detail="Local models run on this Mac. Cloud models send text to their provider." dim={!onMac}>
              <Select
                label="Model"
                value={spoken.model}
                options={hostOptions(spoken.modelOptions, spoken.model)}
                onChange={(value) => host.set("spokenReplies.model", value)}
              />
            </Row>
          </>
        ) : null}
      </Section>

      <Section label="Dictation" mac>
        <Row title="Engine" detail="Auto uses Parakeet once it is warm, and Apple Speech until then.">
          <Select
            label="Engine"
            value={settings?.preference ?? "auto"}
            options={ENGINE_OPTIONS}
            disabled={!settings || busy}
            onChange={(value) => {
              const preference = value as ScoutVoicePreference;
              setSettings((prev) => (prev ? { ...prev, preference } : prev));
              void apply({ preference });
            }}
          />
        </Row>
        <Row
          title="Microphone"
          detail={devices.length > 0 ? "The system default unless you choose one." : "Scout is not reporting microphones. Allow access below, then refresh."}
        >
          {devices.length > 0 ? (
            <Select
              label="Microphone"
              value={selectedDevice}
              disabled={busy}
              options={devices.map((device) => ({
                value: device.id,
                label: device.isDefault ? `${device.name} (default)` : device.name,
              }))}
              onChange={(inputDeviceId) => void apply({ inputDeviceId: inputDeviceId || null })}
            />
          ) : null}
          {host.available ? <Button quiet onClick={() => host.open("sound-settings")}>Sound Settings</Button> : null}
        </Row>
        <Row
          title="Parakeet model"
          detail={settings?.modelReady ? undefined : settings?.modelInstalled ? "Installed. The first dictation warms it." : "Downloads on first use. Apple Speech works meanwhile."}
        >
          {loading && !settings ? <Status>Checking</Status>
            : settings?.modelReady ? <Status ok>Warm</Status>
              : settings?.modelInstalled ? <Status>Installed</Status>
                : <Status>Not installed</Status>}
        </Row>
        <Row
          title="Recent dictation"
          detail={history.length === 0
            ? "Nothing yet. It fills as you use the mic in chat."
            : `${history.length} sessions. Last ${history[0]!.status}${history[0]!.lastEvent ? `, ${history[0]!.lastEvent}` : ""}, ${timeAgo(history[0]!.updatedAt)}.`}
        >
          <Button quiet disabled={loading} onClick={() => void load()}>{loading ? "Refreshing" : "Refresh"}</Button>
        </Row>
      </Section>

      <Section
        label="Permissions"
        mac
        note={hostOnline
          ? "The browser never records. Scout captures audio on the Mac, and only while you talk."
          : "Scout's voice host is offline, so these can't be read. Open Scout on this Mac."}
      >
        <Row title="Microphone" detail="To hear you.">
          {permission("microphone", mic)}
        </Row>
        <Row title="Speech recognition" detail="For Apple Speech dictation.">
          {permission("speechRecognition", speech)}
        </Row>
      </Section>
    </>
  );
}

/* ── Terminal ───────────────────────────────────────────────────────────── */

function TerminalPage({ host }: { host: Host }) {
  const terminal = host.snapshot?.terminal ?? null;
  if (!terminal) return <HostPending host={host} />;
  return (
    <>
      <Section label="Tiles" mac>
        <Row title="Renderer" detail="Native draws with Metal. Web uses the same view as the browser.">
          <Select
            label="Renderer"
            value={terminal.renderer}
            options={hostOptions(terminal.rendererOptions, terminal.renderer)}
            onChange={(value) => host.set("terminal.renderer", value)}
          />
        </Row>
        <Row title="Tile headers" detail="A caption over each tile with the agent and its folder.">
          <Toggle label="Tile headers" on={terminal.tileHeaders} onChange={(value) => host.set("terminal.tileHeaders", value)} />
        </Row>
      </Section>

      <Section label="Type" mac>
        <Row title="Font">
          <Select
            label="Font"
            value={terminal.fontFamily}
            options={hostOptions(terminal.fontFamilyOptions, terminal.fontFamily)}
            onChange={(value) => host.set("terminal.fontFamily", value)}
          />
        </Row>
        <Row title="Size">
          <Range
            label="Size"
            value={terminal.fontSize}
            min={9}
            max={24}
            format={(value) => `${value} pt`}
            onChange={(value) => host.set("terminal.fontSize", value)}
          />
        </Row>
      </Section>

      <Section label="Hand off" mac note="Used when you open a session outside Scout.">
        <Row title="Terminal app" detail="Automatic picks the one you used last.">
          <Select
            label="Terminal app"
            value={terminal.preferredTerminalAppPath}
            options={hostOptions(terminal.terminalAppOptions, terminal.preferredTerminalAppPath)}
            onChange={(value) => host.set("terminal.preferredTerminalAppPath", value)}
          />
        </Row>
      </Section>
    </>
  );
}

function HostPending({ host }: { host: Host }) {
  return (
    <Section label="This Mac">
      <div className="sq-empty">
        {host.error ?? (host.available ? "Asking the Scout app…" : "Open Settings in the Scout app to change this.")}
      </div>
    </Section>
  );
}

/* ── Keys ───────────────────────────────────────────────────────────────── */

function useCredentials() {
  const [client, setClient] = useState<ClientCredentialState | null>(null);
  const [server, setServer] = useState<ServerCredentialState | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    // HudVault lives in IndexedDB and can stall in an embedded web view; it is
    // only a mirror, so it never holds the page.
    const [clientResult, serverResult] = await Promise.allSettled([
      withTimeout(getClientCredentialState(), 2500),
      withTimeout(getServerCredentialState(), 6000),
    ]);
    const clientValue = clientResult.status === "fulfilled" ? clientResult.value : null;
    let serverValue = serverResult.status === "fulfilled" ? serverResult.value : null;
    if (clientValue?.configured && !serverValue?.openai.configured) {
      serverValue = await withTimeout(ensureOpenAIKeyOnServer(), 6000).catch(() => serverValue);
    }
    setClient(clientValue);
    setServer(serverValue);
    setLoaded(true);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return { client, server, loaded, load };
}

function KeysPage() {
  const { client, server, loaded, load } = useCredentials();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const openai = server?.openai ?? null;
  const configured = Boolean(openai?.configured);
  const source = openai?.source === "env"
    ? "from the OPENAI_API_KEY environment variable"
    : openai?.source === "local-config"
      ? "from local Scout config"
      : openai?.source === "local-store"
        ? "saved on this Mac"
        : null;
  const preview = openai?.preview ?? client?.preview ?? null;
  const canClear = Boolean(client?.configured || openai?.source === "local-store");

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const key = draft.trim();
      await saveOpenAIKeyToServer(key);
      const mirrored = await withTimeout(setOpenAIApiKey(key), 2500).then(() => true, () => false);
      setDraft("");
      await load();
      setMessage({ text: mirrored ? "Saved." : "Saved on this Mac. This browser's copy could not be written." });
    } catch (err) {
      setMessage({ text: errorText(err, "Could not save the key."), error: true });
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    setMessage(null);
    const results = await Promise.allSettled([
      withTimeout(deleteOpenAIApiKey(), 2500),
      deleteOpenAIKeyFromServer(),
    ]);
    setDraft("");
    await load();
    setBusy(false);
    setMessage(results.some((result) => result.status === "rejected")
      ? { text: "Removed what could be removed; one store did not answer.", error: true }
      : { text: openai?.source === "env" || openai?.source === "local-config" ? "Removed. A key from the environment or config still applies." : "Removed." });
  };

  return (
    <Section
      label="Model providers"
      note={message
        ? <span style={message.error ? { color: "var(--sq-danger)" } : undefined}>{message.text}</span>
        : "Scout never shows a saved key again, and never writes one to a log."}
    >
      <Row
        title="OpenAI"
        detail={!loaded ? "Checking…" : configured ? `Used for live voice and Scoutbot. ${[preview, source].filter(Boolean).join(", ")}.` : "Used for live voice and Scoutbot. No key yet."}
      >
        {loaded ? configured ? <Status ok>Saved</Status> : <Status>Missing</Status> : null}
      </Row>
      <Row title={configured ? "Replace key" : "Add key"} detail="Paste a key that starts with sk-.">
        <input
          className="sq-input sq-mono"
          type="password"
          aria-label="OpenAI API key"
          value={draft}
          placeholder="sk-…"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && draft.trim() && !busy) void save();
          }}
        />
        <Button disabled={busy || !draft.trim()} onClick={() => void save()}>{busy ? "Saving" : "Save"}</Button>
      </Row>
      {canClear ? (
        <Row title="Remove saved key" detail="Live voice and Scoutbot stop until a key is added again.">
          <Button quiet danger disabled={busy} onClick={() => void clear()}>Remove</Button>
        </Row>
      ) : null}
    </Section>
  );
}

/* ── shared host data (/api/pairing-state, /api/mesh, /api/build) ───────── */

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

function useResource<T>(path: string | null, timeoutMs = 6000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (override?: string) => {
    const target = override ?? path;
    if (!target) return;
    setLoading(true);
    try {
      setData(await withTimeout(api<T>(target), timeoutMs));
      setError(null);
    } catch (err) {
      setError(errorText(err, "Did not answer."));
    } finally {
      setLoading(false);
    }
  }, [path, timeoutMs]);

  useEffect(() => {
    void load();
  }, [load]);

  return { data, setData, error, loading, load };
}

function sourceIdentity(branch: string | null | undefined, commit: string | null | undefined, dirty = false): string {
  if (!branch && !commit) return "not reported";
  return commit ? `${branch || "detached"} · ${commit}${dirty ? " (modified)" : ""}` : branch || "detached";
}

/* ── Devices ────────────────────────────────────────────────────────────── */

function AssistantsPage() {
  const [error, setError] = useState<string | null>(null);
  return <Section label="Connected assistants" note="Compare the matching code before approving. You can review existing access and revoke it at any time.">
    {error ? <Note error>{error}</Note> : null}
    <Row title="Requests and access" detail="Uses your OpenScout Network account on this Mac.">
      <Button onClick={() => void hostSettings.open("connected-assistants").catch(() => setError("Could not open Connected assistants. Try again from Scout."))}>Manage assistants</Button>
    </Row>
  </Section>;
}

function DevicesPage({ navigate }: { navigate: (route: Route) => void }) {
  const pairing = useResource<PairingState>("/api/pairing-state", 4000);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const state = pairing.data;

  const control = async (action: "start" | "stop" | "restart") => {
    setBusy(action);
    setError(null);
    try {
      pairing.setData(await api<PairingState>("/api/pairing/control", { method: "POST", body: JSON.stringify({ action }) }));
    } catch (err) {
      setError(errorText(err, "The relay did not answer."));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (fingerprint: string) => {
    setBusy(fingerprint);
    setError(null);
    try {
      await api(`/api/pairing/peers/${encodeURIComponent(fingerprint)}`, { method: "DELETE" });
      await pairing.load();
    } catch (err) {
      setError(errorText(err, "Could not remove that device."));
    } finally {
      setBusy(null);
    }
  };

  if (!state) {
    return (
      <Section label="Paired">
        <div className="sq-empty">{pairing.loading ? "Asking the relay…" : pairing.error ?? "No pairing state."}</div>
      </Section>
    );
  }

  return (
    <>
      {error ? <Note error>{error}</Note> : null}
      <Section label="Paired">
        {state.trustedPeers.length === 0 ? (
          <Row title="No devices yet" detail="Open Scout on a phone or iPad and scan the code." />
        ) : state.trustedPeers.map((peer) => {
          const connected = peer.fingerprint === state.connectedPeerFingerprint;
          return (
            <Row
              key={peer.fingerprint}
              title={peer.name ?? "Paired device"}
              detail={`Paired ${peer.pairedAtLabel} · last seen ${peer.lastSeenLabel}`}
            >
              {connected ? <Status ok>Connected</Status> : <Status>Offline</Status>}
              <Button quiet disabled={busy !== null} onClick={() => void remove(peer.fingerprint)}>
                {busy === peer.fingerprint ? "Removing" : "Remove"}
              </Button>
            </Row>
          );
        })}
        <Row title="Pair a device" detail="Show the code, then scan it from Scout on the phone.">
          <a
            className="sq-button"
            href={routePath({ view: "settings", section: "pairing" })}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
              event.preventDefault();
              navigate({ view: "settings", section: "pairing" });
            }}
          >
            Show code
          </a>
        </Row>
      </Section>

      <Section
        label="Relay"
        note="Agents reach your phone through the relay when the app is in the background. End-to-end encrypted; keys never leave your devices."
      >
        <Row title="Relay" detail={<span className="sq-mono">{state.relay ?? "not configured"}{state.statusDetail ? ` · ${state.statusDetail}` : ""}</span>}>
          {state.isRunning ? <Status ok>{state.statusLabel || "Running"}</Status> : <Status>{state.statusLabel || "Stopped"}</Status>}
          {state.isRunning ? (
            <>
              <Button quiet disabled={busy !== null} onClick={() => void control("restart")}>{busy === "restart" ? "Restarting" : "Restart"}</Button>
              <Button quiet disabled={busy !== null} onClick={() => void control("stop")}>Stop</Button>
            </>
          ) : (
            <Button disabled={busy !== null} onClick={() => void control("start")}>{busy === "start" ? "Starting" : "Start"}</Button>
          )}
        </Row>
      </Section>
    </>
  );
}

/* ── Mesh ───────────────────────────────────────────────────────────────── */

const ONLINE_WINDOW_MS = 5 * 60_000;

function MeshPage({ host }: { host: Host }) {
  const mesh = useResource<MeshStatus>("/api/mesh");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const status = mesh.data;

  const act = async (label: string, path: string) => {
    setBusy(label);
    setError(null);
    try {
      const next = await api<MeshStatus>(path, { method: "POST", body: "{}" });
      if (next && typeof next === "object" && "identity" in next) mesh.setData(next);
      else await mesh.load();
    } catch (err) {
      setError(errorText(err, "The broker did not answer."));
    } finally {
      setBusy(null);
    }
  };

  if (!status) {
    return (
      <>
        <Section label="Mesh" mac>
          <div className="sq-empty">{mesh.loading ? "Asking the broker…" : mesh.error ?? "No mesh state."}</div>
        </Section>
        <NetworkSection host={host} />
      </>
    );
  }

  const localId = status.localNode?.id ?? null;
  const hosts = Object.values(status.nodes)
    .filter((node) => node.id !== localId)
    .sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0));
  const onMesh = status.identity.discoverable;
  const issues = [...status.issues.map((issue) => issue.summary || issue.title), ...status.warnings].filter(Boolean);

  return (
    <>
      {error ? <Note error>{error}</Note> : null}
      <Section label="Mesh" mac note={issues.length > 0 ? issues[0] : undefined}>
        <Row
          title="Take part in the mesh"
          detail={onMesh ? "Macs you trust can see agents here and send them work." : "Local only. Other Scouts can't find this Mac."}
        >
          <Toggle
            label="Take part in the mesh"
            on={onMesh}
            disabled={busy !== null}
            onChange={(join) => void act(join ? "join" : "leave", join ? "/api/mesh/join" : "/api/mesh/leave")}
          />
        </Row>
        <Row title="Name" detail="How the other Scouts know this Mac.">
          <span className="sq-value">{status.identity.name ?? status.localNode?.name ?? "not set"}</span>
        </Row>
        <Row title="Announce" detail={status.identity.discoveryDetail || "Tell the other Scouts where to find this Mac."} dim={!onMesh}>
          <Button quiet disabled={busy !== null || !onMesh} onClick={() => void act("announce", "/api/mesh/announce")}>
            {busy === "announce" ? "Announcing" : "Announce again"}
          </Button>
        </Row>
      </Section>

      <Section label="Hosts">
        {hosts.length === 0 ? (
          <Row title="No other Scouts yet" detail="Scan to look for them on your tailnet and local network." />
        ) : hosts.map((node) => {
          const seen = node.lastSeenAt ?? null;
          const online = seen !== null && Date.now() - seen < ONLINE_WINDOW_MS;
          return (
            <Row
              key={node.id}
              title={node.name}
              detail={
                <span className="sq-mono">
                  {[node.hostName !== node.name ? node.hostName : null, node.host?.scoutVersion ? `Scout ${node.host.scoutVersion}` : null, seen ? `seen ${timeAgo(seen)}` : null]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              }
            >
              {online ? <Status ok>Online</Status> : <Status>Away</Status>}
            </Row>
          );
        })}
        <Row title="Find machines" detail="Look for Scouts on your tailnet and local network.">
          <Button disabled={busy !== null} onClick={() => void act("scan", "/api/machines/scan")}>
            {busy === "scan" ? "Scanning" : "Scan"}
          </Button>
        </Row>
      </Section>

      <Section label="Tailscale">
        <Row
          title="Tailnet"
          detail={status.tailscale.available
            ? `${status.tailscale.onlineCount} of ${status.tailscale.peers.length} peers online${status.tailscale.backendState ? ` · ${status.tailscale.backendState}` : ""}.`
            : "Tailscale is not installed on this Mac."}
        >
          {status.tailscale.running ? <Status ok>Running</Status> : <Status>{status.tailscale.available ? "Stopped" : "Absent"}</Status>}
        </Row>
      </Section>
      <NetworkSection host={host} />
    </>
  );
}

/* ── System ─────────────────────────────────────────────────────────────── */

type Snapshot = {
  build: WebBuildInfo | null;
  mesh: MeshStatus | null;
  pairing: PairingState | null;
  collectedAt: Date;
};

function useSnapshot() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    const [build, mesh, pairing] = await Promise.allSettled([
      withTimeout(api<WebBuildInfo>(refresh ? "/api/build?refresh=1" : "/api/build"), 6000),
      withTimeout(api<MeshStatus>("/api/mesh"), 6000),
      withTimeout(api<PairingState>("/api/pairing-state"), 4000),
    ]);
    setSnapshot((prev) => ({
      build: build.status === "fulfilled" ? build.value : prev?.build ?? null,
      mesh: mesh.status === "fulfilled" ? mesh.value : prev?.mesh ?? null,
      pairing: pairing.status === "fulfilled" ? pairing.value : prev?.pairing ?? null,
      collectedAt: new Date(),
    }));
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return { snapshot, loading, load };
}

function report(snapshot: Snapshot, host: HostSettingsSnapshot | null): string {
  const { build, mesh, pairing } = snapshot;
  const broker = mesh?.health.build ?? null;
  const localHost = mesh?.localNode ? mesh.nodes[mesh.localNode.id]?.host : undefined;
  return [
    "OpenScout troubleshooting report",
    `Collected: ${snapshot.collectedAt.toISOString()}`,
    "",
    "[App]",
    `Version: ${host ? `${host.host.appVersion}${host.host.build ? ` (${host.host.build})` : ""}` : "not in the Scout app"}`,
    `Surface: ${host?.host.surface ?? "browser"}`,
    `Updates: ${host ? host.update.supported ? host.update.availableVersion ? `${host.update.availableVersion} available` : "up to date" : "not supported in this build" : "unknown"}`,
    "",
    "[Web]",
    `Version: ${build?.version ?? "unknown"}`,
    `Mode: ${build?.mode ?? "unknown"}`,
    `Source: ${sourceIdentity(build?.branch, build?.commit, build?.dirty === true)}`,
    `Server: ${build?.server ? `${build.server.engine} ${build.server.engineVersion} · ${build.server.platform}/${build.server.arch}` : "unknown"}`,
    "",
    "[Broker]",
    `Reachable: ${mesh ? (mesh.health.reachable ? "yes" : "no") : "unknown"}`,
    `Healthy: ${mesh ? (mesh.health.ok ? "yes" : "no") : "unknown"}`,
    `Error: ${mesh?.health.error ?? "none reported"}`,
    `Package: ${broker?.packageName ?? "unknown"}`,
    `Version: ${broker?.version ?? "unknown"}`,
    `Source: ${sourceIdentity(broker?.branch, broker?.commit)}`,
    `Build: ${broker?.buildNumber ?? broker?.buildId ?? "not reported"}`,
    `Node: ${mesh?.health.nodeId ?? "unknown"}`,
    `Broker URL: ${mesh?.brokerUrl ?? "unknown"}`,
    "",
    "[Relay]",
    `Status: ${pairing?.statusLabel ?? "unknown"}`,
    `Relay: ${pairing?.relay ?? "not configured"}`,
    `Paired devices: ${pairing?.trustedPeerCount ?? "unknown"}`,
    "",
    "[Host]",
    `Name: ${host?.host.machineName ?? mesh?.localNode?.name ?? "unknown"}`,
    `System: ${host?.host.osVersion ?? localHost?.os ?? "unknown"}`,
    `Architecture: ${localHost?.arch ?? build?.server?.arch ?? "unknown"}`,
    "",
    "[Browser]",
    `User agent: ${navigator.userAgent}`,
    `Origin: ${window.location.origin}`,
  ].join("\n");
}

function useCopy() {
  const [state, setState] = useState<"idle" | "copied" | "error">("idle");
  const copy = useCallback((text: string) => {
    copyText(text)
      .then(() => {
        setState("copied");
        setTimeout(() => setState("idle"), 1800);
      })
      .catch(() => setState("error"));
  }, []);
  return { state, copy };
}

/** OpenScout Network publishing. Only the menu reports it: it runs the
 *  relay and holds the OSN session, so the group appears in its window. */
function NetworkSection({ host }: { host: Host }) {
  const network = host.snapshot?.network ?? null;
  if (!network) return null;
  const off = !network.discoveryEnabled;
  return (
    <Section label="OpenScout Network" mac note={network.detail}>
      <Row
        title={network.signedIn ? "Signed in" : "Not signed in"}
        detail={network.signedIn ? "This Mac can publish itself to the OpenScout Network." : "Sign in to publish this Mac beyond your own devices."}
      >
        <Status ok={network.signedIn && !off}>{network.pending ? "Working" : network.status}</Status>
        <Button
          primary={!network.signedIn || off}
          disabled={network.pending}
          onClick={() => void host.run(() => hostSettings.setUpNetwork())}
        >
          {network.setupLabel}
        </Button>
      </Row>
      <Row title="Publish this Mac" detail="Paired devices and Scout peers can discover it.">
        <Toggle
          label="Publish this Mac"
          on={network.discoveryEnabled}
          disabled={network.pending}
          onChange={(value) => host.set("network.discoveryEnabled", value)}
        />
      </Row>
      <Row title="Keep the mobile relay up" detail="Paired iPhone and iPad reconnect without scanning again." dim={off}>
        <Toggle
          label="Keep the mobile relay up"
          on={network.keepRelayRunning}
          disabled={off || network.pending}
          onChange={(value) => host.set("network.keepRelayRunning", value)}
        />
      </Row>
      <Row title="Discovery" detail={<span className="sq-mono">{network.rendezvousURL}</span>} />
      <Row title="Relay" detail={<span className="sq-mono">{network.relayURL}</span>} />
      <Row title="Settings file" detail={<span className="sq-mono">{network.settingsPath}</span>}>
        <Button quiet onClick={() => host.open("network-settings-file")}>Reveal</Button>
      </Row>
    </Section>
  );
}

/** The https door on a named host (arts-mini.scout.local). Browsers only
 * give the microphone to a secure page, and the door only works once this
 * Mac trusts the local edge's certificate authority. */
function SecureAddressRow() {
  const [state, setState] = useState<LocalHttpsState | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const { state: copyState, copy } = useCopy();

  useEffect(() => {
    let live = true;
    withTimeout(api<LocalHttpsState>("/api/local-https"), 6000)
      .then((next) => { if (live) setState(next); })
      .catch(() => { if (live) setState(null); });
    return () => { live = false; };
  }, []);

  const trust = async () => {
    setBusy(true);
    setFailed(null);
    try {
      const next = await api<LocalHttpsState>("/api/local-https/trust", { method: "POST", body: "{}" });
      setState(next);
      if (!next.trusted) setFailed(next.detail);
    } catch (error) {
      setFailed(error instanceof Error ? error.message : "macOS did not trust the certificate.");
    } finally {
      setBusy(false);
    }
  };

  if (!state || state.status === "skipped") return null;
  const address = state.secureOrigin ?? "https on scout.local names";
  const detail = failed
    ?? (state.trusted
      ? "Browsers on this Mac open it without a warning, so live voice works there."
      : state.status === "unavailable"
        ? "Starts working once the local edge has run once."
        : state.canTrustHere
          ? "Trust it once so browsers accept it. macOS asks for your password."
          : `Trust it on the Mac itself, or run ${state.command ?? "scout server trust"} there.`);

  return (
    <Row title="Secure address" detail={<><span className="sq-mono">{address}</span> · {detail}</>}>
      {state.trusted ? <Status ok>Trusted</Status> : <Status>Not trusted</Status>}
      {!state.trusted && state.canTrustHere ? (
        <Button disabled={busy} onClick={() => void trust()}>{busy ? "Waiting for macOS" : "Trust"}</Button>
      ) : null}
      {!state.trusted && !state.canTrustHere && state.command ? (
        <Button quiet onClick={() => copy(state.command!)}>{copyState === "copied" ? "Copied" : "Copy command"}</Button>
      ) : null}
    </Row>
  );
}

function SystemPage({ host }: { host: Host }) {
  const { snapshot, loading, load } = useSnapshot();
  const { state: copyState, copy } = useCopy();
  const [busy, setBusy] = useState(false);
  const mesh = snapshot?.mesh ?? null;
  const pairing = snapshot?.pairing ?? null;
  const build = snapshot?.build ?? null;

  const restartRelay = async () => {
    setBusy(true);
    try {
      await api<PairingState>("/api/pairing/control", { method: "POST", body: JSON.stringify({ action: "restart" }) });
    } finally {
      setBusy(false);
      void load();
    }
  };

  return (
    <>
      <Section label="Running" mac note={snapshot ? `As of ${snapshot.collectedAt.toLocaleTimeString()}.` : undefined}>
        <Row title="Broker" detail={<span className="sq-mono">{mesh?.brokerUrl ?? "—"}{mesh?.health.error ? ` · ${mesh.health.error}` : ""}</span>}>
          {!mesh ? <Status>{loading ? "Checking" : "Unknown"}</Status>
            : !mesh.health.reachable ? <Status bad>Unreachable</Status>
              : mesh.health.ok ? <Status ok>Running</Status>
                : <Status bad>Degraded</Status>}
        </Row>
        <Row title="Relay" detail={<span className="sq-mono">{pairing?.relay ?? "not configured"}</span>}>
          {!pairing ? <Status>{loading ? "Checking" : "Unknown"}</Status>
            : pairing.isRunning ? <Status ok>Connected</Status>
              : <Status>Stopped</Status>}
          <Button quiet disabled={busy || !pairing} onClick={() => void restartRelay()}>{busy ? "Restarting" : "Restart"}</Button>
        </Row>
        <Row
          title="Web"
          detail={<span className="sq-mono">{window.location.host}{build?.server ? ` · ${build.server.engine} ${build.server.engineVersion}` : ""}</span>}
        >
          {build ? <Status ok>Serving</Status> : <Status>{loading ? "Checking" : "Unknown"}</Status>}
        </Row>
        <SecureAddressRow />
        <Row title="Check again">
          <Button quiet disabled={loading} onClick={() => void load(true)}>{loading ? "Checking" : "Refresh"}</Button>
        </Row>
      </Section>

      {host.snapshot?.permissions.accessibility ? (
        <Section label="Other apps" mac>
          <Row
            title="Send replies into open apps"
            detail="Lets a reply from your phone go into the ChatGPT app's Codex thread it came from. Scout presses Return in that composer and nothing else."
          >
            <PermissionControl
              state={host.snapshot.permissions.accessibility}
              onAsk={() => void host.run(() => hostSettings.requestPermission("accessibility"))}
              // Asking lists Scout in the Accessibility pane and opens it; the
              // switch there is the operator's.
              onOpen={() => void host.run(() => hostSettings.requestPermission("accessibility"))}
            />
          </Row>
        </Section>
      ) : null}

      <Section label="When something is wrong" note="The report has versions and states, never keys or tokens.">
        <Row
          title="Diagnostics"
          detail={copyState === "error" ? "Clipboard access was denied." : "A plain-text report to paste into an issue or a message."}
        >
          <Button disabled={!snapshot} onClick={() => snapshot && copy(report(snapshot, host.snapshot))}>
            {copyState === "copied" ? "Copied" : "Copy"}
          </Button>
        </Row>
        {host.available ? (
          <Row title="Logs" detail="The broker, relay and app logs, in Finder.">
            <Button onClick={() => host.open("logs")}>Reveal</Button>
          </Row>
        ) : null}
      </Section>
    </>
  );
}

/* ── Solo Pro ───────────────────────────────────────────────────────────── */

// Three facts, kept apart: what the account has (asked of the download host
// only when you check), what is installed here, and what is running. Setup
// happens in the existing CLI; this page shows the command and never installs.

const SOLO_PRO_LEAD: Record<SoloProPhase, string> = {
  active: "Access is confirmed, and every required part is installed and running.",
  finish_setup: "This account has Solo Pro. Install what is missing below; there is nothing to buy.",
  not_ready: "The full web app is installed, but this web server isn't serving it yet.",
  no_access: "This machine keeps working as Solo. Anything already installed stays where it is.",
  unconfirmed: "Scout hasn't confirmed what this account has. Nothing is turned on or off while it's unknown.",
};

function SoloProActions({
  actions,
  onCheck,
  checking,
  copy,
}: {
  actions: SoloProAction[];
  onCheck: () => void;
  checking: boolean;
  copy: (text: string) => void;
}) {
  if (actions.length === 0) return null;
  return (
    <div className="sq-pro-actions">
      {actions.map((action) =>
        action.kind === "command" ? (
          <span key={action.command} className="sq-pro-command" title={action.label}>
            <code className="sq-mono">{action.command}</code>
            <Button quiet onClick={() => copy(action.command)}>Copy</Button>
          </span>
        ) : action.kind === "link" ? (
          <a key={action.href} className="sq-button" href={action.href} target="_blank" rel="noopener noreferrer">
            {action.label} ↗
          </a>
        ) : (
          <Button key="check" disabled={checking} onClick={onCheck}>{checking ? "Checking" : action.label}</Button>
        ),
      )}
    </div>
  );
}

function soloProInstalledStatus(component: SoloProComponent) {
  switch (component.installed) {
    case "installed": return <Status ok>Installed</Status>;
    case "missing": return component.required ? <Status bad>Missing</Status> : <Status>Not installed</Status>;
    case "not_applicable": return <Status>Not on this OS</Status>;
    default: return <Status>Unknown</Status>;
  }
}

function soloProReadyStatus(component: SoloProComponent) {
  switch (component.ready) {
    case "ready": return <Status ok>Ready</Status>;
    case "not_ready": return component.required ? <Status bad>Not ready</Status> : <Status>Not running</Status>;
    case "not_applicable": return <Status>Not on this OS</Status>;
    default: return <Status>Unknown</Status>;
  }
}

type ProFact = { label: string; value: string; detail?: string; tone?: "ok" | "bad" };

/** The three facts as one line each: required parts only, and only those that apply on this OS.
 *  Running counts against what is installed, so a missing part reads once, under Installed. */
function soloProFacts(status: SoloProStatus): ProFact[] {
  const { access } = status;
  const required = status.components.filter((component) => component.required && component.installed !== "not_applicable");
  const installed = required.filter((component) => component.installed === "installed");
  const ready = installed.filter((component) => component.ready === "ready");
  const count = (n: number) => required.length === 0 ? "Nothing required" : `${n} of ${required.length} required`;
  return [
    {
      label: "Access",
      value: access.title,
      detail: access.account ? access.account.label ?? access.account.login : undefined,
      tone: access.state === "granted" ? "ok" : access.state === "credential_rejected" || access.state === "unavailable" ? "bad" : undefined,
    },
    {
      label: "Installed here",
      value: count(installed.length),
      tone: required.length > 0 && installed.length === required.length ? "ok" : installed.length < required.length ? "bad" : undefined,
    },
    {
      label: "Running",
      value: installed.length === 0 ? "Nothing installed" : `${ready.length} of ${installed.length} installed`,
      tone: installed.length === 0 ? undefined : ready.length === installed.length ? "ok" : "bad",
    },
  ];
}

function hasNavigationApi(): boolean {
  return typeof window !== "undefined" && "navigation" in window;
}

function SoloProPage({ navigate }: { navigate: (route: Route) => void }) {
  const [status, setStatus] = useState<SoloProStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [loading, setLoading] = useState(false);
  const { state: copyState, copy } = useCopy();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await api<SoloProStatus>("/api/solo-pro"));
      setError(null);
    } catch (err) {
      setError(errorText(err, "Couldn't read Solo Pro status from this Scout."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const check = async () => {
    setChecking(true);
    try {
      setStatus(await api<SoloProStatus>("/api/solo-pro/access/check", { method: "POST" }));
      setError(null);
    } catch (err) {
      setError(errorText(err, "Couldn't run the check."));
    } finally {
      setChecking(false);
    }
  };

  const backToWork = () => {
    // Back only when the Navigation API can vouch for a previous Scout entry
    // (it lists same-origin entries only). history.length can't: it counts
    // whatever page linked here. Otherwise go Home.
    if (hasNavigationApi() && canNavigateBrowserBack()) navigateBrowserBack();
    else navigate({ view: "inbox" });
  };

  if (!status) {
    return (
      <Section label="Solo Pro" note={error ? <span style={{ color: "var(--sq-danger)" }}>{error}</span> : undefined}>
        {error ? (
          <Row title="Couldn't read this machine" detail="The page asks this Scout's web server; nothing about your account changed.">
            <Button disabled={loading} onClick={() => void load()}>{loading ? "Reading" : "Try again"}</Button>
          </Row>
        ) : <div className="sq-empty">Checking this machine…</div>}
      </Section>
    );
  }

  const { access, components } = status;
  // The tag names the machine the facts describe; only a Mac gets "This Mac".
  const onMac = status.platform === "darwin";
  const accessStatus = access.state === "granted" ? <Status ok>Solo Pro</Status>
    : access.state === "denied" ? <Status>Solo</Status>
      : <Status bad={access.state === "credential_rejected" || access.state === "unavailable"}>{access.title}</Status>;
  const actionProps = { onCheck: () => void check(), checking, copy };

  return (
    <div className="sq-pro">
      <div className="sq-pro-summary" data-phase={status.phase} role="status">
        <div className="sq-pro-kicker">
          <span className="sq-pro-sigil" aria-hidden="true"><ScoutMark /></span>
          Solo Pro
        </div>
        <div className="sq-pro-headline">{status.headline}</div>
        <p className="sq-pro-lead">{SOLO_PRO_LEAD[status.phase]}</p>
        <dl className="sq-pro-facts">
          {soloProFacts(status).map((fact) => (
            <div key={fact.label} data-tone={fact.tone}>
              <dt>{fact.label}</dt>
              <dd>
                <span>{fact.value}</span>
                {fact.detail ? <small>{fact.detail}</small> : null}
              </dd>
            </div>
          ))}
        </dl>
        <div className="sq-pro-summary-actions">
          <Button primary={status.phase === "active"} onClick={backToWork}>Back to your work</Button>
          <Button quiet disabled={loading} onClick={() => void load()}>{loading ? "Reading" : "Read again"}</Button>
        </div>
      </div>

      <Section
        label="Access"
        note={access.checkedAt
          ? access.keyWhere
            ? `Checked ${timeAgo(access.checkedAt)} with the download key in ${access.keyWhere}. Scout never shows the key.`
            : `Checked ${timeAgo(access.checkedAt)}. No download key was found, so nothing was sent.`
          : "Checking asks console.openscout.app once with the download key from scout web login. Scout never shows the key."}
      >
        <Row title="Full web app on this account" detail={access.detail}>{accessStatus}</Row>
        {access.actions.length > 0 ? (
          <div className="sq-row" data-stack>
            <SoloProActions actions={access.actions} {...actionProps} />
          </div>
        ) : null}
      </Section>

      <Section label="Installed" mac={onMac}>
        {components.map((component) => (
          <Row
            key={component.id}
            stack={component.installed === "missing" && component.actions.length > 0}
            title={<>{component.label}{component.required ? null : <span className="sq-pro-optional">optional</span>}</>}
            detail={component.installedDetail}
          >
            {component.installed === "missing" ? (
              <>
                {soloProInstalledStatus(component)}
                <SoloProActions actions={component.actions} {...actionProps} />
              </>
            ) : soloProInstalledStatus(component)}
          </Row>
        ))}
      </Section>

      <Section
        label="Ready"
        mac={onMac}
        note={copyState === "error"
          ? "Clipboard access was denied."
          : copyState === "copied"
            ? "Copied. Run it in a terminal on this machine."
            : "Installing or restarting keeps your agents, projects, history and pairings. scout web install only swaps the web app and restarts the web server."}
      >
        {components.filter((component) => component.installed === "installed").map((component) => (
          <Row
            key={component.id}
            stack={component.ready === "not_ready" && component.actions.length > 0}
            title={component.label}
            detail={component.readyDetail}
          >
            {component.ready === "not_ready" ? (
              <>
                {soloProReadyStatus(component)}
                <SoloProActions actions={component.actions} {...actionProps} />
              </>
            ) : soloProReadyStatus(component)}
          </Row>
        ))}
        {components.every((component) => component.installed !== "installed") ? (
          <div className="sq-empty">Nothing is installed yet.</div>
        ) : null}
      </Section>
      {error ? <Note error>{error}</Note> : null}
    </div>
  );
}

/* ── About ──────────────────────────────────────────────────────────────── */

function UpdateSection({ host }: { host: Host }) {
  const snapshot = host.snapshot;
  if (!snapshot) return null;
  const update = snapshot.update;
  const current = snapshot.host.appVersion;
  if (!update.supported) {
    return (
      <Section label="Updates" mac>
        <Row title={`Scout ${current}`} detail="A development build. It updates from its checkout, not from releases." />
      </Section>
    );
  }
  if (update.delegated) {
    return (
      <Section label="Updates" mac>
        {update.availableVersion ? (
          <Row title={`Scout ${update.availableVersion} is ready`} detail={`You have ${current}. Scout opens, updates and restarts.`}>
            <Button primary onClick={() => void host.run(async () => { await hostSettings.installUpdate(); return null; })}>
              Update now
            </Button>
          </Row>
        ) : (
          <Row title={`Scout ${current}`} detail="The Scout app checks for updates and tells you here when one is ready." />
        )}
      </Section>
    );
  }
  const checked = update.lastCheckedAt ? `Checked ${timeAgo(new Date(update.lastCheckedAt).getTime())}.` : "Not checked yet.";
  return (
    <Section label="Updates" mac>
      {update.availableVersion ? (
        <Row title={`Scout ${update.availableVersion} is ready`} detail={`You have ${current}. Scout restarts to finish.`}>
          <Button primary onClick={() => void host.run(async () => { await hostSettings.installUpdate(); return null; })}>
            Update now
          </Button>
        </Row>
      ) : (
        <Row title={`Scout ${current}`} detail={update.checking ? "Checking…" : `Up to date. ${checked}`}>
          <Button disabled={update.checking} onClick={() => void host.run(() => hostSettings.checkForUpdates())}>
            {update.checking ? "Checking" : "Check now"}
          </Button>
        </Row>
      )}
      <Row title="Check automatically" detail="Scout looks once a day and tells you here and in the sidebar.">
        <Toggle
          label="Check automatically"
          on={update.automaticChecks}
          onChange={(value) => host.set("update.automaticChecks", value)}
        />
      </Row>
    </Section>
  );
}

function AboutPage({ host }: { host: Host }) {
  const { snapshot, loading, load } = useSnapshot();
  const { state: copyState, copy } = useCopy();
  const build = snapshot?.build ?? null;
  const mesh = snapshot?.mesh ?? null;
  const broker = mesh?.health.build ?? null;
  const localHost = mesh?.localNode ? mesh.nodes[mesh.localNode.id]?.host : undefined;
  const app = host.snapshot?.host ?? null;

  return (
    <>
      <Section label="Contact & support">
        <Row title="Founder" detail="OpenScout is built by Arach Tchoupani.">
          <a className="sq-button" href="https://openscout.app/contact" target="_blank" rel="noopener noreferrer">Contact the founder ↗</a>
        </Row>
        <Row title="Feedback" detail="Report a bug or share a pilot result in public GitHub issues.">
          <a className="sq-button" href="https://github.com/oscout/scout/issues" target="_blank" rel="noopener noreferrer">Report an issue ↗</a>
        </Row>
        <Row title="Privacy" detail="How OpenScout handles your data.">
          <a className="sq-button" href="https://openscout.app/privacy" target="_blank" rel="noopener noreferrer">Privacy ↗</a>
        </Row>
      </Section>
      <UpdateSection host={host} />
      <Section label="Scout">
        {app ? <Fact k="App" v={`${app.appVersion}${app.build ? ` (${app.build})` : ""}`} /> : null}
        <Fact k="Web" v={build ? `${build.version ?? "unknown"} · ${build.mode}` : loading ? "…" : "not reported"} />
        <Fact k="Source" v={sourceIdentity(build?.branch, build?.commit, build?.dirty === true)} />
        <Fact k="Server" v={build?.server ? `${build.server.engine} ${build.server.engineVersion}` : "not reported"} />
      </Section>
      <Section label="Broker">
        <Fact k="Version" v={broker?.version ?? "not reported"} />
        <Fact k="Source" v={sourceIdentity(broker?.branch, broker?.commit)} />
        <Fact k="Build" v={broker?.buildNumber ?? broker?.buildId ?? "not reported"} />
        <Fact k="Node" v={mesh?.health.nodeId ?? "not reported"} />
      </Section>
      <Section
        label="This Mac"
        note={copyState === "error" ? "Clipboard access was denied." : "Versions are shown only when a part reports them. Scout never guesses one from a nearby checkout."}
      >
        <Fact
          k="Host"
          v={[app?.machineName ?? mesh?.localNode?.name, app?.osVersion ?? localHost?.os].filter(Boolean).join(" · ") || "not reported"}
        />
        {!app ? <Fact k="Browser" v={window.location.origin} /> : null}
        <Row title="Troubleshooting report" detail="Everything above as one block of text.">
          <Button quiet disabled={loading} onClick={() => void load(true)}>Refresh</Button>
          <Button disabled={!snapshot} onClick={() => snapshot && copy(report(snapshot, host.snapshot))}>
            {copyState === "copied" ? "Copied" : "Copy"}
          </Button>
        </Row>
      </Section>
    </>
  );
}

/* ── the window ─────────────────────────────────────────────────────────── */

export function ScoutSettings({
  section,
  onSectionChange,
  navigate,
  frame = "card",
  inset = false,
}: {
  section: ScoutSettingsSection;
  onSectionChange: (section: ScoutSettingsSection) => void;
  navigate: (route: Route) => void;
  /** "flat" when the host already draws the stage card around the page */
  frame?: "card" | "flat";
  /** leave room for window controls (the menu's Settings window) */
  inset?: boolean;
}) {
  const host = useHost();
  const profileState = useProfile();
  // Host pages need a host that owns them: the menu's window has no terminals.
  const hostTerminal = host.snapshot?.terminal;
  const pages = useMemo(
    () => PAGES.filter((page) => !page.hostOnly || (host.available && hostTerminal !== null)),
    [host.available, hostTerminal],
  );
  const def = pages.find((page) => page.id === section) ?? pages[0]!;
  const update = host.snapshot?.update ?? null;
  const version = host.snapshot?.host.appVersion ?? null;

  // ⌘1–9 switch pages. Only the Scout app gets them: a browser keeps those
  // keys for its tabs, so the sidebar shows them only where they work.
  useEffect(() => {
    if (!host.available) return;
    const onKey = (event: KeyboardEvent) => {
      if (!event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return;
      const index = Number(event.key) - 1;
      if (!Number.isInteger(index) || index < 0 || index > 8 || !pages[index]) return;
      event.preventDefault();
      onSectionChange(pages[index]!.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [host.available, onSectionChange, pages]);

  const mainRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [def.id]);

  const profilePage = def.id === "operator" || def.id === "comms";

  return (
    <div className="sq-win" data-frame={frame} data-inset={inset || undefined}>
      <aside className="sq-side">
        <div className="sq-side-eyebrow">Settings</div>
        <nav className="sq-nav" aria-label="Settings pages">
          {pages.map((page, index) => {
            const Icon = page.icon;
            return (
              <a
                key={page.id}
                className="sq-nav-row"
                title={page.title}
                href={routePath({ view: "settings", section: page.id })}
                aria-current={page.id === def.id ? "page" : undefined}
                onClick={(event) => {
                  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                  event.preventDefault();
                  onSectionChange(page.id);
                }}
              >
                <Icon className="sq-nav-icon" strokeWidth={1.6} aria-hidden />
                <span className="sq-nav-label">{page.title}</span>
                {host.available && index < 9 ? <span className="sq-nav-key">⌘{index + 1}</span> : null}
              </a>
            );
          })}
        </nav>
        <div className="sq-foot">
          {/* In the Scout app its own sidebar already carries this pill. */}
          {update?.availableVersion && host.snapshot?.host.surface !== "app" ? (
            <button
              type="button"
              className="sq-update"
              onClick={() => void host.run(async () => { await hostSettings.installUpdate(); return null; })}
            >
              <ArrowUpCircle aria-hidden strokeWidth={1.8} />
              <span>
                Update to {update.availableVersion}
                <small>Restarts Scout</small>
              </span>
            </button>
          ) : null}
          <div className="sq-brand">
            <ScoutMark />
            <span className="sq-brand-name">Scout</span>
            {version ? <span className="sq-brand-version">{version}</span> : null}
          </div>
        </div>
      </aside>

      <main className="sq-main" ref={mainRef}>
        <div className="sq-page" key={def.id}>
          <div className="sq-head">
            <h1 className="sq-title">{def.title}</h1>
            {profilePage && profileState.loaded ? (
              <span className="sq-save" data-state={profileState.saveState} role="status" aria-live="polite">
                {profileState.saveState === "saving" ? "Saving" : profileState.saveState === "error" ? "Not saved" : "Saved"}
              </span>
            ) : null}
          </div>
          <p className="sq-promise">{def.promise}</p>
          <div className="sq-sections">
            {host.error ? <Note error>{host.error}</Note> : null}
            {profilePage && !profileState.loaded ? (
              <Section label={def.title}>
                <div className="sq-empty">Loading…</div>
              </Section>
            ) : def.id === "appearance" ? <AppearancePage host={host} />
              : def.id === "operator" ? <OperatorPage {...profileState} />
                : def.id === "comms" ? <CommsPage {...profileState} host={host} />
                  : def.id === "voice" ? <VoicePage host={host} />
                    : def.id === "terminal" ? <TerminalPage host={host} />
                      : def.id === "credentials" ? <KeysPage />
                        : def.id === "assistants" ? <AssistantsPage />
                        : def.id === "devices" ? <DevicesPage navigate={navigate} />
                          : def.id === "mesh" ? <MeshPage host={host} />
                          : def.id === "pro" ? <SoloProPage navigate={navigate} />
                            : def.id === "system" ? <SystemPage host={host} />
                              : <AboutPage host={host} />}
          </div>
        </div>
      </main>
    </div>
  );
}

/* ── embed: /embed/settings?section=…&frame=flat|card&inset=1 ─────────── */

export function SettingsEmbedScreen({
  navigate,
  section: initial,
  frame,
  inset,
}: {
  navigate: (route: Route) => void;
  embedded?: boolean;
  section?: ScoutSettingsSection;
  frame?: "card" | "flat";
  inset?: boolean;
}) {
  const [section, setSection] = useState<ScoutSettingsSection>(initial ?? "appearance");
  useEffect(() => {
    if (initial) setSection(initial);
  }, [initial]);
  const change = useCallback((next: ScoutSettingsSection) => {
    setSection(next);
    // Keep the section in the URL so a reload lands on the same page, without
    // handing the change to the native host as navigation.
    const url = new URL(window.location.href);
    url.searchParams.set("section", next);
    window.history.replaceState(window.history.state, "", url);
  }, []);
  const settings = <ScoutSettings section={section} onSectionChange={change} navigate={navigate} frame={frame} inset={inset} />;
  // Opened without a section, the page is the Mac app's first-run window: it
  // shows setup until the canonical record is completed or skipped. Hosts that
  // ask for a page (the menu's Settings window always does) go straight there.
  const [gated] = useState(() => initial === undefined);
  return gated ? <OnboardingEmbedGate>{settings}</OnboardingEmbedGate> : settings;
}

export const scoutSurface = defineSurface({
  id: "settings",
  label: "Settings",
  route: { view: "settings" },
  webPath: "/settings",
  screen: "SettingsEmbedScreen",
  embed: {
    path: "/embed/settings",
    profile: "macos.settings",
    rootClassName: "sq-embed",
    chrome: { showSecondaryNav: false, showPageStatusBar: false },
    hosts: { macos: true },
    resolveEmbedProps: (params) => {
      const section = params.get("section");
      return {
        section: section === "keys" ? "credentials" : isScoutSettingsSection(section) ? section : undefined,
        frame: params.get("frame") === "card" ? "card" : "flat",
        inset: params.get("inset") === "1",
      };
    },
  },
});
