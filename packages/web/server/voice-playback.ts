import {
  SCOUT_VOICE_PLAYBACK_ENV,
  parseScoutVoicePlayback,
  type ScoutVoicePlayback,
  type ScoutVoicePlaybackSettings,
} from "../shared/voice-playback.ts";

/** `OPENSCOUT_VOICE_PLAYBACK=browser|host` pins the mode for a deployment. */
export function scoutVoicePlaybackEnvironmentOverride(
  env: NodeJS.ProcessEnv = process.env,
): ScoutVoicePlayback | null {
  return parseScoutVoicePlayback(env[SCOUT_VOICE_PLAYBACK_ENV]);
}

export function resolveScoutVoicePlaybackSettings(
  configuredPlayback: ScoutVoicePlayback,
  env: NodeJS.ProcessEnv = process.env,
): ScoutVoicePlaybackSettings {
  const environmentOverride = scoutVoicePlaybackEnvironmentOverride(env);
  if (environmentOverride !== null) {
    return {
      playback: environmentOverride,
      configuredPlayback,
      source: "environment",
      locked: true,
    };
  }
  return {
    playback: configuredPlayback,
    configuredPlayback,
    source: "settings",
    locked: false,
  };
}
