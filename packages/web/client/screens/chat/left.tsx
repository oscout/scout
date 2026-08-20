import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import "../../scout/slots/ctx-panel.css";
import { isOfflineApiError } from "../../lib/api-errors.ts";
import { useListArrowNav, makeSearchHandoff, useSlashToFocus, rovingTabIndex } from "../../lib/keyboard-nav.ts";
import { normalizeAgentState, type AgentDisplayState } from "../../lib/agent-state.ts";
import {
  conversationDisplayTitle,
  conversationShortLabel,
  isChannelConversation,
  isObservedDirect,
  isOperatorDm,
} from "../../lib/conversations.ts";
import {
  isArchived,
  isPinned,
  loadConversationPrefs,
  pinRank,
  toggleArchive,
  togglePin,
  type ConversationPrefs,
} from "../../lib/conversation-prefs.ts";
import {
  buildConversationGroups,
  pathBasename,
  type ConversationGroup,
} from "../../lib/conversation-groups.ts";
import { useContextMenu, type MenuItem } from "../../components/ContextMenu.tsx";
import { timeAgo } from "../../lib/time.ts";
import {
  loadLastViewedMap,
  saveLastViewed,
  type LastViewedMap,
} from "../../lib/sessionRead.ts";
import { useConversationList } from "../../lib/use-conversation-list.ts";
import { useFleetActiveAsks } from "../../lib/use-fleet-active-asks.ts";
import { useScout } from "../../scout/Provider.tsx";
import {
  filterSessionsByMachineScope,
  machineScopedAgentIds,
} from "../../lib/machine-scope.ts";
import { routeMachineId } from "../../lib/router.ts";
import { RailRow } from "../../scout/slots/RailRow.tsx";
import type { Agent, FleetAsk, SessionEntry } from "../../lib/types.ts";

/** How many observed groups show before "+N more" (keeps the rail scannable). */
const OBSERVED_PREVIEW_LIMIT = 12;

/**
 * Roving-tabindex bookkeeping. Rows are addressed by ROW id, not conversation
 * id: Needs-you mirrors conversations that also render in their own section
 * below, so a conversation id is not unique in the rail.
 */
type RailNav = {
  /** Conversation currently open in the center pane (highlights every mirror). */
  activeId: string | undefined;
  /** The single row that owns the tab stop, or undefined when nothing is open. */
  activeRowId: string | undefined;
  /** First row in render order — the tab stop when nothing is open. */
  firstRowId: string | undefined;
};

/**
 * The chat rail (D1/D3/D4/D5 of docs/design/comms-channel-navigation.md).
 *
 * One list, fixed sections, no switchers: Needs you · Pinned · Agents ·
 * Channels · Observed · Archived. Attention is the only emphasis — Needs-you
 * MIRRORS rows rather than moving them, so nothing reflows when an ask
 * resolves and positional memory survives.
 */
export function ChatLeft() {
  const { route, navigate, agents, apiConnection } = useScout();
  const { sessions, loading, loadError, reload } = useConversationList();
  const [lastViewed, setLastViewed] = useState<LastViewedMap>(() => loadLastViewedMap());
  const [prefs, setPrefs] = useState<ConversationPrefs>(() => loadConversationPrefs());
  const [query, setQuery] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const [observedOpen, setObservedOpen] = useState(false);
  const [showAllObserved, setShowAllObserved] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const asksByAgent = useFleetActiveAsks();
  const machineId = routeMachineId(route);
  const scopedAgentIds = useMemo(
    () => machineScopedAgentIds(agents, machineId),
    [agents, machineId],
  );

  const agentById = useMemo(() => {
    const map = new Map<string, Agent>();
    const scopedAgents = scopedAgentIds
      ? agents.filter((agent) => scopedAgentIds.has(agent.id))
      : agents;
    for (const agent of scopedAgents) {
      map.set(agent.id, agent);
    }
    return map;
  }, [agents, scopedAgentIds]);

  const activeId =
    route.view === "messages" ? route.conversationId :
    route.view === "conversation" ? route.conversationId :
    route.view === "agent-info" ? route.conversationId :
    route.view === "agents-v2" ? route.conversationId :
    undefined;

  // Keep the observed stratum tight when the query changes under it.
  useEffect(() => {
    setShowAllObserved(false);
  }, [query]);

  const machineScoped = useMemo(
    () => filterSessionsByMachineScope(sessions, scopedAgentIds, machineId),
    [sessions, scopedAgentIds, machineId],
  );

  const scoped = useMemo(
    () => (query ? machineScoped.filter((s) => matchesQuery(s, query)) : machineScoped),
    [machineScoped, query],
  );

  /**
   * The precedence layer: operator DMs whose agent has an ask waiting on you.
   * Computed off the UNFILTERED list so the header stat stays an honest global
   * readout while you type a filter; the section itself is filtered below.
   */
  const needsYouAll = useMemo(() => {
    const askUpdatedAt = (s: SessionEntry) =>
      (s.agentId ? asksByAgent.get(s.agentId)?.updatedAt : undefined) ?? 0;
    return machineScoped
      .filter((s) => {
        if (isArchived(s.id, prefs)) return false;
        if (!isOperatorDm(s)) return false;
        const ask = s.agentId ? asksByAgent.get(s.agentId) : undefined;
        return ask?.status === "needs_attention";
      })
      .sort((a, b) => askUpdatedAt(b) - askUpdatedAt(a));
  }, [machineScoped, prefs, asksByAgent]);

  const needsYou = useMemo(
    () => (query ? needsYouAll.filter((s) => matchesQuery(s, query)) : needsYouAll),
    [needsYouAll, query],
  );

  const sections = useMemo(() => {
    const live = scoped.filter((s) => !isArchived(s.id, prefs));
    const archived = sortByRecency(scoped.filter((s) => isArchived(s.id, prefs)));

    // Pinned float above everything else (most recently pinned first).
    const pinned = live
      .filter((s) => isPinned(s.id, prefs))
      .sort((a, b) => pinRank(b.id, prefs) - pinRank(a.id, prefs) || (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));

    const unpinned = live.filter((s) => !isPinned(s.id, prefs));
    // Named #channels only — group_direct is a DM/observed room, not a channel.
    const channels = unpinned.filter(isChannelConversation);
    const dms = unpinned.filter(isOperatorDm);
    const observed = unpinned.filter(isObservedDirect);

    // One fixed order everywhere: recency. Attention lives in Needs-you, not
    // in sort order — sorting is a preference, not chrome (D1).
    return {
      pinned,
      channels: sortByRecency(channels),
      agents: buildConversationGroups(sortByRecency(dms), agentById, lastViewed, "recent"),
      observed: buildConversationGroups(sortByRecency(observed), agentById, lastViewed, "recent"),
      archived,
    };
  }, [scoped, agentById, lastViewed, prefs]);

  const showContextMenu = useContextMenu();

  const onTogglePin = useCallback((id: string) => {
    setPrefs((prev) => togglePin(id, prev));
  }, []);

  const onToggleArchive = useCallback((id: string) => {
    setPrefs((prev) => toggleArchive(id, prev));
  }, []);

  const onSelect = useCallback((s: SessionEntry) => {
    setLastViewed(saveLastViewed(s.id));
    // One conversation route for every kind — channels included (D1).
    navigate({ view: "messages", conversationId: s.id });
  }, [navigate]);

  const openConversationMenu = useCallback(
    (event: MouseEvent, s: SessionEntry) => {
      const pinned = isPinned(s.id, prefs);
      const archived = isArchived(s.id, prefs);
      const title = conversationDisplayTitle(s);
      const items: MenuItem[] = [
        {
          kind: "action",
          label: "Open",
          onSelect: () => onSelect(s),
        },
        { kind: "separator" },
        {
          kind: "action",
          label: pinned ? "Unpin" : "Pin to top",
          onSelect: () => onTogglePin(s.id),
        },
        {
          kind: "action",
          label: archived ? "Unarchive" : "Archive",
          onSelect: () => onToggleArchive(s.id),
        },
        { kind: "separator" },
        {
          kind: "action",
          label: "Copy name",
          onSelect: () => {
            void navigator.clipboard?.writeText(title).catch(() => {});
          },
        },
      ];
      showContextMenu(event, items);
    },
    [prefs, onSelect, onTogglePin, onToggleArchive, showContextMenu],
  );

  const toggleGroup = (key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const apiOffline =
    apiConnection.status === "offline" || isOfflineApiError(loadError);

  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const onListKeyDown = useListArrowNav();
  const onSearchKeyDown = makeSearchHandoff(() => listRef.current);
  useSlashToFocus(useCallback(() => inputRef.current, []));

  const pinnedCount = sections.pinned.length;
  const channelCount = sections.channels.length;
  const agentCount = sections.agents.reduce((n, g) => n + g.conversations.length, 0);
  const observedCount = sections.observed.reduce((n, g) => n + g.conversations.length, 0);
  const archivedCount = sections.archived.length;
  // Needs-you rows are mirrors of rows counted below — never counted twice.
  const totalVisible = pinnedCount + channelCount + agentCount + observedCount + archivedCount;

  // Query forces the collapsed stratum open so search reaches Observed (D1).
  const observedExpanded = observedOpen || Boolean(query);

  const railRows = useMemo(() => {
    const out: Array<{ rowId: string; id: string }> = [];
    for (const s of needsYou) out.push({ rowId: `ny-${s.id}`, id: s.id });
    for (const s of sections.pinned) out.push({ rowId: `pin-${s.id}`, id: s.id });
    for (const g of sections.agents) for (const c of g.conversations) out.push({ rowId: c.id, id: c.id });
    for (const s of sections.channels) out.push({ rowId: s.id, id: s.id });
    for (const g of sections.observed) for (const c of g.conversations) out.push({ rowId: c.id, id: c.id });
    for (const s of sections.archived) out.push({ rowId: `arch-${s.id}`, id: s.id });
    return out;
  }, [needsYou, sections]);

  const nav: RailNav = useMemo(() => ({
    activeId,
    activeRowId: activeId ? railRows.find((r) => r.id === activeId)?.rowId : undefined,
    firstRowId: railRows[0]?.rowId,
  }), [activeId, railRows]);

  // The preview limit lives INSIDE the expanded stratum (D5).
  const observedShown = showAllObserved || query
    ? sections.observed
    : sections.observed.slice(0, OBSERVED_PREVIEW_LIMIT);
  const observedHidden = Math.max(0, sections.observed.length - observedShown.length);

  // Auto-open the group that holds the active conversation.
  const isGroupOpen = (group: ConversationGroup) => {
    if (query) return true;
    if (expandedGroups.has(group.key)) return true;
    if (activeId && group.conversations.some((c) => c.id === activeId)) return true;
    return false;
  };

  const rowActions = (s: SessionEntry) => (
    <ConversationActions
      pinned={isPinned(s.id, prefs)}
      archived={isArchived(s.id, prefs)}
      onTogglePin={() => onTogglePin(s.id)}
      onToggleArchive={() => onToggleArchive(s.id)}
    />
  );

  return (
    <div className="ctx-panel">
      <div className="ctx-panel-toolbar">
        <input
          ref={inputRef}
          type="text"
          className="ctx-panel-search-input"
          placeholder="Filter…  (/)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onSearchKeyDown}
        />
        {needsYouAll.length > 0 && (
          <span className="ctx-panel-rail-stat" title="Asks waiting on your reply">
            {needsReplyLabel(needsYouAll.length)}
          </span>
        )}
      </div>

      <div
        ref={listRef}
        className={[
          "ctx-panel-list",
          "ctx-panel-list--scroll",
          totalVisible === 0 && "ctx-panel-list--empty",
        ]
          .filter(Boolean)
          .join(" ")}
        onKeyDown={onListKeyDown}
      >
        {totalVisible === 0 ? (
          <ChatRailEmptyState
            query={query}
            loading={loading}
            error={loadError}
            apiOffline={apiOffline}
            onRetry={() => {
              void reload(true);
            }}
          />
        ) : (
          <>
            {needsYou.length > 0 && (
              <RailSection
                label="Needs you"
                count={needsYou.length}
                hint="Asks waiting on your reply"
              >
                {/* Mirrors: the origin row keeps its place below, so nothing
                    reflows under the cursor when an ask resolves. */}
                {needsYou.map((s) => (
                  <SessionRailRow
                    key={`ny-${s.id}`}
                    rowId={`ny-${s.id}`}
                    session={s}
                    nav={nav}
                    agentById={agentById}
                    asksByAgent={asksByAgent}
                    onSelect={onSelect}
                    onContextMenu={openConversationMenu}
                  />
                ))}
              </RailSection>
            )}

            {pinnedCount > 0 && (
              <RailSection label="Pinned" count={pinnedCount} hint="Pinned conversations">
                {sections.pinned.map((s) => (
                  <SessionRailRow
                    key={`pin-${s.id}`}
                    rowId={`pin-${s.id}`}
                    session={s}
                    nav={nav}
                    agentById={agentById}
                    asksByAgent={asksByAgent}
                    pinned
                    actions={rowActions(s)}
                    onSelect={onSelect}
                    onContextMenu={openConversationMenu}
                  />
                ))}
              </RailSection>
            )}

            {agentCount > 0 && (
              <RailSection label="Agents" count={agentCount}>
                {sections.agents.map((group) => (
                  <GroupOrRow
                    key={group.key}
                    group={group}
                    isOpen={isGroupOpen(group)}
                    nav={nav}
                    agentById={agentById}
                    asksByAgent={asksByAgent}
                    prefs={prefs}
                    onToggle={() => toggleGroup(group.key)}
                    onSelect={onSelect}
                    onTogglePin={onTogglePin}
                    onToggleArchive={onToggleArchive}
                    onContextMenu={openConversationMenu}
                  />
                ))}
              </RailSection>
            )}

            {channelCount > 0 && (
              <RailSection label="Channels" count={channelCount}>
                {sections.channels.map((s) => (
                  <SessionRailRow
                    key={s.id}
                    rowId={s.id}
                    session={s}
                    nav={nav}
                    agentById={agentById}
                    asksByAgent={asksByAgent}
                    actions={rowActions(s)}
                    onSelect={onSelect}
                    onContextMenu={openConversationMenu}
                  />
                ))}
              </RailSection>
            )}

            {observedCount > 0 && (
              <RailSection
                label="Observed"
                count={observedCount}
                hint="Agent conversations you’re not in"
                open={observedExpanded}
                onToggle={() => setObservedOpen((v) => !v)}
              >
                {observedShown.map((group) => (
                  <GroupOrRow
                    key={group.key}
                    group={group}
                    isOpen={isGroupOpen(group)}
                    nav={nav}
                    agentById={agentById}
                    asksByAgent={asksByAgent}
                    prefs={prefs}
                    observed
                    onToggle={() => toggleGroup(group.key)}
                    onSelect={onSelect}
                    onTogglePin={onTogglePin}
                    onToggleArchive={onToggleArchive}
                    onContextMenu={openConversationMenu}
                  />
                ))}
                {observedHidden > 0 ? (
                  <button
                    type="button"
                    className="ctx-panel-more"
                    onClick={() => setShowAllObserved(true)}
                  >
                    + {observedHidden} more observed
                  </button>
                ) : null}
              </RailSection>
            )}

            {archivedCount > 0 && (
              <RailSection label="Archived" count={archivedCount} hint="Hidden from the main rail">
                <button
                  type="button"
                  className="ctx-panel-more"
                  onClick={() => setShowArchived((v) => !v)}
                >
                  {showArchived ? "▾ hide archived" : `› show ${archivedCount} archived`}
                </button>
                {showArchived
                  ? sections.archived.map((s) => (
                      <SessionRailRow
                        key={`arch-${s.id}`}
                        rowId={`arch-${s.id}`}
                        session={s}
                        nav={nav}
                        agentById={agentById}
                        asksByAgent={asksByAgent}
                        actions={rowActions(s)}
                        onSelect={onSelect}
                        onContextMenu={openConversationMenu}
                      />
                    ))
                  : null}
              </RailSection>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function RailSection({
  label,
  count,
  hint,
  open,
  onToggle,
  children,
}: {
  label: string;
  count: number;
  hint?: string;
  /** Collapsible sections pass both `open` and `onToggle`. */
  open?: boolean;
  onToggle?: () => void;
  children: ReactNode;
}) {
  if (onToggle) {
    return (
      <section className="ctx-panel-rail-section" aria-label={label}>
        <button
          type="button"
          className="ctx-panel-section-label ctx-panel-section-toggle"
          title={hint}
          aria-expanded={Boolean(open)}
          onClick={onToggle}
        >
          <span className="ctx-panel-section-toggle-label">
            <span className="ctx-panel-section-chevron" aria-hidden>{open ? "▾" : "▸"}</span>
            {label}
          </span>
          <span className="ctx-panel-count">{count}</span>
        </button>
        {open ? <div className="ctx-panel-rail-section-body">{children}</div> : null}
      </section>
    );
  }
  return (
    <section className="ctx-panel-rail-section" aria-label={label}>
      <div className="ctx-panel-section-label" title={hint}>
        <span>{label}</span>
        <span className="ctx-panel-count">{count}</span>
      </div>
      <div className="ctx-panel-rail-section-body">{children}</div>
    </section>
  );
}

function ConversationActions({
  pinned,
  archived,
  onTogglePin,
  onToggleArchive,
}: {
  pinned: boolean;
  archived: boolean;
  onTogglePin: () => void;
  onToggleArchive: () => void;
}) {
  return (
    <>
      <button
        type="button"
        className={["rr-row-action", pinned && "rr-row-action--on"].filter(Boolean).join(" ")}
        title={pinned ? "Unpin" : "Pin to top"}
        aria-label={pinned ? "Unpin" : "Pin"}
        onClick={(e) => {
          e.stopPropagation();
          onTogglePin();
        }}
      >
        {pinned ? "Unpin" : "Pin"}
      </button>
      <button
        type="button"
        className={["rr-row-action", archived && "rr-row-action--on"].filter(Boolean).join(" ")}
        title={archived ? "Unarchive" : "Archive"}
        aria-label={archived ? "Unarchive" : "Archive"}
        onClick={(e) => {
          e.stopPropagation();
          onToggleArchive();
        }}
      >
        {archived ? "Restore" : "Archive"}
      </button>
    </>
  );
}

function SessionRailRow({
  session: s,
  rowId,
  nav,
  agentById,
  asksByAgent,
  pinned,
  depth,
  actions,
  worktreeLabel,
  onSelect,
  onContextMenu,
}: {
  session: SessionEntry;
  /** Unique per RENDERED row — Needs-you mirrors reuse the conversation. */
  rowId: string;
  nav: RailNav;
  agentById: Map<string, Agent>;
  asksByAgent: Map<string, FleetAsk>;
  pinned?: boolean;
  depth?: 0 | 1;
  actions?: ReactNode;
  /** Side-checkout name shown as a worktree glyph (merged repo groups). */
  worktreeLabel?: string | null;
  onSelect: (s: SessionEntry) => void;
  onContextMenu?: (event: MouseEvent, s: SessionEntry) => void;
}) {
  const active = s.id === nav.activeId;
  const title = conversationDisplayTitle(s);
  const channel = isChannelConversation(s);
  const observed = isObservedDirect(s);
  const agent = s.agentId ? agentById.get(s.agentId) : undefined;
  const ask = s.agentId ? asksByAgent.get(s.agentId) : undefined;
  // D4 — emphasis is ADDRESSED-ONLY: an ask waiting on you, never recency.
  // Channel rows carry none because there is no addressed-mention (@you)
  // backend yet; until mentions land, channels order by recency only.
  // D5 — Observed has no unread state at all; its count is inventory.
  const unread = !channel && !observed && ask?.status === "needs_attention";
  const identifier = threadIdentifier(s, agent);
  const baseSub = channel
    ? `${s.participantIds.length} members`
    : identifier.toLowerCase() === title.toLowerCase()
      ? undefined
      : identifier;
  const sub = !channel && ask ? activeAskSubtitle(s, agent, ask) : baseSub;

  return (
    <RailRow
      depth={depth}
      name={depth === 1 ? conversationChildLabel(s, agent, ask) : title}
      sub={depth === 1 ? threadIdentifier(s, agent) : sub}
      meta={ask ? timeAgo(ask.updatedAt) : s.lastMessageAt ? timeAgo(s.lastMessageAt) : undefined}
      tone={
        channel
          ? "channel"
          : ask
            ? askRowTone(agent, ask)
            : agent
              ? normalizeAgentState(agent.state)
              : "dm"
      }
      avatarName={depth === 1 ? (agent?.name ?? conversationChildLabel(s, agent, ask)) : title}
      avatarKind={channel ? "channel" : "user"}
      active={active}
      unread={unread}
      pinned={pinned}
      activityLabel={ask ? askActivityLabel(ask) : undefined}
      activityTone={ask ? askActivityTone(ask) : undefined}
      worktreeLabel={worktreeLabel ?? undefined}
      title={depth === 1 ? conversationChildTooltip(s, agent, ask) : undefined}
      actions={actions}
      tabIndex={rovingTabIndex(
        rowId === nav.activeRowId,
        nav.activeRowId !== undefined,
        rowId === nav.firstRowId,
      )}
      onClick={() => onSelect(s)}
      onContextMenu={onContextMenu ? (e) => onContextMenu(e, s) : undefined}
    />
  );
}

function GroupOrRow({
  group,
  isOpen,
  nav,
  agentById,
  asksByAgent,
  prefs,
  observed,
  onToggle,
  onSelect,
  onTogglePin,
  onToggleArchive,
  onContextMenu,
}: {
  group: ConversationGroup;
  isOpen: boolean;
  nav: RailNav;
  agentById: Map<string, Agent>;
  asksByAgent: Map<string, FleetAsk>;
  prefs: ConversationPrefs;
  /** Observed stratum — no unread state anywhere in it (D5). */
  observed?: boolean;
  onToggle: () => void;
  onSelect: (s: SessionEntry) => void;
  onTogglePin: (id: string) => void;
  onToggleArchive: (id: string) => void;
  onContextMenu: (event: MouseEvent, s: SessionEntry) => void;
}) {
  if (group.conversations.length === 1) {
    const s = group.conversations[0]!;
    return (
      <SessionRailRow
        rowId={s.id}
        session={s}
        nav={nav}
        agentById={agentById}
        asksByAgent={asksByAgent}
        pinned={isPinned(s.id, prefs)}
        actions={
          <ConversationActions
            pinned={isPinned(s.id, prefs)}
            archived={isArchived(s.id, prefs)}
            onTogglePin={() => onTogglePin(s.id)}
            onToggleArchive={() => onToggleArchive(s.id)}
          />
        }
        onSelect={onSelect}
        onContextMenu={onContextMenu}
      />
    );
  }

  const groupAsks = group.conversations
    .map((candidate) => candidate.agentId ? asksByAgent.get(candidate.agentId) : undefined)
    .filter((ask): ask is FleetAsk => Boolean(ask));
  const activeAskCount = groupAsks.length;
  const workingAskCount = groupAsks.filter((ask) => ask.status === "working").length;
  const attentionAskCount = groupAsks.filter((ask) => ask.status === "needs_attention").length;
  const anyActive = group.conversations.some((c) => c.id === nav.activeId);

  return (
    <div key={group.key}>
      <RailRow
        name={group.label}
        meta={activeAskCount > 0
          ? `${activeAskCount} active · ${messagesGroupMeta(group)}`
          : messagesGroupMeta(group)}
        tone={workingAskCount > 0 ? "in_turn" : group.bestState}
        caret={isOpen ? "open" : "closed"}
        active={anyActive && !isOpen}
        // D4/D5 — a collapsed group bolds only for asks addressed to you, and
        // never inside the observed stratum.
        unread={!observed && attentionAskCount > 0 && !isOpen}
        activityLabel={activeAskCount > 0 ? `${activeAskCount} active` : undefined}
        activityTone={attentionAskCount > 0 ? "attention" : workingAskCount > 0 ? "working" : "pending"}
        onClick={onToggle}
      />
      {isOpen &&
        group.conversations.map((s) => {
          const childAgent = s.agentId ? agentById.get(s.agentId) : undefined;
          const worktreeLabel =
            group.canonicalRoot
            && childAgent?.projectRoot
            && childAgent.projectRoot !== group.canonicalRoot
              ? pathBasename(childAgent.projectRoot)
              : null;
          return (
          <SessionRailRow
            key={s.id}
            rowId={s.id}
            session={s}
            depth={1}
            nav={nav}
            agentById={agentById}
            asksByAgent={asksByAgent}
            pinned={isPinned(s.id, prefs)}
            worktreeLabel={worktreeLabel}
            actions={
              <ConversationActions
                pinned={isPinned(s.id, prefs)}
                archived={isArchived(s.id, prefs)}
                onTogglePin={() => onTogglePin(s.id)}
                onToggleArchive={() => onToggleArchive(s.id)}
              />
            }
            onSelect={onSelect}
            onContextMenu={onContextMenu}
          />
          );
        })}
    </div>
  );
}

function ChatRailEmptyState({
  query,
  loading,
  error,
  apiOffline,
  onRetry,
}: {
  query: string;
  loading: boolean;
  error: string | null;
  apiOffline: boolean;
  onRetry: () => void;
}) {
  const hasQuery = query.trim().length > 0;
  const title = loading
    ? "Loading conversations"
    : apiOffline
      ? "Scout server offline"
      : error
        ? "Couldn't load conversations"
        : hasQuery
          ? "No matching conversations"
          : "No conversations yet";
  const detail = loading
    ? "Checking the broker for your conversations, channels, and observed threads."
    : apiOffline
      ? "Start or restart Scout services, then retry."
      : error
        ? error
        : hasQuery
          ? "Try a shorter filter."
          : "Your conversations, channels, and observed agent threads will show here.";

  return (
    <div className="ctx-panel-empty-card" data-tone={apiOffline || error ? "error" : "neutral"}>
      <div className="ctx-panel-empty-card-title">{title}</div>
      <div className="ctx-panel-empty-card-detail">{detail}</div>
      {(apiOffline || error) && (
        <button
          type="button"
          className="ctx-panel-empty-card-action"
          onClick={onRetry}
        >
          Retry
        </button>
      )}
    </div>
  );
}

function matchesQuery(s: SessionEntry, query: string): boolean {
  const q = query.toLowerCase();
  return conversationDisplayTitle(s).toLowerCase().includes(q)
    || s.id.toLowerCase().includes(q)
    || (s.preview ?? "").toLowerCase().includes(q)
    || (s.agentName ?? "").toLowerCase().includes(q);
}

function needsReplyLabel(count: number): string {
  return count === 1 ? "1 needs a reply" : `${count} need a reply`;
}

function askActivityLabel(ask: FleetAsk): string {
  if (ask.status === "queued") return "Starting";
  if (ask.status === "working") return "Working";
  if (ask.status === "needs_attention") return "Needs you";
  return ask.statusLabel || ask.status;
}

function askActivityTone(ask: FleetAsk): "pending" | "working" | "attention" {
  if (ask.status === "queued") return "pending";
  if (ask.status === "needs_attention") return "attention";
  return "working";
}

function askRowTone(
  agent: Agent | undefined,
  ask: FleetAsk,
): AgentDisplayState | "dm" {
  if (ask.status === "working") return "in_turn";
  return agent ? normalizeAgentState(agent.state) : "dm";
}

function activeAskSubtitle(
  s: SessionEntry,
  agent: Agent | undefined,
  ask: FleetAsk,
): string {
  const status = askActivityLabel(ask);
  const task = trimPreview(ask.task)
    ?? trimPreview(ask.summary)
    ?? trimPreview(s.preview)
    ?? s.currentBranch
    ?? agent?.branch
    ?? "";
  return task ? `${status} · ${task}` : status;
}

function sortByRecency(list: SessionEntry[]): SessionEntry[] {
  return [...list].sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));
}

function conversationChildLabel(
  s: SessionEntry,
  agent: Agent | undefined,
  ask: FleetAsk | undefined,
): string {
  const subject = ask?.task ?? trimPreview(s.preview) ?? s.currentBranch ?? agent?.branch ?? "";
  const name = agent?.name ?? s.agentName ?? conversationDisplayTitle(s);
  return subject ? `${name} · ${subject}` : name;
}

function conversationChildTooltip(
  s: SessionEntry,
  agent: Agent | undefined,
  ask: FleetAsk | undefined,
): string | undefined {
  const parts: string[] = [];
  if (ask) parts.push(`task: ${ask.task}`);
  if (s.preview) parts.push(`preview: ${s.preview}`);
  if (s.currentBranch ?? agent?.branch) parts.push(`branch: ${s.currentBranch ?? agent?.branch}`);
  if (agent?.harness) parts.push(`harness: ${agent.harness}`);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function threadIdentifier(s: SessionEntry, agent: Agent | undefined): string {
  if (isChannelConversation(s)) {
    return conversationShortLabel(s);
  }
  const handle = agent?.handle?.trim().replace(/^@+/, "");
  if (handle) return handle;
  if (s.agentId) return s.agentId.split(".")[0] ?? s.agentId;
  return conversationDisplayTitle(s);
}

function trimPreview(preview: string | null): string | null {
  if (!preview) return null;
  const collapsed = preview.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  return collapsed.length > 60 ? `${collapsed.slice(0, 57)}…` : collapsed;
}

/**
 * Group meta is activity grammar, not inventory ratios (D3): recency-unread
 * counts are exactly the ambient pressure D4 kills, so the ratio is gone.
 */
function messagesGroupMeta(group: ConversationGroup): string {
  const time = group.latestUpdate ? timeAgo(group.latestUpdate) : "";
  const count = `${group.conversations.length}`;
  return time ? `${count} · ${time}` : count;
}
