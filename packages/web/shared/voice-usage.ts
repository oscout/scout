/** Usage observations, not a bill: null means the provider did not report it. */
export type VoiceUsageMode = "local" | "api" | "chat";
export type VoiceTokenUsage = { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null };
export type VoiceModelUsage = VoiceTokenUsage & {
  id: string;
  sessionId: string;
  mode: VoiceUsageMode;
  model: string;
  provider: string | null;
  startedAt: number;
  finishedAt: number | null;
  elapsedMs: number | null;
  state: "pending" | "completed" | "failed";
};
export type VoiceModelUsageSummary = VoiceTokenUsage & {
  mode: VoiceUsageMode;
  requests: number;
  missingTokenReports: number;
  elapsedMs: number | null;
};
export type LiveCallUsage = {
  sessionId: string;
  leaseId: string;
  state: string;
  startedAt: number | null;
  endedAt: number | null;
  model: string | null;
  voice: string | null;
  providerSeconds: number | null;
  clientReportedSeconds: number | null;
};
export type VoiceUsageSnapshot = {
  llm: { records: VoiceModelUsage[]; summaries: VoiceModelUsageSummary[] } | null;
  /** Bounded recent call history, not an all-time audio total. */
  calls: LiveCallUsage[];
};

export function validUsageNumber(value: unknown, integer = false): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    && (!integer || Number.isSafeInteger(value)) ? value : null;
}
