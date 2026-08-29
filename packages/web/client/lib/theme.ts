import { readScoutBootstrapTheme } from "./runtime-config.ts";
import { matchCastSlug } from "./crew-registry.ts";
export type ScoutTheme = "dark" | "light";
export type ScoutThemePreference = "dark" | "light" | "system";
export type ScoutThemeTemplate = "hudson" | "editorial" | "drafting";
export type ScoutThemePalette = "scout" | "graphite" | "polar" | "solar";
export type ScoutThemeContrast = "soft" | "balanced" | "strong";
export type ScoutThemeAccent = "theme" | "lime" | "cyan" | "violet" | "amber";
export type ScoutShellStyle = "scout" | "slack";
export type ScoutAvatarStyle = "crew" | "sprite" | "chip";
/**
 * How big avatars are drawn wherever the placement owns the box.
 *
 * A named tier rather than a pixel value: an avatar is not one box but a
 * ladder of them (rail pip, list row, inspector tile, graph node), and the
 * operator is expressing a density preference, not a measurement.
 */
export type ScoutAvatarSize = "compact" | "regular" | "large";

export type ScoutAgentCharacterIdentity = {
  id: string;
  name: string;
};

/**
 * Character choices are durable identity data. New choices are keyed by the
 * broker-owned agent id; the legacy name map is retained only long enough to
 * migrate a choice when exactly one known agent owns that display name.
 */
export type ScoutAgentCharacterAssignments = {
  byId: Record<string, string>;
  legacyByName: Record<string, string>;
};

export interface ScoutAppearanceDetails {
  shell: ScoutShellStyle;
  palette: ScoutThemePalette;
  contrast: ScoutThemeContrast;
  accent: ScoutThemeAccent;
  avatarStyle: ScoutAvatarStyle;
  avatarSize: ScoutAvatarSize;
  operatorCharacter: string;
  /** Per-agent cast assignments, keyed by durable agent identity. */
  agentCharacters: ScoutAgentCharacterAssignments;
}

export const SCOUT_THEME_STORAGE_KEY = "openscout.theme";
export const SCOUT_DEFAULT_THEME_TEMPLATE: ScoutThemeTemplate = "hudson";
export const SCOUT_DEFAULT_APPEARANCE_DETAILS: ScoutAppearanceDetails = {
  shell: "scout",
  palette: "scout",
  contrast: "balanced",
  accent: "theme",
  avatarStyle: "crew",
  avatarSize: "regular",
  operatorCharacter: "milo",
  agentCharacters: { byId: {}, legacyByName: {} },
};

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeAgentCharacterMap(
  value: Record<string, unknown> | null | undefined,
  normalizeKey: (key: string) => string,
): Record<string, string> {
  if (!value) return {};
  const out: Record<string, string> = {};
  for (const [key, slug] of Object.entries(value)) {
    const cleanKey = normalizeKey(key);
    const castSlug = typeof slug === "string" ? matchCastSlug(slug) : undefined;
    if (cleanKey && castSlug) out[cleanKey] = castSlug;
  }
  return out;
}

/**
 * Sanitizes both the current id-keyed shape and the original flat name-keyed
 * shape. Invalid cast slugs disappear rather than producing broken artwork.
 */
export function normalizeAgentCharacters(
  value: Record<string, unknown> | null | undefined,
): ScoutAgentCharacterAssignments {
  if (!value) return { byId: {}, legacyByName: {} };

  const nestedById = isUnknownRecord(value.byId) ? value.byId : null;
  const nestedLegacy = isUnknownRecord(value.legacyByName) ? value.legacyByName : null;
  if (nestedById || nestedLegacy) {
    return {
      byId: normalizeAgentCharacterMap(nestedById, (id) => id.trim()),
      legacyByName: normalizeAgentCharacterMap(
        nestedLegacy,
        (name) => name.trim().toLowerCase(),
      ),
    };
  }

  // v1 stored one flat map keyed by lowercased display name.
  return {
    byId: {},
    legacyByName: normalizeAgentCharacterMap(value, (name) => name.trim().toLowerCase()),
  };
}

function normalizedAgentName(name: string): string {
  return name.trim().toLowerCase();
}

export function migrateLegacyAgentCharacters(
  assignments: ScoutAgentCharacterAssignments,
  agents: readonly ScoutAgentCharacterIdentity[],
): ScoutAgentCharacterAssignments {
  const agentsByName = new Map<string, ScoutAgentCharacterIdentity[]>();
  for (const agent of agents) {
    const name = normalizedAgentName(agent.name);
    const id = agent.id.trim();
    if (!name || !id) continue;
    const matches = agentsByName.get(name) ?? [];
    matches.push({ id, name: agent.name });
    agentsByName.set(name, matches);
  }

  let changed = false;
  const byId = { ...assignments.byId };
  const legacyByName = { ...assignments.legacyByName };
  for (const [name, slug] of Object.entries(assignments.legacyByName)) {
    const matches = agentsByName.get(normalizedAgentName(name)) ?? [];
    if (matches.length !== 1) continue;
    const agentId = matches[0]?.id;
    if (!agentId) continue;
    if (!byId[agentId]) byId[agentId] = slug;
    delete legacyByName[name];
    changed = true;
  }

  return changed ? { byId, legacyByName } : assignments;
}

export function resolveAgentCharacterAssignment(
  assignments: ScoutAgentCharacterAssignments | null | undefined,
  identity: { id?: string | null; name: string },
  agents: readonly ScoutAgentCharacterIdentity[],
): string | undefined {
  if (!assignments) return undefined;
  const id = identity.id?.trim();
  if (id && assignments.byId[id]) return assignments.byId[id];

  const name = normalizedAgentName(identity.name);
  if (!name) return undefined;
  const matches = agents.filter((agent) => normalizedAgentName(agent.name) === name);
  if (matches.length !== 1) return undefined;
  const matchedId = matches[0]?.id.trim();
  if (id && matchedId !== id) return undefined;
  return (matchedId ? assignments.byId[matchedId] : undefined)
    ?? assignments.legacyByName[name];
}

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

export function normalizeScoutAvatarStyle(
  value: string | null | undefined,
): ScoutAvatarStyle | null {
  if (value === "crew" || value === "sprite" || value === "chip") {
    return value;
  }
  return null;
}

export function normalizeScoutAvatarSize(
  value: string | null | undefined,
): ScoutAvatarSize | null {
  if (value === "compact" || value === "regular" || value === "large") {
    return value;
  }
  return null;
}

export function normalizeScoutAppearanceDetails(
  value: Partial<Record<keyof ScoutAppearanceDetails, string | Record<string, unknown>>> | null | undefined,
): ScoutAppearanceDetails {
  return {
    shell: normalizeScoutShellStyle(value?.shell as string | null | undefined) ?? SCOUT_DEFAULT_APPEARANCE_DETAILS.shell,
    palette: normalizeScoutThemePalette(value?.palette as string | null | undefined) ?? SCOUT_DEFAULT_APPEARANCE_DETAILS.palette,
    contrast: normalizeScoutThemeContrast(value?.contrast as string | null | undefined) ?? SCOUT_DEFAULT_APPEARANCE_DETAILS.contrast,
    accent: normalizeScoutThemeAccent(value?.accent as string | null | undefined) ?? SCOUT_DEFAULT_APPEARANCE_DETAILS.accent,
    avatarStyle: normalizeScoutAvatarStyle(value?.avatarStyle as string | null | undefined) ?? SCOUT_DEFAULT_APPEARANCE_DETAILS.avatarStyle,
    avatarSize: normalizeScoutAvatarSize(value?.avatarSize as string | null | undefined) ?? SCOUT_DEFAULT_APPEARANCE_DETAILS.avatarSize,
    operatorCharacter: (value?.operatorCharacter as string | null | undefined)?.trim() || SCOUT_DEFAULT_APPEARANCE_DETAILS.operatorCharacter,
    agentCharacters: normalizeAgentCharacters(value?.agentCharacters as Record<string, unknown> | null | undefined),
  };
}

export function readStoredAppearance(): {
  theme?: ScoutThemePreference;
  template?: ScoutThemeTemplate;
  palette?: ScoutThemePalette;
  contrast?: ScoutThemeContrast;
  accent?: ScoutThemeAccent;
  shell?: ScoutShellStyle;
  avatarStyle?: ScoutAvatarStyle;
  avatarSize?: ScoutAvatarSize;
  operatorCharacter?: string;
  agentCharacters?: ScoutAgentCharacterAssignments;
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
      avatarStyle?: string;
      avatarSize?: string;
      operatorCharacter?: string;
      agentCharacters?: Record<string, unknown>;
    };
    return {
      theme: normalizeScoutThemePreference(parsed.theme) ?? undefined,
      template: normalizeScoutThemeTemplate(parsed.template) ?? undefined,
      palette: normalizeScoutThemePalette(parsed.palette) ?? undefined,
      contrast: normalizeScoutThemeContrast(parsed.contrast) ?? undefined,
      accent: normalizeScoutThemeAccent(parsed.accent) ?? undefined,
      shell: normalizeScoutShellStyle(parsed.shell) ?? undefined,
      avatarStyle: normalizeScoutAvatarStyle(parsed.avatarStyle) ?? undefined,
      avatarSize: normalizeScoutAvatarSize(parsed.avatarSize) ?? undefined,
      operatorCharacter: parsed.operatorCharacter?.trim() || undefined,
      agentCharacters: (() => {
        const normalized = normalizeAgentCharacters(parsed.agentCharacters);
        return Object.keys(normalized.byId).length > 0
          || Object.keys(normalized.legacyByName).length > 0
          ? normalized
          : undefined;
      })(),
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

  // No stated preference anywhere: follow the OS rather than forcing dark.
  // localStorage is per-origin and the bootstrap theme rides on /api/bootstrap.js,
  // so a first visit over an mDNS host (scout.local) has neither — and used to
  // land dark next to a light-mode desktop.
  return resolveScoutThemePreference("system");
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
    avatarStyle: normalizeScoutAvatarStyle(query.get("avatarStyle")) ?? stored.avatarStyle,
    avatarSize: normalizeScoutAvatarSize(query.get("avatarSize")) ?? stored.avatarSize,
    operatorCharacter: query.get("operatorCharacter")?.trim() || stored.operatorCharacter,
    agentCharacters: stored.agentCharacters,
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
    const raw = window.localStorage.getItem(SCOUT_THEME_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    const existing = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
    window.localStorage.setItem(SCOUT_THEME_STORAGE_KEY, JSON.stringify({
      ...existing,
      ...details,
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
  document.documentElement.dataset.scoutAvatarStyle = details.avatarStyle;
  document.documentElement.dataset.scoutAvatarSize = details.avatarSize;
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
