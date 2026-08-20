import "./agent-live-actions.css";

import { Eye, Terminal } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { normalizeAgentState, isAgentCallable, isAgentInTurn } from "../lib/agent-state.ts";
import { api } from "../lib/api.ts";
import { queueTakeover } from "../lib/terminal-takeover.ts";
import { timeAgo } from "../lib/time.ts";
import type { Agent, Route, SessionCatalogWithResume } from "../lib/types.ts";
import { useScout } from "../scout/Provider.tsx";
import { openContent } from "../scout/slots/openContent.ts";

type AgentLiveActionsVariant = "default" | "compact" | "inline";

type AgentLiveActionsProps = {
  agent: Agent;
  catalog?: SessionCatalogWithResume | null;
  navigate?: (route: Route) => void;
  returnTo?: Route;
  variant?: AgentLiveActionsVariant;
  className?: string;
  onNavigate?: () => void;
};

function shortSession(value: string | null): string | null {
  if (!value) return null;
  return value.length > 18 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value;
}

export function AgentLiveActions({
  agent,
  catalog,
  navigate,
  returnTo,
  variant = "default",
  className,
  onNavigate,
}: AgentLiveActionsProps) {
  const scout = useScout();
  const [loadedCatalog, setLoadedCatalog] = useState<SessionCatalogWithResume | null>(null);
  const [takeoverSent, setTakeoverSent] = useState(false);
  const resolvedNavigate = navigate ?? scout.navigate;
  const resolvedReturnTo = returnTo ?? scout.route;

  useEffect(() => {
    setTakeoverSent(false);
  }, [agent.id]);

  useEffect(() => {
    if (catalog !== undefined) {
      setLoadedCatalog(null);
      return;
    }
    let cancelled = false;
    api<SessionCatalogWithResume>(`/api/agents/${encodeURIComponent(agent.id)}/session-catalog`)
      .then((result) => {
        if (!cancelled) setLoadedCatalog(result);
      })
      .catch(() => {
        if (!cancelled) setLoadedCatalog(null);
      });
    return () => {
      cancelled = true;
    };
  }, [agent.id, catalog]);

  const resolvedCatalog = catalog === undefined ? loadedCatalog : catalog;
  const terminalSurface = agent.terminalSurface
    ?? (agent.transport === "tmux" && agent.harnessSessionId
      ? {
          backend: "tmux" as const,
          sessionName: agent.harnessSessionId,
          paneId: null,
          socketDir: null,
        }
      : null);
  const activeSessionId = resolvedCatalog?.activeSessionId
    ?? (terminalSurface ? agent.harnessSessionId ?? terminalSurface.sessionName : null);
  const activeSession = useMemo(
    () => resolvedCatalog?.sessions.find((session) => session.id === activeSessionId) ?? null,
    [activeSessionId, resolvedCatalog?.sessions],
  );
  const state = normalizeAgentState(agent.state);
  const canObserveTerminal = Boolean(terminalSurface && activeSessionId);
  const canTakeover = canObserveTerminal || Boolean(resolvedCatalog?.resumeCommand);
  const hasLiveTurn = isAgentInTurn(agent.state, agent);
  const isCompact = variant === "compact";
  const status = hasLiveTurn
    ? activeSessionId
      ? isCompact
        ? canObserveTerminal ? "Live terminal" : "Live trace"
        : `Live ${shortSession(activeSessionId)}`
      : "Working"
    : activeSessionId
      ? isCompact
        ? canObserveTerminal ? "Terminal" : "Trace"
        : `${canObserveTerminal ? "Terminal" : "Trace"} ${shortSession(activeSessionId)}`
    : isAgentCallable(agent.state, agent)
      ? "Callable"
      : "No live turn";
  const statusDetail = activeSession?.startedAt
    ? timeAgo(activeSession.startedAt)
    : agent.updatedAt
      ? timeAgo(agent.updatedAt)
      : null;
  const observeLabel = canObserveTerminal
    ? isCompact ? "Observe" : "Observe terminal"
    : isCompact ? "Trace" : "Observe trace";
  const observeTitle = canObserveTerminal
    ? "Observe the live terminal"
    : "Open the web observe trace";

  const openTerminal = (mode: "observe" | "takeover") => {
    onNavigate?.();
    openContent(
      resolvedNavigate,
      { view: "terminal", agentId: agent.id, mode },
      { returnTo: resolvedReturnTo },
    );
  };

  const openTrace = () => {
    onNavigate?.();
    openContent(
      resolvedNavigate,
      { view: "agents-v2", agentId: agent.id, tab: "observe" },
      { returnTo: resolvedReturnTo },
    );
  };

  const runTakeover = () => {
    if (canObserveTerminal) {
      openTerminal("takeover");
      return;
    }
    const command = resolvedCatalog?.resumeCommand;
    if (!command) return;
    setTakeoverSent(true);
    void queueTakeover({
      command,
      cwd: resolvedCatalog?.resumeCwd,
      agentId: agent.id,
    }).then(() => openTerminal("takeover"));
  };

  const rootClass = [
    "agent-live-actions",
    `agent-live-actions--${variant}`,
    hasLiveTurn ? "agent-live-actions--live" : "",
    className ?? "",
  ].filter(Boolean).join(" ");

  return (
    <div className={rootClass}>
      <div className="agent-live-actions-status">
        <span className="agent-live-actions-dot" />
        <span className="agent-live-actions-status-main">{status}</span>
        {statusDetail && (
          <span className="agent-live-actions-status-detail">{statusDetail}</span>
        )}
      </div>
      <div className="agent-live-actions-buttons">
        <button
          type="button"
          className="agent-live-actions-button agent-live-actions-button--primary"
          onClick={() => canObserveTerminal ? openTerminal("observe") : openTrace()}
          title={observeTitle}
          aria-label={observeTitle}
        >
          <Eye size={13} strokeWidth={1.9} aria-hidden="true" />
          <span>{observeLabel}</span>
        </button>
        {canObserveTerminal && (
          <button
            type="button"
            className="agent-live-actions-button"
            onClick={openTrace}
            title="Open the web observe trace"
          >
            <span>Trace</span>
          </button>
        )}
        {canTakeover && (
          <button
            type="button"
            className="agent-live-actions-button"
            onClick={runTakeover}
            title={resolvedCatalog?.resumeCommand ?? "Open interactive terminal takeover"}
          >
            <Terminal size={13} strokeWidth={1.9} aria-hidden="true" />
            <span>{takeoverSent ? "Going..." : "Takeover"}</span>
          </button>
        )}
      </div>
    </div>
  );
}
