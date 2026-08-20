import { Eye, UserPlus } from "lucide-react";
import { copyTextToClipboard } from "../../lib/clipboard.ts";
import { routeMachineId } from "../../lib/router.ts";
import type { Agent, Route } from "../../lib/types.ts";
import { AgentAvatar } from "../../components/AgentAvatar.tsx";
import { useContextMenu, type MenuItem } from "../../components/ContextMenu.tsx";
import { BackToPicker } from "../../scout/slots/BackToPicker.tsx";
import { openContent } from "../../scout/slots/openContent.ts";
import {
  conversationIdentityLabel,
  shortConversationIdentity,
} from "./conversation-model.ts";

export type ConversationHeaderParticipant = {
  id: string;
  name: string;
  title: string;
  agent: Agent | null;
  sessionId?: string | null;
  /** Harness/runtime for the agent. Never substituted for an unknown model. */
  harness?: string | null;
  /** Model identifier shown beneath the agent name when known. */
  model?: string | null;
  /** Harness-observed reasoning effort when known. */
  reasoningEffort?: string | null;
};

/** The operator's standing in the conversation, rendered distinctly from agents. */
export type ConversationHeaderOperator = {
  name: string;
  /** True when the operator is an actual member of the thread (e.g. a DM). */
  active: boolean;
};

export function ConversationHeader({
  showBackNav,
  isDm,
  navigate,
  route,
  canonicalConversationId,
  threadTitle,
  agentId,
  sessionId,
  detailRoute,
  visibleParticipants,
  hiddenParticipantCount,
  operator,
  canAddParticipants,
  onToggleAddParticipant,
}: {
  showBackNav: boolean;
  isDm: boolean;
  navigate: (r: Route) => void;
  route: Route;
  canonicalConversationId: string;
  threadTitle: string;
  agentId: string | null;
  sessionId: string | null;
  detailRoute: Route | null;
  visibleParticipants: ConversationHeaderParticipant[];
  hiddenParticipantCount: number;
  operator: ConversationHeaderOperator;
  canAddParticipants: boolean;
  onToggleAddParticipant: () => void;
}) {
  const showContextMenu = useContextMenu();
  const machineId = routeMachineId(route);
  return (
    <div
      className="s-thread-center-header"
      onClick={(event) => {
        const target = event.target as HTMLElement | null;
        if (target?.closest("button,a,input,select,textarea")) return;
        if (!isDm || !detailRoute) return;
        openContent(
          navigate,
          detailRoute,
          { returnTo: route },
        );
      }}
      style={isDm && detailRoute ? { cursor: "pointer" } : undefined}
      onContextMenu={(e) => {
        const items: MenuItem[] = [
          {
            kind: "action",
            label: "Copy Title",
            onSelect: () => {
              void copyTextToClipboard(threadTitle);
            },
          },
        ];
        if (agentId) {
          items.push({
            kind: "action",
            label: "Copy Agent ID",
            onSelect: () => {
              void copyTextToClipboard(agentId);
            },
          });
        }
        if (!agentId && sessionId) {
          items.push({
            kind: "action",
            label: "Copy Session ID",
            onSelect: () => {
              void copyTextToClipboard(sessionId);
            },
          });
        }
        items.push({
          kind: "action",
          label: "Copy Conversation ID",
          onSelect: () => {
            void copyTextToClipboard(canonicalConversationId);
          },
        });
        showContextMenu(e, items);
      }}
    >
      {showBackNav && (
        <BackToPicker
          slot="conversation"
          fallback={{ view: "inbox" }}
          navigate={navigate}
          label="Back"
          className="s-thread-header-back"
        />
      )}
      <div className="s-thread-center-header-info">
        {isDm && detailRoute ? (
          <button
            type="button"
            className="s-thread-center-header-name"
            title={`Open ${threadTitle} details`}
            onClick={() =>
              openContent(
                navigate,
                detailRoute,
                { returnTo: route },
              )
            }
          >
            {threadTitle}
          </button>
        ) : (
          <span className="s-thread-center-header-name">{threadTitle}</span>
        )}
      </div>

      <div className="s-thread-center-header-right">
        {visibleParticipants.length > 0 && (
          <div className="s-thread-participants" aria-label="Conversation participants">
            {visibleParticipants.map((participant) => {
              const modelLabel = participant.model ?? (participant.harness ? "model unknown" : null);
              const runtimeLabel = [modelLabel, participant.reasoningEffort].filter(Boolean).join(" · ") || null;
              const pillTitle = runtimeLabel
                ? `${participant.name} · ${runtimeLabel}`
                : participant.title;
              const content = (
                <>
                  <AgentAvatar
                    agent={participant.agent ?? undefined}
                    name={participant.name}
                    placement="turn"
                    className="s-thread-participant-avatar"
                    title={participant.name}
                  />
                  <span className="s-thread-participant-identity">
                    <span className="s-thread-participant-name">
                      {participant.name}
                    </span>
                    {runtimeLabel && (
                      <span className="s-thread-participant-model" title={runtimeLabel}>
                        {runtimeLabel}
                      </span>
                    )}
                  </span>
                </>
              );
              const participantRoute: Route | null = participant.agent
                ? {
                    view: "agents-v2",
                    agentId: participant.agent.id,
                    ...(machineId ? { machineId } : {}),
                  }
                : participant.sessionId
                  ? {
                      view: "sessions",
                      sessionId: participant.sessionId,
                      ...(machineId ? { machineId } : {}),
                    }
                  : null;
              if (participantRoute) {
                return (
                  <button
                    key={participant.id}
                    type="button"
                    className="s-thread-participant-pill s-thread-participant-pill--button"
                    title={`Open ${participant.name} ${participant.agent ? "profile" : "session"}${
                      runtimeLabel ? ` · ${runtimeLabel}` : ""
                    }`}
                    onClick={() =>
                      openContent(
                        navigate,
                        participantRoute,
                        { returnTo: route },
                      )
                    }
                  >
                    {content}
                  </button>
                );
              }
              return (
                <span
                  key={participant.id}
                  className="s-thread-participant-pill"
                  title={pillTitle}
                >
                  {content}
                </span>
              );
            })}
            {hiddenParticipantCount > 0 && (
              <span className="s-thread-participant-overflow">
                +{hiddenParticipantCount}
              </span>
            )}
            {operator.active ? (
              <span
                className="s-thread-participant-pill s-thread-participant-pill--operator"
                title={`${operator.name} · in this conversation`}
              >
                <AgentAvatar
                  name={operator.name}
                  placement="turn"
                  className="s-thread-participant-avatar s-thread-participant-avatar--operator"
                  title={operator.name}
                />
                <span className="s-thread-participant-identity">
                  <span className="s-thread-participant-name">You</span>
                </span>
              </span>
            ) : (
              <span
                className="s-thread-participant-observer"
                title={`${operator.name} · observing (not in thread)`}
              >
                <Eye size={12} strokeWidth={1.9} aria-hidden="true" />
                <span>Observing</span>
              </span>
            )}
          </div>
        )}
        {canAddParticipants && (
          <button
            type="button"
            className="s-thread-add-participant-trigger"
            onClick={onToggleAddParticipant}
            title="Add participant"
            aria-label="Add participant"
          >
            <UserPlus size={14} strokeWidth={1.9} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}

export function ConversationIdentityRow({
  canonicalConversationId,
  conversationAlias,
}: {
  canonicalConversationId: string;
  conversationAlias: string | null;
}) {
  return (
    <div className="s-thread-identity-row">
      <button
        type="button"
        className="s-thread-identity-chip"
        title={canonicalConversationId}
        onClick={() => void copyTextToClipboard(canonicalConversationId)}
      >
        <span>{conversationIdentityLabel(canonicalConversationId)}</span>
        <strong>{shortConversationIdentity(canonicalConversationId)}</strong>
      </button>
      {conversationAlias && (
        <span className="s-thread-identity-chip" title={conversationAlias}>
          <span>Alias</span>
          <strong>{conversationAlias}</strong>
        </span>
      )}
    </div>
  );
}

export function AddParticipantForm({
  agents,
  addParticipantId,
  setAddParticipantId,
  addingParticipant,
  addParticipantError,
  onCancel,
  onSubmit,
}: {
  agents: Agent[];
  addParticipantId: string;
  setAddParticipantId: (value: string) => void;
  addingParticipant: boolean;
  addParticipantError: string | null;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <form
      className="s-thread-add-participant"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="s-thread-add-participant-row">
        <div className="s-thread-add-participant-field">
          <label
            className="s-thread-add-participant-label"
            htmlFor="thread-add-participant-select"
          >
            Agent
          </label>
          <select
            id="thread-add-participant-select"
            className="s-thread-add-participant-select"
            value={addParticipantId}
            onChange={(event) => setAddParticipantId(event.target.value)}
            autoFocus
          >
            {agents.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
        </div>

        <div className="s-thread-add-participant-actions">
          <button
            type="button"
            className="s-btn s-btn-sm"
            onClick={onCancel}
            disabled={addingParticipant}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="s-btn s-btn-primary s-btn-sm"
            disabled={addingParticipant || addParticipantId.trim().length === 0}
          >
            {addingParticipant ? "Adding..." : "Add"}
          </button>
        </div>
      </div>

      {addParticipantError && (
        <div className="s-thread-add-participant-error">
          {addParticipantError}
        </div>
      )}
    </form>
  );
}
