export type ScoutVoiceCaptureState =
  | "unavailable"
  | "off"
  | "idle"
  | "connecting"
  | "recording"
  | "processing"
  | "error";

export type ScoutVoiceBridgeStatus = {
  captureState: ScoutVoiceCaptureState;
  speaking: boolean;
  voxAvailable: boolean;
  oraAvailable: boolean;
  detail: string | null;
};

export type ScoutVoiceState = {
  captureState: ScoutVoiceCaptureState;
  captureTitle: string;
  repliesEnabled: boolean;
  detail: string;
  isCapturing: boolean;
  speaking: boolean;
};

export function normalizeScoutVoiceCaptureState(value: unknown): ScoutVoiceCaptureState {
  const normalized = typeof value === "string" ? value : "";

  switch (normalized) {
    case "unavailable":
    case "off":
    case "idle":
    case "connecting":
    case "recording":
    case "processing":
    case "error":
      return normalized;
    default:
      return "off";
  }
}

export function isScoutVoiceCaptureActive(captureState: ScoutVoiceCaptureState): boolean {
  return captureState === "connecting" || captureState === "recording" || captureState === "processing";
}

export function scoutVoiceCaptureTitle(captureState: ScoutVoiceCaptureState): string {
  switch (captureState) {
    case "connecting":
      return "Connecting";
    case "recording":
    case "processing":
      return "Stop";
    default:
      return "Listen";
  }
}

export function createScoutVoiceBridgeStatus(
  input: Partial<ScoutVoiceBridgeStatus> = {},
): ScoutVoiceBridgeStatus {
  return {
    captureState: normalizeScoutVoiceCaptureState(input.captureState),
    speaking: Boolean(input.speaking),
    voxAvailable: Boolean(input.voxAvailable),
    oraAvailable: Boolean(input.oraAvailable),
    detail: typeof input.detail === "string" ? input.detail : null,
  };
}

export function createScoutVoiceState(input: {
  bridgeStatus?: Partial<ScoutVoiceBridgeStatus>;
  repliesEnabled?: boolean;
} = {}): ScoutVoiceState {
  const bridgeStatus = createScoutVoiceBridgeStatus(input.bridgeStatus ?? {});
  const repliesEnabled = Boolean(input.repliesEnabled);

  return {
    captureState: bridgeStatus.captureState,
    captureTitle: scoutVoiceCaptureTitle(bridgeStatus.captureState),
    repliesEnabled,
    detail: bridgeStatus.detail ?? (repliesEnabled ? "Playback ready." : "Voice playback is off."),
    isCapturing: isScoutVoiceCaptureActive(bridgeStatus.captureState),
    speaking: bridgeStatus.speaking,
  };
}
