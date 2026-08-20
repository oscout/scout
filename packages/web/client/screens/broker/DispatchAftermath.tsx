import { ArrowUpRight, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import { isScoutNativeUiActionHost } from "../../lib/scoutbot.ts";
import { useBrokerEvents } from "../../lib/sse.ts";
import { timeAgo } from "../../lib/time.ts";
import type {
  BrokerRouteAttempt,
  Flight,
  FollowTarget,
  Message,
  Route,
} from "../../lib/types.ts";
import { openContent } from "../../scout/slots/openContent.ts";
import { clippedText } from "./broker-display.ts";
import {
  AFTERMATH_MESSAGE_PAGE,
  dispatchFlightOutcome,
  dispatchFollowQuery,
  dispatchOutcomeLinks,
  formatDispatchDuration,
  formatDispatchGap,
  resolveDispatchAftermath,
  type DispatchAftermath as Aftermath,
} from "./dispatch-aftermath.ts";

const REPLY_SNIPPET_CHARS = 180;
const RELOAD_COALESCE_MS = 250;

type AftermathState = {
  loading: boolean;
  target: FollowTarget | null;
  /** The follow read failed — "no destination" would be an unearned claim. */
  targetUnknown: boolean;
  flight: Flight | null;
  aftermath: Aftermath;
};

const INITIAL: AftermathState = {
  loading: true,
  target: null,
  targetUnknown: false,
  flight: null,
  aftermath: { status: "no-conversation" },
};

/**
 * Resolve where a dispatch went and what came back. The three reads are
 * independent on purpose: a routed message with no flight still has replies,
 * and a flight with no transcript page still has an outcome. Losing one must
 * not blank the others.
 */
function useDispatchAftermath(
  attempt: BrokerRouteAttempt,
  targetAgentId: string | null,
): AftermathState & { reload: () => void } {
  const [state, setState] = useState<AftermathState>(INITIAL);
  const [nonce, setNonce] = useState(0);
  const requestRef = useRef(0);

  const conversationId = attempt.conversationId;
  const followQuery = useMemo(
    () => dispatchFollowQuery(attempt, targetAgentId)?.toString() ?? null,
    [attempt, targetAgentId],
  );

  useEffect(() => {
    const requestId = ++requestRef.current;
    setState((current) => ({ ...current, loading: true }));

    const followRequest = followQuery
      ? api<FollowTarget>(`/api/follow?${followQuery}`).catch(() => null)
      : Promise.resolve(null);
    const messagesRequest = conversationId
      ? api<Message[]>(
        `/api/messages?conversationId=${encodeURIComponent(conversationId)}&limit=${AFTERMATH_MESSAGE_PAGE}`,
      ).catch(() => null)
      : Promise.resolve(null);

    void (async () => {
      const [target, messages] = await Promise.all([followRequest, messagesRequest]);
      if (requestId !== requestRef.current) return;

      const flight = target?.flightId
        ? await api<Flight[]>(
          `/api/flights?active=false&flightId=${encodeURIComponent(target.flightId)}`,
        ).then((flights) => flights[0] ?? null).catch(() => null)
        : null;
      if (requestId !== requestRef.current) return;

      setState({
        loading: false,
        target,
        targetUnknown: Boolean(followQuery) && !target,
        flight,
        // "Could not read the thread" and "read it, nothing there" are
        // different answers. Collapsing them would report silence that was
        // never observed.
        aftermath: !conversationId
          ? { status: "no-conversation" }
          : messages
            ? resolveDispatchAftermath(attempt, messages)
            : { status: "unavailable" },
      });
    })();

    return () => {
      requestRef.current += 1;
    };
  }, [attempt, conversationId, followQuery, nonce]);

  // A live thread emits several events per agent turn, and each reload is two
  // or three requests carrying an 80-message page. Coalesce them the way the
  // ledger coalesces its own refresh, so a busy conversation cannot turn into
  // a request burst and a flapping spinner.
  const reloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reload = useCallback(() => {
    if (reloadTimerRef.current) return;
    reloadTimerRef.current = setTimeout(() => {
      reloadTimerRef.current = null;
      setNonce((value) => value + 1);
    }, RELOAD_COALESCE_MS);
  }, []);
  useEffect(() => () => {
    if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current);
  }, []);

  // The panel's whole subject is what arrives after the dispatch, so it
  // reloads on the events that produce that — rather than making the operator
  // reselect the row to find out. Matching is narrow on purpose: an unrelated
  // conversation or flight must not churn this fetch.
  const flightId = state.flight?.id ?? state.target?.flightId ?? null;
  useBrokerEvents((event) => {
    switch (event.kind) {
      case "message.posted":
        if (conversationId && event.payload.message.conversationId === conversationId) reload();
        return;
      case "delivery.state.changed":
        if (attempt.messageId && event.payload.delivery.messageId === attempt.messageId) reload();
        return;
      case "flight.updated":
        if (flightId && event.payload.flight.id === flightId) reload();
        return;
      default:
    }
  });

  return { ...state, reload };
}

export function DispatchAftermath({
  attempt,
  targetAgentId,
  navigate,
  returnTo,
}: {
  attempt: BrokerRouteAttempt;
  targetAgentId: string | null;
  navigate: (route: Route) => void;
  returnTo: Route;
}) {
  const { loading, target, targetUnknown, flight, aftermath } =
    useDispatchAftermath(attempt, targetAgentId);
  const outcome = dispatchFlightOutcome(flight);
  const links = target
    ? dispatchOutcomeLinks(target, { nativeHost: isScoutNativeUiActionHost() })
    : [];

  const open = useCallback(
    (route: Route) => openContent(navigate, route, { returnTo }),
    [navigate, returnTo],
  );

  return (
    <section className="sys-broker-aftermath" aria-labelledby="dispatch-aftermath-title">
      <div className="sys-broker-aftermath-head">
        <span id="dispatch-aftermath-title" className="sys-detail-label">What happened next</span>
        {loading && (
          <LoaderCircle className="sys-broker-action-spinner" size={12} aria-hidden="true" />
        )}
      </div>

      {outcome && (
        <div className={`sys-broker-aftermath-outcome sys-broker-aftermath-outcome--${outcome.tone}`}>
          <span className={`sys-broker-dot sys-broker-dot--${outcome.tone}`} aria-hidden="true" />
          <strong>{outcome.label}</strong>
          {outcome.durationMs !== null && (
            <span className="sys-broker-aftermath-duration">
              ran {formatDispatchDuration(outcome.durationMs)}
            </span>
          )}
          {outcome.summary && <p>{clippedText(outcome.summary, REPLY_SNIPPET_CHARS)}</p>}
        </div>
      )}

      {aftermath.status === "replies" ? (
        <ol className="sys-broker-aftermath-replies">
          {aftermath.replies.map((reply) => (
            <li key={reply.id}>
              <button
                type="button"
                className="sys-broker-aftermath-reply"
                disabled={!attempt.conversationId}
                onClick={() => attempt.conversationId && open({
                  view: "conversation",
                  conversationId: attempt.conversationId,
                })}
              >
                <span className="sys-broker-aftermath-reply-head">
                  <strong>{reply.actorName}</strong>
                  {reply.answersDispatch && (
                    <span className="sys-broker-aftermath-answer">reply</span>
                  )}
                  <span className="sys-broker-aftermath-gap">{formatDispatchGap(reply.afterMs)}</span>
                </span>
                <span className="sys-broker-aftermath-reply-body">
                  {clippedText(reply.body, REPLY_SNIPPET_CHARS)}
                </span>
              </button>
            </li>
          ))}
          {aftermath.more > 0 && (
            <li className="sys-broker-aftermath-more">
              +{aftermath.more} more in the thread
            </li>
          )}
        </ol>
      ) : (
        !loading && (
          <p className="sys-broker-aftermath-empty">
            {aftermath.status === "no-conversation"
              ? "No conversation followed this dispatch, so there is nothing to open."
              : aftermath.status === "unavailable"
                ? "The conversation could not be read, so what followed is unknown."
                : aftermath.status === "beyond-page"
                  ? "This dispatch is older than the loaded transcript. Open the conversation to read it in place."
                  : outcome && !outcome.settled
                    ? "Still running. Nothing has come back yet."
                    : "Nothing followed this dispatch in its conversation."}
          </p>
        )
      )}

      {links.length > 0 ? (
        <div className="sys-broker-aftermath-links">
          {links.map((link) => (
            <button
              key={link.key}
              type="button"
              className="sys-broker-aftermath-link"
              title={link.hint}
              onClick={() => open(link.route)}
            >
              {link.label}
              <ArrowUpRight size={11} aria-hidden="true" />
            </button>
          ))}
        </div>
      ) : (
        // With no conversation the first paragraph already said there is
        // nothing to open; a second negative line would just repeat it.
        !loading && aftermath.status !== "no-conversation" && (
          <p className="sys-broker-aftermath-empty">
            {targetUnknown
              ? "Where this went could not be looked up, so there is nothing to link to yet."
              : "No session, work item, or recipient could be resolved from this row."}
          </p>
        )
      )}

      {flight?.completedAt && (
        <div className="sys-broker-aftermath-foot">
          Settled {timeAgo(flight.completedAt)}
        </div>
      )}
    </section>
  );
}
