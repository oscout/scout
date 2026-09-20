import type { ObserveData, ObserveEvent, Route, SessionEntry } from "../../lib/types.ts";
import type {
  ObserveEvidenceFidelity,
  ObserveEvidencePresentation,
  ObserveEvidenceSource,
} from "../../lib/observe-fidelity.ts";
import { SessionContextStrip } from "../../components/SessionContextStrip.tsx";

function shortObserveSessionId(value: string | null | undefined): string {
  if (!value) return "no session";
  return value.length > 18 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value;
}

export const NATIVE_SESSION_ORIGIN_LABEL = "Native session";
export const SCOUT_MANAGED_CHAT_ORIGIN_LABEL = "Scout-managed chat";

export function sessionRefObserveOriginLabel(observe: {
  kind: string;
  source: string;
}): string {
  return observe.kind === "broker" || observe.source === "broker"
    ? SCOUT_MANAGED_CHAT_ORIGIN_LABEL
    : NATIVE_SESSION_ORIGIN_LABEL;
}

export function SessionRefObserveHeader({
  session,
  observe,
  machineId,
  navigate,
}: {
  session: SessionEntry | null;
  observe: {
    refId: string;
    sessionId: string | null;
    data?: ObserveData;
  };
  machineId?: string | null;
  navigate: (route: Route) => void;
}) {
  const sessionMeta = observe.data?.metadata?.session;
  const observeSessionIds = new Set(
    [observe.refId, observe.sessionId]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value)),
  );
  const sessionMatchesObserve = Boolean(
    session && (
      (session.sessionId?.trim() && observeSessionIds.has(session.sessionId.trim()))
      || (session.harnessSessionId?.trim()
        && observeSessionIds.has(session.harnessSessionId.trim()))
    ),
  );
  const factsSession = sessionMatchesObserve ? session : null;
  const workspaceRoot = sessionMeta?.cwd?.trim()
    || factsSession?.workspaceRoot?.trim()
    || null;
  const projectName = workspaceRoot
    ? workspaceRoot.split(/[\\/]/).filter(Boolean).at(-1) ?? workspaceRoot
    : null;
  const hostName = sessionMeta?.hostName?.trim()
    || factsSession?.executionNodeName?.trim()
    || null;
  const sessionIdentity = observe.sessionId?.trim() || observe.refId;
  return (
    <SessionContextStrip
      title={factsSession?.title?.trim() || projectName || sessionIdentity}
      harness={sessionMeta?.adapterType?.trim() || factsSession?.harness || null}
      model={sessionMeta?.model?.trim() || factsSession?.model?.trim() || null}
      hostName={hostName}
      workspaceRoot={workspaceRoot}
      sessionId={sessionIdentity}
      machineId={machineId}
      conversationId={session?.id?.trim() || null}
      showSessionAction={false}
      navigate={navigate}
    />
  );
}

/** Compact embed header backed by the same evidence contract as the observer. */
export function SessionObserveEmbedStatus({
  source,
  fidelity,
  sessionId,
  evidence,
  originLabel = NATIVE_SESSION_ORIGIN_LABEL,
}: {
  source: ObserveEvidenceSource;
  fidelity: ObserveEvidenceFidelity;
  sessionId?: string | null;
  evidence: ObserveEvidencePresentation;
  originLabel?: string | null;
}) {
  return (
    <div className="s-observe-embed-status" data-tone={evidence.tone}>
      {originLabel ? (
        <span className="s-observe-embed-status-origin">{originLabel}</span>
      ) : (
        <span className="s-observe-embed-status-source">{source}</span>
      )}
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
