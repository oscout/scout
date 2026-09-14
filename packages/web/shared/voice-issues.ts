/**
 * Voice engagement issues — the one definition.
 *
 * The server (`server/scout-voice-engage.ts`) and the browser fallback
 * (`client/lib/scout-voice.ts`) both decide these, and each used to carry its
 * own copy. They drifted: the same `host_offline` code shipped two
 * contradictory hints, one of which told you to restart the web server — the
 * very thing that empties the host registry and causes it.
 */

export type ScoutVoiceIssueCode =
  | "host_offline"
  | "host_reconnecting"
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
  /** Label for the button that runs `action`. Null when there is nothing to press. */
  actionLabel: string | null;
};

/** Structural stand-in so this module imports from neither side. */
export type ScoutVoicePermissionLike = {
  status: string;
  granted: boolean;
  canRequest: boolean;
};

/**
 * How the voice host registry looks to a caller.
 *
 * `reconnecting` is the honest reading of an empty registry on a web server
 * that just started: the registry is per-process and ScoutMenu re-registers on
 * its own loop, so "nothing registered yet" is not evidence that Scout Menu is
 * not running.
 */
export type ScoutVoiceHostPresence = "connected" | "reconnecting" | "absent";

/**
 * Scout Menu re-registers once per command long-poll (25s), so a web server
 * younger than this has no standing to call the host missing.
 */
export const SCOUT_VOICE_HOST_REGISTRATION_GRACE_MS = 40_000;

export function voiceIssueHostReconnecting(): ScoutVoiceIssue {
  return {
    code: "host_reconnecting",
    title: "Reconnecting to Scout Menu",
    message: "Scout Menu has not checked in recently.",
    hint: "Waiting briefly for Scout Menu to reconnect. Try the mic again in a moment.",
    action: "none",
    actionLabel: null,
  };
}

export function voiceIssueHostOffline(): ScoutVoiceIssue {
  return {
    code: "host_offline",
    // Not "Scout Menu is not running" — all this server knows is that nothing
    // has registered with it. Claiming the app is dead sends you to relaunch an
    // app that is already in your menu bar.
    title: "Scout Menu is not connected",
    message: "No voice host has registered with this web server.",
    hint: "The browser never records audio — Scout Menu is the voice host. If it is already running, this clears on its own; otherwise launch it.",
    action: "launch_host",
    actionLabel: "Launch Scout Menu",
  };
}

export function voiceIssueMicrophone(
  permission: ScoutVoicePermissionLike | null,
): ScoutVoiceIssue | null {
  if (!permission || permission.granted) return null;
  if (permission.canRequest) {
    return {
      code: "microphone_not_requested",
      title: "Microphone access needed",
      message: "Scout Menu needs microphone access before dictation can start.",
      hint: "Request access or tap the mic again to show the macOS prompt.",
      action: "request_microphone",
      actionLabel: "Request access",
    };
  }
  if (permission.status === "denied") {
    return {
      code: "microphone_denied",
      title: "Microphone blocked",
      message: "Scout Menu cannot record because microphone access is off.",
      hint: "Scout is opening macOS Microphone settings and will detect the change automatically.",
      action: "open_microphone_settings",
      actionLabel: "Open Microphone settings",
    };
  }
  return {
    code: "microphone_denied",
    title: "Microphone unavailable",
    message: "Scout Menu cannot access the microphone on this Mac.",
    hint: "Open Privacy & Security → Microphone to review it.",
    action: "open_microphone_settings",
    actionLabel: "Open Microphone settings",
  };
}

export function voiceIssueSpeechRecognition(
  permission: ScoutVoicePermissionLike | null,
): ScoutVoiceIssue | null {
  if (!permission || permission.granted) return null;
  if (permission.canRequest) {
    return {
      code: "speech_not_requested",
      title: "Speech recognition needed",
      message: "Scout Menu needs speech recognition for live partials and Apple Speech fallback.",
      hint: "Request access to show the macOS prompt.",
      action: "request_speech",
      actionLabel: "Request access",
    };
  }
  return {
    code: "speech_denied",
    title: "Speech recognition blocked",
    message: "Speech recognition is off for Scout Menu.",
    hint: "Choose Retry access to reopen macOS Speech Recognition settings.",
    action: "open_speech_settings",
    actionLabel: "Open Speech settings",
  };
}

export function voiceIssueNoInputDevice(): ScoutVoiceIssue {
  return {
    code: "no_input_device",
    title: "No microphone detected",
    message: "Scout Menu did not report any audio input devices.",
    hint: "Plug in a microphone, check Sound settings, then refresh Settings → Voice.",
    action: "open_voice_settings",
    actionLabel: "Open Voice settings",
  };
}

/**
 * Flatten an issue for places that can only take one string (aria-label, a
 * `title` attribute, a thrown Error). Surfaces with room should render
 * `title`, `hint` and the action separately rather than call this.
 */
export function formatScoutVoiceIssue(issue: ScoutVoiceIssue | null | undefined): string {
  if (!issue) return "Scout voice is unavailable.";
  return issue.hint ? `${issue.message} ${issue.hint}` : issue.message;
}
