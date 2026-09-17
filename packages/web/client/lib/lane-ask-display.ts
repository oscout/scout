import type { ObserveEvent } from "./types.ts";

export type LaneAskDisplayField = {
  label: string;
  value: string;
};

/** An injected-context wrapper (`<in-app-browser-context …>`, `<system-reminder …>`)
 *  lifted out of the request prose so it can render as a chip instead of raw markup. */
export type LaneAskContextTag = {
  /** Element name, lower-cased (e.g. "in-app-browser-context"). */
  name: string;
  /** Most identifying attribute value (`source` preferred, else the first one). */
  detail?: string;
  /** Verbatim opening token, for tooltips. */
  raw: string;
};

export type LaneAskDisplayModel = {
  label: string;
  title: string;
  preview: string;
  requestText: string;
  fullText: string;
  copyText: string;
  fields: LaneAskDisplayField[];
  contextTags: LaneAskContextTag[];
  answer?: {
    label: string;
    text: string;
  };
};

const LEADING_AGENTS_BLOCK = /^\s*#\s*AGENTS\.md instructions[^\n]*(?:\n+<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>)?/i;
const XML_INSTRUCTIONS_BLOCK = /<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/gi;
const ROUTED_TASK_LABEL = /\bask\/Task\s*:\s*([^\n]+)/i;
const TASK_LABEL = /^(?:#+\s*)?(?:task|request|prompt|goal|user goal|user request|ask)\s*:\s*(.+)$/i;
const REQUEST_SECTION_HEADING = /^\s*#{1,4}\s*(?:my request(?:\s+for\s+[^:\n]+)?|request|user request)\s*:?\s*$/i;
const INSTRUCTION_HEADING = /^#?\s*(?:AGENTS\.md instructions|Global Codex Build Hygiene|Agent Instructions)\b/i;
const FILES_MENTIONED_HEADING = /^#?\s*Files mentioned by the user\s*:?\s*$/i;
const MARKDOWN_FENCE = /^```/;
const ROUTING_PREFIX = /^.+?\bask\/Task\s*:\s*/i;
const SCOUT_ROUTING_HEADER = /^\s*(?:\u2316\s*)?.+?\s+(?:->|\u2192)\s+.+?\s+(?:\u00b7|\.)\s+ask:[\w-]+\s*(?:>|\u203a)\s*/iu;
const CODEX_TASK_PREFIX = /^#?\s*Codex task\s*(?:[-:\u2013\u2014])\s*/i;
const GENERIC_REQUEST_LABEL = /^(?:ask|request|user request|incoming ask)$/i;

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\r\n/g, "\n").trim();
}

function stripLeadingInstructionBlocks(value: string): string {
  let text = value.trim();
  let changed = true;
  while (changed) {
    const next = text.replace(LEADING_AGENTS_BLOCK, "").trim();
    changed = next !== text;
    text = next;
  }
  return text.replace(XML_INSTRUCTIONS_BLOCK, "").trim();
}

function stripLeadingGenericRequestLabels(value: string): string {
  let text = value.trim();
  let changed = true;

  while (changed) {
    changed = false;
    const lines = text.split("\n");
    const first = cleanLine(lines[0] ?? "");
    if (GENERIC_REQUEST_LABEL.test(first) && lines.length > 1) {
      text = lines.slice(1).join("\n").trim();
      text = stripLeadingInstructionBlocks(text);
      changed = true;
    }
  }

  return text;
}

function stripFilesMentionedSections(value: string): string {
  const lines = value.split("\n");
  const kept: string[] = [];
  let skipping = false;

  for (const line of lines) {
    if (FILES_MENTIONED_HEADING.test(line)) {
      skipping = true;
      continue;
    }
    if (skipping && REQUEST_SECTION_HEADING.test(line)) {
      skipping = false;
      kept.push(line);
      continue;
    }
    if (!skipping) kept.push(line);
  }

  return kept.join("\n").trim();
}

function cleanLine(value: string): string {
  return value
    .trim()
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/u, "")
    .replace(/^>\s*/u, "")
    .replace(SCOUT_ROUTING_HEADER, "")
    .replace(ROUTING_PREFIX, "")
    .replace(CODEX_TASK_PREFIX, "")
    .trim();
}

function isMeaningfulLine(value: string): boolean {
  const line = cleanLine(value);
  if (!line) return false;
  if (MARKDOWN_FENCE.test(line)) return false;
  if (INSTRUCTION_HEADING.test(line)) return false;
  if (FILES_MENTIONED_HEADING.test(line)) return false;
  if (REQUEST_SECTION_HEADING.test(line)) return false;
  if (GENERIC_REQUEST_LABEL.test(line)) return false;
  if (/^<image\b/i.test(line) || /^<\/image>$/i.test(line)) return false;
  if (/^<\/?INSTRUCTIONS>$/i.test(line)) return false;
  return /[\p{L}\p{N}]/u.test(line);
}

function firstMeaningfulLine(value: string): string | null {
  for (const raw of value.split("\n")) {
    if (!isMeaningfulLine(raw)) continue;
    return cleanLine(raw);
  }
  return null;
}

function labeledRequest(value: string): string | null {
  const routed = value.match(ROUTED_TASK_LABEL);
  if (routed?.[1]?.trim()) return cleanLine(routed[1]);
  for (const raw of value.split("\n")) {
    const line = cleanLine(raw);
    const match = line.match(TASK_LABEL);
    if (match?.[1]?.trim()) return cleanLine(match[1]);
  }
  return null;
}

function requestSection(value: string): string | null {
  const lines = value.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (!REQUEST_SECTION_HEADING.test(lines[index] ?? "")) continue;
    const rest = lines.slice(index + 1).join("\n").trim();
    return rest || null;
  }
  return null;
}

function softClip(value: string, max: number): string {
  const text = value.trim();
  if (text.length <= max) return text;
  const clipped = text.slice(0, max).trimEnd();
  const boundary = Math.max(
    clipped.lastIndexOf(" "),
    clipped.lastIndexOf("\n"),
    clipped.lastIndexOf("."),
  );
  const soft = boundary > max * 0.55 ? clipped.slice(0, boundary) : clipped;
  return `${soft.trimEnd()}...`;
}

/* Injected context wrappers (ambient UI state, reminders, environment blocks)
   are custom-element-like: their names always carry a dash or underscore.
   Requiring one keeps prose mentions like `<Task>` or `<b>` out of the chip row. */
const CONTEXT_TAG_TOKEN = /<\/?([a-zA-Z][\w.-]*)(\s[^<>]*?)?\s*\/?>/g;
const CONTEXT_TAG_NAME = /[-_]/;
const TAG_ATTR = /([\w.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

/* Transport envelopes: the payload IS the request, so unwrap them silently --
   no chip, nothing dropped. `<input>` carries no dash or underscore, so the
   heuristic above can never reach it and both delimiters rendered verbatim in
   the card; naming the outer envelope tells a reader nothing the card doesn't
   already say. Same set floor-preview-text.ts unwraps for its previews. */
const ENVELOPE_TAGS = new Set(["realtime_delegation", "input"]);

/* Wrappers whose body is injected context rather than the operator's words.
   The wrapper still earns a chip, but the body is dropped: stripping only the
   delimiters promoted a replayed transcript into the prose, so the card showed
   `assistant: ...` text nobody typed. Mirrors floor-preview-text.ts's blocks. */
const CONTEXT_PAYLOAD_TAGS = ["transcript_delta"];

const CONTEXT_TAG_LABELS: Record<string, string> = {
  "transcript_delta": "Transcript",
  "in-app-browser-context": "Browser context",
  "environment_context": "Environment",
  "app-context": "App context",
  "system-reminder": "Reminder",
  "recommended_plugins": "Plugins",
  "local-command-caveat": "Command note",
};

/** Chip text for a context wrapper: curated where we know it, else the element
 *  name as words. The model keeps `name` as the identity; this is presentation. */
export function laneAskContextTagLabel(name: string): string {
  const known = CONTEXT_TAG_LABELS[name];
  if (known) return known;
  const words = name.replace(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : name;
}

function extractContextTags(value: string): { tags: LaneAskContextTag[]; text: string } {
  const tags: LaneAskContextTag[] = [];
  const byName = new Map<string, LaneAskContextTag>();

  const record = (key: string, raw: string, attrs?: string) => {
    let detail: string | undefined;
    if (attrs) {
      let firstValue: string | undefined;
      for (const match of attrs.matchAll(TAG_ATTR)) {
        const attrValue = match[2] ?? match[3] ?? match[4] ?? "";
        if (firstValue === undefined) firstValue = attrValue;
        if (match[1]?.toLowerCase() === "source") {
          detail = attrValue;
          break;
        }
      }
      detail ??= firstValue;
    }

    const existing = byName.get(key);
    if (existing) {
      if (!existing.detail && detail) {
        existing.detail = detail;
        existing.raw = raw;
      }
      return;
    }
    const tag: LaneAskContextTag = { name: key, raw };
    if (detail) tag.detail = detail;
    byName.set(key, tag);
    tags.push(tag);
  };

  /* Body-dropping wrappers first, so the pass below never sees their contents.
     An unterminated block runs to the end of the source -- a request truncated
     mid-transcript must not spill the partial dump into the card either. */
  let carrier = value;
  for (const tag of CONTEXT_PAYLOAD_TAGS) {
    const block = new RegExp(`<${tag}\\b([^<>]*?)\\s*>([\\s\\S]*?)(?:<\\/${tag}\\s*>|$)`, "gi");
    carrier = carrier.replace(block, (_match, attrs: string | undefined) => {
      record(tag, `<${tag}${attrs ?? ""}>`, attrs || undefined);
      return "";
    });
    carrier = carrier.replace(new RegExp(`<\\/${tag}\\s*>`, "gi"), "");
  }

  const text = carrier.replace(CONTEXT_TAG_TOKEN, (raw, name: string, attrs?: string) => {
    const key = name.toLowerCase();
    if (ENVELOPE_TAGS.has(key)) return "";
    if (!CONTEXT_TAG_NAME.test(name)) return raw;
    record(key, raw, raw.startsWith("</") ? undefined : attrs);
    return "";
  });

  const tidied = text
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^[ \t]+|[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { tags, text: tidied };
}

function compactParagraph(value: string): string {
  return value
    .split("\n")
    .map((line) => cleanLine(line))
    .filter((line) => line.length > 0)
    .join("\n")
    .trim();
}

function targetLabel(event: Pick<ObserveEvent, "to">): string {
  const to = event.to?.trim();
  if (!to) return "User request";
  if (to === "human") return "To operator";
  return `To ${to}`;
}

function answerDelayLabel(event: Pick<ObserveEvent, "t" | "answerT">): string | null {
  if (typeof event.answerT !== "number" || !Number.isFinite(event.answerT)) return null;
  const seconds = Math.max(0, Math.round(event.answerT - event.t));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return remaining > 0 ? `${minutes}m ${remaining}s` : `${minutes}m`;
}

export function buildLaneAskDisplay(event: Pick<ObserveEvent, "text" | "to" | "answer" | "answerT" | "t">): LaneAskDisplayModel {
  const fullText = normalizeText(event.text);
  const strippedText = stripFilesMentionedSections(stripLeadingGenericRequestLabels(stripLeadingInstructionBlocks(fullText))) || fullText;
  const requestText = requestSection(strippedText)
    ?? requestSection(fullText)
    ?? strippedText;
  const { tags: contextTags, text: requestBody } = extractContextTags(requestText);
  const displayText = requestBody || requestText;
  const compactRequest = compactParagraph(displayText) || fullText || "Request";
  const title = labeledRequest(displayText)
    ?? labeledRequest(fullText)
    ?? firstMeaningfulLine(displayText)
    ?? firstMeaningfulLine(fullText)
    ?? "Request";
  const label = targetLabel(event);
  const fields: LaneAskDisplayField[] = [{ label: "route", value: label }];
  const delay = answerDelayLabel(event);
  if (delay) fields.push({ label: "answer", value: delay });

  const answer = normalizeText(event.answer);
  const copyText = answer
    ? `${fullText}\n\nAnswer:\n${answer}`
    : fullText;

  return {
    label,
    title: softClip(title, 180),
    preview: softClip(compactRequest, 520),
    requestText,
    fullText,
    copyText,
    fields,
    contextTags,
    answer: answer
      ? {
          label: delay ? `answered after ${delay}` : "answered",
          text: answer,
        }
      : undefined,
  };
}

export function laneAskHeadline(
  event: Pick<ObserveEvent, "text" | "to" | "answer" | "answerT" | "t">,
  full = false,
): string {
  const ask = buildLaneAskDisplay(event);
  return full ? ask.fullText : ask.title;
}

export function laneAskPreview(
  event: Pick<ObserveEvent, "text" | "to" | "answer" | "answerT" | "t">,
): string {
  return buildLaneAskDisplay(event).preview;
}
