/**
 * What Scout reads back when an agent answers.
 *
 * This is deliberately not a model-written summary: it is the reply's own
 * opening, stripped of markup that turns into noise when spoken and cut at a
 * sentence boundary. A real summary would mean a round trip to a model before
 * the first word is heard, and the point of talk-back is hearing something
 * while you are still looking somewhere else.
 */

const MAX_SPOKEN_CHARS = 240;

/** Markup that reads as punctuation noise out loud rather than as meaning. */
function stripMarkup(body: string): string {
  return body
    // Fenced code never survives — dictating braces helps nobody.
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    // Images before links: the alt text is the only speakable part.
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s{0,3}[-*+]\s+/gm, "")
    .replace(/^\s{0,3}\d+[.)]\s+/gm, "")
    .replace(/(\*\*|__|\*|_|~~)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * First whole sentences of `body`, at most `maxChars`. Empty when the reply had
 * nothing speakable in it — an all-code answer, say — which the caller should
 * report in its own words rather than reading silence.
 */
export function spokenReplyLead(body: string, maxChars = MAX_SPOKEN_CHARS): string {
  const text = stripMarkup(body ?? "");
  if (!text) return "";
  if (text.length <= maxChars) return text;

  // Prefer a sentence boundary, then a word boundary, then a hard cut — always
  // something that ends cleanly rather than mid-syllable.
  const window = text.slice(0, maxChars + 1);
  const sentenceEnd = Math.max(
    window.lastIndexOf(". "),
    window.lastIndexOf("! "),
    window.lastIndexOf("? "),
  );
  if (sentenceEnd > maxChars * 0.4) return window.slice(0, sentenceEnd + 1).trim();

  const wordEnd = window.lastIndexOf(" ");
  return `${(wordEnd > 0 ? window.slice(0, wordEnd) : text.slice(0, maxChars)).trim()}…`;
}

/** The full sentence Scout speaks, including who it came from. */
export function spokenReplyAnnouncement(agentLabel: string, body: string): string {
  const lead = spokenReplyLead(body);
  return lead ? `${agentLabel} says: ${lead}` : `${agentLabel} replied, but there was nothing to read out.`;
}
