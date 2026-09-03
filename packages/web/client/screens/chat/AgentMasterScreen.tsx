import { useMemo } from "react";
import { ArrowUpRight, X } from "lucide-react";

import { AgentAvatar } from "../../components/AgentAvatar.tsx";
import { HarnessMark } from "../../components/HarnessMark.tsx";
import {
  bestFleetAskForAgentIds,
  fleetAskForSession,
  type FleetActiveAskIndex,
} from "../../lib/fleet-active-asks.ts";
import {
  NO_PROJECT_LABEL,
  projectLabelForAgent,
  taskThreadTitle,
} from "../../lib/sessions-view.ts";
import { timeAgo } from "../../lib/time.ts";
import type { FleetAsk, Route, SessionEntry } from "../../lib/types.ts";
import { useConversationList } from "../../lib/use-conversation-list.ts";
import { useFleetActiveAsks } from "../../lib/use-fleet-active-asks.ts";
import { useScout } from "../../scout/Provider.tsx";
import { ConversationScreen } from "./ConversationScreen.tsx";
import { buildAgentMasterModel } from "./agent-master-model.ts";
import "./agent-master.css";

/**
 * Agent master view — ONE relationship surface per agent: the agent's DM as
 * the center feed, with the agent's other task conversations as a thread
 * strip. Raising a thread opens it in a side panel WITHOUT leaving the DM
 * (Slack's one-big-DM-with-threads model). Route: /messages/agent/<id>?thread=.
 */
export function AgentMasterScreen({
  agentId,
  threadId,
  machineId,
  navigate,
}: {
  agentId: string;
  threadId?: string;
  machineId?: string;
  navigate: (r: Route) => void;
}) {
  const { agents } = useScout();
  const { sessions, loading } = useConversationList();
  const activeAsks = useFleetActiveAsks();
  const {
    agent,
    memberAgentIds,
    sessions: agentSessions,
    master,
    threads,
    thread,
  } = useMemo(
    () => buildAgentMasterModel({ agentId, threadId, machineId, agents, sessions }),
    [agentId, threadId, machineId, agents, sessions],
  );

  const ask = useMemo(
    () => bestFleetAskForAgentIds(activeAsks, memberAgentIds),
    [activeAsks, memberAgentIds],
  );

  const scopedAgentRoute = (
    nextThreadId?: string,
  ): Extract<Route, { view: "messages" }> => ({
    view: "messages",
    agentId,
    ...(nextThreadId ? { threadId: nextThreadId } : {}),
    ...(machineId ? { machineId } : {}),
  });
  const scopedConversationRoute = (
    conversationId: string,
  ): Extract<Route, { view: "messages" }> => ({
    view: "messages",
    conversationId,
    ...(machineId ? { machineId } : {}),
  });

  const name = agent?.name
    ?? agentSessions[0]?.agentName
    ?? agentId.split(".")[0]
    ?? agentId;
  const projectLabel = (() => {
    const label = projectLabelForAgent(agent);
    return label === NO_PROJECT_LABEL ? null : label;
  })();
  const activity = askActivity(ask);
  const sub = [projectLabel, activity?.label ?? agent?.branch ?? null]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="amv">
      <section className="amv-main">
        <header className="amv-head">
          <AgentAvatar
            agent={agent ?? { name, harness: master?.harness ?? null, state: null }}
            placement="row"
            size={32}
          />
          <div className="amv-ident">
            <span className="amv-name">{name}</span>
            {sub ? (
              <span className="amv-sub">
                {activity ? <span className="amv-dot" data-tone={activity.tone} aria-hidden /> : null}
                {sub}
              </span>
            ) : null}
          </div>
          {(agent?.harness ?? master?.harness) ? (
            <HarnessMark harness={agent?.harness ?? master?.harness ?? ""} size={14} />
          ) : null}
        </header>

        {threads.length > 0 ? (
          <div className="amv-strip" role="list" aria-label="Session threads">
            {threads.map((s) => {
              const on = s.id === thread?.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  role="listitem"
                  className={`amv-card${on ? " amv-card--on" : ""}`}
                  onClick={() => navigate(on ? scopedAgentRoute() : scopedAgentRoute(s.id))}
                >
                  <span
                    className="amv-mark"
                    data-state={cardMarkState(s, activeAsks)}
                    aria-hidden
                  />
                  <span className="amv-cardTitle">{taskThreadTitle(s)}</span>
                  <span className="amv-cardMeta">
                    {s.lastMessageAt ? timeAgo(s.lastMessageAt) : "—"}
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}

        <div className="amv-feed">
          {master ? (
            <ConversationScreen
              key={master.id}
              conversationId={master.id}
              navigate={navigate}
              embedded
              showBackNav={false}
            />
          ) : (
            <div className="amv-empty">
              {loading ? "Loading conversations…" : `No conversations with ${name} yet.`}
            </div>
          )}
        </div>
      </section>

      {thread ? (
        <aside className="amv-thread" aria-label="Thread">
          <header className="amv-threadHead">
            <div className="amv-threadIdent">
              <span className="amv-threadKicker">Thread</span>
              <span className="amv-threadTitle" title={taskThreadTitle(thread)}>
                {taskThreadTitle(thread)}
              </span>
            </div>
            <button
              type="button"
              className="amv-threadBtn"
              title="Open as full conversation"
              aria-label="Open as full conversation"
              onClick={() => navigate(scopedConversationRoute(thread.id))}
            >
              <ArrowUpRight size={14} strokeWidth={2} aria-hidden />
            </button>
            <button
              type="button"
              className="amv-threadBtn"
              title="Close thread"
              aria-label="Close thread"
              onClick={() => navigate(scopedAgentRoute())}
            >
              <X size={14} strokeWidth={2} aria-hidden />
            </button>
          </header>
          <div className="amv-threadBody">
            <ConversationScreen
              key={thread.id}
              conversationId={thread.id}
              navigate={navigate}
              embedded
              showBackNav={false}
            />
          </div>
        </aside>
      ) : null}
    </div>
  );
}

function askActivity(
  ask: FleetAsk | undefined,
): { label: string; tone: "working" | "attention" | "pending" } | null {
  if (!ask) return null;
  if (ask.status === "working") return { label: "working", tone: "working" };
  if (ask.status === "needs_attention") return { label: "needs you", tone: "attention" };
  if (ask.status === "queued") return { label: "starting", tone: "pending" };
  return null;
}

function askMarkState(ask: FleetAsk): "working" | "needs_you" | "quiet" {
  if (ask.status === "needs_attention") return "needs_you";
  if (ask.status === "working" || ask.status === "queued") return "working";
  return "quiet";
}

function cardMarkState(
  s: SessionEntry,
  activeAsks: FleetActiveAskIndex,
): "working" | "needs_you" | "quiet" {
  const cardAsk = fleetAskForSession(activeAsks, s);
  if (!cardAsk) return "quiet";
  return askMarkState(cardAsk);
}
