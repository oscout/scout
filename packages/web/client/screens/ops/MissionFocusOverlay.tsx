/**
 * Mission Control focus overlay — the composed view of one agent, opened from a
 * wall pane. The wall itself stays raw (see MissionLogPane.tsx); this is where
 * profile, activity and steering live.
 */
import { useEffect, useRef, useState } from "react";
import type * as React from "react";
import { actorColor } from "../../lib/colors.ts";
import { agentStateLabel, normalizeAgentState } from "../../lib/agent-state.ts";
import { useFocusTrap } from "../../lib/keyboard-nav.ts";
import { timeAgo } from "../../lib/time.ts";
import { formatLabel } from "../../lib/text.ts";
import { statusOnHover } from "../../lib/page-status.ts";
import { MessageComposer } from "../../components/MessageComposer/index.ts";
import { type SessionObserveData } from "../sessions/SessionObserve.tsx";
import type { Agent, ObserveEvent } from "../../lib/types.ts";
import { KIND_LABEL } from "./mission-control-model.ts";

/* ── Focus overlay — full SessionObserve ── */

type FocusTab = "profile" | "activity" | "message";

export function FocusOverlay({
  agent,
  observe,
  onClose,
  onSend,
  onOpenConversation,
  onTail,
  onProfile,
}: {
  agent: Agent;
  observe: SessionObserveData | null;
  onClose: () => void;
  onSend: (body: string) => Promise<void>;
  onOpenConversation: () => void;
  onTail: () => void;
  onProfile: () => void;
}) {
  const color = actorColor(agent.name);
  const { ref: dialogRef, onKeyDown: onTrapKeyDown } = useFocusTrap<HTMLDivElement>();
  const [tab, setTab] = useState<FocusTab>("profile");

  const onDialogKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    onTrapKeyDown(e);
    if (e.defaultPrevented) return;
    const target = e.target as HTMLElement | null;
    const inEditable = target instanceof HTMLInputElement
      || target instanceof HTMLTextAreaElement
      || (target?.isContentEditable ?? false);
    if (inEditable) return;
    if (e.key === "1") { e.preventDefault(); setTab("profile"); }
    else if (e.key === "2") { e.preventDefault(); setTab("activity"); }
    else if (e.key === "3") { e.preventDefault(); setTab("message"); }
  };

  return (
    <div className="s-mission-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="mission-overlay-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onDialogKeyDown}
        tabIndex={-1}
        className="s-mission-overlay-dialog"
      >
        <div className="s-mission-overlay-header">
          <div
            className="s-ops-avatar"
            style={{ "--size": "28px", background: color } as React.CSSProperties}
          >
            {agent.name[0]?.toUpperCase()}
          </div>
          <div className="s-mission-overlay-identity">
            <div className="s-mission-overlay-name" id="mission-overlay-title">
              {agent.name}{" "}
              <span className="s-mission-overlay-handle">
                {agent.handle ? `@${agent.handle}` : ""}
              </span>
            </div>
            <div className="s-mission-overlay-meta">
              {agent.project ?? "—"} · {agent.branch ?? "main"} · {agentStateLabel(agent.state)}
            </div>
          </div>
          <button
            className="s-mission-overlay-close"
            onClick={onClose}
            aria-label="Close (Esc)"
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>

        <div className="s-mission-overlay-tabs" role="tablist">
          <div className="s-mission-overlay-tabs-group">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "profile"}
              className={`s-mission-overlay-tab${tab === "profile" ? " s-mission-overlay-tab--active" : ""}`}
              onClick={() => setTab("profile")}
            >
              Profile
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "activity"}
              className={`s-mission-overlay-tab${tab === "activity" ? " s-mission-overlay-tab--active" : ""}`}
              onClick={() => setTab("activity")}
            >
              Activity
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "message"}
              className={`s-mission-overlay-tab${tab === "message" ? " s-mission-overlay-tab--active" : ""}`}
              onClick={() => setTab("message")}
            >
              Message
            </button>
          </div>
          <div className="s-mission-overlay-tabs-action">
            {tab === "profile" && (
              <button
                type="button"
                className="s-mission-overlay-jump"
                onClick={onProfile}
                {...statusOnHover({
                  label: `Open profile · ${agent.handle ?? agent.name}`,
                  route: `/agents/${agent.id}`,
                })}
              >
                Open profile ↗
              </button>
            )}
            {tab === "activity" && (
              <button
                type="button"
                className="s-mission-overlay-jump"
                onClick={onTail}
                {...statusOnHover({
                  label: `Tail · ${agent.handle ?? agent.name}`,
                  route: `/ops/tail?q=${encodeURIComponent(agent.handle ?? agent.name)}`,
                })}
              >
                Open in Tail ↗
              </button>
            )}
            {tab === "message" && (
              <button
                type="button"
                className="s-mission-overlay-jump"
                onClick={onOpenConversation}
                {...statusOnHover({
                  label: `Open conversation with ${agent.handle ?? agent.name}`,
                  ...(agent.conversationId ? { route: `/c/${agent.conversationId}` } : {}),
                })}
              >
                Open conversation ↗
              </button>
            )}
          </div>
        </div>

        <div className="s-mission-overlay-body">
          {tab === "profile" && <FocusProfileTab agent={agent} />}
          {tab === "activity" && (
            <FocusActivityTab
              agent={agent}
              observe={observe}
              onOpenConversation={onOpenConversation}
              onMessage={() => setTab("message")}
            />
          )}
          {tab === "message" && (
            <FocusMessageTab
              agent={agent}
              onSend={onSend}
              onOpenConversation={onOpenConversation}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function FocusProfileTab({ agent }: { agent: Agent }) {
  const rows: Array<[string, string]> = [
    ["MODEL", [agent.harness, agent.model].filter(Boolean).join("/") || "—"],
    ["AT", [agent.project, agent.branch].filter(Boolean).join("/") || "—"],
    ["CWD", agent.cwd || agent.projectRoot || "—"],
    ["AGENT", agent.agentClass || "—"],
    ["ROLE", agent.role || agent.transport || "—"],
    ["MACHINE", agent.authorityNodeName ?? agent.homeNodeName ?? agent.authorityNodeId ?? agent.homeNodeId ?? "—"],
    ["OWNER", agent.ownerHandle ?? agent.ownerName ?? agent.ownerId ?? "—"],
    ["SPAWNED", agent.createdAt ? timeAgo(agent.createdAt) : "—"],
    ["STATE", agentStateLabel(agent.state)],
  ];
  return (
    <div className="s-focus-tab">
      <dl className="s-focus-spec">
        {rows.map(([k, v]) => (
          <div key={k} className="s-focus-spec-row">
            <dt className="s-focus-spec-label">{k}</dt>
            <dd className="s-focus-spec-value" title={v}>{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

const ACTIVITY_PREVIEW_LIMIT = 14;

const KIND_GLYPH: Record<string, string> = {
  tool: "▸",
  think: "·",
  ask: "?",
  message: "✉",
  note: "•",
  system: "◇",
  boot: "↑",
};

function formatEventAge(secondsFromStart: number, sessionStart?: number | null): string {
  if (sessionStart) {
    const ms = Date.now() - (sessionStart + secondsFromStart * 1000);
    if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s`;
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
    if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
    return `${Math.round(ms / 86_400_000)}d`;
  }
  const s = Math.max(0, Math.round(secondsFromStart));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

function eventSummary(event: ObserveEvent): string {
  if (event.kind === "tool") {
    const head = event.tool ?? "tool";
    return event.arg ? `${head} · ${event.arg}` : head;
  }
  if (event.kind === "ask") {
    return event.text || "request received";
  }
  return event.text || event.detail || KIND_LABEL[event.kind] || event.kind;
}

function FocusActivityTab({
  agent,
  observe,
  onOpenConversation,
  onMessage,
}: {
  agent: Agent;
  observe: SessionObserveData | null;
  onOpenConversation: () => void;
  onMessage: () => void;
}) {
  const events = observe?.events ?? [];
  const usage = observe?.metadata?.usage;
  const sessionStart = typeof (observe?.metadata?.session as Record<string, unknown> | undefined)?.["sessionStart"] === "number"
    ? ((observe?.metadata?.session as Record<string, unknown>)["sessionStart"] as number)
    : null;

  const recent = events.slice(-ACTIVITY_PREVIEW_LIMIT).reverse();

  const turnCount = usage?.assistantMessages ?? events.filter((e) => e.kind === "message").length;
  const toolCount = events.filter((e) => e.kind === "tool").length;
  const editCount = events.filter(
    (e) => e.kind === "tool" && (e.tool === "edit" || e.tool === "write"),
  ).length;
  const ctxPct = observe?.contextUsage && observe.contextUsage.length > 0
    ? Math.round(observe.contextUsage[observe.contextUsage.length - 1] * 100)
    : null;
  const ctxLabel = ctxPct !== null
    ? `${ctxPct}%`
    : usage?.contextWindowTokens && usage?.contextInputTokens
      ? `${Math.round((usage.contextInputTokens / usage.contextWindowTokens) * 100)}%`
      : "—";

  return (
    <div className="s-focus-tab s-focus-tab--activity-preview">
      <dl className="s-focus-stats">
        <Stat label="Turns" value={turnCount || "—"} />
        <Stat label="Tools" value={toolCount || "—"} />
        <Stat label="Edits" value={editCount || "—"} />
        <Stat label="Context" value={ctxLabel} />
      </dl>

      {recent.length === 0 ? (
        <FocusActivityEmpty
          agent={agent}
          onOpenConversation={onOpenConversation}
          onMessage={onMessage}
        />
      ) : (
        <ul className="s-focus-activity-list">
          {recent.map((event) => (
            <li key={event.id} className={`s-focus-activity-row s-focus-activity-row--${event.kind}`}>
              <span className="s-focus-activity-time">{formatEventAge(event.t, sessionStart)}</span>
              <span className="s-focus-activity-glyph" aria-hidden>
                {KIND_GLYPH[event.kind] ?? "·"}
              </span>
              <span className="s-focus-activity-kind">{KIND_LABEL[event.kind] ?? event.kind}</span>
              <span className="s-focus-activity-text">{eventSummary(event)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FocusActivityEmpty({
  agent,
  onOpenConversation,
  onMessage,
}: {
  agent: Agent;
  onOpenConversation: () => void;
  onMessage: () => void;
}) {
  const role = formatLabel(agent.role);
  const harness = [agent.harness, agent.model].filter(Boolean).join("/");
  const where = [agent.project, agent.branch].filter(Boolean).join("/");
  const state = normalizeAgentState(agent.state);
  const stateLabel = agentStateLabel(state);
  const spawned = agent.createdAt ? timeAgo(agent.createdAt) : null;
  const lastSeen = agent.updatedAt ? timeAgo(agent.updatedAt) : null;
  const home = agent.homeNodeName ?? agent.homeNodeId;

  const owner = agent.ownerHandle ?? agent.ownerName ?? agent.ownerId;

  const facts: { label: string; value: string }[] = [];
  if (role) facts.push({ label: "Role", value: role });
  if (harness) facts.push({ label: "Stack", value: harness });
  if (where) facts.push({ label: "At", value: where });
  if (home) facts.push({ label: "Home", value: home });
  if (owner) facts.push({ label: "Owner", value: owner });
  if (spawned) facts.push({ label: "Spawned", value: spawned });
  facts.push({ label: "State", value: stateLabel });
  if (lastSeen) facts.push({ label: "Last seen", value: lastSeen });

  return (
    <div className="s-focus-activity-empty s-focus-activity-empty--rich">
      <div className="s-focus-activity-empty-head">
        <span className="s-focus-activity-empty-eyebrow">No tool or turn events recorded</span>
        <span className="s-focus-activity-empty-title">{agent.handle ?? agent.name}</span>
      </div>
      <dl className="s-focus-activity-empty-facts">
        {facts.map((f) => (
          <div key={f.label} className="s-focus-activity-empty-fact">
            <dt>{f.label}</dt>
            <dd title={f.value}>{f.value}</dd>
          </div>
        ))}
      </dl>
      <div className="s-focus-activity-empty-actions">
        <button
          type="button"
          className="s-focus-activity-empty-btn"
          onClick={onOpenConversation}
          {...statusOnHover({
            label: `Open conversation with ${agent.handle ?? agent.name}`,
            ...(agent.conversationId ? { route: `/c/${agent.conversationId}` } : {}),
          })}
        >
          Open conversation ↗
        </button>
        <button
          type="button"
          className="s-focus-activity-empty-btn s-focus-activity-empty-btn--primary"
          onClick={onMessage}
          {...statusOnHover({
            label: `Compose message · ${agent.handle ?? agent.name}`,
          })}
        >
          Send a message
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="s-focus-stat">
      <dt className="s-focus-stat-label">{label}</dt>
      <dd className="s-focus-stat-value">{value}</dd>
    </div>
  );
}

function FocusMessageTab({
  agent,
  onSend,
  onOpenConversation,
}: {
  agent: Agent;
  onSend: (body: string) => Promise<void>;
  onOpenConversation: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const send = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    try {
      await onSend(body);
      setDraft("");
      setSent(true);
      setTimeout(() => setSent(false), 1800);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  };

  const name = agent.handle ?? agent.name;

  return (
    <div className="s-focus-tab">
      <div className="s-focus-compose">
        <MessageComposer
          density="panel"
          value={draft}
          onChange={setDraft}
          onSend={() => void send()}
          sending={sending}
          placeholder={`Message @${name}…`}
          textareaRef={textareaRef}
          rows={4}
          aria-label={`Message @${name}`}
          header={(
            <div className="s-focus-compose-label">
              Message <span className="s-focus-compose-target">@{name}</span>
            </div>
          )}
          tools={(
            <div className="s-focus-compose-hint">
              {error ? (
                <span className="s-focus-compose-error">Send failed: {error}</span>
              ) : sent ? (
                <span className="s-focus-compose-ok">
                  Sent ↗{" "}
                  <button type="button" className="s-focus-compose-link" onClick={onOpenConversation}>
                    Open Chat
                  </button>
                </span>
              ) : (
                <span>Send starts a Run, or steers the active Run when this agent is already working.</span>
              )}
            </div>
          )}
        />
      </div>
    </div>
  );
}
