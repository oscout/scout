import {
  SCOUT_VOICE_PLAYBACK_SETTINGS_EVENT,
  SCOUT_VOICE_PLAYBACK_SETTINGS_PATH,
  isScoutVoicePlaybackSettings,
  type ScoutVoicePlayback,
  type ScoutVoicePlaybackSettings,
} from "../../shared/voice-playback.ts";
import { api } from "./api.ts";

const SETTINGS_CHANNEL = "openscout.voice-playback-settings";

export function fetchScoutVoicePlaybackSettings(
  signal?: AbortSignal,
): Promise<ScoutVoicePlaybackSettings> {
  return api<ScoutVoicePlaybackSettings>(SCOUT_VOICE_PLAYBACK_SETTINGS_PATH, {
    signal,
    cache: "no-store",
  });
}

export function saveScoutVoicePlaybackSettings(
  playback: ScoutVoicePlayback,
): Promise<ScoutVoicePlaybackSettings> {
  return api<ScoutVoicePlaybackSettings>(SCOUT_VOICE_PLAYBACK_SETTINGS_PATH, {
    method: "PUT",
    body: JSON.stringify({ playback }),
  });
}

export function publishScoutVoicePlaybackSettings(
  settings: ScoutVoicePlaybackSettings,
): void {
  window.dispatchEvent(new CustomEvent<ScoutVoicePlaybackSettings>(
    SCOUT_VOICE_PLAYBACK_SETTINGS_EVENT,
    { detail: settings },
  ));
  if (!("BroadcastChannel" in window)) return;
  const channel = new BroadcastChannel(SETTINGS_CHANNEL);
  channel.postMessage(settings);
  channel.close();
}

export function subscribeScoutVoicePlaybackSettings(
  listener: (settings: ScoutVoicePlaybackSettings) => void,
): () => void {
  const onWindowEvent = (event: Event) => {
    const settings = (event as CustomEvent<ScoutVoicePlaybackSettings>).detail;
    if (isScoutVoicePlaybackSettings(settings)) listener(settings);
  };
  window.addEventListener(SCOUT_VOICE_PLAYBACK_SETTINGS_EVENT, onWindowEvent);

  const channel = "BroadcastChannel" in window
    ? new BroadcastChannel(SETTINGS_CHANNEL)
    : null;
  if (channel) {
    channel.onmessage = (event) => {
      if (isScoutVoicePlaybackSettings(event.data)) listener(event.data);
    };
  }

  return () => {
    window.removeEventListener(SCOUT_VOICE_PLAYBACK_SETTINGS_EVENT, onWindowEvent);
    channel?.close();
  };
}
