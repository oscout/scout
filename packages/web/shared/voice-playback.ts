// Kept shared so the browser request, the Hono route, and Settings stay on
// the same contract for where web-originated speech is heard.
export const SCOUT_VOICE_PLAYBACK_SETTINGS_PATH = "/api/voice/playback/settings";
export const SCOUT_VOICE_PLAYBACK_SETTINGS_EVENT = "scout:voice-playback-settings";
export const SCOUT_VOICE_PLAYBACK_ENV = "OPENSCOUT_VOICE_PLAYBACK";

/**
 * Where a `/api/voice/speak` request is heard.
 *
 * - `browser`: Scout Menu renders audio bytes and the requesting page plays them.
 * - `host`: Scout Menu speaks live on the Mac through its own playback path,
 *   which honors provider-extension voices (Kokoro) that cannot be rendered
 *   to bytes, and uses the Mac's own Settings › Voice choice by default.
 */
export type ScoutVoicePlayback = "browser" | "host";

export const SCOUT_VOICE_PLAYBACK_DEFAULT: ScoutVoicePlayback = "browser";

export type ScoutVoicePlaybackSettings = {
  /** Effective mode after applying an optional environment override. */
  playback: ScoutVoicePlayback;
  /** The operator's persisted preference. */
  configuredPlayback: ScoutVoicePlayback;
  /** Where the effective mode came from. */
  source: "settings" | "environment";
  /** Environment-controlled modes cannot be changed from Settings. */
  locked: boolean;
};

export function parseScoutVoicePlayback(value: unknown): ScoutVoicePlayback | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized === "browser" || normalized === "host" ? normalized : null;
}

export function isScoutVoicePlaybackSettings(value: unknown): value is ScoutVoicePlaybackSettings {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ScoutVoicePlaybackSettings>;
  return parseScoutVoicePlayback(candidate.playback) === candidate.playback
    && parseScoutVoicePlayback(candidate.configuredPlayback) === candidate.configuredPlayback
    && (candidate.source === "settings" || candidate.source === "environment")
    && typeof candidate.locked === "boolean";
}
