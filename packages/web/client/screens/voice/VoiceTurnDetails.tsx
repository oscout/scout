import { useEffect, useRef, useState } from "react";

import { api } from "../../lib/api.ts";
import { turnTotal, type VoiceTurn } from "../../lib/voice-turn-ledger.ts";

/**
 * Technical details for one held turn — the inspector the lane picture
 * cannot carry: ms-precise span ledger from the client ledger, the
 * scoutbot session (prompt · reply · model), the server request ledger
 * (per-call ms — the precise LLM and TTS legs), and the host voice
 * sessions (dictation + speech) with their event timelines, matched by time
 * window. Everything fetched lazily when the disclosure opens; anything
 * the server has already pruned is reported as expired rather than
 * guessed at.
 */

type VoiceSessionSummary = {
  sessionId: string;
  status: string;
  surface: string;
  clientId: string;
  createdAt: number;
  updatedAt: number;
  error: string | null;
  eventCount: number;
  lastEvent: string | null;
  lastTranscript: string | null;
};

type VoiceSessionEventRow = {
  event: string;
  ts: number;
  data: Record<string, unknown>;
};

type PerfEntry = {
  method: string;
  path: string;
  status?: number;
  ms: number;
  at: number; // request completion timestamp (epoch ms)
};

type ScoutbotSessionState = {
  session: {
    id: string;
    title?: string;
    model?: string;
    createdAt?: number;
    updatedAt?: number;
    messages: { id: string; role: string; body: string; createdAt: number }[];
  };
  config?: { model?: string; reasoningEffort?: string; provider?: string };
};

const fmtMs = (ms: number) => `${Math.round(ms).toLocaleString("en-US")} ms`;
const fmtSec = (s: number) => `${s.toFixed(3)}s`;
const fmtClock = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
const fmtRel = (ts: number, origin: number) =>
  `${ts >= origin ? "+" : "−"}${(Math.abs(ts - origin) / 1000).toFixed(3)}s`;

async function fetchSessionEvents(
  sessionId: string,
  signal: AbortSignal,
): Promise<VoiceSessionEventRow[]> {
  const rows: VoiceSessionEventRow[] = [];
  const response = await fetch(
    `/api/voice/session/${encodeURIComponent(sessionId)}/events`,
    { headers: { accept: "text/event-stream" }, signal },
  );
  if (!response.ok || !response.body) return rows;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // The endpoint replays persisted events then holds the stream open for
  // live ones — take the replay, then let the caller's timeout cut it.
  const deadline = Date.now() + 1600;
  const flush = () => {
    buffer = buffer.replace(/\r\n/g, "\n");
    let index = buffer.indexOf("\n\n");
    while (index >= 0) {
      const raw = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      let event = "message";
      const dataLines: string[] = [];
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
      }
      if (dataLines.length === 0) continue;
      try {
        const payload = JSON.parse(dataLines.join("\n")) as Record<string, unknown>;
        const { ts, sessionId: _sid, ...data } = payload;
        rows.push({ event, ts: typeof ts === "number" ? ts : 0, data });
      } catch {
        /* partial frame */
      }
      index = buffer.indexOf("\n\n");
    }
  };
  try {
    while (Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value?: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true }), Math.max(0, deadline - Date.now()))),
      ]);
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      flush();
    }
    flush();
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  return rows;
}

// Ambient pollers — dropped so the requests table only carries the calls
// that did work for this turn.
const AMBIENT_PATHS = new Set([
  "/api/pairing/requests",
  "/api/operator-signals",
  "/api/comms",
  "/api/health",
  "/api/mesh",
  "/api/notifications",
  "/api/agents",
  "/api/machines",
  "/api/user",
  "/api/tail/discover",
  "/api/perf/recent",
  "/api/voice/history",
  "/api/scoutbot/session",
]);

function matchPerfEntries(
  recent: PerfEntry[],
  origin: number,
  turnEndMs: number,
): PerfEntry[] {
  return recent
    .filter((entry) => {
      if (AMBIENT_PATHS.has(entry.path) || entry.path.startsWith("/api/voice/host")) {
        return false;
      }
      if (entry.method === "GET" && entry.path.endsWith("/events")) return false;
      const start = entry.at - entry.ms;
      return start >= origin - 8000 && start <= turnEndMs + 60000;
    })
    .sort((a, b) => a.at - a.ms - (b.at - b.ms));
}

function matchVoiceSessions(
  history: VoiceSessionSummary[],
  turn: VoiceTurn,
): { dictation: VoiceSessionSummary[]; speech: VoiceSessionSummary[] } {
  const total = turnTotal(turn);
  const dictation: VoiceSessionSummary[] = [];
  const speech: VoiceSessionSummary[] = [];
  for (const session of history) {
    if (session.surface === "direct-voice" || session.sessionId.startsWith("scout-voice:")) {
      // The take opens the turn: dictation starts at or just before origin.
      if (session.createdAt >= turn.origin - 4000 && session.createdAt <= turn.origin + (total + 15) * 1000) {
        dictation.push(session);
      }
    } else if (session.surface === "speech" || session.sessionId.startsWith("scout-speech:")) {
      // Speech lands after the reply: anywhere inside the turn window.
      if (session.createdAt >= turn.origin - 1000 && session.createdAt <= turn.origin + (total + 30) * 1000) {
        speech.push(session);
      }
    }
  }
  dictation.sort((a, b) => a.createdAt - b.createdAt);
  speech.sort((a, b) => a.createdAt - b.createdAt);
  return { dictation, speech };
}

function eventDetail(row: VoiceSessionEventRow): string {
  const parts: string[] = [];
  const text = row.data.text;
  if (typeof text === "string" && text) parts.push(`“${text.slice(0, 80)}”`);
  const durationMs = row.data.durationMs;
  if (typeof durationMs === "number") parts.push(`duration ${fmtMs(durationMs)}`);
  const reason = row.data.reason;
  if (typeof reason === "string") parts.push(`reason ${reason}`);
  const state = row.data.state;
  if (typeof state === "string") parts.push(state);
  const message = row.data.message;
  if (typeof message === "string" && message) parts.push(message);
  const audioBytes = row.data.audioBytes;
  if (typeof audioBytes === "number" && audioBytes > 0) parts.push(`${audioBytes.toLocaleString("en-US")} B audio`);
  if (row.data.playedOnHost === true) parts.push("played on host");
  const metrics = row.data.metrics;
  if (metrics && typeof metrics === "object") {
    const provider = (metrics as Record<string, unknown>).provider;
    if (typeof provider === "string") parts.push(provider);
  }
  return parts.join(" · ");
}

function SessionBlock({
  summary,
  turn,
}: {
  summary: VoiceSessionSummary;
  turn: VoiceTurn;
}) {
  const [rows, setRows] = useState<VoiceSessionEventRow[] | null>(null);
  const [gone, setGone] = useState(false);
  const requestRef = useRef<AbortController | null>(null);
  useEffect(() => () => requestRef.current?.abort(), []);
  const load = () => {
    if (rows !== null || gone) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    fetchSessionEvents(summary.sessionId, controller.signal)
      .then((events) => { if (!controller.signal.aborted) setRows(events); })
      .catch(() => { if (!controller.signal.aborted) setGone(true); });
  };
  return (
    <div className="vtd-session">
      <button type="button" className="vtd-session-head" onClick={load}>
        <code title={summary.sessionId}>{summary.sessionId}</code>
        <span className="vtd-dim">
          {summary.status} · {summary.eventCount} events · last {summary.lastEvent ?? "—"}
        </span>
        {summary.lastTranscript && <span className="vtd-dim">“{summary.lastTranscript}”</span>}
        {rows === null && !gone && <span className="vtd-open">events</span>}
        {gone && <span className="vtd-dim">record expired</span>}
      </button>
      {rows && (
        <ol className="vtd-events">
          {rows.map((row, index) => (
            <li key={`${row.ts}-${index}`}>
              <code>{row.event}</code>
              <span className="vtd-dim">{row.ts ? fmtRel(row.ts, turn.origin) : ""}</span>
              {eventDetail(row) && <span>{eventDetail(row)}</span>}
            </li>
          ))}
          {rows.length === 0 && <li className="vtd-dim">no events retained</li>}
        </ol>
      )}
    </div>
  );
}

export function VoiceTurnDetails({
  turn,
  now,
  startOpen,
}: {
  turn: VoiceTurn;
  now?: number;
  startOpen?: boolean;
}) {
  const [open, setOpen] = useState(Boolean(startOpen));
  const [everOpened, setEverOpened] = useState(Boolean(startOpen));
  const [history, setHistory] = useState<VoiceSessionSummary[] | null>(null);
  const [historyError, setHistoryError] = useState(false);
  const [scout, setScout] = useState<ScoutbotSessionState | null>(null);
  const [scoutError, setScoutError] = useState(false);
  const [perf, setPerf] = useState<PerfEntry[] | null>(null);
  const [perfError, setPerfError] = useState(false);

  useEffect(() => {
    if (!everOpened) return;
    let cancelled = false;
    void api<{ sessions: VoiceSessionSummary[] }>("/api/voice/history?limit=14")
      .then((data) => { if (!cancelled) setHistory(data.sessions ?? []); })
      .catch(() => { if (!cancelled) setHistoryError(true); });
    void api<ScoutbotSessionState>("/api/scoutbot/session")
      .then((data) => { if (!cancelled) setScout(data); })
      .catch(() => { if (!cancelled) setScoutError(true); });
    void api<{ recent: PerfEntry[] }>("/api/perf/recent?limit=500")
      .then((data) => { if (!cancelled) setPerf(data.recent ?? []); })
      .catch(() => { if (!cancelled) setPerfError(true); });
    return () => { cancelled = true; };
  }, [everOpened, turn.id]);

  const total = turnTotal(turn, now);
  const origin = turn.origin;
  const matched = history ? matchVoiceSessions(history, turn) : null;
  const turnEndMs = origin + total * 1000;
  const promptPair = (() => {
    if (!scout) return null;
    const msgs = scout.session.messages;
    const user = msgs.find(
      (m) => m.role === "user" && m.createdAt >= origin - 2000 && m.createdAt <= turnEndMs + 15000,
    );
    if (!user) return null;
    const assistant = msgs.find((m) => m.role === "assistant" && m.createdAt >= user.createdAt);
    return { user, assistant: assistant ?? null };
  })();
  const scoutInWindow = Boolean(
    scout?.session.updatedAt
      && scout.session.updatedAt >= origin - 10000
      && (scout.session.createdAt ?? 0) <= turnEndMs + 60000,
  );
  const perfRows = perf ? matchPerfEntries(perf, origin, turnEndMs) : null;

  // One stopwatch, lapped at every transition. The ledger's own span
  // boundaries are the laps — stamped by the client the moment each stage
  // turned over; server records only fill the slots where no lap was ever
  // hit (a span that never opened, or never closed).
  const milestones = (() => {
    const rows: { label: string; ts: number }[] = [];
    const lap = (seconds: number | null | undefined) =>
      seconds === null || seconds === undefined ? null : origin + seconds * 1000;
    const lapStart = (lanes: string[]) => {
      const span = turn.spans.find((s) => lanes.includes(s.lane));
      return lap(span?.start);
    };
    const lapEnd = (lanes: string[]) => {
      const ends = turn.spans
        .filter((s) => lanes.includes(s.lane) && s.end !== null)
        .map((s) => s.end!);
      return ends.length > 0 ? lap(Math.max(...ends)) : null;
    };
    const push = (label: string, ts: number | null | undefined) => {
      if (typeof ts === "number") rows.push({ label, ts });
    };

    const dictation = matched?.dictation[0];
    push("transcript", lapEnd(["host"])
      ?? (dictation && (dictation.lastEvent === "session.final" || dictation.status === "done")
        ? dictation.updatedAt
        : null));
    const chat = perfRows?.find((r) => r.path === "/api/scoutbot/chat");
    push("llm call", lapStart(["scoutbot"]) ?? (chat ? chat.at - chat.ms : null));
    push("reply", lapEnd(["scoutbot"])
      ?? chat?.at
      ?? promptPair?.assistant?.createdAt);
    const speaks = perfRows?.filter((r) => r.path === "/api/voice/speak") ?? [];
    const speech = matched?.speech ?? [];
    push("tts call", lapStart(["voice", "live"])
      ?? (speaks[0] ? speaks[0].at - speaks[0].ms : speech[0]?.createdAt));
    push("tts done", lapEnd(["voice", "live"])
      ?? speaks[speaks.length - 1]?.at
      ?? (speech[speech.length - 1]?.lastEvent === "speech.result"
        ? speech[speech.length - 1]!.updatedAt
        : null));
    const cancelled = dictation?.lastEvent === "session.cancelled" ? dictation.updatedAt
      : speech[speech.length - 1]?.lastEvent === "session.cancelled"
        ? speech[speech.length - 1]!.updatedAt
        : null;
    push("cancelled", cancelled);

    return rows.sort((a, b) => a.ts - b.ts);
  })();

  return (
    <details
      className="vtd"
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        setOpen(next);
        if (next) setEverOpened(true);
      }}
    >
      <summary className="vtd-summary">
        technical details
        <span className="vtd-dim"> · {turn.id} · {fmtMs(total * 1000)}</span>
      </summary>

      <dl className="vtd-facts">
        <div><dt>turn</dt><dd><code>{turn.id}</code></dd></div>
        <div><dt>origin</dt><dd>{fmtClock(origin)}</dd></div>
        <div><dt>total</dt><dd>{fmtMs(total * 1000)}</dd></div>
        <div><dt>quote</dt><dd>{turn.quote ? `“${turn.quote}”` : "—"}</dd></div>
      </dl>

      <table className="vtd-table">
        <thead>
          <tr><th>lane</th><th>tone</th><th>label</th><th>start</th><th>end</th><th>duration</th></tr>
        </thead>
        <tbody>
          {turn.spans.map((span) => {
            const open = span.end === null;
            const end = span.end ?? now ?? null;
            return (
              <tr key={span.id} className={open ? "is-open" : undefined}>
                <td>{span.lane}</td>
                <td>{span.tone}</td>
                <td>{span.label ?? "—"}</td>
                <td>{fmtSec(span.start)}</td>
                <td>{span.end !== null ? fmtSec(span.end) : open ? "open" : "—"}</td>
                <td>
                  {end !== null
                    ? fmtMs(Math.max(0, end - span.start) * 1000)
                    : "—"}
                  {open && now !== undefined ? " (running)" : ""}
                </td>
              </tr>
            );
          })}
          {turn.ticks.map((tick) => (
            <tr key={tick.id} className="vtd-tick">
              <td>scout</td>
              <td>tick</td>
              <td>{tick.label}</td>
              <td>{fmtSec(tick.at)}</td>
              <td colSpan={2}>—</td>
            </tr>
          ))}
        </tbody>
      </table>

      {milestones.length > 0 && (
        <div className="vtd-block">
          <p className="vtd-kicker">key moments</p>
          <ol className="vtd-events">
            {milestones.map((moment, index) => (
              <li key={moment.label}>
                <code>{moment.label}</code>
                <span className="vtd-dim">{fmtRel(moment.ts, origin)}</span>
                <span>
                  {index > 0 ? `+${fmtMs(moment.ts - milestones[index - 1]!.ts)}` : "—"}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {everOpened && (
        <>
          <div className="vtd-block">
            <p className="vtd-kicker">scoutbot session</p>
            {scoutError && <p className="vtd-dim">session fetch failed</p>}
            {!scout && !scoutError && <p className="vtd-dim">loading…</p>}
            {scout && !scoutInWindow && (
              <p className="vtd-dim">
                current scoutbot session <code>{scout.session.id}</code> is outside this turn's window — its messages may belong to a later turn
              </p>
            )}
            {scout && scoutInWindow && (
              <>
                <p className="vtd-line">
                  <code>{scout.session.id}</code>
                  <span className="vtd-dim"> · {scout.session.model ?? scout.config?.model ?? "model unknown"}</span>
                  {scout.config?.reasoningEffort && (
                    <span className="vtd-dim"> · effort {scout.config.reasoningEffort}</span>
                  )}
                </p>
                {promptPair ? (
                  <div className="vtd-pair">
                    <p><b>prompt</b> “{promptPair.user.body}”</p>
                    <p><b>reply</b> {promptPair.assistant ? `“${promptPair.assistant.body}”` : "—"}</p>
                  </div>
                ) : (
                  <p className="vtd-dim">no message pair inside this turn's window</p>
                )}
              </>
            )}
          </div>

          <div className="vtd-block">
            <p className="vtd-kicker">server requests</p>
            {perfError && <p className="vtd-dim">request log fetch failed</p>}
            {!perfRows && !perfError && <p className="vtd-dim">loading…</p>}
            {perfRows && perfRows.length === 0 && (
              <p className="vtd-dim">
                no request records inside this turn's window — the perf ring holds the last 500 calls and rolls under host polling
              </p>
            )}
            {perfRows && perfRows.length > 0 && (
              <table className="vtd-table">
                <thead>
                  <tr><th>request</th><th>started</th><th>took</th></tr>
                </thead>
                <tbody>
                  {perfRows.map((entry, index) => (
                    <tr key={`${entry.at}-${index}`}>
                      <td>
                        <code>{entry.method} {entry.path}</code>
                        {entry.status !== undefined && entry.status !== 200 && (
                          <span className="vtd-dim"> · {entry.status}</span>
                        )}
                      </td>
                      <td>{fmtRel(entry.at - entry.ms, origin)}</td>
                      <td>{fmtMs(entry.ms)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="vtd-block">
            <p className="vtd-kicker">host voice sessions</p>
            {historyError && <p className="vtd-dim">history fetch failed</p>}
            {!matched && !historyError && <p className="vtd-dim">loading…</p>}
            {matched && matched.dictation.length === 0 && matched.speech.length === 0 && (
              <p className="vtd-dim">no host sessions inside this turn's window — they may have expired</p>
            )}
            {matched?.dictation.map((summary) => (
              <SessionBlock key={summary.sessionId} summary={summary} turn={turn} />
            ))}
            {matched?.speech.map((summary) => (
              <SessionBlock key={summary.sessionId} summary={summary} turn={turn} />
            ))}
          </div>
        </>
      )}
    </details>
  );
}
