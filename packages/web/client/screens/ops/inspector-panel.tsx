import { Check, Copy, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useScout } from "../../scout/Provider.tsx";
import { openAgent } from "../../scout/slots/openAgent.ts";
import { openContent } from "../../scout/slots/openContent.ts";
import {
  agentStateCssToken,
  agentStateLabel,
  isAgentBusy,
  isAgentOnline,
  normalizeAgentState,
} from "../../lib/agent-state.ts";
import { api } from "../../lib/api.ts";
import { copyTextToClipboard } from "../../lib/clipboard.ts";
import { routeForFleetAsk, routeForOperatorAttention } from "../../lib/operator-attention.ts";
import { useBrokerEvents } from "../../lib/sse.ts";
import { timeAgo } from "../../lib/time.ts";
import type {
  Agent,
  AgentRun,
  FleetAsk,
  FleetAttentionItem,
  FleetState,
  OpsMode,
  Route,
  SessionEntry,
  WorkItem,
} from "../../lib/types.ts";
import type { BuildInfo, HostInfo } from "./HostAdvisorView.tsx";

type OpsDetailSnapshot = {
  source?: "tail" | "generic";
  focus: "flow" | "item";
  title: string;
  meta: string;
  body: string;
  metadata?: Array<{ label: string; value: string }>;
  copy?: Array<{ label: string; value: string }>;
  action: { label: string; route: Route } | null;
};

const OPS_MODE_LABELS: Record<OpsMode, string> = {
  mission: "Control",
  advisor: "Host Advisor",
  issues: "Alerts",
  tail: "Tail",
  atop: "Runtime",
  agents: "Agents",
  lanes: "Lanes",
};

export function OpsInspectorPanel({
  mode,
  agents,
  navigate,
  returnRoute,
}: {
  mode: OpsMode;
  agents: Agent[];
  navigate: (route: Route) => void;
  returnRoute: Route;
}) {
  const [fleet, setFleet] = useState<FleetState | null>(null);
  const [detail, setDetail] = useState<OpsDetailSnapshot | null>(() => {
    if (typeof window === "undefined") return null;
    const target = window as typeof window & { scoutOpsDetailSnapshot?: unknown };
    return parseOpsDetailSnapshot(target.scoutOpsDetailSnapshot);
  });

  const load = useCallback(async () => {
    const data = await api<FleetState>("/api/fleet").catch(() => null);
    setFleet(data);
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const onDetail = (event: Event) => {
      setDetail(parseOpsDetailSnapshot((event as CustomEvent<unknown>).detail));
    };
    window.addEventListener("scout:ops-detail", onDetail);
    return () => window.removeEventListener("scout:ops-detail", onDetail);
  }, []);

  useBrokerEvents((event) => {
    if (
      event.kind === "message.posted" ||
      event.kind === "flight.updated" ||
      event.kind === "collaboration.event.appended"
    ) {
      void load();
    }
  });

  if (mode === "advisor") {
    return <HostAdvisorInspectorPanel navigate={navigate} />;
  }

  if (mode === "tail" || mode === "issues") {
    return (
      <OpsTailInspectorPanel
        detail={detail?.source === "tail" ? detail : null}
        mode={mode}
        navigate={navigate}
      />
    );
  }

  const activeAsks = (fleet?.activeAsks ?? []).filter((ask) => ask.status !== "needs_attention");
  const needsAttention = fleet?.needsAttention ?? [];

  if (mode === "lanes") {
    return null;
  }

  const workingAgents = agents.filter((agent) => isAgentBusy(agent.state));
  const onlineAgents = agents.filter((agent) => isAgentOnline(agent.state));
  const recentAgents = [...agents]
    .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
    .slice(0, 7);

  return (
    <div className="ctx-panel ctx-panel--ops-inspector">
      {detail && (
        <section className="ctx-panel-section ctx-panel-selected-detail">
          <div className="ctx-panel-section-label">
            {detail.focus === "flow" ? "Message" : "Selection"}
          </div>
          <div className="ctx-panel-selected-card">
            <div className="ctx-panel-selected-title">{detail.title}</div>
            <div className="ctx-panel-selected-meta">{detail.meta}</div>
            <div className="ctx-panel-selected-body">{detail.body}</div>
            {detail.action && (
              <button
                type="button"
                className="ctx-panel-selected-action"
                onClick={() => navigate(detail.action!.route)}
              >
                {detail.action.label}
              </button>
            )}
          </div>
        </section>
      )}

      <section className="ctx-panel-section ctx-panel-ops-summary">
        <div className="ctx-panel-section-label">Ops Context</div>
        <div className="ctx-panel-ops-mode-card">
          <span>Current</span>
          <strong>{OPS_MODE_LABELS[mode]}</strong>
          <small>{fleet ? `${timeAgo(fleet.generatedAt)} refresh` : "loading"}</small>
        </div>
        <div className="ctx-panel-stat-grid">
          <OpsStat label="Needs" value={needsAttention.length} tone={needsAttention.length > 0 ? "warn" : "ok"} />
          <OpsStat label="Active" value={activeAsks.length} />
          <OpsStat label="Online" value={`${onlineAgents.length}/${agents.length}`} />
          <OpsStat label="Working" value={workingAgents.length} />
        </div>
      </section>

      <section className="ctx-panel-section">
        <div className="ctx-panel-section-label">
          Queue
          {needsAttention.length > 0 && <span className="ctx-panel-count">{needsAttention.length}</span>}
        </div>
        {needsAttention.length === 0 ? (
          <div className="ctx-panel-empty">No operator cues</div>
        ) : (
          <div className="ctx-panel-list">
            {needsAttention.slice(0, 5).map((item) => (
              <OpsAttentionButton key={item.recordId} item={item} navigate={navigate} />
            ))}
          </div>
        )}
      </section>

      <section className="ctx-panel-section">
        <div className="ctx-panel-section-label">
          Runs
          {activeAsks.length > 0 && <span className="ctx-panel-count">{activeAsks.length}</span>}
        </div>
        {activeAsks.length === 0 ? (
          <div className="ctx-panel-empty">No active requests</div>
        ) : (
          <div className="ctx-panel-list">
            {activeAsks.slice(0, 5).map((ask) => (
              <OpsAskButton key={ask.invocationId} ask={ask} navigate={navigate} />
            ))}
          </div>
        )}
      </section>

      <section className="ctx-panel-section">
        <div className="ctx-panel-section-label">
          Recent activity
          {recentAgents.length > 0 && <span className="ctx-panel-count">{recentAgents.length}</span>}
        </div>
        <div className="ctx-panel-pulse-list">
          {recentAgents.map((agent) => (
            <button
              key={agent.id}
              type="button"
              className="ctx-panel-pulse-row"
              onClick={() => openAgent(navigate, agent, { from: "inspector", returnTo: returnRoute })}
            >
              <span className={`ctx-panel-pulse-dot ctx-panel-pulse-dot--${agentStateCssToken(agent.state)}`} />
              <span>{agent.name}</span>
              <small>{agentStateLabel(agent.state)} · {agent.updatedAt ? timeAgo(agent.updatedAt) : "unknown"}</small>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function clearOpsDetailSnapshot() {
  if (typeof window === "undefined") return;
  const target = window as typeof window & { scoutOpsDetailSnapshot?: unknown };
  target.scoutOpsDetailSnapshot = null;
  window.dispatchEvent(new CustomEvent("scout:ops-detail", { detail: null }));
}

function OpsTailInspectorPanel({
  detail,
  mode,
  navigate,
}: {
  detail: OpsDetailSnapshot | null;
  mode: OpsMode;
  navigate: (route: Route) => void;
}) {
  const label = mode === "issues" ? "Alert detail" : "Tail detail";
  const messageCopy = detail?.copy?.find((action) => action.label === "Copy message")?.value ?? detail?.body ?? "";
  const metadataCopy = detail?.copy?.find((action) => action.label === "Copy metadata")?.value
    ?? detail?.metadata?.map((row) => `${row.label}: ${row.value}`).join("\n")
    ?? "";

  return (
    <div className="ctx-panel ctx-panel--ops-inspector ctx-panel--tail-inspector">
      <section className="ctx-panel-section ctx-panel-tail-detail">
        <div className="ctx-panel-section-label ctx-panel-tail-detail-label">
          <span>{label}</span>
          {detail && (
            <button
              type="button"
              className="ctx-panel-tail-icon-button"
              onClick={clearOpsDetailSnapshot}
              aria-label="Clear Tail detail"
              title="Clear"
            >
              <X size={13} strokeWidth={2} aria-hidden="true" />
            </button>
          )}
        </div>

        {detail ? (
          <div className="ctx-panel-tail-card">
            <div className="ctx-panel-tail-card-head">
              <div className="ctx-panel-tail-card-title">{detail.title}</div>
              <div className="ctx-panel-tail-card-meta">{detail.meta}</div>
            </div>

            {detail.metadata && detail.metadata.length > 0 && (
              <div className="ctx-panel-tail-copy-scope">
                <dl className="ctx-panel-tail-metadata">
                  {detail.metadata.map((row) => (
                    <div key={row.label} className="ctx-panel-tail-metadata-row">
                      <dt>{row.label}</dt>
                      <dd title={row.value}>{row.value}</dd>
                    </div>
                  ))}
                </dl>
                {metadataCopy && <OpsHoverCopyButton label="Copy metadata" value={metadataCopy} />}
              </div>
            )}

            {detail.action && (
              <div className="ctx-panel-tail-actions">
                <button
                  type="button"
                  className="ctx-panel-tail-action-button"
                  onClick={() => navigate(detail.action!.route)}
                >
                  {detail.action.label}
                </button>
              </div>
            )}

            <div className="ctx-panel-tail-copy-scope ctx-panel-tail-copy-scope--message">
              <div className="ctx-panel-tail-message">{detail.body}</div>
              {messageCopy && <OpsHoverCopyButton label="Copy message" value={messageCopy} />}
            </div>
          </div>
        ) : (
          <div className="ctx-panel-tail-empty-card">
            <span>Tail</span>
            <strong>No log selected</strong>
          </div>
        )}
      </section>
    </div>
  );
}

function OpsHoverCopyButton({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current != null) window.clearTimeout(timeoutRef.current);
    };
  }, []);

  const onCopy = useCallback(async () => {
    const ok = await copyTextToClipboard(value);
    if (!ok) return;
    setCopied(true);
    if (timeoutRef.current != null) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = window.setTimeout(() => setCopied(false), 1200);
  }, [value]);

  return (
    <button
      type="button"
      className={`ctx-panel-tail-hover-copy${copied ? " ctx-panel-tail-hover-copy--copied" : ""}`}
      onClick={() => void onCopy()}
      title={label}
    >
      {copied ? (
        <Check size={13} strokeWidth={2} aria-hidden="true" />
      ) : (
        <Copy size={13} strokeWidth={1.9} aria-hidden="true" />
      )}
      <span>{copied ? "Copied" : label}</span>
    </button>
  );
}

function HostAdvisorInspectorPanel({
  navigate,
}: {
  navigate: (route: Route) => void;
}) {
  const [hostInfo, setHostInfo] = useState<HostInfo | null>(null);
  const [buildInfo, setBuildInfo] = useState<BuildInfo | null>(null);

  useEffect(() => {
    Promise.allSettled([
      api<HostInfo>("/.host-info"),
      api<BuildInfo>("/api/build"),
    ]).then(([h, b]) => {
      if (h.status === "fulfilled") setHostInfo(h.value);
      if (b.status === "fulfilled") setBuildInfo(b.value);
    });
  }, []);

  return (
    <div className="ctx-panel ctx-panel--ops-inspector ctx-panel--plan-inspector">
      <section className="ctx-panel-section ctx-panel-ops-summary">
        <div className="ctx-panel-section-label">Host Telemetry</div>
        <div className="ctx-panel-summary-card">
          <div className="ctx-panel-summary-title">{hostInfo?.nodeName || "Local Host"}</div>
          <div className="ctx-panel-summary-kicker">
            Node: {hostInfo?.nodeId || "local"}
          </div>
          <div className="ctx-panel-summary-meta">
            <span>{buildInfo?.runtime?.platform || "darwin"} {buildInfo?.runtime?.arch || "arm64"}</span>
            {buildInfo?.gitBranch && <span>branch: {buildInfo.gitBranch}</span>}
          </div>
        </div>
      </section>

      <section className="ctx-panel-section">
        <div className="ctx-panel-section-label">Host Endpoints</div>
        <div className="ctx-panel-metric-stack">
          <div className="ctx-panel-metric-row">
            <span className="ctx-panel-metric-label">Broker Port</span>
            <span className="ctx-panel-metric-value">{hostInfo?.ports?.broker ?? 43110}</span>
          </div>
          <div className="ctx-panel-metric-row">
            <span className="ctx-panel-metric-label">Web UI Port</span>
            <span className="ctx-panel-metric-value">{hostInfo?.ports?.web ?? 43120}</span>
          </div>
          <div className="ctx-panel-metric-row">
            <span className="ctx-panel-metric-label">Advertise Scope</span>
            <span className="ctx-panel-metric-value">{hostInfo?.advertiseScope || "mesh"}</span>
          </div>
        </div>
      </section>

      <section className="ctx-panel-section">
        <div className="ctx-panel-section-label">Quick Actions</div>
        <div className="ctx-panel-stack">
          <button
            type="button"
            className="ctx-panel-action-btn"
            onClick={() => navigate({ view: "ops", mode: "mission" })}
          >
            Mission Control Wall →
          </button>
          <button
            type="button"
            className="ctx-panel-action-btn"
            onClick={() => navigate({ view: "harnesses" })}
          >
            Agent Providers & Quotas →
          </button>
          <button
            type="button"
            className="ctx-panel-action-btn"
            onClick={() => navigate({ view: "terminal" })}
          >
            Terminal Relays →
          </button>
          <button
            type="button"
            className="ctx-panel-action-btn"
            onClick={() => navigate({ view: "search" })}
          >
            Knowledge Search →
          </button>
        </div>
      </section>
    </div>
  );
}

function OpsStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number;
  tone?: "ok" | "warn";
}) {
  return (
    <div className={`ctx-panel-stat${tone ? ` ctx-panel-stat--${tone}` : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function parseOpsDetailSnapshot(value: unknown): OpsDetailSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<OpsDetailSnapshot>;
  if (
    (record.focus !== "flow" && record.focus !== "item") ||
    typeof record.title !== "string" ||
    typeof record.meta !== "string" ||
    typeof record.body !== "string"
  ) {
    return null;
  }
  const metadata = Array.isArray(record.metadata)
    ? record.metadata.filter((item): item is { label: string; value: string } => (
        item != null &&
        typeof item === "object" &&
        typeof (item as { label?: unknown }).label === "string" &&
        typeof (item as { value?: unknown }).value === "string"
      ))
    : undefined;
  const copy = Array.isArray(record.copy)
    ? record.copy.filter((item): item is { label: string; value: string } => (
        item != null &&
        typeof item === "object" &&
        typeof (item as { label?: unknown }).label === "string" &&
        typeof (item as { value?: unknown }).value === "string"
      ))
    : undefined;
  return {
    source: record.source === "tail" ? "tail" : "generic",
    focus: record.focus,
    title: record.title,
    meta: record.meta,
    body: record.body,
    metadata,
    copy,
    action: record.action && typeof record.action === "object" ? record.action : null,
  };
}

function OpsAttentionButton({
  item,
  navigate,
}: {
  item: FleetAttentionItem;
  navigate: (route: Route) => void;
}) {
  const { route } = useScout();
  return (
    <button
      type="button"
      className="ctx-panel-item ctx-panel-item--attention"
      onClick={() => {
        if (item.conversationId) {
          openContent(navigate, { view: "conversation", conversationId: item.conversationId }, { returnTo: route });
        } else {
          navigate({ view: "ops", mode: "mission" });
        }
      }}
    >
      <div className="ctx-panel-body">
        <span className="ctx-panel-name">{item.title}</span>
        <span className="ctx-panel-sub">{item.agentName ?? item.agentId ?? "operator"} · {timeAgo(item.updatedAt)}</span>
      </div>
    </button>
  );
}

function OpsAskButton({
  ask,
  navigate,
}: {
  ask: FleetAsk;
  navigate: (route: Route) => void;
}) {
  const { route } = useScout();
  return (
    <button
      type="button"
      className="ctx-panel-item"
      onClick={() => {
        if (ask.conversationId) {
          openContent(navigate, { view: "conversation", conversationId: ask.conversationId }, { returnTo: route });
        } else {
          navigate({ view: "ops", mode: "mission" });
        }
      }}
    >
      <div className="ctx-panel-body">
        <span className="ctx-panel-name">{ask.task}</span>
        <span className="ctx-panel-sub">{ask.agentName ?? ask.agentId} · {ask.statusLabel}</span>
      </div>
    </button>
  );
}

export { OpsInspectorPanel as OpsRight };
