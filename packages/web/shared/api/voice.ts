import { z } from "zod";

// Voice routes whose bodies are checked field by field in the route itself
// (realtime enable, playback setting, speech timing) are not listed here.

export const voiceEngageBody = z.object({
  surface: z.string().optional(),
  requestPermissions: z.boolean().optional(),
});
export type VoiceEngageBody = z.input<typeof voiceEngageBody>;

export const voiceSettingsBody = z.object({
  preference: z.enum(["auto", "parakeet", "apple"]).optional(),
  inputDeviceId: z.string().nullable().optional(),
});
export type VoiceSettingsBody = z.input<typeof voiceSettingsBody>;

export const voicePermissionBody = z.object({
  kind: z.enum(["microphone", "speechRecognition"]).optional(),
});
export type VoicePermissionBody = z.input<typeof voicePermissionBody>;

export const voiceHostRegisterBody = z.object({
  hostId: z.string().optional(),
  instanceId: z.string().optional(),
  platform: z.string().optional(),
  bundle: z.string().optional(),
  settings: z.unknown().optional(),
  devices: z.array(z.object({
    id: z.string().optional(),
    name: z.string().optional(),
    isDefault: z.boolean().optional(),
  })).optional(),
  capabilities: z.array(z.string()).optional(),
});
export type VoiceHostRegisterBody = z.input<typeof voiceHostRegisterBody>;

export const VOICE_SESSION_EVENT_NAMES = [
  "session.started",
  "session.state",
  "session.partial",
  "session.final",
  "session.segment",
  "session.error",
  "session.cancelled",
  "speech.started",
  "speech.result",
  "speech.error",
] as const;

export const voiceHostEventBody = z.object({
  hostId: z.string().optional(),
  instanceId: z.string().optional(),
  sessionId: z.string().optional(),
  event: z.enum(VOICE_SESSION_EVENT_NAMES).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});
export type VoiceHostEventBody = z.input<typeof voiceHostEventBody>;

export const voiceAmbientBody = z.object({ enabled: z.boolean() });
export type VoiceAmbientBody = z.input<typeof voiceAmbientBody>;

export const voiceSessionBody = z.object({
  clientId: z.string().optional(),
  surface: z.string().optional(),
  language: z.string().optional(),
  sessionId: z.string().optional(),
});
export type VoiceSessionBody = z.input<typeof voiceSessionBody>;

export const voiceSpeakBody = z.object({
  text: z.string().optional(),
  modelId: z.string().optional(),
  voiceId: z.string().optional(),
  speed: z.number().optional(),
  instructions: z.string().optional(),
  originAppId: z.string().optional(),
  utteranceId: z.string().optional(),
  // Parsed by the route, which owns their error messages.
  speechTiming: z.unknown().optional(),
  playback: z.unknown().optional(),
});
export type VoiceSpeakBody = z.input<typeof voiceSpeakBody>;
