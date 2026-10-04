/**
 * A scannable outline of a work request. Pure and verbatim: every sentence of
 * the original task lands in exactly one slot, unedited, so the outline can be
 * read instead of the prompt without losing or rewording anything.
 */

export type RequestLine = { lead: string | null; rest: string };

export type RequestOutline = {
  /** Framing that came before the ask ("User correction: '…'"). */
  context: string[];
  /** The headline: the first real instruction. */
  ask: string;
  /** Fragments of a "Read …" sentence, one chip each. */
  readFirst: string[];
  /** Short comma-listed requirements, one chip each. */
  spec: string[];
  build: RequestLine[];
  guard: RequestLine[];
  deliver: RequestLine[];
  /** An explicit authorization sentence, preserved verbatim. */
  authorized: string | null;
  /** False when the task is too short to outline; render it as text instead. */
  structured: boolean;
};

const GUARD = /^(no|not|never|don['’]t|do not|must not|preserve|keep|avoid)\b/i;
const DELIVER = /^(tests?|provide|use|report|return|reply|hand back|deliver)\b/i;
const CONTEXT = /^[\w\s'’-]{1,32}:\s*['"“‘]/;
const READ = /^read\s+/i;
const AUTH = /^(?:this is|you have) (?:explicit )?authori[sz]ation to\s+/i;

export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?]['"”’)]?)\s+(?=[A-Z0-9'"“‘(])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function trimEnd(s: string): string {
  return s.replace(/[.;]\s*$/, "");
}

function specParts(sentence: string): string[] | null {
  const parts = trimEnd(sentence).split(/,\s+/);
  if (parts.length < 4) return null;
  return parts.every((p) => p.split(/\s+/).length <= 7) ? parts : null;
}

export function toLine(sentence: string): RequestLine {
  const m = sentence.match(/^([^,;:]{2,60}?)([,;:])\s+(.+)$/);
  if (m && m[1]!.split(/\s+/).length <= 6) return { lead: `${m[1]}${m[2]}`, rest: m[3]! };
  return { lead: null, rest: sentence };
}

export function outlineRequest(task: string): RequestOutline {
  const sentences = splitSentences(task);
  const outline: RequestOutline = {
    context: [],
    ask: "",
    readFirst: [],
    spec: [],
    build: [],
    guard: [],
    deliver: [],
    authorized: null,
    structured: sentences.length >= 4,
  };
  let i = 0;
  while (i < sentences.length - 1 && CONTEXT.test(sentences[i]!)) outline.context.push(sentences[i++]!);
  outline.ask = sentences[i++] ?? task.trim();
  if (!outline.structured) {
    outline.build = sentences.slice(i).map(toLine);
    return outline;
  }
  for (; i < sentences.length; i++) {
    const s = sentences[i]!;
    const auth = s.match(AUTH);
    if (auth && auth.index !== undefined && outline.authorized === null) {
      outline.authorized = s;
      continue;
    }
    if (READ.test(s) && outline.readFirst.length === 0) {
      outline.readFirst = trimEnd(s.replace(READ, ""))
        .split(/\s*(?:(?<=\.\w{1,5}|\b[A-Z_]{3,})\/|\+|,|\band\b)\s*/)
        .map((p) => p.trim())
        .filter(Boolean);
      continue;
    }
    const spec = outline.spec.length === 0 ? specParts(s) : null;
    if (spec) {
      outline.spec = spec;
      continue;
    }
    const line = toLine(s);
    if (GUARD.test(s) || /\bmust not\b/i.test(s)) outline.guard.push(line);
    else if (DELIVER.test(s)) outline.deliver.push(line);
    else outline.build.push(line);
  }
  return outline;
}

/** Every sentence the outline holds, for the verbatim guarantee. */
export function outlineSentenceCount(outline: RequestOutline): number {
  return outline.context.length + (outline.ask ? 1 : 0) + (outline.readFirst.length ? 1 : 0)
    + (outline.spec.length ? 1 : 0) + outline.build.length + outline.guard.length
    + outline.deliver.length + (outline.authorized !== null ? 1 : 0);
}
