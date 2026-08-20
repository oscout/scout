export {
  buildScoutVoiceHealthCommand,
  buildScoutVoiceSetRepliesEnabledCommand,
  buildScoutVoiceShutdownCommand,
  buildScoutVoiceSpeakCommand,
  buildScoutVoiceStopSpeakingCommand,
  buildScoutVoiceToggleCaptureCommand,
  createScoutVoiceBridgeStatus as createScoutHostVoiceBridgeStatus,
  createScoutVoiceState as createScoutHostVoiceState,
  isScoutVoiceCaptureActive as isScoutHostVoiceCaptureActive,
  normalizeScoutVoiceCaptureState as normalizeScoutHostVoiceCaptureState,
  scoutVoiceCaptureTitle as scoutHostVoiceCaptureTitle,
  selectScoutVoicePlaybackMessage as selectScoutHostVoicePlaybackMessage,
  type ScoutVoiceBridgeCommand as ScoutHostVoiceBridgeCommand,
  type ScoutVoiceBridgeStatus as ScoutHostVoiceBridgeStatus,
  type ScoutVoiceCaptureState as ScoutHostVoiceCaptureState,
  type ScoutVoicePlaybackInput as ScoutHostVoicePlaybackInput,
  type ScoutVoicePlaybackSelection as ScoutHostVoicePlaybackSelection,
  type ScoutVoiceState as ScoutHostVoiceState,
} from "../../core/voice/index.ts";

import {
  normalizeScoutVoiceCaptureState,
  scoutVoiceCaptureTitle,
  type ScoutVoiceState,
} from "../../core/voice/index.ts";

export function normalizeScoutHostVoiceState(
  input: Partial<Omit<ScoutVoiceState, "captureState">> & { captureState?: string } = {},
): ScoutVoiceState {
  const captureState = normalizeScoutVoiceCaptureState(input.captureState);
  const repliesEnabled = Boolean(input.repliesEnabled);

  return {
    captureState,
    captureTitle: typeof input.captureTitle === "string" && input.captureTitle.trim().length > 0
      ? input.captureTitle
      : scoutVoiceCaptureTitle(captureState),
    repliesEnabled,
    detail: typeof input.detail === "string"
      ? input.detail
      : repliesEnabled
        ? "Playback ready."
        : "Voice playback is off.",
    isCapturing: Boolean(input.isCapturing),
    speaking: Boolean(input.speaking),
  };
}
