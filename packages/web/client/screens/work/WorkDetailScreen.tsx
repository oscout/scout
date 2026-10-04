import { Activity, ExternalLink, FileText, MessageSquare, Radio } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { DocumentFocusViewer, type DocumentFocusKind } from "../../components/DocumentFocusViewer.tsx";
import { StatusPill } from "../../components/StatusPill.tsx";
import { createTextDocument } from "../../components/TextDocumentSurface.tsx";
import { renderWithMentions } from "../../lib/mentions.tsx";
import { api, peekApiGet } from "../../lib/api.ts";
import {
  filterWorkDetailByMachineScope,
  machineScopedAgentIds,
} from "../../lib/machine-scope.ts";
import { routeMachineId } from "../../lib/router.ts";
import { useBrokerEvents } from "../../lib/sse.ts";
import { workChildTone } from "../../lib/status-tone.ts";
import { timeAgo } from "../../lib/time.ts";
import { useScout } from "../../scout/Provider.tsx";
import { BackToPicker } from "../../scout/slots/BackToPicker.tsx";
import { openContent } from "../../scout/slots/openContent.ts";
import { TailView } from "../shared/TailView.tsx";
import { useFollowTailQuery } from "../ops/follow-tail-query.ts";
import { initialWorkBriefSummary, workTailRoute, workMaterialImageUrl } from "./work-detail-context.ts";
import { workTimelineRows } from "./work-timeline-rows.ts";
import {
  CopyMark,
  copyText,
  formatBytes,
  WorkFileBrowser,
  WorkLinks,
  WorkMasthead,
  WorkRequestCard,
  WorkRunCard,
} from "./WorkCasefileSections.tsx";
import { CompanionPinButton } from "../companion/CompanionPinButton.tsx";
import { CompanionSurfaceButton } from "../companion/CompanionSurfaceButton.tsx";
import { useEmbedHeadline } from "../../surfaces/useEmbedHeadline.ts";
import "../agents/agents-detail-redesign.css";
import "./work-detail.css";
import type { Route, WorkDetail, WorkMaterial, WorkMaterialContent } from "../../lib/types.ts";

type ActionCue = {
  eyebrow: string;
  title: string;
  body: string;
  tone: "attention" | "blocked" | "active" | "quiet";
};

const ROUTE_CACHE_MAX_AGE_MS = 30_000;

function workDetailPath(workId: string): string {
  return `/api/work/${encodeURIComponent(workId)}`;
}

function stateLabel(state: string): string {
  switch (state) {
    case "review":
      return "In review";
    case "waiting":
      return "Waiting";
    case "working":
      return "Working";
    case "done":
      return "Done";
    default:
      return state.replace(/_/g, " ");
  }
}

function signalLabel(attention: WorkDetail["attention"]): string | null {
  switch (attention) {
    case "badge":
      return "Noteworthy";
    case "interrupt":
      return "Blocked signal";
    default:
      return null;
  }
}

function buildActionCue({
  detail,
  signal,
  ownerLabel,
  nextMoveLabel,
}: {
  detail: WorkDetail;
  signal: string | null;
  ownerLabel: string;
  nextMoveLabel: string;
}): ActionCue {
  const accountableLabel = nextMoveLabel === "—" ? ownerLabel : nextMoveLabel;

  if (detail.attention === "interrupt") {
    return {
      eyebrow: "Network signal",
      title: `Blocker surfaced for ${accountableLabel}`,
      body: detail.conversationId
        ? "Open the thread if you want the blocking context."
        : "No thread is attached; the record and timeline hold the current context.",
      tone: "blocked",
    };
  }

  if (signal) {
    return {
      eyebrow: "Network signal",
      title: `Plan activity from ${accountableLabel}`,
      body: detail.conversationId
        ? "A plan or spec discussion is active in the agent network. Open the thread only if you want context."
        : "A plan or spec discussion is active in the agent network, but no thread is attached yet.",
      tone: "attention",
    };
  }

  if (detail.activeFlights.length > 0 || detail.state === "in_turn" || detail.state === "in_flight") {
    return {
      eyebrow: "Next move",
      title: `${ownerLabel} is working`,
      body: detail.conversationId
        ? "The thread has the freshest working context."
        : "Watch the flight list and timeline for the next update.",
      tone: "active",
    };
  }

  if (detail.state === "waiting" || detail.state === "review") {
    return {
      eyebrow: "Next move",
      title: `Waiting on ${nextMoveLabel}`,
      body: detail.conversationId
        ? "The thread has the current unblock context."
        : "No thread is attached; ownership and timeline are the best context.",
      tone: "quiet",
    };
  }

  if (detail.state === "done") {
    return {
      eyebrow: "Outcome",
      title: "Work is done",
      body: detail.conversationId
        ? "The thread keeps the handoff and final context."
        : "The record and timeline are preserved here.",
      tone: "quiet",
    };
  }

  return {
    eyebrow: "Next move",
    title: nextMoveLabel === "—" ? "No next owner set" : `Next move: ${nextMoveLabel}`,
    body: detail.conversationId
      ? "The thread has the latest context."
      : "Use the record and timeline to decide where this should go next.",
    tone: "quiet",
  };
}

function WorkActionButton({
  children,
  icon,
  onClick,
  primary = false,
  disabled = false,
}: {
  children: ReactNode;
  icon: ReactNode;
  onClick: () => void;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`s-work-action-button${primary ? " s-work-action-button-primary" : ""}`}
      onClick={onClick}
      disabled={disabled}
    >
      {icon}
      <span>{children}</span>
    </button>
  );
}

function askSourceLabel(source: string | null | undefined): string {
  const normalized = source?.toLowerCase() ?? "";
  if (normalized.includes("mcp")) return "MCP request";
  if (normalized.includes("cli")) return "CLI request";
  if (normalized) return `${source} request`;
  return "Scout request";
}

function askLifecycleLabel(detail: WorkDetail): string {
  const ask = detail.primaryInvocation;
  const agent = ask?.targetAgentName ?? ask?.targetAgentId ?? detail.ownerName ?? detail.ownerId ?? "The agent";
  const state = ask?.state ?? detail.activeFlights[0]?.state ?? detail.state;
  switch (state) {
    case "running":
      return `${agent} is running in background. Synchronous wait may have expired, but the Run is still active.`;
    case "waking":
      return `${agent} is waking up for this Run.`;
    case "queued":
      return `${agent} has the Run queued.`;
    case "waiting":
    case "review":
      return `${agent} paused and is waiting for the next move.`;
    case "completed":
    case "done":
      return `${agent} completed this Run.`;
    case "failed":
      return `${agent} reported a failure for this Run.`;
    case "cancelled":
      return "This Run was cancelled.";
    default:
      return `${agent} is attached to this work item.`;
  }
}

function workAskStatusText(detail: WorkDetail): string {
  const ask = detail.primaryInvocation;
  const rows = [
    `Work: ${detail.id}`,
    `State: ${detail.currentPhase}`,
    ask ? `Source: ${askSourceLabel(ask.source)}` : null,
    ask?.targetAgentName || ask?.targetAgentId ? `Resolved agent: ${ask.targetAgentName ?? ask.targetAgentId}` : null,
    ask?.requestedHarness ? `Requested harness: ${ask.requestedHarness}` : null,
    ask?.requestedModel ? `Requested model: ${ask.requestedModel}` : null,
    ask?.requestedReasoningEffort ? `Requested effort: ${ask.requestedReasoningEffort}` : null,
    ask?.resolvedHarness ? `Resolved harness: ${ask.resolvedHarness}` : null,
    ask?.resolvedModel ? `Resolved model: ${ask.resolvedModel}` : null,
    ask?.resolvedReasoningEffort ? `Resolved effort: ${ask.resolvedReasoningEffort}` : null,
    ask?.observedModel ? `Observed model: ${ask.observedModel}` : null,
    ask?.observedReasoningEffort ? `Observed effort: ${ask.observedReasoningEffort}` : null,
    ask?.resolvedSessionId ? `Session: ${ask.resolvedSessionId}` : null,
    ask?.flightId ? `Flight: ${ask.flightId}` : null,
    ask?.invocationId ? `Invocation: ${ask.invocationId}` : null,
    detail.conversationId ? `Conversation: ${detail.conversationId}` : null,
    askLifecycleLabel(detail),
  ];
  return rows.filter(Boolean).join("\n");
}

function idsText(detail: WorkDetail): string {
  const ask = detail.primaryInvocation;
  return [
    `workId=${detail.id}`,
    ask?.flightId ? `flightId=${ask.flightId}` : null,
    ask?.invocationId ? `invocationId=${ask.invocationId}` : null,
    detail.conversationId ? `conversationId=${detail.conversationId}` : null,
    ask?.targetAgentId ? `agentId=${ask.targetAgentId}` : null,
    ask?.resolvedSessionId ? `sessionId=${ask.resolvedSessionId}` : null,
  ].filter(Boolean).join("\n");
}

function WorkBriefViewer({
  detail,
  summary,
  open,
  hasThread,
  navigate,
  onClose,
}: {
  detail: WorkDetail;
  summary: string | null;
  open: boolean;
  hasThread: boolean;
  navigate: (r: Route) => void;
  onClose: () => void;
}) {
  const { route } = useScout();
  if (!open || !summary) {
    return null;
  }

  const document = createTextDocument({
    id: `${detail.id}:brief`,
    title: "Original request",
    uri: `scout://work/${detail.id}/brief`,
    mediaType: "text/markdown",
    value: `# Original request\n\n${summary}`,
    readOnly: true,
  });

  return (
    <DocumentFocusViewer
      kind="ask"
      document={document}
      title="Original request"
      eyebrow="Brief"
      subtitle={detail.title}
      meta={["request", hasThread ? "thread linked" : "threadless"]}
      mode="preview"
      actions={hasThread && detail.conversationId
        ? [{
            label: "Thread",
            icon: <MessageSquare aria-hidden="true" size={13} strokeWidth={1.8} />,
            onClick: () => openContent(navigate, { view: "conversation", conversationId: detail.conversationId! }, { returnTo: route }),
            title: "Open source thread",
          }]
        : []}
      onClose={onClose}
    />
  );
}

function WorkMaterialViewer({
  material,
  content,
  loading,
  error,
  onClose,
}: {
  material: WorkMaterial | null;
  content: WorkMaterialContent | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
}) {
  if (!material) {
    return null;
  }

  const document = content
    ? createTextDocument({
        id: content.materialId,
        title: content.title,
        uri: content.uri,
        mediaType: content.mediaType,
        value: content.content,
        readOnly: true,
      })
    : null;

  return (
    <DocumentFocusViewer
      kind={documentFocusKindForMaterial(material)}
      document={document}
      title={material.path}
      eyebrow={material.kind === "spec" ? "Spec" : material.kind}
      subtitle={content?.uri ?? material.worktreeRoot ?? undefined}
      meta={[
        material.status,
        material.confidence,
        ...(content ? [formatBytes(content.sizeBytes)] : []),
      ]}
      mode={document?.kind === "markdown" ? "preview" : "read"}
      state={loading || (!content && !error) ? "Loading file..." : null}
      error={!loading ? error : null}
      notice={content?.truncated ? `Preview truncated at ${formatBytes(content.content.length)}.` : null}
      onClose={onClose}
    />
  );
}

function documentFocusKindForMaterial(material: WorkMaterial): DocumentFocusKind {
  if (material.kind === "plan" || material.kind === "spec") {
    return "plan";
  }
  if (material.kind === "doc") {
    return "doc";
  }
  return "code";
}

function timelineKindLabel(item: WorkDetail["timeline"][number]): string {
  if (item.kind === "message") {
    return item.title || (item.detailKind === "agent" ? "reply" : "thread update");
  }
  if (item.kind === "flight_started") return "agent output";
  if (item.kind === "flight_completed") return item.detailKind === "completed" ? "reply" : item.detailKind ?? "flight";
  if (item.detailKind === "created") return "request created";
  return item.title ?? item.kind.replace(/_/g, " ");
}

function WorkTimelinePanel({ detail }: { detail: WorkDetail }) {
  const [showAll, setShowAll] = useState(false);
  const rows = useMemo(() => workTimelineRows(detail.timeline), [detail.timeline]);
  const items = showAll ? rows : rows.slice(0, 18);
  if (items.length === 0) return null;
  return (
    <section className="s-work-casefile-section s-work-timeline-panel">
      <div className="s-agent-section-heading">
        <div>
          <h2 className="s-agent-section-title">Timeline</h2>
          <p className="s-work-section-note">The request, progress, and replies · newest first</p>
        </div>
        <span className="s-work-section-note">
          {detail.timeline.length} events{rows.length !== detail.timeline.length ? ` · ${rows.length} rows` : ""}
        </span>
      </div>
      <ol className="s-work-event-track">
        {items.map(({ item, body, ref, folded }, index) => {
          const date = new Date(item.at);
          const startsDay = index === 0 || date.toDateString() !== new Date(items[index - 1]!.item.at).toDateString();
          const long = (body?.length ?? 0) > 400;
          const Icon = item.kind === "message" ? MessageSquare : item.kind.startsWith("flight") ? Radio : item.detailKind === "created" ? FileText : Activity;
          return (
            <li key={item.id} className="s-work-event" data-kind={item.kind}
              data-flight-id={item.flightId ?? undefined} data-work-id={detail.id}
              data-conversation-id={item.conversationId ?? detail.conversationId ?? undefined}>
              <div className="s-work-event-time">
                {startsDay && <span className="s-work-event-date">{date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>}
                <time dateTime={date.toISOString()} title={date.toLocaleString()}>{date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}</time>
                <span>{timeAgo(item.at)}</span>
              </div>
              <span className="s-work-event-node" aria-hidden="true"><Icon size={12} strokeWidth={1.8} /></span>
              <div className="s-work-event-content">
                <div className="s-work-event-heading">
                  <strong>{timelineKindLabel(item).replace(/_/g, " ")}</strong>
                  <span>{item.actorName ?? item.actorId ?? "system"}</span>
                  {ref && <code className="s-work-event-ref" title={`ask:${ref}`}>{ref}<CopyMark value={ref} label="Copy ask handle" /></code>}
                </div>
                {body && (long ? (
                  <details className="s-work-event-detail">
                    <summary><span>{body.replace(/\s+/g, " ").slice(0, 200)}…</span><span className="s-work-event-disclosure">Full update</span></summary>
                    <div className="s-work-event-copy">{renderWithMentions(body)}</div>
                  </details>
                ) : <div className="s-work-event-copy">{renderWithMentions(body)}</div>)}
                {folded.length > 0 && (
                  <div className="s-work-event-folded">
                    + folded: {folded.map(({ item: echo, sameText }) =>
                      `${timelineKindLabel(echo).replace(/_/g, " ")}${sameText ? " with the same text" : ""}`).join(" · ")}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {rows.length > 18 && <button type="button" className="s-work-material-link s-work-event-more" onClick={() => setShowAll(!showAll)}>{showAll ? "Show recent events" : `Show all ${rows.length} rows`}</button>}
    </section>
  );
}

function WorkTailPanel({
  detail,
  navigate,
}: {
  detail: WorkDetail;
  navigate: (r: Route) => void;
}) {
  const { route } = useScout();
  const tailRoute = workTailRoute(detail);
  const tailQuery = useFollowTailQuery(tailRoute, detail.id);
  const tailLabel = detail.primaryInvocation?.targetAgentName ?? detail.ownerName ?? "this work session";

  return (
    <section className="s-work-casefile-section s-work-tail-section">
      <div className="s-agent-section-heading s-work-tail-heading">
        <div>
          <h2 className="s-agent-section-title s-work-tail-title">
            <Activity aria-hidden="true" size={15} strokeWidth={1.8} />
            Live tail
          </h2>
          <p className="s-work-section-note">Filtered to {tailLabel}</p>
        </div>
        <WorkActionButton
          icon={<ExternalLink aria-hidden="true" size={13} strokeWidth={1.8} />}
          onClick={() =>
            openContent(
              navigate,
              tailRoute,
              { returnTo: route },
            )}
        >
          Scout tail
        </WorkActionButton>
      </div>
      <div className="s-work-tail-frame">
        <TailView
          navigate={navigate}
          initialFilter={tailQuery}
          filterLabel={tailLabel}
          filterScope="context"
          chrome="embedded"
        />
      </div>
    </section>
  );
}

/** The selected material's content, fetched once per pick. */
function useMaterialContent(workId: string, materialId: string | null) {
  const [state, setState] = useState<{ id: string | null; content: WorkMaterialContent | null; error: string | null }>({ id: null, content: null, error: null });
  useEffect(() => {
    if (!materialId) return;
    let cancelled = false;
    void api<WorkMaterialContent>(
      `/api/work/${encodeURIComponent(workId)}/material?materialId=${encodeURIComponent(materialId)}`,
    )
      .then((content) => { if (!cancelled) setState({ id: materialId, content, error: null }); })
      .catch((err) => { if (!cancelled) setState({ id: materialId, content: null, error: err instanceof Error ? err.message : String(err) }); });
    return () => { cancelled = true; };
  }, [workId, materialId]);
  const current = materialId !== null && state.id === materialId;
  return {
    content: current ? state.content : null,
    error: current ? state.error : null,
    loading: materialId !== null && !current,
  };
}

export function WorkDetailScreen({
  workId,
  navigate,
  embedded = false,
}: {
  embedded?: boolean;
  workId: string;
  navigate: (r: Route) => void;
}) {
  const { agents, route } = useScout();
  // Warm start: returning to an already-viewed item paints its last-known
  // detail instantly; load() still refreshes it in the background.
  const [initialDetail] = useState(() =>
    peekApiGet<WorkDetail>(workDetailPath(workId), ROUTE_CACHE_MAX_AGE_MS),
  );
  const [detail, setDetail] = useState<WorkDetail | null>(initialDetail);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(initialDetail !== null);
  const [jsonOpen, setJsonOpen] = useState(false);
  const [briefOpen, setBriefOpen] = useState(false);
  const [selectedMaterialId, setSelectedMaterialId] = useState<string | null>(null);
  const [materialViewerOpen, setMaterialViewerOpen] = useState(false);
  const { content: materialContent, loading: loadingMaterial, error: materialError } = useMaterialContent(workId, workMaterialImageUrl(workId, detail?.inventory?.materials.find((m) => m.id === selectedMaterialId)) ? null : selectedMaterialId);
  useEmbedHeadline(detail?.title ?? "Work progress", embedded);

  const load = useCallback(async () => {
    setError(null);
    try {
      const next = await api<WorkDetail>(workDetailPath(workId));
      setDetail(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setDetail(null);
    } finally {
      setLoaded(true);
    }
  }, [workId]);

  useEffect(() => {
    // Only blank to the loading state when we have nothing cached for this
    // workId; a cached detail paints immediately while load() refreshes it.
    const cached = peekApiGet<WorkDetail>(workDetailPath(workId), ROUTE_CACHE_MAX_AGE_MS);
    if (cached) {
      setDetail(cached);
      setLoaded(true);
    } else {
      setLoaded(false);
    }
    void load();
  }, [load, workId]);
  useBrokerEvents(() => {
    void load();
  });

  const machineId = routeMachineId(route);
  const scopedAgentIds = useMemo(
    () => machineScopedAgentIds(agents, machineId),
    [agents, machineId],
  );
  const scopedDetail = useMemo(
    () => (detail ? filterWorkDetailByMachineScope(detail, scopedAgentIds) : null),
    [detail, scopedAgentIds],
  );

  // Embedded (the Mac app's Work window) there is no picker to go back to;
  // the way out is the full page in Scout.
  const backControl = embedded
    ? <a className="s-work-action-button" href={`/work/${encodeURIComponent(workId)}`} target="_blank" rel="noreferrer">Open in Scout</a>
    : <BackToPicker slot="work" fallback={{ view: "inbox" }} navigate={navigate} />;

  if (!loaded) {
    return (
      <div>
        {backControl}
        <div className="s-empty"><p>Loading…</p></div>
      </div>
    );
  }

  if (!detail || !scopedDetail) {
    return (
      <div className="s-work-not-found">
        {backControl}
        <div className="s-work-not-found-body">
          <div className="s-work-not-found-glyph" aria-hidden="true">&#x25A1;</div>
          <h2 className="s-work-not-found-title">
            {detail ? "Work item outside this machine scope" : "Work item not found"}
          </h2>
          <p className="s-work-not-found-sub">
            {detail
              ? "Clear the machine scope or switch machines to inspect this work item."
              : "This work item may have been removed or does not exist on this broker."}
          </p>
          {error && (
            <p className="s-work-not-found-detail">{error}</p>
          )}
        </div>
      </div>
    );
  }

  const visibleDetail = scopedDetail;
  const signal = signalLabel(visibleDetail.attention);
  const ownerLabel = visibleDetail.ownerName ?? visibleDetail.ownerId ?? "Unassigned";
  const nextMoveLabel = visibleDetail.nextMoveOwnerName ?? visibleDetail.nextMoveOwnerId ?? "—";
  const actionCue = visibleDetail.state === "done"
    ? null
    : buildActionCue({ detail: visibleDetail, signal, ownerLabel, nextMoveLabel });
  const hasLowerContent = visibleDetail.activeFlights.length > 0 || visibleDetail.childWork.length > 0;
  const briefSummary = visibleDetail.primaryInvocation?.task?.trim() || initialWorkBriefSummary(visibleDetail);
  const askState = visibleDetail.primaryInvocation?.state;
  const ownerAgent = agents.find((agent) => agent.id === visibleDetail.ownerId);
  const viewedMaterial = visibleDetail.inventory?.materials.find((m) => m.id === selectedMaterialId) ?? null;

  return (
    <div className="s-work-detail s-work-casefile">
      <WorkMasthead
        detail={visibleDetail}
        embedded={embedded}
        leading={embedded ? null : backControl}
        tools={<>
          <CompanionPinButton className="s-wc-btn" workId={workId} machineId={machineId} />
          <CompanionSurfaceButton className="s-wc-btn" workId={workId} workTitle={visibleDetail.title} agentId={visibleDetail.ownerId} agentName={visibleDetail.ownerName} projectRoot={ownerAgent?.projectRoot} projectName={ownerAgent?.project} />
        </>}
        progressLink={() => {
          const link = new URL("/embed/work", window.location.origin);
          link.searchParams.set("workId", workId);
          if (machineId) link.searchParams.set("machineId", machineId);
          return link.toString();
        }}
        onJson={() => setJsonOpen(true)}
        cue={actionCue}
        links={<WorkLinks detail={visibleDetail} embedded={embedded} navigate={navigate} onSelectMaterial={setSelectedMaterialId} />}
      />

      <DocumentFocusViewer
        open={jsonOpen}
        kind="code"
        title="Work JSON"
        eyebrow="Current page data"
        subtitle={visibleDetail.title}
        notice="This snapshot refreshes with the page when broker events arrive. It is not a replayable event stream."
        document={jsonOpen ? createTextDocument({
          id: `${visibleDetail.id}:json`,
          title: "work.json",
          mediaType: "application/json",
          value: JSON.stringify(visibleDetail, null, 2),
          readOnly: true,
        }) : null}
        actions={[{ label: "Copy JSON", onClick: () => copyText(JSON.stringify(visibleDetail, null, 2)) }]}
        onClose={() => setJsonOpen(false)}
      />
      {error && <p className="s-error">{error}</p>}

      <div className="s-work-casefile-layout s-work-casefile-layout-main">
        <div className="s-work-casefile-main s-work-casefile-main-materials">
          <WorkRequestCard key={visibleDetail.id} detail={visibleDetail} onOpenOriginal={() => setBriefOpen(true)} />
          <WorkRunCard
            detail={visibleDetail}
            navigate={navigate}
            lifecycleNote={askState && askState !== "completed" ? askLifecycleLabel(visibleDetail) : null}
            statusText={workAskStatusText(visibleDetail)}
            idsText={idsText(visibleDetail)}
          />
          <WorkFileBrowser
            detail={visibleDetail}
            selectedId={selectedMaterialId}
            onSelect={setSelectedMaterialId}
            content={materialContent}
            loading={loadingMaterial}
            error={materialError}
            onOpen={() => setMaterialViewerOpen(true)}
          />
          <WorkTimelinePanel detail={visibleDetail} />
        </div>

        <WorkBriefViewer
          detail={visibleDetail}
          summary={briefSummary}
          open={briefOpen}
          hasThread={Boolean(visibleDetail.conversationId)}
          navigate={navigate}
          onClose={() => setBriefOpen(false)}
        />
        <WorkMaterialViewer
          material={materialViewerOpen ? viewedMaterial : null}
          content={materialContent}
          loading={loadingMaterial}
          error={materialError}
          onClose={() => setMaterialViewerOpen(false)}
        />

        <WorkTailPanel detail={visibleDetail} navigate={navigate} />

        {hasLowerContent && (
          <div className="s-work-casefile-main s-work-casefile-main-lower">
            {visibleDetail.activeFlights.length > 0 && (
              <section className="s-work-casefile-section">
                <div className="s-agent-section-heading">
                  <h2 className="s-agent-section-title">Flights</h2>
                </div>
                <div className="s-work-flight-list">
                  {visibleDetail.activeFlights.map((flight) => (
                    <button
                      key={flight.id}
                      type="button"
                      className="s-work-flight-card"
                      onClick={
                        flight.conversationId
                          ? () => openContent(navigate, { view: "conversation", conversationId: flight.conversationId! }, { returnTo: route })
                          : undefined
                      }
                      disabled={!flight.conversationId}
                    >
                      <div className="s-work-flight-card-header">
                        <span className="s-work-flight-card-title">{flight.agentName ?? flight.agentId}</span>
                        <StatusPill tone="working" variant="pill">{flight.state}</StatusPill>
                      </div>
                      <div className="s-work-flight-card-meta">
                        <span>{flight.startedAt ? `Started ${timeAgo(flight.startedAt)}` : "Start time unavailable"}</span>
                        {flight.completedAt && <span>Completed {timeAgo(flight.completedAt)}</span>}
                      </div>
                      {flight.summary && <div className="s-work-flight-card-copy">{flight.summary}</div>}
                    </button>
                  ))}
                </div>
              </section>
            )}

            {visibleDetail.childWork.length > 0 && (
              <section className="s-work-casefile-section">
                <div className="s-agent-section-heading">
                  <h2 className="s-agent-section-title">Child work</h2>
                </div>
                <div className="s-work-related-list">
                  {visibleDetail.childWork.map((child) => (
                    <button
                      key={child.id}
                      type="button"
                      className="s-work-related-card"
                      onClick={() => openContent(navigate, { view: "work", workId: child.id }, { returnTo: route })}
                    >
                      <div className="s-work-related-card-header">
                        <span className="s-work-related-card-title">{child.title}</span>
                        <StatusPill tone={workChildTone(child)} variant="pill">
                          {child.currentPhase}
                        </StatusPill>
                      </div>
                      <div className="s-work-related-card-meta">
                        <span>{child.ownerName ?? child.ownerId ?? "Unassigned"}</span>
                        <span>{stateLabel(child.state)}</span>
                        <span>{timeAgo(child.lastMeaningfulAt)}</span>
                      </div>
                      {child.lastMeaningfulSummary && (
                        <div className="s-work-related-card-copy">
                          {renderWithMentions(child.lastMeaningfulSummary)}
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
