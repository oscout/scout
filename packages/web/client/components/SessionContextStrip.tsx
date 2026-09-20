import { useEffect, useRef, useState } from "react";

import type { Route } from "../lib/types.ts";
import { conversationSessionRoute } from "../screens/chat/conversation-model.ts";
import { harnessLabel } from "./HarnessMark.tsx";

import "./session-context-strip.css";

export function sessionContextStripActions(input: {
  sessionId?: string | null;
  conversationId?: string | null;
  machineId?: string | null;
}): { sessionRoute: Route | null; conversationRoute: Route | null } {
  const conversationId = input.conversationId?.trim() || null;
  const machineId = input.machineId?.trim() || null;
  return {
    sessionRoute: conversationSessionRoute({
      sessionId: input.sessionId,
      machineId,
    }),
    conversationRoute: conversationId
      ? {
          view: "conversation",
          conversationId,
          ...(machineId ? { machineId } : {}),
        }
      : null,
  };
}

export function SessionContextStrip({
  title,
  harness,
  model,
  hostName,
  workspaceRoot,
  sessionId,
  machineId,
  conversationId,
  showSessionAction = true,
  navigate,
}: {
  title?: string | null;
  harness?: string | null;
  model?: string | null;
  hostName?: string | null;
  workspaceRoot?: string | null;
  sessionId?: string | null;
  machineId?: string | null;
  conversationId?: string | null;
  showSessionAction?: boolean;
  navigate: (route: Route) => void;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "unavailable">("idle");
  const copyTimerRef = useRef<number | null>(null);
  const workspace = workspaceRoot?.trim() || null;
  const trimmedSessionId = sessionId?.trim() || null;
  const trimmedConversationId = conversationId?.trim() || null;
  const trimmedMachineId = machineId?.trim() || null;
  const { sessionRoute, conversationRoute } = sessionContextStripActions({
    sessionId: trimmedSessionId,
    conversationId: trimmedConversationId,
    machineId: trimmedMachineId,
  });

  useEffect(() => {
    setCopyState("idle");
  }, [workspace]);

  useEffect(() => () => {
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
    }
  }, []);

  const copyWorkspace = () => {
    if (!workspace) return;
    const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (!clipboard?.writeText) {
      setCopyState("unavailable");
      return;
    }
    void clipboard.writeText(workspace)
      .then(() => {
        setCopyState("copied");
        if (copyTimerRef.current !== null) {
          window.clearTimeout(copyTimerRef.current);
        }
        copyTimerRef.current = window.setTimeout(() => {
          copyTimerRef.current = null;
          setCopyState("idle");
        }, 1_500);
      })
      .catch(() => {
        setCopyState("unavailable");
      });
  };

  const facts = [
    harness?.trim() ? harnessLabel(harness) : null,
    model?.trim() || null,
    hostName?.trim() || "Host not reported",
  ].filter((fact): fact is string => Boolean(fact));
  return (
    <div className="s-session-context-strip">
      <div className="s-session-context-strip-main">
        {title?.trim() ? (
          <span className="s-session-context-strip-title">{title.trim()}</span>
        ) : null}
        <span className="s-session-context-strip-facts">{facts.join(" · ")}</span>
        {trimmedSessionId && !showSessionAction ? (
          <code
            className="s-session-context-strip-identity"
            title={trimmedSessionId}
          >
            {trimmedSessionId}
          </code>
        ) : null}
        {workspace ? (
          <span className="s-session-context-strip-workspace" aria-live="polite">
            <code className="s-session-context-strip-path" title={workspace}>
              {workspace}
            </code>
            <button
              type="button"
              className="btn btn--ghost s-session-context-strip-copy"
              onClick={copyWorkspace}
            >
              {copyState === "copied"
                ? "Copied"
                : copyState === "unavailable"
                  ? "Copy unavailable"
                  : "Copy path"}
            </button>
          </span>
        ) : (
          <span className="s-session-context-strip-workspace s-session-context-strip-workspace--missing">
            Workspace not reported
          </span>
        )}
      </div>
      <div className="s-session-context-strip-actions">
        {sessionRoute && showSessionAction ? (
          <button
            type="button"
            className="btn btn--ghost s-session-context-strip-session"
            aria-label={`Open session ${trimmedSessionId}`}
            title={trimmedSessionId ?? undefined}
            onClick={() => navigate(sessionRoute)}
          >
            Open session
          </button>
        ) : null}
        {conversationRoute ? (
          <button
            type="button"
            className="btn btn--ghost s-session-context-strip-back"
            aria-label={`Return to conversation ${trimmedConversationId}`}
            onClick={() => navigate(conversationRoute)}
          >
            Back to conversation
          </button>
        ) : null}
      </div>
    </div>
  );
}
