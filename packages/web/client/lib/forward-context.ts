import type { ForwardContextMode, ForwardContextSource } from "./context-capture-draft.ts";

const MAX_PRIOR_TURNS = 6;
const MAX_TURN_CHARS = 1_600;
const MAX_EXCERPT_CHARS = 8_000;

export type ForwardSourceTurn = {
  id: string;
  actorLabel: string;
  body: string;
  attachmentCount?: number;
};

function attachmentLabel(count: number): string {
  if (count === 0) return "";
  return count === 1
    ? "[1 attachment remains on the source Scout message; not copied]"
    : `[${count} attachments remain on the source Scout message; not copied]`;
}

function boundedBody(turn: ForwardSourceTurn): string {
  const body = turn.body.trim();
  const attachments = attachmentLabel(turn.attachmentCount ?? 0);
  const content = [body, attachments].filter(Boolean).join("\n") || "(message has no text)";
  if (content.length <= MAX_TURN_CHARS) return content;
  return `${content.slice(0, MAX_TURN_CHARS - 1).trimEnd()}…`;
}

function quotedMessage(turn: ForwardSourceTurn): string {
  const quotedBody = boundedBody(turn)
    .split(/\r?\n/gu)
    .map((line) => `> ${line}`)
    .join("\n");
  return `Forwarded from ${turn.actorLabel} in Scout\n\n${quotedBody}`;
}

export function createForwardContextSource(input: {
  conversationId: string;
  messages: readonly ForwardSourceTurn[];
  selectedMessageId: string;
}): ForwardContextSource {
  const selectedIndex = input.messages.findIndex((message) => message.id === input.selectedMessageId);
  if (selectedIndex < 0) {
    throw new Error("The selected message is no longer available in this conversation.");
  }

  const selected = input.messages[selectedIndex]!;
  const prior = input.messages
    .slice(Math.max(0, selectedIndex - MAX_PRIOR_TURNS), selectedIndex)
    .filter((turn) => turn.body.trim() || (turn.attachmentCount ?? 0) > 0);
  const recentContext = prior
    .map((turn) => `${turn.actorLabel}:\n${boundedBody(turn)}`)
    .join("\n\n")
    .slice(-MAX_EXCERPT_CHARS)
    .trim();

  return {
    selectedMessage: quotedMessage(selected),
    selectedMessageId: selected.id,
    sourceConversationId: input.conversationId,
    ...(recentContext ? { recentContext } : {}),
    recentMessageCount: prior.length,
  };
}

/** Build the initial prompt for the fresh task without overstating provenance. */
export function buildForwardTaskInstructions(
  source: ForwardContextSource,
  mode: ForwardContextMode,
  instructions: string,
): string {
  const note = instructions.trim();
  const sourceBlock = mode === "instructions-only"
    ? ""
    : mode === "recent-context" && source.recentContext
      ? [
          `Recent Scout conversation before the forwarded message (${source.recentMessageCount} ${source.recentMessageCount === 1 ? "message" : "messages"})`,
          source.recentContext,
          source.selectedMessage,
        ].join("\n\n")
      : source.selectedMessage;

  if (!note) return sourceBlock;
  if (!sourceBlock) return note;
  return `${note}\n\n---\n\n${sourceBlock}`;
}
