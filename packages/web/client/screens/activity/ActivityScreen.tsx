import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, peekApiGet } from "../../lib/api.ts";
import { copyTextToClipboard } from "../../lib/clipboard.ts";
import { useBrokerEvents } from "../../lib/sse.ts";
import { actorColor } from "../../lib/colors.ts";
import {
  filterActivityByMachineScope,
  machineScopedAgentIds,
} from "../../lib/machine-scope.ts";
import { routeMachineId } from "../../lib/router.ts";
import { renderWithMentions } from "../../lib/mentions.tsx";
import { fullTimestamp, timeAgo } from "../../lib/time.ts";
import { useContextMenu, type MenuItem } from "../../components/ContextMenu.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { useScout } from "../../scout/Provider.tsx";
import type { ActivityItem, Route } from "../../lib/types.ts";
import "../system-surfaces-redesign.css";

const ROUTE_CACHE_MAX_AGE_MS = 30_000;

const KIND_LABELS: Record<string, string> = {
  "agent.registered": "registered",
  "agent.online": "came online",
  "agent.offline": "went offline",
  "flight.started": "started task",
  "message.sent": "sent message",
  "message.received": "received message",
  "collaboration.ask": "asked a question",
  "collaboration.answer": "answered",
  ask_sent: "sent a request",
  ask_working: "working",
  flight_created: "started task",
  message_sent: "sent",
  message_received: "received",
};

// Conversations and activity describe communication and motion, not harness
// verdicts. Delivery failures belong to the broker diagnostics surface.
const HIDDEN_TURN_VERDICT_KINDS = new Set([
  "ask_failed",
  "ask_replied",
  "flight.completed",
  "flight.updated",
  "flight_updated",
]);

type AuditCategory = "presence" | "work" | "message" | "collaboration" | "system";

const AUDIT_CATEGORY_META: Record<AuditCategory, { label: string; tone: "notice" | "working" | "completed" | "failed" }> = {
  presence: { label: "Presence", tone: "notice" },
  work: { label: "Execution", tone: "working" },
  message: { label: "Delivery", tone: "completed" },
  collaboration: { label: "Coordination", tone: "working" },
  system: { label: "System", tone: "notice" },
};

function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind.replace(/[._]/g, " ");
}

function activityCategory(kind: string): AuditCategory {
  if (kind.startsWith("agent.") || kind.includes("registered") || kind.includes("online") || kind.includes("offline")) {
    return "presence";
  }
  if (kind.startsWith("flight") || kind.startsWith("ask_")) return "work";
  if (kind.startsWith("message")) return "message";
  if (kind.startsWith("collaboration")) return "collaboration";
  return "system";
}

function actorInitial(name: string | null): string {
  return (name ?? "system").charAt(0).toUpperCase();
}

function shortId(value: string): string {
  if (value.length <= 14) return value;
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function pathLeaf(value: string | null): string | null {
  if (!value) return null;
  const segments = value.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? value;
}

function fallbackTitle(item: ActivityItem): string {
  const actor = item.actorName ?? "system";
  return `${actor} ${kindLabel(item.kind)}`;
}

function fallbackSummary(item: ActivityItem): string {
  if (item.workspaceRoot) {
    return `Recorded from ${item.workspaceRoot}.`;
  }
  if (item.conversationId) {
    return `Linked to thread ${shortId(item.conversationId)}.`;
  }
  return "No additional detail was captured for this event.";
}

export function ActivityScreen({ navigate }: { navigate: (r: Route) => void }) {
  const { agents, route } = useScout();
  // Warm start: paint the last activity feed on remount while the mount
  // effect's load("initial") refreshes it in the background.
  const [initialActivity] = useState(() =>
    peekApiGet<ActivityItem[]>("/api/activity", ROUTE_CACHE_MAX_AGE_MS),
  );
  const [activity, setActivity] = useState<ActivityItem[]>(initialActivity ?? []);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(initialActivity === null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null);

  const activityRef = useRef<ActivityItem[]>(initialActivity ?? []);
  const requestIdRef = useRef(0);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showContextMenu = useContextMenu();
  const machineId = routeMachineId(route);
  const scopedAgentIds = useMemo(
    () => machineScopedAgentIds(agents, machineId),
    [agents, machineId],
  );
  const visibleActivity = useMemo(
    () => filterActivityByMachineScope(activity, scopedAgentIds)
      .filter((item) => !HIDDEN_TURN_VERDICT_KINDS.has(item.kind)),
    [activity, scopedAgentIds],
  );

  useEffect(() => {
    activityRef.current = activity;
  }, [activity]);

  useEffect(() => {
    if (expandedId && !visibleActivity.some((item) => item.id === expandedId)) {
      setExpandedId(null);
    }
  }, [expandedId, visibleActivity]);

  const load = useCallback(async (mode: "initial" | "background" | "manual" = "initial") => {
    const requestId = ++requestIdRef.current;
    const hasSnapshot = activityRef.current.length > 0;

    if (!hasSnapshot && mode !== "background") {
      setLoading(true);
      setError(null);
    } else {
      setRefreshing(true);
    }

    try {
      const nextActivity = await api<ActivityItem[]>("/api/activity");
      if (requestId !== requestIdRef.current) return;
      setActivity(nextActivity);
      setError(null);
      setLastLoadedAt(Date.now());
      setExpandedId((current) => (nextActivity.some((item) => item.id === current) ? current : null));
    } catch (loadError) {
      if (requestId !== requestIdRef.current) return;
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimerRef.current) return;
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      void load("background");
    }, 250);
  }, [load]);

  useEffect(() => {
    void load("initial");
    return () => {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
      }
    };
  }, [load]);

  useBrokerEvents(scheduleRefresh);

  const metrics = useMemo(() => {
    const actors = new Set(visibleActivity.map((item) => item.actorName ?? "system"));
    const threads = new Set(visibleActivity.map((item) => item.conversationId).filter((value): value is string => Boolean(value)));
    return [
      {
        label: "Events",
        value: `${visibleActivity.length}`,
        detail: visibleActivity.length > 0 ? `Latest ${timeAgo(visibleActivity[0]!.ts)}` : "Waiting for records",
      },
      {
        label: "Actors",
        value: `${actors.size}`,
        detail: actors.size > 0 ? "Distinct event owners" : "No actors yet",
      },
      {
        label: "Threads",
        value: `${threads.size}`,
        detail: threads.size > 0 ? "Conversation-linked records" : "No linked threads",
      },
    ];
  }, [visibleActivity]);

  const showInitialError = !loading && visibleActivity.length === 0 && Boolean(error);
  const showEmpty = !loading && visibleActivity.length === 0 && !error;

  return (
    <div className="sys-surface-page">
      <div className="sys-page-head">
        <div className="sys-page-title-group">
          <h2 className="sys-page-title">Activity Log</h2>
          <p className="sys-page-subtitle">
            Broker events, task execution, and collaboration handoffs.
          </p>
        </div>
        <div className="sys-page-actions">
          <div className="sys-sync-note">
            {loading
              ? "Loading audit ledger..."
              : error && visibleActivity.length > 0
                ? `Showing last confirmed snapshot from ${lastLoadedAt ? timeAgo(lastLoadedAt) : "earlier"}`
                : lastLoadedAt
                  ? `Updated ${timeAgo(lastLoadedAt)}`
                  : "Waiting for first snapshot"}
          </div>
          <button
            type="button"
            className="s-btn"
            disabled={loading || refreshing}
            onClick={() => void load("manual")}
          >
            {refreshing ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>

      <div className="sys-stat-grid">
        {metrics.map((metric) => (
          <div key={metric.label} className="sys-stat-card">
            <span className="sys-stat-label">{metric.label}</span>
            <strong className="sys-stat-value">{metric.value}</strong>
            <span className="sys-stat-detail">{metric.detail}</span>
          </div>
        ))}
      </div>

      {error && visibleActivity.length > 0 && (
        <div className="sys-banner sys-banner-warning">
          <strong>Refresh failed.</strong>
          <span>{error}</span>
        </div>
      )}

      {loading && visibleActivity.length === 0 && (
        <EmptyState
          title="Loading activity"
          body="Pulling the latest records from the broker database."
        />
      )}

      {showInitialError && (
        <EmptyState
          className="sys-state-card-error"
          title="Activity is unavailable"
          body={error}
          action={
            <button type="button" className="s-btn" onClick={() => void load("manual")}>
              Try again
            </button>
          }
        />
      )}

      {showEmpty && (
        <EmptyState
          title="No activity yet"
          body="Events appear here after agents register, send messages, or advance work."
        />
      )}

      {visibleActivity.length > 0 && (
        <div className="sys-audit-list">
          {visibleActivity.map((item) => {
            const isExpanded = expandedId === item.id;
            const category = activityCategory(item.kind);
            const categoryMeta = AUDIT_CATEGORY_META[category];
            const workspaceLabel = pathLeaf(item.workspaceRoot);
            const summary = item.summary && item.summary !== item.title
              ? item.summary
              : fallbackSummary(item);

            const jumps: Array<{ key: string; label: string; route: Route; title: string }> = [];
            if (item.conversationId) {
              jumps.push({
                key: "thread",
                label: "Thread",
                title: `Open thread ${shortId(item.conversationId)}`,
                route: { view: "conversation", conversationId: item.conversationId },
              });
            }
            if (item.recordId) {
              jumps.push({
                key: "work",
                label: "Work",
                title: "Open work item",
                route: { view: "work", workId: item.recordId },
              });
            }
            if (item.agentId) {
              const agentLabel = item.agentName ?? "Agent";
              jumps.push({
                key: "agent",
                label: agentLabel,
                title: `Open agent ${agentLabel}`,
                route: { view: "agents-v2", agentId: item.agentId },
              });
            }
            if (item.sessionId) {
              jumps.push({
                key: "session",
                label: "Session",
                title: "Open session",
                route: { view: "sessions", sessionId: item.sessionId },
              });
            }
            if (item.flightId || item.invocationId) {
              jumps.push({
                key: "follow",
                label: "Follow",
                title: "Follow live execution",
                route: {
                  view: "follow",
                  ...(item.flightId ? { flightId: item.flightId } : {}),
                  ...(item.invocationId ? { invocationId: item.invocationId } : {}),
                  ...(item.conversationId ? { conversationId: item.conversationId } : {}),
                },
              });
            }

            const toggleExpanded = () => setExpandedId(isExpanded ? null : item.id);

            return (
              <article
                key={item.id}
                className={`sys-audit-entry${isExpanded ? " sys-audit-entry-expanded" : ""}`}
                onContextMenu={(e) => {
                  const sel = window.getSelection()?.toString().trim();
                  const items: MenuItem[] = [];
                  if (sel) {
                    items.push({ kind: "action", label: "Copy Selection", shortcut: "⌘C", onSelect: () => { void copyTextToClipboard(sel); } });
                    items.push({ kind: "separator" });
                  }
                  const text = item.title ?? item.summary ?? "";
                  if (text) items.push({ kind: "action", label: "Copy Details", onSelect: () => { void copyTextToClipboard(text); } });
                  if (item.actorName) items.push({ kind: "action", label: "Copy Actor", onSelect: () => { void copyTextToClipboard(item.actorName!); } });
                  items.push({ kind: "action", label: "Copy Event ID", onSelect: () => { void copyTextToClipboard(item.id); } });
                  if (jumps.length > 0) {
                    items.push({ kind: "separator" });
                    for (const jump of jumps) {
                      items.push({
                        kind: "action",
                        label: `Open ${jump.label}`,
                        onSelect: () => navigate(jump.route),
                      });
                    }
                  }
                  showContextMenu(e, items);
                }}
              >
                <div
                  className="sys-audit-toggle"
                  role="button"
                  tabIndex={0}
                  aria-expanded={isExpanded}
                  onClick={toggleExpanded}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      toggleExpanded();
                    }
                  }}
                >
                  <div className="sys-audit-stamp">
                    <span className="sys-audit-time">{timeAgo(item.ts)}</span>
                    <span className="sys-audit-date">{fullTimestamp(item.ts)}</span>
                  </div>

                  <div className={`sys-audit-marker sys-audit-marker-${categoryMeta.tone}`}>
                    <span />
                  </div>

                  <div className="sys-audit-body">
                    <div className="sys-audit-topline">
                      <span className="sys-audit-category">{categoryMeta.label}</span>
                      <span className="sys-audit-kind">{kindLabel(item.kind)}</span>
                    </div>
                    <h3 className="sys-audit-title">
                      {renderWithMentions(item.title ?? fallbackTitle(item))}
                    </h3>
                    <p className="sys-audit-summary">{renderWithMentions(summary)}</p>
                    <div className="sys-audit-meta">
                      <span className="sys-audit-meta-item">
                        <span
                          className="sys-audit-avatar"
                          style={{ background: actorColor(item.actorName ?? "system") }}
                        >
                          {actorInitial(item.actorName)}
                        </span>
                        {item.actorName ?? "system"}
                      </span>
                      {workspaceLabel && (
                        <span className="sys-audit-meta-item">
                          Workspace {workspaceLabel}
                        </span>
                      )}
                    </div>
                    {jumps.length > 0 && (
                      <div className="sys-audit-jumps">
                        <span className="sys-audit-jumps-label">Open</span>
                        {jumps.map((jump) => (
                          <button
                            key={jump.key}
                            type="button"
                            className="sys-audit-jump"
                            title={jump.title}
                            onClick={(e) => {
                              e.stopPropagation();
                              navigate(jump.route);
                            }}
                          >
                            {jump.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="sys-audit-expand">
                    {isExpanded ? "Close" : "Details"}
                  </div>
                </div>

                {isExpanded && (
                  <div className="sys-audit-details">
                    <div className="sys-detail-grid">
                      <div className="sys-detail-card">
                        <span className="sys-detail-label">Event</span>
                        <code className="sys-detail-value">{item.kind}</code>
                      </div>
                      <div className="sys-detail-card">
                        <span className="sys-detail-label">Recorded</span>
                        <span className="sys-detail-value">{fullTimestamp(item.ts)}</span>
                      </div>
                      <div className="sys-detail-card">
                        <span className="sys-detail-label">Actor</span>
                        <span className="sys-detail-value">{item.actorName ?? "system"}</span>
                      </div>
                      {item.agentName && (
                        <div className="sys-detail-card">
                          <span className="sys-detail-label">Agent</span>
                          <span className="sys-detail-value">{item.agentName}</span>
                        </div>
                      )}
                      <div className="sys-detail-card">
                        <span className="sys-detail-label">Workspace</span>
                        <span className="sys-detail-value">{item.workspaceRoot ?? "Not attached"}</span>
                      </div>
                      <div className="sys-detail-card">
                        <span className="sys-detail-label">Thread</span>
                        <span className="sys-detail-value">
                          {item.conversationId ? shortId(item.conversationId) : "Not attached"}
                        </span>
                      </div>
                      {item.recordId && (
                        <div className="sys-detail-card">
                          <span className="sys-detail-label">Work</span>
                          <span className="sys-detail-value">{shortId(item.recordId)}</span>
                        </div>
                      )}
                      {item.sessionId && (
                        <div className="sys-detail-card">
                          <span className="sys-detail-label">Session</span>
                          <span className="sys-detail-value">{shortId(item.sessionId)}</span>
                        </div>
                      )}
                      {item.flightId && (
                        <div className="sys-detail-card">
                          <span className="sys-detail-label">Flight</span>
                          <span className="sys-detail-value">{shortId(item.flightId)}</span>
                        </div>
                      )}
                      {item.invocationId && (
                        <div className="sys-detail-card">
                          <span className="sys-detail-label">Invocation</span>
                          <span className="sys-detail-value">{shortId(item.invocationId)}</span>
                        </div>
                      )}
                      <div className="sys-detail-card">
                        <span className="sys-detail-label">Record id</span>
                        <code className="sys-detail-value">{item.id}</code>
                      </div>
                    </div>

                    {jumps.length > 0 && (
                      <div className="sys-inline-actions">
                        {jumps.map((jump) => (
                          <button
                            key={jump.key}
                            type="button"
                            className="s-btn s-btn-sm"
                            onClick={() => navigate(jump.route)}
                          >
                            Open {jump.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
