import type {
  ScoutVoiceLiveHandle,
  ScoutSpeechResult,
  ScoutSpeechTimingCueRequest,
} from "../../lib/scout-voice.ts";
import { formatClockTimestamp } from "../../lib/time.ts";
import { toSpokenScoutText } from "../../lib/spoken-text.ts";
import type { VoiceFxParams } from "@voxd/client/fx";

export const DEFAULT_SCOUTBOT_VOICE_PRESET_ID = "chill-dispatcher";
export const SCOUTBOT_BRIEF_CUE_EARLY_MS = 100;
export const SCOUT_VOICE_STOP_TIMEOUT_MS = 60_000;
export const SCOUT_VOICE_CANCEL_TIMEOUT_MS = 2_500;
export const STATE_PROMPT =
  "What's the state of things? Give me a terse ops summary, the biggest risk, and the next action you recommend.";
export const SCOUTBOT_VOICE_SPEEDS = [1, 1.2, 1.35] as const;
export const DEFAULT_SCOUTBOT_VOICE_SPEED = 1.2;
export const SCOUTBOT_BRIEF_SEGMENT_SEPARATOR = "\n\n";
export const SCOUTBOT_BRIEF_SPEECH_INSTRUCTIONS = [
  "Read as a calm local operations briefer.",
  "Use the paragraph breaks as short breath moments so the operator can look at the screen.",
  "Keep the tone warm, focused, and unhurried; do not sound like an advertisement.",
].join(" ");

const CHILL_DISPATCHER_OVERRIDES: Partial<VoiceFxParams> = {
  lowCutHz: 160,
  highCutHz: 5200,
  bandQ: 0.35,
  saturationAmount: 0.035,
  bitcrushAmount: 0,
  hissGain: 0,
  hissCutoffHz: 1800,
  presencePeakDb: 1.5,
  presenceCenterHz: 1500,
  presenceQ: 0.65,
  compressorThresholdDb: -15,
  compressorRatio: 2.2,
  clickEnabled: true,
  clickGain: 0.24,
  clickDurationMs: 45,
  squelchTailEnabled: true,
  squelchTailGain: 0.018,
  squelchTailDurationMs: 95,
  outputGain: 1,
  wetMix: 0.38,
};

export type ScoutbotAgentConfig = {
  editable: boolean;
  model: string;
  /** Routing preference the server resolved for this config; mirrors
   * ScoutbotAssistantProviderPreference in server/scoutbot-assistant.ts. */
  provider?: "auto" | "openai" | "codex";
  systemPrompt: string;
};

export type ScoutbotAgentConfigUpdateResult = {
  config: ScoutbotAgentConfig;
};

export type ScoutbotAssistantMessage = {
  id: string;
  role: "user" | "assistant";
  body: string;
  createdAt: number;
};

export type ScoutbotAssistantSession = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  model: string;
  messageCount: number;
  messages: ScoutbotAssistantMessage[];
};

export type ScoutbotAssistantSessionSummary = Omit<ScoutbotAssistantSession, "messages">;

export type ScoutbotAssistantSessionState = {
  session: ScoutbotAssistantSession;
  sessions: ScoutbotAssistantSessionSummary[];
  retention?: {
    activeLimit: number;
    archivedCount: number;
    totalCount: number;
  };
  config: ScoutbotAgentConfig;
};

export type ScoutbotAssistantReply = ScoutbotAssistantSessionState & {
  reply: ScoutbotAssistantMessage;
  responseId: string | null;
};

export type ScoutVoiceCancelReason = "discard" | "stop-failed";

export type ScoutbotBriefStep = {
  id: string;
  label: string;
  route: Record<string, unknown>;
  narration: string;
  durationMs: number;
  snapshot: {
    capturedAt: number;
    expiresAt: number;
    source: "prepared" | "refreshed" | "live";
  };
};

export type ScoutbotBriefAction = {
  label: string;
  route?: Record<string, unknown>;
  prompt?: string;
};

export type ScoutbotBrief = {
  id: string;
  title: string;
  summary: string;
  preparedAt: number;
  expiresAt: number;
  ttlMs: number;
  steps: ScoutbotBriefStep[];
  recommendation: string;
  actions: ScoutbotBriefAction[];
};

export type PreparedBriefSpeech = {
  promise: Promise<ScoutSpeechResult | null>;
  abort: () => void;
};

export type ScoutbotBriefSegment = {
  id: string;
  cueId: string;
  label: string;
  route: Record<string, unknown> | null;
  narration: string;
  durationMs: number;
};

export type ScoutbotBriefSpeechPlan = {
  text: string;
  cues: ScoutSpeechTimingCueRequest[];
};

export type ScoutbotBriefCueSchedule = {
  cueId: string;
  segmentIndex: number;
  activateMs: number;
};

export type ScoutbotReminder = {
  id: string;
  title: string;
  body: string;
  status: "scheduled" | "due" | "dismissed";
  source: "scoutbot" | "api";
  createdAt: number;
  updatedAt: number;
  dueAt: number;
  dueInMs: number;
  dismissedAt?: number;
};

export type ScoutbotReminderState = {
  generatedAt: number;
  reminders: ScoutbotReminder[];
  due: ScoutbotReminder[];
  scheduled: ScoutbotReminder[];
};

export type ScoutbotReminderCreateResult = ScoutbotReminderState & {
  reminder: ScoutbotReminder;
};

export type ScoutbotAskAgentResult = {
  ok: boolean;
  targetLabel: string;
  conversationId: string | null;
  messageId: string | null;
  flightId: string | null;
  targetAgentId: string | null;
};

export type VoiceProbeState = "idle" | "probing" | "launching";

export type ScoutbotVoiceDefaults = {
  modelId: string;
  voiceId?: string;
};

function scoutbotActivityParams(onlineCount: number): Partial<VoiceFxParams> {
  const activity = Math.min(1, onlineCount / 8);
  return {
    saturationAmount: 0.035 + activity * 0.025,
    presencePeakDb: 1.5 + activity * 1.5,
  };
}

export function resolveScoutbotFxParams(presetId: string, onlineCount: number): Partial<VoiceFxParams> {
  const base = presetId === "chill-dispatcher" ? CHILL_DISPATCHER_OVERRIDES : {};
  return { ...base, ...scoutbotActivityParams(onlineCount) };
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(resolve, reject).finally(() => window.clearTimeout(timeout));
  });
}

export async function releaseScoutVoiceLive(
  live: ScoutVoiceLiveHandle,
  options: { allowCurrentSession?: boolean } = {},
): Promise<void> {
  if (!live.sessionId && !options.allowCurrentSession) return;
  await withTimeout(
    live.cancel(),
    SCOUT_VOICE_CANCEL_TIMEOUT_MS,
    "Timed out releasing Scout voice session.",
  ).catch(() => undefined);
}

export function isScoutVoiceCancellation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /session_cancelled|was cancelled|cancelled/i.test(message);
}

export function buildScoutbotBriefSpeechPlan(segments: ScoutbotBriefSegment[]): ScoutbotBriefSpeechPlan {
  let text = "";
  const cues: ScoutSpeechTimingCueRequest[] = [];
  for (const segment of segments) {
    const spoken = toSpokenScoutText(segment.narration);
    if (!spoken) {
      continue;
    }
    if (text) {
      text += SCOUTBOT_BRIEF_SEGMENT_SEPARATOR;
    }
    const textStart = text.length;
    text += spoken;
    cues.push({
      id: segment.cueId,
      textStart,
      textEnd: text.length,
    });
  }
  return { text, cues };
}

export function resolveScoutbotBriefCueSchedule(
  result: ScoutSpeechResult,
  segments: ScoutbotBriefSegment[],
): ScoutbotBriefCueSchedule[] | null {
  const timingCues = result.speechTiming?.cues;
  if (!timingCues?.length) {
    return null;
  }
  const byId = new globalThis.Map(timingCues.map((cue) => [cue.id, cue]));
  const schedule: ScoutbotBriefCueSchedule[] = [];
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex];
    const cue = byId.get(segment.cueId);
    if (!cue || !Number.isFinite(cue.startMs)) {
      return null;
    }
    schedule.push({
      cueId: segment.cueId,
      segmentIndex,
      activateMs: Math.max(0, cue.startMs - SCOUTBOT_BRIEF_CUE_EARLY_MS),
    });
  }
  return schedule;
}

const FILE_PATH_RE =
  /(?:^|(?<=[\s(`'"<>]))(?:~\/|\/(?:Users|home|opt|var|etc|tmp|private)\/)[^\s)`'"<>]+\.[A-Za-z0-9]{1,8}\b/g;

export function extractAbsoluteFilePaths(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  FILE_PATH_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FILE_PATH_RE.exec(text)) !== null) {
    if (!seen.has(match[0])) {
      seen.add(match[0]);
      found.push(match[0]);
    }
  }
  return found;
}

export function shortenForMenu(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 2) return path;
  return `…/${parts.slice(-2).join("/")}`;
}

export function makeScoutAudioLaunchContext() {
  return {
    requesterName: "OpenScout",
    productName: "Scout Voice",
    headline: "Turn on local voice",
    body: "Scout voice handles local speech capture and spoken replies. Start Scout services, then return here to talk with your workspace.",
    actionLabel: "Return to OpenScout",
    logo: {
      url: new URL("/openscout-icon.png", window.location.href).toString(),
      symbolName: "sparkles",
    },
  };
}

export function formatVoiceSpeed(value: number): string {
  return value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

export function estimateBriefDuration(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.min(12_000, Math.max(3500, words * 360));
}

export function formatReminderDueAt(dueAt: number): string {
  return formatClockTimestamp(dueAt) || "unknown";
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
