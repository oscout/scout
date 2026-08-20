import { useCallback, useEffect, useMemo, useState } from "react";
import { agentStateLabel, isAgentOnline } from "../../lib/agent-state.ts";
import { api } from "../../lib/api.ts";
import { useBrokerEvents } from "../../lib/sse.ts";
import { timeAgo } from "../../lib/time.ts";
import { openContent } from "../../scout/slots/openContent.ts";
import { AgentAvatar } from "../../components/AgentAvatar.tsx";
import { HarnessMark } from "../../components/HarnessMark.tsx";
import type {
  Agent,
  AgentObservePayload,
  ObserveEvent,
  Route,
  SessionCatalogWithResume,
} from "../../lib/types.ts";
import { newSessionPayloadForAgent, type SessionInitiationResult } from "../agents/model.ts";
import { harnessOf } from "./model.ts";

function shortCwd(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  return cwd.startsWith("/Users/")
    ? `~/${cwd.split("/").slice(3).join("/")}`
    : cwd;
}

function shortModel(agent: Agent): string | null {
  const model = agent.model?.trim();
  if (!model) return null;
  const harness = agent.harness?.trim();
  if (harness && model.startsWith(`${harness}-`)) {
    return model.slice(harness.length + 1).replace(/-\d{8}$/, "");
  }
  return model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

function toolNames(events: ObserveEvent[]): string[] {
  const counts = new Map<string, number>();
  for (const event of events) {
    if (event.kind !== "tool" || !event.tool) continue;
    const name = event.tool.toLowerCase();
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name]) => name)
    .slice(0, 6);
}

function MetaItem({ label, value, title }: { label: string; value: string | null | undefined; title?: string }) {
  if (!value?.trim()) return null;
  return (
    <div className="av2-coreMetaItem" title={title ?? value}>
      <span className="av2-coreMetaLabel">{label}</span>
      <span className="av2-coreMetaValue">{value}</span>
    </div>
  );
}

export function ProjectAgentProfileHero({
  agent,
  route,
  navigate,
}: {
  agent: Agent;
  route: Extract<Route, { view: "agents-v2" }>;
  navigate: (route: Route) => void;
}) {
  const [observe, setObserve] = useState<AgentObservePayload | null>(null);
  const [catalog, setCatalog] = useState<SessionCatalogWithResume | null>(null);

  const load = useCallback(async () => {
    const [obs, cat] = await Promise.all([
      api<AgentObservePayload>(`/api/agents/${encodeURIComponent(agent.id)}/observe`).catch(() => null),
      api<SessionCatalogWithResume>(`/api/agents/${encodeURIComponent(agent.id)}/session-catalog`).catch(
        () => null,
      ),
    ]);
    setObserve(obs);
    setCatalog(cat);
  }, [agent.id]);

  useEffect(() => {
    setObserve(null);
    setCatalog(null);
    void load();
  }, [load]);
  useBrokerEvents(() => {
    void load();
  });

  const handle = agent.handle?.trim().replace(/^@+/, "") || null;
  const title = handle ? `@${handle}` : agent.name;
  const harness = agent.harness ? harnessOf(agent.harness) : null;
  const model = shortModel(agent);
  const cwd = shortCwd(agent.cwd ?? agent.projectRoot);
  const host = (agent.homeNodeName ?? agent.authorityNodeName ?? "")
    .replace(/\.local$/i, "")
    .replace(/-local-openscout$/i, "");
  const online = isAgentOnline(agent.state);
  const state = agentStateLabel(agent.state, agent);

  const events = observe?.data.events ?? [];
  const tools = useMemo(() => toolNames(events), [events]);
  const usage = observe?.data.metadata?.usage ?? null;
  const ctxPct = (() => {
    const win = usage?.contextWindowTokens ?? 0;
    const used = usage?.contextInputTokens ?? 0;
    if (!win || win <= 0 || used <= 0) return null;
    return Math.min(100, Math.max(0, Math.round((used / win) * 100)));
  })();
  const sessionCount = catalog?.sessions?.length ?? 0;
  const transport =
    agent.transport === "claude_stream_json"
      ? "stream-json"
      : agent.transport === "codex_app_server"
        ? "app-server"
        : agent.transport?.trim() || null;

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
      navigate({
        ...route,
        view: "agents-v2",
        agentId: result.agentId?.trim() || agent.id,
        ...(cid ? { conversationId: cid } : {}),
        tab: "message",
      });
    } catch {
      /* noop */
    }
  };

  return (
    <header className="av2-profileHero">
      <AgentAvatar agent={agent} size={56} tile presence />
      <div className="av2-profileHeroCore">
        <div className="av2-profileHeroTop">
          <div className="av2-profileHeroIdent">
            <h1 className="av2-profileHeroTitle" title={title}>
              {title}
            </h1>
            <span className="av2-profileHeroState" data-online={online || undefined}>
              <span className="av2-profileHeroDot" aria-hidden />
              {state}
              {agent.updatedAt ? ` · ${timeAgo(agent.updatedAt)}` : ""}
            </span>
            {handle && agent.name.toLowerCase() !== handle.toLowerCase() ? (
              <span className="av2-profileHeroBroker" title={agent.id}>
                {agent.name}
              </span>
            ) : (
              <span className="av2-profileHeroBroker" title={agent.id}>
                {agent.id}
              </span>
            )}
          </div>
          <div className="av2-profileHeroActions">
            <button
              type="button"
              className="av2-heroGhost"
              onClick={() => navigate({ ...route, view: "agents-v2", agentId: agent.id, tab: "config" })}
            >
              Edit config
            </button>
            <button type="button" className="av2-heroCta" onClick={() => void startNewSession()}>
              ＋ New session
            </button>
          </div>
        </div>

        <div className="av2-profileHeroMeta">
          <MetaItem label="Project" value={agent.project ? `/${agent.project}` : null} />
          <MetaItem label="Branch" value={agent.branch} />
          <MetaItem
            label="Harness"
            value={harness ? harness.charAt(0).toUpperCase() + harness.slice(1) : null}
            title={agent.harness ?? undefined}
          />
          <MetaItem label="Model" value={model} />
          <MetaItem label="Host" value={host || null} />
          <MetaItem label="Root" value={cwd} title={agent.cwd ?? agent.projectRoot ?? undefined} />
          <MetaItem label="Transport" value={transport} />
        </div>

        <div className="av2-profileHeroSignal">
          {harness ? (
            <span className="av2-signalMark" title={agent.harness ?? harness}>
              <HarnessMark harness={harness} size={12} />
            </span>
          ) : null}
          <span className="av2-signalChip">
            <span className="av2-signalLabel">Sessions</span>
            <span className="av2-signalValue">{sessionCount}</span>
          </span>
          {ctxPct != null ? (
            <span className="av2-signalChip">
              <span className="av2-signalLabel">Ctx</span>
              <span className="av2-signalValue">{ctxPct}%</span>
            </span>
          ) : null}
          {tools.length > 0 ? (
            <span className="av2-signalChip av2-signalChip--wide" title={tools.join(" · ")}>
              <span className="av2-signalLabel">Tools</span>
              <span className="av2-signalValue">{tools.join(" · ")}</span>
            </span>
          ) : observe ? (
            <span className="av2-signalChip">
              <span className="av2-signalLabel">Tools</span>
              <span className="av2-signalValue">—</span>
            </span>
          ) : null}
        </div>
      </div>
    </header>
  );
}
