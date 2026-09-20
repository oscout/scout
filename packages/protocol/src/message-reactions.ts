/** Hover strip. Unknown emoji is `400 invalid_emoji`. */
export const REACTION_EMOJI_QUICK = ["👍", "❤️", "😂", "👀", "🎉"] as const;

/** Extra row, opened from “more” on the strip. */
export const REACTION_EMOJI_MORE = [
  "🔥",
  "🙏",
  "👏",
  "😢",
  "😮",
  "🚀",
  "✅",
  "💯",
  "🤔",
  "💡",
  "🙌",
  "✨",
] as const;

export const REACTION_EMOJI_ALLOWLIST = [
  ...REACTION_EMOJI_QUICK,
  ...REACTION_EMOJI_MORE,
] as const;

export type ReactionEmoji = (typeof REACTION_EMOJI_ALLOWLIST)[number];

export const REACTION_EMOJI_ALLOWLIST_SET: ReadonlySet<string> = new Set(REACTION_EMOJI_ALLOWLIST);

export function isAllowedReactionEmoji(value: string): value is ReactionEmoji {
  return REACTION_EMOJI_ALLOWLIST_SET.has(value);
}

/** One chip on a message, as the feed projects it for the authenticated viewer. */
export interface MessageReactionChip {
  emoji: string;
  count: number;
  me: boolean;
}

/** One stored row. Canonical identity is `(messageId, actorId, emoji)`. */
export interface MessageReactionRecord {
  messageId: string;
  actorId: string;
  emoji: string;
  createdAt: number;
}

/**
 * Project stored rows onto the feed shape.
 *
 * Order is first time that emoji appeared, then allowlist index as a tie-break,
 * so a count change never reshuffles the row under the cursor.
 */
export function projectMessageReactionChips(
  rows: readonly MessageReactionRecord[],
  viewerActorId: string,
): MessageReactionChip[] {
  const byEmoji = new Map<string, { count: number; me: boolean; firstAt: number }>();
  for (const row of rows) {
    const current = byEmoji.get(row.emoji);
    if (current) {
      current.count += 1;
      if (row.actorId === viewerActorId) current.me = true;
      if (row.createdAt < current.firstAt) current.firstAt = row.createdAt;
    } else {
      byEmoji.set(row.emoji, {
        count: 1,
        me: row.actorId === viewerActorId,
        firstAt: row.createdAt,
      });
    }
  }
  const allowlistIndex = (emoji: string): number => {
    const index = REACTION_EMOJI_ALLOWLIST.indexOf(emoji as ReactionEmoji);
    return index === -1 ? REACTION_EMOJI_ALLOWLIST.length : index;
  };
  return [...byEmoji.entries()]
    .sort((left, right) => {
      const time = left[1].firstAt - right[1].firstAt;
      if (time !== 0) return time;
      return allowlistIndex(left[0]) - allowlistIndex(right[0]);
    })
    .map(([emoji, value]) => ({ emoji, count: value.count, me: value.me }));
}
