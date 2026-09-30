import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import type { ObserveData } from "../../lib/types.ts";
import {
  buildJevRequestBody,
  buildSessionRetrospectiveProfile,
  retrospectiveLabelEvidence,
  type JevLabelEvidence,
  type SessionRetrospectiveProfile,
} from "../../../shared/session-retrospective.ts";
import { formatRetrospectiveTime, retrospectiveParticipants, retrospectiveTimelineEvents } from "./retrospective.ts";
import "./session-observe.css";

type JevResponse = {
  status: "ready";
  model: string;
  labels: JevLabelEvidence[];
  usage: { inputTokens: number | null; outputTokens: number | null };
  cost: null;
};

const LABEL_NAMES: Record<JevLabelEvidence["id"], string> = {
  exploration: "Exploration",
  implementation: "Implementation",
  debugging: "Testing and build work",
  delegation: "Delegation",
};

export function SessionRetrospective({
  data,
  sessionRef,
  harness,
}: {
  data: ObserveData;
  sessionRef: string;
  harness: string;
}) {
  // Session lookups refresh `data` often; key on the aggregate values so a
  // refresh with unchanged counts keeps the open preview, consent, and result.
  const profileKey = JSON.stringify(buildSessionRetrospectiveProfile(data));
  const profile = useMemo(() => JSON.parse(profileKey) as SessionRetrospectiveProfile, [profileKey]);
  const profileEvidence = retrospectiveLabelEvidence(profile);
  const participants = retrospectiveParticipants(data);
  const timeline = retrospectiveTimelineEvents(data);
  const usage = data.metadata?.usage;
  const usageIsPresent = [usage?.inputTokens, usage?.outputTokens, usage?.totalTokens]
    .some((value) => typeof value === "number" && Number.isFinite(value));
  const requestBody = useMemo(() => buildJevRequestBody(profile), [profile]);
  const [jevAvailable, setJevAvailable] = useState<boolean | null>(null);
  const [jevEndpoint, setJevEndpoint] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<JevResponse | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    let active = true;
    // Local config read only; no data leaves the machine from this call.
    void api<{ available: boolean; endpoint: string | null }>("/api/session-retrospective/jev/status")
      .then((status) => {
        if (!active) return;
        setJevAvailable(status.available);
        setJevEndpoint(status.endpoint);
      })
      .catch(() => { if (active) setJevAvailable(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    generation.current += 1;
    setShowPreview(false);
    setConfirmed(false);
    setLoading(false);
    setError(null);
    setResult(null);
  }, [sessionRef, harness, profileKey]);

  const requestLabels = async () => {
    if (!confirmed || loading) return;
    const requestGeneration = generation.current;
    const stale = () => requestGeneration !== generation.current;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const response = await api<JevResponse>("/api/session-retrospective/jev", {
        method: "POST",
        body: JSON.stringify({ sessionRef, harness, confirmed: true, preview: profile }),
      });
      if (!stale()) setResult(response);
    } catch (requestError) {
      if (!stale()) setError(requestError instanceof Error ? requestError.message : "Could not generate Jev labels.");
    } finally {
      if (!stale()) setLoading(false);
    }
  };

  return (
    <section className="s-session-retrospective" aria-label="Session retrospective">
      <header>
        <h3>Session retrospective</h3>
        <span>Descriptive summary · optional Jev labels</span>
      </header>
      <div className="s-session-retrospective-grid">
        <section>
          <h4>Agents and models</h4>
          {participants.length ? (
            <ul>{participants.map((item) => <li key={`${item.name}:${item.model ?? ""}`}>
              <strong>{item.name}</strong>{item.model ? ` · ${item.model}` : " · model unavailable"}
              <small>Source: {item.source}</small>
            </li>)}</ul>
          ) : <p>Agent and model details are unavailable in this session record.</p>}
        </section>
        <section>
          <h4>Timeline and observed asks</h4>
          {timeline.length ? <ol>{timeline.map((event) => <li key={event.id}>
            <time>{formatRetrospectiveTime(event)}</time><span>{event.text || event.kind}</span>
          </li>)}</ol> : <p>No timestamped lifecycle or handoff events are available.</p>}
          <small>Events use wall time when available; otherwise time is relative to the session. Observed asks do not necessarily indicate handoffs.</small>
        </section>
        <section className="s-session-retrospective-jev">
          <h4>Tentative labels</h4>
          {result ? (
            <>
              {result.labels.length ? <ul>{result.labels.map((label) => <li key={label.id}>
                <strong>{LABEL_NAMES[label.id]}</strong><small>{label.rationale}</small>
                <small>Jev signal: {Math.round(label.probability * 100)}% · exploratory probability, not a quality rating</small>
              </li>)}</ul> : <p>Jev found no label with enough evidence in this session summary.</p>}
              <small>Classified by {result.model}. Jev request usage: {formatUsage(result.usage)}. Cost was not returned by the provider.</small>
              <button type="button" onClick={() => { setResult(null); setShowPreview(true); setConfirmed(false); }}>Review and run again</button>
            </>
          ) : showPreview ? (
            <div className="s-session-retrospective-consent">
              <p>Nothing has been sent. If you confirm, this exact request body is sent once to <code>{jevEndpoint ?? "the configured Jev endpoint"}</code> (TypeSafe AI’s hosted Jev by default), authenticated with your TYPESAFE_API_KEY. The call may incur provider charges. It contains only activity counts: no transcript text, prompts, source code, paths, tool arguments, model or participant names, hostnames, or session IDs.</p>
              <details open>
                <summary>Exact request body</summary>
                <pre>{JSON.stringify(requestBody, null, 2)}</pre>
              </details>
              <label>
                <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.currentTarget.checked)} />
                <span>I reviewed this request body and want to send it to Jev for tentative labels.</span>
              </label>
              <div className="s-session-retrospective-actions">
                <button type="button" disabled={!confirmed || loading || !jevAvailable || !profileEvidence.some((item) => item.hasEvidence)} onClick={() => void requestLabels()}>
                  {loading ? "Asking Jev…" : "Generate labels with Jev"}
                </button>
                <button type="button" disabled={loading} onClick={() => { setShowPreview(false); setConfirmed(false); }}>Cancel</button>
              </div>
              <small>TypeSafe AI’s <a href="https://typesafe.ai/legal/privacy-policy" target="_blank" rel="noreferrer">privacy policy</a> applies to data sent to its service. Only provider-reported token usage is shown; Scout does not estimate the request cost.</small>
            </div>
          ) : (
            <>
              <p>{jevAvailable === false
                ? "Optional Jev labels are off. Nothing from this session is sent anywhere. Set TYPESAFE_API_KEY on the local web server to enable them."
                : jevAvailable === null
                  ? "Checking Jev availability…"
                  : profileEvidence.some((item) => item.hasEvidence)
                    ? "No labels have been generated for this session."
                    : "This session record has no aggregate activity signals for Jev to classify."}</p>
              <button type="button" disabled={jevAvailable !== true || !profileEvidence.some((item) => item.hasEvidence)} onClick={() => { setShowPreview(true); setError(null); }}>
                Review data and suggest labels
              </button>
              {error && <p role="alert" className="s-session-retrospective-error">{error}</p>}
            </>
          )}
          {error && showPreview && <p role="alert" className="s-session-retrospective-error">{error}</p>}
        </section>
        <section>
          <h4>Session usage</h4>
          {usageIsPresent ? <p>
            {usage?.totalTokens != null ? `${usage.totalTokens.toLocaleString()} tokens` : "Token total unavailable"}
            {usage?.inputTokens != null ? ` · ${usage.inputTokens.toLocaleString()} input` : ""}
            {usage?.outputTokens != null ? ` · ${usage.outputTokens.toLocaleString()} output` : ""}
            <small>Source: observed session usage metadata. Cost is unavailable in this session record.</small>
          </p> : <p>Token usage and cost unavailable: this session record has no trustworthy usage totals.</p>}
        </section>
      </div>
    </section>
  );
}

function formatUsage(usage: JevResponse["usage"]): string {
  const parts = [
    usage.inputTokens == null ? null : `${usage.inputTokens.toLocaleString()} input tokens`,
    usage.outputTokens == null ? null : `${usage.outputTokens.toLocaleString()} output tokens`,
  ].filter((part): part is string => part !== null);
  return parts.length ? parts.join(" · ") : "unavailable";
}

export function sessionRetrospectiveIsComplete(data: ObserveData, source: string): boolean {
  return data.live === false && source !== "live";
}
