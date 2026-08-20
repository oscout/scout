export type MessageMarkupBlock =
  | { type: "paragraph"; text: string }
  | { type: "heading"; depth: number; text: string }
  | { type: "hr" }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "blockquote"; text: string }
  | { type: "code"; language: string | null; text: string }
  | { type: "table"; headers: string[]; rows: string[][] };

const FENCE_PATTERN = /^```([a-z0-9_-]+)?\s*$/iu;
const HEADING_PATTERN = /^(#{1,6})\s+(.+)$/u;
const HR_PATTERN = /^(?:-{3,}|\*{3,}|_{3,})$/u;
const UNORDERED_LIST_PATTERN = /^\s*[-*]\s+(.+)$/u;
const ORDERED_LIST_PATTERN = /^\s*\d+[.)]\s+(.+)$/u;
const TABLE_SEPARATOR_PATTERN = /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$/u;

/**
 * Agent/CLI messages occasionally arrive with a second layer of JSON-style
 * escaping, so intended line breaks are stored as the two visible characters
 * `\\n`. In a transcript that turns otherwise structured prose into one large
 * paragraph.
 *
 * Do not decode every `\\n`: it is legitimate content in source snippets,
 * regular expressions, and Windows paths. A blank-line escape or an escaped
 * break immediately before a Markdown-style block is strong evidence that the
 * whole value is an encoded multiline message. Once that signal is present,
 * restore all of its escaped line breaks before parsing the blocks.
 */
function restoreEscapedMessageLineBreaks(value: string): string {
  if (/[\r\n]/u.test(value)) {
    return value;
  }

  const hasEncodedLayout = /(?:(?:\\r)?\\n){2}/u.test(value)
    || /(?:\\r)?\\n(?=\s*(?:#{1,6}\s|[-*+]\s|>\s|\d+[.)]\s|[A-Z][A-Za-z ]{0,40}:))/u.test(value);
  if (!hasEncodedLayout) {
    return value;
  }

  return value.replace(/\\r\\n|\\n|\\r/gu, "\n");
}

export function normalizeMessageMarkupText(value: string): string {
  const normalized = restoreEscapedMessageLineBreaks(value)
    .replace(/\r\n?/gu, "\n")
    .trim();
  if (!normalized) {
    return "";
  }

  return normalized
    .replace(/([^\n])\s+---\s+(?=(?:#{1,6}\s|\*\*|[A-Z0-9]))/gu, "$1\n\n---\n\n")
    .replace(/([^\n])\s+(#{1,6}\s+)/gu, "$1\n\n$2")
    .replace(/\n{3,}/gu, "\n\n");
}

function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

function isHeading(line: string): boolean {
  return HEADING_PATTERN.test(line.trim());
}

function isHr(line: string): boolean {
  return HR_PATTERN.test(line.trim());
}

function unorderedListItem(line: string): string | null {
  return line.match(UNORDERED_LIST_PATTERN)?.[1]?.trim() ?? null;
}

function orderedListItem(line: string): string | null {
  return line.match(ORDERED_LIST_PATTERN)?.[1]?.trim() ?? null;
}

function isListItem(line: string): boolean {
  return unorderedListItem(line) !== null || orderedListItem(line) !== null;
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/u, "").replace(/\|$/u, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function isTableStart(lines: string[], index: number): boolean {
  const header = lines[index]?.trim();
  const separator = lines[index + 1]?.trim();
  return Boolean(
    header
      && separator
      && header.includes("|")
      && TABLE_SEPARATOR_PATTERN.test(separator),
  );
}

function isBlockStart(lines: string[], index: number): boolean {
  const line = lines[index] ?? "";
  const trimmed = line.trim();
  return Boolean(
    isBlank(line)
      || FENCE_PATTERN.test(trimmed)
      || isHeading(line)
      || isHr(line)
      || isListItem(line)
      || trimmed.startsWith(">")
      || isTableStart(lines, index),
  );
}

export function parseMessageMarkup(value: string): MessageMarkupBlock[] {
  const text = normalizeMessageMarkupText(value);
  if (!text) {
    return [];
  }

  const lines = text.split("\n");
  const blocks: MessageMarkupBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (!trimmed) {
      index += 1;
      continue;
    }

    const fence = trimmed.match(FENCE_PATTERN);
    if (fence) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !FENCE_PATTERN.test(lines[index]!.trim())) {
        codeLines.push(lines[index]!);
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      blocks.push({
        type: "code",
        language: fence[1] ?? null,
        text: codeLines.join("\n"),
      });
      continue;
    }

    if (isHr(line)) {
      blocks.push({ type: "hr" });
      index += 1;
      continue;
    }

    const heading = trimmed.match(HEADING_PATTERN);
    if (heading) {
      blocks.push({
        type: "heading",
        depth: heading[1]!.length,
        text: heading[2]!.trim(),
      });
      index += 1;
      continue;
    }

    if (isTableStart(lines, index)) {
      const headers = splitTableRow(lines[index]!);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index]!.includes("|") && !isBlank(lines[index]!)) {
        rows.push(splitTableRow(lines[index]!));
        index += 1;
      }
      blocks.push({ type: "table", headers, rows });
      continue;
    }

    const unordered = unorderedListItem(line);
    const ordered = orderedListItem(line);
    if (unordered !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items: string[] = [];
      while (index < lines.length) {
        const item = isOrdered ? orderedListItem(lines[index]!) : unorderedListItem(lines[index]!);
        if (item === null) {
          break;
        }
        items.push(item);
        index += 1;
      }
      blocks.push({ type: "list", ordered: isOrdered, items });
      continue;
    }

    if (trimmed.startsWith(">")) {
      const quoteLines: string[] = [];
      while (index < lines.length && lines[index]!.trim().startsWith(">")) {
        quoteLines.push(lines[index]!.trim().replace(/^>\s?/u, ""));
        index += 1;
      }
      blocks.push({ type: "blockquote", text: quoteLines.join("\n").trim() });
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length && !isBlockStart(lines, index)) {
      paragraphLines.push(lines[index]!.trimEnd());
      index += 1;
    }
    blocks.push({
      type: "paragraph",
      text: paragraphLines.join("\n").trim(),
    });
  }

  return blocks;
}
