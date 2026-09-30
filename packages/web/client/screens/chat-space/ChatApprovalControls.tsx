import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ChatApprovalDecision, ChatSessionApprovals } from "./chat-api.ts";

type ApprovalAccess = {
  scope: string;
  load: (flightId: string) => Promise<ChatSessionApprovals>;
  decide: (flightId: string, decision: ChatApprovalDecision) => Promise<unknown>;
};
export const ChatApprovalAccess = createContext<ApprovalAccess | null>(null);

type Approval = ChatSessionApprovals["approvals"][number];
type LastDecision = { key: string; decision: "approve" | "deny"; confirmed: boolean };

const approvalKey = (approval: Approval) => JSON.stringify([approval.sessionId, approval.turnId, approval.blockId, approval.version]);
/** Pending approvals can appear mid-run, so an active card keeps looking. */
const IDLE_POLL_MS = 15_000;
/** After a decision, look quickly for the session to clear the prompt. */
const CONFIRM_POLL_MS = 2_000;
const CONFIRM_POLL_LIMIT = 30;

export type ChatApprovals = ReturnType<typeof useChatApprovals>;

/**
 * Pending approvals for one tracked request, read without a click. Only
 * operators get the access context, so everyone else sees none and the
 * card falls back to who acts next.
 */
export function useChatApprovals(flightId: string, active: boolean) {
  const access = useContext(ChatApprovalAccess);
  const scopeKey = access ? `${access.scope}:${flightId}` : null;
  const [data, setData] = useState<ChatSessionApprovals | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // An uncertain acknowledgement is not permission to resend a decision.
  const [submitted, setSubmitted] = useState<Set<string>>(() => new Set());
  const [last, setLast] = useState<LastDecision | null>(null);
  const loading = useRef(false);
  const deciding = useRef(false);
  const confirmPolls = useRef(0);

  useEffect(() => { setData(null); setError(null); setSubmitted(new Set()); setLast(null); }, [scopeKey]);

  const load = useCallback(async () => {
    if (!access || loading.current) return;
    loading.current = true;
    try {
      const next = await access.load(flightId);
      setData(next);
      setError(null);
      setLast(previous => previous && !previous.confirmed && !next.approvals.some(approval => approvalKey(approval) === previous.key)
        ? { ...previous, confirmed: true } : previous);
    } catch {
      setError("Could not read approvals for this request.");
    } finally { loading.current = false; }
  }, [access, flightId]);

  const confirming = last !== null && !last.confirmed;
  useEffect(() => {
    if (!access || !active) return;
    void load();
    confirmPolls.current = 0;
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (confirming && ++confirmPolls.current > CONFIRM_POLL_LIMIT) return;
      void load();
    }, confirming ? CONFIRM_POLL_MS : IDLE_POLL_MS);
    return () => clearInterval(timer);
  }, [access, active, load, confirming]);

  const decide = async (approval: Approval, decision: "approve" | "deny") => {
    const key = approvalKey(approval);
    if (!access || deciding.current || submitted.has(key)) return;
    deciding.current = true; setBusy(true); setError(null);
    setSubmitted(previous => new Set([...previous, key]));
    setLast({ key, decision, confirmed: false });
    try {
      await access.decide(flightId, { sessionId: approval.sessionId, turnId: approval.turnId, blockId: approval.blockId, version: approval.version, decision });
      void load();
    } catch {
      setLast(null);
      setError("Your decision could not be confirmed. It will not be sent again from here; check the session before acting.");
    } finally { deciding.current = false; setBusy(false); }
  };

  const pending = (data?.approvals ?? []).filter(approval => !submitted.has(approvalKey(approval)));
  return { available: access !== null, pending, awaiting: data?.approvals ?? [], submitted, busy, error, last, decide };
}

/** Context above the buttons: what you are approving, then Approve / Deny. */
export function ChatApprovalPrompts({ approvals }: { approvals: ChatApprovals }) {
  const { awaiting, submitted, busy, error, last, decide } = approvals;
  if (!approvals.available) return null;
  const decisionWord = last?.decision === "deny" ? "Denied" : "Approved";
  return <>
    {awaiting.map(approval => {
      const key = approvalKey(approval);
      const sent = submitted.has(key);
      return <div key={key} className="chat-ask-slot">
        <p className="chat-ask-slot-label">{approval.title} · {approval.risk} risk</p>
        {approval.description ? <p className="chat-ask-quote">{approval.description}</p> : null}
        {approval.detail ? <pre className="chat-ask-code">{approval.detail}</pre> : null}
        {sent ? null : <div className="chat-ask-actions">
          <button type="button" className="btn btn--accent btn--sm" disabled={busy} onClick={() => void decide(approval, "approve")}>Approve</button>
          <button type="button" className="btn btn--sm" disabled={busy} onClick={() => void decide(approval, "deny")}>Deny</button>
        </div>}
      </div>;
    })}
    {last && !(last.confirmed && approvals.pending.length) ? <p className="chat-ask-trail" role="status">{last.confirmed
      ? `${decisionWord}. The session cleared the prompt.`
      : `${decisionWord} · waiting for the session…`}</p> : null}
    {error ? <p className="chat-ask-trail" role="alert">{error}</p> : null}
  </>;
}
