export type StudioInjectionMode = "before" | "after";

export interface StudioInjectionState {
  enabled: boolean;
  mode: StudioInjectionMode;
}

interface ResolveStudioInjectionStateInput {
  studyId: string;
  aliases?: string[];
  href?: string;
  storedEnabled?: string | null;
  storedMode?: string | null;
  dev: boolean;
  defaultMode?: StudioInjectionMode;
}

const DISABLED_VALUES = new Set(["0", "false", "off", "no", "clear", "none"]);
const ENABLED_VALUES = new Set(["1", "true", "on", "yes"]);
const LOCAL_STUDIO_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function normalizeHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function normalizeMode(value: string | null | undefined): StudioInjectionMode | null {
  const normalized = value?.trim().toLowerCase();
  return normalized === "before" || normalized === "after" ? normalized : null;
}

function parseBooleanish(value: string | null | undefined): boolean | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (ENABLED_VALUES.has(normalized)) return true;
  if (DISABLED_VALUES.has(normalized)) return false;
  return null;
}

function studioParamMatches(
  value: string | null | undefined,
  studyId: string,
  aliases: string[] = [],
): boolean | null {
  const direct = parseBooleanish(value);
  if (direct !== null) return direct;
  if (!value) return null;

  const normalizedStudyId = studyId.toLowerCase();
  const matchers = new Set([
    normalizedStudyId,
    normalizedStudyId.replace(/-/g, ""),
    ...aliases.map((alias) => alias.trim().toLowerCase()).filter(Boolean),
  ]);
  const tokens = value
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.some((token) => DISABLED_VALUES.has(token))) return false;
  if (tokens.some((token) => matchers.has(token))) return true;
  return null;
}

export function resolveStudioInjectionState({
  studyId,
  aliases,
  href,
  storedEnabled,
  storedMode,
  dev,
  defaultMode = "after",
}: ResolveStudioInjectionStateInput): StudioInjectionState {
  const url = href ? new URL(href, "http://localhost") : null;
  const urlEnabled =
    studioParamMatches(url?.searchParams.get("studio"), studyId, aliases) ??
    studioParamMatches(url?.searchParams.get(`studio.${studyId}`), studyId, aliases) ??
    studioParamMatches(url?.searchParams.get("studioInjection"), studyId, aliases);
  const localRuntime = url ? LOCAL_STUDIO_HOSTS.has(normalizeHostname(url.hostname)) : false;
  if (!dev && !localRuntime) return { enabled: false, mode: defaultMode };

  const enabled = urlEnabled ?? parseBooleanish(storedEnabled) ?? false;
  const mode =
    normalizeMode(url?.searchParams.get("studioMode")) ??
    normalizeMode(url?.searchParams.get(`studioMode.${studyId}`)) ??
    normalizeMode(storedMode) ??
    defaultMode;

  return { enabled, mode };
}
