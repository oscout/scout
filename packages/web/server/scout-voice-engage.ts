import {
  getScoutVoiceSettingsSnapshot,
  requestScoutVoicePermissions,
  type ScoutVoiceInputDevice,
  type ScoutVoicePermissionStatus,
  type ScoutVoiceSettings,
} from "./scout-voice-session.ts";

export type ScoutVoiceIssueCode =
  | "host_offline"
  | "microphone_not_requested"
  | "microphone_denied"
  | "speech_not_requested"
  | "speech_denied"
  | "no_input_device"
  | "ready";

export type ScoutVoiceIssueAction =
  | "launch_host"
  | "request_microphone"
  | "open_microphone_settings"
  | "request_speech"
  | "open_speech_settings"
  | "open_voice_settings"
  | "none";

export type ScoutVoiceIssue = {
  code: ScoutVoiceIssueCode;
  title: string;
  message: string;
  hint: string | null;
  action: ScoutVoiceIssueAction;
};

export type ScoutVoiceEngageInput = {
  surface?: string;
  /** When true, queues a native permission prompt on Scout Menu when macOS allows it. */
  requestPermissions?: boolean;
};

export type ScoutVoiceEngageResult = {
  ready: boolean;
  issue: ScoutVoiceIssue | null;
  warnings: ScoutVoiceIssue[];
  settings: ScoutVoiceSettings;
  devices: ScoutVoiceInputDevice[];
  inputDevice: { id: string; name: string } | null;
  hostOnline: boolean;
};

export function engageScoutVoiceDictation(input: ScoutVoiceEngageInput = {}): ScoutVoiceEngageResult {
  const snapshot = getScoutVoiceSettingsSnapshot();
  const settings = snapshot.settings;
  const devices = snapshot.devices;
  const hostOnline = devices.length > 0 || (settings.permissions?.length ?? 0) > 0;

  const mic = settings.permissions?.find((entry) => entry.kind === "microphone") ?? null;
  const speech = settings.permissions?.find((entry) => entry.kind === "speechRecognition") ?? null;
  const inputDevice = resolveInputDevice(settings, devices);

  if (!hostOnline) {
    return buildResult({
      ready: false,
      issue: issueHostOffline(),
      settings,
      devices,
      inputDevice,
      hostOnline,
    });
  }

  if (input.requestPermissions) {
    // This is an explicit user gesture. Scout Menu presents the first-run
    // consent sheet or, after a denial, opens the app-specific privacy pane
    // and watches for the permission to change.
    if (mic && !mic.granted && mic.status !== "restricted") {
      requestScoutVoicePermissions("microphone");
    } else if ((mic?.granted ?? false) && speech && !speech.granted && speech.status !== "restricted") {
      requestScoutVoicePermissions("speechRecognition");
    }
  }

  const micIssue = microphoneIssue(mic);
  if (micIssue) {
    return buildResult({
      ready: false,
      issue: micIssue,
      settings,
      devices,
      inputDevice,
      hostOnline,
    });
  }

  if (!inputDevice) {
    return buildResult({
      ready: false,
      issue: issueNoInputDevice(),
      settings,
      devices,
      inputDevice: null,
      hostOnline,
    });
  }

  const warnings = [
    speechRecognitionIssue(speech),
  ].filter((entry): entry is ScoutVoiceIssue => entry !== null);

  return buildResult({
    ready: true,
    issue: null,
    warnings,
    settings,
    devices,
    inputDevice,
    hostOnline,
  });
}

export function resolveInputDevice(
  settings: ScoutVoiceSettings,
  devices: ScoutVoiceInputDevice[],
): { id: string; name: string } | null {
  if (devices.length === 0) return null;
  const selected = settings.inputDeviceId
    ? devices.find((device) => device.id === settings.inputDeviceId)
    : null;
  const fallback = devices.find((device) => device.isDefault) ?? devices[0] ?? null;
  const device = selected ?? fallback;
  if (!device) return null;
  return { id: device.id, name: device.name };
}

function buildResult(
  input: Omit<ScoutVoiceEngageResult, "issue" | "warnings"> & {
    issue: ScoutVoiceIssue | null;
    warnings?: ScoutVoiceIssue[];
  },
): ScoutVoiceEngageResult {
  return {
    ...input,
    warnings: input.warnings ?? [],
  };
}

function issueHostOffline(): ScoutVoiceIssue {
  return {
    code: "host_offline",
    title: "Scout Menu is not running",
    message: "Launch Scout Menu on this Mac to dictate in web chat.",
    hint: "The browser never records audio. Scout Menu is the voice host.",
    action: "launch_host",
  };
}

function microphoneIssue(permission: ScoutVoicePermissionStatus | null): ScoutVoiceIssue | null {
  if (!permission || permission.granted) return null;
  if (permission.canRequest) {
    return {
      code: "microphone_not_requested",
      title: "Microphone access needed",
      message: "Scout Menu needs microphone access before dictation can start.",
      hint: "Request access or tap the mic again to show the macOS prompt.",
      action: "request_microphone",
    };
  }
  if (permission.status === "denied") {
    return {
      code: "microphone_denied",
      title: "Microphone blocked",
      message: "Scout Menu cannot record because microphone access is off.",
      hint: "Scout is opening macOS Microphone settings and will detect the change automatically.",
      action: "open_microphone_settings",
    };
  }
  return {
    code: "microphone_denied",
    title: "Microphone unavailable",
    message: "Scout Menu cannot access the microphone on this Mac.",
    hint: "Open Privacy & Security → Microphone to review it.",
    action: "open_microphone_settings",
  };
}

function speechRecognitionIssue(permission: ScoutVoicePermissionStatus | null): ScoutVoiceIssue | null {
  if (!permission || permission.granted) return null;
  if (permission.canRequest) {
    return {
      code: "speech_not_requested",
      title: "Speech recognition needed",
      message: "Scout Menu needs speech recognition for live partials and Apple Speech fallback.",
      hint: "Request access to show the macOS prompt.",
      action: "request_speech",
    };
  }
  return {
    code: "speech_denied",
    title: "Speech recognition blocked",
    message: "Speech recognition is off for Scout Menu.",
    hint: "Choose Retry access to reopen macOS Speech Recognition settings.",
    action: "open_speech_settings",
  };
}

function issueNoInputDevice(): ScoutVoiceIssue {
  return {
    code: "no_input_device",
    title: "No microphone detected",
    message: "Scout Menu did not report any audio input devices.",
    hint: "Plug in a microphone, check Sound settings, then refresh Settings → Voice.",
    action: "open_voice_settings",
  };
}
