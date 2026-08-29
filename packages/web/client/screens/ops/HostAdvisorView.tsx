import "./host-advisor.css";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowUpRight,
  Compass,
  Cpu,
  Database,
  FileText,
  FolderGit2,
  Gauge,
  LayoutGrid,
  RefreshCw,
} from "lucide-react";
import { HarnessMark, harnessLabel } from "../../components/HarnessMark.tsx";
import { api } from "../../lib/api.ts";
import { useBrokerEvents } from "../../lib/sse.ts";
import { timeAgo } from "../../lib/time.ts";
import type {
  ActivityItem,
  Agent,
  FleetState,
  PairingState,
  Route,
  SessionEntry,
  TailDiscoverySnapshot,
} from "../../lib/types.ts";
import {
  asciiGaugeBar,
  gaugeFill,
  isNearCeiling,
  isUnusedGauge,
  readBudgetSection,
} from "./host-advisor-gauges.ts";

export type HostInfo = {
  nodeId?: string;
  meshId?: string;
  nodeName?: string;
  hostName?: string;
  advertiseScope?: string;
  brokerUrl?: string;
  webUrl?: string;
  brokerSocketPath?: string;
  supportDirectory?: string;
  runtimeDirectory?: string;
  ports?: {
    broker?: number;
    web?: number;
  };
  services?: {
    broker?: { url?: string; host?: string; port?: number; socketPath?: string };
    web?: { url?: string; host?: string; port?: number };
  };
};

export type BuildInfo = {
  version?: string;
  gitHash?: string;
  gitBranch?: string;
  commitTime?: string;
  dirty?: boolean;
  runtime?: {
    engine?: string;
    engineVersion?: string;
    platform?: string;
    arch?: string;
  };
};

export type ServiceQuotaGauge = {
  id: string;
  label: string;
  kind: "quota" | "status";
  fill?: number;
  usedLabel?: string;
  capLabel?: string;
  unitLabel?: string;
  resetAt?: number;
  plan?: string;
  statusLabel?: string;
};

export type KnowledgeStatus = {
  indexedSessions?: number;
  totalTokens?: number;
  dbPath?: string;
  lastIndexedAt?: number;
};

export type TerminalSessionSummary = {
  id: string;
  title?: string;
  origin?: string;
  backend?: string;
  cwd?: string;
  active?: boolean;
  updatedAt?: number;
};

type AdvisorDisplayMode = "inquiry" | "matrix";

function formatProcessCommand(cmd?: string, harness?: string): string {
  if (!cmd) return harness || "process";
  if (cmd.includes("--append-system-prompt")) {
    const match = cmd.match(/session-[a-zA-Z0-9_-]+/);
    if (match) return `${harness || "harness"} (relay ${match[0]})`;
    return `${harness || "harness"} (prompted relay)`;
  }
  if (cmd.length > 70) {
    return `${cmd.slice(0, 67)}...`;
  }
  return cmd;
}

function extractProjectName(path?: string | null): string {
  if (!path) return "workspace";
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

type SubsystemReading = {
  key: string;
  label: string;
  detail: string;
  state: string;
  tone: "ok" | "idle" | "warn" | "unknown";
  action?: { label: string; route: Route };
};

/** `ps -o etime` emits MM:SS, HH:MM:SS or DD-HH:MM:SS. */
function etimeSeconds(etime?: string): number | undefined {
  if (!etime) return undefined;
  const [days, clock] = etime.includes("-") ? etime.split("-") : ["0", etime];
  const parts = clock.split(":").map((part) => Number.parseInt(part, 10));
  if (parts.length < 2 || parts.some((value) => !Number.isFinite(value))) return undefined;
  const [hours, minutes, seconds] = parts.length === 3 ? parts : [0, parts[0], parts[1]];
  return ((Number.parseInt(days, 10) || 0) * 24 + hours) * 3600 + minutes * 60 + seconds;
}

function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return `${Math.round(totalSeconds)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours < 24) return remainder ? `${hours}h${String(remainder).padStart(2, "0")}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d${hours % 24}h`;
}

function basenameOf(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] || path;
}

const UNATTENDED_KIND_LABEL: Record<string, string> = {
  stalled_relay: "relay",
  idle_process: "process",
  uncommitted_branch: "branch",
  unresumed_session: "session",
};

function BudgetGaugeRow({ gauge }: { gauge: ServiceQuotaGauge }) {
  const fill = gaugeFill(gauge);
  const near = isNearCeiling(gauge);
  const unused = isUnusedGauge(gauge);
  const bar = asciiGaugeBar(fill ?? 0);
  const measured = fill !== null;
  const tone = near ? "warn" : unused || !measured ? "unused" : "ok";
  const note = unused
    ? "UNUSED"
    : gauge.resetAt
      ? `RESET ${timeAgo(gauge.resetAt)}`
      : gauge.statusLabel || gauge.usedLabel || "";

  return (
    <div className={`s-host-rack-row ${near ? "s-host-rack-row--warn" : ""} ${unused || !measured ? "s-host-rack-row--unused" : ""}`}>
      <span className="s-host-rack-name font-mono">{gauge.label}</span>
      <span
        className={`s-host-gauge s-host-gauge--${tone}`}
        role="meter"
        aria-label={measured ? `${gauge.label} ${bar.percent} percent` : `${gauge.label} ${gauge.statusLabel || "no quota"}`}
        aria-valuemin={measured ? 0 : undefined}
        aria-valuemax={measured ? 100 : undefined}
        aria-valuenow={measured ? bar.percent : undefined}
      >
        <span className="s-host-gauge-chrome" aria-hidden="true">[</span><span className="s-host-gauge-fill" aria-hidden="true">{bar.filled}</span><span className="s-host-gauge-rest" aria-hidden="true">{bar.rest}</span><span className="s-host-gauge-chrome" aria-hidden="true">]</span>
      </span>
      <span className={`s-host-rack-right font-mono ${near ? "s-host-rack-age--warn" : ""} ${unused || !measured ? "s-host-rack-dim" : ""}`}>
        {measured ? `${bar.percent}%` : "—"}
      </span>
      <span className="s-host-rack-right s-host-rack-dim font-mono s-host-rack-truncate">{note}</span>
    </div>
  );
}

export function HostAdvisorView({
  navigate,
  agents,
}: {
  navigate: (r: Route) => void;
  agents: Agent[];
}) {
  const [hostInfo, setHostInfo] = useState<HostInfo | null>(null);
  const [buildInfo, setBuildInfo] = useState<BuildInfo | null>(null);
  const [quotas, setQuotas] = useState<ServiceQuotaGauge[] | null>(null);
  const [tailDiscovery, setTailDiscovery] = useState<TailDiscoverySnapshot | null>(null);
  const [knowledgeStatus, setKnowledgeStatus] = useState<KnowledgeStatus | null>(null);
  const [pairingState, setPairingState] = useState<PairingState | null>(null);
  const [terminalSessions, setTerminalSessions] = useState<TerminalSessionSummary[]>([]);
  const [fleetState, setFleetState] = useState<FleetState | null>(null);
  const [sessions, setSessions] = useState<SessionEntry[]>([]);
  const [activities, setActivities] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number>(Date.now());
  const [displayMode, setDisplayMode] = useState<AdvisorDisplayMode>("inquiry");
  const [showAllProcesses, setShowAllProcesses] = useState(false);
  const [expandedInquiries, setExpandedInquiries] = useState<Record<string, boolean>>({
    "q-attention": true,
    "q-dropped": true,
    "q-quotas": true,
    "q-posture": true,
  });

  const toggleInquiry = (id: string) => {
    setExpandedInquiries((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const loadData = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);

    try {
      const [
        hostRes,
        buildRes,
        quotaRes,
        tailRes,
        knowledgeRes,
        pairingRes,
        terminalRes,
        fleetRes,
        sessionsRes,
        activityRes,
      ] = await Promise.allSettled([
        api<HostInfo>("/.host-info"),
        api<BuildInfo>("/api/build"),
        api<{ gauges: ServiceQuotaGauge[] }>("/api/service-budgets"),
        api<TailDiscoverySnapshot>("/api/tail/discover"),
        api<KnowledgeStatus>("/api/knowledge/status"),
        api<PairingState>("/api/pairing-state"),
        api<{ sessions: TerminalSessionSummary[] }>("/api/terminal-sessions"),
        api<FleetState>("/api/fleet"),
        api<SessionEntry[]>("/api/sessions"),
        api<ActivityItem[]>("/api/activity"),
      ]);

      if (hostRes.status === "fulfilled") setHostInfo(hostRes.value);
      if (buildRes.status === "fulfilled") setBuildInfo(buildRes.value);
      if (quotaRes.status === "fulfilled") {
        setQuotas(quotaRes.value?.gauges ?? []);
      } else if (quotaRes.status === "rejected") {
        setQuotas([]);
      }
      if (tailRes.status === "fulfilled") setTailDiscovery(tailRes.value);
      if (knowledgeRes.status === "fulfilled") setKnowledgeStatus(knowledgeRes.value);
      if (pairingRes.status === "fulfilled") setPairingState(pairingRes.value);
      if (terminalRes.status === "fulfilled" && terminalRes.value?.sessions) {
        setTerminalSessions(terminalRes.value.sessions);
      }
      if (fleetRes.status === "fulfilled") setFleetState(fleetRes.value);
      if (sessionsRes.status === "fulfilled" && Array.isArray(sessionsRes.value)) {
        setSessions(sessionsRes.value);
      }
      if (activityRes.status === "fulfilled" && Array.isArray(activityRes.value)) {
        setActivities(activityRes.value);
      }

      setLastRefreshedAt(Date.now());
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useBrokerEvents(() => {
    void loadData(true);
  });

  const processes = tailDiscovery?.processes ?? [];
  const displayedProcesses = showAllProcesses ? processes : processes.slice(0, 5);

  const harnesses = useMemo(() => {
    const counts: Record<string, { total: number; active: number }> = {};
    for (const agent of agents) {
      const h = agent.harness || "other";
      if (!counts[h]) counts[h] = { total: 0, active: 0 };
      counts[h].total += 1;
      if (agent.state === "working") counts[h].active += 1;
    }
    for (const p of processes) {
      const h = p.harness || "other";
      if (!counts[h]) counts[h] = { total: 0, active: 0 };
      counts[h].total = Math.max(counts[h].total, 1);
      counts[h].active = Math.max(counts[h].active, 1);
    }
    return counts;
  }, [agents, processes]);

  const worktreeGroups = useMemo(() => {
    const map = new Map<string, { root: string; name: string; agents: Agent[]; branches: Set<string>; processes: typeof processes }>();
    for (const agent of agents) {
      const root = agent.projectRoot || agent.cwd || "unknown";
      if (!map.has(root)) {
        map.set(root, { root, name: extractProjectName(root), agents: [], branches: new Set(), processes: [] });
      }
      const group = map.get(root)!;
      group.agents.push(agent);
      if (agent.branch) group.branches.add(agent.branch);
    }
    for (const proc of processes) {
      if (!proc.cwd) continue;
      for (const [root, group] of map.entries()) {
        if (proc.cwd.startsWith(root) || root.startsWith(proc.cwd)) {
          group.processes.push(proc);
        }
      }
    }
    return Array.from(map.values());
  }, [agents, processes]);

  // Attention & Allocation breakdown
  const attentionBreakdown = useMemo(() => {
    // Tally compute weights across worktree groups
    const totalWeights = worktreeGroups.reduce((sum, g) => sum + Math.max(1, g.agents.length + g.processes.length * 3), 0);
    const ranked = worktreeGroups
      .map((g) => {
        const weight = Math.max(1, g.agents.length + g.processes.length * 3);
        const percent = totalWeights > 0 ? Math.round((weight / totalWeights) * 100) : 0;
        return {
          ...g,
          weight,
          percent,
          primaryBranch: Array.from(g.branches)[0] || (g.name === "openscout" ? buildInfo?.gitBranch || "main" : "main"),
        };
      })
      .sort((a, b) => b.weight - a.weight);

    const topProjects = ranked.slice(0, 5);
    const topProject = ranked[0];
    const otherProjects = ranked.slice(5);
    const otherPercent = otherProjects.reduce((acc, p) => acc + p.percent, 0);

    return {
      ranked,
      topProjects,
      topProject,
      otherProjects,
      otherPercent,
      totalProjects: ranked.length,
    };
  }, [worktreeGroups, buildInfo]);

  // Dropped / Unresolved Threads analysis
  const droppedThreads = useMemo(() => {
    const items: Array<{
      id: string;
      kind: "stalled_relay" | "idle_process" | "uncommitted_branch" | "unresumed_session";
      title: string;
      subtitle: string;
      ageLabel: string;
      projectRoot?: string;
      harness?: string;
      pid?: number;
      conversationId?: string;
      ageSeconds?: number;
      severity: "warn" | "neutral" | "info";
      actionLabel: string;
      actionRoute?: Route;
    }> = [];

    // 1. Long-idle / Prompted relay processes with high etime
    for (const proc of processes) {
      if (proc.command && proc.command.includes("--append-system-prompt")) {
        const match = proc.command.match(/session-[a-zA-Z0-9_-]+/);
        const sessionId = match ? match[0] : `PID ${proc.pid}`;
        items.push({
          id: `relay-${proc.pid}`,
          kind: "stalled_relay",
          title: sessionId,
          subtitle: `Launched in ${extractProjectName(proc.cwd)} · PID ${proc.pid} · Runtime ${proc.etime || "active"}`,
          ageLabel: proc.etime || "active",
          ageSeconds: etimeSeconds(proc.etime),
          projectRoot: proc.cwd || undefined,
          harness: proc.harness,
          pid: proc.pid,
          severity: "warn",
          actionLabel: "Tail Process",
          actionRoute: { view: "ops", mode: "mission" },
        });
      }
    }

    // 2. Uncommitted or diverged project branches
    if (buildInfo?.gitBranch && buildInfo.gitBranch !== "main") {
      items.push({
        id: "branch-divergence",
        kind: "uncommitted_branch",
        title: buildInfo.gitBranch,
        subtitle: `Local worktree is ahead with uncommitted edits on ${buildInfo.runtime?.platform || "darwin"}`,
        ageLabel: "Unmerged",
        projectRoot: "/Users/art/dev/openscout",
        severity: "neutral",
        actionLabel: "Inspect Repos",
        actionRoute: { view: "repos" },
      });
    }

    // 3. Unresumed sessions with last message > 1 hour ago
    for (const s of sessions.slice(0, 4)) {
      if (s.lastMessageAt && Date.now() - s.lastMessageAt > 3600 * 1000) {
        items.push({
          id: `session-${s.id}`,
          kind: "unresumed_session",
          title: s.title || s.id,
          subtitle: `Last turn recorded ${timeAgo(s.lastMessageAt)} · ${s.messageCount} messages · ${extractProjectName(s.workspaceRoot)}`,
          ageLabel: timeAgo(s.lastMessageAt),
          ageSeconds: (Date.now() - s.lastMessageAt) / 1000,
          conversationId: s.id,
          projectRoot: s.workspaceRoot || undefined,
          harness: s.harness || undefined,
          severity: "info",
          actionLabel: "Open Chat",
          actionRoute: { view: "conversation", conversationId: s.id },
        });
      }
    }

    return items;
  }, [processes, buildInfo, sessions]);

  // Highest quota utilization
  const peakQuota = useMemo(() => {
    if (!quotas?.length) return null;
    return [...quotas].sort((a, b) => (b.fill ?? 0) - (a.fill ?? 0))[0];
  }, [quotas]);

  /* ── Derived readings ──────────────────────────────────────────────────
   * Every verdict below is computed from fetched data. Nothing falls back to
   * a literal figure: where a source is empty the reading says it is empty. */

  const attentionReading = useMemo(() => {
    const ranked = attentionBreakdown.ranked;
    if (ranked.length === 0) return null;
    const topPercent = ranked[0].percent;
    const tail = attentionBreakdown.otherProjects;
    return {
      verdict: topPercent >= 50 ? "Concentrated" : topPercent >= 25 ? "Weighted" : "Scattered",
      topPercent,
      tailPercent: attentionBreakdown.otherPercent,
      tailCount: tail.length,
      tailAgents: tail.reduce((acc, p) => acc + p.agents.length, 0),
      tailProcesses: tail.reduce((acc, p) => acc + p.processes.length, 0),
      aboveTen: ranked.filter((p) => p.percent >= 10).length,
    };
  }, [attentionBreakdown]);

  const unattendedReading = useMemo(() => {
    const byKind = droppedThreads.reduce<Record<string, number>>((acc, item) => {
      acc[item.kind] = (acc[item.kind] ?? 0) + 1;
      return acc;
    }, {});
    const oldest = droppedThreads
      .map((item) => item.ageSeconds)
      .filter((s): s is number => typeof s === "number")
      .sort((left, right) => right - left)[0];
    return {
      verdict: droppedThreads.length === 0
        ? "Nothing unattended"
        : `${droppedThreads.length} unattended`,
      byKind,
      oldestLabel: oldest ? formatDuration(oldest) : null,
    };
  }, [droppedThreads]);

  const budgetReading = useMemo(() => readBudgetSection(quotas), [quotas]);

  const subsystems = useMemo((): SubsystemReading[] => {
    const ptySockets = terminalSessions.length;
    const indexed = knowledgeStatus?.indexedSessions ?? 0;
    const peers = pairingState?.trustedPeerCount ?? 0;
    const brokerEndpoint = hostInfo?.brokerUrl
      || (hostInfo?.ports?.broker ? `127.0.0.1:${hostInfo.ports.broker}` : null);

    return [
      {
        key: "broker",
        label: "broker",
        detail: brokerEndpoint
          ? [brokerEndpoint, hostInfo?.brokerSocketPath ? basenameOf(hostInfo.brokerSocketPath) : null]
            .filter(Boolean).join(" · ")
          : "endpoint not reported",
        state: brokerEndpoint ? "UP" : "UNKNOWN",
        tone: brokerEndpoint ? "ok" : "unknown",
      },
      {
        key: "pty",
        label: "pty relay",
        detail: ptySockets > 0
          ? `${ptySockets} socket${ptySockets === 1 ? "" : "s"}`
          : "0 sockets · latency unmeasured",
        state: ptySockets > 0 ? "ACTIVE" : "IDLE",
        tone: ptySockets > 0 ? "ok" : "idle",
      },
      {
        key: "knowledge",
        label: "knowledge",
        detail: indexed > 0
          ? `${indexed.toLocaleString()} transcript${indexed === 1 ? "" : "s"} indexed`
          : "0 transcripts indexed",
        state: indexed > 0 ? "INDEXED" : "EMPTY",
        tone: indexed > 0 ? "ok" : "warn",
        action: indexed > 0 ? undefined : { label: "Index", route: { view: "search" } as Route },
      },
      {
        key: "mesh",
        label: "mesh",
        detail: peers > 0
          ? `${peers} trusted peer${peers === 1 ? "" : "s"} · scope ${hostInfo?.advertiseScope || "mesh"}`
          : `no trusted peers · scope ${hostInfo?.advertiseScope || "mesh"}`,
        state: peers > 0 ? "PAIRED" : "UNPAIRED",
        tone: peers > 0 ? "ok" : "idle",
      },
    ];
  }, [hostInfo, terminalSessions, knowledgeStatus, pairingState]);

  const subsystemSummary = useMemo(() => {
    const counts = subsystems.reduce<Record<string, number>>((acc, item) => {
      acc[item.tone] = (acc[item.tone] ?? 0) + 1;
      return acc;
    }, {});
    const flagged = subsystems.filter((item) => item.tone === "warn");
    return {
      verdict: flagged.length > 0
        ? `${flagged.length} ${flagged.length === 1 ? "needs" : "need"} attention`
        : "All nominal",
      figures: [
        counts.ok ? `${counts.ok} up` : null,
        counts.idle ? `${counts.idle} idle` : null,
        counts.warn ? `${counts.warn} empty` : null,
        counts.unknown ? `${counts.unknown} unknown` : null,
      ].filter(Boolean).join(" · "),
    };
  }, [subsystems]);

  const hostNodeName = hostInfo?.nodeName || hostInfo?.hostName || "Host Node";
  const platformStr = buildInfo?.runtime
    ? `${buildInfo.runtime.platform} ${buildInfo.runtime.arch} · ${buildInfo.runtime.engine} ${buildInfo.runtime.engineVersion}`
    : "Darwin arm64";

  return (
    <div className="s-host-view">
      {/* ── 1. Host Masthead & Mode Switcher ─────────────────────────── */}
      <header className="s-host-header">
        <div className="s-host-header-left">
          <div className="s-host-header-status-line">
            <span className="dot dot--sm dot--working dot--pulse" aria-hidden="true" />
            <span className="label-xs s-host-mono-dim">NODE: {hostInfo?.nodeId || "local"}</span>
            <span className="s-host-header-divider">/</span>
            <span className="label-xs s-host-mono-dim">{platformStr}</span>
            {buildInfo?.gitHash && (
              <>
                <span className="s-host-header-divider">/</span>
                <span className="label-xs s-host-mono-dim">git:{buildInfo.gitHash.slice(0, 7)}</span>
              </>
            )}
          </div>
          <h1 className="s-host-title">
            <Compass size={22} className="s-host-title-icon" />
            <span>Host Advisor</span>
          </h1>
        </div>

        <div className="s-host-header-right">
          <div className="s-host-mode-toggle" role="group" aria-label="Advisor Format">
            <button
              type="button"
              className={`s-host-mode-btn ${displayMode === "inquiry" ? "s-host-mode-btn--active" : ""}`}
              onClick={() => setDisplayMode("inquiry")}
              title="Formatted Executive Inquiries & Operator Answers"
            >
              <FileText size={12} />
              <span>Inquiries</span>
            </button>
            <button
              type="button"
              className={`s-host-mode-btn ${displayMode === "matrix" ? "s-host-mode-btn--active" : ""}`}
              onClick={() => setDisplayMode("matrix")}
              title="Compact Infrastructure Matrix"
            >
              <LayoutGrid size={12} />
              <span>Matrix</span>
            </button>
          </div>

          <button
            type="button"
            className={`btn btn--sm ${refreshing ? "btn--accent" : ""}`}
            disabled={refreshing}
            onClick={() => void loadData(true)}
          >
            <RefreshCw size={12} className={refreshing ? "s-spin" : ""} />
            <span>{refreshing ? "Scanning..." : "Refresh"}</span>
          </button>
        </div>
      </header>

      {/* ── 2. Readouts: noun, figure, qualifier ─────────────────────── */}
      <section className="s-host-readouts" aria-label="Host Readouts">
        <div className="s-host-readout">
          <span className="label-xs s-host-readout-label">AGENTS</span>
          <span className="s-host-readout-figure">{agents.length}</span>
          <span className="label-xs s-host-readout-qual">
            {processes.length} PROCESS{processes.length === 1 ? "" : "ES"}
          </span>
        </div>

        <div className="s-host-readout">
          <span className="label-xs s-host-readout-label">ROOTS</span>
          <span className="s-host-readout-figure">{worktreeGroups.length}</span>
          <span className="label-xs s-host-readout-qual">
            {attentionReading ? `TOP SHARE ${attentionReading.topPercent}%` : "NONE ACTIVE"}
          </span>
        </div>

        <div className={`s-host-readout ${peakQuota && isNearCeiling(peakQuota) ? "s-host-readout--warn" : ""}`}>
          <span className="label-xs s-host-readout-label">PEAK BUDGET</span>
          <span className="s-host-readout-figure">
            {peakQuota ? `${Math.round((peakQuota.fill ?? 0) * 100)}%` : "—"}
          </span>
          <span className="label-xs s-host-readout-qual">
            {peakQuota
              ? `${peakQuota.label}${peakQuota.resetAt ? ` · RESET ${timeAgo(peakQuota.resetAt)}` : ""}`
              : "NO PROVIDERS CONFIGURED"}
          </span>
        </div>

        <div className={`s-host-readout ${droppedThreads.length > 0 ? "s-host-readout--flag" : ""}`}>
          <span className="label-xs s-host-readout-label">UNATTENDED</span>
          <span className="s-host-readout-figure">{droppedThreads.length}</span>
          <span className="label-xs s-host-readout-qual">
            {unattendedReading.oldestLabel ? `OLDEST ${unattendedReading.oldestLabel}` : "NONE OPEN"}
          </span>
        </div>

        <div className="s-host-readout">
          <span className="label-xs s-host-readout-label">MESH PEERS</span>
          <span className="s-host-readout-figure">{pairingState?.trustedPeerCount ?? 0}</span>
          <span className="label-xs s-host-readout-qual">
            SCOPE {(hostInfo?.advertiseScope || "mesh").toUpperCase()}
          </span>
        </div>
      </section>

      {/* ── MODE A: Readings ─────────────────────────────────────────── */}
      {displayMode === "inquiry" ? (
        <div className="s-host-readings" aria-label="Host Readings">

          {/* ── 01 ATTENTION ──────────────────────────────────────────── */}
          <article className="s-host-reading">
            <div className="s-host-reading-head">
              <span className="label-xs s-host-reading-num">01 // ATTENTION</span>
              <span className="s-host-reading-verdict">
                {attentionReading?.verdict ?? "No active roots"}
              </span>
              <span className="s-host-reading-figures">
                {attentionReading ? (
                  <>
                    top {attentionReading.topPercent}%
                    <span className="s-host-sep">·</span>
                    tail {attentionReading.tailPercent}%
                    <span className="s-host-sep">·</span>
                    {attentionReading.aboveTen} root{attentionReading.aboveTen === 1 ? "" : "s"} above 10%
                  </>
                ) : (
                  <>no agents or processes bound to a workspace</>
                )}
              </span>
              <button type="button" className="btn btn--sm" onClick={() => navigate({ view: "repos" })}>
                <span>Repos</span>
                <ArrowUpRight size={10} />
              </button>
            </div>

            {attentionBreakdown.ranked.length > 0 && (
              <>
                <div className="s-host-share-bar">
                  {attentionBreakdown.topProjects.map((project, index) => (
                    <div
                      key={project.root}
                      className={`s-host-share-seg s-host-share-seg--${Math.min(index, 4)}`}
                      style={{ width: `${project.percent}%` }}
                      title={`${project.name} ${project.percent}%`}
                    >
                      <span className="s-host-share-seg-label font-mono text-2xs">
                        {project.name} {project.percent}%
                      </span>
                    </div>
                  ))}
                  {attentionReading && attentionReading.tailCount > 0 && (
                    <div className="s-host-share-seg s-host-share-seg--tail" style={{ flex: 1 }}>
                      <span className="s-host-share-seg-label font-mono text-2xs">
                        {attentionReading.tailCount} OTHER ROOTS — {attentionReading.tailPercent}%
                      </span>
                    </div>
                  )}
                </div>

                <div className="s-host-rack s-host-rack--roots">
                  <div className="s-host-rack-row s-host-rack-row--head">
                    <span className="label-xs">ROOT</span>
                    <span className="label-xs">SHARE</span>
                    <span className="label-xs s-host-rack-right">PCT</span>
                    <span className="label-xs s-host-rack-right">AGENTS</span>
                    <span className="label-xs s-host-rack-right">PROCS</span>
                    <span className="label-xs s-host-rack-right">BRANCH</span>
                  </div>

                  {attentionBreakdown.topProjects.map((project) => (
                    <div key={project.root} className="s-host-rack-row">
                      <span className="s-host-rack-name font-mono">{project.name}</span>
                      <span className="s-host-rack-track">
                        <span
                          className="s-host-rack-fill"
                          style={{
                            width: `${attentionReading && attentionReading.topPercent > 0
                              ? Math.round((project.percent / attentionReading.topPercent) * 100)
                              : 0}%`,
                          }}
                        />
                      </span>
                      <span className="s-host-rack-right font-mono">{project.percent}%</span>
                      <span className="s-host-rack-right s-host-rack-dim font-mono">{project.agents.length}</span>
                      <span className="s-host-rack-right s-host-rack-dim font-mono">{project.processes.length}</span>
                      <span className="s-host-rack-right s-host-rack-dim font-mono s-host-rack-truncate">
                        {project.primaryBranch}
                      </span>
                    </div>
                  ))}

                  {attentionReading && attentionReading.tailCount > 0 && (
                    <div className="s-host-rack-row s-host-rack-row--tail">
                      <span className="s-host-rack-name font-mono">tail — {attentionReading.tailCount} roots</span>
                      <span className="s-host-rack-track s-host-rack-track--hatch" />
                      <span className="s-host-rack-right font-mono">{attentionReading.tailPercent}%</span>
                      <span className="s-host-rack-right s-host-rack-dim font-mono">{attentionReading.tailAgents}</span>
                      <span className="s-host-rack-right s-host-rack-dim font-mono">{attentionReading.tailProcesses}</span>
                      <span className="s-host-rack-right s-host-rack-dim font-mono">each below {attentionBreakdown.topProjects.at(-1)?.percent ?? 0}%</span>
                    </div>
                  )}
                </div>
              </>
            )}
          </article>

          {/* ── 02 UNATTENDED ─────────────────────────────────────────── */}
          <article className="s-host-reading">
            <div className="s-host-reading-head">
              <span className="label-xs s-host-reading-num">02 // UNATTENDED</span>
              <span className="s-host-reading-verdict">{unattendedReading.verdict}</span>
              <span className="s-host-reading-figures">
                {droppedThreads.length > 0 ? (
                  <>
                    {unattendedReading.oldestLabel && (
                      <>
                        oldest {unattendedReading.oldestLabel}
                        <span className="s-host-sep">·</span>
                      </>
                    )}
                    {Object.entries(unattendedReading.byKind)
                      .map(([kind, count]) => `${count} ${UNATTENDED_KIND_LABEL[kind] ?? kind}`)
                      .join(" · ")}
                    <span className="s-host-sep">·</span>
                    of {processes.length} processes
                  </>
                ) : (
                  <>no idle relays, diverged branches or stale conversations</>
                )}
              </span>
            </div>

            {droppedThreads.length > 0 && (
              <div className="s-host-rack s-host-rack--unattended">
                <div className="s-host-rack-row s-host-rack-row--head">
                  <span className="label-xs" />
                  <span className="label-xs">SIGNAL</span>
                  <span className="label-xs">ROOT</span>
                  <span className="label-xs s-host-rack-right">REF</span>
                  <span className="label-xs s-host-rack-right">AGE</span>
                  <span className="label-xs s-host-rack-right">ACTION</span>
                </div>

                {droppedThreads.map((item) => (
                  <div key={item.id} className="s-host-rack-row">
                    <span
                      className={`dot dot--sm ${item.severity === "warn" ? "dot--warning" : "dot--neutral"}`}
                      aria-hidden="true"
                    />
                    <span className="s-host-rack-name font-mono s-host-rack-truncate">{item.title}</span>
                    <span className="s-host-rack-dim font-mono s-host-rack-truncate">
                      {item.projectRoot ? extractProjectName(item.projectRoot) : "—"}
                    </span>
                    <span className="s-host-rack-right s-host-rack-dim font-mono">
                      {item.pid ? `pid ${item.pid}` : UNATTENDED_KIND_LABEL[item.kind] ?? item.kind}
                    </span>
                    <span
                      className={`s-host-rack-right font-mono s-host-rack-age ${item.severity === "warn" ? "s-host-rack-age--warn" : ""}`}
                    >
                      {item.ageSeconds ? formatDuration(item.ageSeconds) : item.ageLabel}
                    </span>
                    <span className="s-host-rack-right s-host-rack-actions">
                      {item.actionRoute && (
                        <button
                          type="button"
                          className="btn btn--sm"
                          onClick={() => item.actionRoute && navigate(item.actionRoute)}
                        >
                          {item.actionLabel}
                        </button>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </article>

          {/* ── 03 BUDGETS ────────────────────────────────────────────── */}
          <article className="s-host-reading">
            <div className="s-host-reading-head">
              <span className="label-xs s-host-reading-num">03 // BUDGETS</span>
              <span className="s-host-reading-verdict">{budgetReading.verdict}</span>
              <span className="s-host-reading-figures">{budgetReading.figures}</span>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => navigate({ view: "harnesses" })}
              >
                <span>Providers</span>
                <ArrowUpRight size={10} />
              </button>
            </div>

            {budgetReading.showGauges && quotas && (
              <div className="s-host-rack s-host-rack--budgets">
                <div className="s-host-rack-row s-host-rack-row--head">
                  <span className="label-xs">PROVIDER</span>
                  <span className="label-xs">GAUGE</span>
                  <span className="label-xs s-host-rack-right">PCT</span>
                  <span className="label-xs s-host-rack-right">NOTE</span>
                </div>

                {quotas.map((gauge) => (
                  <BudgetGaugeRow key={gauge.id} gauge={gauge} />
                ))}
              </div>
            )}
          </article>

          {/* ── 04 SUBSYSTEMS ─────────────────────────────────────────── */}
          <article className="s-host-reading">
            <div className="s-host-reading-head">
              <span className="label-xs s-host-reading-num">04 // SUBSYSTEMS</span>
              <span className="s-host-reading-verdict">{subsystemSummary.verdict}</span>
              <span className="s-host-reading-figures">{subsystemSummary.figures}</span>
            </div>

            <div className="s-host-rack s-host-rack--subsystems">
              <div className="s-host-rack-row s-host-rack-row--head">
                <span className="label-xs" />
                <span className="label-xs">SUBSYSTEM</span>
                <span className="label-xs">DETAIL</span>
                <span className="label-xs s-host-rack-right">STATE</span>
              </div>

              {subsystems.map((item) => (
                <div key={item.key} className="s-host-rack-row">
                  <span className={`dot dot--sm s-host-dot--${item.tone}`} aria-hidden="true" />
                  <span className="s-host-rack-name font-mono">{item.label}</span>
                  <span className="s-host-rack-dim font-mono s-host-rack-truncate">{item.detail}</span>
                  <span className="s-host-rack-right s-host-rack-actions">
                    {item.action && (
                      <button
                        type="button"
                        className="btn btn--sm s-host-btn-accent"
                        onClick={() => item.action && navigate(item.action.route)}
                      >
                        {item.action.label}
                      </button>
                    )}
                    <span className={`chip chip--sm chip--mono s-host-state s-host-state--${item.tone}`}>
                      {item.state}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </article>
        </div>
      ) : (
        /* ── MODE B: Compact Subsystem Matrix ────────────────────────── */
        <div className="s-host-matrix-container">
          <section className="s-host-telemetry-grid" aria-label="Host Telemetry Overview">
            <div className="s-host-stat-box">
              <div className="s-host-stat-head">
                <span className="label-xs s-host-stat-label">REGISTERED AGENTS</span>
                <Cpu size={13} className="s-host-stat-icon" />
              </div>
              <div className="s-host-stat-body">
                <span className="s-host-stat-big">{agents.length}</span>
                <span className="s-host-stat-kicker">{processes.length} background processes</span>
              </div>
            </div>

            <div className="s-host-stat-box">
              <div className="s-host-stat-head">
                <span className="label-xs s-host-stat-label">SERVICE QUOTA RADAR</span>
                <Gauge size={13} className="s-host-stat-icon" />
              </div>
              <div className="s-host-stat-body">
                <span className="s-host-stat-big">
                  {peakQuota ? `${Math.round((peakQuota.fill ?? 0) * 100)}%` : "Nominal"}
                </span>
                <span className="s-host-stat-kicker">peak token consumption</span>
              </div>
            </div>

            <div className="s-host-stat-box">
              <div className="s-host-stat-head">
                <span className="label-xs s-host-stat-label">WORKSPACES & REPOS</span>
                <FolderGit2 size={13} className="s-host-stat-icon" />
              </div>
              <div className="s-host-stat-body">
                <span className="s-host-stat-big">{worktreeGroups.length}</span>
                <span className="s-host-stat-kicker">registered project roots</span>
              </div>
            </div>

            <div className="s-host-stat-box">
              <div className="s-host-stat-head">
                <span className="label-xs s-host-stat-label">SUBSYSTEM RELAYS</span>
                <Database size={13} className="s-host-stat-icon" />
              </div>
              <div className="s-host-stat-body">
                <span className="s-host-stat-big">{terminalSessions.length}</span>
                <span className="s-host-stat-kicker">live terminal relays</span>
              </div>
            </div>
          </section>

          <section className="s-host-block" aria-label="Active Processes">
            <div className="s-host-block-head">
              <span className="label-xs">ACTIVE HARNESS PROCESSES ({processes.length})</span>
            </div>
            <div className="s-host-table-box">
              <div className="s-host-table">
                {displayedProcesses.map((proc) => (
                  <div key={proc.pid} className="s-host-table-row">
                    <div className="s-host-table-cell-main">
                      <span className="dot dot--sm dot--working dot--pulse" aria-hidden="true" />
                      <HarnessMark harness={proc.harness} size={13} />
                      <span className="font-semibold text-xs font-mono">
                        {formatProcessCommand(proc.command, proc.harness)}
                      </span>
                      <span className="chip chip--sm chip--ghost chip--mono">PID {proc.pid}</span>
                      {proc.etime && <span className="chip chip--sm chip--ghost chip--mono">{proc.etime}</span>}
                    </div>
                    <div className="s-host-table-cell-action">
                      <button
                        type="button"
                        className="btn btn--sm"
                        onClick={() => navigate({ view: "ops", mode: "mission" })}
                      >
                        <span>Tail</span>
                        <ArrowUpRight size={10} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
