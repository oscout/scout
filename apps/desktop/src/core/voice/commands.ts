import {
  isScoutVoiceCaptureActive,
  type ScoutVoiceCaptureState,
} from "./state.ts";

export type ScoutVoiceBridgeCommand =
  | {
      method: "health";
    }
  | {
      method: "shutdown";
    }
  | {
      method: "speech.stop";
    }
  | {
      method: "speech.speak";
      params: {
        text: string;
        voice?: string;
      };
    }
  | {
      method: "voice.start";
      params: {
        clientId: string;
      };
    }
  | {
      method: "voice.stop";
    };

export function buildScoutVoiceHealthCommand(): ScoutVoiceBridgeCommand {
  return { method: "health" };
}

export function buildScoutVoiceShutdownCommand(): ScoutVoiceBridgeCommand {
  return { method: "shutdown" };
}

export function buildScoutVoiceStopSpeakingCommand(): ScoutVoiceBridgeCommand {
  return { method: "speech.stop" };
}

export function buildScoutVoiceSpeakCommand(input: {
  text: string;
  voice?: string;
}): ScoutVoiceBridgeCommand {
  return {
    method: "speech.speak",
    params: {
      text: input.text,
      ...(input.voice?.trim() ? { voice: input.voice.trim() } : {}),
    },
  };
}

export function buildScoutVoiceToggleCaptureCommand(input: {
  captureState?: ScoutVoiceCaptureState;
  clientId?: string;
} = {}): ScoutVoiceBridgeCommand {
  const captureState = input.captureState ? input.captureState : "off";
  if (isScoutVoiceCaptureActive(captureState)) {
    return { method: "voice.stop" };
  }

  return {
    method: "voice.start",
    params: {
      clientId: input.clientId?.trim() || "scout-desktop",
    },
  };
}

export function buildScoutVoiceSetRepliesEnabledCommand(enabled: boolean): ScoutVoiceBridgeCommand {
  return enabled ? buildScoutVoiceHealthCommand() : buildScoutVoiceStopSpeakingCommand();
}
