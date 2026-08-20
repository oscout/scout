import { useSyncExternalStore } from "react";

import {
  clearClientBroadcast,
  emitClientBroadcast,
} from "./scoutbot-broadcast-store.ts";
import { toSpokenScoutText } from "./spoken-text.ts";
import {
  isScoutSpeechStopped,
  startScoutSpeech,
  type ScoutSpeechHandle,
} from "./scout-voice.ts";

const LAST_SPOKEN_BRIEF_KEY = "openscout.home.lastSpokenBriefId.v1";
const BROADCAST_KEY = "home.brief.voice";
const BROADCAST_TEXT = "briefing mode voice >>";
const BROADCAST_REFRESH_MS = 20_000;

type HomeBriefPlayerState = {
  speaking: boolean;
  activeBriefId: string | null;
  lastSpokenBriefId: string | null;
  error: string | null;
};

type Listener = () => void;

const listeners = new Set<Listener>();
let speechHandle: ScoutSpeechHandle | null = null;
let broadcastTimer: ReturnType<typeof setInterval> | null = null;

let state: HomeBriefPlayerState = {
  speaking: false,
  activeBriefId: null,
  lastSpokenBriefId: readLastSpokenBriefId(),
  error: null,
};

function readLastSpokenBriefId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(LAST_SPOKEN_BRIEF_KEY);
  } catch {
    return null;
  }
}

function writeLastSpokenBriefId(briefId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAST_SPOKEN_BRIEF_KEY, briefId);
  } catch {
    /* storage is best-effort */
  }
}

function emit(): void {
  for (const listener of listeners) listener();
}

function setState(next: HomeBriefPlayerState): void {
  if (
    state.speaking === next.speaking &&
    state.activeBriefId === next.activeBriefId &&
    state.lastSpokenBriefId === next.lastSpokenBriefId &&
    state.error === next.error
  ) {
    return;
  }
  state = next;
  emit();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): HomeBriefPlayerState {
  return state;
}

function publishVoiceBroadcast(): void {
  emitClientBroadcast({
    key: BROADCAST_KEY,
    tier: "info",
    text: BROADCAST_TEXT,
  });
}

function startBroadcastHeartbeat(): void {
  publishVoiceBroadcast();
  if (broadcastTimer) clearInterval(broadcastTimer);
  broadcastTimer = setInterval(publishVoiceBroadcast, BROADCAST_REFRESH_MS);
}

function stopBroadcastHeartbeat(): void {
  if (broadcastTimer) {
    clearInterval(broadcastTimer);
    broadcastTimer = null;
  }
  clearClientBroadcast(BROADCAST_KEY);
}

export function useHomeBriefPlayerState(): HomeBriefPlayerState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function startHomeBriefSpeech(input: {
  briefId: string;
  text: string;
}): void {
  const text = input.text.trim();
  if (!text) return;

  stopHomeBriefSpeech();

  let handle: ScoutSpeechHandle;
  try {
    handle = startScoutSpeech(toSpokenScoutText(text));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not start brief voice";
    setState({ ...state, error: message });
    return;
  }

  speechHandle = handle;
  writeLastSpokenBriefId(input.briefId);
  setState({
    speaking: true,
    activeBriefId: input.briefId,
    lastSpokenBriefId: input.briefId,
    error: null,
  });
  startBroadcastHeartbeat();

  void handle.promise
    .catch((err) => {
      if (!isScoutSpeechStopped(err)) {
        const message = err instanceof Error ? err.message : "Brief voice failed";
        console.warn("brief speech failed", err);
        setState({ ...state, error: message });
      }
    })
    .finally(() => {
      if (speechHandle !== handle) return;
      speechHandle = null;
      stopBroadcastHeartbeat();
      setState({
        ...state,
        speaking: false,
        activeBriefId: null,
      });
    });
}

export function stopHomeBriefSpeech(): void {
  const handle = speechHandle;
  speechHandle = null;
  handle?.stop();
  stopBroadcastHeartbeat();
  setState({
    ...state,
    speaking: false,
    activeBriefId: null,
    error: null,
  });
}
