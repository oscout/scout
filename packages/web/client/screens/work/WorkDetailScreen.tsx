import { Activity, BookOpen, Clipboard, Code2, ExternalLink, FileText, FolderTree, MessageSquare, Radio } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { DocumentFocusViewer, type DocumentFocusKind } from "../../components/DocumentFocusViewer.tsx";
import { StatusPill } from "../../components/StatusPill.tsx";
import { createTextDocument } from "../../components/TextDocumentSurface.tsx";
import { WorkFilesViewer } from "./WorkFilesViewer.tsx";
import { renderWithMentions } from "../../lib/mentions.tsx";
import { api } from "../../lib/api.ts";
import {
  filterWorkDetailByMachineScope,
  machineScopedAgentIds,
} from "../../lib/machine-scope.ts";
import { routeMachineId } from "../../lib/router.ts";
import { useBrokerEvents } from "../../lib/sse.ts";
import { workChildTone, workTone } from "../../lib/status-tone.ts";
import { timeAgo } from "../../lib/time.ts";
import { useScout } from "../../scout/Provider.tsx";
import { BackToPicker } from "../../scout/slots/BackToPicker.tsx";
import { openContent } from "../../scout/slots/openContent.ts";
import { TailView } from "../shared/TailView.tsx";
import type { Route, WorkDetail, WorkMaterial, WorkMaterialContent, WorkMaterialsInventory } from "../../lib/types.ts";

type ActionCue = {
  eyebrow: string;
  title: string;
  body: string;
  tone: "attention" | "blocked" | "active" | "quiet";
};

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

function copyText(value: string): void {
  void navigator.clipboard?.writeText(value);
}

function WorkAskOverview({
  detail,
  navigate,
}: {
  detail: WorkDetail;
  navigate: (r: Route) => void;
}) {
  const { route } = useScout();
  const ask = detail.primaryInvocation;
  const tailQuery = buildWorkTailContext(detail).query;
  const ids = idsText(detail);
  const sourceLabel = askSourceLabel(ask?.source);
  const resolvedAgent = ask?.targetAgentName ?? ask?.targetAgentId ?? detail.ownerName ?? detail.ownerId ?? "—";
  const prompt = ask?.task ?? initialWorkBriefSummary(detail) ?? detail.summary ?? "No original prompt captured.";
  const observeRoute: Route | null = ask?.resolvedSessionId
    ? {
        view: "sessions",
        sessionId: ask.resolvedSessionId,
        ...(ask.targetAgentId ? { agentId: ask.targetAgentId } : {}),
      }
    : ask?.targetAgentId
    ? { view: "agents-v2", agentId: ask.targetAgentId, tab: "observe" }
    : null;
  const observeLabel = ask?.resolvedSessionId ? "Observe session" : "Observe agent";
  const tailRoute: Route = {
    view: "ops",
    mode: "tail",
    ...(tailQuery ? { tailQuery } : {}),
    workId: detail.id,
    ...(ask?.flightId ? { flightId: ask.flightId } : {}),
    ...(ask?.invocationId ? { invocationId: ask.invocationId } : {}),
    ...(detail.conversationId ? { conversationId: detail.conversationId } : {}),
    ...(ask?.resolvedSessionId ? { sessionId: ask.resolvedSessionId } : {}),
    ...(ask?.targetAgentId ? { targetAgentId: ask.targetAgentId } : {}),
  };

  return (
    <section className="s-work-casefile-section s-work-ask-overview" data-kind="ask" data-work-id={detail.id} data-flight-id={ask?.flightId ?? undefined} data-invocation-id={ask?.invocationId ?? undefined} data-agent-id={ask?.targetAgentId ?? undefined}>
      <div className="s-work-ask-head">
        <div>
          <div className="s-work-ask-badges">
            <span className="s-work-ask-badge s-work-ask-badge-primary">RUN created</span>
            <span className="s-work-ask-badge">{sourceLabel}</span>
            {ask?.state && <span className="s-work-ask-badge">{ask.state}</span>}
          </div>
          <h2 className="s-agent-section-title s-work-ask-title">Message / work source of truth</h2>
          <p className="s-work-ask-lifecycle">{askLifecycleLabel(detail)}</p>
        </div>
      </div>

      <div className="s-work-ask-grid">
        <div className="s-work-ask-prompt">
          <span className="s-work-ask-label">Original prompt</span>
          <p>{renderWithMentions(prompt)}</p>
        </div>
        <dl className="s-work-ask-facts">
          <div><dt>Requested harness</dt><dd>{ask?.requestedHarness ?? "default"}</dd></div>
          <div><dt>Requested model</dt><dd>{ask?.requestedModel ?? "default"}</dd></div>
          <div><dt>Requested effort</dt><dd>{ask?.requestedReasoningEffort ?? "default"}</dd></div>
          <div><dt>Resolved agent</dt><dd>{resolvedAgent}</dd></div>
          <div><dt>Resolved harness</dt><dd>{ask?.resolvedHarness ?? "—"}</dd></div>
          <div><dt>Resolved model</dt><dd>{ask?.resolvedModel ?? "—"}</dd></div>
          <div><dt>Resolved effort</dt><dd>{ask?.resolvedReasoningEffort ?? "—"}</dd></div>
          <div><dt>Observed model</dt><dd>{ask?.observedModel ?? "—"}</dd></div>
          <div><dt>Observed effort</dt><dd>{ask?.observedReasoningEffort ?? "—"}</dd></div>
          <div><dt>Session</dt><dd>{ask?.resolvedSessionId ?? ask?.targetSessionId ?? "—"}</dd></div>
          <div><dt>Flight</dt><dd>{ask?.flightId ?? "—"}</dd></div>
          <div><dt>Invocation</dt><dd>{ask?.invocationId ?? "—"}</dd></div>
          <div><dt>Work</dt><dd>{detail.id}</dd></div>
          <div><dt>Conversation</dt><dd>{detail.conversationId ?? "—"}</dd></div>
        </dl>
      </div>

      <div className="s-work-ask-actions">
        {observeRoute && (
          <WorkActionButton primary icon={<Radio aria-hidden="true" size={13} strokeWidth={1.8} />} onClick={() => openContent(navigate, observeRoute, { returnTo: route })}>{observeLabel}</WorkActionButton>
        )}
        <WorkActionButton icon={<Clipboard aria-hidden="true" size={13} strokeWidth={1.8} />} onClick={() => copyText(workAskStatusText(detail))}>Copy status</WorkActionButton>
        {detail.conversationId && (
          <WorkActionButton icon={<MessageSquare aria-hidden="true" size={13} strokeWidth={1.8} />} onClick={() => openContent(navigate, { view: "conversation", conversationId: detail.conversationId! }, { returnTo: route })}>Open chat</WorkActionButton>
        )}
        <WorkActionButton icon={<ExternalLink aria-hidden="true" size={13} strokeWidth={1.8} />} onClick={() => openContent(navigate, { view: "work", workId: detail.id }, { returnTo: route })}>Open work</WorkActionButton>
        {ask?.resolvedSessionId && (
          <WorkActionButton icon={<Radio aria-hidden="true" size={13} strokeWidth={1.8} />} onClick={() => openContent(navigate, { view: "sessions", sessionId: ask.resolvedSessionId! }, { returnTo: route })}>Open session</WorkActionButton>
        )}
        <WorkActionButton icon={<Activity aria-hidden="true" size={13} strokeWidth={1.8} />} onClick={() => openContent(navigate, tailRoute, { returnTo: route })}>Scout tail</WorkActionButton>
        {ids && <WorkActionButton icon={<Clipboard aria-hidden="true" size={13} strokeWidth={1.8} />} onClick={() => copyText(ids)}>Copy MCP ids</WorkActionButton>}
        {detail.conversationId && (
          <WorkActionButton icon={<MessageSquare aria-hidden="true" size={13} strokeWidth={1.8} />} onClick={() => openContent(navigate, { view: "conversation", conversationId: detail.conversationId! }, { returnTo: route })}>Nudge agent</WorkActionButton>
        )}
      </div>
    </section>
  );
}

function WorkMaterials({
  detail,
  navigate,
}: {
  detail: WorkDetail;
  navigate: (r: Route) => void;
}) {
  const hasThread = Boolean(detail.conversationId);
  const inventory = detail.inventory ?? fallbackInventory(detail);
  const planMaterials = inventory.materials.filter((material) =>
    material.kind === "plan" || material.kind === "spec"
  );
  const docMaterials = inventory.materials.filter((material) => material.kind === "doc");
  const codeMaterials = inventory.materials.filter((material) =>
    material.kind === "code"
    || material.kind === "test"
    || material.kind === "config"
    || material.kind === "asset"
    || material.kind === "other"
  );
  const hasPlanMaterials = planMaterials.length > 0;
  const hasDocMaterials = docMaterials.length > 0;
  const briefSummary = initialWorkBriefSummary(detail);
  const primarySummary = planMaterials[0]
    ? materialSummary(planMaterials[0])
    : briefSummary ?? "No plan or spec file detected yet.";
  const viewableMaterials = [...planMaterials, ...docMaterials, ...codeMaterials]
    .filter((material) => material.status !== "deleted");
  const [briefOpen, setBriefOpen] = useState(false);
  const [selectedMaterialId, setSelectedMaterialId] = useState<string | null>(null);
  const [materialContent, setMaterialContent] = useState<WorkMaterialContent | null>(null);
  const [materialError, setMaterialError] = useState<string | null>(null);
  const [loadingMaterialId, setLoadingMaterialId] = useState<string | null>(null);
  const [filesViewerOpen, setFilesViewerOpen] = useState(false);
  const [filesInitialKind, setFilesInitialKind] = useState<"all" | "plan" | "doc" | "code">("all");

  const openMaterial = useCallback((materialId: string) => {
    setBriefOpen(false);
    setSelectedMaterialId(materialId);
  }, []);

  const openBrief = useCallback(() => {
    setSelectedMaterialId(null);
    setBriefOpen(true);
  }, []);

  const openFiles = useCallback((kind: "all" | "plan" | "doc" | "code") => {
    setBriefOpen(false);
    setSelectedMaterialId(null);
    setFilesInitialKind(kind);
    setFilesViewerOpen(true);
  }, []);

  useEffect(() => {
    if (selectedMaterialId && !viewableMaterials.some((material) => material.id === selectedMaterialId)) {
      setSelectedMaterialId(null);
    }
  }, [selectedMaterialId, viewableMaterials]);

  useEffect(() => {
    if (!selectedMaterialId) {
      setMaterialContent(null);
      setMaterialError(null);
      setLoadingMaterialId(null);
      return;
    }
    let cancelled = false;
    setLoadingMaterialId(selectedMaterialId);
    setMaterialError(null);
    void api<WorkMaterialContent>(
      `/api/work/${encodeURIComponent(detail.id)}/material?materialId=${encodeURIComponent(selectedMaterialId)}`,
    )
      .then((content) => {
        if (!cancelled) {
          setMaterialContent(content);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setMaterialContent(null);
          setMaterialError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingMaterialId(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [detail.id, selectedMaterialId]);

  return (
    <section className="s-work-casefile-section s-work-materials-section">
      <div className="s-agent-section-heading">
        <div>
          <h2 className="s-agent-section-title">Work materials</h2>
          <p className="s-work-section-note">
            {inventoryModeLabel(inventory.mode)} · {inventory.source} evidence · {inventory.confidence} confidence
          </p>
        </div>
        <div className="s-work-inventory-meta" aria-label="Inventory totals">
          <span>{inventory.totals.materials} files</span>
          <span>{inventory.totals.agents} agents</span>
          <span>{inventory.totals.sessions} sessions</span>
        </div>
      </div>
      <div className="s-work-material-grid">
        <article className="s-work-material-card s-work-material-card-primary">
          <div className="s-work-material-head">
            <span className="s-work-material-icon" aria-hidden="true">
              <FileText size={15} strokeWidth={1.8} />
            </span>
            <div>
              <div className="s-work-material-kicker">{hasPlanMaterials ? "Plans & specs" : "Brief"}</div>
              <div className="s-work-material-title">
                {hasPlanMaterials ? `${planMaterials.length} surfaced` : briefSummary ? "Original request" : "No plan file yet"}
              </div>
            </div>
          </div>
          <p className="s-work-material-copy">{primarySummary}</p>
          <WorkMaterialList
            materials={planMaterials.slice(0, 3)}
            empty="No plan or spec files detected yet."
            selectedId={selectedMaterialId}
            onOpen={openMaterial}
          />
          <div className="s-work-material-card-actions">
            {briefSummary && (
              <button
                type="button"
                className={`s-work-material-link${briefOpen ? " s-work-material-link-active" : ""}`}
                onClick={openBrief}
              >
                <FileText aria-hidden="true" size={13} strokeWidth={1.8} />
                View request
              </button>
            )}
            {planMaterials.length > 3 && (
              <button
                type="button"
                className="s-work-material-link"
                onClick={() => openFiles("plan")}
              >
                <FolderTree aria-hidden="true" size={13} strokeWidth={1.8} />
                View all {planMaterials.length}
              </button>
            )}
          </div>
        </article>

        <div className={`s-work-material-evidence-stack${hasDocMaterials ? "" : " s-work-material-evidence-stack-single"}`}>
          {hasDocMaterials && (
            <article className="s-work-material-card s-work-material-card-docs">
              <div className="s-work-material-head">
                <span className="s-work-material-icon" aria-hidden="true">
                  <BookOpen size={15} strokeWidth={1.8} />
                </span>
                <div>
                  <div className="s-work-material-kicker">Docs</div>
                  <div className="s-work-material-title">{docMaterials.length} documents</div>
                </div>
              </div>
              <WorkMaterialList
                materials={docMaterials.slice(0, 3)}
                empty="Docs from git or trace evidence will appear here."
                selectedId={selectedMaterialId}
                onOpen={openMaterial}
              />
              {docMaterials.length > 3 && (
                <div className="s-work-material-card-actions">
                  <button
                    type="button"
                    className="s-work-material-link"
                    onClick={() => openFiles("doc")}
                  >
                    <FolderTree aria-hidden="true" size={13} strokeWidth={1.8} />
                    View all {docMaterials.length}
                  </button>
                </div>
              )}
            </article>
          )}

          <article className="s-work-material-card s-work-material-card-code">
            <div className="s-work-material-head">
              <span className="s-work-material-icon" aria-hidden="true">
                <Code2 size={15} strokeWidth={1.8} />
              </span>
              <div>
                <div className="s-work-material-kicker">Code</div>
                <div className="s-work-material-title">
                  {codeMaterials.length > 0 ? `${codeMaterials.length} related files` : "No code yet"}
                </div>
              </div>
            </div>
            <WorkMaterialList
              materials={codeMaterials.slice(0, 5)}
              empty="Changed code from git or session traces will appear here."
              selectedId={selectedMaterialId}
              onOpen={openMaterial}
            />
            {codeMaterials.length > 5 && (
              <div className="s-work-material-card-actions">
                <button
                  type="button"
                  className="s-work-material-link"
                  onClick={() => openFiles("code")}
                >
                  <FolderTree aria-hidden="true" size={13} strokeWidth={1.8} />
                  View all {codeMaterials.length}
                </button>
              </div>
            )}
          </article>
        </div>
      </div>
      <WorkBriefViewer
        detail={detail}
        summary={briefSummary}
        open={briefOpen}
        hasThread={hasThread}
        navigate={navigate}
        onClose={() => setBriefOpen(false)}
      />
      <WorkMaterialViewer
        material={viewableMaterials.find((material) => material.id === selectedMaterialId) ?? null}
        content={materialContent}
        loading={Boolean(loadingMaterialId)}
        error={materialError}
        onClose={() => setSelectedMaterialId(null)}
      />
      <WorkFilesViewer
        workId={detail.id}
        workTitle={detail.title}
        materials={viewableMaterials}
        open={filesViewerOpen}
        initialKind={filesInitialKind}
        onClose={() => setFilesViewerOpen(false)}
      />
      {inventory.limitations.length > 0 && (
        <div className="s-work-inventory-note">{inventory.limitations[0]}</div>
      )}
    </section>
  );
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

function initialWorkBriefSummary(detail: WorkDetail): string | null {
  const oldestFirst = [...detail.timeline].sort((a, b) => a.at - b.at);
  const createdEvent = oldestFirst.find((item) =>
    item.kind === "collaboration_event"
    && item.detailKind === "created"
    && item.summary
  );
  const openingMessage = oldestFirst.find((item) => item.kind === "message" && item.summary);
  return createdEvent?.summary ?? openingMessage?.summary ?? null;
}

function fallbackInventory(detail: WorkDetail): WorkMaterialsInventory {
  return {
    workId: detail.id,
    generatedAt: Date.now(),
    mode: "trace-only",
    source: "broker",
    confidence: "low",
    agents: [],
    sessions: [],
    materials: [],
    totals: {
      materials: 0,
      plans: 0,
      specs: 0,
      docs: 0,
      code: 0,
      tests: 0,
      config: 0,
      assets: 0,
      agents: 0,
      sessions: 0,
    },
    limitations: ["Inventory is not available from this server yet."],
  };
}

function inventoryModeLabel(mode: WorkMaterialsInventory["mode"]): string {
  switch (mode) {
    case "isolated-git-worktree":
      return "Isolated git worktree";
    case "shared-git-repo":
      return "Shared git repo";
    case "explicit-artifacts":
      return "Explicit artifacts";
    case "trace-only":
    default:
      return "Trace-only";
  }
}

function materialSummary(material: WorkMaterial): string {
  const stats = material.diffStat
    ? `+${material.diffStat.additions} / -${material.diffStat.deletions}`
    : material.status;
  return `${material.path} · ${stats} · ${material.confidence} confidence`;
}

function WorkMaterialList({
  materials,
  empty,
  selectedId,
  onOpen,
}: {
  materials: WorkMaterial[];
  empty: string;
  selectedId?: string | null;
  onOpen?: (materialId: string) => void;
}) {
  if (materials.length === 0) {
    return <div className="s-work-material-empty">{empty}</div>;
  }

  return (
    <div className="s-work-material-list">
      {materials.map((material) => (
        <button
          key={material.id}
          type="button"
          className={`s-work-material-row${selectedId === material.id ? " s-work-material-row-active" : ""}`}
          title={material.path}
          onClick={() => onOpen?.(material.id)}
          disabled={!onOpen || material.status === "deleted"}
        >
          <div className="s-work-material-path">{material.path}</div>
          <div className="s-work-material-row-meta">
            <span>{material.status}</span>
            {material.diffStat && (
              <span>+{material.diffStat.additions} -{material.diffStat.deletions}</span>
            )}
            <span>{material.confidence}</span>
          </div>
        </button>
      ))}
    </div>
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

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${Math.round(value / 1024)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function compactId(id: string): string {
  const parts = id.split(".");
  return parts[parts.length - 1] || id;
}

type WorkTailContext = {
  query: string;
  label: string;
};

function addTailTerm(terms: Set<string>, value: string | null | undefined): void {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length < 3) return;
  terms.add(trimmed);
}

function addWorkPathTailTerms(terms: Set<string>, value: string | null | undefined): void {
  addTailTerm(terms, value);
  const normalized = value?.trim().replace(/\/+$/, "");
  const lastSegment = normalized?.split("/").filter(Boolean).at(-1);
  if (lastSegment && lastSegment.length >= 3) {
    terms.add(lastSegment);
  }
}

function prettyWorkPath(value: string): string {
  return value.replace(/^\/Users\/[^/]+/, "~");
}

function buildWorkTailContext(detail: WorkDetail): WorkTailContext {
  const terms = new Set<string>();
  const labelParts: string[] = [];
  const ownerLabel = detail.ownerName ?? detail.ownerId ?? detail.nextMoveOwnerName ?? detail.nextMoveOwnerId;

  addTailTerm(terms, detail.id);
  addTailTerm(terms, detail.conversationId);
  addTailTerm(terms, detail.ownerId);
  addTailTerm(terms, detail.nextMoveOwnerId);
  addTailTerm(terms, detail.ownerName);
  addTailTerm(terms, detail.nextMoveOwnerName);

  for (const flight of detail.activeFlights) {
    addTailTerm(terms, flight.id);
    addTailTerm(terms, flight.invocationId);
    addTailTerm(terms, flight.agentId);
    addTailTerm(terms, flight.agentName);
    addTailTerm(terms, flight.conversationId);
    addTailTerm(terms, flight.collaborationRecordId);
  }

  for (const agent of detail.inventory?.agents ?? []) {
    addTailTerm(terms, agent.id);
    addTailTerm(terms, agent.name);
    addTailTerm(terms, agent.sessionId);
    addWorkPathTailTerms(terms, agent.cwd);
    addWorkPathTailTerms(terms, agent.projectRoot);
  }

  const primarySession = detail.inventory?.sessions.find((session) => session.cwd)
    ?? detail.inventory?.sessions[0]
    ?? null;
  for (const session of detail.inventory?.sessions ?? []) {
    addTailTerm(terms, session.id);
    addTailTerm(terms, session.conversationId);
    addTailTerm(terms, session.agentId);
    addTailTerm(terms, session.agentName);
    addWorkPathTailTerms(terms, session.cwd);
  }

  if (ownerLabel) {
    labelParts.push(ownerLabel);
  }
  if (primarySession?.cwd) {
    labelParts.push(prettyWorkPath(primarySession.cwd));
  }

  return {
    query: [...terms].slice(0, 20).join("|"),
    label: labelParts.length > 0 ? labelParts.join(" · ") : `Case ${compactId(detail.id)}`,
  };
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
  const items = detail.timeline.slice(0, 18);
  if (items.length === 0) return null;
  return (
    <section className="s-work-casefile-section s-work-timeline-panel">
      <div className="s-agent-section-heading">
        <div>
          <h2 className="s-agent-section-title">Timeline</h2>
          <p className="s-work-section-note">Run lifecycle, follow-up requirements, flight state, and replies attached to this work item.</p>
        </div>
      </div>
      <div className="s-work-timeline-list">
        {items.map((item) => (
          <article
            key={item.id}
            className={`s-work-timeline-row s-work-timeline-row-${item.kind}`}
            data-kind={item.kind}
            data-flight-id={item.flightId ?? undefined}
            data-work-id={detail.id}
            data-conversation-id={item.conversationId ?? detail.conversationId ?? undefined}
          >
            <span className="s-work-timeline-badge">{timelineKindLabel(item)}</span>
            <div className="s-work-timeline-body">
              <div className="s-work-timeline-meta">
                <span>{item.actorName ?? item.actorId ?? "system"}</span>
                <span>{timeAgo(item.at)}</span>
              </div>
              {item.summary && <p>{renderWithMentions(item.summary)}</p>}
            </div>
          </article>
        ))}
      </div>
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
  const tailContext = buildWorkTailContext(detail);

  return (
    <section className="s-work-casefile-section s-work-tail-section">
      <div className="s-agent-section-heading s-work-tail-heading">
        <div>
          <h2 className="s-agent-section-title s-work-tail-title">
            <Activity aria-hidden="true" size={15} strokeWidth={1.8} />
            Live tail
          </h2>
          <p className="s-work-section-note">Filtered to {tailContext.label}</p>
        </div>
        <WorkActionButton
          icon={<ExternalLink aria-hidden="true" size={13} strokeWidth={1.8} />}
          onClick={() =>
            openContent(
              navigate,
              { view: "ops", mode: "tail", tailQuery: tailContext.query || undefined },
              { returnTo: route },
            )}
        >
          Scout tail
        </WorkActionButton>
      </div>
      <div className="s-work-tail-frame">
        <TailView
          navigate={navigate}
          initialFilter={tailContext.query}
          filterLabel={tailContext.label}
          filterScope="context"
          chrome="embedded"
        />
      </div>
    </section>
  );
}

export function WorkDetailScreen({
  workId,
  navigate,
}: {
  workId: string;
  navigate: (r: Route) => void;
}) {
  const { agents, route } = useScout();
  const [detail, setDetail] = useState<WorkDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const next = await api<WorkDetail>(`/api/work/${encodeURIComponent(workId)}`);
      setDetail(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setDetail(null);
    } finally {
      setLoaded(true);
    }
  }, [workId]);

  useEffect(() => {
    setLoaded(false);
    void load();
  }, [load]);
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

  if (!loaded) {
    return (
      <div>
        <BackToPicker slot="work" fallback={{ view: "inbox" }} navigate={navigate} />
        <div className="s-empty"><p>Loading…</p></div>
      </div>
    );
  }

  if (!detail || !scopedDetail) {
    return (
      <div className="s-work-not-found">
        <BackToPicker slot="work" fallback={{ view: "inbox" }} navigate={navigate} />
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
  const actionCue = buildActionCue({
    detail: visibleDetail,
    signal,
    ownerLabel,
    nextMoveLabel,
  });
  const hasLowerContent = visibleDetail.activeFlights.length > 0 || visibleDetail.childWork.length > 0;

  return (
    <div className="s-work-detail s-work-casefile">
      <div className="s-work-casefile-topbar">
        <BackToPicker slot="work" fallback={{ view: "inbox" }} navigate={navigate} />
        <span className="s-work-casefile-record">Case {compactId(visibleDetail.id)}</span>
      </div>

      {error && <p className="s-error">{error}</p>}

      <section className="s-work-casefile-hero">
        <div className="s-work-casefile-hero-main">
          <div className="s-work-casefile-title-row">
            <h1 className="s-work-casefile-title">{visibleDetail.title}</h1>
            <StatusPill tone={workTone(visibleDetail)} variant="pill">{visibleDetail.currentPhase}</StatusPill>
          </div>
          {visibleDetail.lastMeaningfulSummary && (
            <div className="s-work-casefile-summary">
              {renderWithMentions(visibleDetail.lastMeaningfulSummary)}
            </div>
          )}
          <div className="s-work-casefile-meta">
            <span>Updated {timeAgo(visibleDetail.updatedAt)}</span>
            <span>{ownerLabel}</span>
            <span>{stateLabel(visibleDetail.state)}</span>
            {signal && <span>{signal}</span>}
            {visibleDetail.priority && <span>Priority {visibleDetail.priority}</span>}
          </div>
        </div>

        <aside className={`s-work-next-move s-work-next-move-${actionCue.tone}`}>
          <div className="s-work-next-move-kicker">{actionCue.eyebrow}</div>
          <div className="s-work-next-move-title">{actionCue.title}</div>
          <p className="s-work-next-move-copy">{actionCue.body}</p>
          <div className="s-work-next-move-actions">
            {visibleDetail.conversationId && (
              <WorkActionButton
                primary
                icon={<MessageSquare aria-hidden="true" size={14} strokeWidth={1.8} />}
                onClick={() => openContent(navigate, { view: "conversation", conversationId: visibleDetail.conversationId! }, { returnTo: route })}
              >
                Open thread
              </WorkActionButton>
            )}
          </div>
        </aside>
      </section>

      <div className="s-work-casefile-layout s-work-casefile-layout-main">
        <div className="s-work-casefile-main s-work-casefile-main-materials">
          <WorkAskOverview detail={visibleDetail} navigate={navigate} />
          <WorkMaterials detail={visibleDetail} navigate={navigate} />
          <WorkTimelinePanel detail={visibleDetail} />
        </div>

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
