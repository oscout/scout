import { ExternalLink } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { api } from "../lib/api.ts";
import { describeObserveEvidence } from "../lib/observe-fidelity.ts";
import { useBrokerEvents } from "../lib/sse.ts";
import { formatAbsoluteTimestamp } from "../lib/time.ts";
import type { AgentObservePayload } from "../lib/types.ts";
import { SessionObserve } from "./sessions/SessionObserve.tsx";
import { SessionObserveEmbedStatus } from "./sessions/SessionObserveEvidence.tsx";

type ObserveEmbedScreenProps = {
  agentId: string;
};

const EMBED_REFRESH_INTERVAL_MS = 2_500;
const COLLAPSED_ASK_CHARACTER_LIMIT = 240;
const COLLAPSED_ASK_LINE_LIMIT = 5;

export function InitiatingAsk({
  ask,
  sessionId,
}: {
  ask: AgentObservePayload["initiatingAsk"];
  sessionId: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!ask) {
    return (
      <section className="s-observe-embed-ask s-observe-embed-ask--unknown">
        <div className="s-observe-embed-ask-kicker">Ask</div>
        <div className="s-observe-embed-ask-unknown">Not available for this observed session.</div>
      </section>
    );
  }

  const long = ask.task.length > COLLAPSED_ASK_CHARACTER_LIMIT
    || ask.task.split("\n").length > COLLAPSED_ASK_LINE_LIMIT;
  const conversationHref = ask.conversationId
    ? `/messages/${encodeURIComponent(ask.conversationId)}${
        ask.messageId ? `#msg-${encodeURIComponent(ask.messageId)}` : ""
      }`
    : null;
  const flightHref = `/flights/${encodeURIComponent(ask.flightId)}/observe${
    sessionId ? `?session=${encodeURIComponent(sessionId)}` : ""
  }`;

  return (
    <section className="s-observe-embed-ask">
      <div className="s-observe-embed-ask-head">
        <div>
          <div className="s-observe-embed-ask-kicker">Ask</div>
          <div className="s-observe-embed-ask-byline">
            <span>{ask.requesterName}</span>
            <span aria-hidden="true">·</span>
            <time dateTime={new Date(ask.requestedAt).toISOString()}>
              {formatAbsoluteTimestamp(ask.requestedAt)}
            </time>
          </div>
        </div>
        <nav className="s-observe-embed-ask-links" aria-label="Run provenance">
          {conversationHref && (
            <a href={conversationHref} target="_top">
              Origin <ExternalLink size={11} aria-hidden="true" />
            </a>
          )}
          <a href={flightHref} target="_top">
            Flight <ExternalLink size={11} aria-hidden="true" />
          </a>
        </nav>
      </div>
      <div className={`s-observe-embed-ask-body${expanded ? " is-expanded" : ""}`}>
        {ask.task}
      </div>
      {long && (
        <button
          type="button"
          className="s-observe-embed-ask-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : "Show full ask"}
        </button>
      )}
    </section>
  );
}

export function ObserveEmbedScreen({ agentId }: ObserveEmbedScreenProps) {
  const [observe, setObserve] = useState<AgentObservePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (background = false) => {
    if (!background) setLoading(true);
    setError(null);
    try {
      const result = await api<AgentObservePayload>(
        `/api/agents/${encodeURIComponent(agentId)}/observe`,
      );
      setObserve(result);
    } catch (err) {
      if (!background) setObserve(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => {
      void load(true);
    }, EMBED_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [load]);

  useBrokerEvents(() => {
    void load(true);
  });

  if (error && !observe) {
    return (
      <div className="s-observe-embed-page">
        <div className="s-observe-embed-empty">
          <div className="s-observe-embed-empty-title">Observe unavailable</div>
          <div className="s-observe-embed-empty-detail">{error}</div>
        </div>
      </div>
    );
  }

  if (loading && !observe) {
    return (
      <div className="s-observe-embed-page">
        <div className="s-observe-embed-empty">
          <div className="s-observe-embed-empty-title">Resolving trace</div>
          <div className="s-observe-embed-empty-detail">{agentId}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="s-observe-embed-page">
      {observe && (
        <>
          <SessionObserveEmbedStatus
            source={observe.source}
            fidelity={observe.fidelity}
            sessionId={observe.sessionId}
            evidence={describeObserveEvidence({
              source: observe.source,
              fidelity: observe.fidelity,
              live: observe.data.live,
              eventCount: observe.data.events.length,
            })}
          />
          <InitiatingAsk ask={observe.initiatingAsk} sessionId={observe.sessionId} />
        </>
      )}
      <SessionObserve
        data={observe?.data}
        agentId={agentId}
        sessionId={observe?.sessionId}
        showRail={false}
        observeSource={observe?.source}
        observeFidelity={observe?.fidelity}
      />
    </div>
  );
}
