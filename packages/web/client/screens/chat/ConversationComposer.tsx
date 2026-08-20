import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import { Reply, X } from "lucide-react";
import { actorColor } from "../../lib/colors.ts";
import {
  ComposerAttachmentStrip,
  MessageComposer,
  MessageComposerSuggestions,
  type ComposerAttachmentsState,
} from "../../components/MessageComposer/index.ts";
import type {
  BusySendIntent,
  ComposeAction,
  MentionCandidate,
  MentionSuggestState,
  QueuedDraft,
  SlashCommand,
  SlashSuggestState,
} from "./conversation-model.ts";

export type ConversationReplyTarget = {
  messageId: string;
  actorLabel: string;
  preview: string;
  insertedMention?: string | null;
};

export function ConversationComposer({
  composeRef,
  draft,
  setDraft,
  composePlaceholder,
  slashState,
  setSlashState,
  filteredSlashCommands,
  applySlashCommand,
  mentionState,
  setMentionState,
  filteredMentions,
  applyMention,
  updateTriggersFromDraft,
  closeSuggestions,
  replyTarget,
  onCancelReply,
  isStopMode,
  sending,
  composeAction,
  onSend,
  onInterrupt,
  attachments,
  isAgentBusy,
  busyIntent,
  onBusyIntentChange,
  queued,
  queueNote,
  onEditQueued,
  editingQueuedId,
  editingAttachmentCount,
  onCancelEdit,
  onUnqueue,
  onSendQueuedNow,
}: {
  composeRef: RefObject<HTMLTextAreaElement | null>;
  draft: string;
  setDraft: Dispatch<SetStateAction<string>>;
  composePlaceholder: string;
  slashState: SlashSuggestState;
  setSlashState: Dispatch<SetStateAction<SlashSuggestState>>;
  filteredSlashCommands: SlashCommand[];
  applySlashCommand: (command: SlashCommand) => void;
  mentionState: MentionSuggestState;
  setMentionState: Dispatch<SetStateAction<MentionSuggestState>>;
  filteredMentions: MentionCandidate[];
  applyMention: (candidate: MentionCandidate) => void;
  updateTriggersFromDraft: (value: string, caret: number) => void;
  closeSuggestions: () => void;
  replyTarget: ConversationReplyTarget | null;
  onCancelReply: () => void;
  isStopMode: boolean;
  sending: boolean;
  composeAction: ComposeAction;
  onSend: () => void;
  onInterrupt: () => void;
  attachments: ComposerAttachmentsState;
  isAgentBusy: boolean;
  /** What the next Send press does while the agent is mid-turn. */
  busyIntent: BusySendIntent;
  onBusyIntentChange: (intent: BusySendIntent) => void;
  queued: readonly QueuedDraft[];
  queueNote: string | null;
  /** Pull a queued draft back into the input box to rewrite it. */
  onEditQueued: (id: string) => void;
  /** The queued draft currently held in the input box, if any. */
  editingQueuedId: string | null;
  /** Files already uploaded for the draft being rewritten; they ride along. */
  editingAttachmentCount: number;
  /** Abandon the rewrite and leave the queued row as it was. */
  onCancelEdit: () => void;
  onUnqueue: (id: string) => void;
  /** Interrupt the running turn and release one queued draft immediately. */
  onSendQueuedNow: (id: string) => void;
}) {
  const overlay = (
    <>
      {slashState.open ? (
        <MessageComposerSuggestions
          label="Slash commands"
          items={filteredSlashCommands.map((command) => ({
            id: command.command,
            token: command.label,
            description: command.description,
          }))}
          activeIndex={slashState.index}
          onPick={(index) => {
            const command = filteredSlashCommands[index];
            if (command) applySlashCommand(command);
          }}
          onActiveIndexChange={(index) => setSlashState((state) => ({ ...state, index }))}
        />
      ) : null}

      {mentionState.open ? (
        <MessageComposerSuggestions
          label="Mention agent"
          items={filteredMentions.map((mention) => ({
            id: mention.id,
            token: `@${mention.handle}`,
            description: mention.name,
            avatar: {
              label: mention.name[0]?.toUpperCase() ?? "?",
              color: actorColor(mention.name),
            },
          }))}
          activeIndex={mentionState.index}
          onPick={(index) => {
            const mention = filteredMentions[index];
            if (mention) applyMention(mention);
          }}
          onActiveIndexChange={(index) => setMentionState((state) => ({ ...state, index }))}
        />
      ) : null}
    </>
  );

  // While the agent is mid-turn a draft is ambiguous: hold it for the next turn
  // (Queue) or cut in now (Steer). Queue is the default because interrupting is
  // the destructive read of the two — Steer is armed deliberately.
  const hasDraft = draft.trim().length > 0;
  const isEditing = editingQueuedId !== null;
  // A rewrite counts as content even when its text is emptied, because the
  // files it carries are still going somewhere.
  const hasContent =
    hasDraft || attachments.hasFiles || editingAttachmentCount > 0;
  const queueMode = isAgentBusy && hasContent;
  const steerArmed = queueMode && busyIntent === "steer";
  const editingIndex = isEditing
    ? queued.findIndex((entry) => entry.id === editingQueuedId) + 1
    : 0;

  // A modifier, not a second send: it states what the one Send button will do.
  const modeSwitch = queueMode ? (
    <div
      className="s-msg-compose-mode"
      role="group"
      aria-label="What Send does while this turn is running"
    >
      <button
        type="button"
        className="s-msg-compose-mode-btn"
        data-mode="queue"
        aria-pressed={busyIntent === "queue"}
        title="Hold this draft until the running turn lands"
        disabled={sending}
        onClick={() => onBusyIntentChange("queue")}
      >
        Queue
      </button>
      <button
        type="button"
        className="s-msg-compose-mode-btn"
        data-mode="steer"
        aria-pressed={busyIntent === "steer"}
        title="Interrupt the running turn and deliver this now"
        disabled={sending}
        onClick={() => onBusyIntentChange("steer")}
      >
        Steer
      </button>
    </div>
  ) : null;

  // The queue is fused to the top of the composer box: one object, so a queued
  // draft reads as something the input box is still holding, not a separate
  // list parked above it.
  const queueStack = queued.length > 0 || modeSwitch ? (
    <div className="s-msg-compose-queue" role="group" aria-label="Queued messages">
      <div className="s-msg-compose-queue-head">
        <span className="s-msg-compose-queue-kicker">
          {queued.length > 0 ? `Queue · ${queued.length}` : "Queues next"}
        </span>
        <span className="s-msg-compose-queue-hint">
          {isEditing
            ? steerArmed
              ? `Rewriting ${editingIndex} — send interrupts this turn`
              : `Rewriting ${editingIndex} — send returns it to its place`
            : queued.length > 0
              ? steerArmed
                ? "Send interrupts this turn"
                : (queueNote ?? "")
              : steerArmed
                ? "Interrupts this turn on send"
                : "Sends when this turn lands"}
        </span>
        {modeSwitch}
      </div>
      {queued.map((entry, index) => (
        <div
          className="s-msg-compose-queue-row"
          key={entry.id}
          data-editing={entry.id === editingQueuedId ? "true" : undefined}
        >
          <span className="s-msg-compose-queue-index">{index + 1}</span>
          <span className="s-msg-compose-queue-body">
            {entry.body.trim() || "Attachments only"}
          </span>
          {entry.attachments.length > 0 ? (
            <span className="s-msg-compose-queue-clip">
              {entry.attachments.length} file
              {entry.attachments.length === 1 ? "" : "s"}
            </span>
          ) : null}
          {entry.id === editingQueuedId ? (
            <button
              type="button"
              className="s-msg-compose-queue-edit"
              title="Stop rewriting — leave this row as it was"
              aria-label={`Cancel rewriting queued message ${index + 1}`}
              onClick={onCancelEdit}
            >
              Cancel edit
            </button>
          ) : (
            <button
              type="button"
              className="s-msg-compose-queue-edit"
              title="Pull this back into the input box to rewrite it"
              aria-label={`Edit queued message ${index + 1}`}
              disabled={sending || isEditing}
              onClick={() => onEditQueued(entry.id)}
            >
              Edit
            </button>
          )}
          <button
            type="button"
            className="s-msg-compose-queue-now"
            title="Interrupt this turn and send this now"
            aria-label={`Send queued message ${index + 1} now`}
            disabled={sending || entry.id === editingQueuedId}
            onClick={() => onSendQueuedNow(entry.id)}
          >
            Send now
          </button>
          <button
            type="button"
            className="s-msg-compose-queue-drop"
            title="Cancel — drop this from the queue"
            aria-label={`Cancel queued message ${index + 1}`}
            onClick={() => onUnqueue(entry.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  ) : null;

  return (
    <MessageComposer
      density="thread"
      value={draft}
      onChange={(next, meta) => {
        setDraft(next);
        updateTriggersFromDraft(next, meta?.caret ?? next.length);
      }}
      onSend={onSend}
      placeholder={composePlaceholder}
      sending={sending}
      stopMode={isStopMode}
      onStop={onInterrupt}
      canSend={hasContent}
      sendTitle={
        steerArmed
          ? "Steer — interrupt this turn and send now (Cmd+Enter)"
          : queueMode
            ? "Queue for the next turn (Cmd+Enter)"
            : "Send (Cmd+Enter)"
      }
      sendAriaLabel={
        steerArmed
          ? "Steer — interrupt this turn and send now (Cmd+Enter)"
          : queueMode
            ? "Queue message for the next turn (Cmd+Enter)"
            : composeAction === "steer"
              ? "Send follow-up (Cmd+Enter)"
              : "Send message (Cmd+Enter)"
      }
      showAttach
      onAttach={attachments.openPicker}
      onPaste={attachments.onPaste}
      dropHandlers={attachments.dropHandlers}
      dragActive={attachments.dragActive}
      textareaRef={composeRef}
      overlay={overlay}
      above={queueStack}
      aboveAttached
      header={
        <>
          {replyTarget ? (
            <div className="s-thread-compose-reply" role="status">
              <Reply
                className="s-thread-compose-reply-icon"
                size={13}
                strokeWidth={1.8}
                aria-hidden="true"
              />
              <span className="s-thread-compose-reply-label">Replying to</span>
              <span className="s-thread-compose-reply-actor">
                {replyTarget.actorLabel}
              </span>
              <span
                className="s-thread-compose-reply-preview"
                title={replyTarget.preview}
              >
                {replyTarget.preview}
              </span>
              <button
                type="button"
                className="s-thread-compose-reply-cancel"
                aria-label="Cancel reply"
                title="Cancel reply"
                onClick={onCancelReply}
              >
                <X size={13} strokeWidth={1.8} aria-hidden="true" />
              </button>
            </div>
          ) : null}
          {isEditing && editingAttachmentCount > 0 ? (
            <div className="s-msg-compose-carried" role="status">
              {editingAttachmentCount} file
              {editingAttachmentCount === 1 ? "" : "s"} stay attached to this
              draft
            </div>
          ) : null}
          <ComposerAttachmentStrip attachments={attachments} />
        </>
      }
      tools={(
        <span className="s-thread-compose-hint s-msg-compose-tools-hint">
          <kbd className="s-kbd">/</kbd> commands
          {" · "}
          <kbd className="s-kbd">@</kbd> agents
        </span>
      )}
      onSelect={(event) => {
        const target = event.currentTarget;
        updateTriggersFromDraft(target.value, target.selectionStart);
      }}
      onBlur={() => {
        setTimeout(closeSuggestions, 120);
      }}
      onKeyDown={(event) => {
        const suggestOpen =
          (slashState.open && filteredSlashCommands.length > 0)
          || (mentionState.open && filteredMentions.length > 0);
        if (!suggestOpen) return false;

        if (event.key === "ArrowDown") {
          if (slashState.open) {
            setSlashState((s) => ({
              ...s,
              index: (s.index + 1) % filteredSlashCommands.length,
            }));
          } else if (mentionState.open) {
            setMentionState((s) => ({
              ...s,
              index: (s.index + 1) % filteredMentions.length,
            }));
          }
          return true;
        }
        if (event.key === "ArrowUp") {
          if (slashState.open) {
            setSlashState((s) => ({
              ...s,
              index:
                (s.index - 1 + filteredSlashCommands.length)
                % filteredSlashCommands.length,
            }));
          } else if (mentionState.open) {
            setMentionState((s) => ({
              ...s,
              index:
                (s.index - 1 + filteredMentions.length)
                % filteredMentions.length,
            }));
          }
          return true;
        }
        if (event.key === "Escape") {
          closeSuggestions();
          return true;
        }
        if (
          (event.key === "Enter" || event.key === "Tab")
          && !event.shiftKey
          && !event.metaKey
          && !event.ctrlKey
          && !event.altKey
        ) {
          if (slashState.open) {
            const pick =
              filteredSlashCommands[slashState.index]
              ?? filteredSlashCommands[0];
            if (pick) applySlashCommand(pick);
          } else if (mentionState.open) {
            const pick =
              filteredMentions[mentionState.index] ?? filteredMentions[0];
            if (pick) applyMention(pick);
          }
          return true;
        }
        return false;
      }}
    />
  );
}
