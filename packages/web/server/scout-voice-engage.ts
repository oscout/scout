import {
  getScoutVoiceSettingsSnapshot,
  requestScoutVoicePermissions,
  scoutVoiceHostPresence,
  type ScoutVoiceInputDevice,
  type ScoutVoiceSettings,
} from "./scout-voice-session.ts";
import {
  voiceIssueHostOffline,
  voiceIssueHostReconnecting,
  voiceIssueMicrophone,
  voiceIssueNoInputDevice,
  voiceIssueSpeechRecognition,
  type ScoutVoiceIssue,
  type ScoutVoiceIssueAction,
  type ScoutVoiceIssueCode,
} from "../shared/voice-issues.ts";

export type { ScoutVoiceIssue, ScoutVoiceIssueAction, ScoutVoiceIssueCode };

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

/** `now` is injectable so the registration grace is testable without waiting it out. */
export function engageScoutVoiceDictation(
  input: ScoutVoiceEngageInput = {},
  now = Date.now(),
): ScoutVoiceEngageResult {
  const snapshot = getScoutVoiceSettingsSnapshot(now);
  const settings = snapshot.settings;
  const devices = snapshot.devices;
  const hostOnline = scoutVoiceHostPresence(now) === "connected";

  const mic = settings.permissions?.find((entry) => entry.kind === "microphone") ?? null;
  const speech = settings.permissions?.find((entry) => entry.kind === "speechRecognition") ?? null;
  const inputDevice = resolveInputDevice(settings, devices);

  if (!hostOnline) {
    // An empty registry is not proof Scout Menu is gone — this process may
    // simply have restarted out from under a host that re-registers on its own
    // loop. Say which of the two we are actually looking at.
    return buildResult({
      ready: false,
      issue: scoutVoiceHostPresence(now) === "absent"
        ? voiceIssueHostOffline()
        : voiceIssueHostReconnecting(),
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

  const micIssue = voiceIssueMicrophone(mic);
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
      issue: voiceIssueNoInputDevice(),
      settings,
      devices,
      inputDevice: null,
      hostOnline,
    });
  }

  const warnings = [
    voiceIssueSpeechRecognition(speech),
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
