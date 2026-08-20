import { useSyncExternalStore } from "react";

import { api } from "./api.ts";
import type { Broadcast, BroadcastTier } from "./types.ts";

const HISTORY_LIMIT = 50;
const VISIBLE_LIFETIME_MS = 30_000;
const PROMOTE_LIFETIME_MS = 5 * 60_000;
const TOGGLE_SCOUTBOT_EVENT = "openscout:toggle-scoutbot";
const MUTE_KEY = "openscout.broadcast.mute";

export type MuteFilter = "all" | "warn-plus" | "errors-only";

export type MuteState = {
  filter: MuteFilter;
  goDark: boolean;
  muteUntil: number;
};

export const DEFAULT_MUTE: MuteState = {
  filter: "all",
  goDark: false,
  muteUntil: 0,
};

type StoreSnapshot = {
  history: readonly Broadcast[];
  latest: Broadcast | null;
  promotedId: string | null;
  dismissedId: string | null;
  now: number;
  mute: MuteState;
};

let snapshot: StoreSnapshot = {
  history: [],
  latest: null,
  promotedId: null,
  dismissedId: null,
  now: Date.now(),
  mute: DEFAULT_MUTE,
};
const listeners = new Set<() => void>();
let eventSource: EventSource | null = null;
let retryTimeout: ReturnType<typeof setTimeout> | null = null;
let failures = 0;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let seeded = false;
let storageHandler: ((event: StorageEvent) => void) | null = null;

function readMuteFromStorage(): MuteState {
  if (typeof window === "undefined") return DEFAULT_MUTE;
  try {
    const raw = window.localStorage.getItem(MUTE_KEY);
    if (!raw) return DEFAULT_MUTE;
    const parsed = JSON.parse(raw) as Partial<MuteState>;
    return {
      filter:
        parsed.filter === "warn-plus" || parsed.filter === "errors-only"
          ? parsed.filter
          : "all",
      goDark: parsed.goDark === true,
      muteUntil: typeof parsed.muteUntil === "number" ? parsed.muteUntil : 0,
    };
  } catch {
    return DEFAULT_MUTE;
  }
}

function writeMuteToStorage(state: MuteState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(MUTE_KEY, JSON.stringify(state));
  } catch {
    /* swallow */
  }
}

export function tierAllowed(tier: BroadcastTier, filter: MuteFilter): boolean {
  if (filter === "all") return true;
  if (filter === "warn-plus") return tier !== "info";
  return tier === "error";
}

export function isFullyMuted(state: MuteState, now: number): boolean {
  if (state.goDark) return true;
  if (state.muteUntil > now) return true;
  return false;
}

export function shouldDisplayBroadcast(
  broadcast: Broadcast,
  state: MuteState,
  now: number,
): boolean {
  if (isFullyMuted(state, now)) return false;
  return tierAllowed(broadcast.tier, state.filter);
}

function emit(): void {
  for (const listener of [...listeners]) listener();
}

function setSnapshot(updater: (prev: StoreSnapshot) => StoreSnapshot): void {
  const next = updater(snapshot);
  if (next === snapshot) return;
  snapshot = next;
  emit();
}

function appendBroadcast(broadcast: Broadcast): void {
  setSnapshot((prev) => {
    if (prev.history.some((b) => b.id === broadcast.id)) return prev;
    const merged = [...prev.history, broadcast];
    const trimmed =
      merged.length > HISTORY_LIMIT
        ? merged.slice(merged.length - HISTORY_LIMIT)
        : merged;
    return {
      ...prev,
      history: trimmed,
      latest: broadcast,
      promotedId: broadcast.id,
      dismissedId: null,
    };
  });
}

function mergeHistory(incoming: Broadcast[]): void {
  setSnapshot((prev) => {
    const seen = new Set(prev.history.map((b) => b.id));
    const merged = [...prev.history];
    for (const b of incoming) if (!seen.has(b.id)) merged.push(b);
    merged.sort((a, b) => a.ts - b.ts);
    const trimmed =
      merged.length > HISTORY_LIMIT
        ? merged.slice(merged.length - HISTORY_LIMIT)
        : merged;
    const latest = trimmed.length ? trimmed[trimmed.length - 1]! : null;
    return {
      ...prev,
      history: trimmed,
      latest,
      promotedId: prev.promotedId ?? latest?.id ?? null,
    };
  });
}

function scheduleReconnect(): void {
  if (retryTimeout || listeners.size === 0) return;
  failures++;
  const delay = Math.min(2_000 * 2 ** (failures - 1), 30_000);
  retryTimeout = setTimeout(() => {
    retryTimeout = null;
    if (listeners.size > 0) connectStream();
  }, delay);
}

function connectStream(): void {
  if (eventSource || listeners.size === 0) return;
  const es = new EventSource("/api/broadcast/stream");
  eventSource = es;
  es.onopen = () => {
    failures = 0;
  };
  es.onmessage = (msg) => {
    try {
      const parsed = JSON.parse(msg.data) as Broadcast;
      appendBroadcast(parsed);
    } catch {
      /* swallow */
    }
  };
  es.addEventListener("ready", () => {
    failures = 0;
  });
  es.onerror = () => {
    if (eventSource === es) {
      eventSource = null;
    }
    es.close();
    scheduleReconnect();
  };
}

function tearDownStream(): void {
  eventSource?.close();
  eventSource = null;
  if (retryTimeout) {
    clearTimeout(retryTimeout);
    retryTimeout = null;
  }
  failures = 0;
}

function startTicking(): void {
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    setSnapshot((prev) => ({ ...prev, now: Date.now() }));
  }, 1_000);
}

function stopTicking(): void {
  if (!tickTimer) return;
  clearInterval(tickTimer);
  tickTimer = null;
}

async function seedFromRecent(): Promise<void> {
  if (seeded) return;
  seeded = true;
  try {
    const result = await api<{ broadcasts: Broadcast[] }>(
      `/api/broadcast/recent?limit=${HISTORY_LIMIT}`,
    );
    if (result.broadcasts?.length) mergeHistory(result.broadcasts);
  } catch {
    /* swallow */
  }
}

function startMuteStorageSync(): void {
  if (storageHandler || typeof window === "undefined") return;
  storageHandler = (event: StorageEvent) => {
    if (event.key !== MUTE_KEY) return;
    const next = readMuteFromStorage();
    setSnapshot((prev) => ({ ...prev, mute: next }));
  };
  window.addEventListener("storage", storageHandler);
}

function stopMuteStorageSync(): void {
  if (!storageHandler || typeof window === "undefined") return;
  window.removeEventListener("storage", storageHandler);
  storageHandler = null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    // Seed mute from storage on first subscriber.
    setSnapshot((prev) => ({ ...prev, mute: readMuteFromStorage() }));
    connectStream();
    startTicking();
    startMuteStorageSync();
    void seedFromRecent();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      tearDownStream();
      stopTicking();
      stopMuteStorageSync();
    }
  };
}

function getSnapshot(): StoreSnapshot {
  return snapshot;
}

export function useScoutbotBroadcastStore(): StoreSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function dismissPromotedBroadcast(): void {
  setSnapshot((prev) => {
    if (!prev.promotedId) return prev;
    return { ...prev, dismissedId: prev.promotedId, promotedId: null };
  });
}

export function selectActiveBroadcast(snap: StoreSnapshot): Broadcast | null {
  if (!snap.promotedId) return null;
  if (snap.dismissedId && snap.dismissedId === snap.promotedId) return null;
  const found = snap.history.find((b) => b.id === snap.promotedId);
  if (!found) return null;
  if (snap.now - found.ts > PROMOTE_LIFETIME_MS) return null;
  if (!shouldDisplayBroadcast(found, snap.mute, snap.now)) return null;
  return found;
}

export function selectChipBroadcast(snap: StoreSnapshot): Broadcast | null {
  const active = selectActiveBroadcast(snap);
  if (!active) return null;
  if (snap.now - active.ts > VISIBLE_LIFETIME_MS) return null;
  return active;
}

export function updateMute(next: MuteState): void {
  writeMuteToStorage(next);
  setSnapshot((prev) => ({ ...prev, mute: next }));
}

/* ── Client-side broadcasts ─────────────────────────────────────────
   Attention states that originate in the client (reminders due, voice
   offline, Scoutbot errors) flow through the same store as server SSE
   broadcasts so the chip surfaces them without per-state branching.
   Each client broadcast has a stable `key`; emitting the same key again
   replaces the existing entry in place rather than stacking duplicates.
   `clearClientBroadcast(key)` removes the entry when conditions clear. */

function clientBroadcastId(key: string): string {
  return `client:${key}`;
}

export function emitClientBroadcast(input: {
  key: string;
  tier: BroadcastTier;
  text: string;
}): void {
  const id = clientBroadcastId(input.key);
  setSnapshot((prev) => {
    const ts = Date.now();
    const broadcast: Broadcast = {
      id,
      tier: input.tier,
      text: input.text,
      ts,
      ruleId: `client.${input.key}`,
      key: input.key,
    };
    const existingIndex = prev.history.findIndex((b) => b.id === id);
    let nextHistory: Broadcast[];
    if (existingIndex >= 0) {
      nextHistory = [...prev.history];
      nextHistory[existingIndex] = broadcast;
    } else {
      nextHistory = [...prev.history, broadcast];
      if (nextHistory.length > HISTORY_LIMIT) {
        nextHistory = nextHistory.slice(nextHistory.length - HISTORY_LIMIT);
      }
    }
    return {
      ...prev,
      history: nextHistory,
      latest: broadcast,
      promotedId: id,
      dismissedId: prev.dismissedId === id ? null : prev.dismissedId,
    };
  });
}

export function clearClientBroadcast(key: string): void {
  const id = clientBroadcastId(key);
  setSnapshot((prev) => {
    const nextHistory = prev.history.filter((b) => b.id !== id);
    if (nextHistory.length === prev.history.length) return prev;
    const promotedId = prev.promotedId === id ? null : prev.promotedId;
    const dismissedId = prev.dismissedId === id ? null : prev.dismissedId;
    const latest = prev.latest?.id === id
      ? (nextHistory.length > 0 ? nextHistory[nextHistory.length - 1] : null)
      : prev.latest;
    return {
      ...prev,
      history: nextHistory,
      latest: latest ?? null,
      promotedId,
      dismissedId,
    };
  });
}

export function toggleScoutbot(broadcast?: Broadcast | null): void {
  if (typeof window === "undefined") return;
  const detail = broadcast ? { broadcastId: broadcast.id } : {};
  window.dispatchEvent(new CustomEvent(TOGGLE_SCOUTBOT_EVENT, { detail }));
}

export function onToggleScoutbot(
  handler: (detail: { broadcastId?: string }) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (event: Event) => {
    const detail = (event as CustomEvent).detail ?? {};
    handler(detail as { broadcastId?: string });
  };
  window.addEventListener(TOGGLE_SCOUTBOT_EVENT, listener);
  return () => window.removeEventListener(TOGGLE_SCOUTBOT_EVENT, listener);
}

export const TOGGLE_SCOUTBOT_EVENT_NAME = TOGGLE_SCOUTBOT_EVENT;
