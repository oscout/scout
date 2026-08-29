import { useEffect, useCallback } from "react";
import { AlertTriangle, Check, CornerDownLeft, ShieldAlert, Sparkles, X } from "lucide-react";
import { compactAgentId } from "../../lib/agent-labels.ts";
import type { Agent, FleetAsk } from "../../lib/types.ts";
import {
  presenceColor,
  type ConversationPresence,
} from "./conversation-model.ts";

// One breath of the dispatch for the "Re:" context line — never the wall.
function firstLineExcerpt(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find(Boolean) ?? "";
  const max = 110;
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}\u2026` : line;
}

export function PinnedAskCard({
  pinnedAsk,
  onAnswer,
  onApprove,
  onReject,
  onSteer,
  enableKeyboard = true,
}: {
  pinnedAsk: FleetAsk;
  onAnswer: () => void;
  onApprove?: () => void;
  onReject?: () => void;
  onSteer?: () => void;
  enableKeyboard?: boolean;
}) {
  // The headline is the agent's own word — their question, blocker, or
  // failure note (`summary`). `task` is the operator's outbound dispatch:
  // context, never the headline. Echoing the full dispatch back under
  // "@agent -> You" reads as the agent asking you your own prompt.
  const askBody = pinnedAsk.summary?.trim() || null;
  const taskLine = firstLineExcerpt(pinnedAsk.task);
  const headline = askBody && askBody !== pinnedAsk.task.trim() ? askBody : taskLine;
  const showTaskContext = headline !== taskLine && taskLine.length > 0;
  const isApproval = /\b(?:approve|approval|permission|allow|proceed|confirm|gate)\b/i.test(
    headline,
  );
  const kindLabel = isApproval
    ? "Approval Gate"
    : headline.includes("?")
      ? "Question"
      : pinnedAsk.statusLabel;
  const agentDisplayName =
    pinnedAsk.agentName ?? compactAgentId(pinnedAsk.agentId) ?? pinnedAsk.agentId;

  const handleApproveOrAnswer = useCallback(() => {
    if (onApprove) {
      onApprove();
    } else {
      onAnswer();
    }
  }, [onApprove, onAnswer]);

  const handleSteer = useCallback(() => {
    if (onSteer) {
      onSteer();
    } else {
      onAnswer();
    }
  }, [onSteer, onAnswer]);

  useEffect(() => {
    if (!enableKeyboard) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      // Don't intercept when user is typing in form fields or has modifier keys
      const activeEl = document.activeElement;
      const isInput =
        activeEl instanceof HTMLInputElement ||
        activeEl instanceof HTMLTextAreaElement ||
        (activeEl instanceof HTMLElement && activeEl.isContentEditable);

      if (isInput) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key === "y" || event.key === "Y") {
        event.preventDefault();
        handleApproveOrAnswer();
      } else if (event.key === "s" || event.key === "S") {
        event.preventDefault();
        handleSteer();
      } else if ((event.key === "n" || event.key === "N") && onReject) {
        event.preventDefault();
        onReject();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [enableKeyboard, handleApproveOrAnswer, handleSteer, onReject]);

  return (
    <div
      className={`s-thread-pinned-ask surface-card ${
        isApproval ? "s-thread-pinned-ask--approval" : "s-thread-pinned-ask--question"
      }`}
      role="alert"
      aria-live="assertive"
    >
      <div className="s-thread-pinned-ask-header">
        <div className="s-thread-pinned-ask-beacon" aria-hidden="true">
          <span className="dot dot--sm dot--warning dot--pulse dot--glow" />
        </div>
        <div className="s-thread-pinned-ask-kicker">
          <span className="label-sm s-thread-pinned-ask-eyebrow">Operator Attention Required</span>
          <span className="chip chip--sm chip--mono chip--warning">
            {kindLabel}
          </span>
        </div>
        <div className="s-thread-pinned-ask-routing">
          <span className="s-thread-pinned-ask-agent-name chip chip--sm chip--mono chip--neutral">
            @{agentDisplayName}
          </span>
          <span className="s-thread-pinned-ask-routing-arrow" aria-hidden="true">
            →
          </span>
          <span className="chip chip--sm chip--mono chip--working">You</span>
        </div>
      </div>

      <div className="s-thread-pinned-ask-body">
        <p className="s-thread-pinned-ask-text">{headline}</p>
        {showTaskContext && (
          <p className="s-thread-pinned-ask-context text-muted">Re: {taskLine}</p>
        )}
      </div>

      <div className="s-thread-pinned-ask-actions">
        <button
          type="button"
          className="btn btn--primary s-thread-pinned-ask-btn"
          onClick={handleApproveOrAnswer}
          title={isApproval ? "Approve this gate [Y]" : "Answer this question [Y]"}
        >
          <kbd className="s-kbd">[Y]</kbd>
          {isApproval ? <Check size={13} strokeWidth={2.2} /> : <CornerDownLeft size={13} />}
          <span>{isApproval ? "Approve" : "Answer"}</span>
        </button>

        <button
          type="button"
          className="btn btn--accent s-thread-pinned-ask-btn"
          onClick={handleSteer}
          title="Provide guidance or steer [S]"
        >
          <kbd className="s-kbd">[S]</kbd>
          <Sparkles size={13} strokeWidth={1.9} />
          <span>Steer</span>
        </button>

        {onReject && (
          <button
            type="button"
            className="btn btn--danger s-thread-pinned-ask-btn"
            onClick={onReject}
            title="Reject or decline [N]"
          >
            <kbd className="s-kbd">[N]</kbd>
            <X size={13} strokeWidth={2.2} />
            <span>Reject</span>
          </button>
        )}
      </div>

      <div className="s-thread-pinned-ask-strip" aria-hidden="true" />
    </div>
  );
}

export function ApprovalGateCard({
  title,
  description,
  diff,
  command,
  risk = "medium",
  onApprove,
  onReject,
  onSteer,
}: {
  title: string;
  description?: string | null;
  diff?: string | null;
  command?: string | null;
  risk?: "low" | "medium" | "high" | null;
  onApprove: () => void;
  onReject: () => void;
  onSteer?: () => void;
}) {
  return (
    <div className="s-thread-approval-gate surface-card" role="alert">
      <div className="s-thread-approval-gate-head">
        <div className="s-thread-approval-gate-title-wrap">
          <ShieldAlert size={16} className="text-amber" aria-hidden="true" />
          <span className="label-sm text-amber">Execution Approval Gate</span>
          {risk && (
            <span
              className={`chip chip--sm chip--mono ${
                risk === "high"
                  ? "chip--danger"
                  : risk === "medium"
                    ? "chip--warning"
                    : "chip--info"
              }`}
            >
              {risk.toUpperCase()} RISK
            </span>
          )}
        </div>
        <h3 className="s-thread-approval-gate-title">{title}</h3>
        {description && <p className="s-thread-approval-gate-desc">{description}</p>}
      </div>

      {command && (
        <div className="s-thread-approval-gate-command surface-card surface-card--inset">
          <span className="label-xs text-muted">Command</span>
          <code className="s-thread-approval-gate-code">{command}</code>
        </div>
      )}

      {diff && (
        <div className="s-thread-approval-gate-diff surface-card surface-card--inset">
          <span className="label-xs text-muted">Diff Preview</span>
          <pre className="s-thread-approval-gate-diff-pre">
            <code>{diff}</code>
          </pre>
        </div>
      )}

      <div className="s-thread-approval-gate-actions">
        <button
          type="button"
          className="btn btn--primary"
          onClick={onApprove}
        >
          <kbd className="s-kbd">[Y]</kbd>
          <Check size={13} />
          <span>Approve Action</span>
        </button>

        <button
          type="button"
          className="btn btn--danger"
          onClick={onReject}
        >
          <kbd className="s-kbd">[N]</kbd>
          <X size={13} />
          <span>Reject</span>
        </button>

        {onSteer && (
          <button
            type="button"
            className="btn btn--ghost"
            onClick={onSteer}
          >
            <kbd className="s-kbd">[S]</kbd>
            <span>Steer…</span>
          </button>
        )}
      </div>
    </div>
  );
}

export function ConversationStatusStrip({
  presence,
  agent,
}: {
  presence: ConversationPresence;
  agent: Agent | null;
}) {
  if (!presence.showStrip) return null;
  const isWorking = presence.tone === "working";
  const isPending = presence.tone === "pending";

  return (
    <div
      className={`s-thread-status s-thread-status--${presence.tone}`}
      aria-live="polite"
    >
      <span className="s-thread-status-dot-wrap" aria-hidden="true">
        <span
          className={`dot dot--sm ${
            isWorking
              ? "dot--working dot--pulse dot--glow"
              : isPending
                ? "dot--warning dot--pulse dot--glow"
                : "dot--neutral"
          }`}
          style={{
            color: presenceColor(presence, agent?.state ?? null),
          }}
        />
      </span>
      <div className="s-thread-status-copy">
        <span className="s-thread-status-label label-xs">{presence.label}</span>
        <span className="s-thread-status-detail">{presence.detail}</span>
      </div>
    </div>
  );
}
