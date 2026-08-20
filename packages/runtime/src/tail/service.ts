import { basename } from "node:path";
import { open, stat, type FileHandle } from "node:fs/promises";

import { redactSecrets, redactSecretsDeep } from "@openscout/agent-sessions/secret-redaction";

import { ClaudeSource } from "./claude-source.js";
import { CodexSource } from "./codex-source.js";
import { CursorSource } from "./cursor-source.js";
import { GrokSource } from "./grok-source.js";
import { KimiSource } from "./kimi-source.js";
import { OpenCodeSource } from "./opencode-source.js";
import { PiSource } from "./pi-source.js";
import { sessionRegistryKey } from "./registry.js";
import type {
  DiscoveredProcess,
  DiscoveredTranscript,
  DiscoverySnapshot,
  TailDiscoveryOptions,
  TailDiscoveryScope,
  TailDiscoveryIssue,
  TailEvent,
  TranscriptSource,
} from "./types.js";

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

const TAIL_POLL_INTERVAL_MS = readPositiveIntEnv("OPENSCOUT_TAIL_POLL_INTERVAL_MS", 500);
const HOT_DISCOVERY_INTERVAL_MS = readPositiveIntEnv("OPENSCOUT_TAIL_HOT_DISCOVERY_INTERVAL_MS", 30_000);
const DISCOVERY_CACHE_MAX_AGE_MS = readPositiveIntEnv(
  "OPENSCOUT_TAIL_DISCOVERY_CACHE_MAX_AGE_MS",
  HOT_DISCOVERY_INTERVAL_MS,
);
const SHALLOW_DISCOVERY_INTERVAL_MS = readPositiveIntEnv("OPENSCOUT_TAIL_SHALLOW_DISCOVERY_INTERVAL_MS", 10 * 60_000);
const DEEP_DISCOVERY_INTERVAL_MS = readPositiveIntEnv("OPENSCOUT_TAIL_DEEP_DISCOVERY_INTERVAL_MS", 60 * 60_000);
const PER_SESSION_BUFFER_LIMIT = 2_000;
const AGGREGATE_BUFFER_LIMIT = 10_000;
const QUIET_EVENT_COALESCE_WINDOW_MS = readPositiveIntEnv("OPENSCOUT_TAIL_QUIET_EVENT_COALESCE_WINDOW_MS", 5_000);
const QUIET_EVENT_COALESCE_MAX_KEYS = readPositiveIntEnv("OPENSCOUT_TAIL_QUIET_EVENT_COALESCE_MAX_KEYS", 2_000);
const RAW_MAX_DEPTH = 5;
const RAW_MAX_STRING_LEN = 1_000;
const RAW_MAX_ARRAY_ITEMS = 25;
const RAW_MAX_OBJECT_KEYS = 50;
const RECENT_TRANSCRIPT_READ_BYTES = 512 * 1024;
const SESSION_TRANSCRIPT_READ_BYTES = 8 * 1024 * 1024;
const RECENT_TRANSCRIPT_LINES_PER_FILE = 200;
const RECENT_TRANSCRIPT_MAX_FILES = readPositiveIntEnv("OPENSCOUT_TAIL_RECENT_TRANSCRIPT_MAX_FILES", 24);
const NATIVE_TAIL_SOURCES = new Set<TranscriptSource["name"]>(["grok", "kimi", "opencode", "cursor"]);

type Subscriber = (event: TailEvent) => void;

type Watcher = {
  source: TranscriptSource;
  process: DiscoveredProcess;
  transcript: DiscoveredTranscript;
  transcriptPath: string;
  offset: number;
  lineCounter: number;
  carry: string;
  emittedEventIds: Set<string>;
  state: Record<string, unknown>;
};

const sources: TranscriptSource[] = [GrokSource, KimiSource, ClaudeSource, CodexSource, CursorSource, OpenCodeSource, PiSource];

const watchers = new Map<string, Watcher>(); // key = `${source}:${transcriptPath}` (one watcher per file, regardless of how many processes share it)
const aggregateBuffer: TailEvent[] = [];
const perSessionBuffer = new Map<string, TailEvent[]>();
const subscribers = new Set<Subscriber>();
const knownTranscripts = new Map<string, DiscoveredTranscript>();
const quietEventLastSeen = new Map<string, number>();
let pollTimer: ReturnType<typeof setInterval> | null = null;
let hotDiscoveryTimer: ReturnType<typeof setInterval> | null = null;
let shallowDiscoveryTimer: ReturnType<typeof setInterval> | null = null;
let deepDiscoveryTimer: ReturnType<typeof setInterval> | null = null;
let discoveryInFlight: Promise<DiscoverySnapshot> | null = null;
let lastDiscovery: DiscoverySnapshot | null = null;

function emptyDiscoverySnapshot(): DiscoverySnapshot {
  return {
    generatedAt: Date.now(),
    processes: [],
    transcripts: [],
    totals: {
      total: 0,
      scoutManaged: 0,
      hudsonManaged: 0,
      unattributed: 0,
      transcripts: 0,
    },
  };
}

const ATTRIBUTION_RANK: Record<DiscoveredProcess["harness"], number> = {
  "scout-managed": 3,
  "hudson-managed": 2,
  unattributed: 1,
};

/**
 * Pick the best-attributed process to represent a transcript file.
 * Prefer Scout-managed > Hudson-managed > native; tie-break by lowest pid
 * (typically the earliest/root process in a fanout).
 */
function pickPrimaryProcess(procs: DiscoveredProcess[]): DiscoveredProcess {
  return procs.reduce((best, candidate) => {
    const bestRank = ATTRIBUTION_RANK[best.harness] ?? 0;
    const candRank = ATTRIBUTION_RANK[candidate.harness] ?? 0;
    if (candRank > bestRank) return candidate;
    if (candRank === bestRank && candidate.pid < best.pid) return candidate;
    return best;
  });
}

function virtualPidForPath(path: string): number {
  let hash = 2166136261;
  for (let i = 0; i < path.length; i++) {
    hash ^= path.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return -((hash >>> 0) % 900_000 + 1_000);
}

function processForTranscript(
  transcript: DiscoveredTranscript,
  processes: DiscoveredProcess[],
): DiscoveredProcess {
  const cwd = transcript.cwd?.trim();
  if (cwd) {
    const matches = processes.filter((proc) => proc.source === transcript.source && proc.cwd === cwd);
    if (matches.length > 0) {
      return pickPrimaryProcess(matches);
    }
  }

  return {
    pid: virtualPidForPath(transcript.transcriptPath),
    ppid: 0,
    command: `${transcript.source} transcript`,
    etime: "0",
    cwd: transcript.cwd,
    harness: transcript.harness,
    parentChain: [],
    source: transcript.source,
  };
}

function trimRawString(value: string): string {
  if (value.length <= RAW_MAX_STRING_LEN) return value;
  return `${value.slice(0, RAW_MAX_STRING_LEN)}... [truncated ${value.length - RAW_MAX_STRING_LEN} chars]`;
}

function compactRawValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactSecrets(trimRawString(value));
  if (value == null || typeof value !== "object") return value;
  if (depth >= RAW_MAX_DEPTH) return "[truncated depth]";

  if (Array.isArray(value)) {
    const out = value.slice(0, RAW_MAX_ARRAY_ITEMS).map((entry) => compactRawValue(entry, depth + 1));
    if (value.length > RAW_MAX_ARRAY_ITEMS) {
      out.push(`[truncated ${value.length - RAW_MAX_ARRAY_ITEMS} items]`);
    }
    return out;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const out: Record<string, unknown> = {};
  for (const [key, entry] of entries.slice(0, RAW_MAX_OBJECT_KEYS)) {
    out[key] = compactRawValue(entry, depth + 1);
  }
  if (entries.length > RAW_MAX_OBJECT_KEYS) {
    out.__truncatedKeys = entries.length - RAW_MAX_OBJECT_KEYS;
  }
  return out;
}

function compactEvent(event: TailEvent): TailEvent {
  const summary = redactSecrets(event.summary);
  if (!event.raw) return summary === event.summary ? event : { ...event, summary };
  return {
    ...event,
    summary,
    raw: compactRawValue(event.raw),
  };
}

/**
 * Whole-file parsers (parseFile) bypass compactEvent; scrub registered
 * credentials from their events before they reach buffers and HTTP reads.
 */
function redactTailEvent(event: TailEvent): TailEvent {
  return {
    ...event,
    summary: redactSecrets(event.summary),
    ...(event.raw ? { raw: redactSecretsDeep(event.raw) } : {}),
  };
}

function parsedEventsToArray(events: TailEvent | TailEvent[] | null): TailEvent[] {
  if (!events) return [];
  return Array.isArray(events) ? events : [events];
}

const GROK_QUIET_PHASES = new Set([
  "streaming_reasoning",
  "streaming_text",
  "tool_execution",
  "permission_prompt",
]);

function normalizedSummary(event: TailEvent): string {
  return event.summary.trim().toLowerCase();
}

function quietTailEventKey(event: TailEvent): string | null {
  const summary = normalizedSummary(event);
  if (!summary) return null;

  if (event.source === "grok") {
    if (summary === "first token") return `${event.source}:${event.sessionId}:first-token`;
    if (summary.startsWith("loop ")) return `${event.source}:${event.sessionId}:loop`;
    if (!summary.startsWith("phase ·")) return null;
    const phase = summary.slice("phase ·".length).trim();
    return GROK_QUIET_PHASES.has(phase)
      ? `${event.source}:${event.sessionId}:phase:${phase}`
      : null;
  }

  if (event.source !== "codex") return null;

  if (event.kind === "tool-result") {
    if (summary.startsWith("-> chunk id:")) return `${event.source}:${event.sessionId}:tool-result-chunk`;
    if (/^->\s+wall time:/u.test(summary)) return `${event.source}:${event.sessionId}:tool-result-wall-time`;
    if (summary.includes("_end ·")) return `${event.source}:${event.sessionId}:tool-result-end`;
    if (summary.startsWith("->")) return `${event.source}:${event.sessionId}:tool-result-arrow`;
    return null;
  }

  if (event.kind !== "system") return null;
  if (summary === "user_message") return `${event.source}:${event.sessionId}:user-message-meta`;
  if (summary === "agent_message") return `${event.source}:${event.sessionId}:agent-message-meta`;
  if (summary === "[reasoning]") return `${event.source}:${event.sessionId}:reasoning-marker`;
  if (summary.startsWith("turn context")) return `${event.source}:${event.sessionId}:turn-context`;
  if (summary.startsWith("tokens ·")) return `${event.source}:${event.sessionId}:tokens`;
  if (summary.startsWith("session ")) return `${event.source}:${event.sessionId}:session-meta`;
  return null;
}

function pruneQuietTailCoalescer(now: number): void {
  if (quietEventLastSeen.size <= QUIET_EVENT_COALESCE_MAX_KEYS) return;
  const cutoff = now - QUIET_EVENT_COALESCE_WINDOW_MS * 4;
  for (const [key, seenAt] of quietEventLastSeen) {
    if (seenAt < cutoff) quietEventLastSeen.delete(key);
  }
  if (quietEventLastSeen.size <= QUIET_EVENT_COALESCE_MAX_KEYS) return;
  for (const key of quietEventLastSeen.keys()) {
    quietEventLastSeen.delete(key);
    if (quietEventLastSeen.size <= QUIET_EVENT_COALESCE_MAX_KEYS) break;
  }
}

function shouldCoalesceQuietTailEvent(event: TailEvent): boolean {
  const key = quietTailEventKey(event);
  if (!key) return false;
  const now = Number.isFinite(event.ts) ? event.ts : Date.now();
  const lastSeenAt = quietEventLastSeen.get(key);
  if (lastSeenAt != null && now - lastSeenAt < QUIET_EVENT_COALESCE_WINDOW_MS) {
    return true;
  }
  quietEventLastSeen.set(key, now);
  pruneQuietTailCoalescer(now);
  return false;
}

function pushEvent(rawEvent: TailEvent): void {
  const event = compactEvent(rawEvent);
  if (shouldCoalesceQuietTailEvent(event)) return;
  aggregateBuffer.push(event);
  if (aggregateBuffer.length > AGGREGATE_BUFFER_LIMIT) {
    aggregateBuffer.splice(0, aggregateBuffer.length - AGGREGATE_BUFFER_LIMIT);
  }
  let bucket = perSessionBuffer.get(event.sessionId);
  if (!bucket) {
    bucket = [];
    perSessionBuffer.set(event.sessionId, bucket);
  }
  bucket.push(event);
  if (bucket.length > PER_SESSION_BUFFER_LIMIT) {
    bucket.splice(0, bucket.length - PER_SESSION_BUFFER_LIMIT);
  }
  for (const subscriber of [...subscribers]) {
    try {
      subscriber(event);
    } catch {
      /* swallow subscriber errors */
    }
  }
}

async function readNew(
  handle: FileHandle,
  fromOffset: number,
  fileSize: number,
): Promise<{ text: string; nextOffset: number }> {
  if (fileSize <= fromOffset) {
    return { text: "", nextOffset: fromOffset };
  }
  const length = fileSize - fromOffset;
  const buffer = Buffer.alloc(length);
  await handle.read(buffer, 0, length, fromOffset);
  return { text: buffer.toString("utf8"), nextOffset: fileSize };
}

async function readTranscriptText(path: string, maxBytes = RECENT_TRANSCRIPT_READ_BYTES): Promise<string> {
  let handle: FileHandle | null = null;
  try {
    const stats = await stat(path);
    if (stats.size <= 0) return "";
    const start = Math.max(0, stats.size - maxBytes);
    const length = stats.size - start;
    const buffer = Buffer.alloc(length);
    handle = await open(path, "r");
    await handle.read(buffer, 0, length, start);
    return buffer.toString("utf8");
  } catch {
    return "";
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function pumpWatcher(watcher: Watcher): Promise<void> {
  let handle: FileHandle | null = null;
  try {
    const stats = await stat(watcher.transcriptPath);
    if (stats.size < watcher.offset) {
      // File was rotated/truncated; reset.
      watcher.offset = 0;
      watcher.carry = "";
      watcher.emittedEventIds.clear();
    }
    if (stats.size <= watcher.offset) return;
    if (watcher.source.parseFile) {
      const text = await readTranscriptText(watcher.transcriptPath);
      watcher.offset = stats.size;
      if (!text) return;
      const events = parsedEventsToArray(watcher.source.parseFile(text, {
        process: watcher.process,
        transcript: watcher.transcript,
        transcriptPath: watcher.transcriptPath,
        lineOffset: watcher.lineCounter,
        state: watcher.state,
      }));
      watcher.lineCounter += Math.max(1, events.length);
      for (const event of events) {
        if (watcher.emittedEventIds.has(event.id)) continue;
        watcher.emittedEventIds.add(event.id);
        pushEvent(event);
      }
      return;
    }
    handle = await open(watcher.transcriptPath, "r");
    const { text, nextOffset } = await readNew(handle, watcher.offset, stats.size);
    watcher.offset = nextOffset;
    if (!text) return;
    const combined = watcher.carry + text;
    const lines = combined.split("\n");
    watcher.carry = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      const event = watcher.source.parseLine(line, {
        process: watcher.process,
        transcript: watcher.transcript,
        transcriptPath: watcher.transcriptPath,
        lineOffset: watcher.lineCounter,
        state: watcher.state,
      });
      watcher.lineCounter++;
      if (event) {
        if (watcher.emittedEventIds.has(event.id)) continue;
        watcher.emittedEventIds.add(event.id);
        pushEvent(event);
      }
    }
  } catch {
    // File may be missing momentarily — skip this tick.
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function pumpAllWatchers(): Promise<void> {
  await Promise.allSettled([...watchers.values()].map(pumpWatcher));
}

async function seedTail(watcher: Watcher): Promise<void> {
  // Seed the offset to the current end of the file so we don't replay a giant
  // historical transcript. We'll start tailing from "now".
  try {
    const stats = await stat(watcher.transcriptPath);
    watcher.offset = watcher.source.parseFile ? 0 : stats.size;
    if (!watcher.source.parseFile && watcher.source.name === "codex") {
      const lines = await readRecentTranscriptLines(watcher.transcriptPath, RECENT_TRANSCRIPT_LINES_PER_FILE);
      lines.forEach((line, index) => {
        watcher.source.parseLine(line, {
          process: watcher.process,
          transcript: watcher.transcript,
          transcriptPath: watcher.transcriptPath,
          lineOffset: index,
          state: watcher.state,
        });
      });
    }
  } catch {
    watcher.offset = 0;
  }
}

async function refreshDiscovery(
  scope: TailDiscoveryScope = "shallow",
  options: { pruneMissing: boolean } = { pruneMissing: scope !== "hot" },
): Promise<DiscoverySnapshot> {
  const allProcesses: DiscoveredProcess[] = [];
  const cachedProcesses = lastDiscovery?.processes ?? [];
  const seenSessionKeys = new Set<string>();
  const discoveryIssues: TailDiscoveryIssue[] = [];
  const discoveryIssueKeys = new Set<string>();

  for (const source of sources) {
    let processes: DiscoveredProcess[] = [];
    if (scope === "hot" && cachedProcesses.length > 0) {
      processes = cachedProcesses.filter((proc) => proc.source === source.name);
    } else {
      try {
        processes = await source.discoverProcesses();
      } catch {
        processes = [];
      }
    }
    allProcesses.push(...processes);

    let transcripts: DiscoveredTranscript[] = [];
    try {
      transcripts = await source.discoverTranscripts(processes, scope);
    } catch {
      transcripts = [];
    }

    for (const transcript of transcripts) {
      const primary = processForTranscript(transcript, processes);
      const transcriptPath = transcript.transcriptPath;
      const sessionKey = sessionRegistryKey(transcript);
      seenSessionKeys.add(sessionKey);

      const prior = knownTranscripts.get(sessionKey);
      if (
        transcript.source !== "cursor"
        && prior
        && prior.transcriptPath !== transcriptPath
      ) {
        const issueKey = `${sessionKey}\u0000${prior.transcriptPath}\u0000${transcriptPath}`;
        if (!discoveryIssueKeys.has(issueKey)) {
          discoveryIssueKeys.add(issueKey);
          const kept = transcript.mtimeMs >= prior.mtimeMs ? transcriptPath : prior.transcriptPath;
          discoveryIssues.push({
            kind: "transcript_path_collision",
            sessionKey,
            message: `Session ${sessionKey} maps to multiple transcript files; tail is watching ${kept}.`,
            transcriptPaths: [prior.transcriptPath, transcriptPath],
          });
        }
      }
      if (!prior || transcript.mtimeMs >= prior.mtimeMs) {
        knownTranscripts.set(sessionKey, transcript);
      }

      let watcher = watchers.get(sessionKey);
      if (!watcher) {
        watcher = {
          source,
          process: primary,
          transcript,
          transcriptPath,
          offset: 0,
          lineCounter: 0,
          carry: "",
          emittedEventIds: new Set(),
          state: {},
        };
        await seedTail(watcher);
        watchers.set(sessionKey, watcher);
        continue;
      }

      if (watcher.transcriptPath !== transcriptPath) {
        watcher.transcriptPath = transcriptPath;
        watcher.lineCounter = 0;
        watcher.carry = "";
        watcher.emittedEventIds = new Set();
        watcher.state = {};
        await seedTail(watcher);
      }
      watcher.process = primary;
      watcher.transcript = transcript;
    }
  }

  if (options.pruneMissing) {
    for (const sessionKey of [...watchers.keys()]) {
      if (!seenSessionKeys.has(sessionKey)) {
        watchers.delete(sessionKey);
        knownTranscripts.delete(sessionKey);
      }
    }
  }

  const allTranscripts = [...knownTranscripts.values()]
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  let scoutManaged = 0;
  let hudsonManaged = 0;
  let unattributed = 0;
  for (const proc of allProcesses) {
    if (proc.harness === "scout-managed") scoutManaged++;
    else if (proc.harness === "hudson-managed") hudsonManaged++;
    else unattributed++;
  }

  const snapshot: DiscoverySnapshot = {
    generatedAt: Date.now(),
    processes: allProcesses,
    transcripts: allTranscripts,
    issues: discoveryIssues.length > 0 ? discoveryIssues : undefined,
    totals: {
      total: allProcesses.length,
      scoutManaged,
      hudsonManaged,
      unattributed,
      transcripts: allTranscripts.length,
    },
  };
  lastDiscovery = snapshot;
  return snapshot;
}

function runDiscovery(
  scope: TailDiscoveryScope,
  options: { pruneMissing: boolean } = { pruneMissing: scope !== "hot" },
): Promise<DiscoverySnapshot> {
  if (discoveryInFlight) return discoveryInFlight;
  discoveryInFlight = refreshDiscovery(scope, options)
    .finally(() => {
      discoveryInFlight = null;
    });
  return discoveryInFlight;
}

function scheduleDiscovery(
  scope: TailDiscoveryScope,
  options: { pruneMissing: boolean } = { pruneMissing: scope !== "hot" },
): void {
  void runDiscovery(scope, options).catch(() => {});
}

function ensureLoopRunning(): void {
  if (!pollTimer) {
    pollTimer = setInterval(() => {
      void pumpAllWatchers();
    }, TAIL_POLL_INTERVAL_MS);
  }
  if (!hotDiscoveryTimer) {
    hotDiscoveryTimer = setInterval(() => {
      void runDiscovery("hot", { pruneMissing: false }).catch(() => {});
    }, HOT_DISCOVERY_INTERVAL_MS);
  }
  if (!shallowDiscoveryTimer) {
    shallowDiscoveryTimer = setInterval(() => {
      void runDiscovery("shallow", { pruneMissing: true }).catch(() => {});
    }, SHALLOW_DISCOVERY_INTERVAL_MS);
  }
  if (!deepDiscoveryTimer) {
    deepDiscoveryTimer = setInterval(() => {
      void runDiscovery("deep", { pruneMissing: true }).catch(() => {});
    }, DEEP_DISCOVERY_INTERVAL_MS);
  }
}

function stopLoopIfIdle(): void {
  if (subscribers.size > 0) return;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (hotDiscoveryTimer) {
    clearInterval(hotDiscoveryTimer);
    hotDiscoveryTimer = null;
  }
  if (shallowDiscoveryTimer) {
    clearInterval(shallowDiscoveryTimer);
    shallowDiscoveryTimer = null;
  }
  if (deepDiscoveryTimer) {
    clearInterval(deepDiscoveryTimer);
    deepDiscoveryTimer = null;
  }
  watchers.clear();
}

function normalizeTailDiscoveryOptions(
  input: boolean | TailDiscoveryOptions = false,
): Required<Pick<TailDiscoveryOptions, "force">> & Omit<TailDiscoveryOptions, "force"> {
  if (typeof input === "boolean") {
    return { force: input };
  }
  return { ...input, force: input.force === true };
}

export async function getTailDiscovery(
  options: boolean | TailDiscoveryOptions = false,
): Promise<DiscoverySnapshot> {
  const { force, scope } = normalizeTailDiscoveryOptions(options);
  const discoveryScope: TailDiscoveryScope = scope ?? (force ? "deep" : "shallow");
  if (force) {
    scheduleDiscovery(discoveryScope, { pruneMissing: discoveryScope !== "hot" });
    return lastDiscovery ?? emptyDiscoverySnapshot();
  }
  if (lastDiscovery && Date.now() - lastDiscovery.generatedAt <= DISCOVERY_CACHE_MAX_AGE_MS) {
    return lastDiscovery;
  }
  scheduleDiscovery(discoveryScope, { pruneMissing: discoveryScope !== "hot" });
  return lastDiscovery ?? emptyDiscoverySnapshot();
}

export async function refreshTailDiscovery(
  scope: TailDiscoveryScope = "shallow",
): Promise<DiscoverySnapshot> {
  return runDiscovery(scope, { pruneMissing: scope !== "hot" });
}

export function subscribeTail(handler: Subscriber): () => void {
  subscribers.add(handler);
  ensureLoopRunning();
  // Kick one moderate inventory pass immediately so the new subscriber is live;
  // after that, slower timers discover new movers.
  if (watchers.size === 0) {
    void runDiscovery("shallow", { pruneMissing: true })
      .then(() => pumpAllWatchers())
      .catch(() => {});
  } else {
    void pumpAllWatchers();
  }
  return () => {
    subscribers.delete(handler);
    if (subscribers.size === 0) {
      stopLoopIfIdle();
    }
  };
}

export function snapshotRecentEvents(limit = 500): TailEvent[] {
  return aggregateBuffer.slice(-limit);
}

export const __testing = {
  quietTailEventKey,
  resetQuietTailCoalescer: () => quietEventLastSeen.clear(),
  shouldCoalesceQuietTailEvent,
};

export async function readRecentLiveEvents(limit = 500): Promise<TailEvent[]> {
  if (watchers.size === 0) {
    scheduleDiscovery("shallow", { pruneMissing: true });
  } else if (!lastDiscovery || Date.now() - lastDiscovery.generatedAt > DISCOVERY_CACHE_MAX_AGE_MS) {
    scheduleDiscovery("hot", { pruneMissing: false });
  }
  void pumpAllWatchers();
  return snapshotRecentEvents(limit);
}

async function readRecentTranscriptLines(
  path: string,
  maxLines = RECENT_TRANSCRIPT_LINES_PER_FILE,
  maxBytes = RECENT_TRANSCRIPT_READ_BYTES,
): Promise<string[]> {
  let handle: FileHandle | null = null;
  try {
    const stats = await stat(path);
    if (stats.size <= 0) return [];
    const start = Math.max(0, stats.size - maxBytes);
    const length = stats.size - start;
    const buffer = Buffer.alloc(length);
    handle = await open(path, "r");
    await handle.read(buffer, 0, length, start);
    const lines = buffer.toString("utf8").split("\n");
    if (start > 0) {
      lines.shift();
    }
    return lines.filter(Boolean).slice(-maxLines);
  } catch {
    return [];
  } finally {
    await handle?.close().catch(() => {});
  }
}

function rememberTranscriptEvent(
  events: TailEvent[],
  seenEvents: Set<string>,
  event: TailEvent,
  dedupeKey?: string,
): void {
  const compacted = compactEvent(event);
  const key = dedupeKey ?? compacted.id;
  if (seenEvents.has(key)) return;
  seenEvents.add(key);
  events.push(compacted);
}

async function appendWatcherTranscriptEvents(
  events: TailEvent[],
  seenEvents: Set<string>,
  watcher: Watcher,
  perTranscriptLineLimit?: number,
): Promise<void> {
  const { source, transcript, process, transcriptPath } = watcher;
  if (source.parseFile) {
    const text = await readTranscriptText(transcriptPath);
    if (!text) return;
    const parsed = parsedEventsToArray(source.parseFile(text, {
      process,
      transcript,
      transcriptPath,
      lineOffset: 0,
      state: {},
    }));
    for (const event of parsed) {
      rememberTranscriptEvent(events, seenEvents, event);
    }
    return;
  }

  const lines = await readRecentTranscriptLines(
    transcriptPath,
    perTranscriptLineLimit,
  );
  const parseState: Record<string, unknown> = {};
  lines.forEach((line, index) => {
    const event = source.parseLine(line, {
      process,
      transcript,
      transcriptPath,
      lineOffset: index,
      state: parseState,
    });
    if (!event) return;
    const compacted = compactEvent(event);
    const eventKey = [
      compacted.source,
      compacted.sessionId,
      compacted.kind,
      compacted.summary,
    ].join("\u0000");
    rememberTranscriptEvent(events, seenEvents, event, eventKey);
  });
}

export async function readRecentTranscriptEvents(
  limit = 50,
  options?: {
    discovery?: DiscoverySnapshot | null;
    perTranscriptLineLimit?: number;
  },
): Promise<TailEvent[]> {
  if (watchers.size === 0) {
    if (options?.discovery) {
      for (const transcript of options.discovery.transcripts) {
        knownTranscripts.set(sessionRegistryKey(transcript), transcript);
      }
    } else {
      scheduleDiscovery("shallow", { pruneMissing: true });
    }
  }
  const events: TailEvent[] = [];
  const seenEvents = new Set<string>();
  const seenTranscriptPaths = new Set<string>();

  const transcriptReadLimit = Math.min(RECENT_TRANSCRIPT_MAX_FILES, Math.max(12, limit));
  const lineLimit = options?.perTranscriptLineLimit ?? RECENT_TRANSCRIPT_LINES_PER_FILE;
  const activeWatchers = [...watchers.values()]
    .sort((left, right) => right.transcript.mtimeMs - left.transcript.mtimeMs)
    .slice(0, transcriptReadLimit);

  for (const watcher of activeWatchers) {
    seenTranscriptPaths.add(watcher.transcriptPath);
    await appendWatcherTranscriptEvents(events, seenEvents, watcher, lineLimit);
  }

  // Replay discovered transcripts that are not actively watched — Claude/Codex
  // archives often have no live watcher while Grok floods the firehose buffer.
  if (options?.discovery?.transcripts?.length) {
    const discoveryTranscripts = [...options.discovery.transcripts]
      .filter((transcript) => !seenTranscriptPaths.has(transcript.transcriptPath))
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .slice(0, transcriptReadLimit);

    for (const transcript of discoveryTranscripts) {
      const parsed = await parseTranscriptSessionEvents(
        transcript,
        options.discovery.processes,
        lineLimit,
      );
      for (const event of parsed) {
        rememberTranscriptEvent(events, seenEvents, event);
      }
      seenTranscriptPaths.add(transcript.transcriptPath);
    }
  }

  return events
    .sort((left, right) => right.ts - left.ts)
    .slice(0, limit);
}

function normalizeTailSessionRef(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const leaf = basename(trimmed);
  return leaf.endsWith(".jsonl") ? leaf.slice(0, -".jsonl".length) : leaf;
}

function transcriptMatchesSessionRef(
  transcript: DiscoveredTranscript,
  normalizedRef: string,
): boolean {
  const refs = [
    normalizeTailSessionRef(transcript.sessionId),
    normalizeTailSessionRef(transcript.transcriptPath),
  ].filter((ref): ref is string => Boolean(ref));
  return refs.includes(normalizedRef);
}

function snapshotSessionEvents(sessionId: string, limit: number): TailEvent[] {
  const bucket = perSessionBuffer.get(sessionId);
  if (bucket?.length) {
    return bucket.slice(-limit);
  }
  return aggregateBuffer
    .filter((event) => event.sessionId === sessionId)
    .slice(-limit);
}

async function parseTranscriptSessionEvents(
  transcript: DiscoveredTranscript,
  processes: DiscoveredProcess[],
  limit: number,
): Promise<TailEvent[]> {
  const source = sources.find((candidate) => candidate.name === transcript.source);
  if (!source) return [];

  const process = processForTranscript(transcript, processes);
  const ctxBase = {
    process,
    transcript,
    transcriptPath: transcript.transcriptPath,
    lineOffset: 0,
    state: {} as Record<string, unknown>,
  };

  if (source.parseFile) {
    const text = await readTranscriptText(transcript.transcriptPath, SESSION_TRANSCRIPT_READ_BYTES);
    if (!text) return [];
    return parsedEventsToArray(source.parseFile(text, ctxBase))
      .map(redactTailEvent)
      .sort((left, right) => left.ts - right.ts)
      .slice(-limit);
  }

  const lineBudget = Math.max(limit, RECENT_TRANSCRIPT_LINES_PER_FILE);
  const lines = await readRecentTranscriptLines(
    transcript.transcriptPath,
    lineBudget,
    SESSION_TRANSCRIPT_READ_BYTES,
  );
  const events: TailEvent[] = [];
  lines.forEach((line, index) => {
    const event = source.parseLine(line, {
      ...ctxBase,
      lineOffset: index,
    });
    if (event) {
      events.push(compactEvent(event));
    }
  });
  return events
    .sort((left, right) => left.ts - right.ts)
    .slice(-limit);
}

export async function readTailEventsForSession(
  sessionRef: string,
  options?: {
    discovery?: DiscoverySnapshot;
    limit?: number;
    forceDiscovery?: boolean;
  },
): Promise<{ transcript: DiscoveredTranscript; events: TailEvent[] } | null> {
  const normalizedRef = normalizeTailSessionRef(sessionRef);
  if (!normalizedRef) return null;

  const discovery = options?.discovery
    ?? await getTailDiscovery(options?.forceDiscovery ?? false);
  const transcript = discovery.transcripts.find(
    (candidate) => NATIVE_TAIL_SOURCES.has(candidate.source)
      && transcriptMatchesSessionRef(candidate, normalizedRef),
  );
  if (!transcript) return null;

  const limit = options?.limit ?? 2_000;
  const sessionId = transcript.sessionId?.trim() || normalizedRef;
  let events = snapshotSessionEvents(sessionId, limit);
  if (events.length === 0) {
    events = await parseTranscriptSessionEvents(transcript, discovery.processes, limit);
  }

  return { transcript, events };
}
