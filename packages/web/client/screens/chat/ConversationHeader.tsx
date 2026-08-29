import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { Eye, UserPlus } from "lucide-react";
import { copyTextToClipboard } from "../../lib/clipboard.ts";
import { routeMachineId } from "../../lib/router.ts";
import type { Agent, Route } from "../../lib/types.ts";
import { AgentAvatar } from "../../components/AgentAvatar.tsx";
import { HarnessMark } from "../../components/HarnessMark.tsx";
import { useContextMenu, type MenuItem } from "../../components/ContextMenu.tsx";
import { HARNESS_HUE } from "../../lib/agent-identity.ts";
import { agentStateLabel, normalizeAgentState } from "../../lib/agent-state.ts";
import { BackToPicker } from "../../scout/slots/BackToPicker.tsx";
import { openContent } from "../../scout/slots/openContent.ts";
import { AstronautSuit } from "./AstronautSuit.tsx";
import { useFacepileAttention } from "./use-facepile-attention.ts";
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
/**
 * Per-slot facepile vars. Leftmost coins paint on top while the wake animation
 * still ripples left-to-right.
 */
function slotVars(slots: number, index: number, harness?: string | null): CSSProperties {
  const hue = harness ? HARNESS_HUE[harness.trim().toLowerCase()] : undefined;
  return {
    ["--fp-z" as string]: String(slots - index),
    ["--fp-i" as string]: String(index),
    ...(hue == null ? {} : { ["--fp-suit-hue" as string]: String(hue) }),
  } as CSSProperties;
}

function compactCount(count: number): string {
  if (count < 1000) return String(count);
  const thousands = count / 1000;
  return thousands < 10
    ? `${thousands.toFixed(1).replace(/\.0$/, "")}k`
    : `${Math.round(thousands)}k`;
}

function ParticipantCard({
  name,
  runtime,
  state,
  action,
}: {
  name: string;
  runtime: string | null;
  state: string;
  action: string | null;
}) {
  return (
    <span className="s-thread-participant-card" aria-hidden="true">
      <strong>{name}</strong>
      {runtime ? <span>{runtime}</span> : null}
      <span>{state}</span>
      {action ? <span className="s-thread-participant-card-action">{action}</span> : null}
    </span>
  );
}

function OverflowCoin({
  count,
  className,
  style,
  rosterId,
  expanded,
  onClick,
}: {
  count: number;
  className: string;
  style: CSSProperties;
  rosterId: string;
  expanded: boolean;
  onClick: () => void;
}) {
  const label = `${count} more participant${count === 1 ? "" : "s"}`;
  return (
    <button
      type="button"
      className={`s-thread-participant s-thread-participant--button ${className}`}
      style={style}
      aria-label={`${label}; open participant list`}
      aria-haspopup="dialog"
      aria-controls={rosterId}
      aria-expanded={expanded}
      onClick={onClick}
    >
      <span className="s-thread-participant-face s-thread-participant-face--overflow">
        +{compactCount(count)}
      </span>
    </button>
  );
}


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
  participants,
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
  participants: ConversationHeaderParticipant[];
  operator: ConversationHeaderOperator;
  canAddParticipants: boolean;
  onToggleAddParticipant: () => void;
}) {
  const showContextMenu = useContextMenu();
  const machineId = routeMachineId(route);
  const pileRef = useRef<HTMLDivElement>(null);
  const rosterRef = useRef<HTMLDivElement>(null);
  const rosterId = useId();
  const [rosterOpen, setRosterOpen] = useState(false);
  useFacepileAttention(pileRef);

  const visibleParticipants = participants.slice(0, 4);
  const desktopOverflowCount = Math.max(participants.length - visibleParticipants.length, 0);
  const compactOverflowCount = Math.max(participants.length - 2, 0);
  const narrowOverflowCount = Math.max(participants.length - 1, 0);
  const pileSlots =
    visibleParticipants.length +
    (desktopOverflowCount > 0 ? 1 : 0) +
    (operator.active ? 1 : 0);

  useEffect(() => {
    if (!rosterOpen) return;
    const onPointer = (event: MouseEvent) => {
      if (!rosterRef.current?.contains(event.target as Node)) {
        setRosterOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setRosterOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [rosterOpen]);

  const participantRoute = (participant: ConversationHeaderParticipant): Route | null =>
    participant.agent
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

  const openParticipant = (participant: ConversationHeaderParticipant) => {
    const destination = participantRoute(participant);
    if (!destination) return;
    setRosterOpen(false);
    openContent(navigate, destination, { returnTo: route });
  };

  return (
    <div
      className="s-thread-center-header"
      onClick={(event) => {
        const target = event.target as HTMLElement | null;
        if (target?.closest("button,a,input,select,textarea")) return;
        if (!isDm || !detailRoute) return;
        openContent(navigate, detailRoute, { returnTo: route });
      }}
      style={isDm && detailRoute ? { cursor: "pointer" } : undefined}
      onContextMenu={(event) => {
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
        showContextMenu(event, items);
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
            onClick={() => openContent(navigate, detailRoute, { returnTo: route })}
          >
            {threadTitle}
          </button>
        ) : (
          <span className="s-thread-center-header-name">{threadTitle}</span>
        )}
      </div>

      <div className="s-thread-center-header-right">
        {participants.length > 0 && (
          <div
            className="s-thread-participants"
            ref={(node) => {
              pileRef.current = node;
              rosterRef.current = node;
            }}
            aria-label="Conversation participants"
          >
            {visibleParticipants.map((participant, index) => {
              const runtimeLabel =
                [participant.harness, participant.model, participant.reasoningEffort]
                  .filter(Boolean)
                  .join(" · ") || null;
              const state = participant.agent
                ? normalizeAgentState(participant.agent.state ?? null, participant.agent)
                : null;
              const stateLabel = participant.agent
                ? agentStateLabel(participant.agent.state ?? null, participant.agent)
                : "Session participant";
              const destination = participantRoute(participant);
              const actionLabel = destination
                ? participant.agent
                  ? "Open profile"
                  : "Open session"
                : null;
              const accessibleLabel = [
                participant.name,
                runtimeLabel,
                stateLabel,
                actionLabel,
              ].filter(Boolean).join(", ");
              const content = (
                <>
                  <span className="s-thread-participant-face">
                    <AstronautSuit />
                    <AgentAvatar
                      agent={participant.agent ?? undefined}
                      name={participant.name}
                      placement="turn"
                      size={28}
                      className="s-thread-participant-avatar"
                    />
                  </span>
                  {participant.harness ? (
                    <HarnessMark
                      harness={participant.harness}
                      size={9}
                      className="s-thread-participant-harness"
                      title={null}
                    />
                  ) : null}
                  <ParticipantCard
                    name={participant.name}
                    runtime={runtimeLabel}
                    state={stateLabel}
                    action={actionLabel}
                  />
                </>
              );
              const commonProps = {
                className: "s-thread-participant",
                style: slotVars(pileSlots, index, participant.harness),
                "data-state": state ?? undefined,
                "data-compact-hidden": index >= 2 ? "true" : undefined,
                "data-narrow-hidden": index >= 1 ? "true" : undefined,
                "aria-label": accessibleLabel,
              } as const;

              return destination ? (
                <button
                  key={participant.id}
                  type="button"
                  {...commonProps}
                  className={`${commonProps.className} s-thread-participant--button`}
                  onClick={() => openParticipant(participant)}
                >
                  {content}
                </button>
              ) : (
                <span
                  key={participant.id}
                  {...commonProps}
                  role="group"
                  tabIndex={0}
                >
                  {content}
                </span>
              );
            })}

            {desktopOverflowCount > 0 ? (
              <OverflowCoin
                count={desktopOverflowCount}
                className="s-thread-participant--desktop-overflow"
                style={slotVars(pileSlots, visibleParticipants.length)}
                rosterId={rosterId}
                expanded={rosterOpen}
                onClick={() => setRosterOpen((open) => !open)}
              />
            ) : null}
            {compactOverflowCount > 0 ? (
              <OverflowCoin
                count={compactOverflowCount}
                className="s-thread-participant--compact-overflow"
                style={slotVars(pileSlots, 2)}
                rosterId={rosterId}
                expanded={rosterOpen}
                onClick={() => setRosterOpen((open) => !open)}
              />
            ) : null}
            {narrowOverflowCount > 0 ? (
              <OverflowCoin
                count={narrowOverflowCount}
                className="s-thread-participant--narrow-overflow"
                style={slotVars(pileSlots, 1)}
                rosterId={rosterId}
                expanded={rosterOpen}
                onClick={() => setRosterOpen((open) => !open)}
              />
            ) : null}

            {operator.active ? (
              <span
                className="s-thread-participant s-thread-participant--operator"
                style={slotVars(pileSlots, pileSlots - 1)}
                role="group"
                tabIndex={0}
                aria-label={`${operator.name}, you, in this conversation`}
              >
                <span className="s-thread-participant-face">
                  <AgentAvatar
                    name={operator.name}
                    placement="turn"
                    size={28}
                    className="s-thread-participant-avatar"
                  />
                </span>
                <ParticipantCard
                  name={`${operator.name} (you)`}
                  runtime={null}
                  state="In this conversation"
                  action={null}
                />
              </span>
            ) : (
              <span
                className="s-thread-participant-observer"
                role="group"
                tabIndex={0}
                aria-label={`${operator.name}, observing, not in this conversation`}
              >
                <Eye size={15} strokeWidth={1.9} aria-hidden="true" />
                <ParticipantCard
                  name={operator.name}
                  runtime={null}
                  state="Observing, not in this conversation"
                  action={null}
                />
              </span>
            )}

            {rosterOpen ? (
              <div
                id={rosterId}
                className="s-thread-participant-roster"
                role="dialog"
                aria-label="Conversation participants"
                onClick={(event) => event.stopPropagation()}
              >
                <strong className="s-thread-participant-roster-title">
                  Participants
                </strong>
                <div className="s-thread-participant-roster-list">
                  {participants.map((participant) => {
                    const destination = participantRoute(participant);
                    const runtime = [participant.harness, participant.model]
                      .filter(Boolean)
                      .join(" · ");
                    const rowContent = (
                      <>
                        <AgentAvatar
                          agent={participant.agent ?? undefined}
                          name={participant.name}
                          placement="turn"
                          size={24}
                          className="s-thread-participant-roster-avatar"
                        />
                        <span>
                          <strong>{participant.name}</strong>
                          {runtime ? <small>{runtime}</small> : null}
                        </span>
                      </>
                    );
                    return destination ? (
                      <button
                        key={participant.id}
                        type="button"
                        className="s-thread-participant-roster-row"
                        onClick={() => openParticipant(participant)}
                      >
                        {rowContent}
                      </button>
                    ) : (
                      <div
                        key={participant.id}
                        className="s-thread-participant-roster-row"
                      >
                        {rowContent}
                      </div>
                    );
                  })}
                  {operator.active ? (
                    <div className="s-thread-participant-roster-row">
                      <AgentAvatar
                        name={operator.name}
                        placement="turn"
                        size={24}
                        className="s-thread-participant-roster-avatar"
                      />
                      <span>
                        <strong>{operator.name} (you)</strong>
                        <small>Operator</small>
                      </span>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}
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
