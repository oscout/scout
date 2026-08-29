import { useCallback, useEffect, useState } from "react";
import "../../scout/slots/ctx-panel.css";
import {
  Activity,
  Cpu,
  Database,
  FolderGit2,
  Gauge,
  Layers,
  Server,
  Sparkles,
  Terminal,
} from "lucide-react";
import { api } from "../../lib/api.ts";
import { useBrokerEvents } from "../../lib/sse.ts";
import { useScout } from "../../scout/Provider.tsx";
import type { Route, TailDiscoverySnapshot } from "../../lib/types.ts";

export function OpsAdvisorLeft() {
  const { agents, navigate } = useScout();
  const [tailDiscovery, setTailDiscovery] = useState<TailDiscoverySnapshot | null>(null);
  const [quotas, setQuotas] = useState<{ fill?: number; label: string }[]>([]);

  const load = useCallback(async () => {
    const [tailRes, quotaRes] = await Promise.allSettled([
      api<TailDiscoverySnapshot>("/api/tail/discover"),
      api<{ gauges: { fill?: number; label: string }[] }>("/api/service-budgets"),
    ]);
    if (tailRes.status === "fulfilled") setTailDiscovery(tailRes.value);
    if (quotaRes.status === "fulfilled" && quotaRes.value?.gauges) {
      setQuotas(quotaRes.value.gauges);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useBrokerEvents(() => {
    void load();
  });

  const processes = tailDiscovery?.processes ?? [];
  const activeProcs = processes;
  const peakQuota = quotas.length > 0
    ? Math.round(Math.max(...quotas.map((q) => q.fill ?? 0)) * 100)
    : 100;

  return (
    <div className="s-advisor-left-nav">
      <div className="s-ctx-panel-section">
        <div className="s-ctx-panel-head">
          <Server size={14} className="s-ctx-icon" />
          <span className="label-xs">HOST TELEMETRY</span>
        </div>

        <div className="s-ctx-stat-list">
          <div className="s-ctx-stat-item">
            <span className="label-xs s-ctx-stat-label">Agents Connected</span>
            <span className="chip chip--sm chip--mono">{agents.length}</span>
          </div>
          <div className="s-ctx-stat-item">
            <span className="label-xs s-ctx-stat-label">Active Processes</span>
            <span className="chip chip--sm chip--working chip--mono">{activeProcs.length}</span>
          </div>
          <div className="s-ctx-stat-item">
            <span className="label-xs s-ctx-stat-label">Peak Quota</span>
            <span className={`chip chip--sm chip--mono ${peakQuota > 80 ? "chip--warning" : "chip--working"}`}>
              {peakQuota}%
            </span>
          </div>
        </div>
      </div>

      <div className="s-ctx-panel-section">
        <div className="s-ctx-panel-head">
          <Layers size={14} className="s-ctx-icon" />
          <span className="label-xs">OPERATIONS SURFACES</span>
        </div>

        <div className="s-ctx-nav-list">
          <button
            type="button"
            className="s-ctx-nav-btn s-ctx-nav-btn--active"
            onClick={() => navigate({ view: "ops", mode: "advisor" })}
          >
            <Sparkles size={13} />
            <span>Host Advisor</span>
          </button>
          <button
            type="button"
            className="s-ctx-nav-btn"
            onClick={() => navigate({ view: "ops", mode: "mission" })}
          >
            <Activity size={13} />
            <span>Mission Control</span>
          </button>
          <button
            type="button"
            className="s-ctx-nav-btn"
            onClick={() => navigate({ view: "ops", mode: "lanes" })}
          >
            <Cpu size={13} />
            <span>Agent Lanes</span>
          </button>
          <button
            type="button"
            className="s-ctx-nav-btn"
            onClick={() => navigate({ view: "harnesses" })}
          >
            <Gauge size={13} />
            <span>Agent Providers & Quotas</span>
          </button>
          <button
            type="button"
            className="s-ctx-nav-btn"
            onClick={() => navigate({ view: "terminal" })}
          >
            <Terminal size={13} />
            <span>Terminal Relays</span>
          </button>
          <button
            type="button"
            className="s-ctx-nav-btn"
            onClick={() => navigate({ view: "search" })}
          >
            <Database size={13} />
            <span>Knowledge Indexer</span>
          </button>
        </div>
      </div>
    </div>
  );
}
