let liveVoiceActive = false;
let speechCount = 0;

export function setScoutLiveVoiceActive(active: boolean): void {
  liveVoiceActive = active;
}

export function beginScoutSpeech(): void {
  speechCount += 1;
}

export function endScoutSpeech(): void {
  speechCount = Math.max(0, speechCount - 1);
}

export function isScoutSpeechActive(): boolean {
  return speechCount > 0;
}

export function scoutLiveAudioBlockReason(): string | null {
  if (liveVoiceActive) return "Live voice is active.";
  if (speechCount > 0) return "Another Scout playback is active.";
  return null;
}
