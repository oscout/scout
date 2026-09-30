import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Plus, X } from "lucide-react";

import { api } from "../lib/api.ts";
import { friendlyApiError } from "../lib/api-errors.ts";
import { ensureAgentChat } from "../lib/agent-chat.ts";
import { normalizeAgentState } from "../lib/agent-state.ts";
import { loadConversationList } from "../lib/conversation-list-cache.ts";
import { conversationDisplayTitle } from "../lib/conversations.ts";
import { useListArrowNav, useSlashToFocus } from "../lib/keyboard-nav.ts";
import { conversationalMessagePreview } from "../lib/message-visibility.ts";
import { loadLastViewedMap, saveLastViewed, type LastViewedMap } from "../lib/sessionRead.ts";
import { isSyntheticAgentId } from "../lib/synthetic-agent-routing.ts";
import { normalizeTimestampMs, timeAgo } from "../lib/time.ts";
import type { Agent, SessionEntry } from "../lib/types.ts";
import { useConversationList } from "../lib/use-conversation-list.ts";
import { ConversationScreen } from "../screens/chat/ConversationScreen.tsx";
import "../screens/chat/conversation-screen.css";
import { useScout } from "../scout/Provider.tsx";
import { RailRow } from "../scout/slots/RailRow.tsx";
import {
  basicDmConversations,
  findBasicDm,
  findBasicDmForAgent,
  isBasicDm,
  isBasicDmUnread,
} from "./profile.ts";

type DmFilter = "all" | "unread";

const BASELINE_STORAGE_KEY = "scout:basic:dms:unreadBaseline";

/**
 * Unread is "newer than the last time you opened it". A DM never opened in
 * this browser counts from the first visit, not from the beginning of time —
 * otherwise every historical DM would arrive unread.
 */
function readUnreadBaseline(): number {
  try {
    const stored = Number(localStorage.getItem(BASELINE_STORAGE_KEY));
    if (Number.isFinite(stored) && stored > 0) return stored;
    const now = Date.now();
    localStorage.setItem(BASELINE_STORAGE_KEY, String(now));
    return now;
  } catch {
    return Date.now();
  }
}

export function BasicDms() {
  const { route, navigate, agents } = useScout();
  const { sessions, loading, loadError, reload } = useConversationList();
  const [filter, setFilter] = useState<DmFilter>("all");
  const [query, setQuery] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [lastViewed, setLastViewed] = useState<LastViewedMap>(loadLastViewedMap);
  const [baseline] = useState(readUnreadBaseline);
  const filterRef = useRef<HTMLInputElement | null>(null);
  const listKeys = useListArrowNav();
  useSlashToFocus(() => filterRef.current);

  const agentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const dms = useMemo(
    () => basicDmConversations(sessions).sort(
      (a, b) => (normalizeTimestampMs(b.lastMessageAt) ?? 0) - (normalizeTimestampMs(a.lastMessageAt) ?? 0),
    ),
    [sessions],
  );

  const activeConversationId = route.view === "conversation" ? route.conversationId : null;
  const activeDm = activeConversationId ? findBasicDm(dms, activeConversationId) : null;
  const activeAgentId = route.view === "messages" ? route.agentId ?? null : null;

  // Reading a thread keeps it read, including messages that land while it is open.
  const activeDmId = activeDm?.id ?? null;
  const activeDmLastMessageAt = activeDm?.lastMessageAt ?? null;
  useEffect(() => {
    if (!activeDmId) return;
    setLastViewed(saveLastViewed(activeDmId));
  }, [activeDmId, activeDmLastMessageAt]);

  const unreadCount = useMemo(
    () => dms.filter((dm) => dm.id !== activeDmId && isBasicDmUnread(dm, lastViewed, baseline)).length,
    [activeDmId, baseline, dms, lastViewed],
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return dms.filter((dm) => {
      if (filter === "unread" && !(dm.id === activeDmId || isBasicDmUnread(dm, lastViewed, baseline))) return false;
      if (!needle) return true;
      const agent = dm.agentId ? agentById.get(dm.agentId) : undefined;
      return [conversationDisplayTitle(dm), dm.agentName, agent?.name, agent?.handle, dm.preview]
        .some((field) => field?.toLowerCase().includes(needle));
    });
  }, [activeDmId, agentById, baseline, dms, filter, lastViewed, query]);

  const openDm = useCallback((conversationId: string) => {
    setPickerOpen(false);
    navigate({ view: "conversation", conversationId });
  }, [navigate]);

  const threadOpen = Boolean(activeConversationId || activeAgentId || pickerOpen);

  return (
    <div className={`sb-dms${threadOpen ? " sb-dms--thread-open" : ""}`}>
      <aside className="sb-dms-rail" aria-label="Direct messages">
        <div className="sb-dms-rail-head">
          <input
            ref={filterRef}
            className="sb-input"
            type="search"
            placeholder="Filter… (/)"
            aria-label="Filter DMs"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setQuery("");
                event.currentTarget.blur();
              }
            }}
          />
          <button
            type="button"
            className="s-btn sb-new-dm"
            aria-pressed={pickerOpen}
            onClick={() => setPickerOpen((open) => !open)}
          >
            <Plus size={13} aria-hidden="true" />
            <span>New DM</span>
          </button>
        </div>
        <div className="sys-tab-row sb-dms-filter" role="tablist" aria-label="DM filter">
          {(["all", "unread"] as const).map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={filter === key}
              className={`sys-tab${filter === key ? " sys-tab-active" : ""}`}
              onClick={() => setFilter(key)}
            >
              <span>{key === "all" ? "All" : "Unread"}</span>
              <span className="sys-tab-count">{key === "all" ? dms.length : unreadCount}</span>
            </button>
          ))}
        </div>
        <div className="sb-dms-list" onKeyDown={listKeys}>
          {loadError && dms.length === 0 ? (
            <div className="sb-empty">
              <p>{loadError}</p>
              <button type="button" className="s-btn" onClick={() => void reload(true)}>Retry</button>
            </div>
          ) : loading && dms.length === 0 ? (
            <p className="sb-empty">Loading DMs…</p>
          ) : visible.length === 0 ? (
            <p className="sb-empty">
              {dms.length === 0
                ? "No DMs yet. Start one with an agent."
                : filter === "unread" ? "Nothing unread." : "No DMs match."}
            </p>
          ) : visible.map((dm) => {
            const agent = dm.agentId ? agentById.get(dm.agentId) : undefined;
            const title = conversationDisplayTitle(dm);
            return (
              <RailRow
                key={dm.id}
                name={title}
                sub={dm.preview ? conversationalMessagePreview(dm.preview) : undefined}
                meta={dm.lastMessageAt ? timeAgo(dm.lastMessageAt) : undefined}
                tone={agent ? normalizeAgentState(agent.state) : "dm"}
                agent={agent}
                avatarName={agent?.name ?? title}
                active={dm.id === activeDmId}
                unread={dm.id !== activeDmId && isBasicDmUnread(dm, lastViewed, baseline)}
                onClick={() => openDm(dm.id)}
              />
            );
          })}
        </div>
      </aside>
      <section className="sb-dms-thread">
        {threadOpen && (
          <button
            type="button"
            className="sb-dms-back"
            onClick={() => {
              setPickerOpen(false);
              navigate({ view: "messages" });
            }}
          >
            <ArrowLeft size={13} aria-hidden="true" />
            <span>DMs</span>
          </button>
        )}
        {pickerOpen ? (
          <AgentPicker
            agents={agents}
            dms={dms}
            onClose={() => setPickerOpen(false)}
            onOpen={openDm}
          />
        ) : activeConversationId ? (
          <DmThreadGate
            key={activeConversationId}
            conversationId={activeConversationId}
            composeDraft={route.view === "conversation" ? route.composeDraft : undefined}
            listed={activeDm}
            listSettled={!loading}
          />
        ) : activeAgentId ? (
          <AgentDmResolver key={activeAgentId} agentId={activeAgentId} dms={dms} listSettled={!loading} />
        ) : (
          <div className="sb-empty sb-empty--center">
            <p>Pick a DM, or start one with an agent.</p>
            <button type="button" className="s-btn" onClick={() => setPickerOpen(true)}>New DM</button>
          </div>
        )}
      </section>
    </div>
  );
}

type GateState =
  | { status: "checking" }
  | { status: "allowed"; conversationId: string }
  | { status: "rejected"; kind: string }
  | { status: "missing"; message: string };

/**
 * Basic web opens operator ↔ agent DMs only. A listed DM opens at once; any
 * other id (a fresh DM not yet in the list, a coalesced id, a pasted link)
 * is checked against the broker before the thread mounts.
 */
function DmThreadGate({
  conversationId,
  composeDraft,
  listed,
  listSettled,
}: {
  conversationId: string;
  composeDraft?: string;
  listed: SessionEntry | null;
  listSettled: boolean;
}) {
  const { navigate } = useScout();
  const [checked, setChecked] = useState<GateState>({ status: "checking" });
  const canonicalId = listed?.id ?? (checked.status === "allowed" ? checked.conversationId : null);

  useEffect(() => {
    if (listed || !listSettled) return;
    let cancelled = false;
    api<SessionEntry>(`/api/session/${encodeURIComponent(conversationId)}`)
      .then((meta) => {
        if (cancelled) return;
        if (!meta?.id) {
          setChecked({ status: "missing", message: "This conversation was not found." });
        } else if (isBasicDm(meta)) {
          setChecked({ status: "allowed", conversationId: meta.id });
        } else {
          setChecked({ status: "rejected", kind: meta.kind });
        }
      })
      .catch((cause) => {
        if (cancelled) return;
        const detail = friendlyApiError(cause);
        setChecked({
          status: "missing",
          message: /not found/i.test(detail)
            ? "This conversation was not found."
            : `Couldn't open this conversation: ${detail}`,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId, listSettled, listed]);

  // A coalesced id opens as its canonical DM, without leaving a history entry.
  useEffect(() => {
    if (canonicalId && canonicalId !== conversationId) {
      navigate({ view: "conversation", conversationId: canonicalId }, { replace: true });
    }
  }, [canonicalId, conversationId, navigate]);

  if (canonicalId === conversationId) {
    return (
      <ConversationScreen
        key={conversationId}
        conversationId={conversationId}
        initialDraft={composeDraft}
        navigate={navigate}
        showBackNav={false}
      />
    );
  }
  if (checked.status === "rejected") {
    return (
      <div className="sb-empty sb-empty--center" role="status">
        <p>
          This is {checked.kind === "channel"
            ? "a channel"
            : checked.kind === "group_direct"
              ? "a group conversation"
              : "a conversation between agents"}. Scout basic shows direct messages between you and one agent.
        </p>
        <button type="button" className="s-btn" onClick={() => navigate({ view: "messages" })}>Back to DMs</button>
      </div>
    );
  }
  if (checked.status === "missing") {
    return (
      <div className="sb-empty sb-empty--center" role="status">
        <p>{checked.message}</p>
        <button type="button" className="s-btn" onClick={() => navigate({ view: "messages" })}>Back to DMs</button>
      </div>
    );
  }
  return <p className="sb-empty sb-empty--center">Opening DM…</p>;
}

/**
 * `/messages/agent/:id` — open the operator's DM with that agent. An existing
 * DM opens directly; when there is none, starting one is an explicit click,
 * never a side effect of following a link.
 */
function AgentDmResolver({
  agentId,
  dms,
  listSettled,
}: {
  agentId: string;
  dms: SessionEntry[];
  listSettled: boolean;
}) {
  const { agents, agentsLoaded, navigate } = useScout();
  const agent = agents.find((candidate) => candidate.id === agentId) ?? null;
  const existing = findBasicDmForAgent(dms, agentId)?.id ?? agent?.conversationId?.trim() ?? null;
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!listSettled || !existing) return;
    navigate({ view: "conversation", conversationId: existing }, { replace: true });
  }, [existing, listSettled, navigate]);

  const start = useCallback(async () => {
    if (!agent) return;
    setStarting(true);
    setError(null);
    try {
      const conversationId = await ensureAgentChat(agent);
      void loadConversationList({ force: true }).catch(() => null);
      navigate({ view: "conversation", conversationId }, { replace: true });
    } catch (cause) {
      setError(friendlyApiError(cause));
      setStarting(false);
    }
  }, [agent, navigate]);

  if (!listSettled || !agentsLoaded || existing) {
    return <p className="sb-empty sb-empty--center">Opening DM…</p>;
  }
  if (!agent) {
    return (
      <div className="sb-empty sb-empty--center" role="status">
        <p>No agent named <code>{agentId}</code> is registered here.</p>
        <button type="button" className="s-btn" onClick={() => navigate({ view: "messages" })}>Back to DMs</button>
      </div>
    );
  }
  return (
    <div className="sb-empty sb-empty--center">
      <p>No DM with {agent.name} yet.</p>
      <button type="button" className="s-btn" disabled={starting} onClick={() => void start()}>
        {starting ? "Starting…" : `Start a DM with ${agent.name}`}
      </button>
      {error && <p className="sb-error" role="alert">{error}</p>}
    </div>
  );
}

/** Start (or reopen) a DM with one agent. Opening a DM sends nothing. */
function AgentPicker({
  agents,
  dms,
  onClose,
  onOpen,
}: {
  agents: Agent[];
  dms: SessionEntry[];
  onClose: () => void;
  onOpen: (conversationId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const listKeys = useListArrowNav();

  const candidates = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return agents
      .filter((agent) => !isSyntheticAgentId(agent.id))
      .filter((agent) => !needle || [agent.name, agent.handle, agent.id, agent.project]
        .some((field) => field?.toLowerCase().includes(needle)))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [agents, query]);

  const choose = useCallback(async (agent: Agent) => {
    const existing = findBasicDmForAgent(dms, agent.id);
    if (existing) {
      onOpen(existing.id);
      return;
    }
    setPendingId(agent.id);
    setError(null);
    try {
      const conversationId = await ensureAgentChat(agent);
      void loadConversationList({ force: true }).catch(() => null);
      onOpen(conversationId);
    } catch (cause) {
      setError(friendlyApiError(cause));
    } finally {
      setPendingId(null);
    }
  }, [dms, onOpen]);

  return (
    <div className="sb-picker" role="dialog" aria-label="Start a DM">
      <div className="sb-picker-head">
        <strong>New DM</strong>
        <button type="button" className="s-icon-btn" aria-label="Close" onClick={onClose}>
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      <input
        className="sb-input"
        type="search"
        autoFocus
        placeholder="Find an agent"
        aria-label="Find an agent"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      />
      {error && <p className="sb-error" role="alert">{error}</p>}
      <div className="sb-picker-list" onKeyDown={listKeys}>
        {candidates.length === 0 ? (
          <p className="sb-empty">{agents.length === 0 ? "No agents are registered yet." : "No agents match."}</p>
        ) : candidates.map((agent) => (
          <RailRow
            key={agent.id}
            name={agent.name}
            sub={agent.project ?? agent.handle ?? undefined}
            meta={pendingId === agent.id ? "opening…" : undefined}
            tone={normalizeAgentState(agent.state)}
            agent={agent}
            avatarName={agent.name}
            onClick={() => void choose(agent)}
          />
        ))}
      </div>
    </div>
  );
}
