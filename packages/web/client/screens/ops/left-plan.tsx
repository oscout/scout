import { useCallback, useEffect, useMemo, useState } from "react";
import "../../scout/slots/ctx-panel.css";
import { api } from "../../lib/api.ts";
import { useBrokerEvents } from "../../lib/sse.ts";
import { timeAgo } from "../../lib/time.ts";
import { useScout } from "../../scout/Provider.tsx";
import { FleetSearch } from "../../scout/slots/FleetSearch.tsx";
import type {
  PlanDocument,
  PlanDocumentSource,
  PlanDocumentStatus,
  PlanDocumentsResponse,
} from "../../lib/types.ts";

type PlanSourceFilter = "all" | PlanDocumentSource;

const PLAN_SOURCE_LABELS: Record<PlanSourceFilter, string> = {
  all: "All",
  claude: "Claude",
  codex: "Codex",
  openscout: "OpenScout",
  workspace: "Workspace",
  unknown: "Other",
};

const PLAN_STATUS_LABELS: Record<PlanDocumentStatus, string> = {
  active: "Active",
  archived: "Archived",
  blocked: "Blocked",
  completed: "Complete",
  draft: "Draft",
  unknown: "Unknown",
};

function planPathBasename(value: string): string {
  const clean = value.replace(/\\/g, "/").replace(/\/+$/g, "");
  const idx = clean.lastIndexOf("/");
  return idx >= 0 ? clean.slice(idx + 1) : clean;
}

function planProgressLabel(document: PlanDocument): string {
  if (document.steps.length === 0) return "No steps";
  const done = document.steps.filter((step) => step.status === "completed").length;
  return `${done}/${document.steps.length} steps`;
}

function planDocumentSearchText(document: PlanDocument): string {
  return [
    document.title,
    document.summary,
    document.source,
    document.documentKind,
    document.status,
    document.path,
    document.workspaceName,
    document.agentName,
    document.tags.join(" "),
    document.steps.map((step) => step.text).join(" "),
  ].filter(Boolean).join(" ").toLowerCase();
}

export function OpsPlanLeft() {
  const { route, navigate } = useScout();
  const [inventory, setInventory] = useState<PlanDocumentsResponse | null>(null);
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<PlanSourceFilter>("all");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const data = await api<PlanDocumentsResponse>("/api/plan-documents").catch(() => null);
    setInventory(data);
    setLoading(false);
  }, []);

  useEffect(() => {
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
  const selectedId = route.view === "ops" && route.mode === "plan" ? route.planDocumentId : undefined;
  const normalizedQuery = query.trim().toLowerCase();
  const sourceCounts = useMemo(() => {
    const counts: Record<PlanSourceFilter, number> = {
      all: documents.length,
      claude: 0,
      codex: 0,
      openscout: 0,
      workspace: 0,
      unknown: 0,
    };
    for (const document of documents) counts[document.source] += 1;
    return counts;
  }, [documents]);
  const visibleDocuments = useMemo(
    () => documents
      .filter((document) => sourceFilter === "all" || document.source === sourceFilter)
      .filter((document) => !normalizedQuery || planDocumentSearchText(document).includes(normalizedQuery)),
    [documents, normalizedQuery, sourceFilter],
  );

  return (
    <div className="s-plan-left-nav">
      <div className="s-left-roster-search">
        <FleetSearch
          value={query}
          onChange={setQuery}
          placeholder="Search plan documents..."
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              if (query) setQuery("");
              else (event.target as HTMLInputElement).blur();
            }
          }}
        />
      </div>
      <div className="s-plan-left-source-grid">
        {(["all", "claude", "codex", "openscout", "workspace"] as PlanSourceFilter[]).map((source) => (
          <button
            key={source}
            type="button"
            className={`s-plan-left-source${sourceFilter === source ? " s-plan-left-source--active" : ""}`}
            onClick={() => setSourceFilter(source)}
          >
            <span>{PLAN_SOURCE_LABELS[source]}</span>
            <strong>{sourceCounts[source]}</strong>
          </button>
        ))}
      </div>
      <div className="s-plan-left-list">
        {loading && documents.length === 0 ? (
          <div className="s-left-roster-empty">Indexing plan documents...</div>
        ) : visibleDocuments.length === 0 ? (
          <div className="s-left-roster-empty">{documents.length === 0 ? "No plan documents found" : "No plans match"}</div>
        ) : (
          visibleDocuments.map((document) => (
            <button
              key={document.id}
              type="button"
              className={`s-plan-left-document${document.id === selectedId ? " s-plan-left-document--active" : ""}`}
              onClick={() => navigate({ view: "ops", mode: "plan", planDocumentId: document.id })}
              title={`${document.path}\n${document.summary ?? ""}`}
            >
              <div className="s-plan-left-document-top">
                <span className={`s-plan-left-status s-plan-left-status--${document.status}`}>
                  {PLAN_STATUS_LABELS[document.status]}
                </span>
                <span>{PLAN_SOURCE_LABELS[document.source]}</span>
                <time>{timeAgo(document.updatedAt)}</time>
              </div>
              <div className="s-plan-left-document-title">{document.title}</div>
              {document.summary && <div className="s-plan-left-document-summary">{document.summary}</div>}
              <div className="s-plan-left-document-foot">
                <span>{planProgressLabel(document)}</span>
                <span>{planPathBasename(document.path)}</span>
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
