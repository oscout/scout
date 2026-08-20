// Kept shared so the browser request and Hono route stay on the same contract.
export const SCOUT_REALTIME_VOICE_CALL_PATH = "/api/voice/realtime/call";
export const SCOUT_REALTIME_VOICE_LEASE_PATH = "/api/voice/realtime/lease";
export const SCOUT_REALTIME_VOICE_LEASE_HEADER = "x-openscout-realtime-voice-lease";
export const SCOUT_REALTIME_VOICE_FLAG = "surface.realtime-voice";
export const SCOUT_REALTIME_VOICE_STOP_EVENT = "scout:realtime-voice-stop";

export const SCOUT_REALTIME_VOICE_FAR_FIELD_INPUT = {
  noise_reduction: { type: "far_field" },
  turn_detection: {
    type: "server_vad",
    threshold: 0.6,
    prefix_padding_ms: 300,
    silence_duration_ms: 500,
    create_response: true,
    interrupt_response: true,
  },
} as const;

export const SCOUT_REALTIME_VOICE_NEAR_FIELD_INPUT = {
  noise_reduction: { type: "near_field" },
  turn_detection: {
    type: "server_vad",
    threshold: 0.5,
    prefix_padding_ms: 300,
    silence_duration_ms: 500,
    create_response: true,
    interrupt_response: true,
  },
} as const;

// The Realtime function handler delegates through the existing Scoutbot control
// loop instead of giving the browser direct access to broker records.
export const SCOUT_REALTIME_SCOUTBOT_CHAT_PATH = "/api/scoutbot/chat";
