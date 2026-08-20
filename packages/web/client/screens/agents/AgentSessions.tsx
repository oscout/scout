import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useScout } from "../../scout/Provider.tsx";
import { openContent } from "../../scout/slots/openContent.ts";
import { api } from "../../lib/api.ts";
import { copyTextToClipboard } from "../../lib/clipboard.ts";
import { timeAgo } from "../../lib/time.ts";
import type {
  AgentObservePayload,
  ObserveEvent,
  ObserveFile,
  SessionEntry,
} from "../../lib/types.ts";

/* ──────────────────────────────────────────────────────────────────────────
   Agent sessions — the work, expanded in place.

   Ported from the signed-off studio study `agents-session-expand`. Each of an
   agent's sessions is a work-led row; a collapsed row still carries the facts
   you triage on (branch · #id · turns), and opening one expands IN PLACE into
   the full instrument — session id, branch, model, context, tools, and the
   FILES it touched — fetched live from the session's own observe trace
   (/api/session-ref/:ref). No side rail, no separate page.

   Real-data note: branch/model/context/turns/tools/files are real (observe).
   talks-to and subagents have no per-session backing yet, so they're omitted
   rather than faked. Accent stays the directory's single --s-accent.
   ────────────────────────────────────────────────────────────────────────── */

const LIVE_WINDOW = 30 * 60_000;
const VOCATIVE_LEAD =
  /^(?:hey|hi|hello)\b[^,]{0,24},\s*|^(?:can|could|would|will)\s+(?:you|we|i)\s+(?:please\s+)?|^please\s+|^let'?s\s+/i;
const FILE_MARK: Record<ObserveFile["state"], string> = { created: "+", modified: "~", read: "·" };

type SessionStatus = "running" | "idle";

function headlineOf(s: SessionEntry): string {
  const raw = (s.preview ?? "")
    .replace(/^\[ask:[^\]]+\]\s*/i, "")
    .replace(/\s+/g, " ")
    .replace(VOCATIVE_LEAD, "")
    .trim();
  if (raw) return raw.length > 150 ? `${raw.slice(0, 150).replace(/\s+\S*$/, "")}…` : raw;
  const title = s.title?.trim();
  return title && title !== s.agentName ? title : "Untitled session";
}

function shortRef(id: string | null | undefined): string {
  if (!id) return "—";
  const clean = id
    .replace(/\.jsonl$/, "")
    .replace(/^c\./, "")
    .replace(/^session[_:-]?/i, "");
  return clean.length <= 10 ? clean : `${clean.slice(0, 8)}…${clean.slice(-3)}`;
}

function tidyDir(dir: string): string {
  return dir.replace(/^\/(?:Users|home)\/[^/]+\/(?:dev\/|projects\/|src\/|code\/)?/, "");
}

function fmtTokens(n: number | undefined | null): string {
  if (!n || n <= 0) return "0";
  if (n < 1000) return `${n}`;
  return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
}

function toolHistogram(events: ObserveEvent[]): Array<{ name: string; n: number }> {
  const counts = new Map<string, number>();
  for (const event of events) {
    if (event.kind !== "tool") continue;
    const name = (event.tool ?? "tool").toLowerCase();
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, n]) => ({ name, n }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 8);
}

/* Copy-to-clipboard with a brief, obvious confirmation. IDs (and the whole
   metadata block) should be one click to grab — reused for the session chip
   and the "Copy details" action below; liftable to any id-bearing surface. */
function useCopyFlash(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  const copy = useCallback((text: string) => {
    void copyTextToClipboard(text).then((ok) => {
      if (!ok) return;
      setCopied(true);
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1200);
    });
  }, []);
  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current);
  }, []);
  return [copied, copy];
}

function CopyGlyph({ copied }: { copied: boolean }) {
  return (
    <svg className="ap-sx-copyIco" width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
      {copied ? (
        <path
          d="M2.6 6.3 5 8.6 9.5 3.5"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        <>
          <rect x="3.6" y="3.6" width="6" height="6" rx="1.3" stroke="currentColor" strokeWidth="1.05" />
          <path
            d="M7.8 3.6V2.5A1.1 1.1 0 0 0 6.7 1.4H2.5A1.1 1.1 0 0 0 1.4 2.5v4.2A1.1 1.1 0 0 0 2.5 7.8h1.1"
            stroke="currentColor"
            strokeWidth="1.05"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )}
    </svg>
  );
}

/* A mono id rendered as a one-click copy chip — copies the FULL value, not the
   truncated display. The glyph flips to a check and the chip tints to accent. */
function CopyId({
  value,
  display,
  title,
  className,
}: {
  value: string;
  display: string;
  title?: string;
  className?: string;
}) {
  const [copied, copy] = useCopyFlash();
  return (
    <button
      type="button"
      className={className ? `ap-sx-copy ${className}` : "ap-sx-copy"}
      data-copied={copied || undefined}
      title={copied ? "Copied" : (title ?? value)}
      aria-label={`Copy ${value}`}
      onClick={(event) => {
        event.stopPropagation();
        copy(value);
      }}
    >
      <span className="ap-sx-copyText">{display}</span>
      <CopyGlyph copied={copied} />
    </button>
  );
}

function SessionDetail({
  session,
  agentId,
  status,
}: {
  session: SessionEntry;
  agentId: string;
  status: SessionStatus;
}) {
  const { route, navigate } = useScout();
  const [data, setData] = useState<AgentObservePayload | null>(null);
  const [phase, setPhase] = useState<"loading" | "loaded">("loading");
  const ref = session.harnessSessionId ?? session.id;

  // The agent's own observe trace (history-backed) is the reliable source of the
  // session's files/tools/context — session-ref only resolves the live session.
  useEffect(() => {
    if (!agentId) {
      setPhase("loaded");
      return;
    }
    let cancelled = false;
    setPhase("loading");
    setData(null);
    api<AgentObservePayload>(`/api/agents/${encodeURIComponent(agentId)}/observe`)
      .then((payload) => {
        if (cancelled) return;
        setData(payload);
        setPhase("loaded");
      })
      .catch(() => {
        if (!cancelled) setPhase("loaded");
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  const observe = data?.data ?? null;
  const meta = observe?.metadata;
  const usage = meta?.usage;
  const sessionMeta = meta?.session;
  const files = observe?.files ?? [];
  const tools = useMemo(() => toolHistogram(observe?.events ?? []), [observe?.events]);
  const [allCopied, copyAll] = useCopyFlash();

  const branch = sessionMeta?.gitBranch?.trim() || session.currentBranch?.trim() || "—";
  const model = sessionMeta?.model?.trim() || "—";
  const turns = sessionMeta?.turnCount ?? usage?.assistantMessages ?? session.messageCount ?? null;
  const startedAt = sessionMeta?.sessionStart ?? session.lastMessageAt ?? null;
  const ctxUsed = usage?.contextInputTokens ?? 0;
  const ctxTotal = usage?.contextWindowTokens ?? 0;
  const pct = ctxTotal > 0 ? Math.min(100, Math.round((ctxUsed / ctxTotal) * 100)) : null;
  const cache = (usage?.cacheReadInputTokens ?? 0) + (usage?.cacheCreationInputTokens ?? 0);

  const openThread = () =>
    openContent(navigate, { view: "sessions", sessionId: session.id }, { returnTo: route });
  const takeover = () =>
    openContent(navigate, { view: "terminal", agentId, mode: "takeover" }, { returnTo: route });

  // session is rendered as a copy chip (full id); the rest stay plain text.
  const plainStats: Array<[string, string]> = [
    ["branch", branch],
    ["model", model],
    ["started", startedAt ? timeAgo(startedAt) : "—"],
    ["turns", turns != null ? `${turns}` : "—"],
  ];

  // The whole instrument as a paste-ready block — copies the FULL ids.
  const buildMetaText = (): string => {
    const rows: Array<[string, string]> = [
      ["session", ref],
      ["agent", agentId || "—"],
      ["branch", branch],
      ["model", model],
      ["cwd", sessionMeta?.cwd?.trim() || "—"],
      ["started", startedAt ? new Date(startedAt).toISOString() : "—"],
      ["turns", turns != null ? `${turns}` : "—"],
      ["context", pct != null ? `${fmtTokens(ctxUsed)} / ${fmtTokens(ctxTotal)} (${pct}%)` : "—"],
    ];
    const head = rows.map(([key, value]) => `${`${key}:`.padEnd(9)}${value}`).join("\n");
    const fileBlock = files.length
      ? `\n\nfiles touched:\n${[...files]
          .slice(0, 24)
          .map((file) => `  ${FILE_MARK[file.state]} ${file.path}`)
          .join("\n")}`
      : "";
    return head + fileBlock;
  };

  if (phase === "loading") {
    return <div className="ap-sx-card ap-sx-loading">Loading session…</div>;
  }

  return (
    <div className="ap-sx-card">
      <div className="ap-sx-statGrid">
        <div className="ap-sx-stat">
          <span className="ap-sx-statKey">session</span>
          <CopyId className="ap-sx-copyStat" value={ref} display={`#${shortRef(ref)}`} title={ref} />
        </div>
        {plainStats.map(([key, value]) => (
          <div key={key} className="ap-sx-stat">
            <span className="ap-sx-statKey">{key}</span>
            <span className="ap-sx-statVal" title={value}>
              {value}
            </span>
          </div>
        ))}
      </div>

      {observe ? (
        <div className="ap-sx-cols">
          <div className="ap-sx-block">
            <div className="ap-sx-head">
              <span className="ap-sx-lbl">context</span>
              {pct != null ? (
                <span className="ap-sx-read">
                  <span className="ap-sx-num">{fmtTokens(ctxUsed)}</span>
                  <span className="ap-sx-dim"> / {fmtTokens(ctxTotal)}</span>
                  <span className="ap-sx-sep">·</span>
                  <span className="ap-sx-num">{pct}%</span>
                </span>
              ) : null}
            </div>
            {pct != null ? (
              <>
                <div className="ap-sx-gauge" aria-hidden>
                  <span className="ap-sx-gaugeFill" style={{ width: `${pct}%` }} />
                </div>
                <div className="ap-sx-flow">
                  <span>↑{fmtTokens(usage?.inputTokens)} in</span>
                  <span>↓{fmtTokens(usage?.outputTokens)} out</span>
                  {cache > 0 ? <span className="ap-sx-faint">cache {fmtTokens(cache)}</span> : null}
                </div>
              </>
            ) : (
              <div className="ap-sx-empty">No usage captured.</div>
            )}
          </div>

          <div className="ap-sx-block">
            <div className="ap-sx-head">
              <span className="ap-sx-lbl">tools</span>
              {tools.length > 0 ? (
                <span className="ap-sx-meta">{tools.reduce((n, t) => n + t.n, 0)} calls</span>
              ) : null}
            </div>
            {tools.length > 0 ? (
              <div className="ap-sx-tools">
                {tools.map((tool) => (
                  <span key={tool.name} className="ap-sx-tool">
                    <span className="ap-sx-toolName">{tool.name}</span>
                    <span className="ap-sx-toolN">×{tool.n}</span>
                  </span>
                ))}
              </div>
            ) : (
              <div className="ap-sx-empty">No tools yet.</div>
            )}
          </div>
        </div>
      ) : (
        <div className="ap-sx-empty ap-sx-noTrace">No live trace for this session.</div>
      )}

      {files.length > 0 ? (
        <div className="ap-sx-block">
          <div className="ap-sx-head">
            <span className="ap-sx-lbl">files touched</span>
            <span className="ap-sx-meta">{files.length}</span>
          </div>
          <div className="ap-sx-files">
            {[...files]
              .sort((a, b) => (a.state === "read" ? 1 : 0) - (b.state === "read" ? 1 : 0))
              .slice(0, 8)
              .map((file) => {
                const changed = file.state !== "read";
                const name = file.path.replace(/\/+$/, "").split("/").pop() ?? file.path;
                const dir = tidyDir(file.path.slice(0, file.path.length - name.length));
                return (
                  <div key={file.path} className="ap-sx-fileRow" data-changed={changed || undefined}>
                    <span className="ap-sx-fileMark" data-state={file.state} aria-hidden>
                      {FILE_MARK[file.state]}
                    </span>
                    <span className="ap-sx-fileName">{name}</span>
                    <span className="ap-sx-fileDir">{dir}</span>
                    <span className="ap-sx-fileN">×{file.touches}</span>
                  </div>
                );
              })}
          </div>
        </div>
      ) : null}

      <div className="ap-sx-actions">
        <button type="button" className="ap-sx-open" onClick={openThread}>
          Open ↗
        </button>
        <button type="button" className="ap-sx-resume" onClick={takeover}>
          {status === "running" ? "Send" : "Take over"}
        </button>
        <button
          type="button"
          className="ap-sx-copyAll"
          data-copied={allCopied || undefined}
          title="Copy session id + metadata"
          onClick={() => copyAll(buildMetaText())}
        >
          <CopyGlyph copied={allCopied} />
          {allCopied ? "Copied" : "Copy details"}
        </button>
      </div>
    </div>
  );
}

function SessionRow({
  session,
  fallbackAgentId,
}: {
  session: SessionEntry;
  fallbackAgentId: string;
}) {
  const agentId = session.agentId ?? fallbackAgentId;
  const [open, setOpen] = useState(false);
  const live = session.lastMessageAt != null && Date.now() - session.lastMessageAt < LIVE_WINDOW;
  const status: SessionStatus = live ? "running" : "idle";
  const headline = headlineOf(session);
  const branch = session.currentBranch?.trim();
  const id = shortRef(session.harnessSessionId ?? session.id);
  const age = session.lastMessageAt ? timeAgo(session.lastMessageAt) : "—";

  return (
    <div className="ap-sx-session" data-open={open || undefined} data-status={status}>
      <button type="button" className="ap-sx-row" onClick={() => setOpen((value) => !value)}>
        <span className="ap-sx-tri" data-open={open || undefined} aria-hidden>
          ▸
        </span>
        <span className="ap-sx-dot" data-tone={status} aria-hidden />
        <span className="ap-sx-rowBody">
          <span className="ap-sx-line">
            <span className="ap-sx-title" title={headline}>
              {headline}
            </span>
            <span className="ap-sx-rowMeta">
              <span className="ap-sx-badge" data-tone={status}>
                {status === "running" ? "RUNNING" : "IDLE"}
              </span>
              <span className="ap-sx-age">{age}</span>
            </span>
          </span>
          {!open ? (
            <span className="ap-sx-sub">
              {branch ? (
                <>
                  <span className="ap-sx-subBranch">{branch}</span>
                  <span className="ap-sx-subSep">·</span>
                </>
              ) : null}
              <span className="ap-sx-subId">#{id}</span>
              {session.messageCount > 0 ? (
                <>
                  <span className="ap-sx-subSep">·</span>
                  <span>
                    {session.messageCount} turn{session.messageCount === 1 ? "" : "s"}
                  </span>
                </>
              ) : null}
            </span>
          ) : null}
        </span>
      </button>
      {open ? <SessionDetail session={session} agentId={agentId} status={status} /> : null}
    </div>
  );
}

export function AgentSessions({ agentIds, sessions }: { agentIds: string[]; sessions: SessionEntry[] }) {
  // An agent rolls up several ids (branches/worktrees/clones); show the work
  // across all of them, most-recent first. Guard the props defensively — during
  // an HMR prop-shape swap a stale caller can briefly pass neither.
  const ids = agentIds ?? [];
  const list = (sessions ?? [])
    .filter((session) => session.agentId != null && ids.includes(session.agentId))
    .slice()
    .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))
    .slice(0, 8);
  if (list.length === 0) return null;
  const fallbackAgentId = ids[0] ?? "";
  return (
    <div className="ap-sx-list">
      {list.map((session) => (
        <SessionRow key={session.id} session={session} fallbackAgentId={fallbackAgentId} />
      ))}
    </div>
  );
}
