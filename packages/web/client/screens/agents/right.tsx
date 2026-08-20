import { useCallback, useEffect, useMemo, useState } from "react";
import { useScout } from "../../scout/Provider.tsx";
import { openAgent } from "../../scout/slots/openAgent.ts";
import { openContent } from "../../scout/slots/openContent.ts";
import { agentStateLabel, isAgentOnline, normalizeAgentState, isAgentBusy } from "../../lib/agent-state.ts";
import { actorColor, stateColor } from "../../lib/colors.ts";
import { compareTimestampsDesc, timeAgo } from "../../lib/time.ts";
import { formatLabel } from "../../lib/text.ts";
import { api } from "../../lib/api.ts";
import { useBrokerEvents } from "../../lib/sse.ts";
import { resolveAgentTerminalSurface } from "../../lib/terminal-relay.ts";
import { queueTakeover } from "../../lib/terminal-takeover.ts";
import {
  resolveActiveSessionId,
  resolveRoutedSessionId,
  resolveSelectedSessionId,
  sessionEngage,
  sortSessionsByRecency,
} from "../../lib/session-catalog.ts";
import { pathLeaf } from "./model.ts";
import { useContextMenu, type MenuItem } from "../../components/ContextMenu.tsx";
import { AgentAvatar } from "../../components/AgentAvatar.tsx";
import { AgentLiveActions } from "../../components/AgentLiveActions.tsx";
import { TmuxPeekPanel } from "../../scout/inspector/TmuxPeek.tsx";
import type {
  Agent,
  AgentObservePayload,
  FleetAsk,
  FleetState,
  ObserveData,
  Route,
  SessionCatalogEntry,
  SessionCatalogWithResume,
  SessionEntry,
} from "../../lib/types.ts";

const GROUPED_NUMBER_FORMAT = new Intl.NumberFormat("en-US");
const COMPACT_NUMBER_FORMAT = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

function fmtCompactNumber(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }
  if (Math.abs(value) < 1_000) {
    return GROUPED_NUMBER_FORMAT.format(value);
  }

  return COMPACT_NUMBER_FORMAT.format(value).toLowerCase();
}

function fmtWindowSpan(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "0s";
  }
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }

  const wholeSeconds = Math.round(seconds);
  const hours = Math.floor(wholeSeconds / 3_600);
  const minutes = Math.floor((wholeSeconds % 3_600) / 60);
  const remainingSeconds = wholeSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes >= 10 || remainingSeconds === 0) {
    return `${minutes}m`;
  }
  return `${minutes}m ${remainingSeconds}s`;
}

function shortHostLabel(value: string): string {
  return value.replace(/\.local$/i, "").replace(/-local-openscout$/i, "");
}

function agentProjectLabel(agent: Agent): string {
  return agent.project?.trim()
    || (agent.projectRoot ? pathLeaf(agent.projectRoot) : null)
    || (agent.cwd ? pathLeaf(agent.cwd) : null)
    || "unassigned";
}

function protocolLabel(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized) {
    return null;
  }
  return normalized.toLowerCase() === "a2a" ? "A2A" : normalized;
}

function transportDisplayLabel(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized) {
    return null;
  }
  if (normalized === "claude_stream_json") {
    return "Claude stream-json worker";
  }
  if (normalized === "codex_app_server") {
    return "Codex app server";
  }
  if (normalized === "pi_rpc") {
    return "Pi RPC";
  }
  if (normalized === "tmux") {
    return "tmux terminal";
  }
  return normalized;
}

function hasExternalCardIdentity(agent: Agent): boolean {
  return Boolean(agent.providerName || protocolLabel(agent.protocol) || (agent.skills?.length ?? 0) > 0);
}

function agentHarnessLabel(agent: Agent): string {
  return protocolLabel(agent.protocol)
    || (agent.transport === "claude_stream_json" ? "Claude stream-json worker" : null)
    || agent.harness?.trim()
    || transportDisplayLabel(agent.transport)
    || agent.agentClass?.trim()
    || "unknown";
}

function topCounts(values: string[], limit = 4): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const label = value.trim() || "unknown";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
    .slice(0, limit);
}

async function revealLocalPath(input: {
  path: string;
  basePath?: string | null;
  agentId: string;
  sessionId?: string | null;
}) {
  await api<{ ok: true; path: string }>("/api/local-path/reveal", {
    method: "POST",
    body: JSON.stringify({
      path: input.path,
      agentId: input.agentId,
      ...(input.basePath ? { basePath: input.basePath } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    }),
  });
}

function revealPath(input: {
  path: string;
  basePath?: string | null;
  agentId: string;
  sessionId?: string | null;
}) {
  void revealLocalPath(input).catch((error) => {
    console.warn("Failed to reveal local path", error);
  });
}

export function AgentsInspector() {
  const { route, agents, navigate } = useScout();
  if (route.view === "agent-info") {
    return (
      <AgentInfoRouteInspector
        conversationId={route.conversationId}
        agents={agents}
        navigate={navigate}
        route={route}
      />
    );
  }

  if (route.view === "agents-v2") {
    if (!route.agentId) return null;
    const agent = agents.find((a) => a.id === route.agentId) ?? null;
    if (!agent) return null;
    return (
      <AgentContextPanel
        agent={agent}
        agents={agents}
        navigate={navigate}
        route={route}
        observeMode={route.tab === "observe"}
        showStaticIdentity={false}
      />
    );
  }

  return null;
}

function AgentsDirectoryContextPanel({
  agents,
  navigate,
  route,
}: {
  agents: Agent[];
  navigate: (r: Route) => void;
  route: Route;
}) {
  const working = useMemo(
    () => agents.filter((agent) => isAgentBusy(agent.state)),
    [agents],
  );
  const online = useMemo(
    () => agents.filter((agent) => isAgentOnline(agent.state)),
    [agents],
  );
  const readyCount = Math.max(0, online.length - working.length);
  const projectMix = useMemo(
    () => topCounts(agents.map(agentProjectLabel), 5),
    [agents],
  );
  const harnessMix = useMemo(
    () => topCounts(agents.map(agentHarnessLabel), 5),
    [agents],
  );
  const recentAgents = useMemo(
    () => agents
      .filter((agent) => agent.updatedAt)
      .slice()
      .sort((left, right) => compareTimestampsDesc(left.updatedAt, right.updatedAt))
      .slice(0, 5),
    [agents],
  );
  const activeNow = working.slice(0, 5);
  const projectCount = new Set(agents.map(agentProjectLabel)).size;

  return (
    <div className="flex flex-col h-full overflow-y-auto frame-scrollbar p-4 gap-4 text-sm">
      <Section label="Directory context">
        <StatRow
          stats={[
            { label: "Agents", value: `${agents.length}` },
            { label: "Projects", value: `${projectCount}` },
            { label: "Working", value: `${working.length}` },
          ]}
        />
        <div className="mt-2 font-mono text-2xs uppercase tracking-[0.12em] text-[var(--scout-chrome-ink-ghost)]">
          {readyCount} ready · {projectCount} {projectCount === 1 ? "project" : "projects"}
        </div>
      </Section>

      <Section label="Project mix">
        <PillList items={projectMix} empty="No projects visible" />
      </Section>

      <Section label="Harness mix">
        <PillList items={harnessMix} empty="No harnesses visible" />
      </Section>

      <Section label="Active now">
        {activeNow.length === 0 ? (
          <EmptyLine>No agents currently working.</EmptyLine>
        ) : (
          <div className="flex flex-col gap-0.5">
            {activeNow.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                className="flex w-full items-center gap-2 rounded-[4px] px-1.5 py-[5px] text-left transition-colors hover:bg-[var(--scout-chrome-hover)]"
                onClick={() => openAgent(navigate, candidate, { from: "inspector", returnTo: route })}
              >
                <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: "var(--accent)" }} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm text-[var(--scout-chrome-ink)]">
                      {candidate.name}
                    </span>
                    {candidate.updatedAt && (
                      <span className="shrink-0 font-mono text-2xs text-[var(--scout-chrome-ink-faint)]">
                        {timeAgo(candidate.updatedAt)}
                      </span>
                    )}
                  </div>
                  <div className="truncate font-mono text-2xs text-[var(--scout-chrome-ink-ghost)]">
                    {agentProjectLabel(candidate)} · {agentHarnessLabel(candidate)}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </Section>

      <Section label="Recent">
        {recentAgents.length === 0 ? (
          <EmptyLine>No recent agent activity in this scope.</EmptyLine>
        ) : (
          <div className="flex flex-col gap-0.5">
            {recentAgents.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                className="flex w-full items-center gap-2 rounded-[4px] px-1.5 py-[5px] text-left transition-colors hover:bg-[var(--scout-chrome-hover)]"
                onClick={() => openAgent(navigate, candidate, { from: "inspector", returnTo: route })}
              >
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: isAgentOnline(candidate.state) ? "var(--accent)" : "var(--dim)" }}
                />
                <span className="min-w-0 flex-1 truncate text-sm text-[var(--scout-chrome-ink-soft)]">
                  {candidate.name}
                </span>
                <span className="shrink-0 font-mono text-2xs text-[var(--scout-chrome-ink-faint)]">
                  {candidate.updatedAt ? timeAgo(candidate.updatedAt) : "-"}
                </span>
              </button>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

/* ── Instrument structure kit ──────────────────────────────────────────────
   Flat stat readout · border-only tag distributions · plain empty lines.
   The signed-off vocabulary (studio: scout-inspectors). To be lifted into a
   shared inspector kit as the other inspectors adopt it. */

function StatRow({ stats }: { stats: Array<{ label: string; value: string }> }) {
  return (
    <div className="flex">
      {stats.map((stat, i) => (
        <div
          key={stat.label}
          className="flex min-w-0 flex-1 flex-col gap-1"
          style={i ? { paddingLeft: 11, marginLeft: 11, borderLeft: "1px solid var(--scout-chrome-border-soft)" } : undefined}
        >
          <span className="font-mono text-2xs uppercase tracking-[0.1em] text-[var(--scout-chrome-ink-faint)]">
            {stat.label}
          </span>
          <span className="truncate font-mono text-3xl leading-none text-[var(--scout-chrome-ink-strong)]">
            {stat.value}
          </span>
        </div>
      ))}
    </div>
  );
}

function EmptyLine({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-mono text-xs tracking-[0.02em] text-[var(--scout-chrome-ink-ghost)]">
      {children}
    </div>
  );
}

function PillList({
  items,
  empty,
}: {
  items: Array<{ label: string; count: number }>;
  empty: string;
}) {
  if (items.length === 0) {
    return <EmptyLine>{empty}</EmptyLine>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <span
          key={item.label}
          className="inline-flex items-center gap-1.5 rounded-[3px] border border-[var(--scout-chrome-border-soft)] px-1.5 py-[2.5px] font-mono text-xs text-[var(--scout-chrome-ink-soft)]"
          title={`${item.count} ${item.label}`}
        >
          <span>{item.label}</span>
          <span className="text-[var(--scout-chrome-ink-faint)]">{item.count}</span>
        </span>
      ))}
    </div>
  );
}

function AgentInfoRouteInspector({
  conversationId,
  agents,
  navigate,
  route,
}: {
  conversationId: string;
  agents: Agent[];
  navigate: (r: Route) => void;
  route: Route;
}) {
  const [session, setSession] = useState<SessionEntry | null>(null);
  const [agentDetail, setAgentDetail] = useState<Agent | null>(null);
  const [loaded, setLoaded] = useState(false);

  const loadSession = useCallback(async () => {
    const sessionEntry = await api<SessionEntry>(
      `/api/session/${encodeURIComponent(conversationId)}`,
    ).catch(() => null);
    setSession(sessionEntry);
    setLoaded(true);
  }, [conversationId]);

  useEffect(() => {
    setLoaded(false);
    void loadSession();
  }, [loadSession]);

  useBrokerEvents(() => {
    void loadSession();
  });

  const resolvedAgentId = session?.agentId ?? null;
  useEffect(() => {
    if (!resolvedAgentId || agents.some((candidate) => candidate.id === resolvedAgentId)) {
      setAgentDetail(null);
      return;
    }

    let cancelled = false;
    api<Agent>(`/api/agents/${encodeURIComponent(resolvedAgentId)}`)
      .then((next) => {
        if (!cancelled) setAgentDetail(next);
      })
      .catch(() => {
        if (!cancelled) setAgentDetail(null);
      });

    return () => {
      cancelled = true;
    };
  }, [agents, resolvedAgentId]);

  const agent = useMemo(
    () =>
      resolvedAgentId
        ? agents.find((candidate) => candidate.id === resolvedAgentId) ??
          (agentDetail?.id === resolvedAgentId ? agentDetail : null)
        : null,
    [agentDetail, agents, resolvedAgentId],
  );

  if (!loaded) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-sm italic text-[var(--scout-chrome-ink-faint)]">
        Loading agent context...
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="flex flex-col h-full overflow-y-auto frame-scrollbar p-4 gap-4 text-sm">
        <Row label="Conversation" value={conversationId} />
        <div className="mt-2 text-xs font-mono uppercase tracking-[0.15em] leading-relaxed text-[var(--scout-chrome-ink-ghost)]">
          No live agent registration matches this profile.
        </div>
      </div>
    );
  }

  return (
    <AgentContextPanel
      agent={agent}
      agents={agents}
      navigate={navigate}
      route={route}
      observeMode={false}
    />
  );
}

function AgentContextPanel({
  agent,
  agents,
  navigate,
  route,
  observeMode,
  showStaticIdentity = true,
}: {
  agent: Agent;
  agents: Agent[];
  navigate: (r: Route) => void;
  route: Route;
  observeMode: boolean;
  // When the center profile is on screen it already owns the static facts
  // (state · identity · project). The rail then narrows to a live instrument
  // and hides those blocks to avoid echoing the center.
  showStaticIdentity?: boolean;
}) {
  const online = isAgentOnline(agent.state);
  const [fleet, setFleet] = useState<FleetState | null>(null);
  const [sessionCatalog, setSessionCatalog] = useState<SessionCatalogWithResume | null>(null);
  const [observe, setObserve] = useState<AgentObservePayload | null>(null);
  const skills = agent.skills ?? [];
  const protocol = protocolLabel(agent.protocol);
  const externalCardIdentity = hasExternalCardIdentity(agent);

  const load = useCallback(async () => {
    const [fleetResult, catalogResult, observeResult] = await Promise.all([
      api<FleetState>("/api/fleet").catch(() => null),
      api<SessionCatalogWithResume>(
        `/api/agents/${encodeURIComponent(agent.id)}/session-catalog`,
      ).catch(() => null),
      api<AgentObservePayload>(
        `/api/agents/${encodeURIComponent(agent.id)}/observe`,
      ).catch(() => null),
    ]);
    if (fleetResult) setFleet(fleetResult);
    setSessionCatalog(catalogResult);
    setObserve(observeResult);
  }, [agent.id]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    setSessionCatalog(null);
    setObserve(null);
  }, [agent.id]);
  useBrokerEvents(() => {
    void load();
  });

  // Selection is shared with the center's session list (Provider) so the rail's
  // session info + secondary actions follow whichever session is being explored.
  const { focusedSession, focusSession } = useScout();
  const activeSessionId = resolveActiveSessionId(agent, sessionCatalog);
  const sortedSessions = useMemo(
    () => sortSessionsByRecency(sessionCatalog?.sessions ?? [], activeSessionId),
    [sessionCatalog?.sessions, activeSessionId],
  );
  const routedSessionId =
    route.view === "agents-v2" && route.agentId === agent.id
      ? route.sessionId
      : null;
  const selectedSessionId = resolveSelectedSessionId(
    agent.id,
    focusedSession,
    activeSessionId,
    sortedSessions,
    routedSessionId,
  );
  const normalizedRoutedSessionId = resolveRoutedSessionId(routedSessionId, sortedSessions);
  useEffect(() => {
    if (!normalizedRoutedSessionId) return;
    if (
      focusedSession?.agentId === agent.id &&
      focusedSession.sessionId === normalizedRoutedSessionId
    ) {
      return;
    }
    focusSession(agent.id, normalizedRoutedSessionId);
  }, [
    agent.id,
    focusedSession?.agentId,
    focusedSession?.sessionId,
    focusSession,
    normalizedRoutedSessionId,
  ]);
  const selectedSession = sortedSessions.find((s) => s.id === selectedSessionId) ?? null;
  const sessionActive = Boolean(
    selectedSession && activeSessionId && selectedSession.id === activeSessionId,
  );
  const observedSessionId =
    observe?.sessionId?.trim()
    || observe?.data.metadata?.session?.externalSessionId?.trim()
    || observe?.data.metadata?.session?.threadId?.trim()
    || null;
  const displaySessionId =
    selectedSession && sessionActive && observedSessionId
      ? observedSessionId
      : selectedSession?.id ?? null;
  const profileSessionId =
    selectedSession && displaySessionId && displaySessionId !== selectedSession.id
      ? selectedSession.id
      : null;
  const engage = selectedSession
    ? sessionEngage(agent, sessionCatalog, selectedSession, sessionActive)
    : { canObserve: false, canTakeover: false };

  const observeTerminal = () =>
    openContent(navigate, { view: "terminal", agentId: agent.id, mode: "observe" }, { returnTo: route });
  const takeoverTerminal = () =>
    openContent(navigate, { view: "terminal", agentId: agent.id, mode: "takeover" }, { returnTo: route });
  // Take over a resumable harness by replaying its resume command into a
  // terminal; an existing terminal surface is driven in place.
  const runTakeover = () => {
    if (resolveAgentTerminalSurface(agent)) {
      takeoverTerminal();
      return;
    }
    const command = sessionCatalog?.resumeCommand;
    if (command) {
      void queueTakeover({ command, cwd: sessionCatalog?.resumeCwd, agentId: agent.id }).then(
        () => takeoverTerminal(),
      );
      return;
    }
    takeoverTerminal();
  };

  // Focused-agent context card — session-focused: it leads with the session the
  // center is exploring and the secondary ways to engage it. The center owns the
  // avatar / name / state / essentials and the primary Continue, so the rail
  // skips identity replay and high-level agent facts (mesh / capabilities).
  if (!showStaticIdentity) {
    return (
      <div className="flex flex-col h-full overflow-y-auto frame-scrollbar p-4 gap-4 text-sm">
        {selectedSession && (
          <Section label="Session">
            <div className="flex items-baseline justify-between gap-2">
              <span
                className="truncate font-mono text-md text-[var(--scout-chrome-ink)]"
                title={displaySessionId ?? selectedSession.id}
              >
                {shortSessionId(displaySessionId ?? selectedSession.id)}
              </span>
              <span
                className="shrink-0 font-mono text-2xs uppercase tracking-[0.12em]"
                style={{ color: sessionActive ? "var(--accent)" : "var(--scout-chrome-ink-faint)" }}
              >
                {sessionActive
                  ? "now"
                  : selectedSession.endedAt
                    ? `ended · ${timeAgo(selectedSession.endedAt) || "recent"}`
                    : timeAgo(selectedSession.startedAt) || "recent"}
              </span>
            </div>
            {selectedSession.cwd && (
              <div
                className="mt-1 truncate font-mono text-2xs text-[var(--scout-chrome-ink-ghost)]"
                title={selectedSession.cwd}
              >
                {selectedSession.cwd}
              </div>
            )}
            {displaySessionId && (
              <div
                className="mt-1 break-all font-mono text-2xs leading-snug text-[var(--scout-chrome-ink-faint)]"
                title={displaySessionId}
              >
                <span className="uppercase tracking-[0.12em] text-[var(--scout-chrome-ink-ghost)]">
                  id
                </span>{" "}
                {displaySessionId}
              </div>
            )}
            {profileSessionId && (
              <div
                className="mt-0.5 truncate font-mono text-2xs text-[var(--scout-chrome-ink-ghost)]"
                title={profileSessionId}
              >
                profile {profileSessionId}
              </div>
            )}
            {/* Terminal actions — watch it read-only, or grab it. The parsed
                trace has its own top-bar tab, so it isn't duplicated here. */}
            <div className="mt-2.5 flex flex-col gap-1.5">
              <SessionEngageRow label="Terminal">
                <RailActBtn
                  onClick={observeTerminal}
                  disabled={!engage.canObserve}
                  title={engage.canObserve ? "Watch the live terminal, read-only" : "No live terminal to observe"}
                >
                  Observe
                </RailActBtn>
                <RailActBtn
                  onClick={runTakeover}
                  disabled={!engage.canTakeover}
                  title={engage.canTakeover ? "Grab the keyboard and drive it" : "Can't take over this session"}
                >
                  Take over
                </RailActBtn>
              </SessionEngageRow>
            </div>
          </Section>
        )}

        {/* What the session has been doing — flat trace summary + top files
            touched. Only in the Profile tab; the Trace tab shows the fuller
            ObserveStats below, so we don't double up. */}
        {!observeMode && selectedSession && (
          <SessionActivity
            agentId={agent.id}
            navigate={navigate}
            cwd={selectedSession.cwd ?? agent.cwd}
            route={route}
          />
        )}

        {resolveAgentTerminalSurface(agent)?.backend === "tmux" && (
          <TmuxPeekPanel agentId={agent.id} lines={44} columns={132} />
        )}

        {/* Runtime — tight 2-col readout of the facts the header doesn't carry */}
        <Section label="Runtime">
          <RuntimeGrid agent={agent} />
        </Section>

        {observeMode && <ObserveContext agentId={agent.id} />}

        {fleet && (
          <InspectorAsks
            asks={fleet.activeAsks}
            agentId={agent.id}
            navigate={navigate}
          />
        )}
      </div>
    );
  }

  // Agent-info / multi-agent pick context — an identity header earns its place
  // here because the center isn't already focused on this agent.
  return (
    <div className="flex flex-col h-full overflow-y-auto frame-scrollbar p-4 gap-4 text-sm">
      {/* Identity */}
      <div className="flex items-center gap-3 border-b border-[var(--scout-chrome-border-soft)] pb-3">
        <AgentAvatar agent={agent} placement="inspector" />
        <div className="flex flex-col min-w-0 flex-1">
          <span className="truncate text-lg text-[var(--scout-chrome-ink-strong)]">
            {agent.name}
          </span>
          {agent.handle && (
            <span className="text-xs font-mono text-[var(--scout-chrome-ink-faint)]">
              @{agent.handle}
            </span>
          )}
        </div>
      </div>

      <AgentLiveActions
        agent={agent}
        catalog={sessionCatalog}
        navigate={navigate}
        returnTo={route}
        variant="compact"
      />

      {resolveAgentTerminalSurface(agent)?.backend === "tmux" && (
        <TmuxPeekPanel agentId={agent.id} lines={44} columns={132} />
      )}

      {/* State */}
      <Section label="State">
        <div className="flex items-baseline gap-2">
          <span
            className="w-1.5 h-1.5 rounded-full"
            style={{
              background: stateColor(agent.state),
              opacity: online ? 1 : 0.4,
            }}
          />
          <span className="text-md capitalize text-[var(--scout-chrome-ink)]">
            {agentStateLabel(agent.state)}
          </span>
        </div>
        {agent.updatedAt && (
          <div className="mt-1 text-xs font-mono text-[var(--scout-chrome-ink-faint)]">
            Updated {timeAgo(agent.updatedAt)}
          </div>
        )}
      </Section>

      {/* Presence mesh */}
      <Section label="Presence">
        <InspectorMesh
          focusAgent={agent}
          agents={agents}
          onOpenAgent={(target) =>
            openAgent(navigate, target, { from: "inspector", returnTo: route })
          }
        />
      </Section>

      {observeMode && <ObserveContext agentId={agent.id} />}

      {/* Incoming asks */}
      {fleet && (
        <InspectorAsks
          asks={fleet.activeAsks}
          agentId={agent.id}
          navigate={navigate}
        />
      )}

      {/* Identity detail */}
      <Section label="Identity">
        {agent.providerName && <Row label="Provider" value={agent.providerName} />}
        {protocol && <Row label="Protocol" value={protocol} />}
        {!externalCardIdentity && <Row label="Class" value={agent.agentClass} />}
        {!externalCardIdentity && agent.role && <Row label="Role" value={formatLabel(agent.role) ?? agent.role} />}
        {!externalCardIdentity && agent.harness && <Row label="Harness" value={agent.harness} />}
        {!externalCardIdentity && agent.transport && <Row label="Transport" value={transportDisplayLabel(agent.transport) ?? agent.transport} />}
        {(agent.homeNodeName || agent.homeNodeId) && (
          <Row label="Host" value={shortHostLabel(agent.homeNodeName ?? agent.homeNodeId ?? "")} />
        )}
      </Section>

      {skills.length > 0 && (
        <Section label={`Skills · ${skills.length}`}>
          <div className="flex flex-wrap gap-1">
            {skills.map((skill) => (
              <span
                key={skill}
                className="rounded-sm bg-[var(--scout-chrome-hover)] px-1.5 py-0.5 text-xs font-mono text-[var(--scout-chrome-ink-soft)]"
              >
                {skill}
              </span>
            ))}
          </div>
        </Section>
      )}

      {/* Project */}
      {(agent.project || agent.branch || agent.cwd) && (
        <Section label="Project">
          {agent.project && <Row label="Name" value={agent.project} />}
          {agent.branch && <Row label="Branch" value={agent.branch} />}
          {agent.cwd && <Row label="Cwd" value={agent.cwd} />}
        </Section>
      )}

      {/* Capabilities */}
      {agent.capabilities.length > 0 && (
        <Section label={`Capabilities · ${agent.capabilities.length}`}>
          <div className="flex flex-wrap gap-1">
            {agent.capabilities.map((cap) => (
              <span
                key={cap}
                className="rounded-sm bg-[var(--scout-chrome-hover)] px-1.5 py-0.5 text-xs font-mono text-[var(--scout-chrome-ink-soft)]"
              >
                {cap}
              </span>
            ))}
          </div>
        </Section>
      )}

      <RunningSessions
        agent={agent}
        catalog={sessionCatalog}
        navigate={navigate}
        returnTo={route}
      />
    </div>
  );
}

function RuntimeGrid({ agent }: { agent: Agent }) {
  const cells: Array<{ label: string; value: string }> = [];
  const push = (label: string, value: string | null | undefined) => {
    if (value && value.trim()) cells.push({ label, value: value.trim() });
  };
  const protocol = protocolLabel(agent.protocol);
  const externalCardIdentity = hasExternalCardIdentity(agent);
  // Harness · model · host live in the profile header now — keep the rail's
  // Runtime to what the header doesn't carry, to avoid re-printing facts.
  if (externalCardIdentity) {
    push("Protocol", protocol);
  } else {
    push("Role", formatLabel(agent.role));
    push("Class", agent.agentClass);
  }

  if (cells.length === 0) return null;
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-2">
      {cells.map((cell) => (
        <div key={cell.label} className="min-w-0">
          <div className="font-mono text-3xs uppercase tracking-[0.12em] text-[var(--scout-chrome-ink-faint)]">
            {cell.label}
          </div>
          <div className="truncate font-mono text-sm text-[var(--scout-chrome-ink)]">
            {cell.value}
          </div>
        </div>
      ))}
    </div>
  );
}

// A labeled row of session engage buttons (e.g. "Terminal · [Observe] [Take over]"),
// grouped by the surface each action opens.
function SessionEngageRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="w-[56px] shrink-0 font-mono text-3xs uppercase tracking-[0.12em] text-[var(--scout-chrome-ink-faint)]">
        {label}
      </span>
      <div className="flex gap-1.5">{children}</div>
    </div>
  );
}

function RailActBtn({
  onClick,
  disabled,
  title,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="rounded-[4px] border border-[var(--scout-chrome-border-soft)] px-2.5 py-1 font-mono text-3xs uppercase tracking-[0.08em] text-[var(--scout-chrome-ink-soft)] transition-colors hover:bg-[var(--scout-chrome-active)] hover:text-[var(--scout-chrome-ink)] disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--scout-chrome-ink-soft)]"
    >
      {children}
    </button>
  );
}

function RunningSessions({
  agent,
  catalog,
  navigate,
  returnTo,
}: {
  agent: Agent;
  catalog: SessionCatalogWithResume | null;
  navigate: (r: Route) => void;
  returnTo: Route;
}) {
  const showContextMenu = useContextMenu();
  const terminalSurface = resolveAgentTerminalSurface(agent);
  const activeSessionId = catalog?.activeSessionId
    ?? (terminalSurface ? agent.harnessSessionId ?? terminalSurface.sessionName : null);
  const sessions = useMemo(
    () => buildRunningSessions(agent, catalog, activeSessionId),
    [agent, catalog, activeSessionId],
  );
  const running = sessions.filter((session) =>
    session.id === activeSessionId || !session.endedAt
  );
  const visible = running.slice(0, 5);
  if (visible.length === 0) return null;
  const openTerminal = (mode: "observe" | "takeover") =>
    openContent(navigate, { view: "terminal", agentId: agent.id, mode }, { returnTo });
  const runTakeover = () => {
    if (terminalSurface) {
      openTerminal("takeover");
      return;
    }
    if (!catalog?.resumeCommand) return;
    void queueTakeover({
      command: catalog.resumeCommand,
      cwd: catalog.resumeCwd,
      agentId: agent.id,
    }).then(() => openTerminal("takeover"));
  };
  const openSessionDetail = (sessionId: string) =>
    openContent(navigate, { view: "sessions", sessionId }, { returnTo });
  const sessionMenuItems = (
    session: SessionCatalogEntry,
    canObserveTerminal: boolean,
    canTakeover: boolean,
  ): MenuItem[] => {
    const items: MenuItem[] = [];
    if (canObserveTerminal) {
      items.push({
        kind: "action",
        label: "Observe in terminal",
        onSelect: () => openTerminal("observe"),
      });
    }
    if (canTakeover) {
      items.push({
        kind: "action",
        label: "Takeover terminal",
        onSelect: runTakeover,
      });
    }
    if (items.length > 0) {
      items.push({ kind: "separator" });
    }
    items.push({
      kind: "action",
      label: "Open session detail",
      onSelect: () => openSessionDetail(session.id),
    });
    items.push({
      kind: "action",
      label: "Open agent profile",
      onSelect: () => openAgent(navigate, agent, { from: "inspector", returnTo }),
    });
    return items;
  };

  return (
    <Section label={`Running sessions · ${running.length}`}>
      <div className="flex flex-col gap-1.5">
        {visible.map((session) => {
          const active = session.id === activeSessionId;
          const canObserveTerminal = active && Boolean(terminalSurface);
          const canTakeover = active && (Boolean(terminalSurface) || Boolean(catalog?.resumeCommand));
          const age = timeAgo(session.startedAt) || "recent";
          const harnessLabel = transportDisplayLabel(session.transport)
            ?? session.harness
            ?? transportDisplayLabel(agent.transport)
            ?? agent.harness
            ?? "session";
          const lowerMeta = active
            ? age
            : session.endedAt
              ? `${timeAgo(session.endedAt) || age} ended`
              : harnessLabel;
          const menuItems = sessionMenuItems(session, canObserveTerminal, canTakeover);
          return (
            <div
              key={session.id}
              onContextMenu={(event) => showContextMenu(event, menuItems)}
              className={`rounded border px-2 py-1.5 transition-colors ${
                active
                  ? "border-[color-mix(in_srgb,var(--accent)_40%,transparent)] bg-[color-mix(in_srgb,var(--accent)_8%,transparent)]"
                  : "border-[var(--scout-chrome-border-soft)] bg-[var(--scout-chrome-hover)]"
              }`}
            >
              <button
                type="button"
                title={canObserveTerminal
                  ? `Observe terminal ${session.id}`
                  : `Open session ${session.id}`}
                onClick={() =>
                  canObserveTerminal
                    ? openTerminal("observe")
                    : openSessionDetail(session.id)
                }
                className="flex w-full items-center justify-between gap-2 bg-transparent p-0 text-left"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="flex min-w-0 items-center gap-1.5">
                    {active && (
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent)]" />
                    )}
                    <span className="truncate font-mono text-xs text-[var(--scout-chrome-ink)]">
                      {shortSessionId(session.id)}
                    </span>
                    <span className="shrink-0 rounded-sm bg-[var(--scout-chrome-hover)] px-1 py-0.5 font-mono text-3xs uppercase tracking-[0.08em] text-[var(--scout-chrome-ink-faint)]">
                      {harnessLabel}
                    </span>
                  </span>
                  <span className="mt-0.5 truncate font-mono text-2xs text-[var(--scout-chrome-ink-faint)]">
                    {session.cwd ? pathLeaf(session.cwd) : "workspace"}
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end">
                  <span className="font-mono text-2xs uppercase tracking-[0.12em] text-[var(--accent)]">
                    {active ? "active" : "running"}
                  </span>
                  <span className="mt-0.5 max-w-[78px] truncate font-mono text-2xs text-[var(--scout-chrome-ink-ghost)]">
                    {lowerMeta}
                  </span>
                </span>
              </button>
              <button
                type="button"
                title="Session actions"
                onClick={(event) => showContextMenu(event, menuItems)}
                className="mt-1.5 h-5 rounded border border-[var(--scout-chrome-border-soft)] bg-[var(--scout-chrome-hover)] px-1.5 font-mono text-3xs uppercase tracking-[0.08em] text-[var(--scout-chrome-ink-faint)] hover:bg-[var(--scout-chrome-active)] hover:text-[var(--scout-chrome-ink)]"
              >
                ...
              </button>
            </div>
          );
        })}
        {running.length > visible.length && (
          <div className="px-1 pt-0.5 font-mono text-2xs text-[var(--scout-chrome-ink-ghost)]">
            {running.length - visible.length} more running
          </div>
        )}
      </div>
    </Section>
  );
}

function buildRunningSessions(
  agent: Agent,
  catalog: SessionCatalogWithResume | null,
  activeSessionId: string | null,
): SessionCatalogEntry[] {
  const sessions = [...(catalog?.sessions ?? [])];
  const terminalSurface = resolveAgentTerminalSurface(agent);
  if (
    terminalSurface &&
    activeSessionId &&
    !sessions.some((session) => session.id === activeSessionId)
  ) {
    sessions.unshift({
      id: activeSessionId,
      startedAt: agent.createdAt ?? agent.updatedAt ?? Date.now(),
      cwd: agent.cwd ?? agent.projectRoot ?? ".",
      ...(agent.harness ? { harness: agent.harness } : {}),
      transport: terminalSurface.backend,
      model: agent.model,
    });
  }

  return sessions.sort((a, b) => {
    const left = a.endedAt ?? a.startedAt;
    const right = b.endedAt ?? b.startedAt;
    return compareTimestampsDesc(left, right);
  });
}

function shortSessionId(value: string): string {
  const compact = value.replace(/^session[_:-]?/i, "");
  return compact.length > 10 ? compact.slice(0, 8) : compact;
}

function ObserveContext({ agentId }: { agentId: string }) {
  const [observe, setObserve] = useState<AgentObservePayload | null>(null);

  const load = useCallback(async () => {
    const result = await api<AgentObservePayload>(
      `/api/agents/${encodeURIComponent(agentId)}/observe`,
    ).catch(() => null);
    setObserve(result);
  }, [agentId]);

  useEffect(() => {
    void load();
  }, [load]);
  useBrokerEvents(() => {
    void load();
  });

  if (!observe?.data) {
    return (
      <Section label="Trace">
        <div className="text-xs leading-relaxed text-[var(--scout-chrome-ink-faint)]">
          Resolving session trace.
        </div>
      </Section>
    );
  }

  return <ObserveStats agentId={agentId} data={observe.data} sessionId={observe.sessionId} />;
}

function ObserveStats({
  agentId,
  data,
  sessionId,
}: {
  agentId: string;
  data: ObserveData;
  sessionId: string | null;
}) {
  const sessionMeta = data.metadata?.session;
  const events = data.events;
  const files = data.files;
  const toolCount = events.filter((e) => e.kind === "tool").length;
  const thinkCount = events.filter((e) => e.kind === "think").length;
  const askCount = events.filter((e) => e.kind === "ask").length;
  const readCount = events.filter(
    (e) => e.kind === "tool" && e.tool === "read",
  ).length;
  const editCount = events.filter(
    (e) => e.kind === "tool" && (e.tool === "edit" || e.tool === "write"),
  ).length;
  const observedWindowSeconds = events.length > 0 ? events[events.length - 1]!.t : 0;
  const sourcePath = sessionMeta?.threadPath;

  return (
    <>
      <Section label="Session">
        {sessionId && <Row label="Active" value={sessionId} />}
        {sourcePath && (
          <PathRow
            label="Source"
            path={sourcePath}
            basePath={sessionMeta?.cwd ?? null}
            value={pathLeaf(sourcePath)}
            agentId={agentId}
            sessionId={sessionId}
          />
        )}
        {sessionMeta?.cwd && (
          <PathRow
            label="Workspace"
            path={sessionMeta.cwd}
            value={sessionMeta.cwd}
            agentId={agentId}
            sessionId={sessionId}
          />
        )}
      </Section>

      <Section label="Trace stats">
        <div className="grid grid-cols-2 gap-1.5">
          <TraceMetric label="Turns" value={fmtCompactNumber(sessionMeta?.turnCount)} />
          <TraceMetric label="Tools" value={fmtCompactNumber(toolCount)} />
          <TraceMetric label="Thinks" value={fmtCompactNumber(thinkCount)} />
          <TraceMetric label="Requests" value={fmtCompactNumber(askCount)} />
          <TraceMetric label="Reads" value={fmtCompactNumber(readCount)} />
          <TraceMetric label="Edits" value={fmtCompactNumber(editCount)} />
          <TraceMetric label="Files" value={fmtCompactNumber(files.length)} />
          <TraceMetric label="Window" value={fmtWindowSpan(observedWindowSeconds)} />
        </div>
      </Section>

      {files.length > 0 && (
        <Section label={`Files touched · ${files.length}`}>
          <div className="flex flex-col gap-1">
            {files.slice(0, 8).map((file) => (
              <button
                type="button"
                key={file.path}
                title={file.path}
                onClick={() => revealPath({
                  path: file.path,
                  basePath: sessionMeta?.cwd ?? null,
                  agentId,
                  sessionId,
                })}
                className="flex items-center justify-between gap-2 rounded border border-[var(--scout-chrome-border-soft)] bg-[var(--scout-chrome-hover)] px-2 py-1 text-left hover:border-[var(--accent)]"
              >
                <span className="min-w-0 truncate font-mono text-xs text-[var(--scout-chrome-ink-soft)]">
                  {file.path}
                </span>
                <span className="shrink-0 font-mono text-2xs text-[var(--scout-chrome-ink-faint)]">
                  x{file.touches}
                </span>
              </button>
            ))}
          </div>
        </Section>
      )}
    </>
  );
}

// Files changed — the file-level detail for the focused session, in the rail.
// (The session summary — rhythm chart, stats, context — now lives in the center;
// this side is the detail.) Changed-first (created/modified marked accent, read
// dimmed), parent/filename, and an "Open full diff" bridge to the repo-diff view.
// Reuses the /observe payload; renders nothing until it resolves.
function observeTabRoute(route: Route | undefined, agentId: string): Route {
  if (route?.view === "agents-v2") {
    return { ...route, view: "agents-v2", agentId, tab: "observe" };
  }
  return { view: "agents-v2", agentId, tab: "observe" };
}

function SessionActivity({
  agentId,
  navigate,
  cwd,
  route,
}: {
  agentId: string;
  navigate: (r: Route) => void;
  cwd?: string | null;
  route?: Route;
}) {
  const [observe, setObserve] = useState<AgentObservePayload | null>(null);
  const load = useCallback(async () => {
    const result = await api<AgentObservePayload>(
      `/api/agents/${encodeURIComponent(agentId)}/observe`,
    ).catch(() => null);
    setObserve(result);
  }, [agentId]);
  useEffect(() => {
    void load();
  }, [load]);
  useBrokerEvents(() => {
    void load();
  });

  const data = observe?.data;
  if (!data || data.files.length === 0) return null;

  const files = data.files;
  // Surface what it CHANGED first (created/modified), then what it only read —
  // so the durable output reads at the top, not whatever was touched most.
  const ordered = [...files].sort((a, b) => {
    const ra = a.state === "read" ? 0 : 1;
    const rb = b.state === "read" ? 0 : 1;
    return ra !== rb ? rb - ra : b.touches - a.touches;
  });
  const top = ordered.slice(0, 6);
  const rest = files.length - top.length;
  const changedCount = files.filter((f) => f.state !== "read").length;
  const diffPath = data.metadata?.session?.cwd ?? cwd ?? null;
  const sessionId = observe.sessionId ?? data.metadata?.session?.externalSessionId ?? undefined;
  // The session action is path-filtered from observe's changed files. The
  // worktree action remains the full dirty checkout.
  const openSessionDiff = () =>
    diffPath
      ? navigate({
          view: "repo-diff",
          path: diffPath,
          agentId,
          include: "changed",
          ...(sessionId ? { sessionId } : {}),
        })
      : navigate(observeTabRoute(route, agentId));
  const openWorktreeDiff = () =>
    diffPath
      ? navigate({ view: "repo-diff", path: diffPath })
      : navigate(observeTabRoute(route, agentId));

  return (
    <Section label="Files changed">
      <div className="mb-1.5 flex items-baseline justify-between font-mono text-3xs uppercase tracking-[0.14em] text-[var(--scout-chrome-ink-faint)]">
        <span>{changedCount > 0 ? `${changedCount} changed` : "touched"}</span>
        <span className="tabular-nums">{files.length}</span>
      </div>
      <div className="flex flex-col gap-1">
        {top.map((file) => {
          // parent/filename — the filename is the signal; an absolute path would
          // right-truncate it away. Full path on hover.
          const parts = file.path.replace(/\/+$/, "").split("/");
          const name = parts.pop() ?? file.path;
          const parent = parts.pop();
          const dir = parent ? `${parent}/` : "";
          // Changed (created/modified) gets an accent +/~ and brighter name;
          // read-only stays dim — signal via contrast, single accent.
          const changed = file.state !== "read";
          const mark = file.state === "created" ? "+" : file.state === "modified" ? "~" : "·";
          return (
            <div
              key={file.path}
              className="flex items-baseline justify-between gap-2 font-mono text-xs leading-tight"
              title={`${file.path} · ${file.state}`}
            >
              <span className="flex min-w-0 items-baseline gap-1.5">
                <span
                  className="flex-none tabular-nums"
                  style={{ color: changed ? "var(--accent)" : "var(--scout-chrome-ink-ghost)" }}
                >
                  {mark}
                </span>
                <span className="flex min-w-0 items-baseline">
                  <span className="truncate text-[var(--scout-chrome-ink-ghost)]">{dir}</span>
                  <span
                    className="flex-none"
                    style={{ color: changed ? "var(--scout-chrome-ink-soft)" : "var(--scout-chrome-ink-faint)" }}
                  >
                    {name}
                  </span>
                </span>
              </span>
              <span className="shrink-0 tabular-nums text-2xs text-[var(--scout-chrome-ink-faint)]">
                ×{file.touches}
              </span>
            </div>
          );
        })}
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
          <button
            type="button"
            onClick={openSessionDiff}
            className="w-fit cursor-pointer font-mono text-2xs uppercase tracking-[0.1em] text-[var(--accent)] hover:underline"
          >
            Session diff{rest > 0 ? ` · +${rest}` : ""} →
          </button>
          <button
            type="button"
            onClick={openWorktreeDiff}
            className="w-fit cursor-pointer font-mono text-2xs uppercase tracking-[0.1em] text-[var(--scout-chrome-ink-faint)] hover:text-[var(--accent)] hover:underline"
          >
            Worktree diff →
          </button>
        </div>
      </div>
    </Section>
  );
}

function PathRow({
  label,
  path,
  basePath,
  value,
  agentId,
  sessionId,
}: {
  label: string;
  path: string;
  basePath?: string | null;
  value: string;
  agentId: string;
  sessionId?: string | null;
}) {
  return (
    <div className="flex items-baseline justify-between py-0.5 gap-2">
      <span className="shrink-0 text-xs font-mono uppercase tracking-wider text-[var(--scout-chrome-ink-faint)]">
        {label}
      </span>
      <button
        type="button"
        title={`Reveal ${path}`}
        onClick={() => revealPath({ path, basePath, agentId, sessionId })}
        className="min-w-0 truncate bg-transparent p-0 text-right font-mono text-sm text-[var(--accent)] hover:text-[var(--scout-chrome-ink)] hover:underline"
      >
        {value}
      </button>
    </div>
  );
}

function TraceMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-[var(--scout-chrome-border-soft)] bg-[var(--scout-chrome-hover)] px-2 py-1.5">
      <div className="font-mono text-3xs uppercase tracking-[0.12em] text-[var(--scout-chrome-ink-faint)]">
        {label}
      </div>
      <div className="mt-0.5 font-mono text-md text-[var(--scout-chrome-ink)]">
        {value}
      </div>
    </div>
  );
}

function InspectorMesh({
  focusAgent,
  agents,
  onOpenAgent,
}: {
  focusAgent: Agent;
  agents: Agent[];
  onOpenAgent: (agent: Agent) => void;
}) {
  const W = 240;
  const H = 180;
  const CX = W / 2;
  const CY = H / 2;
  const R = 68;
  const others = useMemo(() => {
    const peers = agents.filter((a) => a.id !== focusAgent.id);
    const stateRank = (s: string) => {
      const n = normalizeAgentState(s);
      if (n === "in_turn") return 0;
      if (n === "in_flight") return 1;
      if (n === "callable") return 2;
      return 2;
    };
    return peers
      .slice()
      .sort((a, b) => {
        const sa = stateRank(a.state ?? "");
        const sb = stateRank(b.state ?? "");
        if (sa !== sb) return sa - sb;
        return compareTimestampsDesc(a.updatedAt, b.updatedAt);
      })
      .slice(0, 8);
  }, [agents, focusAgent.id]);

  const nodes = useMemo(() => {
    const result: Array<{
      agent: Agent;
      x: number;
      y: number;
      focused: boolean;
    }> = [{ agent: focusAgent, x: CX, y: CY, focused: true }];
    others.forEach((a, i) => {
      const angle =
        (2 * Math.PI * i) / Math.max(others.length, 1) - Math.PI / 2;
      result.push({
        agent: a,
        x: CX + R * Math.cos(angle),
        y: CY + R * Math.sin(angle),
        focused: false,
      });
    });
    return result;
  }, [focusAgent, others, CX, CY, R]);

  return (
    <div className="@container flex flex-wrap items-start gap-3">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="block mx-auto shrink-0 w-full"
        style={{ maxWidth: W }}
        xmlns="http://www.w3.org/2000/svg"
      >
      <defs>
        <radialGradient id="inspMeshGlow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.06" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx={CX} cy={CY} r={R + 14} fill="url(#inspMeshGlow)" />
      <circle
        cx={CX}
        cy={CY}
        r={R}
        fill="none"
        stroke="var(--border)"
        strokeDasharray="2 4"
      />

      {nodes.slice(1).map((n, i) => (
        <g key={`e-${n.agent.id}`}>
          <line
            x1={CX}
            y1={CY}
            x2={n.x}
            y2={n.y}
            stroke="var(--accent)"
            strokeWidth={1}
            opacity={0.6}
          />
          <circle r={2} fill="var(--accent)">
            <animateMotion
              dur={`${2 + i * 0.3}s`}
              repeatCount="indefinite"
              path={`M ${CX},${CY} L ${n.x},${n.y}`}
            />
          </circle>
        </g>
      ))}

      {nodes.map((n) => {
        const nState = normalizeAgentState(n.agent.state);
        const isActive = nState === "in_turn" || nState === "in_flight" || nState === "callable";
        const r = n.focused ? 14 : 9;
        return (
          <g
            key={n.agent.id}
            style={{ cursor: "pointer" }}
            onClick={() => onOpenAgent(n.agent)}
          >
            {isActive && (
              <circle
                cx={n.x}
                cy={n.y}
                r={r + 5}
                fill="none"
                stroke={actorColor(n.agent.name)}
                strokeWidth={0.8}
                opacity={0.3}
              >
                <animate
                  attributeName="r"
                  values={`${r};${r + 8};${r}`}
                  dur="2.5s"
                  repeatCount="indefinite"
                />
                <animate
                  attributeName="opacity"
                  values="0.3;0;0.3"
                  dur="2.5s"
                  repeatCount="indefinite"
                />
              </circle>
            )}
            <circle
              cx={n.x}
              cy={n.y}
              r={r}
              fill={actorColor(n.agent.name)}
              stroke={n.focused ? "var(--accent)" : "var(--surface)"}
              strokeWidth={n.focused ? 1.5 : 1}
            />
            <text
              x={n.x}
              y={n.y}
              dy="0.35em"
              textAnchor="middle"
              fontFamily="var(--font-mono)"
              fontSize={n.focused ? 10 : 8}
              fontWeight={600}
              fill="var(--scout-chrome-avatar-ink)"
            >
              {n.agent.name[0].toUpperCase()}
            </text>
            <text
              x={n.x}
              y={n.y + r + 10}
              textAnchor="middle"
              fontFamily="var(--font-mono)"
              fontSize={8}
              fill="var(--dim)"
              letterSpacing="0.04em"
            >
              {n.agent.name.length > 9
                ? n.agent.name.slice(0, 8) + "..."
                : n.agent.name}
            </text>
          </g>
        );
      })}
      </svg>
      {others.length > 0 && (
        <ul className="@max-[380px]:hidden flex-1 min-w-[120px] flex flex-col gap-1 m-0 p-0 list-none">
          {others.map((peer) => {
            const nState = normalizeAgentState(peer.state);
            return (
              <li key={peer.id}>
                <button
                  type="button"
                  onClick={() => onOpenAgent(peer)}
                  className="w-full flex items-center gap-2 py-1 px-1.5 rounded hover:bg-[var(--surface-hover)] text-left"
                >
                  <span
                    aria-hidden
                    className="shrink-0 w-2 h-2 rounded-full"
                    style={{ background: actorColor(peer.name) }}
                  />
                  <span className="flex-1 truncate text-sm font-mono text-[var(--scout-chrome-ink)]">
                    {peer.name}
                  </span>
                  <span
                    aria-hidden
                    title={agentStateLabel(peer.state)}
                    className="shrink-0 w-1.5 h-1.5 rounded-full"
                    style={{ background: stateColor(nState) }}
                  />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function InspectorAsks({
  asks,
  agentId,
  navigate,
}: {
  asks: FleetAsk[];
  agentId: string;
  navigate: (r: Route) => void;
}) {
  const relevant = asks.filter(
    (a) =>
      a.agentId === agentId &&
      (a.status === "needs_attention" || a.status === "queued"),
  );
  if (relevant.length === 0) return null;

  return (
    <Section label={`Incoming requests · ${relevant.length}`}>
      <div className="flex flex-col gap-2">
        {relevant.map((ask) => (
          <div
            key={ask.invocationId}
            className="p-2.5 rounded-md border border-amber-500/30 bg-amber-500/[0.04] cursor-pointer hover:bg-amber-500/[0.08] transition-colors"
            onClick={() => {
              if (ask.conversationId) {
                navigate({
                  view: "agents-v2",
                  agentId,
                  conversationId: ask.conversationId,
                });
              }
            }}
          >
            <div className="text-2xs font-mono uppercase tracking-[0.12em] text-amber-500/80 mb-1">
              awaiting
            </div>
            <div className="line-clamp-2 text-sm leading-relaxed text-[var(--scout-chrome-ink)]">
              {ask.summary ?? ask.task}
            </div>
            <div className="mt-1.5 text-2xs font-mono text-[var(--scout-chrome-ink-ghost)]">
              {ask.harness ?? "operator"} &rarr; {ask.agentName ?? "agent"}
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col">
      <div className="mb-1.5 text-2xs font-mono uppercase tracking-[0.15em] text-[var(--scout-chrome-ink-faint)]">
        {label}
      </div>
      {children}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between py-0.5 gap-2">
      <span className="shrink-0 text-xs font-mono uppercase tracking-wider text-[var(--scout-chrome-ink-faint)]">
        {label}
      </span>
      <span
        className="truncate text-sm font-mono text-[var(--scout-chrome-ink)]"
        title={value}
      >
        {value}
      </span>
    </div>
  );
}
