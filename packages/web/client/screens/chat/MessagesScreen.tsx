import { useEffect, useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";

import {
  conversationDisplayTitle,
  isObservedDirect,
} from "../../lib/conversations.ts";
import {
  filterSessionsByMachineScope,
  machineScopedAgentIds,
} from "../../lib/machine-scope.ts";
import { routeMachineId } from "../../lib/router.ts";
import {
  isUnread,
  loadLastViewedMap,
  saveLastViewed,
  type LastViewedMap,
} from "../../lib/sessionRead.ts";
import type { Route, SessionEntry } from "../../lib/types.ts";
import { useConversationList } from "../../lib/use-conversation-list.ts";
import { useFleetActiveAsks } from "../../lib/use-fleet-active-asks.ts";
import { useScout } from "../../scout/Provider.tsx";
import { ConversationScreen } from "./ConversationScreen.tsx";
import "./conversation-screen.css";

export function MessagesScreen({
  conversationId,
  navigate,
}: {
  conversationId?: string;
  navigate: (route: Route) => void;
}) {
  // One conversation route (D6): ConversationScreen renders every kind —
  // channels included. The old channels route wrapped the same component,
  // and the Chat secondary strip died with the DM/Channels split.
  if (!conversationId) {
    return <MessagesLander />;
  }
  return (
    <ConversationScreen
      conversationId={conversationId}
      navigate={navigate}
      showBackNav={false}
    />
  );
}

/**
 * There is no landing page (D2): the rail + open conversation IS the triage
 * surface. Bare /messages resolves to a conversation by precedence —
 * unseen needs-you → last-active participant conversation → zero-state.
 * Landing marks the conversation seen; Observed threads are never a landing
 * target. `replace` keeps Back from bouncing through the redirect.
 */
function MessagesLander() {
  const { onlineCount, apiConnection, reload, route, agents, openContextCapture, navigate } =
    useScout();
  const { sessions, loading, loadError } = useConversationList();
  const [lastViewed] = useState<LastViewedMap>(() => loadLastViewedMap());
  const asksByAgent = useFleetActiveAsks();
  const apiOffline = apiConnection.status === "offline";
  const machineId = routeMachineId(route);
  const landedRef = useRef(false);

  const scopedConversations = useMemo(() => {
    const scopedAgentIds = machineScopedAgentIds(agents, machineId);
    return [...filterSessionsByMachineScope(sessions, scopedAgentIds, machineId)]
      .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));
  }, [sessions, agents, machineId]);

  const landingTarget = useMemo(() => {
    const participant = scopedConversations.filter((s) => !isObservedDirect(s));
    const unseenNeedsYou = participant.find((s) => {
      if (!s.agentId) return false;
      const ask = asksByAgent.get(s.agentId);
      return ask?.status === "needs_attention" && isUnread(s.lastMessageAt, s.id, lastViewed);
    });
    return unseenNeedsYou ?? participant[0];
  }, [scopedConversations, asksByAgent, lastViewed]);

  useEffect(() => {
    if (landedRef.current) return;
    if (loading || loadError || apiOffline) return;
    if (!landingTarget) return;
    landedRef.current = true;
    saveLastViewed(landingTarget.id);
    navigate(
      {
        view: "messages",
        conversationId: landingTarget.id,
        ...(machineId ? { machineId } : {}),
      },
      { replace: true },
    );
  }, [landingTarget, loading, loadError, apiOffline, machineId, navigate]);

  const landingPending = !apiOffline && !loadError && (loading || Boolean(landingTarget));

  return (
    <div className={`s-conv-empty${apiOffline ? " s-conv-empty--offline" : ""}`}>
      <div className="s-conv-empty-inner">
        <EmptyMesh />
        <div className="s-conv-empty-eyebrow">
          {apiOffline ? "Connection" : "Conversations"}
        </div>
        <p className="s-conv-empty-title">
          {apiOffline
            ? "Scout server offline"
            : landingPending
              ? "Opening your latest conversation"
              : loadError
                ? "Chats unavailable"
                : "Nothing open yet"}
        </p>
        <p className="s-conv-empty-detail">
          {apiOffline
            ? "Start or restart Scout services. Chats and context will appear when the server responds."
            : landingPending
              ? conversationLandingDetail(landingTarget)
              : loadError
                ? loadError
                : "Start a chat by choosing an agent and sending the first message."}
        </p>

        {apiOffline || loadError ? (
          <button
            type="button"
            className="s-conv-empty-action"
            onClick={() => {
              void reload();
            }}
          >
            Retry connection
          </button>
        ) : !landingPending ? (
          <button
            type="button"
            className="s-conv-empty-new"
            onClick={() => openContextCapture()}
          >
            <Plus size={16} aria-hidden="true" />
            New chat
          </button>
        ) : null}

        <div className="s-conv-empty-ambient">
          <span className="s-conv-empty-ambient-dot" aria-hidden="true" />
          {apiOffline
            ? "waiting for server"
            : `${onlineCount} ${onlineCount === 1 ? "agent" : "agents"} active`}
        </div>
      </div>
    </div>
  );
}

function conversationLandingDetail(target: SessionEntry | undefined): string {
  if (!target) return "Finding where you left off.";
  return conversationDisplayTitle(target);
}

/** Quiet constellation echo of the brand mesh motif — six nodes, thin links,
 *  one node lit in the single accent. Decorative only. */
function EmptyMesh() {
  return (
    <svg
      className="s-conv-empty-mesh"
      viewBox="0 0 72 72"
      fill="none"
      aria-hidden="true"
    >
      <line className="s-conv-empty-mesh-link" x1="14" y1="20" x2="36" y2="12" />
      <line className="s-conv-empty-mesh-link" x1="36" y1="12" x2="58" y2="24" />
      <line className="s-conv-empty-mesh-link" x1="14" y1="20" x2="24" y2="46" />
      <line className="s-conv-empty-mesh-link" x1="24" y1="46" x2="36" y2="12" />
      <line className="s-conv-empty-mesh-link" x1="24" y1="46" x2="50" y2="54" />
      <line className="s-conv-empty-mesh-link" x1="50" y1="54" x2="58" y2="24" />
      <line className="s-conv-empty-mesh-link" x1="36" y1="12" x2="50" y2="54" />
      <circle className="s-conv-empty-mesh-node" cx="14" cy="20" r="2.5" />
      <circle className="s-conv-empty-mesh-node" cx="58" cy="24" r="2.5" />
      <circle className="s-conv-empty-mesh-node" cx="24" cy="46" r="2.5" />
      <circle className="s-conv-empty-mesh-node" cx="50" cy="54" r="2.5" />
      <circle
        className="s-conv-empty-mesh-node s-conv-empty-mesh-node--accent"
        cx="36"
        cy="12"
        r="3.5"
      />
    </svg>
  );
}
