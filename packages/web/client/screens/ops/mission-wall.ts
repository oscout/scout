/**
 * Mission Control wall model.
 *
 * Mission Control is a wall of tails: one pane per *log* (a session in the tail
 * firehose), tiled to fill the viewport. Two pure concerns live here —
 *
 *  1. `buildMissionLogs` splits the flat tail firehose into per-log streams and
 *     attaches whatever identity we can resolve (Scout agent, discovered
 *     transcript). The pane body is the raw tail lines for that log, not a
 *     summary of them.
 *  2. `computeWallTiling` picks the rows × cols that fit the current pane count
 *     into the viewport at a legible size, dropping the tail of the list rather
 *     than shrinking panes past the point of readability.
 */
import type {
  TailDiscoveredTranscript,
  TailEvent,
} from "../../lib/types.ts";
import type { MissionGroupMode } from "../../lib/mission-control-store.ts";
import { missionGroupLabel } from "./mission-control-model.ts";

/** Hard ceiling on rendered panes — past this the wall stops being readable. */
export const WALL_MAX_PANES = 16;
/** A pane narrower/shorter than this can't hold a legible tail line. */
export const WALL_MIN_PANE_W = 300;
export const WALL_MIN_PANE_H = 180;
export const WALL_GAP = 8;
/** Tail lines retained per pane. */
export const WALL_PANE_BUFFER = 400;

/** Log panes read wide — bias the tiling toward landscape cells. */
const TARGET_PANE_ASPECT = 1.55;
/** Used before the viewport has been measured so the first paint isn't blank. */
const FALLBACK_VIEWPORT = { w: 1440, h: 860 };

export type WallTiling = {
  cols: number;
  rows: number;
  /** Panes actually rendered. */
  shown: number;
  /** Panes withheld because the wall can't hold them legibly. */
  hidden: number;
  paneW: number;
  paneH: number;
};

type Arrangement = {
  cols: number;
  rows: number;
  paneW: number;
  paneH: number;
  waste: number;
  fit: number;
};

function bestArrangement(
  shown: number,
  w: number,
  h: number,
  gap: number,
  minW: number,
  minH: number,
): Arrangement | null {
  let best: Arrangement | null = null;
  for (let cols = 1; cols <= shown; cols += 1) {
    const rows = Math.ceil(shown / cols);
    const paneW = (w - gap * (cols - 1)) / cols;
    const paneH = (h - gap * (rows - 1)) / rows;
    if (paneW < minW || paneH < minH) continue;
    // Prefer arrangements that leave no empty cells; among those, the one whose
    // cells best contain a landscape rectangle (i.e. the widest readable pane).
    const waste = cols * rows - shown;
    const fit = Math.min(paneW, paneH * TARGET_PANE_ASPECT)
      * Math.min(paneW / TARGET_PANE_ASPECT, paneH);
    if (!best || waste < best.waste || (waste === best.waste && fit > best.fit)) {
      best = { cols, rows, paneW, paneH, waste, fit };
    }
  }
  return best;
}

export type WallTilingOptions = {
  max?: number;
  minW?: number;
  minH?: number;
  gap?: number;
};

export function computeWallTiling(
  count: number,
  viewport: { w: number; h: number },
  options: WallTilingOptions = {},
): WallTiling {
  const max = options.max ?? WALL_MAX_PANES;
  const minW = options.minW ?? WALL_MIN_PANE_W;
  const minH = options.minH ?? WALL_MIN_PANE_H;
  const gap = options.gap ?? WALL_GAP;
  const w = viewport.w > 0 ? viewport.w : FALLBACK_VIEWPORT.w;
  const h = viewport.h > 0 ? viewport.h : FALLBACK_VIEWPORT.h;

  const total = Math.max(0, Math.floor(count));
  if (total === 0) return { cols: 0, rows: 0, shown: 0, hidden: 0, paneW: 0, paneH: 0 };

  for (let shown = Math.min(total, max); shown >= 1; shown -= 1) {
    const best = bestArrangement(shown, w, h, gap, minW, minH);
    if (!best) continue;
    return {
      cols: best.cols,
      rows: best.rows,
      shown,
      hidden: total - shown,
      paneW: best.paneW,
      paneH: best.paneH,
    };
  }

  // Viewport too small for even one pane at the legibility floor: show one
  // anyway rather than an empty wall.
  return { cols: 1, rows: 1, shown: 1, hidden: total - 1, paneW: w, paneH: h };
}

/**
 * Retile for a new viewport/count, but return `previous` — same reference —
 * when the discrete grid (cols × rows, shown/hidden) is unchanged. A window
 * resize reports a new viewport every frame while the grid only changes at
 * breakpoints; committing the identical reference between breakpoints lets the
 * wall skip React work entirely and leave per-frame pane sizing to the CSS
 * `1fr` tracks. Consequence: `paneW`/`paneH` on a retained tiling lag the live
 * viewport — nothing may render from them.
 */
export function nextWallTiling(
  previous: WallTiling | null,
  count: number,
  viewport: { w: number; h: number },
  options: WallTilingOptions = {},
): WallTiling {
  const next = computeWallTiling(count, viewport, options);
  if (
    previous
    && previous.cols === next.cols
    && previous.rows === next.rows
    && previous.shown === next.shown
    && previous.hidden === next.hidden
  ) {
    return previous;
  }
  return next;
}

/* ── Log assembly ── */

export type MissionAgentRef = {
  id: string;
  name: string;
  handle: string | null;
  state: string | null;
  project: string | null;
  branch: string | null;
  harness: string | null;
  model: string | null;
  /** Every session id this agent is known by (registration + observe). */
  sessionIds: string[];
};

export type MissionLog = {
  /** Stable pane key. */
  id: string;
  sessionId: string;
  /** Runtime that writes this log ("claude", "codex", …). */
  source: string;
  attribution: TailEvent["harness"];
  project: string;
  cwd: string | null;
  /** Transcript path when we know which file this log is. */
  logPath: string | null;
  agent: MissionAgentRef | null;
  /** Raw tail lines, oldest first. */
  lines: TailEvent[];
  lastActiveAt: number;
  live: boolean;
};

function transcriptSessionKey(transcript: TailDiscoveredTranscript): string | null {
  const sessionId = transcript.sessionId?.trim();
  return sessionId ? sessionId : null;
}

/**
 * Split the firehose into per-session logs, seeded by discovered transcripts so
 * a session that has not emitted since page load still gets a pane.
 */
export function buildMissionLogs(input: {
  events: TailEvent[];
  transcripts: TailDiscoveredTranscript[];
  agents: MissionAgentRef[];
  now: number;
  liveWindowMs: number;
  bufferPerLog?: number;
}): MissionLog[] {
  const buffer = input.bufferPerLog ?? WALL_PANE_BUFFER;

  const agentBySession = new Map<string, MissionAgentRef>();
  for (const agent of input.agents) {
    for (const sessionId of agent.sessionIds) {
      const key = sessionId.trim();
      if (key) agentBySession.set(key, agent);
    }
  }

  const logs = new Map<string, MissionLog>();

  const ensure = (sessionId: string, seed: Omit<MissionLog, "id" | "sessionId" | "lines" | "lastActiveAt" | "live" | "agent">) => {
    const existing = logs.get(sessionId);
    if (existing) return existing;
    const created: MissionLog = {
      id: sessionId,
      sessionId,
      lines: [],
      lastActiveAt: 0,
      live: false,
      agent: agentBySession.get(sessionId) ?? null,
      ...seed,
    };
    logs.set(sessionId, created);
    return created;
  };

  for (const transcript of input.transcripts) {
    const sessionId = transcriptSessionKey(transcript);
    if (!sessionId) continue;
    const log = ensure(sessionId, {
      source: transcript.source,
      attribution: transcript.harness,
      project: transcript.project,
      cwd: transcript.cwd,
      logPath: transcript.transcriptPath,
    });
    log.lastActiveAt = Math.max(log.lastActiveAt, transcript.mtimeMs ?? 0);
  }

  // The firehose replays: the backfill snapshot and the socket both carry an
  // event when a transcript is re-read, so the same id can arrive twice.
  const seenLineIds = new Set<string>();

  for (const event of input.events) {
    const sessionId = event.sessionId?.trim();
    if (!sessionId) continue;
    if (event.id) {
      if (seenLineIds.has(event.id)) continue;
      seenLineIds.add(event.id);
    }
    const log = ensure(sessionId, {
      source: event.source,
      attribution: event.harness,
      project: event.project,
      cwd: event.cwd,
      logPath: null,
    });
    // The firehose is authoritative for identity — a transcript seed can be stale.
    log.source = event.source;
    log.attribution = event.harness;
    log.project = event.project || log.project;
    log.cwd = event.cwd || log.cwd;
    log.lines.push(event);
    log.lastActiveAt = Math.max(log.lastActiveAt, event.ts);
  }

  const result: MissionLog[] = [];
  for (const log of logs.values()) {
    if (log.lines.length > buffer) log.lines = log.lines.slice(log.lines.length - buffer);
    log.live = log.lastActiveAt > 0 && input.now - log.lastActiveAt <= input.liveWindowMs;
    result.push(log);
  }
  return result;
}

/** Free-text match over everything a pane displays about its log. */
export function missionLogMatchesQuery(log: MissionLog, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [
    log.agent?.name,
    log.agent?.handle,
    log.agent?.branch,
    log.project,
    log.source,
    log.sessionId,
    log.cwd,
    log.logPath,
  ]
    .filter((value): value is string => Boolean(value))
    .some((value) => value.toLowerCase().includes(needle));
}

export type MissionLogFilters = {
  sourceFilter: "all" | "scout" | "native";
  activityFilter: "active" | "live" | "all";
  query: string;
  now: number;
  activeWindowMs: number;
  /**
   * Drop logs we know about but cannot tail. Discovery knows of far more
   * transcripts than are producing output, and a pane with nothing to stream
   * is a wasted cell — it would push a live log off the wall. Defaults on.
   */
  requireOutput?: boolean;
};

function logIsScoutManaged(log: MissionLog): boolean {
  return log.attribution === "scout-managed" || log.agent !== null;
}

export function filterMissionLogs(
  logs: MissionLog[],
  filters: MissionLogFilters,
): MissionLog[] {
  const requireOutput = filters.requireOutput ?? true;
  return logs.filter((log) => {
    if (requireOutput && log.lines.length === 0) return false;
    if (filters.sourceFilter === "scout" && !logIsScoutManaged(log)) return false;
    if (filters.sourceFilter === "native" && logIsScoutManaged(log)) return false;

    if (filters.activityFilter === "live" && !log.live) return false;
    if (filters.activityFilter === "active") {
      const age = filters.now - log.lastActiveAt;
      if (!(log.lastActiveAt > 0 && age <= filters.activeWindowMs)) return false;
    }

    return missionLogMatchesQuery(log, filters.query);
  });
}

/** The dimension label a log sorts under for the current order-by mode. */
export function missionLogOrderLabel(log: MissionLog, mode: MissionGroupMode): string {
  if (mode === "activity") return "";
  return missionGroupLabel(
    {
      activityLabel: "",
      workspace: log.project,
      harness: log.source,
      state: log.agent?.state ?? null,
      source: logIsScoutManaged(log) ? "scout" : "native",
    },
    mode,
  );
}

/** Most recent output first, with logs of the same order-by value kept adjacent. */
export function sortMissionLogs(logs: MissionLog[], mode: MissionGroupMode): MissionLog[] {
  const recencyByLabel = new Map<string, number>();
  for (const log of logs) {
    const label = missionLogOrderLabel(log, mode);
    recencyByLabel.set(label, Math.max(recencyByLabel.get(label) ?? 0, log.lastActiveAt));
  }
  return [...logs].sort((a, b) => {
    const aLabel = missionLogOrderLabel(a, mode);
    const bLabel = missionLogOrderLabel(b, mode);
    if (aLabel !== bLabel) {
      const recency = (recencyByLabel.get(bLabel) ?? 0) - (recencyByLabel.get(aLabel) ?? 0);
      if (recency !== 0) return recency;
      return aLabel.localeCompare(bLabel);
    }
    if (a.lastActiveAt !== b.lastActiveAt) return b.lastActiveAt - a.lastActiveAt;
    return a.sessionId.localeCompare(b.sessionId);
  });
}

/**
 * Abbreviated session id. Long enough to survive UUIDv7: harness sessions
 * started in the same millisecond share their first 8 characters, so an 8-char
 * id renders two different panes under the same name.
 */
export function missionLogShortId(log: MissionLog): string {
  return log.sessionId.slice(0, 13);
}

/** Short display name for a log — the agent's handle when we know it. */
export function missionLogTitle(log: MissionLog): string {
  const handle = log.agent?.handle?.trim();
  if (handle) return `@${handle}`;
  const name = log.agent?.name?.trim();
  if (name) return name;
  return `${log.source}:${missionLogShortId(log)}`;
}

/** The log file this pane is tailing, as a short readable label. */
export function missionLogFileLabel(log: MissionLog): string {
  const path = log.logPath?.trim();
  if (path) return path.split("/").pop() || path;
  return `${log.sessionId.slice(0, 12)}.log`;
}
