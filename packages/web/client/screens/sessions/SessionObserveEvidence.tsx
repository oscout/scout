import type { ObserveEvent } from "../../lib/types.ts";
import type {
  ObserveEvidenceFidelity,
  ObserveEvidencePresentation,
  ObserveEvidenceSource,
} from "../../lib/observe-fidelity.ts";

function shortObserveSessionId(value: string | null | undefined): string {
  if (!value) return "no session";
  return value.length > 18 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value;
}

/** Compact embed header backed by the same evidence contract as the observer. */
export function SessionObserveEmbedStatus({
  source,
  fidelity,
  sessionId,
  evidence,
}: {
  source: ObserveEvidenceSource;
  fidelity: ObserveEvidenceFidelity;
  sessionId?: string | null;
  evidence: ObserveEvidencePresentation;
}) {
  return (
    <div className="s-observe-embed-status" data-tone={evidence.tone}>
      <span className="s-observe-embed-status-source">{source}</span>
      <span>{fidelity}</span>
      <span title={sessionId ?? undefined}>{shortObserveSessionId(sessionId)}</span>
      <span>{evidence.eventCountLabel}</span>
      {evidence.tone === "live" && (
        <span className="s-observe-embed-status-live">Live</span>
      )}
    </div>
  );
}

/** Marker-less broker provenance: useful setup context, never trace activity. */
export function SessionObserveReceiptView({
  events,
}: {
  events: ObserveEvent[];
}) {
  return (
    <section className="s-observe-receipt-view" aria-label="Session setup receipts">
      <div className="s-observe-receipt-view-copy">
        <strong>No observed trace activity</strong>
        <span>These broker lifecycle records confirm setup only.</span>
      </div>
      {events.length > 0 && (
        <ul className="s-observe-receipt-list">
          {events.map((event) => (
            <li key={event.id} className="s-observe-receipt">
              <span>{event.text}</span>
              {event.detail && <small>{event.detail}</small>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
