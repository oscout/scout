import { Activity, ChevronRight, ExternalLink, FileText, MessageSquare, Radio } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DocumentFocusViewer, type DocumentFocusKind } from "../../components/DocumentFocusViewer.tsx";
import { StatusPill } from "../../components/StatusPill.tsx";
import { createTextDocument } from "../../components/TextDocumentSurface.tsx";
import { renderWithMentions } from "../../lib/mentions.tsx";
import { api, peekApiGet } from "../../lib/api.ts";
import {
  filterWorkDetailByMachineScope,
  machineScopedAgentIds,
} from "../../lib/machine-scope.ts";
import { routeMachineId, routePath } from "../../lib/router.ts";
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
  WorkMasthead,
  WorkRequestCard,
  WorkRunCard,
  workStatusTone,
  type WorkCue,
} from "./WorkCasefileSections.tsx";
import { CompanionPinButton } from "../companion/CompanionPinButton.tsx";
import { CompanionSurfaceButton } from "../companion/CompanionSurfaceButton.tsx";
import { useEmbedHeadline } from "../../surfaces/useEmbedHeadline.ts";
import "../agents/agents-detail-redesign.css";
import "./work-detail.css";
import type { Agent, Route, WorkDetail, WorkMaterial, WorkMaterialContent } from "../../lib/types.ts";

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

/**
 * A cue appears only when the ticket is blocked. Working, waiting, review and
 * done read from the state chip, and Open chat sits beside the title.
 */
function buildActionCue(detail: WorkDetail, openChat: (() => void) | null): WorkCue | null {
  const owner = detail.ownerName ?? detail.ownerId ?? "the owner";
  const next = detail.nextMoveOwnerName ?? detail.nextMoveOwnerId ?? owner;
  if (detail.state === "done") return null;
  if (detail.attention === "interrupt") {
    return {
      label: "Blocked",
      text: openChat ? `${next} surfaced a blocker. The chat has the context.` : `${next} surfaced a blocker. The timeline below has the context.`,
      tone: "blocked",
    };
  }
  return null;
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

function sentenceCase(label: string): string {
  const text = label.replace(/_/g, " ").trim();
  return text ? text[0]!.toUpperCase() + text.slice(1).toLowerCase() : text;
}

/** Events that carry an outcome; they get the accent node. */
const OUTCOME_KINDS = new Set(["done", "review_requested", "completed"]);

function WorkTimelinePanel({ detail }: { detail: WorkDetail }) {
  const [showAll, setShowAll] = useState(false);
  const rows = useMemo(() => workTimelineRows(detail.timeline), [detail.timeline]);
  const items = showAll ? rows : rows.slice(0, 18);
  if (items.length === 0) return null;
  return (
    <section className="s-wc-card s-work-timeline-panel">
      <div className="s-wc-card-head">
        <h2>Timeline</h2>
        <span className="s-wc-sub">Request, progress and replies · newest first</span>
        <span className="s-wc-spacer" />
        <span className="s-wc-count-note">
          {detail.timeline.length} events{rows.length !== detail.timeline.length ? ` · ${rows.length} shown` : ""}
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
              data-outcome={OUTCOME_KINDS.has(item.detailKind ?? "") || undefined}
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
                  <strong>{sentenceCase(timelineKindLabel(item))}</strong>
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
      {rows.length > 18 && <button type="button" className="s-wc-ghost s-work-event-more" onClick={() => setShowAll(!showAll)}>{showAll ? "Show recent events" : `Show all ${rows.length} events`}</button>}
    </section>
  );
}

function WorkTailPanel({
  detail,
  embedded,
  navigate,
}: {
  detail: WorkDetail;
  embedded: boolean;
  navigate: (r: Route) => void;
}) {
  const { route } = useScout();
  const tailRoute = workTailRoute(detail);
  const tailQuery = useFollowTailQuery(tailRoute, detail.id);
  const tailLabel = detail.primaryInvocation?.targetAgentName ?? detail.ownerName ?? "this work session";
  const live = workStatusTone(detail) === "active";
  // Open while the task runs; a finished ticket keeps its tail one click away.
  const [open, setOpen] = useState(detail.state !== "done");
  const bodyId = `work-tail-${detail.id}`;

  return (
    <section className="s-wc-card s-wc-tail" data-open={open || undefined}>
      <div className="s-wc-card-head s-wc-tail-head">
        <button
          type="button"
          className="s-wc-disclosure"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((value) => !value)}
        >
          <ChevronRight size={14} strokeWidth={1.8} aria-hidden="true" />
          <h2>Task tail</h2>
        </button>
        <span className="s-wc-sub">
          {live && <i className="s-wc-pulse" aria-hidden="true" />}
          {live ? "Live from" : "Session output from"} <b>{tailLabel}</b>
        </span>
        <span className="s-wc-spacer" />
        <a
          className="s-wc-ghost s-wc-tail-open"
          href={routePath(tailRoute)}
          target={embedded ? "_blank" : undefined}
          rel={embedded ? "noreferrer" : undefined}
          onClick={(event) => {
            if (embedded || event.metaKey || event.ctrlKey || event.shiftKey) return;
            event.preventDefault();
            openContent(navigate, tailRoute, { returnTo: route });
          }}
        >
          Open in Tail <ExternalLink aria-hidden="true" size={12} strokeWidth={1.8} />
        </a>
      </div>
      {open && (
        <div id={bodyId} className="s-work-tail-frame">
          <TailView
            navigate={navigate}
            initialFilter={tailQuery.query}
            sessionId={tailQuery.sessionId}
            filterLabel={tailLabel}
            filterScope="context"
            chrome="embedded"
          />
        </div>
      )}
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

  // Ended sessions drop out of the roster; the masthead still wants their path and branch.
  const ownerId = detail?.ownerId ?? null;
  const ownerListed = ownerId ? agents.some((agent) => agent.id === ownerId) : true;
  const [fetchedOwner, setFetchedOwner] = useState<Agent | null>(null);
  useEffect(() => {
    if (ownerListed || !ownerId) return;
    let live = true;
    api<Agent>(`/api/agents/${encodeURIComponent(ownerId)}`).then((agent) => { if (live) setFetchedOwner(agent); }).catch(() => {});
    return () => { live = false; };
  }, [ownerListed, ownerId]);

  // Embedded (the Mac app's Work window) there is no picker to go back to;
  // the way out is the full page in Scout.
  const backControl = embedded
    ? <a className="s-work-action-button" href={`/work/${encodeURIComponent(workId)}`} target="_blank" rel="noreferrer">Open in Scout</a>
    : <BackToPicker slot="work" fallback={{ view: "inbox" }} navigate={navigate} />;

  if (!loaded) {
    return (
      <div className="s-work-detail s-work-casefile" aria-busy="true">
        <header className="s-wc-mast">
          <div className="s-wc-topbar">
            {embedded ? null : <BackToPicker slot="work" fallback={{ view: "inbox" }} navigate={navigate} />}
            <span className="s-wc-kind">Work</span>
            <span className="s-wc-id-chip"><code>{workId}</code></span>
            <span className="s-wc-spacer" />
            {embedded && (
              <a className="s-wc-btn-strong" href={`/work/${encodeURIComponent(workId)}`} target="_blank" rel="noreferrer">
                Open in Scout <ExternalLink size={12} strokeWidth={1.8} aria-hidden="true" />
              </a>
            )}
          </div>
          <div className="s-wc-headline" role="status">
            <span className="s-wc-skeleton s-wc-skeleton-title" />
            <span className="s-wc-skeleton s-wc-skeleton-line" />
            <span className="s-wc-sr-only">Loading work item…</span>
          </div>
        </header>
        <div className="s-wc-card s-wc-skeleton-card" aria-hidden="true" />
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
  const conversationId = visibleDetail.conversationId;
  const openChat = conversationId ? () => openContent(navigate, { view: "conversation", conversationId }, { returnTo: route }) : null;
  const actionCue = buildActionCue(visibleDetail, openChat);
  // The Run card already covers the primary flight; list only the others.
  const otherFlights = visibleDetail.activeFlights.filter((flight) => flight.id !== visibleDetail.primaryInvocation?.flightId);
  const hasLowerContent = otherFlights.length > 0 || visibleDetail.childWork.length > 0;
  const briefSummary = visibleDetail.primaryInvocation?.task?.trim() || initialWorkBriefSummary(visibleDetail);
  const askState = visibleDetail.primaryInvocation?.state;
  const ownerAgent = agents.find((agent) => agent.id === visibleDetail.ownerId) ?? (fetchedOwner?.id.startsWith(visibleDetail.ownerId ?? "\0") ? fetchedOwner : undefined);
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
        onOpenChat={openChat}
        cue={actionCue}
        agent={ownerAgent}
        navigate={navigate}
        onSelectMaterial={setSelectedMaterialId}
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
          <WorkTimelinePanel detail={visibleDetail} />
          <WorkTailPanel key={`${visibleDetail.id}:tail`} detail={visibleDetail} embedded={embedded} navigate={navigate} />
          <WorkFileBrowser
            detail={visibleDetail}
            selectedId={selectedMaterialId}
            onSelect={setSelectedMaterialId}
            content={materialContent}
            loading={loadingMaterial}
            error={materialError}
            onOpen={() => setMaterialViewerOpen(true)}
          />
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

        {hasLowerContent && (
          <div className="s-work-casefile-main s-work-casefile-main-lower">
            {otherFlights.length > 0 && (
              <section className="s-wc-card">
                <div className="s-wc-card-head">
                  <h2>Other flights</h2>
                  <span className="s-wc-sub">Also running for this work</span>
                </div>
                <div className="s-work-flight-list">
                  {otherFlights.map((flight) => (
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
              <section className="s-wc-card">
                <div className="s-wc-card-head">
                  <h2>Child work</h2>
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
