import type { ScoutSpeechCatalog, ScoutSpeechCatalogVoice } from "./scout-voice.ts";

export const RECAP_VOICES_STORAGE_KEY = "scout.recapVoices.v1";
export const RECAP_VOICE_CONSENT_KEY = "scout.recapVoices.consent.v1";

export type RecapVoiceAssignment = {
  modelId: string;
  voiceId: string;
};

export type RecapVoicePlan = {
  assignments: Record<string, RecapVoiceAssignment>;
  notices: string[];
};

function hashKey(value: string): number {
  return [...value].reduce((total, char) => (total * 31 + char.charCodeAt(0)) >>> 0, 0);
}

function voicesForModel(catalog: ScoutSpeechCatalog, modelId: string): ScoutSpeechCatalogVoice[] {
  return catalog.voices.filter((voice) => voice.modelId === modelId && voice.available !== false);
}

export function loadRecapVoiceAssignments(): Record<string, RecapVoiceAssignment> {
  try {
    const raw = window.localStorage.getItem(RECAP_VOICES_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, RecapVoiceAssignment>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function saveRecapVoiceAssignments(assignments: Record<string, RecapVoiceAssignment>): void {
  try {
    window.localStorage.setItem(RECAP_VOICES_STORAGE_KEY, JSON.stringify(assignments));
  } catch {
    /* private mode */
  }
}

export function recapTtsConsented(): boolean {
  try {
    return window.localStorage.getItem(RECAP_VOICE_CONSENT_KEY) === "1";
  } catch {
    return false;
  }
}

export function markRecapTtsConsented(): void {
  try {
    window.localStorage.setItem(RECAP_VOICE_CONSENT_KEY, "1");
  } catch {
    /* private mode */
  }
}

export function recapProviderMayBeMetered(catalog: ScoutSpeechCatalog, modelId: string): boolean {
  const model = catalog.models.find((item) => item.id === modelId);
  if (!model) return true;
  return model.provider !== "system" && model.available !== false;
}

export function assignRecapVoices(
  keys: readonly string[],
  catalog: ScoutSpeechCatalog,
  modelId: string,
  stored: Record<string, RecapVoiceAssignment> = {},
): RecapVoicePlan {
  const pool = voicesForModel(catalog, modelId);
  const assignments: Record<string, RecapVoiceAssignment> = { ...stored };
  const notices: string[] = [];
  const used = new Set<string>();

  for (const key of keys) {
    const existing = assignments[key];
    if (existing && existing.modelId === modelId && pool.some((voice) => voice.id === existing.voiceId)) {
      used.add(existing.voiceId);
      continue;
    }
    if (existing && existing.voiceId) {
      notices.push(`Assigned voice ${existing.voiceId} is unavailable; using a fallback.`);
    }
    const unused = pool.filter((voice) => !used.has(voice.id));
    const candidates = unused.length > 0 ? unused : pool;
    if (candidates.length === 0) {
      notices.push("No supported Scout speech voice is available for this model.");
      continue;
    }
    const voice = candidates[hashKey(key) % candidates.length]!;
    assignments[key] = { modelId, voiceId: voice.id };
    used.add(voice.id);
  }

  return { assignments, notices };
}
