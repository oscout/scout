import { api } from "./api.ts";
import { scoutLiveAudioBlockReason } from "./scout-audio-owners.ts";
import {
  fetchScoutSpeechCatalog,
  startScoutSpeech,
  type ScoutSpeechCatalog,
  type ScoutSpeechHandle,
} from "./scout-voice.ts";
import { recapTargetsFromLanes, type RecapTarget } from "./session-recap-identity.ts";
import { getRecapFocus, getRecapLanes } from "./session-recap-lanes.ts";
import {
  assignRecapVoices,
  loadRecapVoiceAssignments,
  markRecapTtsConsented,
  recapProviderMayBeMetered,
  recapTtsConsented,
  saveRecapVoiceAssignments,
  type RecapVoiceAssignment,
} from "./session-recap-voices.ts";

export type SessionRecapApiResponse = {
  sessionRef: string;
  harness: string;
  observedAt: number | null;
  summary: string;
  status: "ready" | "unavailable";
};

export type RecapItemStatus = "queued" | "summarizing" | "speaking" | "done" | "skipped" | "failed";

export type RecapQueueItem = {
  target: RecapTarget;
  status: RecapItemStatus;
  summary: string;
  reason: string | null;
  spokenText: string | null;
};

export type RecapQueueSnapshot = {
  running: boolean;
  speaker: string | null;
  notice: string | null;
  items: RecapQueueItem[];
};

type RecapFetch = (target: RecapTarget, signal: AbortSignal) => Promise<SessionRecapApiResponse>;
type RecapSpeak = (text: string, assignment: RecapVoiceAssignment) => ScoutSpeechHandle;

const ORIGIN_APP_ID = "openscout-recap";

let snapshot: RecapQueueSnapshot = { running: false, speaker: null, notice: null, items: [] };
const listeners = new Set<() => void>();
let controller: AbortController | null = null;
let speech: ScoutSpeechHandle | null = null;
let generation = 0;

function emit(next: RecapQueueSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

export function getRecapQueueSnapshot(): RecapQueueSnapshot {
  return snapshot;
}

export function subscribeRecapQueue(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function stopSessionRecaps(): void {
  generation += 1;
  controller?.abort();
  controller = null;
  speech?.stop();
  speech = null;
  emit({
    running: false,
    speaker: null,
    notice: snapshot.notice,
    items: snapshot.items.map((item) => (
      item.status === "queued" || item.status === "summarizing" || item.status === "speaking"
        ? { ...item, status: "skipped", reason: item.reason ?? "Stopped." }
        : item
    )),
  });
}

function defaultFetch(target: RecapTarget, signal: AbortSignal): Promise<SessionRecapApiResponse> {
  return api<SessionRecapApiResponse>("/api/scoutbot/session-recap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionRef: target.sessionRef, harness: target.harness }),
    signal,
  });
}

export async function startSessionRecaps(
  targets: RecapTarget[],
  options: {
    fetchRecap?: RecapFetch;
    speak?: RecapSpeak;
    catalog?: ScoutSpeechCatalog;
    fetchCatalog?: () => Promise<ScoutSpeechCatalog>;
    modelId?: string;
    requireConsent?: boolean;
  } = {},
): Promise<void> {
  if (snapshot.running) {
    stopSessionRecaps();
    return;
  }
  const blocked = scoutLiveAudioBlockReason();
  if (blocked) {
    emit({ running: false, speaker: null, notice: blocked, items: [] });
    return;
  }
  if (targets.length === 0) {
    emit({ running: false, speaker: null, notice: "No visible sessions to recap.", items: [] });
    return;
  }

  const token = ++generation;
  const runController = new AbortController();
  controller = runController;
  emit({ running: true, speaker: null, notice: null, items: [] });
  let catalog: ScoutSpeechCatalog;
  try {
    catalog = options.catalog ?? await (options.fetchCatalog?.() ?? fetchScoutSpeechCatalog(options.modelId));
  } catch (error) {
    if (generation !== token) return;
    controller = null;
    emit({ running: false, speaker: null, notice: error instanceof Error ? error.message : "Speech catalog unavailable.", items: [] });
    return;
  }
  if (generation !== token || runController.signal.aborted) return;
  const audioBlocked = scoutLiveAudioBlockReason();
  if (audioBlocked) {
    controller = null;
    emit({ running: false, speaker: null, notice: audioBlocked, items: [] });
    return;
  }
  const modelId = options.modelId ?? catalog.defaultModelId;
  if ((options.requireConsent ?? true) && recapProviderMayBeMetered(catalog, modelId) && !recapTtsConsented()) {
    emit({
      running: false,
      speaker: null,
      notice: "Configured TTS may be metered. Run Fleet roll call again to speak.",
      items: [],
    });
    controller = null;
    markRecapTtsConsented();
    return;
  }

  const planned = assignRecapVoices(
    targets.map((target) => target.voiceKey),
    catalog,
    modelId,
    loadRecapVoiceAssignments(),
  );
  saveRecapVoiceAssignments(planned.assignments);
  const items: RecapQueueItem[] = targets.map((target) => ({
    target,
    status: "queued",
    summary: "",
    reason: null,
    spokenText: null,
  }));
  emit({
    running: true,
    speaker: null,
    notice: planned.notices[0] ?? null,
    items,
  });

  const fetchRecap = options.fetchRecap ?? defaultFetch;
  const speak = options.speak ?? ((text, assignment) => startScoutSpeech(text, {
    modelId: assignment.modelId,
    voiceId: assignment.voiceId,
    originAppId: ORIGIN_APP_ID,
    utteranceId: `recap:${Date.now()}`,
  }));

  for (let index = 0; index < items.length; index += 1) {
    if (generation !== token || runController.signal.aborted) return;
    const item = items[index]!;
    items[index] = { ...item, status: "summarizing" };
    emit({ running: true, speaker: item.target.displayLabel, notice: snapshot.notice, items: [...items] });
    try {
      const recap = await fetchRecap(item.target, runController.signal);
      if (generation !== token) return;
      if (recap.status !== "ready" || !recap.summary.trim()) {
        items[index] = {
          ...items[index]!,
          status: "skipped",
          reason: "Source unavailable.",
          summary: recap.summary,
        };
        emit({ running: true, speaker: item.target.displayLabel, notice: snapshot.notice, items: [...items] });
        continue;
      }
      const prefix = item.target.identityVerified
        ? `${item.target.displayLabel}. `
        : `${item.target.displayLabel}. Identity not verified. `;
      const spokenText = `${prefix}${recap.summary}`;
      const assignment = planned.assignments[item.target.voiceKey];
      if (!assignment) {
        items[index] = {
          ...items[index]!,
          status: "failed",
          reason: "No Scout speech voice is assigned.",
          summary: recap.summary,
        };
        emit({ running: true, speaker: item.target.displayLabel, notice: snapshot.notice, items: [...items] });
        continue;
      }
      items[index] = {
        ...items[index]!,
        status: "speaking",
        summary: recap.summary,
        spokenText,
      };
      emit({ running: true, speaker: item.target.displayLabel, notice: snapshot.notice, items: [...items] });
      const currentSpeech = speak(spokenText, assignment);
      speech = currentSpeech;
      await currentSpeech.promise;
      if (generation !== token) return;
      speech = null;
      items[index] = { ...items[index]!, status: "done" };
      emit({ running: true, speaker: item.target.displayLabel, notice: snapshot.notice, items: [...items] });
    } catch (error) {
      if (generation !== token || runController.signal.aborted) return;
      speech = null;
      items[index] = {
        ...items[index]!,
        status: "failed",
        reason: error instanceof Error ? error.message : "Recap failed.",
      };
      emit({ running: true, speaker: null, notice: snapshot.notice, items: [...items] });
    }
  }

  if (generation === token) {
    controller = null;
    emit({ running: false, speaker: null, notice: snapshot.notice, items: [...items] });
  }
}

export function toggleFleetRollCall(): void {
  if (snapshot.running) {
    stopSessionRecaps();
    return;
  }
  void startSessionRecaps(recapTargetsFromLanes(getRecapLanes()));
}

export function speakLatestVisibleTurn(): void {
  if (snapshot.running) {
    stopSessionRecaps();
    return;
  }
  const lanes = getRecapLanes();
  const focusedId = getRecapFocus();
  const focusedLane = (focusedId ? lanes.find((lane) => lane.id === focusedId) : null) ?? lanes[0];
  const targets = recapTargetsFromLanes(focusedLane ? [focusedLane] : []);
  if (targets.length === 0) {
    emit({ running: false, speaker: null, notice: "No visible session to recap.", items: [] });
    return;
  }
  void startSessionRecaps(targets);
}
