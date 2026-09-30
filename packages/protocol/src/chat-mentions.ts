/** Explicit attention recipients. Text is payload and is never parsed as routing. */
export const MAX_CHAT_MENTIONS = 20;

export function parseChatMentionActorIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_CHAT_MENTIONS
    || value.some(id => typeof id !== "string" || !id.trim() || id.length > 256)) {
    throw new Error("Choose at most 20 valid mention recipients.");
  }
  return [...new Set(value.map(id => (id as string).trim()))].sort();
}
