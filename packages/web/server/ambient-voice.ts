/**
 * Always-on voice: the Mac transcribes continuously on-device and hands each
 * finalized segment here. Segments live only in this in-memory buffer, never
 * on disk and never off the machine, until the operator speaks a submit
 * phrase. The submit sends one excerpt of the buffer to Scoutbot.
 *
 * The excerpt is deliberately imprecise: "everything since I said X", "the
 * last two minutes", or, by default, the stretch of talk since the last long
 * pause. It never reaches back past the previous submit.
 */

export type AmbientSegment = {
  text: string;
  /** Wall-clock ms when the segment was spoken (its start). */
  at: number;
};

export type AmbientSubmit = {
  /** What the operator asked for, with the submit phrase removed. */
  command: string;
  /** Speech after the submit phrase in the same segment: the start of the next thought. */
  after: string;
  /** Words after "since/after I said", to find the excerpt's start. */
  anchor: string | null;
  /** "the last N minutes/seconds". */
  lookbackMs: number | null;
};

export type AmbientExcerpt = {
  text: string;
  startedAt: number;
  endedAt: number;
  segmentCount: number;
  reason: "anchor" | "lookback" | "pause" | "cap";
};

// Short on purpose: nobody submits "the last hour", and a day-long buffer is
// memory and a transcript of everything said near the Mac.
export const AMBIENT_BUFFER_MS = 5 * 60_000;
export const AMBIENT_DEFAULT_PAUSE_MS = 20_000;
export const AMBIENT_DEFAULT_CAP_MS = 2 * 60_000;
export const AMBIENT_MAX_LOOKBACK_MS = AMBIENT_BUFFER_MS;
const SPLIT_SUBMIT_MS = 10_000;

// "Scout" plus a hand-off verb, in either order. Talking *about* Scout all day
// must not submit, so a bare mention never counts.
const SUBMIT_VERBS = [
  "go ahead",
  "go",
  "send it",
  "send that",
  "send",
  "take it",
  "take that",
  "take it from here",
  "run with it",
  "run with that",
  "handle it",
  "handle that",
  "do it",
  "do that",
  "over to you",
  "your turn",
];

const VERB_PATTERN = SUBMIT_VERBS
  .slice()
  .sort((a, b) => b.length - a.length)
  .map((verb) => verb.replace(/ /g, "\\s+"))
  .join("|");

// "... okay Scout, send it." / "Scout, take it from here" / "over to you, Scout".
// The phrase must end its sentence (punctuation or the end of the segment):
// continuous speech runs straight on ("…send it. Hey, next thing"), while
// "Scout, go ahead with the release" is talk, not a submit.
const SUBMIT_PHRASE = new RegExp(
  `(?:^|[\\s,.;!?])(?:(?:ok(?:ay)?|hey|alright|all right)[\\s,]+)?`
    + `(?:scout[\\s,]+(?:${VERB_PATTERN})|(?:${VERB_PATTERN})[\\s,]+scout)`
    + `\\s*(?:[.!?]+|$)`,
  "gi",
);
// "Scout, <command>" as a whole segment: "Scout, turn that into a ticket".
const ADDRESSED_COMMAND = /^(?:(?:ok(?:ay)?|hey|alright|all right)[\s,]+)?scout[\s,]+(.+)$/i;

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, ninety: 90,
};

/**
 * Reads one finalized segment for a submit. Two shapes count:
 * - speech that *ends* with an address plus hand-off verb ("…okay Scout, send it"),
 *   where the words before it are the command;
 * - a segment that *starts* by addressing Scout and ends with a hand-off verb.
 */
export function detectAmbientSubmit(segment: string): AmbientSubmit | null {
  const text = segment.trim();
  if (!text) return null;
  // The last submit in the segment wins; a repeated "send it" is one submit.
  let match: RegExpExecArray | null = null;
  SUBMIT_PHRASE.lastIndex = 0;
  for (let next = SUBMIT_PHRASE.exec(text); next; next = SUBMIT_PHRASE.exec(text)) {
    match = next;
    if (next[0].length === 0) SUBMIT_PHRASE.lastIndex += 1;
  }
  if (!match) return null;

  const before = stripSubmitPhrases(text.slice(0, match.index)).trim().replace(/[\s,;:-]+$/, "");
  const after = text.slice(match.index + match[0].length).trim();
  const addressed = ADDRESSED_COMMAND.exec(before);
  const spoken = (addressed ? addressed[1]! : before).trim();
  return {
    command: spoken,
    after,
    anchor: readAnchor(spoken),
    lookbackMs: readLookback(spoken),
  };
}

function stripSubmitPhrases(text: string): string {
  return text.replace(SUBMIT_PHRASE, (phrase) => (/^[\s,.;!?]/.test(phrase) ? phrase[0]! : "")).replace(/\s{2,}/g, " ");
}

function readAnchor(text: string): string | null {
  const match = /\b(?:since|after|from (?:when|where))\s+i\s+(?:said|mentioned|started talking about|talked about|brought up)\s+(.+?)(?:[,.;!?]|$)/i.exec(text);
  const anchor = match?.[1]?.trim().replace(/^["'“]|["'”]$/g, "");
  return anchor ? anchor : null;
}

function readLookback(text: string): number | null {
  const match = /\b(?:last|past|previous)\s+(?:(\d+|[a-z]+)\s+)?(minute|minutes|min|mins|second|seconds|sec|secs)\b/i.exec(text);
  if (!match) return null;
  const rawCount = match[1]?.toLowerCase();
  const count = rawCount === undefined
    ? 1
    : /^\d+$/.test(rawCount) ? Number(rawCount) : NUMBER_WORDS[rawCount];
  if (!count) return null;
  const unit = match[2]!.toLowerCase().startsWith("m") ? 60_000 : 1_000;
  return Math.min(count * unit, AMBIENT_MAX_LOOKBACK_MS);
}

/**
 * Picks the excerpt a submit refers to from segments *before* the submitting
 * one (oldest first). `floor` is the previous submit's time; nothing at or
 * before it is sent twice.
 */
export function selectAmbientExcerpt(input: {
  segments: readonly AmbientSegment[];
  submit: AmbientSubmit;
  now: number;
  floor?: number;
  pauseMs?: number;
  capMs?: number;
}): AmbientExcerpt | null {
  const floor = input.floor ?? Number.NEGATIVE_INFINITY;
  const eligible = input.segments.filter((segment) => segment.at > floor && segment.text.trim());
  if (eligible.length === 0) return null;

  let startIndex: number | null = null;
  let reason: AmbientExcerpt["reason"] = "pause";

  if (input.submit.anchor) {
    const found = findAnchor(eligible, input.submit.anchor);
    if (found !== null) {
      startIndex = found;
      reason = "anchor";
    }
  }
  if (startIndex === null && input.submit.lookbackMs !== null) {
    const since = input.now - input.submit.lookbackMs;
    const index = eligible.findIndex((segment) => segment.at >= since);
    if (index >= 0) {
      startIndex = index;
      reason = "lookback";
    }
  }
  if (startIndex === null) {
    // Walk back through continuous talk; stop at a long pause or the cap.
    const pauseMs = input.pauseMs ?? AMBIENT_DEFAULT_PAUSE_MS;
    const capSince = input.now - (input.capMs ?? AMBIENT_DEFAULT_CAP_MS);
    let index = eligible.length - 1;
    reason = "pause";
    while (index > 0 && eligible[index]!.at - eligible[index - 1]!.at < pauseMs) {
      if (eligible[index - 1]!.at < capSince) {
        reason = "cap";
        break;
      }
      index -= 1;
    }
    startIndex = index;
  }

  const picked = eligible.slice(startIndex);
  return {
    text: picked.map((segment) => segment.text.trim()).join(" "),
    startedAt: picked[0]!.at,
    endedAt: picked[picked.length - 1]!.at,
    segmentCount: picked.length,
    reason,
  };
}

/** Latest segment containing most of the anchor's words, in order-insensitive loose match. */
function findAnchor(segments: readonly AmbientSegment[], anchor: string): number | null {
  const words = normalizeWords(anchor);
  if (words.length === 0) return null;
  const needed = Math.max(1, Math.ceil(words.length * 0.6));
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const have = new Set(normalizeWords(segments[index]!.text));
    const hits = words.filter((word) => have.has(word)).length;
    if (hits >= needed) return index;
  }
  return null;
}

function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 1 && !ANCHOR_STOPWORDS.has(word));
}

const ANCHOR_STOPWORDS = new Set(["the", "a", "an", "and", "of", "to", "about", "that", "this", "it", "is", "was"]);

/** In-memory rolling window of finalized segments. */
export class AmbientTranscriptBuffer {
  private segments: AmbientSegment[] = [];
  private lastSubmitAt = Number.NEGATIVE_INFINITY;
  /** A submit already fired from the live transcript; its final segment is spent. */
  private submittedFromPartial = false;

  constructor(private readonly windowMs = AMBIENT_BUFFER_MS) {}

  /**
   * Adds a segment. Returns the submit it carries, with the excerpt it points
   * at, or null when it's ordinary speech.
   */
  push(segment: AmbientSegment): { submit: AmbientSubmit; excerpt: AmbientExcerpt | null } | null {
    this.prune(segment.at);
    if (this.submittedFromPartial) {
      // This final is the phrase the live transcript already submitted; keep
      // only what came after it.
      this.submittedFromPartial = false;
      const spent = detectAmbientSubmit(segment.text);
      if (spent) {
        if (spent.after) this.segments.push({ text: spent.after, at: segment.at });
        return null;
      }
    }
    let submit = detectAmbientSubmit(segment.text);
    if (!submit) {
      // The recognizer can finalize "okay Scout," and "send it" separately.
      const previous = this.segments[this.segments.length - 1];
      const joined = previous && segment.at - previous.at < SPLIT_SUBMIT_MS
        ? detectAmbientSubmit(`${previous.text} ${segment.text}`)
        : null;
      if (joined && !detectAmbientSubmit(previous!.text)) {
        this.segments.pop();
        submit = joined;
      }
    }
    if (!submit) {
      this.segments.push(segment);
      return null;
    }
    // Words spoken before the submit phrase in the same breath are usually the
    // ask itself ("…turn that into a ticket, okay Scout, send it").
    if (submit.command) this.segments.push({ text: submit.command, at: segment.at });
    const excerpt = selectAmbientExcerpt({
      segments: this.segments,
      submit,
      now: segment.at,
      floor: this.lastSubmitAt,
    });
    this.lastSubmitAt = segment.at;
    if (submit.after) this.segments.push({ text: submit.after, at: segment.at + 1 });
    return { submit, excerpt };
  }

  /**
   * The in-progress (volatile) transcript, checked so a submit doesn't wait
   * for the recognizer to finalize after a pause. Fires only when the phrase
   * ends the live text; otherwise the final segment decides.
   */
  pushPartial(partial: AmbientSegment): { submit: AmbientSubmit; excerpt: AmbientExcerpt | null } | null {
    if (this.submittedFromPartial) return null;
    const submit = detectAmbientSubmit(partial.text);
    if (!submit || submit.after) return null;
    this.prune(partial.at);
    if (submit.command) this.segments.push({ text: submit.command, at: partial.at });
    const excerpt = selectAmbientExcerpt({
      segments: this.segments,
      submit,
      now: partial.at,
      floor: this.lastSubmitAt,
    });
    this.lastSubmitAt = partial.at;
    this.submittedFromPartial = true;
    return { submit, excerpt };
  }

  clear(): void {
    this.segments = [];
  }

  /** What's buffered, for the operator's own "what did it hear" check. */
  transcript(): AmbientSegment[] {
    return this.segments.map((segment) => ({ ...segment }));
  }

  snapshot(): { segmentCount: number; oldestAt: number | null; newestAt: number | null } {
    return {
      segmentCount: this.segments.length,
      oldestAt: this.segments[0]?.at ?? null,
      newestAt: this.segments[this.segments.length - 1]?.at ?? null,
    };
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    const firstKept = this.segments.findIndex((segment) => segment.at >= cutoff);
    this.segments = firstKept < 0 ? [] : this.segments.slice(firstKept);
  }
}
