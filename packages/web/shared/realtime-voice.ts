// Kept shared so the browser request and Hono route stay on the same contract.
export const SCOUT_REALTIME_VOICE_CALL_PATH = "/api/voice/realtime/call";
export const SCOUT_REALTIME_VOICE_LEASE_PATH = "/api/voice/realtime/lease";
export const SCOUT_REALTIME_VOICE_SETTINGS_PATH = "/api/voice/realtime/settings";
export const SCOUT_REALTIME_VOICE_LEASE_HEADER = "x-openscout-realtime-voice-lease";
export const SCOUT_REALTIME_VOICE_FLAG = "surface.realtime-voice";
export const SCOUT_REALTIME_VOICE_STOP_EVENT = "scout:realtime-voice-stop";
export const SCOUT_REALTIME_VOICE_SETTINGS_EVENT = "scout:realtime-voice-settings";

export type ScoutRealtimeVoiceSettings = {
  /** Effective state after applying an optional environment override. */
  enabled: boolean;
  /** The operator's persisted preference. */
  configuredEnabled: boolean;
  /** Where the effective state came from. */
  source: "settings" | "environment";
  /** Environment-controlled states cannot be changed from Settings. */
  locked: boolean;
  /** The speech-to-speech model a call will use (OPENSCOUT_REALTIME_MODEL). */
  model?: string;
  /** The OpenAI voice a call will speak with (OPENSCOUT_REALTIME_VOICE). */
  voice?: string;
};

// Live is full-duplex and owns turn-taking itself, so there is no server VAD or
// noise-reduction profile to tune per input device. The operator's device choice
// still matters, but only for which microphone getUserMedia opens.

// Live delegations are answered through the existing Scoutbot control loop
// instead of giving the browser direct access to broker records.
export const SCOUT_REALTIME_SCOUTBOT_CHAT_PATH = "/api/scoutbot/chat";
