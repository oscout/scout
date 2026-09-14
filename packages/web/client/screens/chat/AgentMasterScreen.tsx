import { useEffect, useMemo, useRef, useState } from "react";
import { PanelRight } from "lucide-react";

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
import { useAgentFlowMessages } from "../../lib/use-agent-flow.ts";
import { useConversationList } from "../../lib/use-conversation-list.ts";
import { useFleetActiveAsks } from "../../lib/use-fleet-active-asks.ts";
import { useBrowserLocation } from "../../lib/router.ts";
import { useScout } from "../../scout/Provider.tsx";
import { CommsFlowView } from "./CommsFlowGraph.tsx";
import { mapIdentities } from "./CommsFlowMap.tsx";
import { flowTasks } from "./comms-flow-map.ts";
import { press } from "./comms-gesture.ts";
import type { DeckCard } from "./comms-deck.ts";
import { useBeside, useStage } from "./use-beside.ts";
import { buildCommsFlow, flowCanonicalId, type FlowSourceMessage } from "../../lib/comms-flow.ts";
import { ConversationScreen } from "./ConversationScreen.tsx";
import { buildAgentMasterModel, sessionMatchesConversationId } from "./agent-master-model.ts";
import "./agent-master.css";

type AgentView = "chat" | "flow" | "map" | "canvas";

const AGENT_VIEWS: { id: AgentView; label: string; hint: string }[] = [
  { id: "chat", label: "Chat", hint: "The conversation on the stage" },
  { id: "flow", label: "Flow", hint: "Who asked whom across everything this agent is in" },
  { id: "map", label: "Map", hint: "Who this agent exchanges work with, and on which model" },
  { id: "canvas", label: "Canvas", hint: "The same window laid out left to right, with nobody folded away" },
];

/**
 * The agent's neighbourhood as a flow: every conversation it is mixed up in.
 */
function useAgentFlow(agentId: string, enabled: boolean) {
  const { messages, loading, error } = useAgentFlowMessages(agentId, enabled);
  const { passes, flights } = useMemo(() => {
    const source: FlowSourceMessage[] = messages
      // A message with no actor has no sender to draw it from.
      .filter((message): message is typeof message & { actorId: string } => Boolean(message.actorId))
      .map((message) => ({
        id: message.id,
        conversationId: message.conversationId,
        actorId: message.actorId,
        actorName: message.actorName,
        body: message.body,
        createdAt: message.createdAt,
        class: message.class,
        metadata: message.metadata ?? null,
        replyToMessageId: message.replyToMessageId ?? null,
      }));
    return buildCommsFlow(source);
  }, [messages]);
  const tasks = useMemo(() => flowTasks(passes, flights), [passes, flights]);
  return { passes, flights, tasks, loading, error, count: messages.length };
}

/**
 * Agent surface — ONE relationship surface per agent, with one stage.
 *
 * The stage is the conversation the route names: the agent's own conversation
 * by default, or the thread `?thread=` asks for. The strip above it lists the
 * agent's conversations; clicking one puts it on the stage, and nothing else.
 * Flow, Map and Canvas draw the agent's whole neighbourhood in place of the
 * stage, and a click inside a drawing selects — one thing, shown in a panel
 * docked to the drawing — rather than opening anything.
 *
 * Keeping a conversation beside the stage is a separate, deliberate act: the
 * beside glyph on a strip card, or a double click on it. Those columns are the
 * Comms page's, not this surface's (MessagesScreen draws them), so they stay
 * put when the stage changes to another agent.
 *
 * Route: /messages/agent/<id>?thread=.
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
  const location = useBrowserLocation();
  const beside = useBeside();
  const toStage = useStage(navigate, machineId);
  // Which drawing is on screen, seeded from the URL so a Map can be linked to.
  const [view, setView] = useState<AgentView>(() => {
    if (typeof window === "undefined") return "chat";
    const asked = new URLSearchParams(window.location.search).get("view");
    return asked === "flow" || asked === "map" || asked === "canvas" ? asked : "chat";
  });
  // The one thing selected in the drawing. Local to this surface and to the
  // drawing: it is what you are looking at, not where you are.
  const [selected, setSelected] = useState<DeckCard | null>(null);

  // Navigation lands on the conversation. When the route brings a different
  // stage — another agent, another thread — the drawing gives way to Chat and
  // the selection is dropped; a drawing is something you switch to from there.
  // A link straight to a drawing still opens on it, since that is the first
  // stage, not a change of stage.
  const stageKey = `${agentId}\u0000${threadId ?? ""}`;
  const lastStage = useRef(stageKey);
  useEffect(() => {
    if (lastStage.current === stageKey) return;
    lastStage.current = stageKey;
    setView("chat");
    setSelected(null);
  }, [stageKey]);
  // Another drawing is another set of things to click.
  useEffect(() => setSelected(null), [view]);

  // `view` is route-local view state: it says what you are looking at, not
  // which page you are on. So it rides the URL by replaceState — never pushing
  // a history entry — rather than living in the Route.
  //
  // The router owns the canonical URL and strips params it does not know, so
  // this watches the location as well as the state and puts it back. A bare
  // replaceState does not go through the location store, so restoring it
  // cannot re-trigger this; only a real navigation can.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const want = view === "chat" ? "" : view;
    if ((url.searchParams.get("view") ?? "") === want) return;
    if (want) url.searchParams.set("view", want);
    else url.searchParams.delete("view");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, [view, location.searchStr]);

  const { sessions, loading } = useConversationList();
  const activeAsks = useFleetActiveAsks();
  const {
    agent,
    memberAgentIds,
    sessions: agentSessions,
    master,
    threads,
  } = useMemo(
    () => buildAgentMasterModel({ agentId, threadId, machineId, agents, sessions }),
    [agentId, threadId, machineId, agents, sessions],
  );

  const ask = useMemo(
    () => bestFleetAskForAgentIds(activeAsks, memberAgentIds),
    [activeAsks, memberAgentIds],
  );

  // The drawings read the agent's window; the stage does not need it.
  const flow = useAgentFlow(agentId, view !== "chat");
  const identities = useMemo(
    () => mapIdentities(agentSessions.flatMap((entry) => entry.participants ?? [])),
    [agentSessions],
  );

  // What is on the stage: the thread the route asks for, else the agent's own
  // conversation. The strip lists both, the agent's own first.
  const stageId = threadId ?? master?.id ?? null;
  const strip = useMemo(
    () => (master ? [master, ...threads] : threads),
    [master, threads],
  );
  const onStage = (s: SessionEntry) => Boolean(stageId) && sessionMatchesConversationId(s, stageId!);

  const stage = (s: SessionEntry) => {
    navigate({
      view: "messages",
      agentId,
      // The agent's own conversation is the stage's default, so it needs no
      // thread parameter — and the URL stays the one the rail links to.
      ...(master && s.id === master.id ? {} : { threadId: s.id }),
      ...(machineId ? { machineId } : {}),
    });
  };

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
    <>
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
        <div className="s-thread-view-toggle" role="group" aria-label="View">
          {AGENT_VIEWS.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`s-thread-view-option${view === option.id ? " is-active" : ""}`}
              onClick={() => setView(option.id)}
              aria-pressed={view === option.id}
              title={option.hint}
            >
              {option.label}
            </button>
          ))}
        </div>
      </header>

      {strip.length > 0 ? (
        <div className="amv-strip" role="list" aria-label="Conversations">
          {strip.map((s) => {
            const on = onStage(s);
            const kept = beside.has(s.id);
            return (
              <div
                key={s.id}
                role="listitem"
                className={`amv-card${on ? " amv-card--on" : ""}${kept ? " amv-card--kept" : ""}`}
              >
                <button
                  type="button"
                  className="amv-cardMain"
                  title={on ? "On the stage" : "Open on the stage · double-click to keep beside"}
                  aria-current={on ? "true" : undefined}
                  {...press(() => {
                    setView("chat");
                    stage(s);
                  }, () => beside.add(s.id))}
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
                <button
                  type="button"
                  className="amv-cardBeside"
                  title={kept ? "Close the column beside the stage" : "Keep beside the stage"}
                  aria-label={kept ? "Close beside" : "Keep beside"}
                  aria-pressed={kept}
                  onClick={() => beside.toggle(s.id)}
                >
                  <PanelRight size={12} strokeWidth={2} aria-hidden />
                </button>
              </div>
            );
          })}
        </div>
      ) : null}

      <div className="amv-feed">
        {view !== "chat" ? (
          flow.error ? (
            <div className="amv-empty">{flow.error}</div>
          ) : flow.loading && flow.count === 0 ? (
            <div className="amv-empty">Loading this agent&rsquo;s work…</div>
          ) : flow.count === 0 ? (
            <div className="amv-empty">Nothing has passed through this agent yet.</div>
          ) : (
            <CommsFlowView
              passes={flow.passes}
              flights={flow.flights}
              rootId={flowCanonicalId(agentId)}
              identities={identities}
              view={view}
              selected={selected}
              onSelect={setSelected}
              onStage={(conversationId) => {
                // Even when it is the conversation already on the stage: the
                // ask was to see it, and the drawing is in the way.
                setView("chat");
                toStage(conversationId);
              }}
              beside={beside}
            />
          )
        ) : stageId ? (
          <ConversationScreen
            key={stageId}
            conversationId={stageId}
            navigate={navigate}
            embedded
            showBackNav={false}
            beside={beside}
          />
        ) : (
          <div className="amv-empty">
            {loading ? "Loading conversations…" : `No conversations with ${name} yet.`}
          </div>
        )}
      </div>
    </>
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
