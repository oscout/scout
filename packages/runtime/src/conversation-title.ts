/**
 * Conversation titles: derived by default, operator-owned once renamed.
 *
 * Every direct conversation gets an automatic title built from its
 * participants' display names. That is right until it isn't — an agent
 * registered from a home directory is called "Art", so the thread reads
 * `Art <> openscout-einstein-6` and the operator appears to be talking to
 * themselves through a third party.
 *
 * A rename therefore cannot be a plain column write. `upsertConversation`
 * rewrites `title` from the definition on every conflict, so the next time the
 * broker re-derives a title — a share-mode flip, a participant change — an
 * operator's name would silently vanish. The mark lives in `metadata` instead,
 * and derivation defers to it: once a human has named a thread, nothing
 * automatic may rename it again.
 *
 * Pure string/record helpers, no imports, so the rules are testable on their
 * own.
 */

export const OPERATOR_TITLE_SOURCE = "operator";

/** Titles live in a narrow rail; past this they only ever truncate. */
export const CONVERSATION_TITLE_MAX = 120;

export type ConversationTitleMetadata = Record<string, unknown>;

/**
 * Trim, collapse runs of whitespace, strip control characters, and cap.
 *
 * Returns "" for anything that is only whitespace — that is the signal to hand
 * the thread back to automatic naming, not an error.
 */
export function normalizeConversationTitle(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const collapsed = raw
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return collapsed.length > CONVERSATION_TITLE_MAX
    ? collapsed.slice(0, CONVERSATION_TITLE_MAX).trim()
    : collapsed;
}

/** Has a human named this thread? */
export function isOperatorTitled(metadata: ConversationTitleMetadata | null | undefined): boolean {
  return metadata?.titleSource === OPERATOR_TITLE_SOURCE;
}

/** Stamp the operator's ownership of the name onto a conversation's metadata. */
export function markOperatorTitled(
  metadata: ConversationTitleMetadata | null | undefined,
  atMs: number,
): ConversationTitleMetadata {
  return { ...(metadata ?? {}), titleSource: OPERATOR_TITLE_SOURCE, titleSetAt: atMs };
}

/** Hand the thread back to automatic naming. */
export function clearOperatorTitle(
  metadata: ConversationTitleMetadata | null | undefined,
): ConversationTitleMetadata {
  const next = { ...(metadata ?? {}) };
  delete next.titleSource;
  delete next.titleSetAt;
  return next;
}

/**
 * What a conversation should be called when the broker re-derives its shape.
 *
 * The operator's name wins, always. This is the guard that stops a share-mode
 * flip from quietly undoing a rename.
 */
export function resolveConversationTitle(input: {
  derived: string;
  existingTitle?: string | null;
  existingMetadata?: ConversationTitleMetadata | null;
}): string {
  if (isOperatorTitled(input.existingMetadata)) {
    const kept = normalizeConversationTitle(input.existingTitle);
    if (kept) return kept;
  }
  return input.derived;
}
