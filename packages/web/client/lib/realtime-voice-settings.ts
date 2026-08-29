import {
  SCOUT_REALTIME_VOICE_SETTINGS_EVENT,
  SCOUT_REALTIME_VOICE_SETTINGS_PATH,
  type ScoutRealtimeVoiceSettings,
} from "../../shared/realtime-voice.ts";
import { api } from "./api.ts";

const SETTINGS_CHANNEL = "openscout.realtime-voice-settings";

export function fetchScoutRealtimeVoiceSettings(
  signal?: AbortSignal,
): Promise<ScoutRealtimeVoiceSettings> {
  return api<ScoutRealtimeVoiceSettings>(SCOUT_REALTIME_VOICE_SETTINGS_PATH, {
    signal,
    cache: "no-store",
  });
}

export function saveScoutRealtimeVoiceSettings(
  enabled: boolean,
): Promise<ScoutRealtimeVoiceSettings> {
  return api<ScoutRealtimeVoiceSettings>(SCOUT_REALTIME_VOICE_SETTINGS_PATH, {
    method: "PUT",
    body: JSON.stringify({ enabled }),
  });
}

export function publishScoutRealtimeVoiceSettings(
  settings: ScoutRealtimeVoiceSettings,
): void {
  window.dispatchEvent(new CustomEvent<ScoutRealtimeVoiceSettings>(
    SCOUT_REALTIME_VOICE_SETTINGS_EVENT,
    { detail: settings },
  ));
  if (!("BroadcastChannel" in window)) return;
  const channel = new BroadcastChannel(SETTINGS_CHANNEL);
  channel.postMessage(settings);
  channel.close();
}

export function subscribeScoutRealtimeVoiceSettings(
  listener: (settings: ScoutRealtimeVoiceSettings) => void,
): () => void {
  const onWindowEvent = (event: Event) => {
    const settings = (event as CustomEvent<ScoutRealtimeVoiceSettings>).detail;
    if (isScoutRealtimeVoiceSettings(settings)) listener(settings);
  };
  window.addEventListener(SCOUT_REALTIME_VOICE_SETTINGS_EVENT, onWindowEvent);

  const channel = "BroadcastChannel" in window
    ? new BroadcastChannel(SETTINGS_CHANNEL)
    : null;
  if (channel) {
    channel.onmessage = (event) => {
      if (isScoutRealtimeVoiceSettings(event.data)) listener(event.data);
    };
  }

  return () => {
    window.removeEventListener(SCOUT_REALTIME_VOICE_SETTINGS_EVENT, onWindowEvent);
    channel?.close();
  };
}

function isScoutRealtimeVoiceSettings(value: unknown): value is ScoutRealtimeVoiceSettings {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ScoutRealtimeVoiceSettings>;
  return typeof candidate.enabled === "boolean"
    && typeof candidate.configuredEnabled === "boolean"
    && (candidate.source === "settings" || candidate.source === "environment")
    && typeof candidate.locked === "boolean";
}
