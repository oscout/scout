import "./mission-control.css";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import {
  clearMissionRevealRequest,
  clearMissionSelection,
  setMissionFocusedId,
  setMissionVisibleAgents,
  toggleMissionSelected,
  useMissionControlStore,
  type MissionActivityState,
} from "../../lib/mission-control-store.ts";
import { useObservePolling } from "../../lib/observe.ts";
import { ensureAgentChat } from "../../lib/agent-chat.ts";
import { isEditableTarget, isModalShortcutContext } from "../../lib/keyboard-nav-core.ts";
import { filterTailEventsForDisplay } from "../../lib/tail-display.ts";
import { useTailEvents } from "../../lib/tail-events.ts";
import { useScout } from "../../scout/Provider.tsx";
import type {
  Agent,
  ObserveData,
  Route,
  TailDiscoveredTranscript,
  TailDiscoverySnapshot,
  TailEvent,
} from "../../lib/types.ts";
import { MissionContextRail } from "./MissionContextRail.tsx";
import { FocusOverlay } from "./MissionFocusOverlay.tsx";
import { MissionLogPane } from "./MissionLogPane.tsx";
import { observeDataFromTail, type AgentLane } from "./agent-lanes-model.ts";
import { ACTIVE_EVENT_WINDOW_MS } from "./mission-control-model.ts";
import { moveWallCursor, wallCursorMoveForKey } from "./mission-cursor.ts";
import {
  WALL_GAP,
  buildMissionLogs,
  computeWallTiling,
  filterMissionLogs,
  missionLogShortId,
  missionLogTitle,
  nextWallTiling,
  sortMissionLogs,
  type MissionAgentRef,
  type MissionLog,
} from "./mission-wall.ts";

/** Firehose retention across the whole wall (per-pane retention is separate). */
const TAIL_BUFFER = 4_000;
/** Live events arrive one at a time; repaint the wall on a fixed cadence instead. */
const FLUSH_INTERVAL_MS = 250;
const DISCOVERY_REFRESH_MS = 30_000;
const RECENT_TAIL_LIMIT = 1_500;
const REVEAL_FLASH_MS = 1_800;

/* ── Identity ── */

function agentRefs(
  agents: Agent[],
  sessionIdsByAgent: Map<string, string[]>,
): MissionAgentRef[] {
  return agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    handle: agent.handle,
    state: agent.state,
    project: agent.project,
    branch: agent.branch,
    harness: agent.harness,
    model: agent.model,
    sessionIds: sessionIdsByAgent.get(agent.id) ?? [],
  }));
}

/**
 * A log without a registered Scout agent still needs an `Agent` to drive the
 * focus overlay (profile, activity, steer). Synthesize one from the log.
 */
function syntheticAgent(log: MissionLog): Agent {
  return {
    id: `native:${log.source}:${log.sessionId}`,
    definitionId: `native:${log.source}:${log.sessionId}`,
    name: `${log.source} · ${log.project}`,
    handle: log.sessionId.slice(0, 8),
    agentClass: "native-session",
    harness: log.source,
    state: log.live ? "working" : "ready",
    projectRoot: log.cwd,
    cwd: log.cwd,
    updatedAt: log.lastActiveAt,
    createdAt: null,
    transport: "tail",
    selector: null,
    defaultSelector: null,
    nodeQualifier: null,
    workspaceQualifier: null,
    wakePolicy: null,
    capabilities: [],
    project: log.project,
    branch: log.attribution === "unattributed" ? "native session" : log.attribution,
    role: "native session",
    model: null,
    harnessSessionId: log.sessionId,
    terminalSurface: null,
    harnessLogPath: log.logPath,
    conversationId: null,
    homeNodeId: null,
    homeNodeName: null,
    ownerId: null,
    ownerName: null,
    ownerHandle: null,
    staleLocalRegistration: false,
    retiredFromFleet: false,
    replacedByAgentId: null,
  };
}

function isNativeSessionAgent(agent: Agent): boolean {
  return agent.agentClass === "native-session" || agent.id.startsWith("native:");
}

/** The registered agent behind a log, or a stand-in synthesized from the log. */
function resolveLogAgent(log: MissionLog, agents: Agent[]): Agent {
  if (log.agent) {
    const registered = agents.find((agent) => agent.id === log.agent!.id);
    if (registered) return registered;
  }
  return syntheticAgent(log);
}

/**
 * The discovered transcript for a log, or a stand-in built from the log itself.
 * `observeDataFromTail` reads identity off the transcript, and a log that has
 * only ever been seen on the firehose has no discovery record to read.
 */
function transcriptForLog(
  log: MissionLog,
  transcripts: TailDiscoveredTranscript[],
): TailDiscoveredTranscript {
  const found = transcripts.find((transcript) => transcript.sessionId?.trim() === log.sessionId);
  if (found) return found;
  return {
    source: log.source,
    transcriptPath: log.logPath ?? "",
    sessionId: log.sessionId,
    cwd: log.cwd,
    project: log.project,
    harness: log.attribution,
    mtimeMs: log.lastActiveAt,
    size: 0,
  };
}

function nativeSessionInstructionsPayload(agent: Agent, instructions: string) {
  const sessionId = agent.harnessSessionId?.trim();
  if (!sessionId) {
    throw new Error("This native session has no session id to continue.");
  }
  const projectPath = agent.projectRoot?.trim() || agent.cwd?.trim();
  if (!projectPath) {
    throw new Error("This native session has no project path to route from.");
  }
  const harness = agent.harness?.trim();
  const model = agent.model?.trim();
  return {
    target: { projectPath },
    execution: {
      session: "existing",
      targetSessionId: sessionId,
      ...(harness ? { harness } : {}),
      ...(model ? { model } : {}),
    },
    agent: {
      persistence: "one_time",
      ...(agent.handle?.trim() ? { handle: agent.handle.trim() } : {}),
    },
    seed: { instructions },
  };
}

async function sendToFocusedAgentSession(agent: Agent, body: string): Promise<void> {
  if (isNativeSessionAgent(agent)) {
    await api<unknown>("/api/sessions", {
      method: "POST",
      body: JSON.stringify(nativeSessionInstructionsPayload(agent, body)),
    });
    return;
  }

  const conversationId = await ensureAgentChat(agent);
  await api<unknown>("/api/send", {
    method: "POST",
    body: JSON.stringify({
      body,
      chatId: conversationId,
      execution: {
        ...(agent.harness?.trim() ? { harness: agent.harness.trim() } : {}),
        ...(agent.model?.trim() ? { model: agent.model.trim() } : {}),
      },
    }),
  });
}

function missionActivity(log: MissionLog, now: number, windowMs: number): MissionActivityState {
  if (log.live) return "active";
  if (log.lastActiveAt > 0 && now - log.lastActiveAt <= windowMs) return "recent";
  return "idle";
}

/* ── Wall ── */

export function MissionControlView({
  navigate,
  agents,
}: {
  navigate: (r: Route) => void;
  agents: Agent[];
}) {
  const mc = useMissionControlStore();
  const { openFilePreview } = useScout();
  const {
    activityFilter,
    sourceFilter,
    activityWindowMs,
    groupMode,
    query,
    focusedId,
    revealRequest,
  } = mc;

  const [tailEvents, setTailEvents] = useState<TailEvent[]>([]);
  const [discovery, setDiscovery] = useState<TailDiscoverySnapshot | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const observeCache = useObservePolling(agents);

  /* ── Firehose ── */

  const pendingRef = useRef<TailEvent[]>([]);
  useTailEvents((event) => {
    pendingRef.current.push(event);
  });

  useEffect(() => {
    const timer = setInterval(() => {
      if (pendingRef.current.length === 0) return;
      const incoming = pendingRef.current;
      pendingRef.current = [];
      setTailEvents((previous) => {
        // Replayed events are dropped here as well as in buildMissionLogs, so
        // a re-read transcript can't evict live lines out of the buffer.
        const seen = new Set(previous.map((event) => event.id));
        const fresh = incoming.filter((event) => !event.id || !seen.has(event.id));
        if (fresh.length === 0) return previous;
        const next = previous.concat(fresh);
        return next.length > TAIL_BUFFER ? next.slice(next.length - TAIL_BUFFER) : next;
      });
    }, FLUSH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);

  // Backfill runs exactly once: it is a multi-second scan, and once it lands the
  // WebSocket keeps every pane current. Re-running it on a poll would re-read
  // the same history and stall the wall.
  useEffect(() => {
    let cancelled = false;
    void api<{ events: TailEvent[] }>(`/api/tail/recent?limit=${RECENT_TAIL_LIMIT}`)
      .then((payload) => {
        if (cancelled) return;
        const seed = payload.events ?? [];
        setTailEvents((previous) => {
          // Live events that arrived during the backfill win over the snapshot.
          const seen = new Set(previous.map((event) => event.id));
          const merged = seed.filter((event) => !seen.has(event.id)).concat(previous);
          return merged.length > TAIL_BUFFER ? merged.slice(merged.length - TAIL_BUFFER) : merged;
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Discovery only supplies identity (which file a session writes to), so it can
  // poll cheaply and independently.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const snapshot = await api<TailDiscoverySnapshot>("/api/tail/discover");
        if (!cancelled) setDiscovery(snapshot);
      } catch {}
    };
    void load();
    const timer = setInterval(() => void load(), DISCOVERY_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  /* ── Logs ── */

  const sessionIdsByAgent = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const agent of agents) {
      const observe = observeCache[agent.id];
      const ids = [
        agent.harnessSessionId,
        observe?.sessionId,
        observe?.data.metadata?.session?.externalSessionId,
      ]
        .map((id) => id?.trim())
        .filter((id): id is string => Boolean(id));
      map.set(agent.id, [...new Set(ids)]);
    }
    return map;
  }, [agents, observeCache]);

  const logs = useMemo(
    () =>
      buildMissionLogs({
        events: filterTailEventsForDisplay(tailEvents, "work"),
        transcripts: discovery?.transcripts ?? [],
        agents: agentRefs(agents, sessionIdsByAgent),
        now,
        liveWindowMs: ACTIVE_EVENT_WINDOW_MS,
      }),
    [agents, discovery?.transcripts, now, sessionIdsByAgent, tailEvents],
  );

  const [pinnedId, setPinnedId] = useState<string | null>(null);

  const ordered = useMemo(() => {
    const visible = sortMissionLogs(
      filterMissionLogs(logs, {
        sourceFilter,
        activityFilter,
        query,
        now,
        activeWindowMs: activityWindowMs,
      }),
      groupMode,
    );
    if (!pinnedId) return visible;
    const pinned = visible.find((log) => log.id === pinnedId);
    if (!pinned) return visible;
    return [pinned, ...visible.filter((log) => log.id !== pinnedId)];
  }, [activityFilter, activityWindowMs, groupMode, logs, now, pinnedId, query, sourceFilter]);

  /* ── Tiling ── */

  const wallRef = useRef<HTMLDivElement>(null);
  // State holds the discrete tiling, not the measured size: a drag-resize
  // reports a new contentRect every frame, but the wall only changes at grid
  // breakpoints. Keep the latest tiling in a ref so frames inside the same
  // breakpoint do not even enqueue a React state update — CSS `1fr` tracks
  // absorb those pixel-size changes natively.
  const wallSizeRef = useRef({ w: 0, h: 0 });
  const paneCountRef = useRef(0);
  // ResizeObserver may deliver between commit and effects. Publish the count
  // during render so it can never retile against the previous pane set.
  paneCountRef.current = ordered.length;
  const [tiling, setTiling] = useState(() => computeWallTiling(0, { w: 0, h: 0 }));
  const tilingRef = useRef(tiling);

  const updateTiling = useCallback((count: number, size: { w: number; h: number }) => {
    const next = nextWallTiling(tilingRef.current, count, size);
    if (next === tilingRef.current) return;
    tilingRef.current = next;
    setTiling(next);
  }, []);

  useEffect(() => {
    const node = wallRef.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      wallSizeRef.current = { w: entry.contentRect.width, h: entry.contentRect.height };
      updateTiling(paneCountRef.current, wallSizeRef.current);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [updateTiling]);

  useLayoutEffect(() => {
    updateTiling(ordered.length, wallSizeRef.current);
  }, [ordered.length, updateTiling]);
  const shown = useMemo(() => ordered.slice(0, tiling.shown), [ordered, tiling.shown]);
  // The keydown handler is bound once; a ref keeps `j`/`k` stepping the row
  // width the wall is actually tiled at without rebinding on every retile.
  const colsRef = useRef(1);
  colsRef.current = Math.max(1, tiling.cols);

  /* ── Left-rail mirror ── */

  useEffect(() => {
    setMissionVisibleAgents(ordered.map((log) => ({
      id: log.id,
      name: log.agent?.name ?? missionLogTitle(log),
      handle: log.agent?.handle ?? missionLogShortId(log),
      harness: log.source,
      branch: log.agent?.branch ?? null,
      project: log.project,
      model: log.agent?.model ?? null,
      state: log.agent?.state ?? null,
      agentClass: log.agent ? "agent" : "native-session",
      updatedAt: log.lastActiveAt,
      source: log.agent || log.attribution === "scout-managed" ? "scout" : "native",
      activity: missionActivity(log, now, activityWindowMs),
      lastActiveAt: log.lastActiveAt,
    })));
  }, [activityWindowMs, now, ordered]);

  /* ── Reveal from the left rail ── */

  const [revealedId, setRevealedId] = useState<string | null>(null);
  const consumedRevealRef = useRef<number | null>(null);
  const revealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!revealRequest) return;
    if (consumedRevealRef.current === revealRequest.serial) return;
    consumedRevealRef.current = revealRequest.serial;
    // Pinning guarantees the pane is inside the wall's cap, not just highlighted.
    setPinnedId(revealRequest.id);
    setRevealedId(revealRequest.id);
    if (revealTimerRef.current) clearTimeout(revealTimerRef.current);
    revealTimerRef.current = setTimeout(() => setRevealedId(null), REVEAL_FLASH_MS);
    clearMissionRevealRequest(revealRequest.serial);
  }, [revealRequest]);

  useEffect(() => () => {
    if (revealTimerRef.current) clearTimeout(revealTimerRef.current);
  }, []);

  /* ── Focus ── */

  const focusedLog = focusedId ? logs.find((log) => log.id === focusedId) ?? null : null;
  const focusedAgent = useMemo(
    () => (focusedLog ? resolveLogAgent(focusedLog, agents) : null),
    [agents, focusedLog],
  );
  const focusedObserve: ObserveData | null = focusedLog?.agent
    ? observeCache[focusedLog.agent.id]?.data ?? null
    : null;

  /* ── Cursor + context rail ── */

  // The cursor is held as a log id, not an index: the wall re-sorts on every
  // flush (most recently active first), so an index would silently slide onto a
  // different session while the operator sat still.
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [railOpen, setRailOpen] = useState(false);
  const cursorIndex = cursorId ? shown.findIndex((log) => log.id === cursorId) : -1;
  const cursorRef = useRef({ index: -1, ids: [] as string[] });
  cursorRef.current = { index: cursorIndex, ids: shown.map((log) => log.id) };

  // The rail reads from every log, not just the tiled ones: a pane withheld by
  // the wall's legibility cap still has context worth showing.
  const cursorLog = cursorId ? logs.find((log) => log.id === cursorId) ?? null : null;
  const railLog = railOpen ? cursorLog : null;

  useEffect(() => {
    if (railOpen && !cursorLog) setRailOpen(false);
  }, [cursorLog, railOpen]);

  const paneRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const registerPaneRef = useCallback((id: string, node: HTMLDivElement | null) => {
    if (node) paneRefs.current.set(id, node);
    else paneRefs.current.delete(id);
  }, []);

  useEffect(() => {
    if (!cursorId) return;
    paneRefs.current.get(cursorId)?.focus({ preventScroll: true });
  }, [cursorId]);

  const railLane: AgentLane | null = useMemo(() => {
    if (!railLog) return null;
    const agent = resolveLogAgent(railLog, agents);
    // A registered agent's own observe is richer than anything the firehose can
    // reconstruct (usage, diffs); fall back to the tail only when there is none.
    const observe = (railLog.agent ? observeCache[railLog.agent.id]?.data ?? null : null)
      ?? observeDataFromTail(
        transcriptForLog(railLog, discovery?.transcripts ?? []),
        railLog.lines,
        railLog.live,
        { now },
      );
    return {
      id: railLog.id,
      agent,
      source: railLog.agent ? "scout" : "native",
      observe,
      lastActiveAt: railLog.lastActiveAt,
      current: railLog.live,
    };
  }, [agents, discovery?.transcripts, now, observeCache, railLog]);

  const openLog = useCallback(
    (log: MissionLog) => {
      navigate({ view: "ops", mode: "tail", tailQuery: log.sessionId });
    },
    [navigate],
  );

  const inspect = useCallback((id: string) => {
    setCursorId(id);
    setRailOpen(true);
  }, []);

  const shortcutStateRef = useRef({
    focusedId,
    railOpen,
    pinnedId,
    selectedIds: mc.selectedIds,
    visibleAgents: mc.visibleAgents,
  });
  shortcutStateRef.current = {
    focusedId,
    railOpen,
    pinnedId,
    selectedIds: mc.selectedIds,
    visibleAgents: mc.visibleAgents,
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      const shortcutState = shortcutStateRef.current;

      // The focus overlay is a real modal: while it is up it owns every key
      // except the one that dismisses it.
      if (shortcutState.focusedId) {
        if (e.key === "Escape") setMissionFocusedId(null);
        return;
      }
      if (isModalShortcutContext()) return;

      if (e.key === "Escape") {
        if (shortcutState.railOpen) setRailOpen(false);
        else if (shortcutState.selectedIds.length > 0) clearMissionSelection();
        else if (shortcutState.pinnedId) setPinnedId(null);
        else setCursorId(null);
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key === "a") {
        if (shortcutState.visibleAgents.length === 0) return;
        e.preventDefault();
        const ids = shortcutState.visibleAgents.map((a) => a.id);
        const allSelected = ids.every((id) => shortcutState.selectedIds.includes(id));
        if (allSelected) {
          clearMissionSelection();
          return;
        }
        for (const id of ids) {
          if (!shortcutState.selectedIds.includes(id)) toggleMissionSelected(id);
        }
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const { index, ids } = cursorRef.current;
      if (ids.length === 0) return;

      const move = wallCursorMoveForKey(e.key);
      if (move) {
        e.preventDefault();
        const next = moveWallCursor(index, ids.length, colsRef.current, move);
        setCursorId(ids[next] ?? null);
        return;
      }

      const landed = index < 0 ? 0 : index;
      const id = ids[landed];
      if (!id) return;

      if (e.key === "Enter" || e.key === "i") {
        e.preventDefault();
        inspect(id);
        return;
      }
      if (e.key === "o") {
        // The full overlay — profile, activity and steering — is a deliberate
        // second step, since it covers the wall the rail is careful not to.
        e.preventDefault();
        setCursorId(id);
        setMissionFocusedId(id);
        return;
      }
      if (e.key === "x" || e.key === " ") {
        e.preventDefault();
        setCursorId(id);
        toggleMissionSelected(id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inspect]);

  const streamingLines = shown.reduce((total, log) => total + log.lines.length, 0);
  const quiet = logs.length - ordered.length;

  return (
    <div className="s-wall">
      <div className="s-wall-status">
        <span className="s-wall-status-key">logs</span>
        <span className="s-wall-status-value">
          {tiling.shown}/{ordered.length}
        </span>
        <span className="s-wall-status-key">grid</span>
        <span className="s-wall-status-value">
          {tiling.cols > 0 ? `${tiling.cols}×${tiling.rows}` : "—"}
        </span>
        <span className="s-wall-status-key">lines</span>
        <span className="s-wall-status-value">{streamingLines}</span>
        {tiling.hidden > 0 && (
          <span className="s-wall-status-hidden" title="Least recently active logs are withheld to keep panes readable">
            {tiling.hidden} withheld
          </span>
        )}
        {quiet > 0 && (
          <span className="s-wall-status-hidden" title="Sessions discovery knows of that have produced no output to tail">
            {quiet} quiet
          </span>
        )}
        {shown.length > 0 && (
          <span className="s-wall-status-keys">
            <kbd>hjkl</kbd> move · <kbd>⏎</kbd> context · <kbd>o</kbd> expand
          </span>
        )}
        {pinnedId && (
          <button type="button" className="s-wall-status-pin" onClick={() => setPinnedId(null)}>
            unpin
          </button>
        )}
      </div>

      <div
        ref={wallRef}
        className={`s-wall-grid${railOpen ? " s-wall-grid--railed" : ""}`}
        style={{
          gridTemplateColumns: `repeat(${Math.max(1, tiling.cols)}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${Math.max(1, tiling.rows)}, minmax(0, 1fr))`,
          gap: WALL_GAP,
        }}
      >
        {shown.length === 0 ? (
          <div className="s-wall-empty">
            <div className="s-wall-empty-title">
              {logs.length === 0 ? "No logs on the wire" : "No matching logs"}
            </div>
            <div className="s-wall-empty-sub">
              {logs.length === 0
                ? "Panes appear as sessions start writing to their transcripts."
                : "Widen the activity window or clear the filter."}
            </div>
          </div>
        ) : (
          shown.map((log) => (
            <MissionLogPane
              key={log.id}
              log={log}
              selected={mc.selectedIds.includes(log.id)}
              revealed={revealedId === log.id}
              cursor={cursorId === log.id}
              paneRef={(node) => registerPaneRef(log.id, node)}
              onOpen={() => inspect(log.id)}
              onToggleSelected={() => toggleMissionSelected(log.id)}
              onOpenLog={() => openLog(log)}
            />
          ))
        )}
      </div>

      {railLog && railLane && (
        <MissionContextRail
          log={railLog}
          lane={railLane}
          onClose={() => setRailOpen(false)}
          onExpand={() => setMissionFocusedId(railLog.id)}
          onTail={() => openLog(railLog)}
          onOpenLog={() => navigate({ view: "sessions", sessionId: railLog.sessionId })}
          onOpenFile={openFilePreview}
        />
      )}

      {focusedAgent && (
        <FocusOverlay
          agent={focusedAgent}
          observe={focusedObserve}
          onClose={() => setMissionFocusedId(null)}
          onSend={(body) => sendToFocusedAgentSession(focusedAgent, body)}
          onOpenConversation={() => {
            setMissionFocusedId(null);
            if (isNativeSessionAgent(focusedAgent) && focusedAgent.harnessSessionId) {
              navigate({ view: "sessions", sessionId: focusedAgent.harnessSessionId });
              return;
            }
            void ensureAgentChat(focusedAgent)
              .then((conversationId) => navigate({ view: "conversation", conversationId }))
              .catch(() => navigate({
                view: "agents-v2",
                agentId: focusedAgent.id,
                tab: "message",
              }));
          }}
          onTail={() => {
            setMissionFocusedId(null);
            navigate({
              view: "ops",
              mode: "tail",
              tailQuery: focusedAgent.harnessSessionId ?? focusedAgent.handle ?? focusedAgent.name,
            });
          }}
          onProfile={() => {
            setMissionFocusedId(null);
            navigate({ view: "agents-v2", agentId: focusedAgent.id });
          }}
        />
      )}
    </div>
  );
}
