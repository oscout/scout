/**
 * Minimized chat side-rail: sectioned chip stack.
 *
 * With hundreds of conversations we never list everything — we show a short
 * sample of each rail band (matching the expanded IA):
 *   PIN · # channels · DMs · OBS
 *
 * Uses the shared conversation list cache so collapse does not re-fetch.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  conversationDisplayTitle,
  isChannelConversation,
  isObservedDirect,
  isOperatorDm,
} from "../../lib/conversations.ts";
import {
  isArchived,
  isPinned,
  loadConversationPrefs,
  pinRank,
  type ConversationPrefs,
} from "../../lib/conversation-prefs.ts";
import {
  filterSessionsByMachineScope,
  machineScopedAgentIds,
} from "../../lib/machine-scope.ts";
import { fleetAskForSession } from "../../lib/fleet-active-asks.ts";
import { routeMachineId } from "../../lib/router.ts";
import {
  isUnread,
  loadLastViewedMap,
  saveLastViewed,
  type LastViewedMap,
} from "../../lib/sessionRead.ts";
import { useConversationList } from "../../lib/use-conversation-list.ts";
import { useFleetActiveAsks } from "../../lib/use-fleet-active-asks.ts";
import { useScout } from "../../scout/Provider.tsx";
import type { Agent, Route, SessionEntry } from "../../lib/types.ts";
import { isAgentOnline } from "../../lib/agent-state.ts";
import { AgentAvatar } from "../../components/AgentAvatar.tsx";
import {
  CollapsedChip,
  CollapsedStrip,
  CollapsedStripRule,
} from "../../scout/sidebar/CollapsedStrip.tsx";

/** Caps — collapsed rail is a jump list, not a full index. */
const PIN_LIMIT = 3;
const CHANNEL_LIMIT = 3;
const DM_LIMIT = 4;
const OBSERVED_LIMIT = 3;

function recencySort(list: SessionEntry[], lastViewed: LastViewedMap): SessionEntry[] {
  return [...list].sort((a, b) => {
    const ua = isUnread(a.lastMessageAt, a.id, lastViewed) ? 0 : 1;
    const ub = isUnread(b.lastMessageAt, b.id, lastViewed) ? 0 : 1;
    if (ua !== ub) return ua - ub;
    return (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0);
  });
}

export function ChatCollapsedStrip({ onExpand }: { onExpand?: () => void }) {
  const { route, navigate, agents } = useScout();
  const { sessions } = useConversationList();
  const activeAsks = useFleetActiveAsks();
  const [prefs, setPrefs] = useState<ConversationPrefs>(() => loadConversationPrefs());
  const [lastViewed, setLastViewed] = useState<LastViewedMap>(() => loadLastViewedMap());
  const machineId = routeMachineId(route);
  const scopedAgentIds = useMemo(
    () => machineScopedAgentIds(agents, machineId),
    [agents, machineId],
  );

  const agentById = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const agent of agents) {
      map.set(agent.id, agent);
    }
    return map;
  }, [agents]);

  const activeId =
    route.view === "messages" ? route.conversationId :
    route.view === "conversation" ? route.conversationId :
    undefined;

  useEffect(() => {
    setPrefs(loadConversationPrefs());
    setLastViewed(loadLastViewedMap());
  }, []);

  const bands = useMemo(() => {
    const live = filterSessionsByMachineScope(sessions, scopedAgentIds, machineId)
      .filter((s) => !isArchived(s.id, prefs));

    const pinned = live
      .filter((s) => isPinned(s.id, prefs))
      .sort((a, b) => pinRank(b.id, prefs) - pinRank(a.id, prefs) || (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))
      .slice(0, PIN_LIMIT);

    const pinnedIds = new Set(pinned.map((s) => s.id));
    const rest = live.filter((s) => !pinnedIds.has(s.id));

    return {
      pinned,
      channels: recencySort(rest.filter(isChannelConversation), lastViewed).slice(0, CHANNEL_LIMIT),
      dms: recencySort(rest.filter(isOperatorDm), lastViewed).slice(0, DM_LIMIT),
      observed: recencySort(rest.filter(isObservedDirect), lastViewed).slice(0, OBSERVED_LIMIT),
      totals: {
        channels: rest.filter(isChannelConversation).length,
        dms: rest.filter(isOperatorDm).length,
        observed: rest.filter(isObservedDirect).length,
        pinned: live.filter((s) => isPinned(s.id, prefs)).length,
      },
    };
  }, [sessions, scopedAgentIds, machineId, prefs, lastViewed]);

  const open = (s: SessionEntry) => {
    setLastViewed(saveLastViewed(s.id));
    // Channels and DMs share one conversation route.
    navigate({
      view: "messages",
      conversationId: s.id,
      ...(machineId ? { machineId } : {}),
    } satisfies Route);
  };

  const allShown = [
    ...bands.pinned,
    ...bands.channels,
    ...bands.dms,
    ...bands.observed,
  ];
  const unreadCount = allShown.filter((s) => isUnread(s.lastMessageAt, s.id, lastViewed)).length;

  const renderChip = (s: SessionEntry, pinned = false) => {
    const title = conversationDisplayTitle(s);
    const channel = isChannelConversation(s);
    const unread = isUnread(s.lastMessageAt, s.id, lastViewed);
    const peer = channel ? undefined : peerLabel(s, title);
    const identity = peer ?? title;
    const agent = s.agentId ? agentById.get(s.agentId) : undefined;
    const ask = fleetAskForSession(activeAsks, s);
    const hasAttention = ask?.status === "needs_attention";
    const isWorking = ask?.status === "working";
    const isOnline = agent ? isAgentOnline(agent.state) : false;

    const dot = hasAttention ? "attention" : unread ? "unread" : isWorking || isOnline ? "live" : null;

    return (
      <CollapsedChip
        key={s.id}
        title={pinned ? `${title} · pinned` : peer ? `${title} · ${peer}` : title}
        active={s.id === activeId}
        tone={channel ? "channel" : hasAttention ? "attention" : unread ? "unread" : "default"}
        avatarNode={
          channel ? undefined : (
            <AgentAvatar
              agent={agent}
              name={identity}
              size={28}
              tile
              presence={false}
            />
          )
        }
        glyph={channel ? channelMark(title) : undefined}
        dot={dot}
        pinned={pinned}
        onClick={() => open(s)}
      />
    );
  };

  const sections: ReactNode[] = [];
  if (bands.pinned.length) {
    sections.push(
      <CollapsedStripSection key="pin" mark="Pin" count={bands.totals.pinned} showMark={sections.length > 0}>
        {bands.pinned.map((s) => renderChip(s, true))}
      </CollapsedStripSection>,
    );
  }
  if (bands.channels.length) {
    sections.push(
      <CollapsedStripSection key="ch" mark="#" count={bands.totals.channels} showMark={sections.length > 0}>
        {bands.channels.map((s) => renderChip(s))}
      </CollapsedStripSection>,
    );
  }
  if (bands.dms.length) {
    sections.push(
      <CollapsedStripSection key="dm" mark="DM" count={bands.totals.dms} showMark={sections.length > 0}>
        {bands.dms.map((s) => renderChip(s))}
      </CollapsedStripSection>,
    );
  }
  if (bands.observed.length) {
    sections.push(
      <CollapsedStripSection key="obs" mark="Obs" count={bands.totals.observed} showMark={sections.length > 0}>
        {bands.observed.map((s) => renderChip(s))}
      </CollapsedStripSection>,
    );
  }

  return (
    <CollapsedStrip
      label="Chat"
      emptyMark="#"
      labelTone={unreadCount > 0 ? "accent" : "default"}
      labelCount={unreadCount > 0 ? unreadCount : allShown.length || undefined}
      onLabelClick={onExpand}
    >
      {sections}
    </CollapsedStrip>
  );
}

/** "#s" for #spatial-agent-updates — styled channel badge. */
function channelMark(title: string): ReactNode {
  const raw = title.replace(/^#+/, "");
  const letter = raw.match(/[a-z0-9]/i)?.[0]?.toLowerCase() ?? "?";
  return (
    <span className="collapsed-chip-channel-badge">
      <span className="collapsed-chip-channel-hash" aria-hidden>#</span>
      <span className="collapsed-chip-channel-text">{letter}</span>
    </span>
  );
}

/**
 * The participant that is NOT the display title — for "Blink" DMs the session
 * on the other side (openscout-pauli-3), i.e. the identity the chip stands for.
 */
function peerLabel(s: SessionEntry, title: string): string | undefined {
  const wanted = title.toLowerCase();
  for (const p of s.participants ?? []) {
    const name = p.displayName || p.label;
    if (name && name.toLowerCase() !== wanted) return name;
  }
  return undefined;
}

/** Mini band header inside the collapsed chat stack (# / DM / Obs). */
function CollapsedStripSection({
  mark,
  count,
  showMark = true,
  children,
}: {
  mark: string;
  count?: number;
  showMark?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="collapsed-strip-section" role="group" aria-label={mark}>
      {showMark ? (
        <div className="collapsed-strip-section-mark" title={count != null ? `${mark} · ${count}` : mark}>
          <span className="collapsed-strip-section-mark-text">{mark}</span>
          {count != null && count > 0 ? (
            <span className="collapsed-strip-section-mark-count">{count > 99 ? "99+" : count}</span>
          ) : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}
