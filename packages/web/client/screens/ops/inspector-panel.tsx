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
  PlanDocument,
  PlanDocumentStepStatus,
  PlanDocumentsResponse,
  Route,
  SessionEntry,
  WorkItem,
} from "../../lib/types.ts";

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

type PlanInspectorRelated = {
  asks: FleetAsk[];
  runs: AgentRun[];
  sessions: SessionEntry[];
  workItems: WorkItem[];
  attention: FleetAttentionItem[];
};

const PLAN_STEP_LABELS: Record<PlanDocumentStepStatus, string> = {
  blocked: "blocked",
  completed: "done",
  in_progress: "active",
  pending: "todo",
  unknown: "step",
};

const OPS_MODE_LABELS: Record<OpsMode, string> = {
  mission: "Control",
  plan: "Plans",
  issues: "Alerts",
  tail: "Tail",
  atop: "Runtime",
  agents: "Agents",
  lanes: "Lanes",
};

const PLAN_STEP_MARKERS: Record<PlanDocumentStepStatus, string> = {
  blocked: "!",
  completed: "x",
  in_progress: ">",
  pending: " ",
  unknown: "-",
};

function objectField(value: unknown, key: string): unknown {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function stringField(value: unknown, key: string): string | null {
  const field = objectField(value, key);
  return typeof field === "string" && field.trim() ? field.trim() : null;
}

function runTask(run: AgentRun): string | null {
  return stringField(run.input, "task") ?? stringField(run.input, "action");
}

function runOutputSummary(run: AgentRun): string | null {
  return stringField(run.output, "summary") ?? stringField(run.output, "text");
}

function planBasename(value: string): string {
  const clean = value.replace(/\\/g, "/").replace(/\/+$/g, "");
  const idx = clean.lastIndexOf("/");
  return idx >= 0 ? clean.slice(idx + 1) : clean;
}

function compactPlanText(value: string, max = 180): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}...`;
}

function planSignificantTokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_/-]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4)
    .filter((token) => !["plan", "plans", "todo", "work", "task", "docs", "markdown"].includes(token))
    .slice(0, 8);
}

function planRelatedScore(document: PlanDocument, haystackInput: Array<string | null | undefined>): number {
  const haystack = haystackInput.filter(Boolean).join(" ").toLowerCase();
  if (!haystack) return 0;

  const path = document.path.toLowerCase();
  const file = planBasename(path).toLowerCase();
  const title = document.title.toLowerCase();
  let score = 0;

  if (path && haystack.includes(path)) score += 8;
  if (file && haystack.includes(file)) score += 6;
  if (title.length > 8 && haystack.includes(title)) score += 6;

  for (const tag of document.tags) {
    if (tag.length >= 3 && haystack.includes(tag.toLowerCase())) score += 2;
  }
  for (const token of planSignificantTokens(document.title)) {
    if (haystack.includes(token)) score += 1;
  }
  for (const step of document.steps.slice(0, 8)) {
    for (const token of planSignificantTokens(step.text).slice(0, 3)) {
      if (haystack.includes(token)) score += 1;
    }
  }

  return score;
}

function planRelatedSessionScore(document: PlanDocument, session: SessionEntry): number {
  let score = planRelatedScore(document, [
    session.id,
    session.title,
    session.preview,
    session.agentName,
    session.harness,
    session.harnessSessionId,
    session.harnessLogPath,
    session.currentBranch,
    session.workspaceRoot,
    session.participantIds.join(" "),
  ]);

  if (document.agentId && session.agentId === document.agentId) score += 4;
  if (document.agentName && session.agentName && document.agentName === session.agentName) score += 2;
  if (
    document.workspaceName
    && session.workspaceRoot
    && planBasename(session.workspaceRoot).toLowerCase() === document.workspaceName.toLowerCase()
  ) {
    score += 3;
  }

  return score;
}

function mergeInspectorWorkItems(results: Array<PromiseSettledResult<WorkItem[]>>): WorkItem[] {
  const byId = new Map<string, WorkItem>();
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    for (const item of result.value) byId.set(item.id, item);
  }
  return [...byId.values()];
}

function relatedPlanContext(
  document: PlanDocument | null,
  input: {
    fleet: FleetState | null;
    runs: AgentRun[];
    sessions: SessionEntry[];
    workItems: WorkItem[];
  },
): PlanInspectorRelated {
  if (!document) return { asks: [], runs: [], sessions: [], workItems: [], attention: [] };

  const minimumRelatedScore = 6;
  const asks = [...(input.fleet?.activeAsks ?? []), ...(input.fleet?.recentCompleted ?? [])]
    .filter((ask) => planRelatedScore(document, [
      ask.task,
      ask.summary,
      ask.agentName,
      ask.collaborationRecordId,
    ]) >= minimumRelatedScore)
    .slice(0, 8);

  const runs = input.runs
    .filter((run) => planRelatedScore(document, [
      runTask(run),
      runOutputSummary(run),
      run.agentName,
      run.workId,
      run.collaborationRecordId,
    ]) >= minimumRelatedScore)
    .slice(0, 8);

  const workItems = input.workItems
    .filter((work) => planRelatedScore(document, [
      work.title,
      work.summary,
      work.lastMeaningfulSummary,
      work.parentTitle,
      work.ownerName,
      work.nextMoveOwnerName,
    ]) >= minimumRelatedScore)
    .slice(0, 8);

  const attention = (input.fleet?.needsAttention ?? [])
    .filter((item) => planRelatedScore(document, [
      item.title,
      item.summary,
      item.agentName,
    ]) >= minimumRelatedScore)
    .slice(0, 6);

  const relatedConversationIds = new Set<string>();
  const relatedHarnessSessionIds = new Set<string>();
  for (const ask of asks) if (ask.conversationId) relatedConversationIds.add(ask.conversationId);
  for (const run of runs) {
    if (run.conversationId) relatedConversationIds.add(run.conversationId);
    for (const sessionId of run.traceSessionIds ?? []) relatedHarnessSessionIds.add(sessionId);
  }
  for (const work of workItems) if (work.conversationId) relatedConversationIds.add(work.conversationId);
  for (const item of attention) if (item.conversationId) relatedConversationIds.add(item.conversationId);

  const sessions = input.sessions
    .filter((session) => (
      relatedConversationIds.has(session.id)
      || (session.harnessSessionId ? relatedHarnessSessionIds.has(session.harnessSessionId) : false)
      || planRelatedSessionScore(document, session) >= minimumRelatedScore
    ))
    .slice(0, 8);

  return { asks, runs, sessions, workItems, attention };
}

function OpsInspectorPanel({
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

  if (mode === "plan") {
    return <PlanContextInspectorPanel navigate={navigate} returnRoute={returnRoute} />;
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

function PlanContextInspectorPanel({
  navigate,
  returnRoute,
}: {
  navigate: (route: Route) => void;
  returnRoute: Route;
}) {
  const [inventory, setInventory] = useState<PlanDocumentsResponse | null>(null);
  const [fleet, setFleet] = useState<FleetState | null>(null);
  const [workItems, setWorkItems] = useState<WorkItem[]>([]);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [sessions, setSessions] = useState<SessionEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const selectedId = returnRoute.view === "ops" && returnRoute.mode === "plan"
    ? returnRoute.planDocumentId
    : undefined;

  const load = useCallback(async () => {
    const [documentsResult, fleetResult, activeWorkResult, recentWorkResult, runsResult, sessionsResult] = await Promise.allSettled([
      api<PlanDocumentsResponse>("/api/plan-documents"),
      api<FleetState>("/api/fleet"),
      api<WorkItem[]>("/api/work?limit=250"),
      api<WorkItem[]>("/api/work?active=false&limit=250"),
      api<AgentRun[]>("/api/runs?active=false&limit=500"),
      api<SessionEntry[]>("/api/conversations?limit=250"),
    ]);
    if (documentsResult.status === "fulfilled") setInventory(documentsResult.value);
    if (fleetResult.status === "fulfilled") setFleet(fleetResult.value);
    if (activeWorkResult.status === "fulfilled" || recentWorkResult.status === "fulfilled") {
      setWorkItems(mergeInspectorWorkItems([activeWorkResult, recentWorkResult]));
    }
    if (runsResult.status === "fulfilled") setRuns(runsResult.value);
    if (sessionsResult.status === "fulfilled") setSessions(sessionsResult.value);
    setLoaded(true);
  }, []);

  useEffect(() => {
    setLoaded(false);
    void load();
  }, [load]);

  useBrokerEvents((event) => {
    if (
      event.kind === "message.posted" ||
      event.kind === "flight.updated" ||
      event.kind === "collaboration.event.appended"
    ) {
      void load();
    }
  });

  const documents = inventory?.documents ?? [];
  const selectedDocument = useMemo(
    () => documents.find((document) => document.id === selectedId) ?? documents[0] ?? null,
    [documents, selectedId],
  );
  const related = useMemo(
    () => relatedPlanContext(selectedDocument, { fleet, runs, sessions, workItems }),
    [fleet, runs, selectedDocument, sessions, workItems],
  );
  const contextCount = related.attention.length
    + related.workItems.length
    + related.asks.length
    + related.runs.length
    + related.sessions.length;

  if (!selectedDocument) {
    return (
      <div className="ctx-panel ctx-panel--ops-inspector ctx-panel--plan-inspector">
        <section className="ctx-panel-section ctx-panel-ops-summary">
          <div className="ctx-panel-section-label">Plan Context</div>
          <div className="ctx-panel-empty">{loaded ? "No plan document selected" : "Indexing plan documents"}</div>
        </section>
      </div>
    );
  }

  return (
    <div className="ctx-panel ctx-panel--ops-inspector ctx-panel--plan-inspector">
      <section className="ctx-panel-section ctx-panel-plan-summary">
        <div className="ctx-panel-section-label">Plan Context</div>
        <div className="ctx-panel-plan-card">
          <span>Current</span>
          <strong>{selectedDocument.title}</strong>
          <small>{selectedDocument.path} · {timeAgo(selectedDocument.updatedAt)}</small>
          {selectedDocument.summary && <p>{selectedDocument.summary}</p>}
        </div>
      </section>

      <section className="ctx-panel-section">
        <div className="ctx-panel-section-label">
          Steps
          <span className="ctx-panel-count">{selectedDocument.steps.length}</span>
        </div>
        {selectedDocument.steps.length === 0 ? (
          <div className="ctx-panel-empty">No checklist steps parsed</div>
        ) : (
          <div className="ctx-panel-plan-step-list">
            {selectedDocument.steps.map((step) => (
              <div key={step.id} className={`ctx-panel-plan-step ctx-panel-plan-step--${step.status}`}>
                <span className="ctx-panel-plan-step-marker">{PLAN_STEP_MARKERS[step.status]}</span>
                <span className="ctx-panel-plan-step-text">{step.text}</span>
                <span className="ctx-panel-plan-step-state">{PLAN_STEP_LABELS[step.status]}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="ctx-panel-section">
        <div className="ctx-panel-section-label">
          Around This Plan
          <span className="ctx-panel-count">{contextCount}</span>
        </div>
        {contextCount === 0 ? (
          <div className="ctx-panel-empty">No nearby activity matched yet</div>
        ) : null}
      </section>

      <PlanContextSection title="Sessions" count={related.sessions.length}>
        {related.sessions.map((session) => (
          <button
            key={session.id}
            type="button"
            className="ctx-panel-item ctx-panel-plan-context-item"
            onClick={() => openContent(navigate, { view: "conversation", conversationId: session.id }, { returnTo: returnRoute })}
          >
            <div className="ctx-panel-body">
              <span className="ctx-panel-name">{session.title || session.agentName || session.id}</span>
              <span className="ctx-panel-sub">
                {session.kind} · {session.agentName ?? session.harness ?? "session"} · {session.messageCount} msg
              </span>
              <span className="ctx-panel-preview">{session.preview?.trim() || session.workspaceRoot || session.id}</span>
            </div>
          </button>
        ))}
      </PlanContextSection>

      <PlanContextSection title="Work Items" count={related.workItems.length}>
        {related.workItems.map((work) => (
          <button
            key={work.id}
            type="button"
            className="ctx-panel-item ctx-panel-plan-context-item"
            onClick={() => openContent(navigate, { view: "work", workId: work.id }, { returnTo: returnRoute })}
          >
            <div className="ctx-panel-body">
              <span className="ctx-panel-name">{work.title}</span>
              <span className="ctx-panel-sub">{work.currentPhase || work.state} · {timeAgo(work.lastMeaningfulAt || work.updatedAt)}</span>
              {(work.summary || work.lastMeaningfulSummary) && (
                <span className="ctx-panel-preview">{work.summary ?? work.lastMeaningfulSummary}</span>
              )}
            </div>
          </button>
        ))}
      </PlanContextSection>

      <PlanContextSection title="Runs" count={related.runs.length}>
        {related.runs.map((run) => (
          <button
            key={run.id}
            type="button"
            className="ctx-panel-item ctx-panel-plan-context-item"
            onClick={() => navigate(planRouteForRun(run))}
          >
            <div className="ctx-panel-body">
              <span className="ctx-panel-name">{compactPlanText(runTask(run) ?? run.agentName ?? run.id, 120)}</span>
              <span className="ctx-panel-sub">{run.agentName ?? run.agentId} · {run.state} · {timeAgo(run.updatedAt)}</span>
              {runOutputSummary(run) && <span className="ctx-panel-preview">{runOutputSummary(run)}</span>}
            </div>
          </button>
        ))}
      </PlanContextSection>

      <PlanContextSection title="Requests" count={related.asks.length}>
        {related.asks.map((ask) => (
          <button
            key={ask.invocationId}
            type="button"
            className="ctx-panel-item ctx-panel-plan-context-item"
            onClick={() => navigate(planRouteForAsk(ask))}
          >
            <div className="ctx-panel-body">
              <span className="ctx-panel-name">{ask.task}</span>
              <span className="ctx-panel-sub">{ask.agentName ?? ask.agentId} · {ask.statusLabel} · {timeAgo(ask.updatedAt)}</span>
              {ask.summary && <span className="ctx-panel-preview">{ask.summary}</span>}
            </div>
          </button>
        ))}
      </PlanContextSection>

      <PlanContextSection title="Attention" count={related.attention.length}>
        {related.attention.map((item) => {
          const route = planRouteForAttention(item);
          return (
            <button
              key={item.recordId}
              type="button"
              className="ctx-panel-item ctx-panel-item--attention ctx-panel-plan-context-item"
              onClick={() => route && navigate(route)}
              disabled={!route}
            >
              <div className="ctx-panel-body">
                <span className="ctx-panel-name">{item.title}</span>
                <span className="ctx-panel-sub">{item.kind} · {timeAgo(item.updatedAt)}</span>
                {item.summary && <span className="ctx-panel-preview">{item.summary}</span>}
              </div>
            </button>
          );
        })}
      </PlanContextSection>
    </div>
  );
}

function PlanContextSection({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <section className="ctx-panel-section">
      <div className="ctx-panel-section-label">
        {title}
        <span className="ctx-panel-count">{count}</span>
      </div>
      {count === 0 ? <div className="ctx-panel-empty">None matched</div> : <div className="ctx-panel-list">{children}</div>}
    </section>
  );
}

function planRouteForAsk(ask: FleetAsk): Route {
  return routeForFleetAsk(ask);
}

function planRouteForRun(run: AgentRun): Route {
  if (run.conversationId) return { view: "conversation", conversationId: run.conversationId };
  if (run.workId) return { view: "work", workId: run.workId };
  return { view: "agents-v2", agentId: run.agentId };
}

function planRouteForAttention(item: FleetAttentionItem): Route | null {
  return routeForOperatorAttention(item);
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
