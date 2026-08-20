import {
  getTailDiscovery,
  snapshotRecentEvents,
  subscribeTail,
} from "@openscout/runtime/tail";
import type { DiscoverySnapshot, TailEvent } from "@openscout/runtime/tail";
import { allRules } from "./rules.ts";
import type {
  Broadcast,
  BroadcastContext,
  BroadcastRule,
  BroadcastSubscriber,
} from "./types.ts";

const EVAL_INTERVAL_MS = 5_000;
// Long enough to cover the idle rule's "last hour" lookback plus a buffer.
const RECENT_EVENT_WINDOW_MS = 70 * 60_000;
const RECENT_EVENT_LIMIT = 5_000;
const HISTORY_LIMIT = 200;
const VOLUME_WINDOW_MS = 60_000;
const VOLUME_THRESHOLD = 5;
const VOLUME_MUTE_MS = 60_000;

const recentEvents: TailEvent[] = [];
const lastFiredAt = new Map<string, number>();
const seenExits = new Set<number>();
const broadcastHistory: Broadcast[] = [];
const subscribers = new Set<BroadcastSubscriber>();
const recentBroadcastTimes: number[] = [];
let infoMutedUntil = 0;

let previousDiscovery: DiscoverySnapshot | null = null;
let evalTimer: ReturnType<typeof setInterval> | null = null;
let unsubscribeTail: (() => void) | null = null;
let started = false;

function pruneRecentEvents(now: number): void {
  const cutoff = now - RECENT_EVENT_WINDOW_MS;
  while (recentEvents.length && recentEvents[0]!.ts < cutoff) {
    recentEvents.shift();
  }
  if (recentEvents.length > RECENT_EVENT_LIMIT) {
    recentEvents.splice(0, recentEvents.length - RECENT_EVENT_LIMIT);
  }
}

function pruneVolume(now: number): void {
  const cutoff = now - VOLUME_WINDOW_MS;
  while (recentBroadcastTimes.length && recentBroadcastTimes[0]! < cutoff) {
    recentBroadcastTimes.shift();
  }
}

function dispatch(broadcast: Broadcast): void {
  broadcastHistory.push(broadcast);
  if (broadcastHistory.length > HISTORY_LIMIT) {
    broadcastHistory.splice(0, broadcastHistory.length - HISTORY_LIMIT);
  }
  for (const subscriber of [...subscribers]) {
    try {
      subscriber(broadcast);
    } catch {
      /* swallow subscriber errors */
    }
  }
}

function shouldEmit(broadcast: Broadcast, rule: BroadcastRule, now: number): boolean {
  // Volume throttle: suppress info if too many broadcasts recently.
  if (broadcast.tier === "info" && now < infoMutedUntil) {
    return false;
  }
  if (rule.cooldownMs > 0) {
    const last = lastFiredAt.get(broadcast.key);
    if (last !== undefined && now - last < rule.cooldownMs) {
      return false;
    }
  }
  return true;
}

export function evaluateOnce(now: number, discovery: DiscoverySnapshot): Broadcast[] {
  pruneRecentEvents(now);
  pruneVolume(now);

  const ctx: BroadcastContext = {
    now,
    recentEvents: [...recentEvents],
    discovery,
    previousDiscovery,
    seenExits,
  };

  const emitted: Broadcast[] = [];
  for (const rule of allRules) {
    let produced: Broadcast[] | null;
    try {
      produced = rule.evaluate(ctx);
    } catch {
      produced = null;
    }
    if (!produced) continue;
    for (const broadcast of produced) {
      if (!shouldEmit(broadcast, rule, now)) continue;
      lastFiredAt.set(broadcast.key, now);
      recentBroadcastTimes.push(now);
      emitted.push(broadcast);
      // After enqueuing, re-check volume threshold to mute future info-tier rules.
      pruneVolume(now);
      if (recentBroadcastTimes.length > VOLUME_THRESHOLD) {
        infoMutedUntil = Math.max(infoMutedUntil, now + VOLUME_MUTE_MS);
      }
    }
  }

  previousDiscovery = discovery;
  return emitted;
}

async function runTick(): Promise<void> {
  const now = Date.now();
  let discovery: DiscoverySnapshot;
  try {
    discovery = await getTailDiscovery();
  } catch {
    return;
  }
  const emitted = evaluateOnce(now, discovery);
  for (const broadcast of emitted) {
    dispatch(broadcast);
  }
}

function ensureStarted(): void {
  if (started) return;
  started = true;
  // Subscribe to tail firehose to keep recentEvents fresh.
  unsubscribeTail = subscribeTail((event) => {
    recentEvents.push(event);
    if (recentEvents.length > RECENT_EVENT_LIMIT) {
      recentEvents.splice(0, recentEvents.length - RECENT_EVENT_LIMIT);
    }
  });
  // Seed with whatever the tail service has already buffered so we don't
  // start cold.
  const seeded = snapshotRecentEvents(RECENT_EVENT_LIMIT);
  for (const event of seeded) recentEvents.push(event);
  evalTimer = setInterval(() => {
    void runTick();
  }, EVAL_INTERVAL_MS);
  // Kick a first tick so previousDiscovery is seeded quickly.
  void runTick();
}

function stopIfIdle(): void {
  if (subscribers.size > 0) return;
  if (evalTimer) {
    clearInterval(evalTimer);
    evalTimer = null;
  }
  if (unsubscribeTail) {
    unsubscribeTail();
    unsubscribeTail = null;
  }
  recentEvents.length = 0;
  started = false;
}

export function subscribeBroadcast(handler: BroadcastSubscriber): () => void {
  subscribers.add(handler);
  ensureStarted();
  return () => {
    subscribers.delete(handler);
    if (subscribers.size === 0) stopIfIdle();
  };
}

export function snapshotRecentBroadcasts(limit = 50): Broadcast[] {
  return broadcastHistory.slice(-limit);
}

export function emitBroadcast(input: {
  tier: Broadcast["tier"];
  text: string;
  ruleId: string;
  key: string;
  agent?: string;
  project?: string;
}): Broadcast {
  const broadcast: Broadcast = {
    id: `${input.ruleId}:${input.key}:${Date.now()}`,
    tier: input.tier,
    text: input.text,
    agent: input.agent,
    project: input.project,
    ts: Date.now(),
    ruleId: input.ruleId,
    key: input.key,
  };
  dispatch(broadcast);
  return broadcast;
}

/* ── Test seams ──────────────────────────────────────────────────────── */

export function __resetBroadcastForTests(): void {
  recentEvents.length = 0;
  lastFiredAt.clear();
  seenExits.clear();
  broadcastHistory.length = 0;
  subscribers.clear();
  recentBroadcastTimes.length = 0;
  infoMutedUntil = 0;
  previousDiscovery = null;
  if (evalTimer) {
    clearInterval(evalTimer);
    evalTimer = null;
  }
  if (unsubscribeTail) {
    unsubscribeTail();
    unsubscribeTail = null;
  }
  started = false;
}

export function __pushTailEventForTests(event: TailEvent): void {
  recentEvents.push(event);
}

export function __setPreviousDiscoveryForTests(snap: DiscoverySnapshot | null): void {
  previousDiscovery = snap;
}
