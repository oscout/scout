import { useCallback, useEffect, useMemo, useState } from "react";
import { EmptyState } from "../../components/EmptyState.tsx";
import { api } from "../../lib/api.ts";
import { ScoutbotMarkdown } from "../../lib/scoutbot-markdown.tsx";
import { fullTimestamp, timeAgo } from "../../lib/time.ts";
import type { Route } from "../../lib/types.ts";
import "../system-surfaces-redesign.css";
import "./briefings.css";

type BriefingKind = "fleet-home" | "tour";

type BriefingDetail = {
  id: string;
  kind: BriefingKind;
  title: string;
  summary: string;
  recommendation: string | null;
  preparedAt: number;
  ttlMs: number;
  brief: BriefBody | null;
  observations: ObservationItem[];
  snapshot: SnapshotBody | null;
  call: CallBody | null;
  /** SCO-037: canonical markdown body. Null for rows persisted before the markdown pipeline. */
  markdown: string | null;
  createdAt: number;
};

type BriefBody = {
  id: string;
  title: string;
  summary: string;
  recommendation: string;
  steps: BriefStep[];
  actions: BriefAction[];
  presented?: PresentedBody | null;
};

type PresentedBody = {
  sentences: string[];
  voiceSpec: { targetWords: number; persona: string };
  model: string;
  responseId: string | null;
};

type BriefStep = {
  id: string;
  label: string;
  route?: Record<string, unknown>;
  narration: string;
  observations?: ObservationItem[];
};

type BriefAction = {
  label: string;
  route?: Record<string, unknown>;
  prompt?: string;
};

type ObservationItem = {
  text: string;
  tone?: string;
  references: ReferenceItem[];
};

type ReferenceItem = {
  label: string;
  kind: string;
  route?: Record<string, unknown>;
  detail?: string;
};

type SnapshotBody = {
  generatedAt?: string;
  currentDirectory?: string;
  currentRoute?: unknown;
  state?: Record<string, unknown>;
};

type CallBody = {
  model: string;
  systemPrompt: string;
  operatorRequest: string;
  responseId: string | null;
  telemetry?: CallTelemetry | null;
  presenter?: PresenterTelemetry | null;
};

type CallTelemetry = {
  elapsedMs: number;
  usage: TokenUsage | null;
};

type TokenUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
};

type PresenterTelemetry = CallTelemetry & {
  model: string;
  responseId: string | null;
  skipped: "rate-guard" | "error" | null;
  errorMessage?: string;
};

const KIND_LABEL: Record<BriefingKind, string> = {
  "fleet-home": "fleet briefing",
  tour: "tour briefing",
};

export function BriefingDetailScreen({
  briefingId,
  navigate,
}: {
  briefingId: string;
  navigate: (r: Route) => void;
}) {
  const [detail, setDetail] = useState<BriefingDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await api<BriefingDetail>(
        `/api/briefings/${encodeURIComponent(briefingId)}`,
      );
      setDetail(response);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load briefing");
    }
  }, [briefingId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <div className="sys-surface-page sys-surface-page-wide">
        <button
          type="button"
          className="briefing-detail-back"
          onClick={() => navigate({ view: "briefings" })}
        >
          ← back to briefings
        </button>
        <EmptyState title="Couldn't load briefing" body={error} />
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="sys-surface-page sys-surface-page-wide">
        <div className="briefings-placeholder">Loading briefing...</div>
      </div>
    );
  }

  return (
    <div className="sys-surface-page sys-surface-page-wide briefing-detail">
      <button
        type="button"
        className="briefing-detail-back"
        onClick={() => navigate({ view: "briefings" })}
      >
        ← back to briefings
      </button>

      <header className="briefing-detail-header">
        <h2>{detail.title}</h2>
        <div className="briefing-detail-header-meta">
          <span className={`briefing-kind briefing-kind-${detail.kind}`}>
            {KIND_LABEL[detail.kind]}
          </span>
          <span>{fullTimestamp(detail.preparedAt)}</span>
          <span>· {timeAgo(detail.preparedAt)}</span>
        </div>
        <p className="briefing-detail-summary">{detail.summary}</p>
        {detail.recommendation ? (
          <div className="briefing-detail-recommendation">
            {detail.recommendation}
          </div>
        ) : null}
      </header>

      {detail.markdown ? (
        <MarkdownLayer markdown={detail.markdown} />
      ) : null}
      {detail.brief?.presented ? (
        <PresentedLayer presented={detail.brief.presented} />
      ) : null}
      <TelemetryLayer call={detail.call} />
      <BriefLayer brief={detail.brief} navigate={navigate} />
      <ObservationsLayer
        observations={detail.observations}
        navigate={navigate}
      />
      <SnapshotLayer snapshot={detail.snapshot} call={detail.call} />
    </div>
  );
}

function MarkdownLayer({ markdown }: { markdown: string }) {
  return (
    <section className="briefing-layer briefing-layer-markdown">
      <LayerHead eyebrow="Layer 0" title="Brief (markdown)" />
      <div className="briefing-markdown">
        <ScoutbotMarkdown text={markdown} />
      </div>
    </section>
  );
}

function TelemetryLayer({ call }: { call: CallBody | null }) {
  if (!call || (!call.telemetry && !call.presenter)) return null;
  return (
    <section className="briefing-layer briefing-layer-telemetry">
      <LayerHead eyebrow="Telemetry" title="Calls & usage" />
      <dl className="briefing-telemetry">
        <CallTelemetryRow
          label="Analyst"
          model={call.model}
          responseId={call.responseId}
          telemetry={call.telemetry ?? null}
        />
        {call.presenter ? (
          <CallTelemetryRow
            label="Presenter"
            model={call.presenter.model}
            responseId={call.presenter.responseId}
            telemetry={call.presenter}
            note={
              call.presenter.skipped === "rate-guard"
                ? "skipped — rate-guard hit"
                : call.presenter.skipped === "error"
                  ? `failed — ${call.presenter.errorMessage ?? "unknown"}`
                  : null
            }
          />
        ) : null}
      </dl>
    </section>
  );
}

function CallTelemetryRow({
  label,
  model,
  responseId,
  telemetry,
  note,
}: {
  label: string;
  model: string;
  responseId: string | null;
  telemetry: CallTelemetry | null;
  note?: string | null;
}) {
  const usage = telemetry?.usage ?? null;
  return (
    <div className="briefing-telemetry-row">
      <div className="briefing-telemetry-row-head">
        <span className="briefing-telemetry-label">{label}</span>
        <span className="briefing-telemetry-model">{model}</span>
        {note ? <span className="briefing-telemetry-note">{note}</span> : null}
      </div>
      <div className="briefing-telemetry-stats">
        <span>{telemetry && telemetry.elapsedMs > 0 ? `${(telemetry.elapsedMs / 1000).toFixed(2)}s` : "—"}</span>
        <span>in {usage?.inputTokens ?? "—"}</span>
        <span>out {usage?.outputTokens ?? "—"}</span>
        <span>total {usage?.totalTokens ?? "—"}</span>
        {responseId ? <span className="briefing-telemetry-response">{responseId}</span> : null}
      </div>
    </div>
  );
}

function PresentedLayer({ presented }: { presented: PresentedBody }) {
  return (
    <section className="briefing-layer briefing-layer-presented">
      <LayerHead
        eyebrow="Spoken"
        title={`Presented as · ${presented.voiceSpec.persona}, ~${presented.voiceSpec.targetWords} words`}
      />
      <ol className="briefing-presented-sentences">
        {presented.sentences.map((sentence, idx) => (
          <li key={idx} className="briefing-presented-sentence">
            {sentence}
          </li>
        ))}
      </ol>
      <div className="briefing-presented-meta">
        model: {presented.model}
        {presented.responseId ? ` · response: ${presented.responseId}` : ""}
      </div>
    </section>
  );
}

function BriefLayer({
  brief,
  navigate,
}: {
  brief: BriefBody | null;
  navigate: (r: Route) => void;
}) {
  if (!brief) {
    return (
      <section className="briefing-layer">
        <LayerHead eyebrow="Layer 3" title="Brief & call" />
        <p className="briefings-placeholder">No brief body persisted.</p>
      </section>
    );
  }
  return (
    <section className="briefing-layer">
      <LayerHead eyebrow="Layer 3" title="Brief" />
      {brief.steps.length > 0 ? (
        <ol className="briefing-steps">
          {brief.steps.map((step, idx) => (
            <li key={step.id ?? idx} className="briefing-step">
              <div className="briefing-step-label">
                {idx + 1}. {step.label}
              </div>
              {step.narration ? (
                <p className="briefing-step-narration">{step.narration}</p>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
      {brief.actions.length > 0 ? (
        <div className="briefing-actions">
          {brief.actions.map((action, idx) => (
            <button
              type="button"
              key={`${action.label}-${idx}`}
              className="s-btn"
              onClick={() => {
                if (action.route) navigate(action.route as Route);
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function ObservationsLayer({
  observations,
  navigate,
}: {
  observations: ObservationItem[];
  navigate: (r: Route) => void;
}) {
  return (
    <section className="briefing-layer">
      <LayerHead
        eyebrow="Layer 2"
        title={`Observations (${observations.length})`}
      />
      {observations.length === 0 ? (
        <p className="briefings-placeholder">No observations on this brief.</p>
      ) : (
        <div className="briefing-observations">
          {observations.map((obs, idx) => {
            const toneClass = obs.tone === "warn"
              ? "briefing-observation-warn"
              : obs.tone === "err" || obs.tone === "error"
              ? "briefing-observation-err"
              : "";
            return (
              <div
                key={idx}
                className={`briefing-observation ${toneClass}`.trim()}
              >
                <div className="briefing-observation-text">{obs.text}</div>
                {obs.references.length > 0 ? (
                  <div className="briefing-observation-refs">
                    {obs.references.map((ref, ridx) => (
                      <ReferenceChip
                        key={`${ref.label}-${ridx}`}
                        reference={ref}
                        navigate={navigate}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function ReferenceChip({
  reference,
  navigate,
}: {
  reference: ReferenceItem;
  navigate: (r: Route) => void;
}) {
  const hasRoute = Boolean(reference.route);
  const label = reference.detail
    ? `${reference.label} · ${reference.detail}`
    : reference.label;
  if (!hasRoute) {
    return (
      <span className="briefing-ref-chip briefing-ref-chip-static">{label}</span>
    );
  }
  return (
    <button
      type="button"
      className="briefing-ref-chip"
      onClick={() => navigate(reference.route as Route)}
    >
      {label}
    </button>
  );
}

function SnapshotLayer({
  snapshot,
  call,
}: {
  snapshot: SnapshotBody | null;
  call: CallBody | null;
}) {
  const counts = useMemo(() => deriveSnapshotCounts(snapshot), [snapshot]);
  const [showRaw, setShowRaw] = useState(false);

  return (
    <section className="briefing-layer">
      <LayerHead eyebrow="Layer 1" title="Read snapshot" />
      {counts.length > 0 ? (
        <div className="briefing-snapshot-counts">
          {counts.map((c) => (
            <span key={c.label} className="briefing-snapshot-count">
              <strong>{c.value}</strong> {c.label}
            </span>
          ))}
        </div>
      ) : null}
      {call ? (
        <details className="briefing-snapshot-section">
          <summary className="briefing-snapshot-section-head">
            Call metadata
          </summary>
          <dl className="briefing-call-grid">
            <dt>Model</dt>
            <dd>{call.model}</dd>
            <dt>Response ID</dt>
            <dd>{call.responseId ?? "—"}</dd>
            <dt>System prompt</dt>
            <dd>
              <pre className="briefing-call-prompt">{call.systemPrompt}</pre>
            </dd>
            <dt>Operator request</dt>
            <dd>
              <pre className="briefing-call-prompt">{call.operatorRequest}</pre>
            </dd>
          </dl>
        </details>
      ) : null}
      <div className="briefing-snapshot-section">
        <button
          type="button"
          className="briefing-detail-back"
          onClick={() => setShowRaw((v) => !v)}
        >
          {showRaw ? "Hide raw snapshot" : "Show raw snapshot JSON"}
        </button>
        {showRaw ? (
          <pre className="briefing-snapshot-raw">
            {JSON.stringify(snapshot ?? {}, null, 2)}
          </pre>
        ) : null}
      </div>
    </section>
  );
}

function LayerHead({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div className="briefing-layer-head">
      <span className="briefing-layer-eyebrow">{eyebrow}</span>
      <span className="briefing-layer-title">{title}</span>
    </div>
  );
}

function deriveSnapshotCounts(
  snapshot: SnapshotBody | null,
): Array<{ label: string; value: number }> {
  if (!snapshot?.state) return [];
  const state = snapshot.state;
  const counts: Array<{ label: string; value: number }> = [];
  const tryCount = (label: string, value: unknown) => {
    if (Array.isArray(value)) counts.push({ label, value: value.length });
  };
  tryCount("agents", state.agents);
  if (state.fleet && typeof state.fleet === "object") {
    const fleet = state.fleet as Record<string, unknown>;
    tryCount("active requests", fleet.activeAsks);
    tryCount("attention", fleet.needsAttention);
    tryCount("recent", fleet.recentCompleted);
  }
  if (state.broker && typeof state.broker === "object") {
    const broker = state.broker as Record<string, unknown>;
    tryCount("broker msgs", broker.recentMessages);
  }
  tryCount("scout chatter", state.scoutChatter);
  tryCount("tail events", state.agentLogMessages);
  if (state.operatorAttention && typeof state.operatorAttention === "object") {
    const op = state.operatorAttention as Record<string, unknown>;
    tryCount("operator items", op.items);
  }
  return counts;
}
