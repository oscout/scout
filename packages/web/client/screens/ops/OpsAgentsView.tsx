import "./ops-agents.css";

import { Search, SlidersHorizontal } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { isAgentBusy, isAgentOnline, normalizeAgentState } from "../../lib/agent-state.ts";
import { stateColor } from "../../lib/colors.ts";
import { api } from "../../lib/api.ts";
import { useBrokerEvents } from "../../lib/sse.ts";
import { timeAgo } from "../../lib/time.ts";
import { DataTable, type DataTableColumn } from "../../components/DataTable/DataTable.tsx";
import { useAgentHoverCard } from "../../components/useAgentHoverCard.tsx";
import { resolveAgentRuntimeIdentity } from "./agent-runtime-identity.ts";
import {
  estimateAdapterCost,
  type AdapterCostEstimate,
  type AdapterTokenBreakdown,
} from "../../../../agent-sessions/src/protocol/cost.ts";
import type {
  ActivityItem,
  Agent,
  AgentObservePayload,
  FleetAsk,
  FleetState,
  Route,
  SessionEntry,
} from "../../lib/types.ts";

const BROKER_EVENT_REFRESH_DELAY_MS = 1500;

type AgentOpsRow = {
  agent: Agent;
  team: string;
  machine: string;
  model: string | null;
  provider: string | null;
  state: ReturnType<typeof normalizeAgentState>;
  activeFlights: number;
  sessions24h: number;
  throughput: number[];
  avgLatencyMs: number | null;
  usage: AdapterTokenBreakdown;
  cost: AdapterCostEstimate;
  errors: number;
  lastActiveAt: number | null;
  /** Top in-flight task title for this agent, if any. Differentiates two agents that share a name. */
  activeTask: string | null;
};

const DAY_MS = 24 * 60 * 60_000;
const LATENCY_WINDOW_MS = 90 * 60_000;


type AgentOpsColumnKey =
  | "agent"
  | "task"
  | "team"
  | "machine"
  | "active"
  | "sessions24h"
  | "throughput"
  | "avgLatency"
  | "input"
  | "cacheRead"
  | "cacheWrite"
  | "output"
  | "apiEquiv"
  | "billed"
  | "errors"
  | "lastActive";

const STATE_RANK: Record<AgentOpsRow["state"], number> = {
  needs_attention: 0,
  in_turn: 1,
  in_flight: 2,
  callable: 3,
  blocked: 4,
};

const AGENT_COLUMNS: DataTableColumn<AgentOpsRow, AgentOpsColumnKey>[] = [
  {
    key: "agent",
    label: "Agent",
    kind: "custom",
    sortable: true,
    sortValue: (row) => row.agent.name.toLowerCase(),
    defaultWidth: 220,
    minWidth: 160,
    render: (row) => (
      <div className="s-ops-agents-agent-cell">
        <span
          className="s-ops-agents-dot"
          style={{ background: stateColor(row.state) }}
          aria-hidden
        />
        <span className="s-ops-agents-agent-name" title={row.agent.name}>
          {row.agent.handle ?? row.agent.name}
        </span>
      </div>
    ),
  },
  {
    key: "task",
    label: "Active task",
    kind: "custom",
    sortable: true,
    sortValue: (row) => (row.activeTask ?? "").toLowerCase() || null,
    defaultWidth: 240,
    minWidth: 140,
    render: (row) =>
      row.activeTask ? (
        <span className="s-ops-agents-task" title={row.activeTask}>
          {row.activeTask}
        </span>
      ) : (
        <span className="s-ops-agents-task s-ops-agents-task--idle">—</span>
      ),
  },
  {
    key: "team",
    label: "Project",
    kind: "text",
    defaultWidth: 140,
    minWidth: 90,
    cls: "s-ops-agents-meta",
    render: (row) => <span className="s-ops-agents-meta-cell">{row.team}</span>,
    sortValue: (row) => row.team.toLowerCase(),
  },
  {
    key: "machine",
    label: "Machine",
    kind: "text",
    defaultWidth: 120,
    minWidth: 88,
    cls: "s-ops-agents-meta",
    render: (row) => <span className="s-ops-agents-meta-cell">{row.machine}</span>,
    sortValue: (row) => row.machine.toLowerCase(),
  },
  {
    key: "active",
    label: "Active",
    kind: "number",
    defaultWidth: 90,
    minWidth: 64,
    cls: "s-ops-agents-num",
    render: (row) => row.activeFlights,
    sortValue: (row) => row.activeFlights,
  },
  {
    key: "sessions24h",
    label: "24h sessions",
    kind: "number",
    defaultWidth: 108,
    minWidth: 78,
    cls: "s-ops-agents-num",
    render: (row) => row.sessions24h,
    sortValue: (row) => row.sessions24h,
  },
  {
    key: "throughput",
    label: "Throughput",
    kind: "custom",
    sortable: false,
    defaultWidth: 110,
    minWidth: 90,
    render: (row) => <Sparkline values={row.throughput} warn={row.errors > 0} />,
  },
  {
    key: "avgLatency",
    label: "Avg latency",
    kind: "number",
    defaultWidth: 108,
    minWidth: 80,
    cls: "s-ops-agents-num",
    render: (row) => formatLatency(row.avgLatencyMs),
    sortValue: (row) => row.avgLatencyMs,
  },
  {
    key: "input",
    label: "Input",
    kind: "number",
    defaultWidth: 88,
    minWidth: 64,
    cls: "s-ops-agents-num",
    render: (row) => compactNumber(row.usage.uncachedInput ?? row.usage.input),
    sortValue: (row) => row.usage.uncachedInput ?? row.usage.input ?? null,
  },
  {
    key: "cacheRead",
    label: "Cache read",
    kind: "number",
    defaultWidth: 98,
    minWidth: 72,
    cls: "s-ops-agents-num",
    render: (row) => compactNumber(row.usage.cachedInput),
    sortValue: (row) => row.usage.cachedInput ?? null,
  },
  {
    key: "cacheWrite",
    label: "Cache write",
    kind: "number",
    defaultWidth: 98,
    minWidth: 72,
    cls: "s-ops-agents-num",
    render: (row) => compactNumber(row.usage.cacheWrite),
    sortValue: (row) => row.usage.cacheWrite ?? null,
  },
  {
    key: "output",
    label: "Output",
    kind: "number",
    defaultWidth: 88,
    minWidth: 64,
    cls: "s-ops-agents-num",
    render: (row) => compactNumber(row.usage.output),
    sortValue: (row) => row.usage.output ?? null,
  },
  {
    key: "apiEquiv",
    label: "API equiv",
    kind: "number",
    defaultWidth: 92,
    minWidth: 72,
    cls: "s-ops-agents-num",
    render: (row) => (
      <span className={row.cost.rateCardSource === "unknown" ? "s-ops-agents-num--dim" : undefined}>
        {formatCost(row.cost.totalUsd)}
      </span>
    ),
    sortValue: (row) => row.cost.totalUsd ?? null,
  },
  {
    key: "billed",
    label: "Billed",
    kind: "number",
    defaultWidth: 92,
    minWidth: 72,
    cls: "s-ops-agents-num",
    render: (row) => (
      <span className={row.cost.billingMode === "subscription" ? "s-ops-agents-num--covered" : undefined}>
        {formatCost(row.cost.billedTotalUsd)}
      </span>
    ),
    sortValue: (row) => row.cost.billedTotalUsd ?? null,
  },
  {
    key: "errors",
    label: "Errors",
    kind: "number",
    defaultWidth: 72,
    minWidth: 58,
    cls: "s-ops-agents-num",
    render: (row) => (
      <span className={row.errors > 0 ? "s-ops-agents-num--warn" : undefined}>{row.errors}</span>
    ),
    sortValue: (row) => row.errors,
  },
  {
    key: "lastActive",
    label: "Last active",
    kind: "time",
    defaultWidth: 104,
    minWidth: 78,
    cls: "s-ops-agents-last",
    render: (row) => (row.lastActiveAt ? timeAgo(row.lastActiveAt) : "—"),
    sortValue: (row) => row.lastActiveAt,
  },
];


function basename(path: string | null | undefined): string | null {
  if (!path) return null;
  const cleaned = path.replace(/\/+$/, "");
  const idx = cleaned.lastIndexOf("/");
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

function compactNumber(value: number | null): string {
  if (value == null) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  return String(value);
}

function formatLatency(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatCost(value: number | null): string {
  if (value == null) return "$—";
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

function averageLatencyMs(payload: AgentObservePayload | undefined, now: number): number | null {
  if (!payload) return null;
  const events = payload.data.events
    .filter((event) => event.kind === "message" || event.kind === "tool")
    .filter((event) => now - event.t <= LATENCY_WINDOW_MS)
    .sort((left, right) => left.t - right.t);
  if (events.length < 2) return null;
  const gaps: number[] = [];
  for (let idx = 1; idx < events.length; idx += 1) {
    const gap = events[idx].t - events[idx - 1].t;
    if (gap > 0 && gap < 120_000) gaps.push(gap);
  }
  if (gaps.length === 0) return null;
  return Math.round(gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length);
}

function makeThroughput(activity: ActivityItem[], now: number): number[] {
  const buckets = new Array<number>(24).fill(0);
  const start = now - DAY_MS;
  for (const item of activity) {
    if (item.ts < start || item.ts > now) continue;
    const bucket = Math.min(23, Math.max(0, Math.floor(((item.ts - start) / DAY_MS) * buckets.length)));
    buckets[bucket] += 1;
  }
  return buckets;
}

function Sparkline({ values, warn = false }: { values: number[]; warn?: boolean }) {
  const width = 92;
  const height = 22;
  const peak = Math.max(1, ...values);
  const points = values
    .map((value, index) => {
      const x = (index / Math.max(1, values.length - 1)) * width;
      const y = height - (value / peak) * (height - 3) - 1.5;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg className={`s-ops-agents-spark${warn ? " s-ops-agents-spark--warn" : ""}`} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function machineLabel(agent: Agent): string {
  return agent.authorityNodeName
    ?? agent.homeNodeName
    ?? agent.authorityNodeId
    ?? agent.homeNodeId
    ?? agent.transport
    ?? basename(agent.cwd)
    ?? basename(agent.projectRoot)
    ?? "local";
}

function teamLabel(agent: Agent): string {
  return agent.project ?? agent.role ?? agent.agentClass ?? "Unassigned";
}

function pickActiveTask(asks: FleetAsk[]): string | null {
  if (asks.length === 0) return null;
  // Prefer in-flight work; fall back to anything queued/needs attention so the cell still differentiates siblings.
  const STATUS_RANK: Record<FleetAsk["status"], number> = {
    working: 0,
    needs_attention: 1,
    queued: 2,
    failed: 3,
    completed: 4,
  };
  const sorted = [...asks].sort((a, b) => {
    const rd = STATUS_RANK[a.status] - STATUS_RANK[b.status];
    if (rd !== 0) return rd;
    return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  });
  const top = sorted[0];
  const raw = (top.task ?? top.summary ?? "").trim();
  return raw || null;
}

function rowForAgent(
  agent: Agent,
  sessions: SessionEntry[],
  activity: ActivityItem[],
  activeAsks: FleetAsk[],
  observe: Map<string, AgentObservePayload>,
  now: number,
): AgentOpsRow {
  const agentSessions = sessions.filter((session) => session.agentId === agent.id);
  const recentSessions = agentSessions.filter((session) => {
    const lastAt = session.lastMessageAt ?? 0;
    return lastAt > 0 && now - lastAt <= DAY_MS;
  });
  const agentConversationId = agent.conversationId;
  const agentActivity = activity.filter(
    (item) =>
      item.actorName === agent.name
      || Boolean(agentConversationId && item.conversationId === agentConversationId),
  );
  const payload = observe.get(agent.id);
  const { model, provider } = resolveAgentRuntimeIdentity(agent, payload);
  const cost = estimateAdapterCost({
    adapterType: payload?.data.metadata?.session?.adapterType,
    capturedAt: payload?.updatedAt ?? now,
    model,
    provider,
    usage: payload?.data.metadata?.usage,
  });
  const agentAsks = activeAsks.filter((ask) => ask.agentId === agent.id);
  return {
    agent,
    team: teamLabel(agent),
    machine: machineLabel(agent),
    model,
    provider,
    state: normalizeAgentState(agent.state),
    activeFlights: agentAsks.length,
    activeTask: pickActiveTask(agentAsks),
    sessions24h: recentSessions.length,
    throughput: makeThroughput(agentActivity, now),
    avgLatencyMs: averageLatencyMs(payload, now),
    usage: cost.usage,
    cost,
    errors: agentAsks.filter((ask) => ask.status === "failed" || ask.status === "needs_attention").length,
    lastActiveAt: Math.max(
      0,
      ...agentSessions.map((session) => session.lastMessageAt ?? 0),
      ...agentActivity.map((item) => item.ts),
      agent.updatedAt ?? 0,
    ) || null,
  };
}

export function OpsAgentsView({
  navigate,
  agents,
}: {
  navigate: (r: Route) => void;
  agents: Agent[];
}) {
  const [fleet, setFleet] = useState<FleetState | null>(null);
  const [sessions, setSessions] = useState<SessionEntry[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [observePayloads, setObservePayloads] = useState<AgentObservePayload[]>([]);
  const [query, setQuery] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const brokerRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    const ids = agents.map((agent) => agent.id).join(",");
    const [fleetResult, sessionsResult, activityResult, observeResult] = await Promise.allSettled([
      api<FleetState>("/api/fleet"),
      api<SessionEntry[]>("/api/conversations"),
      api<ActivityItem[]>("/api/activity"),
      ids ? api<AgentObservePayload[]>(`/api/observe/agents?ids=${encodeURIComponent(ids)}`) : Promise.resolve([]),
    ]);

    if (fleetResult.status === "fulfilled") setFleet(fleetResult.value);
    if (sessionsResult.status === "fulfilled") setSessions(sessionsResult.value);
    if (activityResult.status === "fulfilled") setActivity(activityResult.value);
    if (observeResult.status === "fulfilled") setObservePayloads(observeResult.value);
    setNow(Date.now());
  }, [agents]);

  useEffect(() => {
    void load();
  }, [load]);
  const scheduleBrokerRefresh = useCallback(() => {
    if (brokerRefreshTimer.current) return;
    brokerRefreshTimer.current = setTimeout(() => {
      brokerRefreshTimer.current = null;
      void load();
    }, BROKER_EVENT_REFRESH_DELAY_MS);
  }, [load]);
  useBrokerEvents(scheduleBrokerRefresh);
  useEffect(() => {
    return () => {
      if (brokerRefreshTimer.current) {
        clearTimeout(brokerRefreshTimer.current);
        brokerRefreshTimer.current = null;
      }
    };
  }, []);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const observeByAgent = useMemo(
    () => new Map(observePayloads.map((payload) => [payload.agentId, payload])),
    [observePayloads],
  );

  const rows = useMemo(() => {
    const activeAsks = fleet?.activeAsks ?? [];
    return agents.map((agent) =>
      rowForAgent(agent, sessions, activity, activeAsks, observeByAgent, now),
    );
  }, [activity, agents, fleet?.activeAsks, now, observeByAgent, sessions]);

  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) =>
      `${row.agent.name} ${row.team} ${row.machine} ${row.agent.handle ?? ""} ${row.agent.harness ?? ""} ${row.activeTask ?? ""}`
        .toLowerCase()
        .includes(q),
    );
  }, [query, rows]);

  const [sort, setSort] = useState<{ key: AgentOpsColumnKey; dir: 1 | -1 } | null>({
    key: "lastActive",
    dir: -1,
  });

  // Status promotion: working > ready > not ready, applied as a tiebreaker so
  // user-chosen sort always wins within a tier but busy agents stay near the top.
  const secondarySort = useMemo(
    () => (sort?.key === "agent"
      ? undefined
      : (a: AgentOpsRow, b: AgentOpsRow) => STATE_RANK[a.state] - STATE_RANK[b.state]),
    [sort?.key],
  );

  const filteredAgents = useMemo(() => filteredRows.map((r) => r.agent), [filteredRows]);
  const orderedIds = useMemo(() => filteredRows.map((r) => r.agent.id), [filteredRows]);
  const hover = useAgentHoverCard({
    agents: filteredAgents,
    orderedIds,
    navigate,
    selectMode: "preview",
  });

  const running = rows.filter((row) => row.state === "in_turn" || row.state === "in_flight").length;
  const online = rows.filter((row) => isAgentOnline(row.agent.state, row.agent)).length;
  const tokens = rows.reduce((sum, row) => sum + (row.usage.total ?? 0), 0);
  const apiCost = rows.some((row) => row.cost.totalUsd != null)
    ? rows.reduce((sum, row) => sum + (row.cost.totalUsd ?? 0), 0)
    : null;
  const billedCost = rows.some((row) => row.cost.billedTotalUsd != null)
    ? rows.reduce((sum, row) => sum + (row.cost.billedTotalUsd ?? 0), 0)
    : null;
  const avgLatency = (() => {
    const values = rows.map((row) => row.avgLatencyMs).filter((value): value is number => value != null);
    return values.length === 0 ? null : Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
  })();

  return (
    <div className="s-ops-agents">
      <main className="s-ops-agents-main">
        <div className="s-ops-agents-toolbar">
          <div className="s-ops-agents-breadcrumb">Agents <span>/</span> Directory</div>
          <div className="s-ops-agents-live">
            <span className="s-ops-agents-live-dot" />
            {online} active
          </div>
          <div className="s-ops-agents-search">
            <Search size={13} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search agents, tasks, projects, machines…" />
          </div>
          <button className="s-ops-agents-icon-btn" type="button" title="Filters">
            <SlidersHorizontal size={14} />
          </button>
        </div>

        <section className="s-ops-agents-hero">
          <div>
            <div className="s-ops-agents-kicker">Agents</div>
            <h1>All agents</h1>
            <p>Every registered agent across the local fleet, sorted by live status.</p>
          </div>
        </section>

        <section className="s-ops-agents-stats">
          <Metric label="Running" value={String(running)} sub={`of ${agents.length} total`} />
          <Metric label="Tokens" value={compactNumber(tokens || null)} sub={apiCost == null ? "usage metadata pending" : `${formatCost(apiCost)} API equiv`} />
          <Metric label="Avg latency" value={formatLatency(avgLatency)} sub="recent observe events" />
          <Metric label="Billed" value={formatCost(billedCost)} sub="subscription usage can mark this down" />
        </section>

        <section className="s-ops-agents-table-panel">
          <div className="s-ops-agents-table-title">
            Agents <span>{filteredRows.length}</span>
            <span className="s-ops-agents-hint" aria-hidden>
              <kbd>↑</kbd><kbd>↓</kbd> navigate · <kbd>enter</kbd> pin · <kbd>o</kbd> open · <kbd>esc</kbd> clear
            </span>
          </div>
          <div className="s-ops-agents-table-wrap" ref={hover.containerRef}>
            <DataTable
              rows={filteredRows}
              columns={AGENT_COLUMNS}
              rowId={(row) => row.agent.id}
              storageKey="openscout.opsAgents.cols"
              sort={sort}
              onSortChange={setSort}
              secondarySort={secondarySort}
              density="compact"
              rowBindings={(id) => {
                const bindings = hover.bind<HTMLTableRowElement>(id);
                return {
                  ...bindings,
                  onKeyDown: (event: ReactKeyboardEvent<HTMLTableRowElement>) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    bindings.onClick();
                  },
                };
              }}
              rowState={(id) => hover.getState(id)}
              empty={{ title: "No agents match", body: "Adjust the search to find a different slice of the fleet." }}
              className="s-ops-agents-data-table"
              ariaLabel="Agents directory"
            />
          </div>
        </section>
      </main>
      {hover.card}
    </div>
  );
}

function Metric({
  label,
  value,
  sub,
  tone = "default",
}: {
  label: string;
  value: string;
  sub: string;
  tone?: "default" | "warn";
}) {
  return (
    <div className={`s-ops-agents-metric s-ops-agents-metric--${tone}`}>
      <div className="s-ops-agents-metric-label">{label}</div>
      <div className="s-ops-agents-metric-value">{value}</div>
      <div className="s-ops-agents-metric-sub">{sub}</div>
    </div>
  );
}
