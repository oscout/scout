import { readScoutBootstrapTheme } from "./runtime-config.ts";

export type ScoutTheme = "dark" | "light";
export type ScoutThemePreference = "dark" | "light" | "system";
export type ScoutThemeTemplate = "hudson" | "editorial" | "drafting";
export type ScoutThemePalette = "scout" | "graphite" | "polar" | "solar";
export type ScoutThemeContrast = "soft" | "balanced" | "strong";
export type ScoutThemeAccent = "theme" | "lime" | "cyan" | "violet" | "amber";
export type ScoutShellStyle = "scout" | "slack";

export interface ScoutAppearanceDetails {
  shell: ScoutShellStyle;
  palette: ScoutThemePalette;
  contrast: ScoutThemeContrast;
  accent: ScoutThemeAccent;
}

export const SCOUT_THEME_STORAGE_KEY = "openscout.theme";
export const SCOUT_DEFAULT_THEME_TEMPLATE: ScoutThemeTemplate = "hudson";
export const SCOUT_DEFAULT_APPEARANCE_DETAILS: ScoutAppearanceDetails = {
  shell: "scout",
  palette: "scout",
  contrast: "balanced",
  accent: "theme",
};

export function normalizeScoutThemePreference(
  value: string | null | undefined,
): ScoutThemePreference | null {
  if (value === "dark" || value === "light" || value === "system") {
    return value;
  }

  return null;
}

export function normalizeScoutThemeTemplate(
  value: string | null | undefined,
): ScoutThemeTemplate | null {
  if (value === "hudson" || value === "editorial" || value === "drafting") {
    return value;
  }

  return null;
}

export function normalizeScoutThemePalette(
  value: string | null | undefined,
): ScoutThemePalette | null {
  if (value === "scout" || value === "graphite" || value === "polar" || value === "solar") {
    return value;
  }

  return null;
}

export function normalizeScoutThemeContrast(
  value: string | null | undefined,
): ScoutThemeContrast | null {
  if (value === "soft" || value === "balanced" || value === "strong") {
    return value;
  }

  return null;
}

export function normalizeScoutThemeAccent(
  value: string | null | undefined,
): ScoutThemeAccent | null {
  if (value === "theme" || value === "lime" || value === "cyan" || value === "violet" || value === "amber") {
    return value;
  }

  return null;
}

export function normalizeScoutShellStyle(
  value: string | null | undefined,
): ScoutShellStyle | null {
  if (value === "scout" || value === "slack") {
    return value;
  }

  return null;
}

export function normalizeScoutAppearanceDetails(
  value: Partial<Record<keyof ScoutAppearanceDetails, string>> | null | undefined,
): ScoutAppearanceDetails {
  return {
    shell: normalizeScoutShellStyle(value?.shell) ?? SCOUT_DEFAULT_APPEARANCE_DETAILS.shell,
    palette: normalizeScoutThemePalette(value?.palette) ?? SCOUT_DEFAULT_APPEARANCE_DETAILS.palette,
    contrast: normalizeScoutThemeContrast(value?.contrast) ?? SCOUT_DEFAULT_APPEARANCE_DETAILS.contrast,
    accent: normalizeScoutThemeAccent(value?.accent) ?? SCOUT_DEFAULT_APPEARANCE_DETAILS.accent,
  };
}

export function readStoredAppearance(): {
  theme?: ScoutThemePreference;
  template?: ScoutThemeTemplate;
  palette?: ScoutThemePalette;
  contrast?: ScoutThemeContrast;
  accent?: ScoutThemeAccent;
  shell?: ScoutShellStyle;
} {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SCOUT_THEME_STORAGE_KEY) || "{}") as {
      theme?: string;
      template?: string;
      palette?: string;
      contrast?: string;
      accent?: string;
      shell?: string;
    };
    return {
      theme: normalizeScoutThemePreference(parsed.theme) ?? undefined,
      template: normalizeScoutThemeTemplate(parsed.template) ?? undefined,
      palette: normalizeScoutThemePalette(parsed.palette) ?? undefined,
      contrast: normalizeScoutThemeContrast(parsed.contrast) ?? undefined,
      accent: normalizeScoutThemeAccent(parsed.accent) ?? undefined,
      shell: normalizeScoutShellStyle(parsed.shell) ?? undefined,
    };
  } catch {
    return {};
  }
}

export function resolveScoutThemePreference(
  preference: ScoutThemePreference,
  prefersDark = typeof window !== "undefined"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : true,
): ScoutTheme {
  if (preference === "system") return prefersDark ? "dark" : "light";
  return preference;
}

export function resolveScoutStartupTheme(): ScoutTheme {
  if (typeof window === "undefined") {
    return "dark";
  }

  const queryTheme = normalizeScoutThemePreference(
    new URLSearchParams(window.location.search).get("theme"),
  );
  if (queryTheme) {
    return resolveScoutThemePreference(queryTheme);
  }

  const storedTheme = readStoredAppearance().theme;
  if (storedTheme) {
    return resolveScoutThemePreference(storedTheme);
  }

  const bootstrapTheme = normalizeScoutThemePreference(readScoutBootstrapTheme());
  if (bootstrapTheme) {
    return resolveScoutThemePreference(bootstrapTheme);
  }

  return "dark";
}

export function resolveScoutStartupTemplate(): ScoutThemeTemplate {
  if (typeof window === "undefined") return SCOUT_DEFAULT_THEME_TEMPLATE;
  const queryTemplate = normalizeScoutThemeTemplate(
    new URLSearchParams(window.location.search).get("template"),
  );
  return queryTemplate
    ?? readStoredAppearance().template
    ?? SCOUT_DEFAULT_THEME_TEMPLATE;
}

export function resolveScoutStartupAppearanceDetails(): ScoutAppearanceDetails {
  if (typeof window === "undefined") return SCOUT_DEFAULT_APPEARANCE_DETAILS;
  const query = new URLSearchParams(window.location.search);
  const stored = readStoredAppearance();
  return normalizeScoutAppearanceDetails({
    shell: normalizeScoutShellStyle(query.get("shell")) ?? stored.shell,
    palette: normalizeScoutThemePalette(query.get("palette")) ?? stored.palette,
    contrast: normalizeScoutThemeContrast(query.get("contrast")) ?? stored.contrast,
    accent: normalizeScoutThemeAccent(query.get("accent")) ?? stored.accent,
  });
}

function hasAppearanceUrlOverride(): boolean {
  if (typeof window === "undefined") return false;
  const query = new URLSearchParams(window.location.search);
  return Boolean(
    normalizeScoutThemePalette(query.get("palette"))
    || normalizeScoutThemeContrast(query.get("contrast"))
    || normalizeScoutThemeAccent(query.get("accent"))
    || normalizeScoutShellStyle(query.get("shell")),
  );
}

export function writeScoutAppearanceDetails(details: ScoutAppearanceDetails): void {
  if (typeof window === "undefined" || hasAppearanceUrlOverride()) return;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SCOUT_THEME_STORAGE_KEY) || "{}") as unknown;
    const existing = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
    window.localStorage.setItem(SCOUT_THEME_STORAGE_KEY, JSON.stringify({
      ...existing,
      ...normalizeScoutAppearanceDetails(details),
    }));
  } catch {
    // Appearance remains active in memory when device storage is unavailable.
  }
}

export function applyScoutThemeToDocument(
  theme: ScoutTheme,
  template: string = resolveScoutStartupTemplate(),
  details: ScoutAppearanceDetails = resolveScoutStartupAppearanceDetails(),
): void {
  if (typeof document === "undefined") {
    return;
  }

  document.documentElement.dataset.scoutTheme = theme;
  document.documentElement.dataset.scoutThemeMode = theme;
  document.documentElement.dataset.scoutPalette = details.palette;
  document.documentElement.dataset.scoutContrast = details.contrast;
  document.documentElement.dataset.scoutAccent = details.accent;
  document.documentElement.dataset.scoutShell = details.shell;
  document.documentElement.dataset.hudsonTheme = theme;
  document.documentElement.dataset.hudsonTemplate = template;
  document.documentElement.style.colorScheme = theme;
}

/**
 * Native theme bridge. The macOS app hosts the embed routes in a `WKWebView`
 * and passes its *resolved* palette via `?themeVars=<base64url(JSON)>` so the
 * embed renders with the app's actual surfaces / accent / status colors
 * instead of the generic web light/dark. The map is keyed by `--hud-*` CSS
 * variable names; the Provider layers it over `LIGHT_THEME_VARS` /
 * `DARK_THEME_VARS`. Returns null when absent or malformed (web-standalone).
 */
export function resolveScoutNativeThemeVars(): Record<`--${string}`, string> | null {
  if (typeof window === "undefined") {
    return null;
  }

  const raw = new URLSearchParams(window.location.search).get("themeVars");
  if (!raw) {
    return null;
  }

  try {
    const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const parsed = JSON.parse(atob(padded)) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const vars: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (key.startsWith("--") && typeof value === "string") {
        vars[key] = value;
      }
    }
    return Object.keys(vars).length > 0
      ? (vars as Record<`--${string}`, string>)
      : null;
  } catch {
    return null;
  }
}
