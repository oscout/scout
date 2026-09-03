import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { AgentAvatar } from "../../components/AgentAvatar.tsx";
import { api } from "../../lib/api.ts";
import {
  contextBudgetBarWidth,
  deriveContextBudgetGauge,
} from "../../lib/context-budget.ts";
import { ensureAgentChat } from "../../lib/agent-chat.ts";
import {
  resolveActiveSessionId,
  resolveRoutedSessionId,
  resolveSelectedSessionId,
  sortSessionsByRecency,
} from "../../lib/session-catalog.ts";
import { useBrokerEvents } from "../../lib/sse.ts";
import { timeAgo } from "../../lib/time.ts";
import { BackToPicker } from "../../scout/slots/BackToPicker.tsx";
import { openContent } from "../../scout/slots/openContent.ts";
import { useScout } from "../../scout/Provider.tsx";
import { ConversationScreen } from "../chat/ConversationScreen.tsx";
import { SessionObserve } from "../sessions/SessionObserve.tsx";
import { HarnessMark } from "../../components/HarnessMark.tsx";
import "./agents-project.css";
import type {
  Agent,
  AgentObservePayload,
  AgentTab,
  LocalAgentContextState,
  Route,
  SessionCatalogEntry,
  SessionCatalogWithResume,
} from "../../lib/types.ts";
import { AgentDefinitionsWorkspace } from "./AgentDefinitionsWorkspace.tsx";
import { AgentEssentialsGlyph } from "./agent-essentials.tsx";
import {
  agentLabel,
  newSessionPayloadForAgent,
  pathLeaf,
  shortSessionId,
  type SessionInitiationResult,
} from "./model.ts";

function formatContextAge(ms: number | null): string {
  if (ms === null) return "age unknown";
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes}m old`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder > 0 ? `${hours}h ${remainder}m old` : `${hours}h old`;
}

function contextTurnLabel(context: LocalAgentContextState): string {
  return `${context.turnCount} turn${context.turnCount === 1 ? "" : "s"}`;
}

function shortCwd(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  return cwd.startsWith("/Users/")
    ? "~/" + cwd.split("/").slice(3).join("/")
    : cwd;
}

function shortSessionLabel(id: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(id)) {
    return id;
  }
  // Human session ids (e.g. "relay-hu") read fine; long hashes get elided.
  return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

function compactSurfaceSessionLabel(id: string): string {
  return id
    .replace(/^relay-/u, "")
    .replace(/-arts-mac-mini-local-(claude|codex)$/u, "");
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return `${n}`;
}

function fmtCompactNumber(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  if (Math.abs(value) < 1_000) return `${Math.round(value)}`;
  if (Math.abs(value) < 1_000_000) {
    return `${(value / 1_000).toFixed(value % 1_000 === 0 ? 0 : 1)}k`;
  }
  return `${(value / 1_000_000).toFixed(1)}m`;
}

function fmtWindowSpan(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const whole = Math.round(seconds);
  const hours = Math.floor(whole / 3_600);
  const minutes = Math.floor((whole % 3_600) / 60);
  const secs = whole % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes >= 10 || secs === 0) return `${minutes}m`;
  return `${minutes}m ${secs}s`;
}

// Bin trace events into intensity buckets across the session window, so the
// sparkline reads the session's rhythm (warm-up · bursts · idle).
function binEvents(events: { t: number }[], n = 32): number[] {
  if (events.length === 0) return [];
  const last = events[events.length - 1]!.t || 1;
  const buckets = new Array<number>(n).fill(0);
  for (const e of events) {
    const idx = Math.min(n - 1, Math.max(0, Math.floor((e.t / last) * n)));
    buckets[idx] += 1;
  }
  return buckets;
}

function isWorkTraceEvent(event: { kind: string }): boolean {
  return event.kind !== "boot" && event.kind !== "system";
}

// A little chart of the session's rhythm — intensity bars, brighter where busier
// (single accent, opacity = intensity). Matches the studio rebalance treatment.
function ActivitySparkline({
  buckets,
  emptyTitle,
  emptyDetail,
}: {
  buckets: number[];
  emptyTitle: string;
  emptyDetail: string;
}) {
  if (buckets.length === 0) {
    return (
      <div className="s-sum-observed-empty">
        <span>{emptyTitle}</span>
        <strong>{emptyDetail}</strong>
      </div>
    );
  }
  const max = Math.max(...buckets, 1);
  const W = 240;
  const H = 20;
  const gap = 1;
  const bw = (W - gap * (buckets.length - 1)) / buckets.length;
  return (
    <div className="s-sum-spark">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="s-sum-spark-svg" aria-hidden>
        {buckets.map((v, i) => {
          const h = Math.max(1, (v / max) * H);
          return (
            <rect
              key={i}
              x={i * (bw + gap)}
              y={H - h}
              width={bw}
              height={h}
              fill="var(--accent)"
              opacity={0.22 + 0.62 * (v / max)}
            />
          );
        })}
      </svg>
      <div className="s-sum-spark-axis">
        <span>session start</span>
        <span>now</span>
      </div>
    </div>
  );
}

// The center summary band for the focused session: the rhythm chart + key stats +
// quantifiable context, then the primary action. Kept shallow on purpose — the
// file detail and the rest live in the rail. Mirrors the studio SessionSummary.

function SessionSummary({
  agentId,
  session,
  active,
  onPrimary,
  primaryLabel,
  primaryTitle,
}: {
  agentId: string;
  session: SessionCatalogEntry;
  active: boolean;
  onPrimary: () => void;
  primaryLabel: string;
  primaryTitle: string;
}) {
  const [observe, setObserve] = useState<AgentObservePayload | null>(null);
  const [ctx, setCtx] = useState<LocalAgentContextState | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ sessionId: session.id });
    const [o, c] = await Promise.all([
      api<AgentObservePayload>(`/api/agents/${encodeURIComponent(agentId)}/observe?${params}`).catch(() => null),
      api<LocalAgentContextState>(`/api/agents/${encodeURIComponent(agentId)}/session/context`).catch(() => null),
    ]);
    setObserve(o);
    setCtx(c);
  }, [agentId, session.id]);
  useEffect(() => {
    void load();
  }, [load]);
  useBrokerEvents(() => {
    void load();
  });

  const data = observe?.data;
  const events = data?.events ?? [];
  const workEvents = events.filter(isWorkTraceEvent);
  const toolEvents = workEvents.filter((e) => e.kind === "tool");
  const editEvents = toolEvents.filter((e) => e.tool === "edit" || e.tool === "write");
  const readEvents = toolEvents.filter((e) => e.tool === "read");
  const fileCount = data?.files.length ?? 0;
  const observedTurnCount = data?.metadata?.session?.turnCount;
  const ledgerTurnCount = ctx?.activeSessionId === session.id ? ctx.turnCount : undefined;
  const hasObservedWork = workEvents.length > 0 || fileCount > 0;
  const traceState =
    !observe
      ? "loading"
      : observe.source === "unavailable"
        ? "unavailable"
        : hasObservedWork
          ? "observed"
          : "waiting";
  const traceEmptyTitle =
    traceState === "loading"
      ? "Loading trace"
      : traceState === "unavailable"
        ? "No trace source"
        : "Session created";
  const traceEmptyDetail =
    traceState === "loading"
      ? "checking for terminal or transcript activity"
      : traceState === "unavailable"
        ? "this session has no observable transcript attached"
        : "no agent work has been recorded yet";
  const stats: Array<{ k: string; v: string }> = [
    { k: "turns", v: fmtCompactNumber(observedTurnCount ?? ledgerTurnCount) },
    { k: "tools", v: fmtCompactNumber(toolEvents.length) },
    { k: "edits", v: fmtCompactNumber(editEvents.length) },
    { k: "reads", v: fmtCompactNumber(readEvents.length) },
    { k: "files", v: fmtCompactNumber(fileCount) },
    { k: "window", v: fmtWindowSpan(workEvents.length > 0 ? workEvents[workEvents.length - 1]!.t : 0) },
  ];

  // Context, quantifiable only when the harness reports a real token window.
  // Turn policy is useful session bookkeeping, but it is not context usage.
  const usage = data?.metadata?.usage;
  const contextGauge = deriveContextBudgetGauge(usage, {
    model: data?.metadata?.session?.model ?? session.model,
    adapterType: session.harness,
  });
  const ctxHead = contextGauge
    ? `${contextGauge.usedLabel} / ${contextGauge.budgetLabel} ctx`
    : ctx
      ? contextTurnLabel(ctx)
      : "context";
  const ctxPctLabel = contextGauge
    ? `${contextGauge.pct}%${contextGauge.overLimit ? " over" : ""}`
    : "tokens unavailable";
  // When the gauge already shows tokens, the runway adds turns + age. When the
  // head already shows turns, the runway is just age, so don't print the turns twice.
  const ctxAge = ctx && ctx.sessionAgeMs !== null ? formatContextAge(ctx.sessionAgeMs) : null;
  const ctxRunway =
    contextGauge && ctx
      ? `${contextTurnLabel(ctx)}${ctxAge ? ` · ${ctxAge}` : ""}`
      : ctxAge;
  const observedSessionId =
    observe?.sessionId?.trim()
    || observe?.data.metadata?.session?.externalSessionId?.trim()
    || observe?.data.metadata?.session?.threadId?.trim()
    || null;
  const nativeSessionId =
    session.harnessSessionId?.trim()
    || session.threadId?.trim()
    || session.externalSessionId?.trim()
    || (active ? observedSessionId : null)
    || null;
  const runtimeSessionId =
    session.runtimeSessionId?.trim()
    || session.surfaceSessionId?.trim()
    || (nativeSessionId && nativeSessionId !== session.id ? session.id : null);
  const displaySessionId = nativeSessionId ?? session.id;
  const displaySessionLabel = nativeSessionId && session.harness === "codex"
    ? "codex session id"
    : nativeSessionId && session.harness
      ? `${session.harness} session id`
      : session.id.startsWith("relay-")
        ? "runtime id"
        : "session id";
  const workspaceLabel = session.cwd ? pathLeaf(session.cwd) : "workspace";

  return (
    <div className="s-sum">
      <div className="s-sum-session-state">
        <span className={`s-sum-session-dot${active ? " s-sum-session-dot--active" : ""}`} />
        <span className="s-sum-session-copy">
          <strong>{active ? "Session attached" : "Previous session"}</strong>
          <span className="s-sum-session-ref" title={displaySessionId}>
            <span>{displaySessionLabel}</span>
            <code>{displaySessionId}</code>
          </span>
          {runtimeSessionId && runtimeSessionId !== displaySessionId && (
            <span className="s-sum-session-profile" title={runtimeSessionId}>
              runtime {runtimeSessionId}
            </span>
          )}
          <small title={session.cwd || undefined}>{workspaceLabel}</small>
        </span>
        {traceState !== "observed" ? (
          <span className={`s-sum-trace-pill s-sum-trace-pill--${traceState}`}>
            {traceState === "waiting"
              ? "waiting for work"
              : traceState === "loading"
                ? "checking trace"
                : "no trace"}
          </span>
        ) : null}
      </div>
      <div className="s-sum-cols">
        <div className="s-sum-col s-sum-col--activity">
          <div className="s-sum-label">Observed work</div>
          <ActivitySparkline
            buckets={binEvents(workEvents)}
            emptyTitle={traceEmptyTitle}
            emptyDetail={traceEmptyDetail}
          />
        </div>
        <div className="s-sum-col s-sum-col--context">
          <div className="s-sum-label">Context</div>
          <div className="s-sum-ctx-head">
            <span className="s-sum-ctx-size">{ctxHead}</span>
            <span className="s-sum-ctx-pct">{ctxPctLabel}</span>
          </div>
          {contextGauge ? (
            <div className="s-sum-gauge" aria-label={`Context ${contextGauge.pct}%`}>
              <div
                className="s-sum-gauge-fill"
                style={{ width: `${contextBudgetBarWidth(contextGauge)}%` }}
              />
            </div>
          ) : (
            <div className="s-sum-ctx-unavailable">No token-window usage yet</div>
          )}
          {ctxRunway && <div className="s-sum-ctx-runway">{ctxRunway}</div>}
        </div>
      </div>
      <div className="s-sum-foot">
        {hasObservedWork ? (
          <div className="s-sum-stats">
            {stats.map((m, i) => (
              <span key={m.k} className="s-sum-stat">
                {i > 0 && <span className="s-sum-stat-sep">·</span>}
                <span className="s-sum-stat-v">{m.v}</span>
                <span className="s-sum-stat-k">{m.k}</span>
              </span>
            ))}
          </div>
        ) : (
          <div className="s-sum-status-note">
            {active
              ? "The session exists, but no turn/tool/file activity has reached Scout yet."
              : "This prior session has no observable work trace."}
          </div>
        )}
        <button type="button" className="s-sess-explore-primary" onClick={onPrimary} title={primaryTitle}>
          {primaryLabel}
        </button>
      </div>
    </div>
  );
}

// Sessions-first center (Hybrid): a compact essentials header (state · cwd ·
// branch · harness · model · host), then the agent's sessions by recency (active
// first). Clicking a session selects it (shared with the rail) and expands a
// light "exploring" strip with the one most-likely action — Continue (message
// into the conversation) or Resume — inline, right where the eye is. The
// secondary ways to engage (Observe / Take over / Trace) live in the rail, which
// follows the same selection. Selecting never jumps straight into a terminal.
export function AgentProfileSessionsCenter({
  agent,
  name,
  sessionCatalog,
  conversationId,
  navigate,
  route,
  homeView = "agents-v2",
}: {
  agent: Agent;
  name: string;
  sessionCatalog: SessionCatalogWithResume | null;
  conversationId: string | null;
  navigate: (r: Route) => void;
  route: Route;
  /** Registry surface that owns this profile — drives Message / New session navigation. */
  homeView?: Extract<Route, { view: "agents-v2" }>["view"];
}) {
  const { focusedSession, focusSession } = useScout();
  const activeSessionId = resolveActiveSessionId(agent, sessionCatalog);

  const sessions = useMemo(
    () => sortSessionsByRecency(sessionCatalog?.sessions ?? [], activeSessionId),
    [sessionCatalog?.sessions, activeSessionId],
  );
  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? null;
  const liveSessionModel = activeSession?.model ?? null;
  const liveSessionEffort = activeSession?.reasoningEffort ?? agent.reasoningEffort ?? null;
  const hasDistinctSessionModel = Boolean(liveSessionModel && liveSessionModel !== agent.model);
  const chipTitle = [
    hasDistinctSessionModel && liveSessionModel ? `Session model: ${liveSessionModel}` : null,
    liveSessionEffort ? `Effort: ${liveSessionEffort}` : null,
  ].filter(Boolean).join(" · ") || null;
  const [startState, setStartState] = useState<"idle" | "starting">("idle");
  const [startError, setStartError] = useState<string | null>(null);
  const [chatState, setChatState] = useState<"idle" | "opening">("idle");
  const [chatError, setChatError] = useState<string | null>(null);

  useEffect(() => {
    setStartState("idle");
    setStartError(null);
    setChatState("idle");
    setChatError(null);
  }, [agent.id]);

  // Selection is shared with the rail (Provider): it defaults to the active (or
  // most recent) session, and clicking a row only re-points it — never jumps.
  const routedSessionId =
    route.view === "agents-v2" && route.agentId === agent.id
      ? route.sessionId
      : null;
  const selectedSessionId = resolveSelectedSessionId(
    agent.id,
    focusedSession,
    activeSessionId,
    sessions,
    routedSessionId,
  );
  const normalizedRoutedSessionId = resolveRoutedSessionId(routedSessionId, sessions);

  useEffect(() => {
    if (!normalizedRoutedSessionId) return;
    if (
      focusedSession?.agentId === agent.id &&
      focusedSession.sessionId === normalizedRoutedSessionId
    ) {
      return;
    }
    focusSession(agent.id, normalizedRoutedSessionId);
  }, [
    agent.id,
    focusedSession?.agentId,
    focusedSession?.sessionId,
    focusSession,
    normalizedRoutedSessionId,
  ]);

  const openMessage = async () => {
    if (chatState === "opening") return;
    setChatState("opening");
    setChatError(null);
    try {
      const chatId = await ensureAgentChat({ ...agent, conversationId });
      navigate({
        view: homeView,
        agentId: agent.id,
        conversationId: chatId,
        tab: "message",
      });
    } catch (caught) {
      setChatError(caught instanceof Error ? caught.message : "Could not open chat.");
    } finally {
      setChatState("idle");
    }
  };
  const startNewSession = async () => {
    if (startState === "starting") return;
    setStartState("starting");
    setStartError(null);
    try {
      const result = await api<SessionInitiationResult>("/api/sessions", {
        method: "POST",
        body: JSON.stringify(newSessionPayloadForAgent(agent)),
      });
      const sessionId = result.sessionId?.trim();
      if (sessionId) {
        openContent(navigate, { view: "sessions", sessionId }, { returnTo: route });
        return;
      }
      const conversationId = result.conversationId?.trim();
      if (!conversationId) {
        throw new Error("Session started, but no conversation was returned.");
      }
      navigate({
        view: homeView,
        agentId: result.agentId?.trim() || agent.id,
        conversationId,
        tab: "message",
      });
    } catch (error) {
      setStartError(error instanceof Error ? error.message : "Could not start a new session.");
    } finally {
      setStartState("idle");
    }
  };
  const resumeSession = (s: SessionCatalogEntry) =>
    openContent(navigate, { view: "sessions", sessionId: s.id }, { returnTo: route });
  const selectSession = (sessionId: string) => {
    // Routed sessionId is the selection source of truth (SCO-082 Phase B).
    focusSession(agent.id, sessionId);
  };

  return (
    <div className="s-sess-root">
      <header className="s-sess-head">
        <div className="s-sess-id">
          <span className="s-sess-avatar">
            <AgentAvatar agent={agent} size={46} tile presence={false} />
          </span>
          <div className="s-sess-id-copy">
            <div className="s-sess-name-row">
              <span className="s-sess-name">{name}</span>
              {agent.handle && (
                <span className="s-sess-handle">@{agent.handle.replace(/^@+/, "")}</span>
              )}
            </div>
            <AgentEssentialsGlyph agent={agent} chipTitle={chipTitle} />
          </div>
        </div>
        {/* Header CTA mirrors the studio: "+ New session" (start fresh) — a
            distinct action from per-session Continue and the Message tab, so
            "Message" isn't duplicated across the tab, the header, and Continue. */}
        <div className="s-sess-head-actions">
          <button
            type="button"
            className="s-sess-action"
            onClick={() =>
              navigate({
                view: homeView,
                agentId: agent.id,
                tab: "config",
              })
            }
          >
            Edit config
          </button>
          <button
            type="button"
            className="s-sess-action s-sess-action--accent"
            disabled={startState === "starting"}
            onClick={startNewSession}
          >
            {startState === "starting" ? "Starting..." : "+ New session"}
          </button>
          {startError && <div className="s-sess-action-error">{startError}</div>}
          {chatError && <div className="s-sess-action-error">{chatError}</div>}
        </div>
      </header>

      <section className="s-sess-band">
        <header className="s-sess-band-head">
          <span className="s-sess-band-label">Recent sessions</span>
          {sessions.length > 0 && (
            <span className="s-sess-band-meta">{sessions.length} sessions</span>
          )}
        </header>
        <div className="s-sess-list">
          {sessions.length === 0 ? (
            <div className="s-sess-empty">No sessions yet — start a new session for {name}.</div>
          ) : (
            sessions.map((s) => {
              const active = s.id === activeSessionId;
              const selected = s.id === selectedSessionId;
              const rowHarness = s.harness ?? agent.harness ?? "session";
              const rowModelRaw = s.model ?? agent.model;
              const rowModel =
                rowModelRaw && rowHarness && rowModelRaw.startsWith(`${rowHarness}-`)
                  ? rowModelRaw.slice(rowHarness.length + 1)
                  : rowModelRaw;
              const engineLabel = [rowHarness, rowModel, s.reasoningEffort]
                .filter((value): value is string => Boolean(value))
                .join(" · ");
              const surfaceLabel = s.surfaceSessionId
                ? `${s.transport ?? agent.transport ?? "terminal"} surface ${compactSurfaceSessionLabel(s.surfaceSessionId)}`
                : s.transport && s.transport !== rowHarness
                  ? `${s.transport} surface`
                  : null;
              // No status words (active/ready/live) — the live session reads as
              // `now` in the accent; ended ones show how long ago, dim.
              const when = active
                ? "now"
                : s.endedAt
                  ? `ended · ${timeAgo(s.endedAt) || "recent"}`
                  : timeAgo(s.startedAt) || "recent";
              return (
                <div key={s.id} className={`s-sess-item${selected ? " s-sess-item--selected" : ""}`}>
                  <button
                    type="button"
                    className={`s-sess-row${active ? " s-sess-row--active" : ""}${selected ? " s-sess-row--selected" : ""}`}
                    onClick={() => selectSession(s.id)}
                    aria-expanded={selected}
                  >
                    <span
                      className="s-mod-dot s-sess-row-dot"
                      style={{
                        background: active ? "var(--accent)" : "var(--dim)",
                        opacity: active ? 1 : 0.55,
                      }}
                    />
                    <span className="s-sess-row-main">
                      <span className="s-sess-row-top">
                        <span className="s-sess-row-id" title={s.id}>{shortSessionLabel(s.id)}</span>
                        <span className="s-sess-row-tag">{engineLabel}</span>
                      </span>
                      <span className="s-sess-row-sub" title={surfaceLabel ?? undefined}>
                        {s.cwd ? pathLeaf(s.cwd) : "workspace"}
                        {surfaceLabel ? ` · ${surfaceLabel}` : ""}
                      </span>
                    </span>
                    <span
                      className={`s-sess-row-when${active ? " s-sess-row-when--active" : ""}`}
                    >
                      {when}
                    </span>
                  </button>
                  {selected && (
                    <SessionSummary
                      agentId={agent.id}
                      session={s}
                      active={active}
                      onPrimary={() => (active ? void openMessage() : resumeSession(s))}
                      primaryLabel={active ? "Continue" : "Resume"}
                      primaryTitle={
                        active
                          ? "Send a message into this conversation"
                          : "Reopen this conversation and message it"
                      }
                    />
                  )}
                </div>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
}

// ── session-card profile (graphite) ───────────────────────────────────────
// The studio session profile, ported: the agent's CURRENT session as the
// primary LG card (real /observe log), its other sessions as SM rows, and a
// secondary info rail. Same session material as the focus view; normal profile
// furniture around it. Lives under `.s-aproj`, reusing the focus-card classes.
const PROFILE_LIVE_WINDOW = 30 * 60_000;

function observeLogText(e: { kind: string; text?: string; tool?: string; arg?: string }): string {
  let s: string;
  if (e.kind === "tool") {
    const what = e.arg?.trim() || e.text?.trim() || "";
    s = `${e.tool ?? "tool"}${what ? ` ${what}` : ""}`.trim();
  } else {
    s = e.text?.trim() || e.kind;
  }
  return s.length > 160 ? `${s.slice(0, 157)}…` : s;
}

export function CurrentSessionCard({
  agent,
  session,
  active,
  onContinue,
  onTakeover,
  onOpen,
}: {
  agent: Agent;
  session: SessionCatalogEntry;
  active: boolean;
  onContinue: () => void;
  onTakeover: () => void;
  onOpen: () => void;
}) {
  const [observe, setObserve] = useState<AgentObservePayload | null>(null);
  const load = useCallback(async () => {
    const o = await api<AgentObservePayload>(
      `/api/agents/${encodeURIComponent(agent.id)}/observe`,
    ).catch(() => null);
    setObserve(o);
  }, [agent.id]);
  useEffect(() => {
    setObserve(null);
    void load();
  }, [load]);
  useBrokerEvents(() => {
    void load();
  });

  const events = observe?.data.events ?? [];
  const branch = agent.branch || (session.cwd ? pathLeaf(session.cwd) : "main");
  const model =
    agent.model && agent.harness && agent.model.startsWith(`${agent.harness}-`)
      ? agent.model.slice(agent.harness.length + 1)
      : agent.model ?? null;
  const harness = session.harness ?? agent.harness ?? "session";
  const title =
    (() => {
      for (const e of events) if ((e.kind === "message" || e.kind === "ask") && e.text?.trim()) return e.text.trim();
      return null;
    })() ??
    (session.cwd ? pathLeaf(session.cwd) : null) ??
    agent.name;
  const usage = observe?.data.metadata?.usage ?? null;
  const turns = usage?.assistantMessages ?? null;
  const contextGauge = deriveContextBudgetGauge(usage, {
    model: observe?.data.metadata?.session?.model ?? model,
    adapterType: harness,
  });
  const ctxPct = contextGauge ? Math.min(100, contextGauge.pct) : null;
  const tone: "live" | "idle" = active ? "live" : "idle";
  const eventCount = events.length;
  const logLines = events.slice(-6).map((e) => ({
    t: e.at ?? e.t ? timeAgo(e.at ?? e.t) : "",
    text: observeLogText(e),
    kind: e.kind,
  }));

  return (
    <section className="ap-focus ap-profileCard" data-tone={tone} aria-label={title}>
      <header className="ap-focusHead">
        <h1 className="ap-focusTitle">{title}</h1>
        <span className="ap-focusState" data-tone={tone}>
          {active ? (
            <>
              <span className="ap-dot" data-tone="live" aria-hidden /> working
            </>
          ) : (
            "idle"
          )}
        </span>
        <button type="button" className="ap-focusOpen" onClick={onOpen}>
          Open ↗
        </button>
      </header>

      <div className="ap-focusAttr">
        <span className="ap-focusAttrText">
          {branch}{model ? ` · ${model}` : ""}
        </span>
        <span className="ap-rowMark" aria-hidden>
          <HarnessMark harness={harness} size={11} />
        </span>
      </div>

      <div className="ap-decision">
        <button type="button" className="ap-decisionPrimary" onClick={onContinue}>
          {active ? "Continue" : "Resume"}
        </button>
        <button type="button" className="ap-decisionGhost" onClick={onTakeover}>
          Take over
        </button>
        <span className="ap-decisionMeta">
          {ctxPct != null ? (
            <span>
              <span className="ap-metaKey">ctx</span>
              {ctxPct}%
            </span>
          ) : null}
          {usage && (usage.inputTokens || usage.outputTokens) ? (
            <span>
              <span className="ap-metaKey">tokens</span>
              {fmtTokens(usage.inputTokens ?? 0)} in
            </span>
          ) : null}
          {turns != null ? (
            <span>
              <span className="ap-metaKey">turns</span>
              {turns}
            </span>
          ) : null}
        </span>
      </div>

      <div className="ap-logHead">
        <span className="ap-logHeadTitle">Session log</span>
        <span className="ap-logHeadMeta">
          {observe === null ? "loading…" : `${observe.source} · ${eventCount} events`}
        </span>
      </div>
      <div className="ap-log">
        {observe === null ? (
          <div className="ap-traceLoading">Resolving the most recent session…</div>
        ) : logLines.length === 0 ? (
          <div className="ap-traceLoading">No activity captured for this session yet.</div>
        ) : (
          logLines.map((l, i) => (
            <div key={i} className="ap-logLine" data-kind={l.kind}>
              <span className="ap-logT">{l.t}</span>
              <span className="ap-logText">{l.text}</span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function SessionProfileCenter({
  agent,
  name,
  sessionCatalog,
  conversationId,
  navigate,
  route,
}: {
  agent: Agent;
  name: string;
  sessionCatalog: SessionCatalogWithResume | null;
  conversationId: string | null;
  navigate: (r: Route) => void;
  route: Route;
}) {
  const { focusedSession, focusSession } = useScout();
  const activeSessionId = resolveActiveSessionId(agent, sessionCatalog);
  const sessions = useMemo(
    () => sortSessionsByRecency(sessionCatalog?.sessions ?? [], activeSessionId),
    [sessionCatalog?.sessions, activeSessionId],
  );
  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? sessions[0] ?? null;
  const routedSessionId =
    route.view === "agents-v2" && route.agentId === agent.id
      ? route.sessionId
      : null;
  const selectedSessionId = resolveSelectedSessionId(
    agent.id,
    focusedSession,
    activeSessionId,
    sessions,
    routedSessionId,
  );
  const normalizedRoutedSessionId = resolveRoutedSessionId(routedSessionId, sessions);

  useEffect(() => {
    if (!normalizedRoutedSessionId) return;
    if (
      focusedSession?.agentId === agent.id &&
      focusedSession.sessionId === normalizedRoutedSessionId
    ) {
      return;
    }
    focusSession(agent.id, normalizedRoutedSessionId);
  }, [
    agent.id,
    focusedSession?.agentId,
    focusedSession?.sessionId,
    focusSession,
    normalizedRoutedSessionId,
  ]);

  const modelShort =
    agent.model && agent.harness && agent.model.startsWith(`${agent.harness}-`)
      ? agent.model.slice(agent.harness.length + 1)
      : agent.model ?? null;
  const cwdShort = agent.cwd ? (shortCwd(agent.cwd) ?? agent.cwd) : null;
  const hostShort = agent.homeNodeName ? agent.homeNodeName.replace(/\.local$/i, "") : null;
  const handle = agent.handle?.trim().replace(/^@+/, "") || null;
  const profileTitle = handle ? `@${handle}` : name;
  const profileSubtitle =
    handle && name.toLowerCase() !== handle.toLowerCase()
      ? name
      : [agent.project ? `/${agent.project}` : null, agent.branch, modelShort].filter(Boolean).join(" · ");

  const agentRoute = (patch: Partial<Extract<Route, { view: "agents-v2" }>>): Route =>
    route.view === "agents-v2"
      ? { ...route, ...patch, view: "agents-v2" }
      : { view: "agents-v2", agentId: agent.id, ...patch };

  const openMessage = async () => {
    try {
      const chatId = await ensureAgentChat({ ...agent, conversationId });
      navigate(agentRoute({ agentId: agent.id, conversationId: chatId, tab: "message" }));
    } catch {
      /* surfaced elsewhere */
    }
  };
  const startNewSession = async () => {
    try {
      const result = await api<SessionInitiationResult>("/api/sessions", {
        method: "POST",
        body: JSON.stringify(newSessionPayloadForAgent(agent)),
      });
      const sessionId = result.sessionId?.trim();
      if (sessionId) {
        openContent(navigate, { view: "sessions", sessionId }, { returnTo: route });
        return;
      }
      const cid = result.conversationId?.trim();
      navigate(
        agentRoute({
          agentId: result.agentId?.trim() || agent.id,
          ...(cid ? { conversationId: cid } : {}),
          tab: "message",
        }),
      );
    } catch {
      /* noop */
    }
  };
  const resumeSession = (s: SessionCatalogEntry) =>
    openContent(navigate, { view: "sessions", sessionId: s.id }, { returnTo: route });
  const takeover = () =>
    openContent(navigate, { view: "terminal", agentId: agent.id, mode: "takeover" }, { returnTo: route });
  const selectSession = (sessionId: string) => {
    // Routed sessionId is the selection source of truth (SCO-082 Phase B).
    focusSession(agent.id, sessionId);
  };

  return (
    <div className="ap-profile">
      <header className="ap-profileHead">
        <AgentAvatar agent={agent} size={48} tile presence={false} />
        <div className="ap-profileIdent">
          <div className="ap-profileTop">
            {agent.harness ? (
              <span className="ap-rowMark" aria-hidden>
                <HarnessMark harness={agent.harness} size={13} />
              </span>
            ) : null}
            <h1 className="ap-profileName" title={profileTitle}>
              {profileTitle}
            </h1>
          </div>
          <span className="ap-profileSub" title={profileSubtitle}>
            {profileSubtitle || cwdShort || "—"}
          </span>
          {handle && name.toLowerCase() !== handle.toLowerCase() ? (
            <span className="ap-profileId" title={agent.id}>
              {name}
            </span>
          ) : null}
        </div>
        <div className="ap-headActions">
          <button
            type="button"
            className="ap-headGhost"
            onClick={() => navigate(agentRoute({ agentId: agent.id, tab: "config" }))}
          >
            Edit config
          </button>
          <button type="button" className="ap-headCta" onClick={() => void startNewSession()}>
            ＋ New session
          </button>
        </div>
      </header>

      <div className="ap-profileBody">
        <div className="ap-profileMain">
          <div className="ap-profileSection">Current session</div>
          {activeSession ? (
            <CurrentSessionCard
              agent={agent}
              session={activeSession}
              active={activeSession.id === activeSessionId}
              onContinue={() => void openMessage()}
              onTakeover={takeover}
              onOpen={() => void openMessage()}
            />
          ) : (
            <div className="ap-traceLoading">No active session for {name}.</div>
          )}

          <div className="ap-profileSection">
            Sessions <span className="ap-profileCount">{sessions.length}</span>
          </div>
          {sessions.length === 0 ? (
            <div className="ap-empty">No sessions yet — start a new session for {name}.</div>
          ) : (
            <div className="ap-sessTable">
              <div className="ap-sessTableHead" aria-hidden>
                <span />
                <span>Session</span>
                <span>Engine</span>
                <span>Last</span>
              </div>
              {sessions.map((s) => {
                const isActive = s.id === activeSessionId;
                const when = isActive
                  ? "now"
                  : s.endedAt
                    ? `ended · ${timeAgo(s.endedAt) || "recent"}`
                    : timeAgo(s.startedAt) || "recent";
                const label = s.cwd ? pathLeaf(s.cwd) : shortSessionLabel(s.id);
                const sHarness = s.harness ?? agent.harness ?? "session";
                const sModelRaw = s.model ?? agent.model;
                const sModel =
                  sModelRaw && sModelRaw.startsWith(`${sHarness}-`)
                    ? sModelRaw.slice(sHarness.length + 1)
                    : sModelRaw;
                const engine = [sHarness, sModel, s.reasoningEffort].filter(Boolean).join(" · ");
                return (
                  <button
                    key={s.id}
                    type="button"
                    className="ap-sessRow"
                    data-tone={isActive ? "live" : "idle"}
                    data-selected={s.id === selectedSessionId || undefined}
                    onClick={() => (isActive ? selectSession(s.id) : resumeSession(s))}
                  >
                    {isActive ? (
                      <span className="ap-dot" data-tone="live" aria-hidden />
                    ) : (
                      <span className="ap-sessRowDot" aria-hidden />
                    )}
                    <span className="ap-sessRowName" title={s.id}>{label}</span>
                    <span className="ap-sessRowEngine">{engine}</span>
                    <span className="ap-sessRowWhen">{when}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <aside className="ap-profileAside">
          <div className="ap-group">
            <div className="ap-groupHead">Place</div>
            {cwdShort ? (
              <div className="ap-kv"><span className="ap-kvKey">root</span><span className="ap-kvVal">{cwdShort}</span></div>
            ) : null}
            {hostShort ? (
              <div className="ap-kv"><span className="ap-kvKey">host</span><span className="ap-kvVal">{hostShort}</span></div>
            ) : null}
            {agent.branch ? (
              <div className="ap-kv"><span className="ap-kvKey">branch</span><span className="ap-kvVal">{agent.branch}</span></div>
            ) : null}
          </div>
          <div className="ap-group">
            <div className="ap-groupHead">Runtime</div>
            {agent.harness ? (
              <div className="ap-kv"><span className="ap-kvKey">harness</span><span className="ap-kvVal">{agent.harness}</span></div>
            ) : null}
            {modelShort ? (
              <div className="ap-kv"><span className="ap-kvKey">model</span><span className="ap-kvVal">{modelShort}</span></div>
            ) : null}
          </div>
        </aside>
      </div>
    </div>
  );
}

export function AgentDetailWithRail({
  agent,
  allAgents,
  conversationId,
  navigate,
  activeTab,
  renderProfile,
}: {
  agent: Agent;
  allAgents: Agent[];
  conversationId: string | null;
  navigate: (r: Route) => void;
  activeTab: AgentTab;
  renderProfile?: (ctx: {
    agent: Agent;
    sessionCatalog: SessionCatalogWithResume | null;
    conversationId: string | null;
    navigate: (r: Route) => void;
    route: Route;
  }) => ReactNode;
}) {
  const { name } = agentLabel(agent, allAgents);
  const [observe, setObserve] = useState<AgentObservePayload | null>(null);
  const [observeLoading, setObserveLoading] = useState(false);
  const [sessionCatalog, setSessionCatalog] = useState<SessionCatalogWithResume | null>(null);
  const { route } = useScout();
  const routedObserveSessionId =
    route.view === "agents-v2" && route.agentId === agent.id
      ? route.sessionId ?? null
      : null;
  const observeSessionId =
    resolveRoutedSessionId(routedObserveSessionId, sessionCatalog?.sessions ?? [])
    ?? routedObserveSessionId;

  const load = useCallback(async () => {
    const catalogResult = await api<SessionCatalogWithResume>(
      `/api/agents/${encodeURIComponent(agent.id)}/session-catalog`,
    ).catch(() => null);
    setSessionCatalog(catalogResult);
  }, [agent.id]);

  const loadObserve = useCallback(async () => {
    setObserveLoading(true);
    try {
      const params = observeSessionId ? new URLSearchParams({ sessionId: observeSessionId }) : null;
      const result = await api<AgentObservePayload>(
        `/api/agents/${encodeURIComponent(agent.id)}/observe${params ? `?${params}` : ""}`,
      );
      setObserve(result);
    } catch {
      setObserve({
        agentId: agent.id,
        source: "unavailable",
        fidelity: "synthetic",
        historyPath: null,
        sessionId: null,
        updatedAt: Date.now(),
        data: {
          events: [
            {
              id: `${agent.id}:observe-error`,
              t: 0,
              kind: "system",
              text: "Observer data is temporarily unavailable.",
              detail: "Retrying will resume once the session source becomes reachable.",
            },
          ],
          files: [],
          contextUsage: [],
          live: false,
        },
      });
    } finally {
      setObserveLoading(false);
    }
  }, [agent.id, observeSessionId]);

  useEffect(() => {
    setSessionCatalog(null);
    void load();
    const retry = window.setTimeout(() => {
      void load();
    }, 3000);
    return () => window.clearTimeout(retry);
  }, [load]);

  useEffect(() => {
    setObserve(null);
    setObserveLoading(false);
  }, [agent.id, observeSessionId]);

  useEffect(() => {
    if (activeTab !== "observe") {
      return;
    }
    void loadObserve();
  }, [activeTab, loadObserve]);

  useBrokerEvents(() => {
    void load();
    if (activeTab === "observe") {
      void loadObserve();
    }
  });

  useEffect(() => {
    if (activeTab !== "observe" || !observe?.data.live) {
      return;
    }
    const timer = setInterval(() => {
      void loadObserve();
    }, 2500);
    return () => clearInterval(timer);
  }, [activeTab, observe?.data.live, loadObserve]);

  return (
    <div
      className={`s-profile-center${
        activeTab !== "profile" ? " s-profile-center--tabbed" : " s-profile-center--modular"
      }`}
    >
      {activeTab === "profile" && (
        renderProfile ? (
          renderProfile({ agent, sessionCatalog, conversationId, navigate, route })
        ) : (
          <div className="s-aproj s-aproj--profile">
            <SessionProfileCenter
              agent={agent}
              name={name}
              sessionCatalog={sessionCatalog}
              conversationId={conversationId}
              navigate={navigate}
              route={route}
            />
          </div>
        )
      )}

      {activeTab === "config" && (
        <AgentDefinitionsWorkspace
          agent={agent}
          navigate={navigate}
          homeView="agents-v2"
        />
      )}

      {activeTab === "observe" && (
        <div className="s-profile-tab-conversation">
          {observeLoading && !observe ? (
            <div className="s-profile-activity-empty">
              <div className="s-profile-activity-empty-title">Loading trace</div>
              <div className="s-profile-activity-empty-detail">
                Resolving the best available live or history-backed session stream for this agent.
              </div>
            </div>
          ) : (
            <SessionObserve
              data={observe?.data}
              agentId={agent.id}
              sessionId={observe?.sessionId}
              observeSource={observe?.source}
              observeFidelity={observe?.fidelity}
              showRail={false}
            />
          )}
        </div>
      )}

      {activeTab === "message" && (
        conversationId ? (
          <div className="s-profile-tab-conversation">
            <ConversationScreen
              conversationId={conversationId}
              navigate={navigate}
              embedded
            />
          </div>
        ) : (
          <StartAgentChatPane
            agent={agent}
            navigate={navigate}
          />
        )
      )}
    </div>
  );
}

function StartAgentChatPane({
  agent,
  navigate,
}: {
  agent: Agent;
  navigate: (r: Route) => void;
}) {
  const { route } = useScout();
  const [state, setState] = useState<"idle" | "opening">("idle");
  const [error, setError] = useState<string | null>(null);

  const openChat = async () => {
    if (state === "opening") return;
    setState("opening");
    setError(null);
    try {
      const conversationId = await ensureAgentChat(agent);
      navigate(
        route.view === "agents-v2"
          ? { ...route, view: "agents-v2", agentId: agent.id, conversationId, tab: "message" }
          : { view: "agents-v2", agentId: agent.id, conversationId, tab: "message" },
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not open chat.");
    } finally {
      setState("idle");
    }
  };

  return (
    <div className="s-profile-tab-conversation">
      <div className="s-profile-activity-empty">
        <div className="s-profile-activity-empty-title">No chat yet</div>
        <div className="s-profile-activity-empty-detail">
          Open a direct chat with {agent.name}. The broker will create a real chat ID and keep routing by this agent identity.
        </div>
        {error && <div className="s-sess-action-error">{error}</div>}
        <button
          type="button"
          className="s-sess-action"
          disabled={state === "opening"}
          onClick={() => void openChat()}
        >
          {state === "opening" ? "Opening..." : "Open chat"}
        </button>
      </div>
    </div>
  );
}

export function AgentProfileBar({
  agent,
  conversationId,
  activeTab,
  navigate,
}: {
  agent: Agent;
  conversationId: string | null;
  activeTab: AgentTab;
  navigate: (r: Route) => void;
}) {
  const tabs: { key: AgentTab; label: string; disabled?: boolean }[] = [
    { key: "profile", label: "Sessions" },
    { key: "config", label: "Config" },
    { key: "observe", label: "Trace" },
    { key: "message", label: "Message" },
  ];
  const navigateToTab = (tab: AgentTab) =>
    navigate({
      view: "agents-v2",
      agentId: agent.id,
      ...(conversationId ? { conversationId } : {}),
      tab,
    });
  return (
    <div className="s-agent-bar">
      <BackToPicker
        slot="agents"
        fallback={{ view: "agents-v2" }}
        navigate={navigate}
        className="s-agent-bar-back"
      />
      <nav className="s-profile-tabs s-agent-bar-tabs">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`s-profile-tab${activeTab === t.key ? " s-profile-tab--active" : ""}`}
            disabled={t.disabled}
            onClick={() => navigateToTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
