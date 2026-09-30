/* ──────────────────────────────────────────────────────────────────────────
   Agents feed detail — an agent's update read as a short article.
   Ported from the studio study design/studio/app/studies/agents-feed-detail.

   An update arrives as one message body. Agents already write it with some
   structure (ALL-CAPS section labels, indented path and URL lines); streamed
   replies run their beats together ("…says.Hold this…"). This module turns
   that into: a headline (the lead sentence), body blocks, the process
   narration folded aside ("I'll review…"), and the files and links it names.
   Pure — no React, no fetches.
   ────────────────────────────────────────────────────────────────────────── */

import type { ObserveData, ObserveEvent } from "../../lib/types.ts";

export type ArticleBlock =
  | { kind: "heading"; text: string }
  | { kind: "para"; text: string }
  | { kind: "file"; path: string; note: string | null }
  | { kind: "link"; url: string; note: string | null };

export type Article = {
  headline: string;
  body: ArticleBlock[];
  /** Process narration ("I'll check…") — how the reply formed, not what it says. */
  notes: string[];
  /** Paths the update names in prose (not already set as file lines). */
  files: string[];
  /** URLs the update names. */
  links: string[];
};

const PATH_RE = /(?:~\/|\/|\b)(?:[\w.-]+\/)+[\w.-]+\.[a-z]{1,5}\b/g;
const URL_RE = /https?:\/\/[^\s)>\]]+/g;
const ASK_TAG = /\[ask:[^\]]+\]\s*/g;
const SECTION = /^[A-Z][A-Z &/-]{2,}$/;
const NARRATION = /^(?:I'll|I will|I'm going to|Let me|Now I'll|Next I'll|First,? I'll)\b/;
const STATUS_LEAD = /^(DONE|APPROVED?|BLOCKED)\s*[—–-]\s*/;

/** Streamed replies run their beats together ("…says.Hold this"); split them back. */
export function splitBeats(text: string): string[] {
  return text
    .split(/(?<=[a-z0-9)`'"][.!?:])(?=[A-Z][a-z])/)
    .map((beat) => beat.trim())
    .filter(Boolean);
}

function parseBlocks(body: string): ArticleBlock[] {
  const blocks: ArticleBlock[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: "para", text: para.join(" ") });
    para = [];
  };
  for (const raw of body.replace(ASK_TAG, "").split("\n")) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    if (SECTION.test(line)) { flush(); blocks.push({ kind: "heading", text: line }); continue; }
    const indented = /^\s{2,}/.test(raw);
    const url = line.match(URL_RE)?.[0];
    if (indented && url && line.startsWith(url)) {
      flush();
      blocks.push({ kind: "link", url, note: tidyNote(line.slice(url.length)) });
      continue;
    }
    const path = line.match(PATH_RE)?.[0];
    if (indented && path && line.startsWith(path)) {
      flush();
      blocks.push({ kind: "file", path, note: tidyNote(line.slice(path.length)) });
      continue;
    }
    para.push(line);
  }
  flush();
  return blocks;
}

function tidyNote(text: string): string | null {
  return text.replace(/^[\s(·—–-]+|[\s)]+$/g, "") || null;
}

/* Harness transcripts write markdown; the article sets its own type, so the
   marks go: [label](url) → label, **bold** / `code` → plain, and each list
   item (numbers kept) becomes its own paragraph instead of running into the one above. */
export function tidyMarkdown(text: string): string {
  return text
    .replace(/!?\[([^\]\n]+)\]\((?:[^()\s]|\([^()\s]*\))+\)/g, "$1")
    .replace(/(\*\*|__)(?=\S)([^\n]*?\S)\1/g, "$2")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^(\s*)[-*+]\s+(?=\S)/gm, "\n$1")
    .replace(/^(\s*\d+[.)]\s+)(?=\S)/gm, "\n$1")
    .replace(/^#{1,6}\s+(.+)$/gm, (_, heading: string) => `\n${heading.toUpperCase()}\n`);
}

export function toArticle(body: string): Article {
  const blocks = parseBlocks(tidyMarkdown(body));
  const notes: string[] = [];
  const out: ArticleBlock[] = [];
  for (const block of blocks) {
    if (block.kind !== "para") { out.push(block); continue; }
    const kept: string[] = [];
    for (const beat of splitBeats(block.text)) (NARRATION.test(beat) ? notes : kept).push(beat);
    // Three beats a paragraph at most, so a streamed wall reads as prose.
    for (let i = 0; i < kept.length; i += 3) out.push({ kind: "para", text: kept.slice(i, i + 3).join(" ") });
  }

  let headline = "";
  const first = out.findIndex((block) => block.kind === "para");
  if (first >= 0) {
    const text = (out[first] as { kind: "para"; text: string }).text;
    const lead = text.match(/^(.{12,180}?[.!?])(?=\s|$)/)?.[1] ?? (text.length <= 200 ? text : `${text.slice(0, 180).trimEnd()}…`);
    headline = lead.replace(STATUS_LEAD, (_, status: string) => `${status} — `);
    const rest = lead.endsWith("…") ? text : text.slice(lead.length).trim();
    if (rest && rest !== text) out[first] = { kind: "para", text: rest };
    else if (!lead.endsWith("…")) out.splice(first, 1);
  } else if (notes.length) {
    // Only narration so far ("I'll review…"): the promise is the headline.
    headline = notes.shift()!;
  }

  const setFiles = new Set(out.flatMap((block) => (block.kind === "file" ? [block.path] : [])));
  const prose = [headline, ...out.flatMap((block) => (block.kind === "para" ? [block.text] : []))].join("\n");
  const files = [...new Set(prose.match(PATH_RE) ?? [])]
    .filter((path) => !setFiles.has(path) && !path.startsWith("/private/tmp") && !path.startsWith("/tmp/"))
    .slice(0, 8);
  const links = [...new Set(body.match(URL_RE) ?? [])];
  return { headline, body: out, notes, files, links };
}

/** Absolute path for a path an update names, resolved against its workspace. */
export function resolveUpdatePath(path: string, root: string | null | undefined): string | null {
  if (path.startsWith("/")) return path;
  if (path.startsWith("~/")) return null; // home is not known client-side
  if (!root) return null;
  return `${root.replace(/\/+$/, "")}/${path.replace(/^\.\//, "")}`;
}

/** `/Users/<me>/…` → `~/…` for display only. */
export function displayPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+\//, "~/");
}

/* An update worked outside Scout has no conversation, only its harness
   session's trace. The same article reads from the agent message behind the
   post; around it, the trace supplies what a thread cannot: the steps that
   produced it, the files it changed, and where the session stands. */

export type SessionStep = { id: string; tool: string; arg: string | null };

export type SessionUpdate = {
  text: string;
  at: number | null;
  /** Tool steps between the previous message and this one, oldest first. */
  steps: SessionStep[];
  /** Steps behind this update, including any not listed. */
  stepCount: number;
  /** Files created or changed in the session, most recent first. */
  changed: string[];
  readCount: number;
  earlier: Array<{ id: string; text: string; at: number | null }>;
  facts: string[];
};

const STEP_LIMIT = 8;

function isAgentMessage(event: ObserveEvent): boolean {
  return event.kind === "message" && !event.communication && Boolean(event.text?.trim());
}

function stepArg(event: ObserveEvent): string | null {
  const line = (event.arg ?? event.text ?? "").split("\n").find((part) => part.trim())?.trim();
  if (!line) return null;
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}

function isScratch(path: string): boolean {
  return path.startsWith("/private/tmp") || path.startsWith("/tmp/");
}

/** Read the update at `at` (the post's time) out of its session's trace. */
export function toSessionUpdate(data: ObserveData | null | undefined, at: number): SessionUpdate | null {
  const events = data?.events ?? [];
  const messages = events.map((event, index) => ({ event, index })).filter(({ event }) => isAgentMessage(event));
  if (!messages.length) return null;
  // The post was cut from one of these messages: take the nearest in time.
  let pick = messages[messages.length - 1]!;
  let best = Infinity;
  for (const message of messages) {
    if (message.event.at == null) continue;
    const gap = Math.abs(message.event.at - at);
    if (gap <= best) {
      best = gap;
      pick = message;
    }
  }
  const position = messages.indexOf(pick);
  const from = position > 0 ? messages[position - 1]!.index + 1 : 0;
  const tools = events.slice(from, pick.index).filter((event) => event.kind === "tool");

  const files = [...(data?.files ?? [])].filter((file) => !isScratch(file.path));
  const changed = files
    .filter((file) => file.state !== "read")
    .sort((a, b) => b.lastT - a.lastT)
    .map((file) => file.path);

  const session = data?.metadata?.session;
  const usage = data?.metadata?.usage;
  const context = usage?.contextInputTokens && usage.contextWindowTokens
    ? Math.round((usage.contextInputTokens / usage.contextWindowTokens) * 100)
    : null;
  const facts = [
    session?.gitBranch ? `branch ${session.gitBranch}` : null,
    session?.turnCount ? `${session.turnCount} turns` : null,
    context != null ? `${context}% context` : null,
  ].filter((fact): fact is string => Boolean(fact));

  return {
    text: pick.event.text,
    at: pick.event.at ?? null,
    steps: tools.slice(-STEP_LIMIT).map((event) => ({ id: event.id, tool: event.tool ?? "tool", arg: stepArg(event) })),
    stepCount: tools.length,
    changed,
    readCount: files.length - changed.length,
    earlier: messages
      .slice(Math.max(0, position - 5), position)
      .reverse()
      .map(({ event }) => ({ id: event.id, text: event.text, at: event.at ?? null })),
    facts,
  };
}
