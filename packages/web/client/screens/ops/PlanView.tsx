import "./plan-view.css";
import "../../components/document-focus-viewer.css";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createTextDocument, TextDocumentSurface } from "../../components/TextDocumentSurface.tsx";
import { api } from "../../lib/api.ts";
import { useBrokerEvents } from "../../lib/sse.ts";
import { formatAbsoluteTimestamp, timeAgo } from "../../lib/time.ts";
import type {
  Agent,
  PlanDocument,
  PlanDocumentStatus,
  PlanDocumentsResponse,
  Route,
} from "../../lib/types.ts";

const STATUS_LABELS: Record<PlanDocumentStatus, string> = {
  active: "Active",
  archived: "Archived",
  blocked: "Blocked",
  completed: "Complete",
  draft: "Draft",
  unknown: "Unknown",
};

const STATUS_COLORS: Record<PlanDocumentStatus, string> = {
  active: "var(--green)",
  archived: "var(--dim)",
  blocked: "var(--amber)",
  completed: "var(--muted)",
  draft: "var(--accent)",
  unknown: "var(--dim)",
};

function formatSource(document: PlanDocument): string {
  switch (document.source) {
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
    case "openscout":
      return "OpenScout";
    case "workspace":
      return "Workspace";
    case "unknown":
      return "Other";
  }
}

export function PlanView({
  navigate,
  agents,
  selectedPlanDocumentId,
}: {
  navigate: (r: Route) => void;
  agents: Agent[];
  selectedPlanDocumentId?: string;
}) {
  const [inventory, setInventory] = useState<PlanDocumentsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const requestSeqRef = useRef(0);

  const load = useCallback(async () => {
    const requestSeq = ++requestSeqRef.current;
    setLoading(true);
    const documentsResult = await Promise.resolve(api<PlanDocumentsResponse>("/api/plan-documents"))
      .then((value) => ({ status: "fulfilled" as const, value }))
      .catch((reason) => ({ status: "rejected" as const, reason }));

    if (requestSeq !== requestSeqRef.current) return;

    if (documentsResult.status === "fulfilled") setInventory(documentsResult.value);

    const errors = [
      documentsResult.status === "rejected" ? `plans: ${documentsResult.reason instanceof Error ? documentsResult.reason.message : String(documentsResult.reason)}` : null,
    ].filter((error): error is string => Boolean(error));
    setLoadError(errors.length > 0 ? errors.join(" · ") : null);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useBrokerEvents(() => {
    void load();
  });

  const agentsById = useMemo(
    () => Object.fromEntries(agents.map((agent) => [agent.id, agent])),
    [agents],
  );

  const documents = inventory?.documents ?? [];

  const selectedDocument = useMemo(
    () => documents.find((document) => document.id === selectedPlanDocumentId)
      ?? documents[0]
      ?? null,
    [documents, selectedPlanDocumentId],
  );

  useEffect(() => {
    if (
      documents.length > 0
      && (!selectedPlanDocumentId || !documents.some((document) => document.id === selectedPlanDocumentId))
    ) {
      navigate({ view: "ops", mode: "plan", planDocumentId: documents[0].id });
    }
  }, [documents, navigate, selectedPlanDocumentId]);

  const sourceCounts = useMemo(() => {
    const counts = {
      claude: 0,
      codex: 0,
      openscout: 0,
      workspace: 0,
      unknown: 0,
    };
    for (const document of documents) counts[document.source] += 1;
    return counts;
  }, [documents]);

  return (
    <div className="s-plan">
      <div className="s-plan-inner s-plan-inner--documents">
        <header className="s-plan-banner">
          <span className="s-plan-banner-badge">Plan Documents</span>
          <span className="s-plan-banner-meta">
            {loading && documents.length === 0
              ? "indexing plan documents..."
              : `${documents.length} document${documents.length === 1 ? "" : "s"} · ${sourceCounts.claude} Claude · ${sourceCounts.codex} Codex · ${sourceCounts.openscout} OpenScout · ${sourceCounts.workspace} workspace`}
          </span>
          {inventory && (
            <span className="s-plan-banner-meta">
              {inventory.roots.length} roots · updated {timeAgo(inventory.generatedAt)}
            </span>
          )}
          {loadError && <span className="s-plan-banner-meta s-plan-banner-meta--error">partial data · {loadError}</span>}
          <span className="s-plan-banner-spacer" />
          <button className="s-ops-btn" onClick={() => void load()} disabled={loading}>
            {loading ? "Indexing..." : "Refresh"}
          </button>
        </header>

        <main className="s-plan-col s-plan-col--canvas">
          {selectedDocument ? (
            <PlanDocumentDetail document={selectedDocument} agentsById={agentsById} />
          ) : (
            <div className="s-plan-empty-card">
              <div className="s-plan-empty-title">No plan document selected</div>
              <div className="s-plan-empty-copy">The plan inventory will appear here once the index finds documents.</div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function PlanDocumentDetail({
  document,
  agentsById,
}: {
  document: PlanDocument;
  agentsById: Record<string, Agent>;
}) {
  const [mode, setMode] = useState<"preview" | "source">("preview");
  const owner = document.agentId ? agentsById[document.agentId] : null;
  const renderedDocument = useMemo(
    () => createTextDocument({
      id: document.id,
      title: document.title,
      uri: document.path,
      filename: document.path,
      mediaType: "text/markdown",
      kind: "markdown",
      value: document.body || document.rawText,
      readOnly: true,
    }),
    [document],
  );
  useEffect(() => {
    setMode("preview");
  }, [document.id]);
  return (
    <div className="s-plan-document">
      <div className="s-plan-readonly-head">
        <div>
          <div className="s-ops-eyebrow">Plan document</div>
          <h1 className="s-plan-title">{document.title}</h1>
          {document.summary && <p className="s-plan-goal">{document.summary}</p>}
        </div>
        <span className="s-ops-state-chip" style={{ color: STATUS_COLORS[document.status] }}>
          {STATUS_LABELS[document.status]}
        </span>
      </div>

      <section className="s-plan-doc-section s-plan-doc-section--primary">
        <div className="s-plan-tree-header">
          <div className="s-ops-eyebrow" style={{ marginBottom: 0 }}>Document</div>
          <span className="s-plan-tree-stats">{document.body.length.toLocaleString()} chars · {document.path}</span>
          <div className="s-plan-tree-toggle s-plan-doc-mode-toggle">
            <button
              type="button"
              className={`s-plan-tree-toggle-btn${mode === "preview" ? " s-plan-tree-toggle-btn--active" : ""}`}
              onClick={() => setMode("preview")}
            >
              Preview
            </button>
            <button
              type="button"
              className={`s-plan-tree-toggle-btn${mode === "source" ? " s-plan-tree-toggle-btn--active" : ""}`}
              onClick={() => setMode("source")}
            >
              Source
            </button>
          </div>
        </div>
        {mode === "preview" ? (
          <TextDocumentSurface
            document={renderedDocument}
            mode="preview"
            className="s-plan-doc-preview s-plan-doc-body--primary"
          />
        ) : (
          <pre className="s-plan-doc-body s-plan-doc-body--primary">{document.body || document.rawText}</pre>
        )}
      </section>

      <section className="s-plan-doc-section">
        <div className="s-ops-eyebrow">Provenance</div>
        <dl className="s-plan-doc-meta">
          <MetaLine label="Source" value={`${formatSource(document)} · ${document.confidence}`} />
          <MetaLine label="Path" value={document.path} />
          <MetaLine label="Workspace" value={document.workspaceName ?? document.provenance.root} />
          <MetaLine label="Agent" value={document.agentName ?? owner?.name ?? document.agentId ?? "unassigned"} />
          <MetaLine label="Updated" value={formatAbsoluteTimestamp(document.updatedAt) || "unknown"} />
        </dl>
      </section>
    </div>
  );
}

function MetaLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="s-plan-doc-meta-row">
      <dt>{label}</dt>
      <dd title={value}>{value}</dd>
    </div>
  );
}
